// The team chat rooms ("대화방" v1, shared/src/api/rooms.ts): the rooms I am in with their unread badges, the timeline
// of the one room on screen (pages/Room.tsx) and the threads on screen (components/rooms/ThreadPanel.tsx; docs/
// DECISIONS.md "스레드와 반응"): the one beside the room or over it, and the one beside a file in the viewer
// (components/rooms/ViewerColumn.tsx), each kept while a panel shows it (threadViews, by root, with a count). Only
// those are kept: leaving drops them and opening reads the newest page. What the room page shows on its right (a
// thread is in the address; side: the Trina side chat) is here too, so the file viewer can start the same way. A reply in a thread goes to the thread, and to the timeline only when it was sent to the room too. The
// WebSocket's room.* events come in through store/live.ts dispatch → handleEvent; the pure with* functions below make
// the state changes (test/unit/rooms-store.test.ts), handleEvent adds the requests they need. A reconnect the server
// could not resume reloads through resync (components/rooms/useRoomsSync).
import { create } from 'zustand'
import { emojiForm } from '@mycel/shared'
import { ROOM_REACTION_EMOJI_MAX, uuidv7, type Room, type RoomAlertSettings, type ShareAnswerToRoomResult, type RoomNotifyLevel, type RoomAiRun, type RoomFile, type RoomLastMessage, type RoomMember, type RoomMessage, type RoomQuote, type RoomReaction, type RoomThreadSummary, type ServerEvent } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError } from '../lib/api'
import { noteRecent } from '../lib/emoji'
import { mentionsMe, withRun, withRunPosition, withRunStep, type PickedMention } from '../lib/rooms'
import { navigateTo } from '../lib/nav'
import { currentLocale, t } from '../i18n'
import { mergeOpenRequests, useChats } from './chats'
import { useSession } from './session'
import { useSideChats } from './sideChats'
import { toast } from './ui'

export type RoomEvent = Extract<ServerEvent, { type: 'room.message' | 'room.message.updated' | 'room.read' | 'room.thread' | 'room.reactions' | 'room.updated' | 'room.ai' | 'room.ai.run' | 'room.ai.step' | 'queue.position' }>

/** The AI in a room (docs/DECISIONS.md "대화방의 트리나"): how many questions it answers there now (anyone's), and my own
 * questions: working ones with their steps, and ones that stopped or failed until I close them. A finished answer is a
 * room message, so its run goes. Someone else's question whose answer stayed theirs only says so itself
 * (RoomMessage.answeredPrivately). */
export interface RoomAi { answering: number; runs: RoomAiRun[] }
const NO_AI: RoomAi = { answering: 0, runs: [] }

export const ROOM_PAGE = 50

/** The timeline of the room on screen: its messages and the replies sent to the room too, oldest first. */
export interface RoomTimeline {
  roomId: string
  messages: RoomMessage[]
  /** older messages (null: this is the start of what I can see) */
  nextCursor: string | null
  /** newer messages not loaded yet: the timeline is a window around a message a link or a search result opened
   * (loadAround), not at the newest. New messages are not added to it until it reaches the newest (loadNewer) or goes
   * back there (loadNewest). Absent or null: it ends at the newest. */
  newerCursor?: string | null
  loading: boolean
  error: unknown
}

/** A thread on screen: its root and the replies I can see, oldest first. */
export interface ThreadView {
  roomId: string
  rootId: string
  root: RoomMessage | null
  replies: RoomMessage[]
  nextCursor: string | null
  loading: boolean
  error: unknown
  /** how many panels show it (the room page's, the file viewer's): it goes when the last one closes */
  holders: number
}

/** A message on its way (or that could not be sent): shown at the end of the room (or its thread) until the server has
 * it. */
export interface PendingSend {
  clientMessageId: string
  body: string
  mentions: string[]
  /** "@전체" picked in the box */
  mentionsAll?: boolean
  files: RoomFile[]
  /** a reply in this thread (null: a message of the timeline) */
  threadRootId: string | null
  /** a reply also sent to the room */
  alsoInRoom: boolean
  state: 'sending' | 'failed'
  error?: string
  createdAt: string
}

export interface RoomsData {
  rooms: Room[]
  /** the room on screen */
  openRoomId: string | null
  timeline: RoomTimeline | null
  /** the threads on screen, by placeKey(roomId, rootId) */
  threadViews: Record<string, ThreadView>
}

/** Where a send belongs (its draft, a refused send coming back): the room's timeline, or one thread of it. */
export const placeKey = (roomId: string, threadRootId?: string | null) => (threadRootId ? `${roomId}/${threadRootId}` : roomId)

const time = (iso: string) => Date.parse(iso) || 0

/** Most recent activity first, as GET /api/rooms lists them. */
export const sortRooms = (rooms: Room[]) => [...rooms].sort((a, b) => time(b.activityAt) - time(a.activityAt))

/** One copy per message id (the newest wins), in room order. */
export function mergeMessages(list: RoomMessage[], incoming: RoomMessage[]): RoomMessage[] {
  const byId = new Map(list.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

/** Is this message in the room's timeline (not a reply that stays in its thread)? */
export const inTimeline = (m: Pick<RoomMessage, 'threadRootId' | 'alsoInRoom'>) => !m.threadRootId || !!m.alsoInRoom

export function lastLineOf(m: RoomMessage): RoomLastMessage {
  return { id: m.id, seq: m.seq, author: m.author, excerpt: m.deletedAt ? '' : m.body.slice(0, 120), fileCount: m.files.length, deleted: !!m.deletedAt, createdAt: m.createdAt }
}

export function quoteOf(m: RoomMessage): RoomQuote {
  return { id: m.id, author: m.author, excerpt: m.deletedAt ? '' : m.body.slice(0, 200), fileCount: m.files.length, deleted: !!m.deletedAt }
}

/**
 * A new message: once (by id) in the open room's timeline; its room moves to the top with it as the last line. A
 * message after the room's last position and my read position that is not mine and arrives while the room is not on
 * screen counts as unread (and "mentions me" when it does); a message seen before (a replay, my own send's answer)
 * counts nothing again. Who may see a message is the server's to say, not repeated here: it sends one only to them
 * (server/src/rooms/store.ts canSee), so what arrives counts as its unreadCount counts it, @트리나's private answer to
 * my question included. My private answer shared to the room from another window read the room up to it there first
 * (room.read comes before the message), so it counts nothing. My own message moves my read position to it (the
 * server does the same), so the room has nothing unread for me then.
 * An event line (a rename, people invited, someone left) only takes its place: no unread, no last line, no move.
 * A reply goes to its thread when that is open; it is in the timeline (and counts there) only when sent to the room too.
 * A followed thread's badge comes from the server (room.updated with my room).
 */
export function withMessage(d: RoomsData, roomId: string, m: RoomMessage, meId: string | null): RoomsData {
  // the threads on screen it belongs to: as their root, or as a reply
  const threadViews = mapViews(d.threadViews, (tv) => (tv.roomId !== roomId ? tv : m.id === tv.rootId ? { ...tv, root: m } : m.threadRootId === tv.rootId ? { ...tv, replies: mergeMessages(tv.replies, [m]) } : tv))
  if (!inTimeline(m)) return { ...d, threadViews }
  // a window around an older message (newerCursor) gets it with the newer pages, not after a gap
  const timeline = d.timeline && d.timeline.roomId === roomId && !d.timeline.newerCursor ? { ...d.timeline, messages: mergeMessages(d.timeline.messages, [m]) } : d.timeline
  const room = d.rooms.find((r) => r.id === roomId)
  if (!room) return { ...d, timeline, threadViews }
  if (m.event) return { ...d, timeline, threadViews, rooms: d.rooms.map((r) => (r.id === roomId ? { ...r, lastSeq: Math.max(r.lastSeq, m.seq) } : r)) }
  const fresh = m.seq > room.lastSeq
  const mine = !!meId && m.author?.id === meId
  // my message in the room reads the room up to it (as the server does); my reply sent to the room too does not: it was
  // written in the thread, maybe with the room out of sight (the server moves only my place in the thread)
  const read = mine && !m.threadRootId
  const counts = fresh && m.seq > room.lastReadSeq && !mine && !m.deletedAt && d.openRoomId !== roomId
  const next: Room = {
    ...room,
    lastSeq: Math.max(room.lastSeq, m.seq),
    lastMessage: fresh || room.lastMessage?.id === m.id ? lastLineOf(m) : room.lastMessage,
    activityAt: fresh && time(m.createdAt) > time(room.activityAt) ? m.createdAt : room.activityAt,
    unreadCount: read && fresh ? 0 : counts ? Math.min(999, room.unreadCount + 1) : room.unreadCount,
    // (a followed thread's mention stays until that thread is read; room.read says so exactly)
    mentioned: read && fresh ? room.threadsUnread > 0 && room.mentioned : room.mentioned || (counts && mentionsMe(m, meId)),
    lastReadSeq: read ? Math.max(room.lastReadSeq, m.seq) : room.lastReadSeq,
  }
  return { ...d, rooms: sortRooms(d.rooms.map((r) => (r.id === roomId ? next : r))), timeline, threadViews }
}

/** Each thread on screen through `f` (the same object when none changed). */
function mapViews(views: Record<string, ThreadView>, f: (tv: ThreadView) => ThreadView): Record<string, ThreadView> {
  let out: Record<string, ThreadView> | null = null
  for (const [k, tv] of Object.entries(views)) {
    const next = f(tv)
    if (next !== tv) (out ??= { ...views })[k] = next
  }
  return out ?? views
}

/** One message changed in place wherever it shows in the room: the timeline, each thread's root and replies on screen. */
function mapMessages(d: RoomsData, roomId: string, f: (x: RoomMessage) => RoomMessage): Pick<RoomsData, 'timeline' | 'threadViews'> {
  const timeline = d.timeline && d.timeline.roomId === roomId ? { ...d.timeline, messages: d.timeline.messages.map(f) } : d.timeline
  const threadViews = mapViews(d.threadViews, (tv) => (tv.roomId === roomId ? { ...tv, root: tv.root ? f(tv.root) : tv.root, replies: tv.replies.map(f) } : tv))
  return { timeline, threadViews }
}

/** An edited or deleted message: replaced where it shows (the timeline, the threads on screen, older quotes of it, the
 * room's last line). */
export function withUpdatedMessage(d: RoomsData, roomId: string, m: RoomMessage): RoomsData {
  const q = quoteOf(m)
  const changed = mapMessages(d, roomId, (x) => (x.id === m.id ? m : x.replyTo?.id === m.id ? { ...x, replyTo: { ...q, author: x.replyTo.author } } : x))
  const rooms = d.rooms.some((r) => r.id === roomId && r.lastMessage?.id === m.id) ? d.rooms.map((r) => (r.id === roomId && r.lastMessage?.id === m.id ? { ...r, lastMessage: lastLineOf(m) } : r)) : d.rooms
  return { ...d, rooms, ...changed }
}

/** The summary of a thread under its root changed (room.thread, or my read of it). */
export function withThreadSummary(d: RoomsData, roomId: string, rootId: string, thread: RoomThreadSummary | null): RoomsData {
  return { ...d, ...mapMessages(d, roomId, (x) => {
    if (x.id !== rootId) return x
    if (thread) return { ...x, thread }
    const { thread: _gone, ...rest } = x
    return rest
  }) }
}

/** The reactions on a message changed (room.reactions, my own toggle, its answer). */
export function withReactions(d: RoomsData, roomId: string, messageId: string, reactions: RoomReaction[]): RoomsData {
  return { ...d, ...mapMessages(d, roomId, (x) => {
    if (x.id !== messageId) return x
    if (reactions.length) return { ...x, reactions }
    const { reactions: _none, ...rest } = x
    return rest
  }) }
}

/** My reaction put on or taken off, before the server answers (my name first when it is new). */
export function toggledReactions(list: readonly RoomReaction[], emoji: string, on: boolean, me: { id: string; name: string } | null): RoomReaction[] {
  const i = list.findIndex((r) => r.emoji === emoji)
  if (on) {
    if (i >= 0) return list[i]!.mine ? [...list] : list.map((r, j) => (j === i ? { ...r, count: r.count + 1, mine: true, users: me ? [...r.users.filter((u) => u.id !== me.id), me] : r.users } : r))
    return [...list, { emoji, count: 1, mine: true, users: me ? [me] : [] }]
  }
  if (i < 0 || !list[i]!.mine) return [...list]
  const r = list[i]!
  if (r.count <= 1) return list.filter((_, j) => j !== i)
  return list.map((x, j) => (j === i ? { ...x, count: x.count - 1, mine: false, users: me ? x.users.filter((u) => u.id !== me.id) : x.users } : x))
}

/** The server's copy of a room (new to me, renamed, my setting, members changed): in its place by activity. */
export function withRoom(d: RoomsData, room: Room): RoomsData {
  const rooms = d.rooms.some((r) => r.id === room.id) ? d.rooms.map((r) => (r.id === room.id ? room : r)) : [...d.rooms, room]
  return { ...d, rooms: sortRooms(rooms) }
}

/** My hidden mark on a room (docs/DECISIONS.md "대화 숨기기"), before the server answers: the room stays in the list,
 * only marked (the sidebar, the counts and the 대화 tab leave it out; the full list shows it under "숨긴 대화"). Hiding
 * unpins it (docs/DECISIONS.md "Pinned conversations"). */
export function withHidden(d: RoomsData, roomId: string, hidden: boolean): RoomsData {
  return { ...d, rooms: d.rooms.map((r) => {
    if (r.id !== roomId || !!r.hidden === hidden) return r
    if (hidden) {
      const { pinnedAt: _unpinned, ...rest } = r
      return { ...rest, hidden: true as const }
    }
    const { hidden: _shown, ...rest } = r
    return rest
  }) }
}

/** I am no longer in the room: gone from the list, and its messages and threads with it. */
export function withoutRoom(d: RoomsData, roomId: string): RoomsData {
  const threadViews = Object.values(d.threadViews).some((tv) => tv.roomId === roomId) ? Object.fromEntries(Object.entries(d.threadViews).filter(([, tv]) => tv.roomId !== roomId)) : d.threadViews
  return { ...d, rooms: d.rooms.filter((r) => r.id !== roomId), timeline: d.timeline?.roomId === roomId ? null : d.timeline, threadViews }
}

/** One of my runs changed: a done one goes (its answer is a message now), the others stay in their place. */
export function withAiRun(ai: Record<string, RoomAi>, roomId: string, run: RoomAiRun): Record<string, RoomAi> {
  const cur = ai[roomId] ?? NO_AI
  const runs = run.state === 'done' ? cur.runs.filter((r) => r.turnId !== run.turnId) : withRun(cur.runs, run)
  return { ...ai, [roomId]: { ...cur, runs } }
}

/** The AI's count in a room. */
export function withAiCount(ai: Record<string, RoomAi>, roomId: string, answering: number): Record<string, RoomAi> {
  const cur = ai[roomId] ?? NO_AI
  return { ...ai, [roomId]: { ...cur, answering } }
}

/** The read position the server answered: my badge for the room follows it. */
export function withReadState(d: RoomsData, roomId: string, s: { lastReadSeq: number; unreadCount: number; mentioned?: boolean }): RoomsData {
  // "mentioned" also covers a followed thread's reply, which reading the room does not read: the server says (an older
  // one does not: then it stays while a followed thread has news)
  const mentioned = (r: Room) => s.mentioned ?? ((s.unreadCount > 0 || r.threadsUnread > 0) && r.mentioned)
  return { ...d, rooms: d.rooms.map((r) => (r.id === roomId ? { ...r, lastReadSeq: Math.max(r.lastReadSeq, s.lastReadSeq), unreadCount: s.unreadCount, mentioned: mentioned(r) } : r)) }
}

const myId = () => {
  const s = useSession.getState().status
  return s.kind === 'signed-in' ? s.me.user.id : null
}
const myRef = () => {
  const s = useSession.getState().status
  return s.kind === 'signed-in' ? { id: s.me.user.id, name: s.me.user.name } : null
}

export interface SendInput { body: string; mentions: string[]; mentionsAll?: boolean; files: RoomFile[]; threadRootId?: string | null; alsoInRoom?: boolean }

interface RoomsState extends RoomsData {
  loaded: boolean
  /** the list could not be read (an older server without rooms: the sidebar group stays away) */
  failed: unknown
  /** what decides the room sound besides each room's level (GET /api/rooms alerts; null: not read yet or an older
   * server); read again with the list when my notification settings change (store/live.ts room_alerts_changed) */
  alerts: RoomAlertSettings | null
  members: Record<string, RoomMember[]>
  /** per room: its timeline's sends and its threads' (PendingSend.threadRootId) */
  pending: Record<string, PendingSend[]>
  /** a send the server refused (the AI still busy with my question, a used-up budget, …): back in its message box (by
   * placeKey: the room's, or a thread's) with the reason as a toast, not a failed bubble to retry
   * (components/rooms/RoomComposer.tsx takes it) */
  returned: Record<string, PendingSend>
  ai: Record<string, RoomAi>
  /** what the room page shows on its right besides a thread (which is in the address): 'trina', its Trina side chat
   * (components/rooms/SideChatPanel.tsx); none: nothing, or the thread. Gone when the page leaves the room. */
  side: Record<string, 'trina'>
  setSide: (roomId: string, side: 'trina' | null) => void
  loadRooms: () => Promise<void>
  /** null: not one of my rooms (gone from the list) */
  fetchRoom: (id: string) => Promise<Room | null>
  open: (roomId: string) => void
  close: (roomId: string) => void
  loadNewest: (roomId: string) => Promise<void>
  /** the newest page read again into the timeline as it is (older pages and the reader's place stay); nothing for a
   * window around an older message */
  refreshNewest: (roomId: string) => Promise<void>
  loadOlder: (roomId: string) => Promise<void>
  /** the timeline as a window around this message (a link or a search result older than the newest page) */
  loadAround: (roomId: string, messageId: string) => Promise<void>
  /** the window's next newer page (until it reaches the newest) */
  loadNewer: (roomId: string) => Promise<void>
  /** the thread under this message, beside the room (desktop) or over it (phones), or beside a file in the viewer: one
   * more panel shows it (read when it was not on screen yet) */
  openThread: (roomId: string, rootId: string) => void
  /** one panel less shows it: it goes with the last */
  closeThread: (roomId: string, rootId: string) => void
  loadThread: (roomId: string, rootId: string) => Promise<void>
  loadOlderReplies: (roomId: string, rootId: string) => Promise<void>
  markThreadRead: (roomId: string, rootId: string, seq: number) => Promise<void>
  loadMembers: (roomId: string, force?: boolean) => Promise<void>
  send: (roomId: string, input: SendInput) => void
  retry: (roomId: string, clientMessageId: string) => void
  discard: (roomId: string, clientMessageId: string) => void
  edit: (roomId: string, messageId: string, body: string, mentions: string[], mentionsAll?: boolean) => Promise<void>
  remove: (roomId: string, messageId: string) => Promise<void>
  /** put my reaction on a message, or take it off (shown at once; the server's answer wins) */
  react: (roomId: string, messageId: string, emoji: string, on: boolean) => Promise<void>
  markRead: (roomId: string, seq: number) => Promise<void>
  setMuted: (roomId: string, muted: boolean) => Promise<void>
  /** my level for a room (null: my default; docs/DECISIONS.md "대화방 알림 설정") */
  setNotifyLevel: (roomId: string, level: RoomNotifyLevel | null) => Promise<void>
  /** the DM with this person (the existing one when there is one) */
  openDm: (userId: string) => Promise<Room>
  /** a new group chat of me and these people (docs/DECISIONS.md "그룹 대화와 방 이름") */
  createGroup: (userIds: string[], name: string | null) => Promise<Room>
  /** the room's own name ('' or null: the server's name) */
  rename: (roomId: string, name: string | null) => Promise<void>
  invite: (roomId: string, userIds: string[]) => Promise<void>
  /** leave a group chat: it goes from the list (and every window) */
  leave: (roomId: string) => Promise<void>
  /** hide a DM, a team room or the everyone room from my lists, or show it again (docs/DECISIONS.md "대화 숨기기"):
   * shown at once, the server's answer wins; hiding the room on screen goes to the conversations list */
  setHidden: (roomId: string, hidden: boolean) => Promise<void>
  /** pin a room to the top of my lists, or unpin it ("상단에 고정" / "고정 해제", docs/DECISIONS.md "Pinned
   * conversations"): mine only; my other windows hear it (room.updated) */
  setPinned: (roomId: string, pinned: boolean) => Promise<void>
  removeMember: (roomId: string, userId: string) => Promise<void>
  /** the AI's count and my own questions in a room (GET /api/rooms/:id/ai) */
  loadAi: (roomId: string) => Promise<void>
  stopAi: (roomId: string, turnId: string) => Promise<void>
  /** close a run of mine that stopped or failed */
  dismissAi: (roomId: string, turnId: string) => void
  /** the message box took back a refused send (by placeKey) */
  takeReturned: (key: string) => void
  /** post my private preview of an AI answer to the room */
  shareAi: (roomId: string, messageId: string) => Promise<void>
  /** "대화방에 보내기": a finished answer of my own AI chat to a room I am in, as my message (shared/src/api/chats.ts
   * shareAnswerToRoom); sent, the message takes its place in the room once (the server's room.message to my windows
   * finds it there) */
  shareAnswer: (chatId: string, messageId: string, body: { roomId: string; note?: string; confirmKey?: string; attach?: string[]; threadRootId?: string; clientMessageId: string }) => Promise<ShareAnswerToRoomResult>
  resync: () => Promise<void>
  handleEvent: (ev: RoomEvent) => void
  reset: () => void
}

const EMPTY: Pick<RoomsState, 'rooms' | 'openRoomId' | 'timeline' | 'threadViews' | 'loaded' | 'failed' | 'alerts' | 'members' | 'pending' | 'returned' | 'ai' | 'side'> = { rooms: [], openRoomId: null, timeline: null, threadViews: {}, loaded: false, failed: null, alerts: null, members: {}, pending: {}, returned: {}, ai: {}, side: {} }

/** what was typed in a room (or one of its threads: placeKey) and not sent yet, while this page is open
 * (components/rooms/RoomComposer.tsx); gone at sign-out with the rest */
export const roomDrafts = new Map<string, string>()
/** the people picked in those drafts and where their names stand (lib/rooms.ts PickedMention), so a draft keeps its
 * mentions */
export const roomDraftMentions = new Map<string, PickedMention[]>()

/** read positions already asked for, per room and per thread (placeKey; a scroll fires many times: one request per new
 * position) */
const asked = new Map<string, number>()
/** rooms I am leaving from this window: their "removed" event is no news here */
const leaving = new Set<string>()
/** The member list read last per room: an answer to an older read, or to one from before the list was dropped (a members
 * change, a resync), does not put an old list back. */
const memberReads = new Map<string, number>()
let memberReadSeq = 0
/** a newer read of the same room's messages wins over an older one still on its way */
let timelineGen = 0
/** the same for each thread on screen (by placeKey; one counter for all, so a thread that went and came back never
 * takes an answer meant for its earlier showing); a thread's goes with it */
let threadGenSeq = 0
const threadGens = new Map<string, number>()
const nextThreadGen = (key: string) => {
  const g = ++threadGenSeq
  threadGens.set(key, g)
  return g
}

/** The changes to the messages on screen (a new one, an edit, reactions, a thread's summary) made while a read of a page
 * is on its way: the page is what the server had when it read it, so these are made again on it, or a message that
 * came meanwhile would be gone (and the room read up to it). One list per read in flight. */
type MessageChange = (d: RoomsData) => RoomsData
const inFlight = new Set<MessageChange[]>()
const watchChanges = () => {
  const changes: MessageChange[] = []
  inFlight.add(changes)
  return { changes, done: () => inFlight.delete(changes) }
}
/** The page read, with the changes made while it was on its way made again on it (only its part: the rooms and the
 * other places had them already). */
const replayed = (s: RoomsData, changes: MessageChange[], fresh: Partial<RoomsData>): RoomsData => changes.reduce((d, f) => f(d), { ...s, ...fresh })

const omit = <T,>(o: Record<string, T>, key: string) => {
  if (!(key in o)) return o
  const next = { ...o }
  delete next[key]
  return next
}

/** The message as this window has it (the timeline, the threads on screen). */
export function findMessage(s: RoomsData, roomId: string, id: string): RoomMessage | undefined {
  if (s.timeline?.roomId === roomId) { const m = s.timeline.messages.find((x) => x.id === id); if (m) return m }
  for (const tv of Object.values(s.threadViews)) {
    if (tv.roomId !== roomId) continue
    const m = tv.root?.id === id ? tv.root : tv.replies.find((x) => x.id === id)
    if (m) return m
  }
  return undefined
}

/** A room file whose message this window has and which was deleted since (or the file is no longer on it): the file
 * viewer's "no longer available". A message this window no longer holds (an older page the timeline left when it went
 * back to the newest) is not known to be gone. */
export function roomFileGone(s: RoomsData, roomId: string, messageId: string, fileId: string): boolean {
  const m = findMessage(s, roomId, messageId)
  return !!m && (!!m.deletedAt || !m.files.some((f) => f.id === fileId))
}

/** The sends still on their way (or failed) without the ones whose message is on screen (the room's timeline, a thread
 * on screen), matched by the id my app sent it with (RoomMessage.clientMessageId, only ever on my own messages). Such a
 * send is done whichever way its message came: its own answer, the live event, a replay or a page read again after a
 * reconnect. Otherwise a send whose answer was lost shows twice: delivered, and failed with 다시 시도 / 지우기. The same
 * object when nothing is done. */
export function settledPending(s: Pick<RoomsData, 'timeline' | 'threadViews'> & { pending: Record<string, PendingSend[]> }): Record<string, PendingSend[]> {
  if (!Object.keys(s.pending).length) return s.pending
  // by room: the ids of my messages on screen
  const sent = new Map<string, Set<string>>()
  const note = (roomId: string, list: readonly (RoomMessage | null)[]) => {
    if (!s.pending[roomId]) return
    for (const m of list) {
      if (!m?.clientMessageId) continue
      const ids = sent.get(roomId) ?? new Set<string>()
      ids.add(m.clientMessageId)
      sent.set(roomId, ids)
    }
  }
  if (s.timeline) note(s.timeline.roomId, s.timeline.messages)
  for (const tv of Object.values(s.threadViews)) note(tv.roomId, [tv.root, ...tv.replies])
  let pending = s.pending
  for (const [roomId, ids] of sent) {
    const list = pending[roomId]!
    const left = list.filter((p) => !ids.has(p.clientMessageId))
    if (left.length < list.length) pending = left.length ? { ...pending, [roomId]: left } : omit(pending, roomId)
  }
  return pending
}

export const useRooms = create<RoomsState>((set, get) => {
  const setPending = (roomId: string, f: (list: PendingSend[]) => PendingSend[]) =>
    set((s) => {
      const list = f(s.pending[roomId] ?? [])
      return { pending: list.length ? { ...s.pending, [roomId]: list } : omit(s.pending, roomId) }
    })

  /** a change to the messages on screen, kept for each page read on its way too (watchChanges) */
  const patchMessages = (f: MessageChange) => {
    for (const list of inFlight) list.push(f)
    set((s) => f(s))
  }

  const post = async (roomId: string, p: PendingSend) => {
    try {
      const m = await api.call(API.sendRoomMessage, { params: { id: roomId }, body: { body: p.body, mentions: p.mentions, ...(p.mentionsAll ? { mentionsAll: true } : {}), fileIds: p.files.map((f) => f.id), clientMessageId: p.clientMessageId, ...(p.threadRootId ? { threadRootId: p.threadRootId, alsoInRoom: p.alsoInRoom } : {}) } })
      patchMessages((s) => withMessage(s, roomId, m, myId()))
      setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== p.clientMessageId))
    } catch (e) {
      // its message came another way while the answer was lost (settledPending), or it was let go: nothing to show
      if (!get().pending[roomId]?.some((x) => x.clientMessageId === p.clientMessageId)) return
      const error = errorText(e, currentLocale(), t('error.network'))
      // the server said no (not a lost connection): sending it again would get the same answer, so the text goes back
      // to the box to send later; a room that is gone (404) or a lost sign-in (401) keeps the failed bubble
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 404) {
        setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== p.clientMessageId))
        set((s) => ({ returned: { ...s.returned, [placeKey(roomId, p.threadRootId)]: p } }))
        toast({ level: 'warn', text: error })
        return
      }
      setPending(roomId, (list) => list.map((x) => (x.clientMessageId === p.clientMessageId ? { ...x, state: 'failed', error } : x)))
    }
  }

  return {
    ...EMPTY,

    async loadRooms() {
      try {
        const r = await api.call(API.listRooms)
        set({ rooms: sortRooms(r.items), loaded: true, failed: null, alerts: r.alerts ?? null })
      } catch (e) {
        set({ loaded: true, failed: e })
      }
    },

    async fetchRoom(id) {
      try {
        const room = await api.call(API.getRoom, { params: { id } })
        set((s) => withRoom(s, room))
        return room
      } catch (e) {
        if (isApiError(e, 'not_found') || isApiError(e, 'forbidden')) {
          set((s) => withoutRoom(s, id))
          return null
        }
        throw e
      }
    },

    setSide(roomId, side) {
      set((s) => (side ? (s.side[roomId] === side ? {} : { side: { ...s.side, [roomId]: side } }) : { side: omit(s.side, roomId) }))
    },

    open(roomId) {
      asked.delete(roomId)
      // (the threads stay: each is its panel's, opened before the page's own effect runs)
      set({ openRoomId: roomId, timeline: { roomId, messages: [], nextCursor: null, loading: true, error: null } })
      void get().loadNewest(roomId)
      void get().loadMembers(roomId)
      void get().loadAi(roomId)
    },

    close(roomId) {
      // the page's right side goes with it, as the page's own state did
      set((s) => ({ side: omit(s.side, roomId) }))
      if (get().openRoomId !== roomId) return
      timelineGen++
      set({ openRoomId: null, timeline: null })
      // messages that came while it was on screen did not count; left without reading them, the server's count is right
      const r = get().rooms.find((x) => x.id === roomId)
      if (r && r.lastReadSeq < r.lastSeq) void get().fetchRoom(roomId).catch(() => {})
    },

    async loadNewest(roomId) {
      const gen = ++timelineGen
      // a failed read's error stays until this one answers: the page's calm notice stays while it reads again
      // (components/LoadError.tsx) instead of going and coming back
      set((s) => (s.timeline?.roomId === roomId ? { timeline: { ...s.timeline, loading: true } } : {}))
      const w = watchChanges()
      try {
        const page = await api.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: ROOM_PAGE } })
        if (gen !== timelineGen || get().openRoomId !== roomId) return
        // the messages that came while it was read (my own send from a window around an older one too) stay
        set((s) => ({ timeline: replayed(s, w.changes, { timeline: { roomId, messages: mergeMessages([], page.items), nextCursor: page.nextCursor, loading: false, error: null } }).timeline }))
      } catch (error) {
        if (gen !== timelineGen || get().openRoomId !== roomId) return
        set((s) => ({ timeline: { roomId, messages: s.timeline?.roomId === roomId ? s.timeline.messages : [], nextCursor: s.timeline?.roomId === roomId ? s.timeline.nextCursor : null, loading: false, error } }))
      } finally {
        w.done()
      }
    },

    async refreshNewest(roomId) {
      const tl = get().timeline
      // a window around an older message reads the newest when it gets there
      if (!tl || tl.roomId !== roomId || tl.newerCursor) return
      // nothing on screen yet (the first read failed or is on its way): the newest page as a first read
      if (!tl.messages.length) return get().loadNewest(roomId)
      const gen = timelineGen
      const w = watchChanges()
      try {
        const page = await api.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: ROOM_PAGE } })
        if (gen !== timelineGen) return
        // in place: the older pages loaded and the reader's place stay
        set((s) => (s.timeline?.roomId === roomId && !s.timeline.newerCursor ? { timeline: replayed(s, w.changes, { timeline: { ...s.timeline, messages: mergeMessages(s.timeline.messages, page.items) } }).timeline } : {}))
      } catch {
        /* as it was; the next open reads it again */
      } finally {
        w.done()
      }
    },

    async loadOlder(roomId) {
      const tl = get().timeline
      if (!tl || tl.roomId !== roomId || !tl.nextCursor || tl.loading) return
      const gen = timelineGen
      set({ timeline: { ...tl, loading: true } })
      try {
        const page = await api.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: ROOM_PAGE, cursor: tl.nextCursor } })
        if (gen !== timelineGen) return
        set((s) => (s.timeline?.roomId === roomId ? { timeline: { ...s.timeline, messages: mergeMessages(s.timeline.messages, page.items), nextCursor: page.nextCursor, loading: false } } : {}))
      } catch {
        if (gen !== timelineGen) return
        set((s) => (s.timeline?.roomId === roomId ? { timeline: { ...s.timeline, loading: false } } : {}))
      }
    },

    async loadAround(roomId, messageId) {
      const gen = ++timelineGen
      set((s) => (s.timeline?.roomId === roomId ? { timeline: { ...s.timeline, loading: true, error: null } } : {}))
      const w = watchChanges()
      try {
        const page = await api.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: ROOM_PAGE, around: messageId } })
        if (gen !== timelineGen || get().openRoomId !== roomId) return
        // (a new message waits for the newer pages; an edit or a reaction meanwhile shows)
        set((s) => ({ timeline: replayed(s, w.changes, { timeline: { roomId, messages: mergeMessages([], page.items), nextCursor: page.nextCursor, newerCursor: page.newerCursor ?? null, loading: false, error: null } }).timeline }))
      } catch {
        // the newest page as it was (the message is not looked for again)
        if (gen !== timelineGen) return
        set((s) => (s.timeline?.roomId === roomId ? { timeline: { ...s.timeline, loading: false } } : {}))
      } finally {
        w.done()
      }
    },

    async loadNewer(roomId) {
      const tl = get().timeline
      if (!tl || tl.roomId !== roomId || !tl.newerCursor || tl.loading) return
      const gen = timelineGen
      set({ timeline: { ...tl, loading: true } })
      try {
        const page = await api.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: ROOM_PAGE, cursor: tl.newerCursor } })
        if (gen !== timelineGen) return
        set((s) => (s.timeline?.roomId === roomId ? { timeline: { ...s.timeline, messages: mergeMessages(s.timeline.messages, page.items), newerCursor: page.newerCursor ?? null, loading: false } } : {}))
      } catch {
        if (gen !== timelineGen) return
        set((s) => (s.timeline?.roomId === roomId ? { timeline: { ...s.timeline, loading: false } } : {}))
      }
    },

    openThread(roomId, rootId) {
      const key = placeKey(roomId, rootId)
      const cur = get().threadViews[key]
      // on screen already (the page's thread, now beside a file of it too): one more panel shows it
      if (cur) return set((s) => ({ threadViews: { ...s.threadViews, [key]: { ...cur, holders: cur.holders + 1 } } }))
      asked.delete(key)
      // the root as the timeline has it already: shown at once while the replies load
      const root = get().timeline?.roomId === roomId ? get().timeline!.messages.find((m) => m.id === rootId) ?? null : null
      set((s) => ({ threadViews: { ...s.threadViews, [key]: { roomId, rootId, root, replies: [], nextCursor: null, loading: true, error: null, holders: 1 } } }))
      void get().loadThread(roomId, rootId)
    },

    closeThread(roomId, rootId) {
      const key = placeKey(roomId, rootId)
      const cur = get().threadViews[key]
      if (!cur) return
      if (cur.holders > 1) return set((s) => ({ threadViews: { ...s.threadViews, [key]: { ...cur, holders: cur.holders - 1 } } }))
      // the last panel: a read still on its way is dropped
      threadGens.delete(key)
      set((s) => ({ threadViews: omit(s.threadViews, key) }))
    },

    async loadThread(roomId, rootId) {
      const key = placeKey(roomId, rootId)
      const gen = nextThreadGen(key)
      set((s) => (s.threadViews[key] ? { threadViews: { ...s.threadViews, [key]: { ...s.threadViews[key]!, loading: true, error: null } } } : {}))
      const w = watchChanges()
      try {
        const page = await api.call(API.listRoomThread, { params: { id: roomId, messageId: rootId }, query: { limit: ROOM_PAGE } })
        if (gen !== threadGens.get(key)) return
        // the replies that came while it was read stay
        set((s) => {
          const tv = s.threadViews[key]
          if (!tv) return {}
          const read = replayed(s, w.changes, { threadViews: { [key]: { ...tv, root: page.root, replies: mergeMessages([], page.items), nextCursor: page.nextCursor, loading: false, error: null } } })
          return { threadViews: { ...s.threadViews, [key]: read.threadViews[key]! } }
        })
      } catch (error) {
        if (gen !== threadGens.get(key)) return
        set((s) => (s.threadViews[key] ? { threadViews: { ...s.threadViews, [key]: { ...s.threadViews[key]!, loading: false, error } } } : {}))
      } finally {
        w.done()
      }
    },

    async loadOlderReplies(roomId, rootId) {
      const key = placeKey(roomId, rootId)
      const tv = get().threadViews[key]
      if (!tv || !tv.nextCursor || tv.loading) return
      const gen = threadGens.get(key)
      set((s) => ({ threadViews: { ...s.threadViews, [key]: { ...tv, loading: true } } }))
      try {
        const page = await api.call(API.listRoomThread, { params: { id: roomId, messageId: rootId }, query: { limit: ROOM_PAGE, cursor: tv.nextCursor } })
        if (gen !== threadGens.get(key)) return
        set((s) => (s.threadViews[key] ? { threadViews: { ...s.threadViews, [key]: { ...s.threadViews[key]!, replies: mergeMessages(s.threadViews[key]!.replies, page.items), nextCursor: page.nextCursor, loading: false } } } : {}))
      } catch {
        if (gen !== threadGens.get(key)) return
        set((s) => (s.threadViews[key] ? { threadViews: { ...s.threadViews, [key]: { ...s.threadViews[key]!, loading: false } } } : {}))
      }
    },

    async markThreadRead(roomId, rootId, seq) {
      const key = placeKey(roomId, rootId)
      if ((asked.get(key) ?? 0) >= seq) return
      asked.set(key, seq)
      try {
        const r = await api.call(API.markRoomThreadRead, { params: { id: roomId, messageId: rootId }, body: { seq } })
        set((s) => withRoom(s, r.room))
        patchMessages((s) => {
          const root = findMessage(s, roomId, rootId)
          return root?.thread?.newReplies ? withThreadSummary(s, roomId, rootId, { ...root.thread, newReplies: false }) : s
        })
      } catch {
        if (asked.get(key) === seq) asked.delete(key)
      }
    },

    async loadMembers(roomId, force) {
      if (get().members[roomId] && !force) return
      const read = ++memberReadSeq
      memberReads.set(roomId, read)
      try {
        const r = await api.call(API.listRoomMembers, { params: { id: roomId } })
        if (memberReads.get(roomId) !== read) return
        set((s) => ({ members: { ...s.members, [roomId]: r.items } }))
      } catch {
        /* the header and the @ list do without; the next open asks again */
      }
    },

    send(roomId, input) {
      const p: PendingSend = { clientMessageId: uuidv7(), body: input.body, mentions: input.mentions, ...(input.mentionsAll ? { mentionsAll: true } : {}), files: input.files, threadRootId: input.threadRootId ?? null, alsoInRoom: !!input.threadRootId && !!input.alsoInRoom, state: 'sending', createdAt: new Date().toISOString() }
      setPending(roomId, (list) => [...list, p])
      void post(roomId, p)
      // sent from a window around an older message: back to the newest, where it goes
      const tl = get().timeline
      if (!p.threadRootId && tl?.roomId === roomId && tl.newerCursor) void get().loadNewest(roomId)
    },

    retry(roomId, clientMessageId) {
      const p = get().pending[roomId]?.find((x) => x.clientMessageId === clientMessageId)
      if (!p || p.state === 'sending') return
      setPending(roomId, (list) => list.map((x) => (x.clientMessageId === clientMessageId ? { ...x, state: 'sending', error: undefined } : x)))
      // the same client id: a send the server did get before the failure comes back as that message, not a second one
      void post(roomId, { ...p, state: 'sending' })
    },

    discard(roomId, clientMessageId) {
      setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== clientMessageId))
    },

    async edit(roomId, messageId, body, mentions, mentionsAll) {
      const m = await api.call(API.editRoomMessage, { params: { id: roomId, messageId }, body: { body, mentions, ...(mentionsAll ? { mentionsAll: true } : {}) } })
      patchMessages((s) => withUpdatedMessage(s, roomId, m))
    },

    async remove(roomId, messageId) {
      await api.call(API.deleteRoomMessage, { params: { id: roomId, messageId } })
      // the room.message.updated event says the same; show it at once
      const m = findMessage(get(), roomId, messageId)
      if (m) {
        const { reactions: _r, ...rest } = m
        patchMessages((s) => withUpdatedMessage(s, roomId, { ...rest, body: '', files: [], mentions: [], deletedAt: new Date().toISOString() }))
      }
    },

    async react(roomId, messageId, picked, on) {
      // the form the server keeps (❤ and ❤️ are one reaction)
      const emoji = emojiForm(picked)
      const before = findMessage(get(), roomId, messageId)?.reactions ?? []
      // a new emoji on a message that has the most different ones already: the server would refuse it (409)
      if (on && before.length >= ROOM_REACTION_EMOJI_MAX && !before.some((r) => r.emoji === emoji)) {
        toast({ level: 'warn', text: t('rooms.reactionsFull', { n: ROOM_REACTION_EMOJI_MAX }) })
        return
      }
      // the picker's "Recently used" (this browser, per person)
      const me = myRef()
      if (on && me) noteRecent(me.id, emoji)
      patchMessages((s) => withReactions(s, roomId, messageId, toggledReactions(before, emoji, on, me)))
      try {
        const r = await api.call(API.reactRoomMessage, { params: { id: roomId, messageId }, body: { emoji, on } })
        patchMessages((s) => withReactions(s, roomId, messageId, r.reactions))
      } catch (e) {
        // only my own tap undone, on the list as it is now: a room.reactions that came meanwhile (someone else's) stays.
        // A tap that changed nothing (on where it was mine already) has nothing to undo.
        const wasMine = !!before.find((x) => x.emoji === emoji)?.mine
        if (wasMine !== on) {
          patchMessages((s) => {
            const now = findMessage(s, roomId, messageId)
            return now ? withReactions(s, roomId, messageId, toggledReactions(now.reactions ?? [], emoji, !on, me)) : s
          })
        }
        toast({ level: 'warn', text: errorText(e, currentLocale(), t('error.network')) })
      }
    },

    async markRead(roomId, seq) {
      const room = get().rooms.find((r) => r.id === roomId)
      if (room && seq <= room.lastReadSeq) return
      if ((asked.get(roomId) ?? 0) >= seq) return
      asked.set(roomId, seq)
      try {
        const r = await api.call(API.markRoomRead, { params: { id: roomId }, body: { seq } })
        set((s) => withReadState(s, roomId, r))
      } catch {
        if (asked.get(roomId) === seq) asked.delete(roomId)
      }
    },

    async setMuted(roomId, muted) {
      const room = await api.call(API.updateRoom, { params: { id: roomId }, body: { muted } })
      set((s) => withRoom(s, room))
    },

    async setNotifyLevel(roomId, level) {
      const room = await api.call(API.updateRoom, { params: { id: roomId }, body: { notifyLevel: level } })
      set((s) => withRoom(s, room))
    },

    async openDm(userId) {
      const room = await api.call(API.createRoom, { body: { kind: 'dm', userId } })
      set((s) => withRoom(s, room))
      return room
    },

    async createGroup(userIds, name) {
      const room = await api.call(API.createRoom, { body: { kind: 'group', userIds, ...(name?.trim() ? { name: name.trim() } : {}) } })
      set((s) => withRoom(s, room))
      return room
    },

    async rename(roomId, name) {
      const room = await api.call(API.updateRoom, { params: { id: roomId }, body: { name: name?.trim() || null } })
      set((s) => withRoom(s, room))
    },

    async invite(roomId, userIds) {
      const room = await api.call(API.inviteRoomMembers, { params: { id: roomId }, body: { userIds } })
      memberReads.delete(roomId)
      set((s) => ({ ...withRoom(s, room), members: omit(s.members, roomId) }))
      void get().loadMembers(roomId, true)
    },

    async leave(roomId) {
      // my own windows get room.updated "removed" too: this one says nothing about it
      leaving.add(roomId)
      try {
        await api.call(API.leaveRoom, { params: { id: roomId } })
        // in place of the room I left: Back leads to where I was before it
        if (get().openRoomId === roomId) navigateTo('/rooms', { replace: true })
        set((s) => ({ ...withoutRoom(s, roomId), members: omit(s.members, roomId), pending: omit(s.pending, roomId), side: omit(s.side, roomId), ...(s.openRoomId === roomId ? { openRoomId: null } : {}) }))
        useSideChats.getState().drop(roomId)
      } finally {
        setTimeout(() => leaving.delete(roomId), 5000)
      }
    },

    async setHidden(roomId, hidden) {
      const was = get().rooms.find((r) => r.id === roomId)
      if (!was) return
      set((s) => withHidden(s, roomId, hidden))
      try {
        const room = await api.call(API.setRoomHidden, { params: { id: roomId }, body: { hidden } })
        set((s) => withRoom(s, room))
        // only once the server has it (refused, the room stays on screen with the error): to the list in place of the
        // room, so Back does not open it again (which would show it again)
        if (hidden && get().openRoomId === roomId) navigateTo('/rooms', { replace: true })
      } catch (e) {
        // as it was: shown or hidden, and its pin (hiding took it off)
        set((s) => {
          const d = withHidden(s, roomId, !!was.hidden)
          return was.pinnedAt ? { ...d, rooms: d.rooms.map((r) => (r.id === roomId ? { ...r, pinnedAt: was.pinnedAt } : r)) } : d
        })
        throw e
      }
    },

    async setPinned(roomId, pinned) {
      const params = { id: roomId }
      const room = pinned ? await api.call(API.pinRoom, { params }) : await api.call(API.unpinRoom, { params })
      set((s) => withRoom(s, room))
    },

    async removeMember(roomId, userId) {
      await api.call(API.removeRoomMember, { params: { id: roomId, userId } })
      set((s) => (s.members[roomId] ? { members: { ...s.members, [roomId]: s.members[roomId]!.filter((m) => m.user.id !== userId) } } : {}))
    },

    async loadAi(roomId) {
      // the cards of my questions here come along (the AI's question, a confirmation), as a chat's do with its thread
      // (store/chats.ts loadThread): after a reload, in another browser or after a reconnect the events that opened
      // them are not replayed, and the question would wait for an answer nobody can give
      const before = new Set(Object.keys(useChats.getState().requests))
      const who = myId()
      const [r, open] = await Promise.all([
        api.call(API.getRoomAi, { params: { id: roomId } }).catch(() => null),
        // an older server without the list: the cards that come over the socket, as before
        api.call(API.listRoomAiRequests, { params: { id: roomId } }).catch(() => null),
      ])
      // an older server without the AI in rooms: nothing shows; signed out meanwhile: nothing of it stays
      if (!r || myId() !== who) return
      // the questions of mine the list speaks for: the room's as this window knew them and as the server lists them
      // (the window's own: a question that ended while the socket was away still has its run here, so its card, which
      // the list no longer has, goes). The two reads run side by side: a turn that ended between them (the cards read
      // with its card, the runs read without it) and that this window does not know is outside these, so its listed
      // card is not merged (it would wait under no question) and a copy the socket brought is not dropped by this read;
      // either way the card goes with the turn's turn.request.closed (the end of a turn closes its cards first; one
      // closed before the merge stays out, mergeOpenRequests)
      const turns = new Set([...(get().ai[roomId]?.runs ?? []), ...r.mine].map((x) => x.turnId))
      set((s) => {
        // runs that ended here (stopped, failed) stay until closed; the server lists the working ones
        const ended = (s.ai[roomId]?.runs ?? []).filter((x) => x.state === 'stopped' || x.state === 'error')
        return { ai: { ...s.ai, [roomId]: { answering: r.answering, runs: [...r.mine, ...ended.filter((x) => !r.mine.some((m) => m.turnId === x.turnId))] } } }
      })
      if (open) useChats.setState((s) => ({ requests: mergeOpenRequests(s.requests, (q) => turns.has(q.turnId), open.items, before) }))
    },

    async stopAi(roomId, turnId) {
      await api.call(API.stopRoomAi, { params: { id: roomId, turnId } })
    },

    dismissAi(roomId, turnId) {
      set((s) => (s.ai[roomId] ? { ai: { ...s.ai, [roomId]: { ...s.ai[roomId]!, runs: s.ai[roomId]!.runs.filter((r) => r.turnId !== turnId) } } } : {}))
    },

    takeReturned(key) {
      set((s) => ({ returned: omit(s.returned, key) }))
    },

    async shareAi(roomId, messageId) {
      const m = await api.call(API.shareRoomMessage, { params: { id: roomId, messageId } })
      patchMessages((s) => withMessage(s, roomId, m, myId()))
    },

    async shareAnswer(chatId, messageId, body) {
      const r = await api.call(API.shareAnswerToRoom, { params: { id: chatId, messageId }, body })
      if (r.status === 'sent') patchMessages((s) => withMessage(s, body.roomId, r.message, myId()))
      return r
    },

    async resync() {
      await get().loadRooms()
      const open = get().openRoomId
      // the member lists: a members change missed while away is in none of them, so all go (the next open of a room reads
      // its list again) and the rooms on screen (the open one, one beside a file in the viewer) read theirs now
      const onScreen = new Set([...(open ? [open] : []), ...Object.values(get().threadViews).map((tv) => tv.roomId)])
      memberReads.clear()
      set((s) => ({ members: Object.fromEntries(Object.entries(s.members).filter(([id]) => onScreen.has(id))) }))
      const members = [...onScreen].map((id) => get().loadMembers(id, true))
      // every thread on screen reads again, the room's and one beside a file of it
      const threads = Object.values(get().threadViews).map((tv) => get().loadThread(tv.roomId, tv.rootId))
      if (open) {
        asked.delete(open)
        await Promise.all([get().loadNewest(open), get().loadAi(open), ...members, ...threads])
      } else await Promise.all([...members, ...threads])
    },

    handleEvent(ev) {
      switch (ev.type) {
        case 'room.ai':
          set((s) => ({ ai: withAiCount(s.ai, ev.data.roomId, ev.data.answering) }))
          return
        case 'room.ai.run':
          set((s) => ({ ai: withAiRun(s.ai, ev.data.roomId, ev.data.run) }))
          return
        case 'room.ai.step': {
          const cur = get().ai[ev.data.roomId]
          if (cur?.runs.some((r) => r.turnId === ev.data.turnId)) set((s) => ({ ai: { ...s.ai, [ev.data.roomId]: { ...cur, runs: withRunStep(cur.runs, ev.data.turnId, ev.data.step) } } }))
          return
        }
        case 'queue.position': {
          // the queue of every answer of mine: only my questions in rooms are kept here
          const { turnId, position } = ev.data
          for (const [roomId, cur] of Object.entries(get().ai)) {
            if (cur.runs.some((r) => r.turnId === turnId)) set((s) => ({ ai: { ...s.ai, [roomId]: { ...cur, runs: withRunPosition(cur.runs, turnId, position) } } }))
          }
          return
        }
        case 'room.message': {
          const { roomId, message } = ev.data
          const known = get().rooms.some((r) => r.id === roomId)
          patchMessages((s) => withMessage(s, roomId, message, myId()))
          // a room I was just added to whose "added" did not reach this window: its counts come from the server
          if (!known && get().loaded) void get().fetchRoom(roomId).catch(() => {})
          return
        }
        case 'room.message.updated':
          patchMessages((s) => withUpdatedMessage(s, ev.data.roomId, ev.data.message))
          return
        case 'room.thread':
          patchMessages((s) => withThreadSummary(s, ev.data.roomId, ev.data.rootId, ev.data.thread))
          return
        case 'room.reactions':
          patchMessages((s) => withReactions(s, ev.data.roomId, ev.data.messageId, ev.data.reactions))
          return
        case 'room.read':
          // I read it in another window or on my phone: my position and badge for the room (nobody else's)
          set((s) => withReadState(s, ev.data.roomId, ev.data))
          return
        case 'room.updated': {
          const { roomId, change, room } = ev.data
          if (change === 'removed' || !room) {
            const wasOpen = get().openRoomId === roomId
            set((s) => ({ ...withoutRoom(s, roomId), members: omit(s.members, roomId), pending: omit(s.pending, roomId), side: omit(s.side, roomId), ...(wasOpen ? { openRoomId: null } : {}) }))
            useSideChats.getState().drop(roomId)
            if (wasOpen) {
              if (!leaving.has(roomId)) toast({ level: 'info', text: t('rooms.removed') })
              navigateTo('/rooms')
            }
            return
          }
          set((s) => withRoom(s, room))
          if (change === 'members') {
            memberReads.delete(roomId)
            set((s) => ({ members: omit(s.members, roomId) }))
            // someone joined or left: the member list, and the reactions they took with them (in place: the reader keeps
            // their place)
            if (get().openRoomId === roomId) {
              void get().loadMembers(roomId, true)
              void get().refreshNewest(roomId)
            }
            for (const tv of Object.values(get().threadViews)) if (tv.roomId === roomId) void get().loadThread(roomId, tv.rootId)
          }
          return
        }
      }
    },

    reset() {
      asked.clear()
      leaving.clear()
      memberReads.clear()
      roomDrafts.clear()
      roomDraftMentions.clear()
      useSideChats.getState().reset()
      timelineGen++
      threadGens.clear()
      inFlight.clear()
      set({ ...EMPTY })
    },
  }
})

// A send whose message is on screen is done (settledPending), checked whenever what is on screen or the sends change:
// one place for every way the message can come, so a send whose answer was lost never stays failed beside it
useRooms.subscribe((s, prev) => {
  if (s.timeline === prev.timeline && s.threadViews === prev.threadViews && s.pending === prev.pending) return
  const pending = settledPending(s)
  if (pending !== s.pending) useRooms.setState({ pending })
})
