// The room side chat (✦ Trina, docs/DECISIONS.md "Trina side chat"): a private AI chat of mine beside a room, opened from
// the room's header. A column beside the room on computers (beside the thread too when one is open: pages/Room.tsx,
// docs/decisions/20261117-thread-plus-trina.md), the whole screen on phones; in the file viewer's column one of the two
// at a time. While a thread is open beside it (`thread`), its box carries a chip, "Looking at this thread", with ✕:
// with the chip on a question goes with a thread line on top (shared rooms.ts threadLineOf: the thread's id, no message
// text; the AI reads the thread with room_read, which checks what I may read), its answer offers that thread first, and
// an empty chat offers "Summarize this thread"; ✕ takes it off for that thread (questions are about the room again), and
// a quoted message takes its place while it shows. It is an ordinary chat of mine (chats.side_room_id): the AI is told the room and reads it with
// its room tools as I see it (chat/room-tools.ts); nothing goes to the room until I press the one button under an
// answer (components/rooms/SendHere.tsx): "스레드에 보내기" for an answer about a message of the room (that message's
// thread, named in the question's quote: lib/sideChatSend.ts; ▾ for the room), else "대화방에 보내기". It goes at once;
// the server's checks of files and material some members cannot see ask first with the confirm step of
// components/chat/ShareToRoom.tsx. Sent, its 보기 opens the thread at the reply (in this column; ✦ brings this chat back)
// or the room at the message (a phone: this panel closes). Opened, it starts on a new chat (docs/DECISIONS.md "The side
// chat opens on a new chat": the starters, or the message or file it was asked about), made by the first question, so
// opening and closing leaves nothing behind; the last chat comes back while it is not done (its answer on its way, the
// AI waiting on me, an answer I have not seen) or while what I typed or attached waits in its box (sideChatOpening).
// Closing is ✕, ‹ or ✦ on the room page, leaving the room, the thread that took its place on the room page closing
// (where the two do not show together), or the file viewer closing after it showed it (also from its thread). The column switching between a thread and it (✦,
// "스레드로 돌아가기"), hiding the viewer's column or sheet, and the room page and the viewer showing it together are not;
// nor is 보기, a hand-off (threadClosedOn, viewerClosedOn): ✦ brings the same chat back. "New chat" starts another one
// with the next question; 🕘 lists the room's side chats (newest first) and opens one. Cards the AI
// raises (a yes before a change, a question) show under its answer as in the full chat; while it waits for the answer
// to its question, what I type in the box answers it (lib/askAnswer.ts), as the full chat's box does.
// Files and pictures go with a question as in the full chat's box, with its own parts (components/chat/ComposerFiles.tsx):
// 📎, pasted into the box, or dropped anywhere on the panel (components/FileDropZone.tsx: its overlay, the nearest panel
// wins); each is uploaded into this side chat at once (my own attachments folder, as in any chat of mine; a side chat
// not made yet is made by the first file) and shows above the box, a picture as its 64 px square, with ✕. At most 20 per message, the same messages when one fails. They go with what
// is typed in the box (a starter or quick question goes alone, and an answer to the AI's question is its text alone);
// "Share to room" sends the answer, never these. On a computer no team-folder files here (the full chat has them); a phone's
// 📎 is the attach sheet every message box has there (components/chat/AttachSheet.tsx), its 팀 파일 attached by reference
// as in the full chat's box.
// Voice input as in every message box (lib/useVoiceInput.ts, components/VoiceBar.tsx; docs/decisions/
// 20261117-side-chat-mic.md): the mic right before send, Space held in the box on a computer, a finger held on the
// mic; the words go to the end of the box and are never sent by themselves. The recording names the side chat shown (an
// ordinary chat of mine; none yet: the server answers as for a new chat), so a confidential one says why instead of
// recording (lib/voice.ts voiceBlockedHere), as the full chat's box does.
// Which chat it shows, its draft, its quote, its files and whether it is open are kept per room on this page
// (store/sideChats.ts; the files in the composer's stash, `side:<room id>`): every panel of the room is the same chat, and
// a draft stays for this page's session. The files were uploaded into the chat shown, so another chat (New chat, 🕘)
// drops them, and an opening keeps the chat they wait in. The column around it is components/rooms/RoomSideColumn.tsx: drawn
// here (`frame`), or by the room page around this (frame={false}). `closeX`: the ✕ at every width, never the phone's ‹
// (the file viewer's sheet on a phone, which closes back to the file).
import { GuestNoAi, useGuestNoAi } from '../GuestView'
import { isGuestMe, meGuest } from '../../lib/guests'
import { textOverLimit } from '../../lib/longPaste'
import { useAiAccess } from '../../store/aiAccess'
import { QueueFull, useSendQueue } from '../../store/sendQueue'
import { parseQueue, queueKey } from '../../lib/sendQueue'
import { sideChatWasOpen } from '../../lib/sideChatOpenKeep'
import QueuedMessages from '../chat/QueuedMessages'
import { ChevronLeft, ExternalLink, Eye, History, Loader2, Paperclip, SquarePen, X } from 'lucide-react'
import clsx from 'clsx'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MESSAGE_ATTACHMENTS_MAX, MESSAGE_TEXT_MAX, SIDE_CHAT_QUICK, SIDE_QUICK_FILE, SIDE_QUICK_MESSAGE, THREAD_LINE, threadRefToken, type Chat, type EngineId } from '@mycel/shared/api'
import { oneLineName } from '@mycel/shared'
import { api, API, errorText, isApiError, isConnectionError } from '../../lib/api'
import { waitForUpdate, waitsForUpdate } from '../../lib/serverUpdating'
import { readDraft, writeDraft } from '../../lib/localData'
import { answerTooLong, BoxAnswers, composerAnswer, composerQuestion, picksOf } from '../../lib/askAnswer'
import { useSecretHold } from '../chat/SecretWarning'
import { formatDate, formatDateTime } from '../../lib/format'
import { closeImageViewer, getImageViewer } from '../../lib/imageViewer'
import { useOverlayEntry } from '../../lib/backCloses'
import { markerOf } from '../../lib/sessionMarkers'
import { quotes, sendTargets } from '../../lib/sideChatSend'
import { aiName } from '../../lib/tabs'
import { readStash } from '../../lib/teamAttach'
import { useConfidentialChat } from '../../lib/confidential'
import { useVoiceInput } from '../../lib/useVoiceInput'
import { micState, voiceBlockedHere } from '../../lib/voice'
import { useStickToBottom } from '../../lib/stickToBottom'
import { useEndAfterRecording } from '../../lib/autoGrow'
import { useLocale, useT } from '../../i18n'
import { useChats } from '../../store/chats'
import { useRooms } from '../../store/rooms'
import { plainLine, projectRoomOf } from '../../lib/rooms'
import { useMeStrict, useSession } from '../../store/session'
import { sideChatOnScreen } from '../../store/sessionMarkers'
import { SEED_KEYS_MAX, sideChatOf, useSideChats, type SideChatState } from '../../store/sideChats'
import { emptyThread, runningMessage, type ViewMessage } from '../../store/thread'
import { toast } from '../../store/ui'
import { ComposerFileList, useComposerFiles, type Pending } from '../chat/ComposerFiles'
import { AttachMenu } from '../composer/AttachMenu'
import { ComposerField } from '../composer/ComposerField'
import { ComposerShell } from '../composer/ComposerShell'
import { composerHint } from '../composer/drafts'
import type { Unsent } from '../composer/ComposerNotices'
import { FileDropZone, type DropTarget } from '../FileDropZone'
import { AssistantMessage, UserMessage } from '../chat/Messages'
import { ImageGroup, ViewerMeta } from '../ImageViewer'
import { IconButton, useAnnounce } from '../ui'
import { LoadError } from '../LoadError'
import { AiFace, AiMark } from './AiFace'
import { RoomSideColumn } from './RoomSideColumn'
import type { SentHere } from './SendHere'
import { appChip } from '../../lib/roomApps'
import { useDemoOut } from '../../store/demo'

/** the side chat's kept draft (`side:<room id>`): its text and the chat it was written in (null: a new chat) */
function parseKept(raw: string): { chatId: string | null; text: string } | null {
  try {
    const v = JSON.parse(raw) as { chatId?: unknown; text?: unknown }
    return typeof v.text === 'string' && (v.chatId === null || typeof v.chatId === 'string') ? { chatId: v.chatId, text: v.text } : null
  } catch {
    return null
  }
}

/** the newest side chat of mine for this room (not deleted), or null: one asks the server */
export async function newestSideChat(roomId: string): Promise<Chat | null> {
  const r = await api.call(API.listChats, { query: { sideRoomId: roomId, limit: 1 } })
  return r.items[0] ?? null
}
/** The chat a panel shows when this page knows none for the room (the first opening after a reload, the one it showed
 * deleted meanwhile): the room's newest side chat while it is not done (the server's word: its answer running or queued,
 * the AI waiting on me, an answer I have not seen), with its messages read; else none, a new chat. Asked once however
 * many panels of the room open together. */
const looking = new Map<string, Promise<string | null>>()
function findSideChat(roomId: string): Promise<string | null> {
  let p = looking.get(roomId)
  if (!p) {
    p = (async () => {
      const c = await newestSideChat(roomId)
      if (!c || (!markerOf(c) && !queuedIn(c.id))) return null
      await useChats.getState().loadThread(c.id)
      return c.id
    })().finally(() => looking.delete(roomId))
    looking.set(roomId, p)
  }
  return p
}

/** Messages of mine wait in the chat to be sent (store/sendQueue.ts): in this window, or kept by this browser (a reload). */
function queuedIn(chatId: string): boolean {
  if (useSendQueue.getState().queues[chatId]?.items.length) return true
  const st = useSession.getState().status
  if (st.kind !== 'signed-in') return false
  try {
    return !!parseQueue(localStorage.getItem(queueKey(st.me.user.id, chatId)))
  } catch {
    return false
  }
}

/** Any messages of mine waiting to be sent in any chat (this window, or kept by this browser): cheap, before asking the
 * server which side chat is the room's newest. */
function anyQueued(userId: string): boolean {
  if (Object.values(useSendQueue.getState().queues).some((q) => q?.items.length)) return true
  try {
    const prefix = queueKey(userId, '')
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(prefix)) return true
  } catch { /* storage blocked: nothing kept there */ }
  return false
}

/**
 * Does the room's side chat open by itself as the room page opens (QA TC-4963, docs/decisions/
 * 20261118-side-chat-reload.md)? After a reload when it was open in this tab before (lib/sideChatOpenKeep.ts: on a phone
 * too, where it is the screen that was showing, as a thread's address brings its screen back). On a computer also when
 * messages of mine wait to be sent in the room's newest side chat: the panel beside the room shows them and the answer
 * they wait for. Not on a phone for that alone: it would cover the room the person chose to open with a screen they had
 * closed; ✦ opens it on that chat (sideChatOpening keeps a chat that is not done).
 */
export async function sideChatComesBack(roomId: string, userId: string, phone: boolean): Promise<boolean> {
  if (sideChatWasOpen(userId, roomId)) return true
  if (phone || !anyQueued(userId)) return false
  const c = await newestSideChat(roomId).catch(() => null)
  return !!c && queuedIn(c.id)
}

/** The chat is not done: its answer is on its way (sending, running or queued), the AI waits on me (a card), an answer
 * finished, failed or paused that I have not seen (Trina history's marker for it: lib/sessionMarkers.ts markerOf), or
 * messages of mine still wait to be sent in it (queuedIn). */
function notDone(chatId: string): boolean {
  if (queuedIn(chatId)) return true
  const s = useChats.getState()
  const messages = s.threads[chatId]?.messages ?? []
  if (runningMessage(messages) || messages.some((m) => m.local?.state === 'sending')) return true
  // a card of it open in this window, also for a chat the list does not keep (one opened from 🕘)
  if (Object.values(s.requests).some((r) => r.chatId === chatId)) return true
  const chat = s.chats.find((c) => c.id === chatId)
  return !!chat && !!markerOf(chat)
}
/** the composer's stash of the room's box files (components/chat/ComposerFiles.tsx), the same in every panel of the room */
const filesDraft = (roomId: string) => `side:${roomId}`

/** A panel that comes on screen while the room's side chat is closed opens it afresh: a new chat (made by the first
 * question), with the starters or what this opening asks about, unless the last one is not done (notDone) or something
 * waits in its box: typed text, files (uploaded into that chat; a failed one is not sent), which stay with the chat and
 * its quote for this page's session. A chat with nothing in it yet (made for a file) is a new chat already, so it stays
 * rather than leave an empty one in 🕘. Returns the change, or null: it is open (another panel shows it, or a thread
 * took its place), so this panel shows the same chat. */
function sideChatOpening(roomId: string, userId: string): Partial<SideChatState> | null {
  const s = sideChatOf(useSideChats.getState(), roomId)
  if (s.open) return null
  const box = !!s.draft.trim() || readStash<Pending>(userId, filesDraft(roomId)).some((f) => f.status !== 'failed')
  const quote = box ? {} : { quoted: null }
  // undefined: none known on this page yet, looked for as the panel opens (findSideChat); null: a new chat already
  const id = s.chatId
  if (!id || box || notDone(id) || !useChats.getState().threads[id]?.messages.length) return { open: true, ...quote }
  return { open: true, chatId: null, ...quote }
}

/** 보기 under an answer showed it elsewhere (`view` below): the column it leaves closing for that (the file viewer it
 * was in; the thread it opened on the room page, closed again) does not close the side chat: ✦ brings it back */
const handedOff = { viewer: new Set<string>(), thread: new Set<string>() }
/** The file viewer closed after its column showed the room's side chat (components/rooms/ViewerColumn.tsx): that closes
 * the side chat, unless the room page has it open under the viewer or 보기 closed the viewer. */
export function viewerClosedOn(roomId: string) {
  if (handedOff.viewer.delete(roomId)) return
  if (useRooms.getState().side[roomId] !== 'trina') useSideChats.getState().close(roomId)
}
/** The room page's thread closed (pages/Room.tsx): a side chat it took the place of is closed with it, unless the
 * column switched back to the side chat (✦, "Ask Trina about this") or 보기 opened that thread. */
export function threadClosedOn(roomId: string) {
  if (handedOff.thread.delete(roomId)) return
  if (useRooms.getState().side[roomId] !== 'trina') useSideChats.getState().close(roomId)
}
/** 보기 under an answer opens a thread that takes the side chat's place on the room page (pages/Room.tsx viewThread):
 * a hand-off, so that thread closing does not close the side chat. */
export function handOffToThread(roomId: string) {
  handedOff.thread.add(roomId)
}
/** The person opened or closed the side chat on the room page themselves: a hand-off to a thread is over (a thread
 * that later takes the side chat's place closes it again when it closes). */
export function handOffDone(roomId: string) {
  handedOff.thread.delete(roomId)
}
/** The room page left the room: its side chat is closed (back in it, ✦ opens it afresh). */
export function roomLeft(roomId: string) {
  handedOff.viewer.delete(roomId)
  handedOff.thread.delete(roomId)
  useSideChats.getState().close(roomId)
}

/** the side chat being made for the room's first question or file, per room */
const making = new Map<string, Promise<string>>()
/** the chat each room's box files were uploaded into (they go with a question there only) */
const filesOf = new Map<string, string>()
/** The side chat a question or a file goes into: the one the panel shows; while it is still looked for, the one
 * findSideChat finds; none, a new side chat of the room, made once however many files and questions come at once (one path for both,
 * so a file and the first question never make two), which the panel shows from then on. */
function chatToWrite(roomId: string): Promise<string> {
  const shown = sideChatOf(useSideChats.getState(), roomId).chatId
  if (shown) return Promise.resolve(shown)
  let p = making.get(roomId)
  if (!p) {
    p = (async () => {
      const current = () => sideChatOf(useSideChats.getState(), roomId).chatId
      let id = shown === undefined ? await findSideChat(roomId) : null
      if (!current() && !id) {
        const c = await api.call(API.createChat, { body: { projectId: null, sideRoomId: roomId } })
        useChats.getState().upsertChat(c)
        id = c.id
      }
      if (!current()) useSideChats.getState().patch(roomId, { chatId: id })
      // the chat the panel shows by now (another one picked from 🕘 meanwhile: that one)
      return current() || id!
    })().finally(() => making.delete(roomId))
    making.set(roomId, p)
  }
  return p
}

/** A message of the room asked about ("Ask Trina about this" on it): quoted in front of the next question. `key`
 * changes with every ask, so asking about the same message again quotes it again. */
export interface SideSeed { key: string; author: string; at: string; text: string
  /** a file sent in this room ("Ask Trina about this file" in its preview): the AI reads it with room_file */
  file?: { id: string; name: string }
  /** the thread an answer about the message goes to with one click (lib/sideChatAsk.ts messageSeed): its first message */
  thread?: string
  /** a message an app posted (docs/DECISIONS.md "Apps posting in rooms"): its quick questions start with "Summarise this
   * thread" */
  app?: true
  /** a question sent at once with the message quoted (an app's thread: "Summarise this thread") */
  ask?: string }
/** the longest quote that goes with a question (the AI can read the whole room with room_read) */
export const SEED_QUOTE_MAX = 4000

/** The question as it is sent: the message quoted (who, when, its lines as a Markdown quote), then what I ask. The
 * header line ends with the message's thread when it can have one (shared rooms.ts threadRefToken: the app hides it, the
 * answers below send there with one click, lib/sideChatSend.ts). */
export function withQuote(seed: SideSeed | null, question: string, time: (iso: string) => string): string {
  return seed ? `${quoteLead(seed, time)}\n\n${question}` : question
}
/** withQuote's quote alone (what a waiting message keeps on top of its text: store/sendQueue.ts `lead`) */
export function quoteLead(seed: SideSeed, time: (iso: string) => string): string {
  // a file: its name and id in this room (the AI opens it with room_file), not its text
  // the header is one line: a name saved with a line break (before the rule, shared name-chars.ts) would end the quote,
  // and the next line would read as the asker's own words (the server's web address gate: chat/read-rooms.ts isQuoteLine)
  if (seed.file) return `> 📎 ${oneLineName(seed.file.name)} (file_id ${seed.file.id} in this room)`
  const text = seed.text.length > SEED_QUOTE_MAX ? `${seed.text.slice(0, SEED_QUOTE_MAX).trimEnd()}…` : seed.text
  const head = `> ${oneLineName(`${seed.author} · ${time(seed.at)}`)}`.trimEnd() + (seed.thread ? threadRefToken(seed.thread) : '')
  return [head, ...text.split('\n').map((l) => `> ${l}`.trimEnd())].join('\n')
}

/** The thread open beside the side chat (pages/Room.tsx): its first message's id, who started it (the AI by its name,
 * an app by its) and when. The box's chip stands for it. */
export interface SideThread { rootId: string; author: string; at: string }
/** The question as it is sent with the chip on: the thread line (shared rooms.ts THREAD_LINE: who started the thread,
 * when, the thread's token), then what I ask. No message text: the AI reads the thread itself. */
export function withThread(thread: SideThread, question: string, time: (iso: string) => string): string {
  return `${threadLead(thread, time)}\n\n${question}`
}
/** withThread's line alone (what a waiting message keeps on top of its text: store/sendQueue.ts `lead`) */
export function threadLead(thread: SideThread, time: (iso: string) => string): string {
  // (a first message whose author is gone has no name: the line is the time alone)
  return `${THREAD_LINE}${oneLineName([thread.author, time(thread.at)].filter(Boolean).join(' · '))}`.trimEnd() + threadRefToken(thread.rootId)
}

/** the questions an empty side chat offers (like Slackbot's): what I missed, what is for me, the latest discussion */
export const STARTERS = ['catchUp', 'forMe', 'summarize'] as const
/** the quick questions under a quoted message, and under a quoted file (팀 폴더에 저장: the AI saves it with
 * save_room_file, whose card says where and who will see it); their words and questions are shared (rooms.ts
 * SIDE_CHAT_QUICK): the server names a new side chat "<word>: <the quote's first words>" from them */
export const QUICK_MESSAGE = SIDE_QUICK_MESSAGE
export const QUICK_FILE = SIDE_QUICK_FILE

/** how many of the room's side chats 🕘 lists */
export const SIDE_HISTORY_MAX = 30
/** at most this many older pages are read to find where an answer goes (its question further up than the page read) */
export const OLDER_PAGES_MAX = 10

/** `frame` false: the column around it is the caller's (RoomSideColumn). `autoFocus` false: the box does not take the
 * focus as the panel opens (a new `seed` still does: it was asked for). `closeX`: ✕ instead of a phone's ‹. `thread`:
 * the thread open beside it on the room page (the box's chip). `onViewThread`: 보기 under an answer sent to a thread
 * opens it through the room page (which knows what shows beside what); absent: by its address. */
export function SideChatPanel({ roomId, roomTitle, onClose, seed = null, frame = true, autoFocus = true, closeX = false, thread: beside = null, onViewThread }: { roomId: string; roomTitle: string; onClose: () => void; seed?: SideSeed | null; frame?: boolean; autoFocus?: boolean; closeX?: boolean; thread?: SideThread | null; onViewThread?: (rootId: string, messageId: string) => void }) {
  const t = useT()
  const locale = useLocale()
  const me = useMeStrict()
  const navigate = useNavigate()
  const guestNoAi = useGuestNoAi()
  // a guest with their own sign-in not made yet: the line above the box offers it (Connect my AI), as Home's box does
  const guestOwn = meGuest(me)?.ai === 'own'
  // a guest's AI reads the rooms they are in (server chat/guest-tools.ts room_read, room_file) but saves no room file
  // (no save_room_file): no "Save to files" quick ask on a quoted file for them
  const guest = isGuestMe(me)
  // ...and only the group chat they were invited to: beside a 1:1 chat it reads nothing of the room, so that panel has no
  // room starters or "Looking at" line and says to quote or paste instead
  const roomUnread = guest && meGuest(me)?.room?.id !== roomId
  // a project's chat room (for a viewer who can open the project): the empty chat says it is private and where the
  // project's people ask together, the project page (docs/decisions/20261121-sidebar-projects-group.md). A guest, who
  // does not see a project's AI chats, keeps their own line
  const roomProject = useRooms((s) => projectRoomOf(s.rooms.find((r) => r.id === roomId) ?? {}))
  const projectHint = !guest && roomProject ? roomProject : null
  // and until it is made (ai-access answers usable), no starters or quick asks: nothing would answer them, so the
  // "Connect my AI" line is the one thing to do here
  const guestWaits = useAiAccess((s) => guestOwn && !(s.loaded && s.usable))
  // opened while the room's side chat was closed: which chat it starts on (sideChatOpening), decided once, written to
  // the store before the first paint and shown by this panel until then, so nothing here sees the chat it replaces
  const opening = useRef<Partial<SideChatState> | null | undefined>(undefined)
  if (opening.current === undefined) opening.current = sideChatOpening(roomId, me.user.id)
  useLayoutEffect(() => {
    const p = opening.current
    opening.current = null
    if (p) useSideChats.getState().patch(roomId, p)
  }, [])
  // the room's side chat as every panel of it shows it: undefined chat: still looking for it; null: a new chat (the
  // first question makes one)
  const stored = useSideChats((s) => sideChatOf(s, roomId))
  const { chatId, draft, quoted, chipOff } = opening.current ? { ...stored, ...opening.current } : stored
  const patch = useCallback((p: Partial<SideChatState>) => useSideChats.getState().patch(roomId, p), [roomId])
  /** the read of the room's side chat failed (the calm notice reads again by itself until it works) */
  const [loadError, setLoadError] = useState<unknown>(null)
  // the person opened or started a chat: theirs, and the read that looked for one is no longer needed
  const setChatId = (id: string | null) => {
    setLoadError(null)
    patch({ chatId: id })
  }
  const setDraft = (f: string | ((d: string) => string)) => patch({ draft: typeof f === 'function' ? f(sideChatOf(useSideChats.getState(), roomId).draft) : f })
  const setQuoted = (f: SideSeed | null | ((q: SideSeed | null) => SideSeed | null)) => patch({ quoted: typeof f === 'function' ? f(sideChatOf(useSideChats.getState(), roomId).quoted) : f })
  /** 🕘: the room's side chats, newest first (null: the list is not open) */
  const [history, setHistory] = useState<Chat[] | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  // phones: Back closes the list and shows the chat again, not the whole side chat (lib/backCloses.ts)
  useOverlayEntry(!!history, () => setHistory(null))
  // session markers: the chat this panel shows is on screen in this window, as a full chat is (store/sessionMarkers.ts
  // marks its answer seen: no "New answer" dot in Trina history, no notification); not while the 🕘 list covers it
  const listOpen = !!history
  useEffect(() => {
    if (chatId && !listOpen) return sideChatOnScreen(chatId)
  }, [chatId, listOpen])
  // the AI's open question in this chat: the box answers it
  const question = useChats((s) => (chatId ? composerQuestion(s.requests, chatId) : null))
  const thread = useChats((s) => (chatId ? s.threads[chatId] : undefined)) ?? emptyThread()
  const chat = useChats((s) => (chatId ? s.chats.find((c) => c.id === chatId) : undefined))
  const messages = thread.messages
  const running = runningMessage(messages)
  const busy = !!running || messages.some((m) => m.local?.state === 'sending')
  // messages typed while an answer ran (the full chat's queue, store/sendQueue.ts): they wait under the conversation
  const waiting = useSendQueue((s) => (chatId ? s.queues[chatId] : undefined))
  const queueing = !!chatId && !question && (busy || !!waiting?.items.length)
  const announce = useAnnounce()
  const shareable = !chat?.confidential && !me.server.allChatsConfidential
  // the thread open beside this chat, while its chip is on: the next question is about it (not for a guest whose AI
  // cannot read the room or cannot answer yet)
  const looking = beside && chipOff !== beside.rootId && !roomUnread && !guestNoAi && !guestWaits ? beside : null
  // the chip shows unless a quoted message stands in its place (the quote names its own thread) or the box answers
  // the AI's question
  const chipOn = !!looking && !quoted && !question
  // where each answer goes with one click: the thread its question (or the one it follows up) asked about, or the room
  const targets = useMemo(() => sendTargets(messages), [messages])
  // an answer above the first question that quotes something depends on older messages than the page read (a long chat
  // after a reload): those pages too, so it goes where it did before
  const firstQuote = messages.findIndex((m) => m.role === 'user' && quotes(m.content))
  const needOlder = !!chatId && !!thread.nextCursor && messages.slice(0, firstQuote < 0 ? undefined : firstQuote).some((m) => m.role === 'assistant')
  const olderRead = useRef<{ chatId: string | null | undefined; pages: number }>({ chatId, pages: 0 })
  useEffect(() => {
    if (olderRead.current.chatId !== chatId) olderRead.current = { chatId, pages: 0 }
    if (!needOlder || !chatId || olderRead.current.pages >= OLDER_PAGES_MAX) return
    olderRead.current.pages++
    void useChats.getState().loadOlder(chatId).catch(() => {})
  }, [needOlder, chatId, thread.nextCursor])
  // new answers, pictures loading and a phone's keyboard: at the bottom it stays there (lib/stickToBottom.ts)
  const list = useStickToBottom()
  const { scroller, content, stick } = list
  const box = useRef<HTMLTextAreaElement>(null)
  /** a seed's question waiting to be sent (SideSeed.ask) */
  const autoAsk = useRef<{ key: string; ask: string } | null>(null)
  // the box's files (the full chat box's own parts), kept per room like the draft, in every panel of the room
  const [fileError, setFileError] = useState<string | null>(null)
  const files = useComposerFiles({
    userId: me.user.id,
    draftId: filesDraft(roomId),
    ensureChat: async () => {
      const id = await chatToWrite(roomId)
      filesOf.set(roomId, id)
      return id
    },
    onError: setFileError,
    reload: false,
  })
  // files dropped anywhere on the panel (FileDropZone), with the box's own check: no room left for one more refuses the drop
  const dropTarget: DropTarget = { files: (all, folders) => void files.addFiles(all, folders), refusal: () => (files.live.length >= MESSAGE_ATTACHMENTS_MAX ? t('composer.tooMany', { n: MESSAGE_ATTACHMENTS_MAX }) : null) }
  // they were uploaded into one chat: once another shows (New chat, 🕘, the chat deleted meanwhile, the room left and
  // joined again), they go, in every panel of the room
  const clearFiles = useRef(files.clear)
  clearFiles.current = files.clear
  useEffect(() => {
    const owner = filesOf.get(roomId)
    if (!owner || chatId === undefined || chatId === owner) return
    filesOf.delete(roomId)
    clearFiles.current()
    setFileError(null)
  }, [roomId, chatId])

  // a failed read's error stays until a read works: the notice stays while it reads again (components/LoadError.tsx)
  /** the chat this page showed for the room, found gone (deleted in the full chat): what `load` may replace */
  const gone = useRef<string | null>(null)
  const load = useCallback(async () => {
    try {
      const found = await findSideChat(roomId)
      // only in place of no chat yet or the one found gone: a chat the person opened or started meanwhile (here or in
      // another panel of the room) stays on screen
      const now = sideChatOf(useSideChats.getState(), roomId).chatId
      if (now === undefined || now === gone.current) patch({ chatId: found })
      setLoadError(null)
    } catch (e) {
      setLoadError(e ?? new Error('failed'))
    }
  }, [roomId, patch])
  // the chat this page shows for the room already (another panel of it, or the last one kept by sideChatOpening): read
  // again; gone meanwhile (deleted in the full chat), or none known yet (after a reload): findSideChat
  useEffect(() => {
    const known = sideChatOf(useSideChats.getState(), roomId).chatId
    if (known === undefined) return void load()
    if (known) void useChats.getState().loadThread(known).catch(() => {
      if (sideChatOf(useSideChats.getState(), roomId).chatId !== known) return
      gone.current = known
      void load()
    })
  }, [roomId, load])
  useEffect(() => { if (autoFocus) box.current?.focus() }, [])
  // messages this browser kept waiting in the chat shown (the panel closed and opened again, a reload): back under it
  const threadRead = messages.length > 0 || !!thread.nextCursor
  useEffect(() => {
    if (chatId && threadRead) useSendQueue.getState().restore(me.user.id, chatId)
  }, [chatId, threadRead, me.user.id])
  // a message asked about: quoted in front of the next question, until it is sent or taken off (once per ask: a panel
  // drawn again, or a second panel of the room, does not quote it again)
  useEffect(() => {
    const taken = sideChatOf(useSideChats.getState(), roomId).seedKeys
    if (!seed || taken.includes(seed.key)) return
    patch({ quoted: seed, seedKeys: [...taken, seed.key].slice(-SEED_KEYS_MAX) })
    setHistory(null)
    if (seed.ask) autoAsk.current = { key: seed.key, ask: seed.ask }
    box.current?.focus()
  }, [seed?.key])

  const last = messages.at(-1)
  useLayoutEffect(() => {
    list.follow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, last?.content.length, messages.length])
  const onScroll = () => {
    list.onScroll()
  }

  const fail = (e: unknown) => toast({ level: 'warn', text: errorText(e, locale, t('error.network')) })
  // the AI limit used up is a known state: the calm notice under the box (as under the full chat's box, chat/Composer.tsx)
  // and the text kept, never a warning toast (owner rule; QA TC-2895)
  const [limit, setLimit] = useState<string | null>(null)
  // voice input, as in every message box: under the team's switch (no mic while it is off), for the side chat shown (a
  // confidential chat's recording never goes to an outside speech service: the note instead)
  const mic = micState(me)
  const confidential = useConfidentialChat(chatId ?? null)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const boxRoot = useRef<HTMLDivElement>(null)
  const voice = useVoiceInput({
    input: box,
    root: boxRoot,
    text: draft,
    replace: (next) => setDraft(next),
    // (read from the store: a live recording's next words may come before the panel renders again)
    append: (said) => setDraft((cur) => (cur.trim() ? `${cur.trimEnd()} ${said}` : said)),
    chatId: chatId ?? null,
    blocked: voiceBlockedHere(me, confidential),
    enabled: mic === 'on' && !guestNoAi,
    menuOpen: false,
    onError: setVoiceError,
  })
  // back after a recording: the newest words in sight, as they were while recording
  useEndAfterRecording(box, voice.recording, voice.busy, draft)
  // the box's draft kept on this device across reloads (lib/localData, `side:<room id>`), with the chat it was written
  // in: it comes back only into that chat (or a new chat's into a new chat) once the panel knows which chat it shows, so
  // which chat opens after a reload (sideChatOpening) is as before
  const keptKey = `side:${roomId}`
  const keptRead = useRef<string | null>(null)
  useEffect(() => {
    if (chatId === undefined || keptRead.current === `${keptKey}|${chatId}`) return
    keptRead.current = `${keptKey}|${chatId}`
    const kept = parseKept(readDraft(me.user.id, keptKey))
    if (kept && kept.chatId === chatId && !sideChatOf(useSideChats.getState(), roomId).draft) setDraft(kept.text)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, keptKey])
  useEffect(() => {
    if (chatId === undefined || keptRead.current !== `${keptKey}|${chatId}`) return
    writeDraft(me.user.id, keptKey, draft.trim() ? JSON.stringify({ chatId, text: draft }) : '')
  }, [draft, chatId, keptKey, me.user.id])
  // a send that did not go for the connection: the calm line under the box, the text kept in it (as the full chat's)
  const [unsent, setUnsent] = useState<Unsent>(false)
  const [sendError, setSendError] = useState<string | null>(null)
  useEffect(() => { if (!draft.trim()) setUnsent(false) }, [draft])
  // the room's apps (docs/DECISIONS.md "Apps posting in rooms"): one chip chosen by the apps that posted here, from the
  // messages on screen (a member cannot list the apps)
  const chip = useRooms((s) => (s.timeline?.roomId === roomId ? appChip(s.timeline.messages) : null))
  // what the box sends: its text and its files (all uploaded); an answer to the AI's question is the text alone
  // (while an answer runs the box's message waits for it: queueing)
  // a free-roam demo whose AI is used up (store/demo.ts): ✦ stops like every AI message box; the room's own box goes on
  const demoOut = useDemoOut()
  const canSend = !demoOut && chatId !== undefined && !voice.busy && (question ? !!draft.trim() : (!busy || queueing) && !files.uploading && (!!draft.trim() || files.ready.length > 0))
  const sendLabel = question ? t('sideChat.answer') : busy && queueing ? t('outbox.sendLater') : t('sideChat.send')
  // what is typed here goes to the AI: as under the full chat's box, a key-looking text is held for "Send anyway" (every
  // send from the box; an answer to the AI's question also has the "no passwords" line)
  const secret = useSecretHold(draft)
  const noSecretsId = useId()
  const send = async (asked?: string, anyway = false) => {
    const text = (asked ?? draft).trim()
    // the box's files go with what is typed in it; a starter or quick question goes alone (and leaves them, as it leaves
    // the text)
    const atts = asked === undefined && !question ? files.attachments() : []
    if ((!text && !atts.length) || chatId === undefined) return
    // the box's text while it is recorded into or the words are on their way: not sent (a starter or quick ask goes)
    if (asked === undefined && voice.busy) return
    // the box's own text that looks like a key waits for "Send anyway" (a starter or quick question is ours)
    if (asked === undefined && !secret.pass(anyway)) return
    setUnsent(false)
    setSendError(null)
    // the AI waits for the answer to its question: the text answers it (never a new message while its answer runs)
    if (question && chatId) {
      setLimit(null)
      // longer than an answer can be: said before sending, the text kept (the full chat's box does the same)
      const max = answerTooLong(question.request, text)
      if (max) return setSendError(t('composer.answerTooLong', { n: max.toLocaleString(locale) }))
      stick.current = true
      setDraft('')
      try {
        await useChats.getState().answer(question.request.requestId, { kind: 'ask_user', answer: composerAnswer(question.request, picksOf(question.request.requestId), text) })
      } catch (e) {
        setDraft((d) => d || text)
        failed(e)
      }
      return
    }
    // longer than a message holds (a long paste went in as a file): said, the text kept
    if (textOverLimit(text)) return setSendError(t('composer.textTooLong', { max: MESSAGE_TEXT_MAX.toLocaleString(locale) }))
    if (asked === undefined && queueing && chatId) return void queue(text, atts)
    if (busy || (asked === undefined && files.uploading)) return
    stick.current = true
    setLimit(null)
    const q = quoted
    if (asked === undefined) setDraft('')
    setQuoted(null)
    try {
      const time = (iso: string) => formatDateTime(iso, locale)
      const content = q ? withQuote(q, text, time) : looking ? withThread(looking, text, time) : text
      // the room's first question makes its side chat the way a first file does (one path: never two chats)
      const into = chatId ?? (await chatToWrite(roomId))
      const r = await useChats.getState().send({ chatId: into, content, attachments: atts, author: { id: me.user.id, name: me.user.name }, sideRoomId: roomId })
      if (r.chatId !== chatId) setChatId(r.chatId)
      // the files are in the message now (a send that fails keeps them there, with "send again")
      if (atts.length) {
        files.clearSent()
        setFileError(null)
      }
      await r.sent
    } catch (e) {
      if (asked === undefined) setDraft((d) => d || text)
      setQuoted((x) => x ?? q)
      failed(e, asked === undefined)
    }
  }
  /** a send of the box that failed: the limit's calm notice, the connection's calm line with the text kept (it goes
   * again by itself after an update), else the reason under the box, as under the full chat's box */
  const failed = (e: unknown, box = true) => {
    if (isApiError(e, 'budget_exceeded')) setLimit(errorText(e, locale, t('error.network')))
    else if (box && isConnectionError(e)) setUnsent(waitsForUpdate(e) ? 'updating' : 'connection')
    else setSendError(errorText(e, locale, t('error.network')))
  }
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(() => {
    if (unsent !== 'updating') return
    let live = true
    void waitForUpdate().then(() => { if (live) void sendRef.current() })
    return () => { live = false }
  }, [unsent])
  /** The box's message while an answer runs (or earlier ones wait): it waits under the conversation and goes when the
   * answer is done, with what the box showed on top of it now (the quoted message, else the thread's chip), its files
   * too; earlier ones paused by a stopped or failed answer go now, together with it (as in the full chat, pages/Chat.tsx). */
  const queue = (text: string, atts: ReturnType<typeof files.attachments>) => {
    if (!chatId || files.uploading) return
    const time = (iso: string) => formatDateTime(iso, locale)
    const lead = quoted ? quoteLead(quoted, time) : looking ? threadLead(looking, time) : undefined
    const m = { content: text, attachments: atts, author: { id: me.user.id, name: me.user.name }, ...(lead ? { lead } : {}) }
    const sq = useSendQueue.getState()
    stick.current = true
    setLimit(null)
    try {
      if (!busy && waiting?.paused) sq.sendNow(chatId, m)
      else sq.enqueue(me.user.id, chatId, m)
    } catch (e) {
      return failed(e instanceof QueueFull ? new Error(t('outbox.full')) : e, false)
    }
    setDraft('')
    setQuoted(null)
    if (atts.length) {
      files.clearSent()
      setFileError(null)
    }
    if (busy) announce(t('outbox.waitingOne'))
  }
  const newChat = () => {
    if (busy) return
    // a recording was for the chat shown: it goes with it (its words are not put back into the new chat's box)
    voice.abandon()
    setHistory(null)
    setChatId(null)
    setDraft('')
    setLimit(null)
    setUnsent(false)
    setSendError(null)
    box.current?.focus()
  }
  // a seed with its question (an app's thread: "Summarise this thread"): sent once the message is quoted and the chat
  // can take it
  useEffect(() => {
    const a = autoAsk.current
    if (!a || quoted?.key !== a.key || chatId === undefined || busy) return
    autoAsk.current = null
    void send(a.ask)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoted?.key, chatId, busy])
  const toggleHistory = async () => {
    if (history) return setHistory(null)
    setHistoryBusy(true)
    try {
      const r = await api.call(API.listChats, { query: { sideRoomId: roomId, limit: SIDE_HISTORY_MAX } })
      setHistory(r.items)
    } catch (e) {
      fail(e)
    } finally {
      setHistoryBusy(false)
    }
  }
  const openPast = async (id: string) => {
    setHistory(null)
    setLimit(null)
    if (id === chatId) return
    // a recording names the chat shown: it does not go on into another one
    voice.abandon()
    stick.current = true
    try {
      await useChats.getState().loadThread(id)
      setChatId(id)
    } catch (e) {
      fail(e)
    }
  }
  const onRegenerate = (m: ViewMessage) => {
    if (!chatId) return
    stick.current = true
    void useChats.getState().regenerate(chatId, m.id).catch(fail)
  }
  const onEdit = (m: ViewMessage, text: string) => {
    if (!chatId) return
    stick.current = true
    void useChats.getState().edit(chatId, m.id, text, m.attachments).catch(fail)
  }
  const onSelectBranch = (id: string) => { if (chatId) void useChats.getState().selectBranch(chatId, id).catch(fail) }
  // 보기 under a sent answer: the thread at the reply (it takes this column, or the whole screen on a phone; ✦ brings this
  // chat back), or the room at the message (a phone: this panel closes so the room shows). From the file viewer's column
  // the viewer closes first. A hand-off, not a close: the side chat stays open, also when the viewer closes on it.
  const view = (s: SentHere) => {
    // on the room page: the page opens the thread beside this chat, or in its place where the two do not fit
    if (s.to === 'thread' && s.rootId && onViewThread && !getImageViewer()) return onViewThread(s.rootId, s.messageId)
    if (getImageViewer()) handedOff.viewer.add(roomId)
    if (s.to === 'thread' && s.rootId) handedOff.thread.add(roomId)
    closeImageViewer(() => {
      if (s.to === 'thread' && s.rootId) return navigate(`/rooms/${s.roomId}/t/${s.rootId}?m=${s.messageId}`, { state: { fromRoom: true } })
      if (!window.matchMedia?.('(min-width: 48rem)').matches) useRooms.getState().setSide(s.roomId, null)
      navigate(`/rooms/${s.roomId}?m=${s.messageId}`, { replace: window.location.pathname === `/rooms/${s.roomId}` })
    })
  }
  const name = aiName(t)
  // what the box asks: the answer to the AI's question, or about the file or message quoted, or about the room
  const boxLabel = question ? t('sideChat.answerPlaceholder', { name }) : quoted?.file ? t('sideChat.placeholderQuotedFile', { name }) : quoted ? t('sideChat.placeholderQuoted', { name }) : chipOn ? t('sideChat.placeholderThread', { name }) : t('sideChat.placeholder', { name })

  // a message or file asked about, above the box, with its quick questions
  const quotedCard = (
    <>
        {quoted && (
          <div className="mb-2 rounded-lg border border-line bg-canvas p-2" data-testid="side-chat-quote">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 border-l-2 border-line-strong pl-2 text-xs">
                {!quoted.file && <p className="font-medium text-ink">{quoted.author} <span className="font-normal text-faint">{formatDateTime(quoted.at, locale)}</span></p>}
                {quoted.file ? (
                  <p className="flex min-w-0 items-center gap-1 text-muted" data-testid="side-chat-quote-file"><Paperclip size={12} aria-hidden className="shrink-0" /><span className="truncate">{quoted.file.name}</span></p>
                ) : (
                  // the room message's words as the room shows them: a link is its label, never its address (lib/rooms.ts plainLine)
                  <p className="line-clamp-3 break-words text-muted" data-testid="side-chat-quote-text">{plainLine(quoted.text)}</p>
                )}
              </div>
              <IconButton label={t('sideChat.quoteRemove')} onClick={() => setQuoted(null)} className="touch-hit -mt-0.5 shrink-0" data-testid="side-chat-quote-remove">
                <X size={13} aria-hidden />
              </IconButton>
            </div>
            {!question && !guestWaits && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {quoted.app && quoted.thread && (
                  <button type="button" disabled={busy || chatId === undefined} onClick={() => void send(t('roomApps.askThread'))}
                    className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-40" data-testid="side-chat-quick-app-thread">
                    {t('roomApps.chipThread')}
                  </button>
                )}
                {(quoted.file ? (roomUnread ? [] : guest ? QUICK_FILE.filter((k) => k !== 'fileSave') : QUICK_FILE) : QUICK_MESSAGE).map((k) => (
                  <button key={k} type="button" disabled={busy || chatId === undefined} onClick={() => void send(SIDE_CHAT_QUICK[k].ask[locale])}
                    className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-40" data-testid={`side-chat-quick-${k}`}>
                    {SIDE_CHAT_QUICK[k].label[locale]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
    </>
  )
  const hint = composerHint(t, { transcribing: voice.transcribing ? voice.transcribingText : null, waiting: busy && queueing, own: boxLabel })

  const body = (
    // files dropped anywhere on the panel go with the next question (the overlay over the panel shows the drop)
    // tinted (--c-aside, a light wash of the brand's soft accent) and marked with ✦ and "Only you" in its header, so my
    // private side chat never reads as the room's thread, which opens in the same place on the plain surface (the owner,
    // 2026-11-20; QA TC-5675)
    <FileDropZone className="flex min-h-0 flex-1 flex-col bg-aside [--sticky-bg:var(--c-aside)] [--typing-bg:var(--c-aside)]" target={dropTarget} data-testid="side-chat-panel">
      <div className={clsx('flex h-12 shrink-0 items-center gap-1 border-b border-line', closeX ? 'pr-2 pl-4 md:px-4' : 'px-2 max-md:pl-0.5 md:px-4')}>
        {!closeX && (
          <IconButton tip label={t('sideChat.close')} onClick={onClose} className="touch-hit p-3 md:hidden" data-testid="side-chat-back">
            <ChevronLeft size={20} aria-hidden />
          </IconButton>
        )}
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="flex shrink-0 self-center" data-testid="side-chat-mark"><AiMark place="nav" /></span>
          <span className="shrink-0 text-title-sm font-semibold text-ink">{t('sideChat.title', { name })}</span>
          <span className="truncate text-xs text-faint" data-testid="side-chat-room">{roomTitle}</span>
          <span className="flex shrink-0 gap-2 text-xs text-faint" data-testid="side-chat-only-you"><span aria-hidden>·</span>{t('sideChat.onlyYou')}</span>
        </h2>
        {/* a phone's room shows this panel full screen already: no "open full screen" there (the chat is in the history
            too); the file viewer's sheet keeps it */}
        {chatId && (
          <IconButton tip label={t('sideChat.openFull')} onClick={() => navigate(`/c/${chatId}`)} className={clsx('touch-hit', !closeX && 'max-md:hidden')} data-testid="side-chat-open-full">
            <ExternalLink size={15} aria-hidden />
          </IconButton>
        )}
        <IconButton tip label={t('sideChat.history')} onClick={() => void toggleHistory()} disabled={historyBusy} aria-expanded={!!history} className={clsx('touch-hit', history && 'bg-hover')} data-testid="side-chat-history">
          <History size={15} aria-hidden />
        </IconButton>
        {/* (a chat with nothing in it yet, made for a file, is a new chat already) */}
        <IconButton tip label={t('sideChat.new')} onClick={newChat} disabled={busy || !chatId || !messages.length} className="touch-hit" data-testid="side-chat-new">
          <SquarePen size={15} aria-hidden />
        </IconButton>
        <IconButton tip label={t('sideChat.close')} onClick={onClose} className={clsx('touch-hit', !closeX && 'max-md:hidden')} data-testid="side-chat-close">
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <div ref={scroller} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="side-chat-scroller">
        <div ref={content} className="space-y-5 px-4 pt-3 pb-4">
          {history && (
            <nav aria-label={t('sideChat.history')} className="-mx-2" data-testid="side-chat-history-list">
              <p className="px-2 pb-1 text-xs text-faint">{t('sideChat.historyTitle', { room: roomTitle })}</p>
              {!history.length && <p className="px-2 py-3 text-sm text-muted" data-testid="side-chat-history-empty">{t('sideChat.historyEmpty')}</p>}
              <ul>
                {history.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => void openPast(c.id)} aria-current={c.id === chatId ? 'true' : undefined}
                      className={clsx('flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover', c.id === chatId ? 'font-medium text-ink' : 'text-muted')} data-testid="side-chat-history-item">
                      <span className="min-w-0 flex-1 truncate">{c.title || t('chat.untitled')}</span>
                      <span className="shrink-0 text-xs text-faint">{formatDate(c.updatedAt, locale)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {!history && chatId === undefined && !loadError && <Loader2 size={16} className="mx-auto my-6 animate-spin text-faint" aria-label={t('common.loading')} />}
          {!history && !!loadError && <LoadError error={loadError} onRetry={load} what="side-chat" />}
          {!history && chatId !== undefined && !messages.length && (
            <div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="side-chat-empty">
              <AiFace size={40} />
              {/* what Trina reads here: this room, as I see it (Slackbot's "함께 확인하는 중") */}
              {/* (a guest whose AI cannot answer yet is not told the AI is looking at the room) */}
              {roomUnread ? (!guestNoAi && !guestWaits && <p className="max-w-[280px] text-sm text-muted">{t('sideChat.emptyGuest', { name })}</p>) : !guestNoAi && !guestWaits && (<>
                {/* (with the box's thread chip on, the chip says what is looked at) */}
                {!chipOn && (
                  <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-xs text-muted" data-testid="side-chat-context">
                    <Eye size={12} aria-hidden className="shrink-0" /><span className="truncate">{t('sideChat.context', { room: roomTitle })}</span>
                  </span>
                )}
                {!chipOn && projectHint ? (
                  <ProjectSideHint project={projectHint} />
                ) : (
                  <p className="max-w-[280px] text-sm text-muted" data-testid="side-chat-intro">{t(chipOn ? 'sideChat.emptyThread' : 'sideChat.empty', { name })}</p>
                )}
              </>)}
              {/* (no starters while no AI answers a guest: they would only fail; components/GuestView.tsx) */}
              {!quoted && !guestNoAi && !guestWaits && !roomUnread && (
                <div className="flex flex-wrap justify-center gap-1.5" data-testid="side-chat-starters">
                  {/* the thread's chip is on: one starter, about the thread (the words an app's thread uses) */}
                  {chipOn && (
                    <button type="button" disabled={busy || chatId === undefined} onClick={() => void send(t('roomApps.askThread'))}
                      className="rounded-full border border-line px-3 py-1 text-xs text-ink hover:bg-hover disabled:opacity-40 max-md:min-h-11" data-testid="side-chat-starter-thread">
                      {t('roomApps.chipThread')}
                    </button>
                  )}
                  {!chipOn && chip && (
                    <button type="button" disabled={busy || chatId === undefined} onClick={() => void send(t(chip === 'forms' ? 'roomApps.askForms' : 'roomApps.askToday'))}
                      className="rounded-full border border-line px-3 py-1 text-xs text-ink hover:bg-hover disabled:opacity-40 max-md:min-h-11" data-testid="side-chat-app-chip">
                      {t(chip === 'forms' ? 'roomApps.chipForms' : 'roomApps.chipToday')}
                    </button>
                  )}
                  {!chipOn && STARTERS.map((k) => (
                    <button key={k} type="button" disabled={busy || chatId === undefined} onClick={() => void send(t(`sideChat.starter.${k}`))}
                      className="rounded-full border border-line px-3 py-1 text-xs text-ink hover:bg-hover disabled:opacity-40 max-md:min-h-11" data-testid={`side-chat-starter-${k}`}>
                      {t(`sideChat.starterLabel.${k}`)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* its pictures are one pane of the image viewer (← →), each with who sent it and when, like the AI chat's */}
          {/* the box below answers the AI's open question: its card leaves typing to the box */}
          <BoxAnswers.Provider value={question?.request.requestId ?? null}>
          <ImageGroup>
            {!history && chatId && messages.map((m, i) =>
              m.role === 'user' ? (
                <ViewerMeta key={m.id} sender={{ kind: 'user', user: m.author ?? me.user }} at={m.createdAt}>
                  <UserMessage m={m} chatId={chatId} busy={busy} onEdit={onEdit} onSelectBranch={onSelectBranch} sideChat pressMenu />
                </ViewerMeta>
              ) : (
                <ViewerMeta key={m.id} sender={{ kind: 'ai' }} at={m.createdAt}>
                  <AssistantMessage m={m} chatId={chatId} isLast={i === messages.length - 1} busy={busy} switchedFrom={null as EngineId | null} onRegenerate={onRegenerate} onSelectBranch={onSelectBranch} onAskOwnFolder={() => {}} shareable={shareable} sendHere={{ roomId, target: targets.get(m.id) ?? null, onView: view }} canSuggest={false} pressMenu />
                </ViewerMeta>
              ),
            )}
          </ImageGroup>
          </BoxAnswers.Provider>
          {!history && chatId && <div className="pt-3"><QueuedMessages chatId={chatId} onFocusComposer={() => box.current?.focus()} /></div>}
        </div>
      </div>
      <div className="shrink-0 px-4 pb-[var(--box-bottom)]">
        {/* a guest whose AI is off: one line in place of the box (components/GuestView.tsx) */}
        {guestNoAi ? <GuestNoAi /> : (<>
        <ComposerShell
          rootRef={boxRoot}
          testId="side-chat-box"
          toolsTestId="side-chat-tools"
          // "no usable AI" with its button, for everyone it concerns (it shows nothing while the AI answers)
          aiBand
          above={quotedCard}
          secret={{
            held: secret.held,
            onSendAnyway: () => void send(undefined, true),
            onEdit: () => {
              secret.release()
              box.current?.focus()
            },
          }}
          files={files.files.length > 0}
          text={draft}
          hint={hint}
          heldTestId="side-chat-text-held"
          voice={voice}
          mic={mic}
          top={<>
            {question && (
              <p id={noSecretsId} className="px-4.5 pt-2.5 text-xs text-faint" data-testid="side-chat-no-secrets">
                {t('ask.noSecrets')}
              </p>
            )}
            {/* the thread open beside this chat: the next question is about it, until ✕ */}
            {chipOn && !voice.recording && (
              <div className="flex px-3 pt-2.5">
                <span className="inline-flex max-w-full items-center gap-1.5 rounded-xl border border-line bg-subtle py-0.5 pr-0.5 pl-2.5 text-xs text-muted" data-testid="side-chat-thread-chip">
                  <Eye size={12} aria-hidden className="shrink-0" />
                  <span className="truncate">{t('sideChat.threadChip')}</span>
                  <IconButton compact label={t('sideChat.threadChipOff')} onClick={() => { patch({ chipOff: looking!.rootId }); box.current?.focus() }} data-testid="side-chat-thread-chip-off">
                    <X size={13} aria-hidden />
                  </IconButton>
                </span>
              </div>
            )}
            <ComposerFileList files={files.files} onRemove={files.removeFile} className="px-3 pt-2.5" />
          </>}
          field={
            <ComposerField
              ref={box}
              value={draft}
              onText={(v) => { setDraft(v); setLimit(null) }}
              voice={voice}
              onSend={() => void send()}
              onPaste={files.onPaste}
              placeholder={hint}
              // not disabled: the focus stays in the box while the words are on their way
              readOnly={voice.busy || demoOut}
              aria-disabled={demoOut || undefined}
              aria-busy={voice.transcribing || undefined}
              aria-label={boxLabel}
              aria-describedby={question ? noSecretsId : undefined}
              className={demoOut ? 'cursor-not-allowed text-muted' : undefined}
              data-testid="side-chat-input"
            />
          }
          start={
            <AttachMenu
              key={filesDraft(roomId)}
              onFiles={(all) => void files.addFiles(all)}
              onTeamFiles={(picked) => void files.addTeamFiles(picked.map((f) => ({ path: f.path, name: f.name, size: f.size })))}
              teamAttached={new Set(files.live.filter((f) => f.source === 'team').map((f) => f.attachment?.path ?? f.path!))}
              room={MESSAGE_ATTACHMENTS_MAX - files.live.length}
              max={MESSAGE_ATTACHMENTS_MAX}
              testId="side-chat-attach"
              filesTestId="side-chat-file-input"
              onPicked={() => box.current?.focus()}
            />
          }
          send={{ kind: question ? 'answer' : busy && queueing ? 'later' : 'send', can: canSend, onSend: () => void send(), label: sendLabel, testId: 'side-chat-send' }}
          // while my answer is on its way (running, queued or still sending), as in the full chat's box
          stop={busy && chatId ? { onStop: () => useChats.getState().stop(chatId), onError: fail, testId: 'side-chat-stop' } : null}
          footer={t('chat.footerAi')}
          footerTestId="side-chat-disclaimer"
          below={fileError && <p role="alert" className="pt-1.5 text-xs text-danger" data-testid="side-chat-file-error">{fileError}</p>}
          notices={{ prefix: 'side-chat', demoOut, limit: demoOut ? null : limit, error: sendError, unsent, onRetry: () => void send(), canRetry: canSend, voiceError }}
        />
        </>)}
      </div>
    </FileDropZone>
  )
  if (!frame) return body
  return (
    <RoomSideColumn label={t('sideChat.title', { name })} testId="room-side-chat" divider="side-chat">
      {body}
    </RoomSideColumn>
  )
}

/** The empty ✦ side chat of a project's chat room: "Only you see this. To ask where {project}'s people see it, ask on the
 * project page.", the project page a link to it (/projects/<id>). */
export function ProjectSideHint({ project }: { project: { id: string; name: string } }) {
  const t = useT()
  const page = t('sideChat.projectPage')
  const text = t('sideChat.emptyProject', { project: project.name, page })
  const at = text.lastIndexOf(page)
  const link = <Link to={`/projects/${project.id}`} className="font-medium text-ink underline underline-offset-2" data-testid="side-chat-project-link">{page}</Link>
  return (
    <p className="max-w-[280px] text-sm break-keep text-muted" data-testid="side-chat-intro" data-project="">
      {at < 0 ? text : <>{text.slice(0, at)}{link}{text.slice(at + page.length)}</>}
    </p>
  )
}
