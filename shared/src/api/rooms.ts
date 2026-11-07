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
// The AI in a room ("대화방의 트리나", docs/DECISIONS.md): a message that calls it ("@트리나 …", roomAiCalled) runs a
// normal chat turn as the person who sent it, in their own AI session for that room. Only they see its steps and can
// stop it (room.ai.run / room.ai.step, GET /api/rooms/:id/ai); the others see that the AI is answering (room.ai). The
// answer is an 'ai' message asked by them: for the whole room when every member may read every file the session read
// and it used nothing else, else a private preview for them only, which they may post (shareRoomMessage).
//
// Threads, reactions, no read receipts (docs/DECISIONS.md "스레드와 반응"): any normal message of the room (not an event
// line, not deleted, for the whole room) can get replies in a thread (SendRoomMessageBody.threadRootId). Replies live in
// the thread, not in the room's timeline, unless sent to the room too (alsoInRoom); the root carries the thread's
// summary (RoomMessage.thread). A thread follows its root: who cannot see the root (a later member) sees none of it.
// Reactions are 8 fixed emoji (ROOM_REACTIONS); they never notify or count. Nobody is told who has read what.
import { z } from 'zod'
import { UserId, Uuid7 } from '../ids'
import { PRODUCT } from '../product'
import { ApiErrorBody, IsoTime, PageQuery, QueryBool, SMALL_UPLOAD_MAX, page } from './common'
import { empty, endpoint, multipart, stream } from './endpoint'
import { Attachment, MessageSources, Step, UserRef } from './entities'
import { RoomAlertSettings, RoomNotifyLevel } from './room-alerts'

export const ROOM_MESSAGE_MAX = 10_000
export const ROOM_FILES_MAX = 10
export const ROOM_MENTIONS_MAX = 50
/** an AI answer in a room is cut here (the rest is said to be cut) */
export const ROOM_AI_ANSWER_MAX = 60_000

/** The names that call the AI in a room ("@트리나 …"): its Korean name, the Latin and Japanese ones, and the product's
 * own names. Matched without regard to case; the web app's "@" list offers the first one in Korean. */
const AI_OWN_NAMES = ['트리나', 'Trina', 'トリナ']
export const ROOM_AI_NAMES: readonly string[] = [...new Set([...AI_OWN_NAMES, PRODUCT.shortName, PRODUCT.displayName])]
/** The product is named after its AI (the Trina edition): the app calls the AI by its short name there (the web app's
 * rooms.aiName, "트리나", like "@트리나"); the core edition calls it by the product's name. */
export const PRODUCT_NAMED_AFTER_AI = AI_OWN_NAMES.some((n) => PRODUCT.displayName.includes(n))
const AI_NAMES_LONGEST = [...ROOM_AI_NAMES].sort((a, b) => b.length - a.length)
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c)

/** Where "@<AI name>" stands in a text: after the start, a space or an opening mark, and not followed by a letter or a
 * digit ("@트리나야" is not it). `taken`: names of people mentioned in the message (a person called 트리나 wins, and a
 * mentioned person's "@name" that goes on from an AI name is theirs: "@Trina Kim"). */
export function roomAiMentions(body: string, taken: readonly string[] = []): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const lower = body.toLocaleLowerCase()
  const people = new Set(taken.map((n) => n.toLocaleLowerCase()))
  for (let i = body.indexOf('@'); i >= 0; i = body.indexOf('@', i + 1)) {
    if (i > 0 && !/[\s([{"'“‘]/.test(body[i - 1]!)) continue
    const name = AI_NAMES_LONGEST.find((n) => lower.startsWith(n.toLocaleLowerCase(), i + 1) && !isWordChar(body[i + 1 + n.length]))
    if (!name || people.has(name.toLocaleLowerCase())) continue
    if ([...people].some((p) => p.length > name.length && lower.startsWith(p, i + 1))) continue
    out.push({ start: i, end: i + 1 + name.length })
  }
  return out
}
/** "@전체" (docs/DECISIONS.md "@전체"): the word it is written with in each language (the everyone room's own name there).
 * The web app's "@" list writes the person's language's word (its rooms.mentionAll, one of these); the server takes a
 * message's mentionsAll only when one of them stands in its text where a mention may start, so what notifies is what
 * the text shows. */
export const ROOM_MENTION_ALL_WORDS: readonly string[] = ['전체', 'everyone', '全員', 'todos', 'semua']
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
/** Does this message call the AI? */
export const roomAiCalled = (body: string, taken: readonly string[] = []) => roomAiMentions(body, taken).length > 0
/** What the AI is asked: the message without the "@<AI name>" that starts it ("@트리나 /회의록 …" runs the skill). */
export function roomAiQuestion(body: string, taken: readonly string[] = []): string {
  const first = roomAiMentions(body, taken)[0]
  if (!first || body.slice(0, first.start).trim()) return body.trim()
  return body.slice(first.end).trim() || body.trim()
}

export const RoomKind = z.enum(['team', 'all', 'dm', 'group'])
export type RoomKind = z.infer<typeof RoomKind>

/** A group chat holds at most this many people, its maker included. */
export const ROOM_GROUP_MAX = 100
/** A room's own name: at most this many characters (after trimming). */
export const ROOM_NAME_MAX = 80
/** What a room's name may not hold: control characters, every format character (bidirectional marks, overrides and
 * isolates, zero-width spaces and non-joiners, the byte order mark, soft hyphens, invisible operators, tag characters,
 * …) but the zero-width joiner that emoji sequences need, line and paragraph separators, and the blank letters that
 * draw nothing (the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the blank Braille pattern U+2800). */
const NAME_FORBIDDEN = /(?!\u200d)\p{Cf}|[\p{Cc}\u2028\u2029\u115f\u1160\u3164\uffa0\u2800]/u
/** ...and it must show something: at least one letter, number, symbol or punctuation mark (not only spaces, combining
 * marks or joiners). */
const NAME_VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u
/** A room's own name as typed: trimmed, at most ROOM_NAME_MAX characters, no control characters. '' (or null) takes it
 * back to the server's name (the group's name, the app's word for everyone, a group chat's members). Always shown as
 * plain text. */
export const RoomName = z.string().trim().max(ROOM_NAME_MAX).refine((s) => s === '' || (!NAME_FORBIDDEN.test(s) && NAME_VISIBLE.test(s)), { message: 'invisible or control characters' })

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

/** The reactions a message can get (a fixed set; the request is checked against it). */
export const ROOM_REACTIONS = ['👍', '✅', '👀', '🙏', '😂', '🎉', '❤️', '🔥'] as const
export const RoomReactionEmoji = z.enum(ROOM_REACTIONS)
export type RoomReactionEmoji = z.infer<typeof RoomReactionEmoji>
/** Who reacted with one emoji: at most this many names come with it (the count is all of them). */
export const ROOM_REACTION_NAMES = 10

/** One emoji on a message: how many members put it there, whether I did, and who (the first ROOM_REACTION_NAMES, in
 * the order they reacted; only people in the room now). In the order the emoji were first used. */
export const RoomReaction = z.object({
  emoji: RoomReactionEmoji,
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

/** The quoted message under a reply: an excerpt (at most 200 characters), or nothing once it was deleted. */
export const RoomQuote = z.object({
  id: Uuid7,
  author: UserRef.nullable(),
  excerpt: z.string(),
  fileCount: z.number().int().nonnegative(),
  deleted: z.boolean(),
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
  /** a line this build cannot read (a newer build's, or a damaged one): said neutrally, without who did it */
  z.object({ type: z.literal('unknown') }),
])
export type RoomEventLine = z.infer<typeof RoomEventLine>

export const RoomMessage = z.object({
  id: Uuid7,
  roomId: Uuid7,
  /** position in the room, 1, 2, 3 … (read positions refer to it; thread replies take one too); gaps are possible */
  seq: z.number().int().positive(),
  /** 'user' for now. Reserved for the AI step: 'ai' (author null, askedBy = who asked it) */
  authorKind: z.enum(['user', 'ai']),
  /** the sender as the server knows them (never taken from the request); null: the AI, or an account that is gone */
  author: UserRef.nullable(),
  /** reserved for the AI step: who asked the AI (null otherwise) */
  askedBy: UserRef.nullable(),
  /** 'room': everyone in the room. Reserved for the AI step: 'private', seen by one person only (a preview of an AI
   * answer before it is shared); it makes no notice, badge or unread count for anyone else */
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
  /** an AI answer: how many files its "참고한 파일" list holds (GET …/sources checks each one for the viewer) */
  sourceCount: z.number().int().nonnegative().optional(),
  /** a private preview of an AI answer, to the person who asked only: why it did not go to the room. folders: team
   * folders some member cannot read ('' = the top of the team folder); personal: their own folder (or what only they
   * see: the in-app browser, a personal connection); outside: web pages, connected services or other tools */
  preview: z.object({ folders: z.array(z.string()),
    /** more such folders the person who asked cannot open themselves: never named to them */
    otherFolders: z.boolean().optional(), personal: z.boolean(), outside: z.boolean(),
    /** members who were not in the room yet when a message the AI was given was written (their names) */
    joinedLater: z.array(z.string()).optional() }).optional(),
  /** an AI answer: the team files it links to or shows that the viewer may open now; the app shows the others as plain
   * text (no link, no picture loaded) */
  openable: z.array(z.string()).optional(),
  /** a question to the AI whose answer went to its author only (a private preview not posted): true for the other
   * members who see the question ("○○ 님에게만 답했어요" under it), never for the author; nothing of the answer or why.
   * Gone once the author posts the answer */
  answeredPrivately: z.boolean().optional(),
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
})
export type RoomMessage = z.infer<typeof RoomMessage>

/** One question to the AI in a room, as the person who asked sees it (nobody else gets one). */
export const RoomAiRun = z.object({
  turnId: Uuid7,
  roomId: Uuid7,
  /** the room message that asked */
  questionId: Uuid7,
  /** the question was a reply in this thread (the root's id): its answer goes there */
  threadRootId: Uuid7.optional(),
  state: z.enum(['queued', 'running', 'done', 'stopped', 'error']),
  /** queued: answers ahead in the team's queue (1 = next); 0 otherwise */
  position: z.number().int().nonnegative(),
  /** what the AI did so far (file names and searches: for this person only, never for the room) */
  steps: z.array(Step),
  /** why it ended without an answer (state error) */
  error: ApiErrorBody.nullable(),
  createdAt: IsoTime,
})
export type RoomAiRun = z.infer<typeof RoomAiRun>
/** answering: questions the AI is answering in the room now (anyone's; nobody is named); mine: my own of them */
export const RoomAiState = z.object({ answering: z.number().int().nonnegative(), mine: z.array(RoomAiRun) })
export type RoomAiState = z.infer<typeof RoomAiState>

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
  /** the room's AI waits on me: a question I asked @트리나 there shows a card for my answer (docs/DECISIONS.md "Session
   * markers": the room's "?"). Absent = no. */
  aiWaits: z.literal(true).optional(),
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
/** people to add to a group chat (active people of this team; those already in it are skipped). They see the room from
 * now on, never what was said before. */
export const InviteRoomBody = z.object({ userIds: z.array(UserId).min(1).max(ROOM_GROUP_MAX - 1) }).strict()

/** Without a cursor: the newest `limit` messages, oldest first; nextCursor fetches older ones (prepend). */
export const ListRoomMessagesQuery = PageQuery
export const RoomMessagesPage = page(RoomMessage)

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
}).strict().refine((b) => b.body.trim().length > 0 || b.fileIds.length > 0, { message: 'empty message', path: ['body'] })
export const EditRoomMessageBody = z.object({
  body: z.string().min(1).max(ROOM_MESSAGE_MAX),
  mentions: z.array(UserId).max(ROOM_MENTIONS_MAX).default([]),
  /** the message keeps its "@전체" (only a send adds it: an edit notifies nobody, so it cannot add it, 400) */
  mentionsAll: z.boolean().optional(),
}).strict()
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
export const RoomFileQuery = z.object({ thumb: QueryBool.optional(), download: QueryBool.optional() })

export const ROOMS = {
  listRooms: endpoint({ method: 'GET', path: '/api/rooms', auth: 'user', owner: 'B', response: z.object({ items: z.array(Room), alerts: RoomAlertSettings.optional() }), summary: 'The rooms I am in (my team rooms, everyone, DMs, group chats), most recent activity first, with my unread count, the last message and my notification level; alerts: what else decides whether a message rings (thread replies, quiet hours, the team time zone).' }),
  createRoom: endpoint({ method: 'POST', path: '/api/rooms', auth: 'user', owner: 'B', status: 201, body: CreateRoomBody, response: Room, summary: 'Open the DM with a person (the existing one when there is one), or make a group chat with two or more people. Not audited: admins do not learn who talks to whom.' }),
  getRoom: endpoint({ method: 'GET', path: '/api/rooms/:id', auth: 'user', owner: 'B', response: Room, summary: 'One room I am in (404 for anyone else, admins included).' }),
  updateRoom: endpoint({ method: 'PATCH', path: '/api/rooms/:id', auth: 'user', owner: 'B', body: UpdateRoomBody, response: Room, summary: 'Set my notification level for a room (all, mentions, off, or my default), or rename it (group chats: any member; team and everyone rooms: owner or admin members; never a DM).' }),
  listRoomMessages: endpoint({ method: 'GET', path: '/api/rooms/:id/messages', auth: 'user', owner: 'B', query: ListRoomMessagesQuery, response: RoomMessagesPage, summary: 'The timeline of a room I am in from my join on (thread replies only when sent to the room too), newest page first, oldest first within it.' }),
  sendRoomMessage: endpoint({ method: 'POST', path: '/api/rooms/:id/messages', auth: 'user', owner: 'B', status: 201, body: SendRoomMessageBody, response: RoomMessage, summary: 'Send a message as myself (never another author), or a reply in a thread, with @mentions (or @전체 for everyone: mentionsAll; in the everyone room owners and admins only) and files; DMs, group chats, mentions and followed threads notify.' }),
  listRoomThread: endpoint({ method: 'GET', path: '/api/rooms/:id/messages/:messageId/thread', auth: 'user', owner: 'B', query: ListRoomMessagesQuery, response: RoomThreadPage, summary: 'A thread in a room I am in: its root and the replies I can see (none of it when I cannot see the root).' }),
  markRoomThreadRead: endpoint({ method: 'POST', path: '/api/rooms/:id/messages/:messageId/thread/read', auth: 'user', owner: 'B', body: MarkRoomReadBody, response: RoomThreadReadState, summary: 'Move my read position in a thread I follow forward to seq; its notices count as read.' }),
  reactRoomMessage: endpoint({ method: 'PUT', path: '/api/rooms/:id/messages/:messageId/reactions', auth: 'user', owner: 'B', body: ReactRoomMessageBody, response: RoomReactions, summary: 'Put one of the fixed reactions on a message I can see, or take mine off. Never notifies.' }),
  editRoomMessage: endpoint({ method: 'PATCH', path: '/api/rooms/:id/messages/:messageId', auth: 'user', owner: 'B', body: EditRoomMessageBody, response: RoomMessage, summary: 'Edit my own message.' }),
  deleteRoomMessage: endpoint({ method: 'DELETE', path: '/api/rooms/:id/messages/:messageId', auth: 'user', owner: 'B', status: 204, response: empty, summary: 'Delete my own message (its text and files are removed; "deleted" stays in its place).' }),
  markRoomRead: endpoint({ method: 'POST', path: '/api/rooms/:id/read', auth: 'user', owner: 'B', body: MarkRoomReadBody, response: RoomReadState, summary: 'Move my read position forward to seq (never back); nobody else is told.' }),
  listRoomMembers: endpoint({ method: 'GET', path: '/api/rooms/:id/members', auth: 'user', owner: 'B', response: z.object({ items: z.array(RoomMember) }), summary: 'Who is in a room I am in (names only; nobody\'s read position).' }),
  inviteRoomMembers: endpoint({ method: 'POST', path: '/api/rooms/:id/members', auth: 'user', owner: 'B', body: InviteRoomBody, response: Room, summary: 'Add people to a group chat I am in (any member; active people only). They see it from now on. Not audited.' }),
  removeRoomMember: endpoint({ method: 'DELETE', path: '/api/rooms/:id/members/:userId', auth: 'user', owner: 'B', status: 204, response: empty, summary: 'Take someone out of a group chat I am in: its manager, or an owner or admin in it (never myself: leave instead). Not audited.' }),
  leaveRoom: endpoint({ method: 'POST', path: '/api/rooms/:id/leave', auth: 'user', owner: 'B', status: 204, response: empty, summary: 'Leave a group chat; the last one to leave closes it. Not audited.' }),
  uploadRoomFile: endpoint({ method: 'POST', path: '/api/rooms/:id/files', auth: 'user', owner: 'B', status: 201, body: multipart(RoomFileUploadFields, SMALL_UPLOAD_MAX), response: RoomFile, summary: 'Upload a file (≤ 50 MB) to send in a room I am in; stored outside the team folder, readable by the room\'s members once sent.' }),
  roomFile: endpoint({ method: 'GET', path: '/api/rooms/:id/files/:fileId', auth: 'user', owner: 'B', query: RoomFileQuery, response: stream(true), summary: 'A file sent in a room I am in (membership checked on every read); thumb=1 for an image preview.' }),
  getRoomAi: endpoint({ method: 'GET', path: '/api/rooms/:id/ai', auth: 'user', owner: 'B', response: RoomAiState, summary: 'How many questions the AI is answering in a room I am in, and my own of them with their steps.' }),
  stopRoomAi: endpoint({ method: 'POST', path: '/api/rooms/:id/ai/:turnId/stop', auth: 'user', owner: 'B', response: z.object({ stopped: z.boolean() }), summary: 'Stop the AI answering my question (only the person who asked; anyone else gets 404).' }),
  shareRoomMessage: endpoint({ method: 'POST', path: '/api/rooms/:id/messages/:messageId/share', auth: 'user', owner: 'B', response: RoomMessage, summary: 'Post my private preview of an AI answer to the room: sources some member cannot read are left out; it notifies like a new message and is audited.' }),
  roomMessageSources: endpoint({ method: 'GET', path: '/api/rooms/:id/messages/:messageId/sources', auth: 'user', owner: 'B', response: MessageSources, summary: 'The files an AI answer in a room I am in used, each checked against my access now (no name or path for the others).' }),
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
