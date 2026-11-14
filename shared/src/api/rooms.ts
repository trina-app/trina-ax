// Team chat rooms ("대화방" v1, docs/DECISIONS.md "대화방 v1"): people talking to people. Apart from the one-person AI
// chats (chats.ts), which stay as they are. Owner: B (server/src/routes/rooms.ts, server/src/rooms/*).
//
// Kinds: 'team' mirrors one group's members (kept in step when the group changes), 'all' is everyone on the team (one
// per team), 'dm' is exactly two people (one per pair), 'group' is a group chat of hand-picked people (docs/DECISIONS.md
// "그룹 대화와 방 이름": made from the new-chat picker, any member invites or leaves, its manager removes). Only members
// read or send; an admin or the owner is no exception. A member who joins later (added to the group, a new account) sees the messages from their join on. The
// author of a message is always the signed-in person: a body that names an author is refused (the schemas are strict).
//
// Realtime: room.* events in ws.ts go to the room's members only. After a reconnect the server replays them only while
// the person is still a member; otherwise the window gets `resync` and reloads the rooms over REST.
//
// The AI beside a room: the ✦ side chat (a person's own chat, chats.ts sideRoomId; docs/DECISIONS.md "Trina side
// chat"), whose answer they may send to the room (shareAnswerToRoom). "@트리나" in a room is plain text since 2026-11-09,
// and its code was removed on 2026-11-13 (docs/DECISIONS.md "Room @트리나 code removed"): earlier AI messages a room
// holds stay ordinary messages (authorKind 'ai').
//
// Threads, reactions, no read receipts (docs/DECISIONS.md "스레드와 반응"): any normal message of the room (not an event
// line, not deleted, for the whole room) can get replies in a thread (SendRoomMessageBody.threadRootId). Replies live in
// the thread, not in the room's timeline, unless sent to the room too (alsoInRoom); the root carries the thread's
// summary (RoomMessage.thread). A thread follows its root: who cannot see the root (a later member) sees none of it.
// Reactions are any one emoji (RoomReactionEmoji), at most ROOM_REACTION_EMOJI_MAX different ones on a message; they
// never notify or count. Nobody is told who has read what.
//
// Hiding (docs/DECISIONS.md "대화 숨기기"): a member hides a DM, a team room or the everyone room from their own lists
// (setRoomHidden; a group chat is left instead). Nobody else is told. It stays a room they are in: reachable from the
// full list, and opening it brings it back. It comes back by itself when something for them arrives (the server decides
// it when the message is stored: a DM's new message, a mention, a reply in a thread they follow, an answer to their own
// question, a card of their question to the AI); a room still hidden notifies them of nothing.
//
// Pinning (docs/DECISIONS.md "Pinned conversations"): a member pins a room to the top of their own lists (pinRoom,
// Room.pinnedAt). Nobody else is told. Hiding a room unpins it, and a hidden room cannot be pinned.
import { z } from 'zod'
import { HwpPreviewPage, HwpPreviewQuery } from '../hwp'
import { UserId, Uuid7 } from '../ids'
import { PRODUCT } from '../product'
import { emojiForm } from '../emoji-form'
import { NAME_FORBIDDEN, NAME_FORBIDDEN_FIELD } from '../name-chars'
import { isStatusEmoji } from '../status-message'
import { IsoTime, PageQuery, QueryBool, RelPath, SMALL_UPLOAD_MAX, page, type Locale } from './common'
import { empty, endpoint, multipart, stream } from './endpoint'
import { Attachment, UserRef } from './entities'
import { RoomAlertSettings, RoomNotifyLevel } from './room-alerts'
import { RoomAppCard, RoomAppRef } from './room-apps'

export const ROOM_MESSAGE_MAX = 10_000
export const ROOM_FILES_MAX = 10
export const ROOM_MENTIONS_MAX = 50
/** a quote's excerpt (RoomQuote.excerpt) is the message cut to this many characters, the last one "…" */
export const ROOM_QUOTE_EXCERPT_MAX = 200
/** an AI answer in a room is cut here (the rest is said to be cut) */
export const ROOM_AI_ANSWER_MAX = 60_000

export const AI_OWN_NAMES = ['트리나', 'Trina', 'トリナ']
/** The product is named after its AI (the Trina edition): the app calls the AI by its short name there (the web app's
 * rooms.aiName, "트리나"); the core edition calls it by the product's name. */
export const PRODUCT_NAMED_AFTER_AI = AI_OWN_NAMES.some((n) => PRODUCT.displayName.includes(n))

/** "@전체" (docs/DECISIONS.md "@전체"): the word it is written with in each language (the everyone room's own name there).
 * The web app's "@" list writes the person's language's word (its rooms.mentionAll, one of these); the server takes a
 * message's mentionsAll only when one of them stands in its text where a mention may start, so what notifies is what
 * the text shows. */
/** the everyone room's own word in each language, which "@<word>" means everyone in the room */
const ROOM_MENTION_ALL_WORD = {
  ko: '전체',
  en: 'everyone',
  ja: '全員',
  es: 'todos',
  id: 'semua',
  zh: '所有人',
} as const
export const ROOM_MENTION_ALL_WORDS: readonly string[] = Object.values(ROOM_MENTION_ALL_WORD)
/** Does "@<one of ROOM_MENTION_ALL_WORDS>" stand in the text where a mention may start (the start, a space or an opening
 * mark before it)? Without regard to case. */
export function roomMentionAllIn(body: string): boolean {
  const lower = body.toLocaleLowerCase()
  for (let i = body.indexOf('@'); i >= 0; i = body.indexOf('@', i + 1)) {
    if (i > 0 && !/[\s([{"'“‘]/.test(body[i - 1]!)) continue
    if (ROOM_MENTION_ALL_WORDS.some((w) => lower.startsWith(w.toLocaleLowerCase(), i + 1))) return true
  }
  return false
}
export const RoomKind = z.enum(['team', 'all', 'dm', 'group'])
export type RoomKind = z.infer<typeof RoomKind>

/** A group chat holds at most this many people, its maker included. */
export const ROOM_GROUP_MAX = 100
/** A room's own name: at most this many characters (after trimming). */
export const ROOM_NAME_MAX = 80
/** What a room's name may not hold: ../name-chars.ts NAME_FORBIDDEN (control, invisible and blank characters). */
/** ...and it must show something: at least one letter, number, symbol or punctuation mark (not only spaces, combining
 * marks or joiners). */
const NAME_VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u
/** A room's own name as typed: trimmed, at most ROOM_NAME_MAX characters, no control characters. '' (or null) takes it
 * back to the server's name (the group's name, the app's word for everyone, a group chat's members). Always shown as
 * plain text. */
export const RoomName = z.string().trim().max(ROOM_NAME_MAX).refine((s) => s === '' || (!NAME_FORBIDDEN.test(s) && NAME_VISIBLE.test(s)), { message: NAME_FORBIDDEN_FIELD })

/**
 * A room picked with "#" in the person's own AI chat (docs/DECISIONS.md "내 AI 채팅에서 대화방 읽기"): in the message as
 * `#[<title>](room:<room id>)`, so the AI reads exactly that room by its id (room_read) and never guesses from a name.
 * The title is what the person saw when they picked it (no brackets, one line, at most ROOM_NAME_MAX characters); the
 * server checks membership when the room is read, so a token of a room the person has left reads nothing. The app shows
 * a token as a chip "#<title>". Only in the AI chat's message box, never in a room's (a room's name would reach people
 * who are not in it).
 */
export const ROOM_REF_RE = /#\[([^\[\]\n]{1,80})\]\(room:([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)/g
/** The title as a token can hold it: no brackets or lines, and never an address (any member of a group chat names it,
 * and an address in the person's message would count as one they typed: tools/url-gate.ts) */
export const roomRefTitle = (title: string) => title.replace(/[\[\]\r\n\u2028\u2029]+/g, ' ').replace(/:\/\//g, ': //').replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX) || '?'
/** The token for a picked room. */
export const roomRefToken = (id: string, title: string) => `#[${roomRefTitle(title)}](room:${id})`
/** The rooms a message names with tokens, in order, each once. */
export function roomRefsOf(text: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = []
  for (const m of text.matchAll(ROOM_REF_RE)) if (!out.some((r) => r.id === m[2])) out.push({ id: m[2]!, title: m[1]! })
  return out
}
/** A message split at its tokens: text, and the rooms as {room} (the app draws a chip for each). */
export function roomRefParts(text: string): ({ text: string } | { room: { id: string; title: string } })[] {
  const out: ({ text: string } | { room: { id: string; title: string } })[] = []
  let at = 0
  for (const m of text.matchAll(ROOM_REF_RE)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index) })
    out.push({ room: { id: m[2]!, title: m[1]! } })
    at = m.index! + m[0].length
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}
/** The message as the AI is given it: each token as "[#room N]" (N in the order of roomRefsOf), its title and id only
 * in the server's data block (chat/turn.ts roomRefsBlock), never as the person's own words. */
export function roomRefsForModel(text: string): string {
  const order = roomRefsOf(text).map((r) => r.id)
  return text.replace(ROOM_REF_RE, (_all, _title: string, id: string) => `[#room ${order.indexOf(id) + 1}]`)
}
/** An earlier message of the conversation as the AI is given it: each token as the room's id alone. */
export const roomRefsByIdOnly = (text: string) => text.replace(ROOM_REF_RE, (_all, _title: string, id: string) => `[#room room_id=${id}]`)
/** The message as people read it: each token as "#<title>" (lists, titles, a text box to edit it in). */
export const plainRoomRefs = (text: string) => text.replace(ROOM_REF_RE, (_all, title: string) => `#${title}`)

/**
 * The thread a side chat question is about (docs/DECISIONS.md "Trina side chat: send here"): a question about a room
 * message (web SideChatPanel withQuote) starts with the message quoted, and the quote's header line ("> <who> · <when>")
 * ends with ` (thread_id <id> in this room)`, the message's thread root (its own id, or its thread's first message), only
 * when that message can have a thread. Like the file quote's `file_id`, the AI reads it as is (room_read's `thread`). The
 * app hides it wherever it shows the question, and an answer of the side chat goes to that thread with one click. Only
 * the first line of a message counts: the quote is always at the top.
 */
const THREAD_REF_RE = /^(> [^\n]*?) \(thread_id ([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) in this room\)(?=\n|$)/
/** The token at the end of a quote's header line. */
export const threadRefToken = (rootId: string) => ` (thread_id ${rootId} in this room)`
/** The thread root a question's quote names, or null. */
export const threadRefOf = (text: string): string | null => THREAD_REF_RE.exec(text)?.[2] ?? null
/** The question as people read it: the quote's header without the token. */
export const hideThreadRef = (text: string): string => text.replace(THREAD_REF_RE, '$1')
/** Does a side chat question start with a quote (a message or a file of the room asked about)? */
export const quotesRoom = (content: string) => content.startsWith('> ')
/**
 * Where an answer of a side chat goes (docs/DECISIONS.md "Trina side chat: send here"), from the questions above it on its
 * branch, the nearest first: the first that quotes something decides, its token's thread, or the room (null) when it has
 * none (a file, a message that cannot have a thread, an older chat); a follow-up without a quote keeps what an earlier
 * one said. No question quotes anything: the room. One rule for the button under an answer (web lib/sideChatSend.ts) and
 * the AI's post_to_room (server chat/post-to-room.ts).
 */
export function nearestThreadOf(questionsNearestFirst: Iterable<string>): string | null {
  for (const q of questionsNearestFirst) if (quotesRoom(q)) return threadRefOf(q)
  return null
}

/** The quote a side chat question starts with (web SideChatPanel withQuote), as people read it: a message (who, when, its
 * lines) or a file sent in the room (its name), then the question asked about it ('' when files went alone). null: the
 * question does not start with one. The bubble shows it as a quote (web components/chat/Messages.tsx UserText) and a new
 * chat's title is the question, not the quote (server chat/title.ts). */
export type SideQuote =
  | { kind: 'message'; author: string; at: string; text: string; question: string }
  | { kind: 'file'; name: string; question: string }
export function sideQuoteOf(content: string): SideQuote | null {
  const shown = hideThreadRef(content)
  if (!shown.startsWith('> ')) return null
  const cut = shown.indexOf('\n\n')
  const block = (cut < 0 ? shown : shown.slice(0, cut)).split('\n')
  const question = cut < 0 ? '' : shown.slice(cut + 2)
  if (block.some((l) => !l.startsWith('>'))) return null
  const file = /^> 📎 (.+) \(file_id \S+ in this room\)$/.exec(block[0]!)
  if (file) return block.length === 1 ? { kind: 'file', name: file[1]!, question } : null
  const head = block[0]!.slice(2), at = head.lastIndexOf(' · ')
  if (at < 0 || block.length < 2) return null
  return { kind: 'message', author: head.slice(0, at), at: head.slice(at + 3), text: block.slice(1).map((l) => l.replace(/^> ?/, '')).join('\n'), question }
}

/** The quick questions of a side chat under a quoted message or file (web SideChatPanel): the button's word and the
 * question it sends, in each language. One source for the app and for a new chat's title ("요약: <the quote's first
 * words>", server chat/title.ts), which recognizes them in any language. */
export const SIDE_CHAT_QUICK = {
  translate: {
    label: { ko: '번역', en: 'Translate', id: 'Terjemahkan', ja: '翻訳', es: 'Traducir', zh: '翻译' },
    ask: { ko: '이 메시지를 한국어로 번역해 줘.', en: 'Translate this message into English.', id: 'Terjemahkan pesan ini ke bahasa Indonesia.', ja: 'このメッセージを日本語に翻訳してください。', es: 'Traduce este mensaje al español.', zh: '把这条消息翻译成中文。' },
  },
  summarize: {
    label: { ko: '요약', en: 'Summarize', id: 'Ringkas', ja: '要約', es: 'Resumir', zh: '总结' },
    ask: { ko: '이 메시지를 요약해 줘. 스레드가 있으면 스레드도 요약해 줘.', en: 'Summarize this message. If it has a thread, summarize the thread too.', id: 'Ringkas pesan ini. Kalau ada thread, ringkas thread-nya juga.', ja: 'このメッセージを要約してください。スレッドがあればスレッドも要約してください。', es: 'Resume este mensaje. Si tiene un hilo, resume también el hilo.', zh: '总结这条消息。如果有话题，也总结一下话题。' },
  },
  explain: {
    label: { ko: '설명', en: 'Explain', id: 'Jelaskan', ja: '説明', es: 'Explicar', zh: '解释' },
    ask: { ko: '이 메시지를 쉬운 말로 설명해 줘.', en: 'Explain this message in plain words.', id: 'Jelaskan pesan ini dengan kata-kata sederhana.', ja: 'このメッセージをわかりやすく説明してください。', es: 'Explica este mensaje con palabras sencillas.', zh: '用简单的话解释这条消息。' },
  },
  fileSummarize: {
    label: { ko: '요약', en: 'Summarize', id: 'Ringkas', ja: '要約', es: 'Resumir', zh: '总结' },
    ask: { ko: '이 파일을 요약해 줘.', en: 'Summarize this file.', id: 'Ringkas file ini.', ja: 'このファイルを要約してください。', es: 'Resume este archivo.', zh: '总结这个文件。' },
  },
  fileKeyPoints: {
    label: { ko: '핵심 정리', en: 'Key points', id: 'Poin penting', ja: '要点', es: 'Puntos clave', zh: '要点' },
    ask: { ko: '이 파일의 핵심(결정, 숫자, 날짜, 해야 할 일)을 정리해 줘.', en: 'List the key points of this file: decisions, numbers, dates and what someone must do.', id: 'Tulis poin penting file ini: keputusan, angka, tanggal, dan yang harus dikerjakan.', ja: 'このファイルの要点（決定事項、数字、日付、やること）をまとめてください。', es: 'Enumera los puntos clave de este archivo: decisiones, cifras, fechas y tareas.', zh: '列出这个文件的要点：决定、数字、日期，以及谁需要做什么。' },
  },
  fileCheck: {
    label: { ko: '검토', en: 'Check it', id: 'Periksa', ja: 'チェック', es: 'Revisar', zh: '检查' },
    ask: { ko: '이 파일에서 틀린 곳, 빠진 곳, 이상한 곳을 검토해 줘.', en: 'Check this file for mistakes, gaps and anything that looks wrong.', id: 'Periksa file ini: kesalahan, bagian yang kurang, dan yang terlihat janggal.', ja: 'このファイルの誤り、抜け、おかしな点を確認してください。', es: 'Revisa este archivo en busca de errores, huecos y cosas que parezcan incorrectas.', zh: '检查这个文件里的错误、遗漏和看起来不对的地方。' },
  },
  fileSave: {
    label: { ko: '팀 폴더에 저장', en: 'Save to a team folder', id: 'Simpan ke folder tim', ja: 'チームフォルダに保存', es: 'Guardar en una carpeta del equipo', zh: '保存到团队文件夹' },
    ask: { ko: '이 파일을 팀 폴더에 저장해 줘.', en: 'Save this file to a team folder.', id: 'Simpan file ini ke folder tim.', ja: 'このファイルをチームフォルダに保存してください。', es: 'Guarda este archivo en una carpeta del equipo.', zh: '把这个文件保存到团队文件夹。' },
  },
} as const satisfies Record<string, { label: Record<Locale, string>; ask: Record<Locale, string> }>
export type SideChatQuick = keyof typeof SIDE_CHAT_QUICK
/** The one button under a side chat's answer (web components/rooms/SendHere.tsx), in each language: to the asked
 * message's thread, or to the room. One source for the app and for the AI's side panel instructions (server
 * chat/prompt.ts sideRoomSection), which name it as the person sees it. */
export const SIDE_CHAT_SEND = {
  thread: { ko: '스레드에 보내기', en: 'Send to thread', id: 'Kirim ke utas', ja: 'スレッドに送る', es: 'Enviar al hilo', zh: '发送到话题' },
  room: { ko: '대화방에 보내기', en: 'Send to room', id: 'Kirim ke ruang', ja: 'ルームに送る', es: 'Enviar a la sala', zh: '发送到群聊' },
} as const satisfies Record<string, Record<Locale, string>>
/** the quick questions under a quoted message, and under a quoted file (팀 폴더에 저장: the AI saves it with
 * save_room_file, whose card says where and who will see it) */
export const SIDE_QUICK_MESSAGE = ['translate', 'summarize', 'explain'] as const satisfies readonly SideChatQuick[]
export const SIDE_QUICK_FILE = ['fileSummarize', 'fileKeyPoints', 'fileCheck', 'fileSave'] as const satisfies readonly SideChatQuick[]
/** Which quick question this text is, exactly, and in which language; null: a question of the person's own. */
export function sideQuickOf(question: string): { key: SideChatQuick; locale: Locale } | null {
  const q = question.trim()
  for (const key of Object.keys(SIDE_CHAT_QUICK) as SideChatQuick[]) {
    for (const [locale, ask] of Object.entries(SIDE_CHAT_QUICK[key].ask) as [Locale, string][]) if (ask === q) return { key, locale }
  }
  return null
}

/** A file or image sent in a room. Stored outside the team folder (owners and admins can read the team folder outside
 * users/<id>/); read at GET /api/rooms/:id/files/:fileId by the room's current members only, checked on every read
 * (`?thumb=1`: an image's small preview when `thumb` is true). */
export const RoomFile = z.object({
  id: Uuid7,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  kind: Attachment.shape.kind,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  thumb: z.boolean(),
})
export type RoomFile = z.infer<typeof RoomFile>

/** A reaction: any one emoji (docs/DECISIONS.md "Any emoji as a reaction"), by the rule of a status message's emoji
 * (isStatusEmoji, shared/src/status-message.ts): a single emoji or one sequence (ZWJ, flag, keycap, skin tone), never
 * text, several emoji or invisible tag letters (only the three subdivision flags carry them), at most 32 UTF-16 units.
 * Taken in its fully qualified form (emojiForm): ❤ and ❤️ are one reaction. */
export const RoomReactionEmoji = z.string().refine(isStatusEmoji, 'one emoji').transform(emojiForm)
export type RoomReactionEmoji = z.infer<typeof RoomReactionEmoji>
/** Different emoji one message may carry, at most: a new one past this is refused (409, params.reason
 * 'reactions_full'); adding mine to one that is there always works. */
export const ROOM_REACTION_EMOJI_MAX = 20
/** Who reacted with one emoji: at most this many names come with it (the count is all of them). */
export const ROOM_REACTION_NAMES = 10

/** One emoji on a message: how many members put it there, whether I did, and who (the first ROOM_REACTION_NAMES, in
 * the order they reacted; only people in the room now). In the order the emoji were first used. */
export const RoomReaction = z.object({
  /** one emoji (RoomReactionEmoji; the server stores nothing else) */
  emoji: z.string(),
  count: z.number().int().positive(),
  mine: z.boolean(),
  users: z.array(UserRef),
})
export type RoomReaction = z.infer<typeof RoomReaction>

/** A thread under its root, as I see it: the replies I can see (not deleted), the time of the last one, up to 3 people
 * who replied (the latest first; the AI is not one of them), and whether a thread I follow (I wrote the root, replied,
 * or was mentioned in it) has a reply after my position in it. */
export const RoomThreadSummary = z.object({
  replyCount: z.number().int().nonnegative(),
  lastReplyAt: IsoTime.nullable(),
  repliers: z.array(UserRef),
  newReplies: z.boolean(),
})
export type RoomThreadSummary = z.infer<typeof RoomThreadSummary>

/** The quoted message under a reply: an excerpt (at most 200 characters), or nothing once it was deleted (or when the
 * viewer does not see it). withheld: an old answer hidden from the viewer (RoomMessage.withheld). */
export const RoomQuote = z.object({
  id: Uuid7,
  author: UserRef.nullable(),
  excerpt: z.string(),
  fileCount: z.number().int().nonnegative(),
  deleted: z.boolean(),
  withheld: z.literal(true).optional(),
  /** a quoted message an app posted (docs/DECISIONS.md "Apps posting in rooms"): the app (author null); `excerpt` is its
   * plain text, shown as text (no links found in it) */
  app: RoomAppRef.optional(),
})
export type RoomQuote = z.infer<typeof RoomQuote>

/** What an event line in a room says (a room message with `event` set: who did it is its author). It takes its place in
 * the room (a seq) but counts nowhere: no badge, no notice or push, no menu (not editable, deletable,
 * quotable or postable), never given to the AI. created: a group chat was made with these people; renamed: the room's
 * own name is now `name` (null: back to the server's name); added: these people were invited; left: the author left
 * (or their account is gone); removed: the author took this person out; unknown: a line this build cannot read. */
export const RoomEventLine = z.discriminatedUnion('type', [
  z.object({ type: z.literal('created'), users: z.array(UserRef) }),
  z.object({ type: z.literal('renamed'), name: z.string().nullable() }),
  z.object({ type: z.literal('added'), users: z.array(UserRef) }),
  z.object({ type: z.literal('left') }),
  z.object({ type: z.literal('removed'), user: UserRef.nullable() }),
  /** the author joined the team (an invite, the team link or an admin's "Add directly"): the everyone room's line, nobody notified */
  z.object({ type: z.literal('joined') }),
  /** a line this build cannot read (a newer build's, or a damaged one): said neutrally, without who did it */
  z.object({ type: z.literal('unknown') }),
])
export type RoomEventLine = z.infer<typeof RoomEventLine>

/** Message links (docs/DECISIONS.md "Message links and their previews"): the address of a room's message as "Copy link"
 * gives it, `https://<host>/rooms/<room>?m=<message>`, a thread reply `https://<host>/rooms/<room>/t/<root>?m=<reply>`.
 * Pure: the server reads ids from a message's text on any host (the ids decide: another team's names nothing here), the
 * web draws a chip only for its own origin or the team address. */
export interface MessageLinkRef { roomId: string; messageId: string; rootId: string | null; host: string; href: string }
/** At most this many message links of one message get a card; a message with more links than this (of any kind) gets
 * none (Slack's rule). */
export const MESSAGE_LINK_PREVIEWS_MAX = 5
/** A snapshot's (and a card's) text, at most this many characters. */
export const MESSAGE_LINK_TEXT_MAX = 4000
const U7 = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
const MESSAGE_LINK_RE = new RegExp(`https?://([A-Za-z0-9.-]+(?::\\d{1,5})?)/rooms/(${U7})(?:/t/(${U7}))?/?\\?([A-Za-z0-9\\-._~%&=+,;:!?*'(]*)`, 'g')
/** One address as a message link, or null (another path, not uuid v7 ids, `//` or `/api/`). */
export function parseMessageLink(href: string): MessageLinkRef | null {
  const first = parseMessageLinks(href)[0]
  return first && href.startsWith(first.href) && !/\s/.test(href) ? first : null
}
/** The message links in a text, in order, each message once (the first link to it). */
export function parseMessageLinks(text: string): MessageLinkRef[] {
  if (!text || !text.includes('/rooms/')) return []
  const out: MessageLinkRef[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(MESSAGE_LINK_RE)) {
    // not inside a word or another address ("xhttps://…")
    const before = m.index ? text[m.index - 1]! : ''
    if (before && /[A-Za-z0-9._\-/@]/.test(before)) continue
    const query = (m[4] ?? '').replace(/[.,:;!?'*_~([{]+$/, '').split('#')[0]!
    let id: string | null = null
    for (const part of query.split('&')) {
      const [k, v] = part.split('=')
      if (k === 'm' && v && new RegExp(`^${U7}$`).test(v)) { id = v; break }
    }
    if (!id) continue
    const messageId = id.toLowerCase()
    if (seen.has(messageId)) continue
    seen.add(messageId)
    const rootId = m[3] ? m[3].toLowerCase() : null
    const end = (m[0].length - (m[4] ?? '').length) + (m[4] ?? '').replace(/[.,:;!?'*_~([{]+$/, '').length
    out.push({ roomId: m[2]!.toLowerCase(), messageId, rootId: rootId && rootId !== messageId ? rootId : null, host: m[1]!.toLowerCase(), href: m[0].slice(0, end) })
  }
  return out
}
/** How many web addresses a text holds (any kind): more than MESSAGE_LINK_PREVIEWS_MAX and no message link gets a card. */
export const linkCount = (text: string): number => (text.match(/(?<![A-Za-z0-9._\-/@])(?:https?:\/\/|www\.)/gi) ?? []).length

/** A linked message as one viewer may see it under the message that links to it (RoomMessage.linkPreviews), decided by
 * the server for that viewer: live (they can see the original now; its conversation as they name it) or a snapshot the
 * sender chose to show ("Show message": sharedBy, the place without anyone's name). A link they may not see and that has
 * no snapshot has no entry at all, the same as a link to nothing. */
export const RoomLinkPreview = z.object({
  roomId: Uuid7,
  messageId: Uuid7,
  /** a thread reply: its thread's first message */
  rootId: Uuid7.nullable(),
  /** where it was said: live, the room as this viewer names it (its own name or the group's, the other people); a
   * snapshot, only its kind (and a team room's name as the sender saw it), never who is in a DM or group chat */
  place: z.object({ kind: RoomKind, name: z.string().nullable(), peers: z.array(UserRef) }),
  author: UserRef.nullable(),
  authorKind: z.enum(['user', 'ai']),
  /** a message an app posted: the app (its text is plain) */
  app: RoomAppRef.optional(),
  mentions: z.array(UserId),
  createdAt: IsoTime,
  editedAt: IsoTime.nullable(),
  /** the original was deleted: no text, no files */
  deleted: z.boolean(),
  /** its text (at most MESSAGE_LINK_TEXT_MAX characters); an AI answer's team-file links: `openable` as on the message */
  body: z.string(),
  openable: z.array(z.string()).optional(),
  files: z.object({ count: z.number().int().nonnegative(), first: z.object({ name: z.string(), kind: z.string() }).optional() }),
  /** a snapshot ("Show message"): who chose to show it (null: an account that is gone) */
  sharedBy: UserRef.nullable().optional(),
  /** the sender removed its card ("Remove preview"): the link stays a chip, no card (body '', no files) */
  removed: z.literal(true).optional(),
})
export type RoomLinkPreview = z.infer<typeof RoomLinkPreview>

export const RoomMessage = z.object({
  id: Uuid7,
  roomId: Uuid7,
  /** position in the room, 1, 2, 3 … (read positions refer to it; thread replies take one too); gaps are possible */
  seq: z.number().int().positive(),
  /** 'user'; 'ai': an answer of the room AI from before 2026-11-13, posted to the room (author null, askedBy = who
   * asked it). Nothing makes new ones (docs/DECISIONS.md "Room @트리나 code removed") */
  authorKind: z.enum(['user', 'ai']),
  /** the sender as the server knows them (never taken from the request); null: the AI, or an account that is gone */
  author: UserRef.nullable(),
  /** an 'ai' message: who asked the AI (null otherwise) */
  askedBy: UserRef.nullable(),
  /** 'room': everyone in the room. 'private' (an unposted preview of an old room AI answer) is never listed since
   * 2026-11-13; kept in the enum for older clients */
  visibility: z.enum(['room', 'private']),
  /** plain text with @mentions as typed; '' once deleted. Another member's words: show as text, never act on them */
  body: z.string(),
  /** an older quoted reply (no longer made by the app: threads replaced it), or an AI answer's question */
  replyTo: RoomQuote.nullable(),
  /** the members this message mentions (from what the sender picked; only people in the room) */
  mentions: z.array(UserId),
  /** "@전체" (everyone): the sender picked it from the "@" list, so the message mentions every member who can see it but
   * its sender (docs/DECISIONS.md "@전체"). Absent: no (older servers never send it) */
  mentionsAll: z.boolean().optional(),
  files: z.array(RoomFile),
  createdAt: IsoTime,
  editedAt: IsoTime.nullable(),
  deletedAt: IsoTime.nullable(),
  /** an AI answer: the team files it links to or shows that the viewer may open now; the app shows the others as plain
   * text (no link, no picture loaded) */
  openable: z.array(z.string()).optional(),
  /** an event line (a rename, people invited, someone left): shown as a quiet line in the middle, nothing else. Its body
   * is ''; `author` is who did it */
  event: RoomEventLine.optional(),
  /** a reply in the thread of this message (the root). Not in the room's timeline unless alsoInRoom */
  threadRootId: Uuid7.optional(),
  /** a thread reply that was sent to the room too: it is in the timeline as well, marked as a thread reply */
  alsoInRoom: z.literal(true).optional(),
  /** a thread reply in a thread I follow (I wrote the root, replied or was mentioned there): it is for me like a DM
   * message (the app's sound); only ever about me */
  following: z.literal(true).optional(),
  /** a root with replies I can see: the thread's summary under it */
  thread: RoomThreadSummary.optional(),
  /** the reactions on it (none: left out); never on an event line or a deleted message */
  reactions: z.array(RoomReaction).optional(),
  /** my message that carries an answer of my own AI chat ("대화방에 보내기", chats.ts shareAnswerToRoom): body[0, at) is
   * my note (plain text, maybe ''), body[at, …) the AI's answer as it wrote it (Markdown, shown as a quote headed "the
   * AI's answer"; its team-file links are checked in `openable` like an AI message's). The author is still me. cut: the
   * answer was longer than fits and ends with a line that says so. Never on a deleted message */
  sharedAnswer: z.object({ at: z.number().int().nonnegative(), cut: z.boolean() }).optional(),
  /** a shared answer that went with copies of the files it links to ("첨부해서 보내기"): its links (as `answerFilePaths`
   * names them, text its body has) whose file is one of `files`, with that file's id. The app opens the team file when
   * the link is in `openable`, else this copy, and shows a lock only when there is neither. Only files of this message;
   * never the path a copy was made from. Absent: nothing attached, or an older message */
  attachedLinks: z.array(z.object({ path: z.string(), fileId: Uuid7 })).optional(),
  /** an old answer hidden from me (docs/DECISIONS.md "지난 대화"): I joined this team room or the everyone room after
   * it, and it used something I cannot open (or what it used is not known). Shown as one line in its place: body is ''
   * and nothing of it comes (no files, sources, links, reactions or thread); who asked it (askedBy) or shared it
   * (author) and when stay. Nothing can be done on it (react, reply in its thread, quote: refused like a message I do
   * not see) */
  withheld: z.literal(true).optional(),
  /** a message an app posted (docs/DECISIONS.md "Apps posting in rooms"): author is null, authorKind 'user'; shown as
   * the app's name with an "App" tag, never as a person. `body` is the card's plain text with Markdown marks escaped
   * (older apps show it as text) */
  app: RoomAppRef.optional(),
  /** the app's card (plain text fields, one checked link): show it as text, never as Markdown or HTML */
  appCard: RoomAppCard.optional(),
  /** my own message: the id my app made when it sent it (SendRoomMessageBody.clientMessageId), so a send whose answer
   * was lost is matched to its message when that comes another way (the live event, a replay, a page read again).
   * Only ever on the viewer's own messages */
  clientMessageId: z.string().optional(),
  /** the messages this one links to that this viewer may see (or that its sender chose to show), in link order, at most
   * MESSAGE_LINK_PREVIEWS_MAX; absent: none (older servers never send it) */
  linkPreviews: z.array(RoomLinkPreview).optional(),
})
export type RoomMessage = z.infer<typeof RoomMessage>

/** "대화방에 보내기": the one-line note before a shared answer, at most this long */
export const ANSWER_NOTE_MAX = 300
/** room left for the line that ends a cut answer (and a code fence it closes) */
const ANSWER_CUT_RESERVE = 200

/** The note as it goes into the room: one line, trimmed. */
export const answerNote = (note: string | undefined) => (note ?? '').replace(/\s+/g, ' ').trim().slice(0, ANSWER_NOTE_MAX)

/** Will this answer be cut to fit one room message (ROOM_MESSAGE_MAX) after this note? (the picker says so first) */
export function answerShareCut(note: string | undefined, answer: string): boolean {
  const n = answerNote(note)
  return (n ? n.length + 2 : 0) + answer.trim().length > ROOM_MESSAGE_MAX
}

/** The room message a shared answer becomes: my note, a blank line, then the answer; too long, the answer is cut at a
 * line's end where it can be (a code fence left open is closed) and `cutLine` ends it. `at`: where the answer starts. */
export function answerShareBody(note: string | undefined, answer: string, cutLine: string): { body: string; at: number; cut: boolean } {
  const n = answerNote(note)
  const head = n ? `${n}\n\n` : ''
  const text = answer.trim()
  if (!answerShareCut(note, answer)) return { body: head + text, at: head.length, cut: false }
  const room = ROOM_MESSAGE_MAX - head.length - ANSWER_CUT_RESERVE
  let kept = text.slice(0, Math.max(0, room))
  const nl = kept.lastIndexOf('\n')
  if (nl > room * 0.8) kept = kept.slice(0, nl)
  // a lone half of a surrogate pair at the end
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
  kept = kept.trimEnd()
  if ((kept.match(/^\s*(```|~~~)/gm) ?? []).length % 2 === 1) kept += '\n```'
  return { body: `${head}${kept}\n\n${cutLine.slice(0, ANSWER_CUT_RESERVE - 10)}`, at: head.length, cut: true }
}

/** One line of the rooms list under a room's name. */
export const RoomLastMessage = z.object({
  id: Uuid7,
  seq: z.number().int().positive(),
  author: UserRef.nullable(),
  /** at most 120 characters; '' when it is files only or deleted */
  excerpt: z.string(),
  fileCount: z.number().int().nonnegative(),
  deleted: z.boolean(),
  createdAt: IsoTime,
  /** a message an app posted (author null): the app, shown as its name with the "App" tag */
  app: RoomAppRef.optional(),
})
export type RoomLastMessage = z.infer<typeof RoomLastMessage>

export const Room = z.object({
  id: Uuid7,
  kind: RoomKind,
  /** the room's own name when a member gave it one (plain text); else team: the group's name; dm, all and an unnamed
   * group chat: null (the app shows the other person's name, its word for everyone, the other members' names) */
  name: z.string().nullable(),
  /** may I change the name: a group chat's members; a team room's and the everyone room's members who are owner or
   * admin; nobody in a DM */
  canRename: z.boolean(),
  /** a group chat's manager (방장): its maker while they are in it, else the member who joined first. They, and owners
   * and admins in it, may take someone out. null for the other kinds */
  managerId: UserId.nullable(),
  groupId: Uuid7.nullable(),
  memberCount: z.number().int().nonnegative(),
  /** up to 4 other members, for the avatars; a DM: the other person */
  peers: z.array(UserRef),
  /** the newest position of the timeline I can see (replies that stay in a thread and other people's private previews
   * do not move it) */
  lastSeq: z.number().int().nonnegative(),
  /** messages of the timeline after my read position that I can see and are not mine (capped at 999); thread replies
   * never count here */
  unreadCount: z.number().int().nonnegative(),
  /** threads I follow with replies I have not read (capped at 999): they count in my badge for the room */
  threadsUnread: z.number().int().nonnegative(),
  /** the followed thread with the newest reply I have not read (its root), or null */
  nextThreadId: Uuid7.nullable(),
  /** one of those messages or replies mentions me */
  mentioned: z.boolean(),
  lastReadSeq: z.number().int().nonnegative(),
  lastMessage: RoomLastMessage.nullable(),
  /** my level for this room is 끄기 (notify.own 'off'): no notices, pushes or sound from it, mentions included; its badge
   * is grey and stays out of the 대화 tab's count */
  muted: z.boolean(),
  /** my notifications for this room (docs/DECISIONS.md "대화방 알림 설정", room-alerts.ts): `own` my level for it (null:
   * my default), `byDefault` what my default gives this kind of room, `level` the one that applies now (own, else
   * byDefault). Older servers omit it. */
  notify: z.object({ own: RoomNotifyLevel.nullable(), byDefault: RoomNotifyLevel, level: RoomNotifyLevel }).optional(),
  createdAt: IsoTime,
  /** the last message's time, or when the room was made */
  activityAt: IsoTime,
  /** I hid it (docs/DECISIONS.md "대화 숨기기"): it is out of my 대화 list, my counts and badges, and listed under
   * "숨긴 대화" at the end of the full list. Absent = shown (older servers never hide). */
  hidden: z.literal(true).optional(),
  /** when I pinned it to the top of my 대화 list ("상단에 고정", POST /api/rooms/:id/pin; docs/DECISIONS.md "Pinned
   * conversations"). Mine only: nobody else in the room sees my pin. Never with hidden. Absent = not pinned. */
  pinnedAt: IsoTime.optional(),
  /** the list folder I keep it in (PUT /api/rooms/:id/folder; docs/DECISIONS.md "List folders"). Mine only: each
   * member's copy of the room carries theirs. Not while hidden (it comes back with the room). Absent = in no folder. */
  folderId: Uuid7.optional(),
  /** a DM whose other person was deleted from the team: it stays readable but nobody can write in it any more. Absent
   * = they are still here (older servers never send it). */
  gone: z.literal(true).optional(),
})
export type Room = z.infer<typeof Room>

export const RoomMember = z.object({ user: UserRef, joinedAt: IsoTime })
export type RoomMember = z.infer<typeof RoomMember>

/** dm: the DM with this person (the existing one when there is one). group: a new group chat of me and these people
 * (at least two others; several group chats of the same people are fine), optionally named. Only active people of this
 * team. Team rooms and the everyone room are made by the server, never through the API. */
export const CreateRoomBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dm'), userId: UserId }).strict(),
  z.object({ kind: z.literal('group'), userIds: z.array(UserId).min(2).max(ROOM_GROUP_MAX - 1), name: RoomName.nullable().optional() }).strict(),
])
export type CreateRoomBody = z.infer<typeof CreateRoomBody>
/** notifyLevel: my level for this room (null: back to my default). muted: the older apps' switch (true is 'off', false
 * brings 'off' back to my default); not with notifyLevel. name: the room's own name (Room.canRename; '' or null: back to
 * the server's name) */
export const UpdateRoomBody = z.object({ muted: z.boolean().optional(), notifyLevel: RoomNotifyLevel.nullable().optional(), name: RoomName.nullable().optional() }).strict()
  .refine((b) => b.muted !== undefined || b.notifyLevel !== undefined || b.name !== undefined, { message: 'nothing to change' })
  .refine((b) => b.muted === undefined || b.notifyLevel === undefined, { message: 'muted or notifyLevel, not both', path: ['muted'] })
/** hide the room from my lists (true) or show it again (false). A DM, a team room or the everyone room; a group chat is
 * left instead (hiding one: 403). The same again changes nothing. */
export const SetRoomHiddenBody = z.object({ hidden: z.boolean() }).strict()
/** people to add to a group chat (active people of this team; those already in it are skipped). They see the room from
 * now on, never what was said before. */
export const InviteRoomBody = z.object({ userIds: z.array(UserId).min(1).max(ROOM_GROUP_MAX - 1) }).strict()

/** Without a cursor: the newest `limit` messages, oldest first; nextCursor fetches older ones (prepend).
 * around: the page around this message of the timeline (a thread reply: its thread's first message), for a link or a
 * search result older than the newest page; newerCursor then fetches newer ones (append) until it is null (the page
 * reaches the newest). A message I cannot see is not looked for: the newest page, as without it. A cursor from
 * newerCursor gives the next newer page (and nextCursor null). */
export const ListRoomMessagesQuery = PageQuery.extend({ around: Uuid7.optional() })
/** newerCursor: present only for a page that does not reach the newest message (around, or a newer page) */
export const RoomMessagesPage = page(RoomMessage).extend({ newerCursor: z.string().nullable().optional() })
export type RoomMessagesPage = z.infer<typeof RoomMessagesPage>

/** The timeline's cursor from a message's position, as GET /api/rooms/:id/messages makes it (server/src/rooms/service.ts
 * messages): 'newer', the messages after it (what newerCursor gives); 'older', the ones before it (nextCursor). An app
 * that still holds a room's newest messages asks with it only for what came after them; one that keeps only the newest
 * part of a long timeline gives the rest back to scrolling up with it. */
export function roomTimelineCursor(dir: 'newer' | 'older', seq: number): string {
  // base64url of the JSON the server encodes (chat/store.ts encodeCursor), without padding
  return btoa(JSON.stringify(dir === 'newer' ? { n: String(seq) } : { s: String(seq) })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** ⌘K search of the room messages I can see (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"): every word of the text, in
 * any order and any case, newest first. */
export const ROOM_SEARCH_PAGE_MAX = 30
export const ROOM_SEARCH_SNIPPET_MAX = 200
export const RoomSearchQuery = z.object({
  /** (no NUL: it would end the index's query) */
  q: z.string().trim().min(1).max(200).refine((s) => !s.includes('\u0000'), { message: 'invalid character' }),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(ROOM_SEARCH_PAGE_MAX).optional(),
})
/** A message found: who wrote it and when, and the text around the first match (at most ROOM_SEARCH_SNIPPET_MAX
 * characters, … where it is cut, a room link as #name). threadRootId: a reply in that message's thread (it opens the
 * thread). The text is the message's own, as the room shows it to me: never a quote, a file or an answer hidden from me. */
export const RoomSearchHit = z.object({
  id: Uuid7,
  roomId: Uuid7,
  threadRootId: Uuid7.nullable(),
  authorKind: z.enum(['user', 'ai']),
  /** the person who wrote it (null: the AI's answer, or someone no longer here) */
  author: UserRef.nullable(),
  /** an AI answer: who asked it */
  askedBy: UserRef.nullable(),
  /** the text is Markdown (an AI answer, or an answer someone sent from their own AI chat) */
  markdown: z.boolean(),
  snippet: z.string(),
  createdAt: IsoTime,
  /** a message an app posted (author null): the app, shown as its name with the "App" tag; snippet is plain text */
  app: RoomAppRef.optional(),
})
export type RoomSearchHit = z.infer<typeof RoomSearchHit>
/** The rooms of the hits on a page, as much as their titles need (the app names them as in its lists) */
export const RoomSearchRoom = z.object({ id: Uuid7, kind: RoomKind, name: z.string().nullable(), peers: z.array(UserRef), memberCount: z.number().int().nonnegative() })
export type RoomSearchRoom = z.infer<typeof RoomSearchRoom>
export const RoomSearchPage = z.object({ items: z.array(RoomSearchHit), rooms: z.array(RoomSearchRoom), nextCursor: z.string().nullable() })
export type RoomSearchPage = z.infer<typeof RoomSearchPage>
/** A file sent in a room, found by its name (same query as RoomSearchQuery: every word in the name, any case): the file
 * as the room shows it, and the message it was sent with, which opening it opens (a thread reply: in its thread). Only
 * files of messages I would see by opening the room now. */
export const RoomFileSearchHit = z.object({
  file: RoomFile,
  messageId: Uuid7,
  roomId: Uuid7,
  threadRootId: Uuid7.nullable(),
  /** who sent it (null: someone no longer here) */
  author: UserRef.nullable(),
  createdAt: IsoTime,
})
export type RoomFileSearchHit = z.infer<typeof RoomFileSearchHit>
export const RoomFileSearchPage = z.object({ items: z.array(RoomFileSearchHit), rooms: z.array(RoomSearchRoom), nextCursor: z.string().nullable() })
export type RoomFileSearchPage = z.infer<typeof RoomFileSearchPage>

export const SendRoomMessageBody = z.object({
  body: z.string().max(ROOM_MESSAGE_MAX),
  /** an older client's quoted reply (the app answers in threads now); not with threadRootId */
  replyToId: Uuid7.nullable().optional(),
  /** a reply in the thread of this message of the room's timeline (not an event line, not deleted, for the whole room) */
  threadRootId: Uuid7.nullable().optional(),
  /** a thread reply that also goes to the room's timeline ("대화방에도 보내기"); only with threadRootId */
  alsoInRoom: z.boolean().optional(),
  mentions: z.array(UserId).max(ROOM_MENTIONS_MAX).default([]),
  /** "@전체" picked from the "@" list: notify every member who can see the message as a mention (never the text alone;
   * the text must show it: roomMentionAllIn, 400 otherwise). In the everyone room only an owner or admin may (403) */
  mentionsAll: z.boolean().optional(),
  /** uploaded first with POST /api/rooms/:id/files */
  fileIds: z.array(Uuid7).max(ROOM_FILES_MAX).default([]),
  /** client-made id: sending the same one again (after a reconnect) returns the first message */
  clientMessageId: z.string().min(8).max(64),
  /** "Show message": the linked messages (of links in the body) whose snapshot goes with it, for readers who cannot see
   * them (docs/DECISIONS.md "Message links and their previews"). The server builds each from the original with my own
   * access now; one I cannot see, or that is not a person's message, is dropped without a word */
  showMessages: z.array(Uuid7).max(MESSAGE_LINK_PREVIEWS_MAX).optional(),
}).strict().refine((b) => b.body.trim().length > 0 || b.fileIds.length > 0, { message: 'empty message', path: ['body'] })
export const EditRoomMessageBody = z.object({
  body: z.string().min(1).max(ROOM_MESSAGE_MAX),
  mentions: z.array(UserId).max(ROOM_MENTIONS_MAX).default([]),
  /** the message keeps its "@전체" (only a send adds it: an edit notifies nobody, so it cannot add it, 400) */
  mentionsAll: z.boolean().optional(),
}).strict()
/** The composer's question before a send with message links: for which of them must I choose "Only show link" or "Show
 * message"? `threadRootId`: the box is a reply in that thread (who sees the thread reads it). */
export const MessageLinkAudienceBody = z.object({
  links: z.array(z.object({ roomId: Uuid7, messageId: Uuid7 }).strict()).min(1).max(MESSAGE_LINK_PREVIEWS_MAX),
  threadRootId: Uuid7.optional(),
}).strict()
/** Only the links I can see that someone who would read my message cannot (no names, no counts); `snapshotAllowed`: a
 * person's own message ("Show message" is offered), not an AI answer, an app's card or a shared answer. Any other link
 * (one I cannot see, one that is not there, one everyone here sees) is simply absent. */
export const MessageLinkAudience = z.object({ items: z.array(z.object({
  messageId: Uuid7, someoneCannotSee: z.literal(true), snapshotAllowed: z.boolean(),
  /** with snapshotAllowed: the card exactly as "Show message" would store it (what the box shows before I send) */
  preview: RoomLinkPreview.optional(),
})) })
export type MessageLinkAudience = z.infer<typeof MessageLinkAudience>
export const HideLinkPreviewBody = z.object({ linkedMessageId: Uuid7 }).strict()
export const MarkRoomReadBody = z.object({ seq: z.number().int().nonnegative() }).strict()
/** my position and badge after a read; mentioned: an unread message or followed reply still mentions me (older servers
 * omit it) */
export const RoomReadState = z.object({ lastReadSeq: z.number().int().nonnegative(), unreadCount: z.number().int().nonnegative(), mentioned: z.boolean().optional() })
export type RoomReadState = z.infer<typeof RoomReadState>
/** A thread: its root and a page of the replies I can see (without a cursor the newest `limit`, oldest first;
 * nextCursor fetches older ones). */
export const RoomThreadPage = z.object({ root: RoomMessage, items: z.array(RoomMessage), nextCursor: z.string().nullable() })
export type RoomThreadPage = z.infer<typeof RoomThreadPage>
/** my position in a thread I follow, and the room as I see it after (its badge) */
export const RoomThreadReadState = z.object({ lastReadSeq: z.number().int().nonnegative(), room: Room })
export type RoomThreadReadState = z.infer<typeof RoomThreadReadState>
/** put my reaction on (on: true) or take it off; the same again changes nothing */
export const ReactRoomMessageBody = z.object({ emoji: RoomReactionEmoji, on: z.boolean() }).strict()
export const RoomReactions = z.object({ reactions: z.array(RoomReaction) })
export const RoomFileUploadFields = z.object({ name: z.string().min(1).max(255).optional(), size: z.string().regex(/^\d+$/).transform(Number).optional() })
/** `k` with `thumb`: this sign-in's media key (Me.session.mediaKey): the thumbnail may be kept by this browser
 * (server/src/auth/media-key.ts) */
export const RoomFileQuery = z.object({ thumb: QueryBool.optional(), download: QueryBool.optional(), k: z.string().max(64).optional() })
/** "팀 파일" in a room's message box (a phone's attach sheet): a team file I may read now, copied as my upload in the
 * room, sent by id like one from POST /api/rooms/:id/files */
export const RoomTeamFileBody = z.object({ path: RelPath }).strict()
/** the copy (not sent yet), and how many other members of the room cannot open the team file now: who will see it only
 * through this message (a count, never who; as "대화방에 보내기" tells it before a copy goes: AnswerShareFile.unable) */
export const RoomTeamFile = z.object({ file: RoomFile, unable: z.number().int().nonnegative() })
export type RoomTeamFile = z.infer<typeof RoomTeamFile>

// ---------------- the confirm before content goes to a room ("대화방에 보내기", a room AI preview) ----------------
/** at most this many rows in a "confirm": past it the rest of the answer's links is one more row nothing is told about
 * (everyone else counted) */
export const ANSWER_SHARE_FILES_MAX = 100
/** Where something the answer used came from that some member cannot open (never who cannot). */
export const AnswerSharePlace = z.discriminatedUnion('kind', [
  /** a team folder ('' = the top of the team folder) */
  z.object({ kind: z.literal('folder'), path: z.string() }),
  /** my own folder, or what only I saw (the in-app browser, a personal connection) */
  z.object({ kind: z.literal('mine') }),
  /** a team connection (a connected service) or a shared Google Drive, by its name */
  z.object({ kind: z.literal('service'), name: z.string() }),
  /** a team room by its group's name, or the everyone room (name '') */
  z.object({ kind: z.literal('room'), name: z.string() }),
  /** a 1:1 or group conversation (never named: its name is people's names) */
  z.object({ kind: z.literal('conversation') }),
])
export type AnswerSharePlace = z.infer<typeof AnswerSharePlace>
/** One file the answer links to or shows, as the person sending may be told. */
export const AnswerShareFile = z.object({
  /** its name; '' when `missing` (never named: I cannot open it now) */
  name: z.string(),
  /** its team path, only when I may open it now */
  path: RelPath.optional(),
  /** I cannot open it now: gone or not mine to open read the same, and it is never named */
  missing: z.boolean(),
  /** yes: it can go with the message as a copy (the switch, on by default); no: not needed (everyone can open it) or not
   * a file to copy; too_big: over 50 MB; hidden: I cannot open it (`missing`) */
  attach: z.enum(['yes', 'no', 'too_big', 'hidden']),
  /** members of the room (not me) who cannot open it now; for a `missing` file, everyone else (nothing is told) */
  unable: z.number().int().nonnegative(),
})
export type AnswerShareFile = z.infer<typeof AnswerShareFile>
/** The answer carries content from material some members cannot see. */
export const AnswerShareProvenance = z.object({
  /** members (not me) who cannot see some of it */
  people: z.number().int().positive(),
  /** where it came from, named only where I may look myself */
  places: z.array(AnswerSharePlace),
  /** more such places that are not named */
  otherPlaces: z.boolean(),
  /** what this answer used is not all known (it is not on the chat's current branch): `people` is everyone else */
  unknown: z.literal(true).optional(),
})
export type AnswerShareProvenance = z.infer<typeof AnswerShareProvenance>
/** Nothing sent yet: the person is asked first. `files`: every file the answer links to (a row each); `provenance`: content from material some members
 * cannot see (null: none); `confirmKey`: send it with the same request to go ahead
 * (shareAnswerToRoom). Older clients read `people` (the
 * members, not me, who cannot open a linked file or see some of that material), `places` and `otherPlaces` */
export const AnswerShareConfirm = z.object({
  status: z.literal('confirm'), people: z.number().int().positive(), places: z.array(AnswerSharePlace), otherPlaces: z.boolean(),
  files: z.array(AnswerShareFile).max(ANSWER_SHARE_FILES_MAX),
  provenance: AnswerShareProvenance.nullable(),
  confirmKey: z.string(),
  /** asked again after a confirmKey: `changed`, something changed meanwhile (the app says so); `choice`, the same state,
   * but the files I chose to attach change the provenance line (shown for that choice) */
  reason: z.enum(['changed', 'choice']).optional(),
})
export type AnswerShareConfirm = z.infer<typeof AnswerShareConfirm>

export const ROOMS = {
  listRooms: endpoint({ method: 'GET', path: '/api/rooms', auth: 'user', owner: 'B', response: z.object({ items: z.array(Room), alerts: RoomAlertSettings.optional() }), summary: 'The rooms I am in (my team rooms, everyone, DMs, group chats), most recent activity first, with my unread count, the last message, my notification level and my pin (pinnedAt; the app lists my pinned rooms first); alerts: what else decides whether a message rings (thread replies, quiet hours, the team time zone).' }),
  createRoom: endpoint({ method: 'POST', path: '/api/rooms', auth: 'user', owner: 'B', status: 201, body: CreateRoomBody, response: Room, summary: 'Open the DM with a person (the existing one when there is one), or make a group chat with two or more people. Not audited: admins do not learn who talks to whom.' }),
  getRoom: endpoint({ method: 'GET', path: '/api/rooms/:id', auth: 'user', owner: 'B', response: Room, summary: 'One room I am in (404 for anyone else, admins included).' }),
  updateRoom: endpoint({ method: 'PATCH', path: '/api/rooms/:id', auth: 'user', owner: 'B', body: UpdateRoomBody, response: Room, summary: 'Set my notification level for a room (all, mentions, off, or my default), or rename it (group chats: any member; team and everyone rooms: owner or admin members; never a DM).' }),
  listRoomMessages: endpoint({ method: 'GET', path: '/api/rooms/:id/messages', auth: 'user', owner: 'B', query: ListRoomMessagesQuery, response: RoomMessagesPage, summary: 'The timeline of a room I am in from my join on (thread replies only when sent to the room too), newest page first, oldest first within it. With around: the page around that message, and newerCursor for the newer ones.' }),
  searchRoomMessages: endpoint({ method: 'GET', path: '/api/room-messages', auth: 'user', owner: 'B', query: RoomSearchQuery, response: RoomSearchPage, summary: 'Search the messages I can see in the rooms, 1:1 and group chats I am in now (q: every word, in any order and any case; Korean by part of a word), newest first, with the text around the first word found and the rooms of the hits.' }),
  searchRoomFiles: endpoint({ method: 'GET', path: '/api/room-files', auth: 'user', owner: 'B', query: RoomSearchQuery, response: RoomFileSearchPage, summary: 'Search the files sent in the rooms, 1:1 and group chats I am in now by name (q: every word, any case), only those of messages I can see, newest first, with the message each was sent with and the rooms of the hits.' }),
  sendRoomMessage: endpoint({ method: 'POST', path: '/api/rooms/:id/messages', auth: 'user', owner: 'B', status: 201, body: SendRoomMessageBody, response: RoomMessage, summary: 'Send a message as myself (never another author), or a reply in a thread, with @mentions (or @everyone, written as the everyone room word of each language: mentionsAll; in the everyone room owners and admins only) and files; DMs, group chats, mentions and followed threads notify.' }),
  listRoomThread: endpoint({ method: 'GET', path: '/api/rooms/:id/messages/:messageId/thread', auth: 'user', owner: 'B', query: ListRoomMessagesQuery, response: RoomThreadPage, summary: 'A thread in a room I am in: its root and the replies I can see (none of it when I cannot see the root).' }),
  markRoomThreadRead: endpoint({ method: 'POST', path: '/api/rooms/:id/messages/:messageId/thread/read', auth: 'user', owner: 'B', body: MarkRoomReadBody, response: RoomThreadReadState, summary: 'Move my read position in a thread I follow forward to seq; its notices count as read.' }),
  reactRoomMessage: endpoint({ method: 'PUT', path: '/api/rooms/:id/messages/:messageId/reactions', auth: 'user', owner: 'B', body: ReactRoomMessageBody, response: RoomReactions, summary: `Put a reaction (any one emoji) on a message I can see, or take mine off. A message carries at most ${ROOM_REACTION_EMOJI_MAX} different emoji: a new one past that is refused (409, reason reactions_full). Never notifies.` }),
  editRoomMessage: endpoint({ method: 'PATCH', path: '/api/rooms/:id/messages/:messageId', auth: 'user', owner: 'B', body: EditRoomMessageBody, response: RoomMessage, summary: 'Edit my own message.' }),
  roomMessageLinkAudience: endpoint({ method: 'POST', path: '/api/rooms/:id/message-links/audience', auth: 'user', owner: 'B', body: MessageLinkAudienceBody, response: MessageLinkAudience, summary: 'Before sending message links into a room I am in: the links I can see that someone who would read my message cannot (yes/no only, never who or how many), and whether "Show message" may go with each. Anything else is left out, the same for a message that is not there. Rate limited (429).' }),
  hideRoomLinkPreview: endpoint({ method: 'POST', path: '/api/rooms/:id/messages/:messageId/hide-preview', auth: 'user', owner: 'B', body: HideLinkPreviewBody, response: RoomMessage, summary: 'Remove the preview of one message link from my own message, for everyone (its snapshot is deleted). The message is not marked edited.' }),
  deleteRoomMessage: endpoint({ method: 'DELETE', path: '/api/rooms/:id/messages/:messageId', auth: 'user', owner: 'B', status: 204, response: empty, summary: 'Delete my own message (its text and files are removed; "deleted" stays in its place).' }),
  markRoomRead: endpoint({ method: 'POST', path: '/api/rooms/:id/read', auth: 'user', owner: 'B', body: MarkRoomReadBody, response: RoomReadState, summary: 'Move my read position forward to seq (never back); nobody else is told.' }),
  listRoomMembers: endpoint({ method: 'GET', path: '/api/rooms/:id/members', auth: 'user', owner: 'B', response: z.object({ items: z.array(RoomMember) }), summary: 'Who is in a room I am in (names only; nobody\'s read position).' }),
  inviteRoomMembers: endpoint({ method: 'POST', path: '/api/rooms/:id/members', auth: 'user', owner: 'B', body: InviteRoomBody, response: Room, summary: 'Add people to a group chat I am in (any member; active people only). They see it from now on. Not audited.' }),
  removeRoomMember: endpoint({ method: 'DELETE', path: '/api/rooms/:id/members/:userId', auth: 'user', owner: 'B', status: 204, response: empty, summary: 'Take someone out of a group chat I am in: its manager, or an owner or admin in it (never myself: leave instead). Not audited.' }),
  setRoomHidden: endpoint({ method: 'PUT', path: '/api/rooms/:id/hidden', auth: 'user', owner: 'B', body: SetRoomHiddenBody, response: Room, summary: 'Hide a DM, a team room or the everyone room from my own lists, or show it again (nobody else is told; a group chat is left instead). Hiding unpins it. It comes back by itself when something for me arrives.' }),
  pinRoom: endpoint({ method: 'POST', path: '/api/rooms/:id/pin', auth: 'user', owner: 'B', response: Room, summary: 'Pin a room I am in to the top of my own conversation list ("Pin to top"; nobody else is told). Pinned already: unchanged. A hidden room: 409 room_hidden (hiding unpins it). At most 50 pins (409 room_pins_full). My other windows hear it (room.updated).' }),
  unpinRoom: endpoint({ method: 'DELETE', path: '/api/rooms/:id/pin', auth: 'user', owner: 'B', response: Room, summary: 'Unpin a room ("Unpin"); not pinned: unchanged. My other windows hear it (room.updated).' }),
  leaveRoom: endpoint({ method: 'POST', path: '/api/rooms/:id/leave', auth: 'user', owner: 'B', status: 204, response: empty, summary: 'Leave a group chat; the last one to leave closes it. Not audited.' }),
  uploadRoomFile: endpoint({ method: 'POST', path: '/api/rooms/:id/files', auth: 'user', owner: 'B', status: 201, body: multipart(RoomFileUploadFields, SMALL_UPLOAD_MAX), response: RoomFile, summary: 'Upload a file (≤ 50 MB) to send in a room I am in; stored outside the team folder, readable by the room\'s members once sent.' }),
  attachRoomTeamFile: endpoint({ method: 'POST', path: '/api/rooms/:id/team-file', auth: 'user', owner: 'B', status: 201, body: RoomTeamFileBody, response: RoomTeamFile, summary: 'Copy a team-folder file I may read now (not a folder, a link or a quarantined file: 404 like a missing one; ≤ 50 MB) as my upload to send in a room I am in, readable by the room\'s members once sent; with how many other members cannot open the team file (a count). The same unchanged file again before sending: that copy again; past 200 MB of my unsent copies: 409 team_copies_full. Audited when sent (room.team_file).' }),
  roomFile: endpoint({ method: 'GET', path: '/api/rooms/:id/files/:fileId', auth: 'user', owner: 'B', query: RoomFileQuery, response: stream(true), summary: 'A file sent in a room I am in (membership checked on every read); thumb=1 for an image preview, download=1 as an attachment. Inline, a page or script type is sent as text/plain with a sandbox CSP: never a page of the app. A file on the safety check\'s download-only list is sent only with download=1 (503 quarantined otherwise).' }),
  roomFileHwpPreview: endpoint({ method: 'GET', path: '/api/rooms/:id/files/:fileId/hwp-preview', auth: 'user', owner: 'B', query: HwpPreviewQuery, response: HwpPreviewPage, summary: 'One page of a Hangul file (HWP, HWPX) sent in a room I am in, as a PNG from the HWP Preview plugin: the team file preview\'s renderer, limits and cache. Checked on every request as reading the file inline is: a member, the message visible to me and not deleted (404 otherwise), not on the download-only list (503 quarantined). The plugin off or not usable here: 503 unavailable with params.reason disabled, as for a team file. Pages are 1-based.' }),
} as const

/** The team files an answer links to or shows (/api/files/download?path=… and the file view's ?path=…), as the app's
 * links name them (no slashes around): what RoomMessage.openable is checked from. */
export function answerFilePaths(body: string, max = 100): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/(?:\/api\/files\/download|\/files\/view)\?([^\s)"'<>\]]+)/g)) {
    let p: string | null = null
    try { p = new URLSearchParams(m[1]!.replace(/&amp;/g, '&')).get('path') } catch { /* not a query */ }
    const clean = p?.replace(/^\/+|\/+$/g, '')
    if (clean) out.add(clean)
    if (out.size >= max) break
  }
  return [...out]
}
