// The team chat rooms ("대화방" v1, shared/src/api/rooms.ts): the rooms I am in with their unread badges, the timeline
// of the one room on screen (pages/Room.tsx) and the threads on screen (components/rooms/ThreadPanel.tsx; docs/
// DECISIONS.md "스레드와 반응"): the one beside the room or over it, and the one beside a file in the viewer
// (components/rooms/ViewerColumn.tsx), each kept while a panel shows it (threadViews, by root, with a count): leaving
// drops a thread and opening reads its newest page. A room's timeline stays a while after leaving it (kept, the last
// KEPT_ROOMS rooms, in memory only, current by the same events): going back shows it at once and reads only what came
// after its newest message (docs/DECISIONS.md "Rooms left a moment ago open at once"). What the room page shows on its right (a
// thread is in the address; side: the Trina side chat) is here too, so the file viewer can start the same way. A reply in a thread goes to the thread, and to the timeline only when it was sent to the room too. The
// WebSocket's room.* events come in through store/live.ts dispatch → handleEvent; the pure with* functions below make
// the state changes (test/unit/rooms-store.test.ts), handleEvent adds the requests they need. A reconnect the server
// could not resume reloads through resync (components/rooms/useRoomsSync).
import { create } from 'zustand'
import { emojiForm } from '@mycel/shared'
import { ROOM_REACTION_EMOJI_MAX, roomLevel, roomTimelineCursor, uuidv7, type Room, type RoomAlertSettings, type ShareAnswerToRoomResult, type RoomNotifyLevel, type RoomFile, type RoomLastMessage, type RoomMember, type RoomMessage, type RoomQuote, type RoomReaction, type RoomReadState, type RoomThreadReadState, type RoomThreadSummary, type ServerEvent } from '@mycel/shared/api'
import { api, API, ApiError, errorText, isApiError } from '../lib/api'
import { noteRecent } from '../lib/emoji'
import { optimistic, optimisticPending } from '../lib/optimistic'
import { mentionsMe, newestSeq, type PickedMention } from '../lib/rooms'
import { draftKey, readDraft, writeDraft } from '../lib/localData'
import { navigateTo } from '../lib/nav'
import { lastHeard, LIVE_QUIET_MS } from '../lib/realtime'
import { currentLocale, t } from '../i18n'
import { useSession } from './session'
import { useSideChats } from './sideChats'
import { toast, useUi } from './ui'

export type RoomEvent = Extract<ServerEvent, { type: 'room.message' | 'room.message.updated' | 'room.read' | 'room.thread' | 'room.reactions' | 'room.updated' }>

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
  /** "Show message" for these linked messages (SendRoomMessageBody.showMessages) */
  showMessages?: string[]
  state: 'sending' | 'failed'
  error?: string
  createdAt: string
  /** kept on this device from an earlier page (the app was closed, the page loaded again) and not confirmed since: it
   * may have reached the server. Try again is safe (the same client id). */
  restored?: true
}

/** Where the reader was in a room they left: the first message in sight and how far below the list's top its top was.
 * None: at the bottom, following the newest. */
export interface RoomPlace { messageId: string; offset: number }

/** A room left a moment ago (KEPT_ROOMS): its timeline at the newest, kept current by the room.* events as the open
 * one is, where the reader was, when it was left and its newest message then (leftSeq). */
export interface KeptTimeline extends RoomTimeline { place: RoomPlace | null; leftAt: number; leftSeq: number }

/** Where going back to a kept room opens: where the reader left it, while nothing came since (else at the bottom, with
 * what came in sight, as before); null: at the bottom. */
export const keptPlace = (tl: KeptTimeline | null): RoomPlace | null => (tl?.place && newestSeq(tl.messages) === tl.leftSeq ? tl.place : null)

/** how many rooms left lately keep their messages in this window's memory (never on the device), the last left first */
export const KEPT_ROOMS = 10
/** the newest messages each keeps (the older ones load again on scrolling up) */
export const KEPT_MESSAGES = 200

export interface RoomsData {
  rooms: Room[]
  /** the room on screen */
  openRoomId: string | null
  timeline: RoomTimeline | null
  /** the threads on screen, by placeKey(roomId, rootId) */
  threadViews: Record<string, ThreadView>
  /** the rooms left lately, by room (docs/DECISIONS.md "Rooms left a moment ago open at once"): going back shows them
   * at once and asks only for what came after their newest message. Gone with the room, when the live updates may
   * have missed something (resync), at sign-out. */
  kept?: Record<string, KeptTimeline>
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

/** A timeline cut to its newest `max` messages: what it drops loads again on scrolling up, from the oldest it keeps. */
export function capped<T extends RoomTimeline>(tl: T, max = KEPT_MESSAGES): T {
  if (tl.messages.length <= max) return tl
  const messages = tl.messages.slice(-max)
  return { ...tl, messages, nextCursor: roomTimelineCursor('older', messages[0]!.seq) }
}

/** This room's kept timeline changed by `f` (kept to its newest KEPT_MESSAGES), as a part of RoomsData to spread:
 * empty when the room is not kept or `f` changed nothing. */
function keptPatch(d: Pick<RoomsData, 'kept'>, roomId: string, f: (tl: KeptTimeline) => KeptTimeline): Pick<RoomsData, 'kept'> {
  const tl = d.kept?.[roomId]
  if (!tl) return {}
  const next = capped(f(tl))
  return next === tl ? {} : { kept: { ...d.kept, [roomId]: next } }
}

/** The kept timeline to show on going back to a room (null: read it as the first time). Only while the live connection
 * is up and was heard lately (a link that went quiet, a computer waking from sleep, may be dead): otherwise events may
 * be missing, the one that took me out of the room too, so the room is read again (the server answers 404 then, and
 * nothing of it shows). */
export const keptFor = (d: Pick<RoomsData, 'kept'>, roomId: string): KeptTimeline | null =>
  useUi.getState().conn === 'open' && Date.now() - lastHeard() < LIVE_QUIET_MS ? (d.kept?.[roomId] ?? null) : null

/** The kept rooms with this one added as the last left, the one left longest ago going past KEPT_ROOMS. */
export function withKept(kept: Record<string, KeptTimeline> | undefined, tl: KeptTimeline, max = KEPT_ROOMS): Record<string, KeptTimeline> {
  const others = Object.values(kept ?? {}).filter((x) => x.roomId !== tl.roomId).sort((a, b) => b.leftAt - a.leftAt)
  return Object.fromEntries([capped(tl), ...others].slice(0, max).map((x) => [x.roomId, x]))
}

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
  // a room left a moment ago gets it too (kept at the newest), so going back shows it
  const kept = keptPatch(d, roomId, (tl) => ({ ...tl, messages: mergeMessages(tl.messages, [m]) }))
  const room = d.rooms.find((r) => r.id === roomId)
  if (!room) return { ...d, timeline, threadViews, ...kept }
  // an app's quiet line (server rooms/apps: Quiet, the paused line) counts nowhere, as an event line
  if (m.event || m.app?.quiet) return { ...d, timeline, threadViews, ...kept, rooms: d.rooms.map((r) => (r.id === roomId ? { ...r, lastSeq: Math.max(r.lastSeq, m.seq) } : r)) }
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
  return { ...d, rooms: sortRooms(d.rooms.map((r) => (r.id === roomId ? next : r))), timeline, threadViews, ...kept }
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

/** One message changed in place wherever it shows in the room: the timeline, each thread's root and replies on screen,
 * and the room's kept timeline when it was left a moment ago. */
function mapMessages(d: RoomsData, roomId: string, f: (x: RoomMessage) => RoomMessage): Pick<RoomsData, 'timeline' | 'threadViews' | 'kept'> {
  const timeline = d.timeline && d.timeline.roomId === roomId ? { ...d.timeline, messages: d.timeline.messages.map(f) } : d.timeline
  const threadViews = mapViews(d.threadViews, (tv) => (tv.roomId === roomId ? { ...tv, root: tv.root ? f(tv.root) : tv.root, replies: tv.replies.map(f) } : tv))
  return { timeline, threadViews, ...keptPatch(d, roomId, (tl) => {
    const messages = tl.messages.map(f)
    return messages.every((m, i) => m === tl.messages[i]) ? tl : { ...tl, messages }
  }) }
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

const pinKey = (roomId: string) => `room:${roomId}:pin`

/** A room's pin as it is on screen now (lib/optimistic.ts), or none */
const withPin = (r: Room, at: string | undefined): Room => {
  const { pinnedAt: _was, ...rest } = r
  return at ? { ...rest, pinnedAt: at } : rest
}

const notifyKey = (roomId: string) => `room:${roomId}:notify`
const nameKey = (roomId: string) => `room:${roomId}:name`
const readKey = (roomId: string) => `room:${roomId}:read`
const threadReadKey = (roomId: string, rootId: string) => `room:${roomId}:thread:${rootId}:read`
const editKey = (roomId: string, messageId: string) => `room:${roomId}:message:${messageId}:edit`
/** a thread read still on its way: what its news mark and the room's counts were before the first of them */
const threadSnaps = new Map<string, { had: boolean; before: Pick<Room, 'threadsUnread' | 'mentioned' | 'nextThreadId'> | null }>()

/** My level for a room as it is on screen now (lib/optimistic.ts): `notify` as the server would answer it (what my
 * default gives the room stays), and `muted` with 끄기 */
export function withNotifyLevel(r: Room, own: RoomNotifyLevel | null): Room {
  const byDefault = r.notify?.byDefault ?? roomLevel(r.kind, null, 'direct')
  return { ...r, muted: own === 'off', notify: { own, byDefault, level: own ?? byDefault } }
}
const ownLevel = (r: Room | undefined): RoomNotifyLevel | null => (r?.notify ? r.notify.own : r?.muted ? 'off' : null)

/** my read place in a room and its badge, as the screen has it */
type ReadPlace = Pick<Room, 'lastReadSeq' | 'unreadCount' | 'mentioned'>
/** what an edit changes on a message */
type EditedText = Pick<RoomMessage, 'body' | 'mentions' | 'mentionsAll' | 'editedAt'>

/** A room read or heard while a change of mine to it is still on its way (lib/optimistic.ts: its pin, my level, its
 * name, my read place): it keeps what is on screen (the read may be from before the change; the change's own answer
 * decides). */
function keepPending(d: Pick<RoomsData, 'rooms'>, room: Room): Room {
  const now = d.rooms.find((r) => r.id === room.id)
  let r = optimisticPending(pinKey(room.id)) ? withPin(room, now?.pinnedAt) : room
  if (!now) return r
  if (optimisticPending(notifyKey(room.id))) r = withNotifyLevel(r, ownLevel(now))
  if (optimisticPending(nameKey(room.id))) r = { ...r, name: now.name }
  if (optimisticPending(readKey(room.id)) && now.lastReadSeq > r.lastReadSeq) r = { ...r, lastReadSeq: now.lastReadSeq, unreadCount: now.unreadCount, mentioned: now.mentioned }
  return r
}

/** My hidden mark on a room (docs/DECISIONS.md "대화 숨기기"), before the server answers: the room stays in the list,
 * only marked (the 대화 list, the counts and the 대화 tab leave it out; the full list shows it under "숨긴 대화"). Hiding
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

/** I am no longer in the room: gone from the list, and its messages and threads with it (the kept ones too: they never
 * show again). */
export function withoutRoom(d: RoomsData, roomId: string): RoomsData {
  const threadViews = Object.values(d.threadViews).some((tv) => tv.roomId === roomId) ? Object.fromEntries(Object.entries(d.threadViews).filter(([, tv]) => tv.roomId !== roomId)) : d.threadViews
  return { ...d, rooms: d.rooms.filter((r) => r.id !== roomId), timeline: d.timeline?.roomId === roomId ? null : d.timeline, threadViews, ...(d.kept?.[roomId] ? { kept: omit(d.kept, roomId) } : {}) }
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

export interface SendInput { body: string; mentions: string[]; mentionsAll?: boolean; files: RoomFile[]; threadRootId?: string | null; alsoInRoom?: boolean; showMessages?: string[] }

interface RoomsState extends RoomsData {
  kept: Record<string, KeptTimeline>
  loaded: boolean
  /** the list could not be read (an older server without rooms: the 대화 list stays empty) */
  failed: unknown
  /** what decides the room sound besides each room's level (GET /api/rooms alerts; null: not read yet or an older
   * server); read again with the list when my notification settings change (store/live.ts room_alerts_changed) */
  alerts: RoomAlertSettings | null
  members: Record<string, RoomMember[]>
  /** per room: its timeline's sends and its threads' (PendingSend.threadRootId) */
  pending: Record<string, PendingSend[]>
  /** a send the server refused (a used-up budget, a team file I can no longer open, …): back in its message box (by
   * placeKey: the room's, or a thread's) with the reason as a toast, not a failed bubble to retry
   * (components/rooms/RoomComposer.tsx takes it) */
  returned: Record<string, PendingSend>
  /** what the room page shows on its right besides a thread (which is in the address): 'trina', its Trina side chat
   * (components/rooms/SideChatPanel.tsx); none: nothing, or the thread. Gone when the page leaves the room. */
  side: Record<string, 'trina'>
  setSide: (roomId: string, side: 'trina' | null) => void
  loadRooms: () => Promise<void>
  /** null: not one of my rooms (gone from the list) */
  fetchRoom: (id: string) => Promise<Room | null>
  /** the room on screen: as it was when I left it a moment ago (kept), else its newest page read */
  open: (roomId: string) => void
  /** the room off screen; `place`: where the reader was (none: at the bottom), kept with its timeline for going back */
  close: (roomId: string, place?: RoomPlace | null) => void
  loadNewest: (roomId: string) => Promise<void>
  /** what came after the newest message on screen (a kept room shown again), added to it; more than a page: the newest
   * page as a first read */
  loadAfter: (roomId: string) => Promise<void>
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
  /** my place in a thread moved to seq: its news mark and the room's badge go at once; a failure puts them back without
   * a word (asked again with a newer reply, the thread opening again or the connection coming back) */
  markThreadRead: (roomId: string, rootId: string, seq: number) => Promise<void>
  loadMembers: (roomId: string, force?: boolean) => Promise<void>
  send: (roomId: string, input: SendInput) => void
  retry: (roomId: string, clientMessageId: string) => void
  discard: (roomId: string, clientMessageId: string) => void
  /** my message's new text, on screen at once; a failure puts the old text back with a toast (lib/optimistic.ts).
   * Never rejects: false when it failed and nothing newer of it was made since (the box can open again with the text) */
  edit: (roomId: string, messageId: string, body: string, mentions: string[], mentionsAll?: boolean) => Promise<boolean>
  remove: (roomId: string, messageId: string) => Promise<void>
  /** "Remove preview" on my own message: that link's card goes for everyone (a failure says so in a toast) */
  hidePreview: (roomId: string, messageId: string, linkedMessageId: string) => Promise<void>
  /** put my reaction on a message, or take it off (shown at once; the server's answer wins) */
  react: (roomId: string, messageId: string, emoji: string, on: boolean) => Promise<void>
  /** my read place in the room moved to seq: the badge goes at once; a failure puts it back without a word (asked
   * again with a newer message, the room opening again or the connection coming back) */
  markRead: (roomId: string, seq: number) => Promise<void>
  setMuted: (roomId: string, muted: boolean) => Promise<void>
  /** my level for a room (null: my default; docs/DECISIONS.md "대화방 알림 설정"). On screen at once; a failure puts
   * it back with a toast (lib/optimistic.ts), so it never rejects */
  setNotifyLevel: (roomId: string, level: RoomNotifyLevel | null) => Promise<void>
  /** the DM with this person (the existing one when there is one) */
  openDm: (userId: string) => Promise<Room>
  /** a new group chat of me and these people (docs/DECISIONS.md "그룹 대화와 방 이름") */
  createGroup: (userIds: string[], name: string | null) => Promise<Room>
  /** the room's own name ('' or null: the server's name). On screen at once; a failure puts the old name back with a
   * toast (lib/optimistic.ts). Never rejects: false when it failed and nothing newer of it was made since (the field
   * can open again with the name typed) */
  rename: (roomId: string, name: string | null) => Promise<boolean>
  invite: (roomId: string, userIds: string[]) => Promise<void>
  /** leave a group chat: it goes from the list (and every window) */
  leave: (roomId: string) => Promise<void>
  /** hide a DM, a team room or the everyone room from my lists, or show it again (docs/DECISIONS.md "대화 숨기기"):
   * shown at once, the server's answer wins; hiding the room on screen goes to the conversations list */
  setHidden: (roomId: string, hidden: boolean) => Promise<void>
  /** pin a room to the top of my lists, or unpin it ("상단에 고정" / "고정 해제", docs/DECISIONS.md "Pinned
   * conversations"): mine only; my other windows hear it (room.updated). On screen at once; a failure puts it back
   * with a toast (lib/optimistic.ts), so it never rejects */
  setPinned: (roomId: string, pinned: boolean) => Promise<void>
  removeMember: (roomId: string, userId: string) => Promise<void>
  /** the message box took back a refused send (by placeKey) */
  takeReturned: (key: string) => void
  /** "대화방에 보내기": a finished answer of my own AI chat to a room I am in, as my message (shared/src/api/chats.ts
   * shareAnswerToRoom); sent, the message takes its place in the room once (the server's room.message to my windows
   * finds it there) */
  shareAnswer: (chatId: string, messageId: string, body: { roomId: string; note?: string; confirmKey?: string; attach?: string[]; threadRootId?: string; clientMessageId: string }) => Promise<ShareAnswerToRoomResult>
  /** the live connection could not resume (events in between are lost): the kept rooms go, and the open one is not kept
   * when left until its newest page is read again */
  forgetKept: () => void
  resync: () => Promise<void>
  handleEvent: (ev: RoomEvent) => void
  reset: () => void
}

const EMPTY: Pick<RoomsState, 'rooms' | 'openRoomId' | 'timeline' | 'threadViews' | 'kept' | 'loaded' | 'failed' | 'alerts' | 'members' | 'pending' | 'returned' | 'side'> = { rooms: [], openRoomId: null, timeline: null, threadViews: {}, kept: {}, loaded: false, failed: null, alerts: null, members: {}, pending: {}, returned: {}, side: {} }

/** what was typed in a room (or one of its threads: placeKey) and not sent yet (components/rooms/RoomComposer.tsx); kept
 * on this device too (keepRoomDraft), like the AI chat's drafts; gone at sign-out with the rest */
export const roomDrafts = new Map<string, string>()
/** the people picked in those drafts and where their names stand (lib/rooms.ts PickedMention), so a draft keeps its
 * mentions */
export const roomDraftMentions = new Map<string, PickedMention[]>()

// On this device, with the AI chat's drafts (lib/localData.ts: per signed-in person, on the team's own address; signing
// out, or another person signing in, clears them): each box's draft, and the sends of each room that were on their way
// or not sent (QA TC-374/375: closing the app or a Reload lost them). Kept 30 days at most, and only for rooms I am
// still in (pruneRoomDevice). Another tab of the same person shares them (onDeviceChange).
const draftStoreId = (key: string) => `room:${key}`
const unsentStoreId = (roomId: string) => `roomUnsent:${roomId}`
type DeviceStore = Parameters<typeof readDraft>[2]
/** how long this device keeps a room draft or a send that did not go */
export const ROOM_DEVICE_DAYS = 30
const tooOld = (at: number) => !(at > Date.now() - ROOM_DEVICE_DAYS * 86_400_000)

/** the rooms whose kept sends are in this page's store already (restoreUnsent: the first change to the room's sends, or
 * opening it): until then a change to them adds to what the device kept, never writes over it */
const restoredUnsent = new Set<string>()
/** the sends this page saw end (sent, settled, let go, back in the box): never written back from another tab's copy */
const goneHere = new Set<string>()
/** sends this page is still making that another tab of mine saw end (let go, sent): failing here, they go, not back */
const goneElsewhere = new Set<string>()

const isPicked = (x: unknown): x is PickedMention => {
  const m = x as PickedMention
  return !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.name === 'string' && Number.isInteger(m.start) && Number.isInteger(m.end)
}

/** this place's draft and its mentions as they are now (roomDrafts, roomDraftMentions) onto this device; nothing when
 * the device has them so already (a draft another tab changed, shown here: written back with a new time, a late echo
 * could undo that tab's newest keys) */
export function keepRoomDraft(key: string, s?: Parameters<typeof writeDraft>[3]) {
  const me = myId()
  if (!me) return
  const text = roomDrafts.get(key) ?? ''
  const mentions = roomDraftMentions.get(key) ?? []
  const raw = readDraft(me, draftStoreId(key), s)
  if (!text) {
    if (raw) writeDraft(me, draftStoreId(key), '', s)
    return
  }
  const there = storedDraft(raw || null)
  if (there && there.text === text && JSON.stringify(there.mentions) === JSON.stringify(mentions)) return
  writeDraft(me, draftStoreId(key), JSON.stringify({ text, mentions, at: Date.now() }), s)
}

/** every draft of this page onto this device (before a reload the person asked for: lib/reload-guard.ts) */
export function keepRoomDrafts(s?: Parameters<typeof writeDraft>[3]) {
  for (const key of roomDrafts.keys()) keepRoomDraft(key, s)
}

/** a kept draft as it is on the device (null: none, not ours, or too old) */
function storedDraft(raw: string | null): { text: string; mentions: PickedMention[] } | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { text?: unknown; mentions?: unknown; at?: unknown }
    if (typeof v.text !== 'string' || !v.text || typeof v.at !== 'number' || tooOld(v.at)) return null
    return { text: v.text, mentions: Array.isArray(v.mentions) ? v.mentions.filter(isPicked) : [] }
  } catch { return null }
}
function setDraftHere(key: string, d: { text: string; mentions: PickedMention[] } | null) {
  if (!d) {
    roomDrafts.delete(key)
    roomDraftMentions.delete(key)
    return
  }
  roomDrafts.set(key, d.text)
  if (d.mentions.length) roomDraftMentions.set(key, d.mentions)
  else roomDraftMentions.delete(key)
}

/** A box opens: the draft this device kept for its place (after the app was closed or the page loaded again) is its
 * draft, when this page has none of its own. Once: it is the page's draft from then on. */
export function restoreRoomDraft(key: string, s?: DeviceStore) {
  const me = myId()
  if (!me || roomDrafts.has(key)) return
  const d = storedDraft(readDraft(me, draftStoreId(key), s) || null)
  if (d) setDraftHere(key, d)
}

const isPendingSend = (x: unknown): x is PendingSend => {
  const p = x as PendingSend
  return !!p && typeof p === 'object' && typeof p.clientMessageId === 'string' && typeof p.body === 'string' && Array.isArray(p.mentions) && Array.isArray(p.files) && typeof p.createdAt === 'string'
}
const byCreated = (a: { createdAt: string }, b: { createdAt: string }) => time(a.createdAt) - time(b.createdAt)

/** the kept sends as the device has them, the ones younger than ROOM_DEVICE_DAYS */
function storedUnsent(roomId: string, s?: DeviceStore): PendingSend[] {
  const me = myId()
  if (!me) return []
  try {
    const v = JSON.parse(readDraft(me, unsentStoreId(roomId), s) || '[]') as unknown
    return Array.isArray(v) ? v.filter(isPendingSend).filter((p) => !tooOld(time(p.createdAt))) : []
  } catch { return [] }
}

/** This room's sends on their way or not sent onto this device: this page's, and the ones another tab of mine kept that
 * this page has not seen end (goneHere). None: removed. */
function keepUnsent(roomId: string, list: PendingSend[] | undefined) {
  const me = myId()
  if (!me) return
  const mine = list ?? []
  const ids = new Set(mine.map((p) => p.clientMessageId))
  const others = storedUnsent(roomId).filter((p) => !ids.has(p.clientMessageId) && !goneHere.has(p.clientMessageId))
  const all = [...mine.map(({ state: _s, error: _e, restored: _r, ...p }) => p), ...others].sort(byCreated)
  writeDraft(me, unsentStoreId(roomId), all.length ? JSON.stringify(all) : '')
}

/** The sends of this room this device kept (on their way or not sent when the page went), each as not sent and not
 * confirmed: Try again sends it with the same client id, so one the server did get comes back as that message, never a
 * second one. */
export function keptUnsent(roomId: string, s?: DeviceStore): PendingSend[] {
  return storedUnsent(roomId, s).map((p) => ({ ...p, threadRootId: p.threadRootId ?? null, alsoInRoom: !!p.alsoInRoom, state: 'failed' as const, restored: true as const }))
}

/** The room's sends in this page with the kept ones added, the first time this page touches them (once per room). */
function withKeptUnsent(roomId: string, list: PendingSend[]): PendingSend[] {
  if (restoredUnsent.has(roomId) || !myId()) return list
  restoredUnsent.add(roomId)
  const have = new Set(list.map((p) => p.clientMessageId))
  const add = keptUnsent(roomId).filter((p) => !have.has(p.clientMessageId) && !goneHere.has(p.clientMessageId))
  return add.length ? [...list, ...add].sort(byCreated) : list
}

/** A room I am no longer in: what this device kept for it (its box, its threads' boxes, its sends) goes. */
function forgetRoomOnDevice(roomId: string, s?: DeviceStore) {
  const me = myId()
  if (!me) return
  writeDraft(me, unsentStoreId(roomId), '', s)
  pruneRoomDevice((id) => id !== roomId, s)
}

/** Drop the room drafts and sends this device kept for me that are too old, or of a room `keep` says no to. */
export function pruneRoomDevice(keep: (roomId: string) => boolean, s: DeviceStore = typeof localStorage === 'undefined' ? null : localStorage) {
  const me = myId()
  if (!me || !s) return
  const head = draftKey(me, '')
  try {
    const gone: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (!k?.startsWith(head)) continue
      const id = k.slice(head.length)
      if (id.startsWith('room:')) {
        const roomId = id.slice(5).split('/')[0]!
        if (!keep(roomId) || !storedDraft(s.getItem(k))) gone.push(k)
      } else if (id.startsWith('roomUnsent:')) {
        if (!keep(id.slice(11))) gone.push(k)
      }
    }
    for (const k of gone) s.removeItem(k)
  } catch { /* storage blocked */ }
}

/** the room drafts another tab of mine changed (by placeKey): each box of the place reads its draft again
 * (components/rooms/RoomComposer.tsx) */
const draftWatchers = new Set<(key: string) => void>()
export function onRoomDraftElsewhere(f: (key: string) => void): () => void {
  draftWatchers.add(f)
  return () => draftWatchers.delete(f)
}

/** Another tab of mine changed what this device keeps (the window's "storage" event): a draft it changed is this page's
 * draft too; a send of mine it saw end (sent, let go) goes here too, unless this page is sending it now. Nothing is ever
 * sent from here. */
export function onDeviceChange(key: string | null, value: string | null) {
  const me = myId()
  if (!me || !key) return
  const head = draftKey(me, '')
  if (!key.startsWith(head)) return
  const id = key.slice(head.length)
  if (id.startsWith('room:')) {
    const place = id.slice(5)
    setDraftHere(place, storedDraft(value))
    for (const f of draftWatchers) f(place)
    return
  }
  if (!id.startsWith('roomUnsent:')) return
  const roomId = id.slice(11)
  const list = useRooms.getState().pending[roomId]
  if (!list || !restoredUnsent.has(roomId)) return
  let there: Set<string>
  try {
    const v = JSON.parse(value || '[]') as unknown
    there = new Set(Array.isArray(v) ? v.filter(isPendingSend).map((p) => p.clientMessageId) : [])
  } catch { return }
  for (const p of list) if (p.state === 'sending' && !there.has(p.clientMessageId)) goneElsewhere.add(p.clientMessageId)
  const left = list.filter((p) => p.state === 'sending' || there.has(p.clientMessageId))
  if (left.length === list.length) return
  useRooms.setState((s) => ({ pending: left.length ? { ...s.pending, [roomId]: left } : omit(s.pending, roomId) }))
}

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
/** the open rooms whose timeline may be out of date in a way the events do not mend: someone joined or left (the
 * reactions they took with them, on any message: the newest page read again does not cover the older ones), or the
 * live connection could not resume. Such a room is not kept when left, unless its newest page was read afresh since
 * (loadNewest). */
const unsure = new Map<string, number>()
/** (by the read count when it was marked: only a read that started after it clears it) */
const markUnsure = (roomId: string) => unsure.set(roomId, timelineGen)
/** Threads closed a moment ago (by placeKey, the last few): one opened again shows them at once while its newest page
 * is read (docs/DECISIONS.md "Lists, Search and Settings open at once"). A change in one meanwhile (a reply, an edit, a
 * delete, reactions) forgets it, so it opens as before, from the server. */
const keptThreads = new Map<string, Pick<ThreadView, 'root' | 'replies' | 'nextCursor'>>()
const KEPT_THREADS = 10
/** forget every kept thread of a room (I am out of it: back in later, its threads open from the server) */
function forgetKeptThreads(roomId: string) {
  for (const key of [...keptThreads.keys()]) if (key.startsWith(roomId + '/')) keptThreads.delete(key)
}
/** forget the kept threads of the room that this message (or its thread's root) is part of */
function forgetKeptThread(roomId: string, messageId: string, rootId?: string | null) {
  for (const [key, tv] of keptThreads) {
    if (!key.startsWith(roomId + '/')) continue
    const root = key.slice(roomId.length + 1)
    if (root === messageId || root === rootId || tv.replies.some((m) => m.id === messageId)) keptThreads.delete(key)
  }
}
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
  // (the first change to a room's sends in this page starts from the ones this device kept: withKeptUnsent)
  const setPending = (roomId: string, f: (list: PendingSend[]) => PendingSend[]) =>
    set((s) => {
      const list = f(withKeptUnsent(roomId, s.pending[roomId] ?? []))
      return { pending: list.length ? { ...s.pending, [roomId]: list } : omit(s.pending, roomId) }
    })

  /** a change to the messages on screen, kept for each page read on its way too (watchChanges) */
  const patchMessages = (f: MessageChange) => {
    for (const list of inFlight) list.push(f)
    set((s) => f(s))
  }

  const post = async (roomId: string, p: PendingSend) => {
    try {
      const m = await api.call(API.sendRoomMessage, { params: { id: roomId }, body: { body: p.body, mentions: p.mentions, ...(p.mentionsAll ? { mentionsAll: true } : {}), fileIds: p.files.map((f) => f.id), clientMessageId: p.clientMessageId, ...(p.threadRootId ? { threadRootId: p.threadRootId, alsoInRoom: p.alsoInRoom } : {}), ...(p.showMessages?.length ? { showMessages: p.showMessages } : {}) } })
      goneElsewhere.delete(p.clientMessageId)
      patchMessages((s) => withMessage(s, roomId, m, myId()))
      setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== p.clientMessageId))
    } catch (e) {
      // its message came another way while the answer was lost (settledPending), or it was let go: nothing to show
      if (!get().pending[roomId]?.some((x) => x.clientMessageId === p.clientMessageId)) return
      // another tab of mine let it go (or sent it) meanwhile: it goes here too (onDeviceChange)
      if (goneElsewhere.delete(p.clientMessageId)) {
        setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== p.clientMessageId))
        return
      }
      const error = errorText(e, currentLocale(), t('error.network'))
      // the server said no (not a lost connection): sending it again would get the same answer, so the text goes back
      // to the box to send later; a room that is gone (404) or a lost sign-in (401) keeps the failed bubble
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 404) {
        setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== p.clientMessageId))
        // team files I may no longer open: the server took those copies out (params.files), so they do not come back
        const out = e.body.params?.reason === 'team_file_access' ? new Set(String(e.body.params.files ?? '').split(',')) : null
        const back = out ? { ...p, files: p.files.filter((f) => !out.has(f.id)) } : p
        set((s) => ({ returned: { ...s.returned, [placeKey(roomId, p.threadRootId)]: back } }))
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
        // (a room left a moment ago that is not mine any more: its kept messages go with it)
        const mine = new Set(r.items.map((x) => x.id))
        set((s) => ({ rooms: sortRooms(r.items.map((x) => keepPending(s, x))), loaded: true, failed: null, alerts: r.alerts ?? null, kept: Object.values(s.kept).every((tl) => mine.has(tl.roomId)) ? s.kept : Object.fromEntries(Object.entries(s.kept).filter(([id]) => mine.has(id))) }))
        // what this device kept for rooms I am no longer in, or for too long, goes
        pruneRoomDevice((id) => mine.has(id))
      } catch (e) {
        set({ loaded: true, failed: e })
      }
    },

    async fetchRoom(id) {
      try {
        const room = await api.call(API.getRoom, { params: { id } })
        set((s) => withRoom(s, keepPending(s, room)))
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
      // a room left a moment ago: as it was, at once (the events kept it current meanwhile), and only what came after its
      // newest message is read; else its newest page
      const kept = keptFor(get(), roomId)
      const shown: RoomTimeline = kept ? { roomId, messages: kept.messages, nextCursor: kept.nextCursor, loading: false, error: null } : { roomId, messages: [], nextCursor: null, loading: true, error: null }
      // (the threads stay: each is its panel's, opened before the page's own effect runs)
      set((s) => ({ openRoomId: roomId, timeline: shown, kept: omit(s.kept, roomId) }))
      // the sends this device kept for the room come back as not sent, after the newest page: one the server did get
      // (its answer lost when the app closed) is on that page and settles at once (settledPending), not shown failed
      // (a send before that page came adds them at once: setPending)
      void (kept ? get().loadAfter(roomId) : get().loadNewest(roomId)).finally(() => {
        if (restoredUnsent.has(roomId) || get().openRoomId !== roomId) return
        setPending(roomId, (list) => list)
        // the ones that settled at once are gone from the device too
        keepUnsent(roomId, get().pending[roomId])
      })
      void get().loadMembers(roomId)
    },

    close(roomId, place = null) {
      // the page's right side goes with it, as the page's own state did
      set((s) => ({ side: omit(s.side, roomId) }))
      if (get().openRoomId !== roomId) return
      timelineGen++
      // kept for going back: a timeline read to the newest (not a window around an older message, not one still being
      // read or that failed, nor one read again after a change the events do not carry) of a room still in my list
      const tl = get().timeline
      const keep = !!tl && tl.roomId === roomId && !tl.loading && !tl.error && !tl.newerCursor && tl.messages.length > 0 && !unsure.has(roomId) && get().rooms.some((r) => r.id === roomId)
      unsure.delete(roomId)
      set((s) => ({ openRoomId: null, timeline: null, kept: keep ? withKept(s.kept, { ...tl!, place, leftAt: Date.now(), leftSeq: newestSeq(tl!.messages) }) : omit(s.kept, roomId) }))
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
        // read afresh since it was marked: kept again when left
        if ((unsure.get(roomId) ?? Infinity) < gen) unsure.delete(roomId)
      } catch (error) {
        if (gen !== timelineGen || get().openRoomId !== roomId) return
        set((s) => ({ timeline: { roomId, messages: s.timeline?.roomId === roomId ? s.timeline.messages : [], nextCursor: s.timeline?.roomId === roomId ? s.timeline.nextCursor : null, loading: false, error } }))
      } finally {
        w.done()
      }
    },

    async loadAfter(roomId) {
      const tl = get().timeline
      if (!tl || tl.roomId !== roomId || tl.newerCursor || !tl.messages.length) return get().loadNewest(roomId)
      const gen = timelineGen
      const w = watchChanges()
      try {
        const page = await api.call(API.listRoomMessages, { params: { id: roomId }, query: { limit: ROOM_PAGE, cursor: roomTimelineCursor('newer', newestSeq(tl.messages)) } })
        if (gen !== timelineGen || get().openRoomId !== roomId) return
        // more than a page came that the events did not bring: the newest page, as on a first open (no gap between)
        if (page.newerCursor) return void get().loadNewest(roomId)
        if (!page.items.length) return
        // added after what is on screen; what changed meanwhile (an edit, a reaction) made again on top
        set((s) => (s.timeline?.roomId === roomId && !s.timeline.newerCursor ? { timeline: replayed(s, w.changes, { timeline: { ...s.timeline, messages: mergeMessages(s.timeline.messages, page.items) } }).timeline } : {}))
      } catch (error) {
        if (gen !== timelineGen || get().openRoomId !== roomId) return
        // no longer mine (taken out, the room closed): nothing of it stays on screen, the page says it is not there
        if (isApiError(error, 'not_found') || isApiError(error, 'forbidden')) set({ timeline: { roomId, messages: [], nextCursor: null, loading: false, error } })
        // else what is on screen stays (the events keep it current; a reconnect that could not resume reads it again)
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
      // the root as the timeline has it already, and the replies as this window last showed them (a room I am still
      // in): shown at once while the newest page loads
      const kept = get().rooms.some((r) => r.id === roomId) ? keptThreads.get(key) : undefined
      keptThreads.delete(key)
      const root = (get().timeline?.roomId === roomId ? get().timeline!.messages.find((m) => m.id === rootId) : undefined) ?? kept?.root ?? null
      set((s) => ({ threadViews: { ...s.threadViews, [key]: { roomId, rootId, root, replies: kept?.replies ?? [], nextCursor: kept?.nextCursor ?? null, loading: true, error: null, holders: 1 } } }))
      void get().loadThread(roomId, rootId)
    },

    closeThread(roomId, rootId) {
      const key = placeKey(roomId, rootId)
      const cur = get().threadViews[key]
      if (!cur) return
      if (cur.holders > 1) return set((s) => ({ threadViews: { ...s.threadViews, [key]: { ...cur, holders: cur.holders - 1 } } }))
      // the last panel: a read still on its way is dropped; what it showed is kept for a while (keptThreads)
      threadGens.delete(key)
      // (only one page of replies: the newest page read when it opens again replaces them, so more would shrink)
      if (cur.root && !cur.error && !cur.loading && cur.replies.length <= ROOM_PAGE) {
        keptThreads.delete(key)
        keptThreads.set(key, { root: cur.root, replies: cur.replies, nextCursor: cur.nextCursor })
        if (keptThreads.size > KEPT_THREADS) keptThreads.delete(keptThreads.keys().next().value!)
      }
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
      // read on screen at once: the thread's news mark, and the room's count of followed threads with news (the
      // server's room follows). Put back: as they were before the first read still on its way (the room is read again
      // for the exact count)
      const k = threadReadKey(roomId, rootId)
      const snap = (optimisticPending(k) && threadSnaps.get(k)) || (() => {
        const room = get().rooms.find((r) => r.id === roomId)
        return { had: !!findMessage(get(), roomId, rootId)?.thread?.newReplies, before: room ? { threadsUnread: room.threadsUnread, mentioned: room.mentioned, nextThreadId: room.nextThreadId } : null }
      })()
      threadSnaps.set(k, snap)
      const { had, before } = snap
      const r = await optimistic<boolean, RoomThreadReadState>({
        key: k,
        from: false,
        to: true,
        show: (read) => {
          if (!had) return
          patchMessages((s) => {
            const now = findMessage(s, roomId, rootId)
            return now?.thread && now.thread.newReplies !== !read ? withThreadSummary(s, roomId, rootId, { ...now.thread, newReplies: !read }) : s
          })
          if (before) set((s) => ({ rooms: s.rooms.map((x) => (x.id !== roomId ? x : read ? { ...x, threadsUnread: Math.max(0, before.threadsUnread - 1), ...(x.nextThreadId === rootId ? { nextThreadId: null } : {}) } : { ...x, ...before })) }))
        },
        send: () => api.call(API.markRoomThreadRead, { params: { id: roomId, messageId: rootId }, body: { seq } }),
        settle: (reply) => set((s) => withRoom(s, keepPending(s, reply.room))),
        failText: false,
      })
      if (!optimisticPending(k)) threadSnaps.delete(k)
      // not read: the room is read again for the exact count. The same place is not asked again until the thread opens
      // again or the connection comes back (asking at once would repeat while the server says no: the news mark is back)
      if (!r.ok && r.newest) void get().fetchRoom(roomId).catch(() => {})
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
      const p: PendingSend = { clientMessageId: uuidv7(), body: input.body, mentions: input.mentions, ...(input.mentionsAll ? { mentionsAll: true } : {}), files: input.files, threadRootId: input.threadRootId ?? null, alsoInRoom: !!input.threadRootId && !!input.alsoInRoom, ...(input.showMessages?.length ? { showMessages: input.showMessages } : {}), state: 'sending', createdAt: new Date().toISOString() }
      setPending(roomId, (list) => [...list, p])
      void post(roomId, p)
      // sent from a window around an older message: back to the newest, where it goes
      const tl = get().timeline
      if (!p.threadRootId && tl?.roomId === roomId && tl.newerCursor) void get().loadNewest(roomId)
    },

    retry(roomId, clientMessageId) {
      const p = get().pending[roomId]?.find((x) => x.clientMessageId === clientMessageId)
      if (!p || p.state === 'sending') return
      setPending(roomId, (list) => list.map((x) => (x.clientMessageId === clientMessageId ? { ...x, state: 'sending', error: undefined, restored: undefined } : x)))
      // the same client id: a send the server did get before the failure comes back as that message, not a second one
      void post(roomId, { ...p, state: 'sending' })
    },

    discard(roomId, clientMessageId) {
      setPending(roomId, (list) => list.filter((x) => x.clientMessageId !== clientMessageId))
    },

    async edit(roomId, messageId, body, mentions, mentionsAll) {
      const was = findMessage(get(), roomId, messageId)
      const textOf = (m: RoomMessage): EditedText => ({ body: m.body, mentions: m.mentions, mentionsAll: m.mentionsAll, editedAt: m.editedAt })
      const r = await optimistic<EditedText | null, RoomMessage>({
        key: editKey(roomId, messageId),
        from: was ? textOf(was) : null,
        to: { body, mentions, mentionsAll: mentionsAll || undefined, editedAt: new Date().toISOString() },
        // the text wherever the message shows (patchMessages: a page read on its way gets it too)
        show: (text) => {
          if (!text) return
          patchMessages((s) => {
            const now = findMessage(s, roomId, messageId)
            if (!now || now.deletedAt) return s
            const { mentionsAll: _was, ...rest } = now
            return withUpdatedMessage(s, roomId, { ...rest, ...text, ...(text.mentionsAll ? { mentionsAll: true } : {}) })
          })
        },
        send: () => api.call(API.editRoomMessage, { params: { id: roomId, messageId }, body: { body, mentions, ...(mentionsAll ? { mentionsAll: true } : {}) } }),
        confirmed: textOf,
        settle: (m) => patchMessages((s) => withUpdatedMessage(s, roomId, m)),
      })
      return r.ok || !r.newest
    },

    async remove(roomId, messageId) {
      await api.call(API.deleteRoomMessage, { params: { id: roomId, messageId } })
      // the room.message.updated event says the same; show it at once
      const m = findMessage(get(), roomId, messageId)
      if (m) {
        const { reactions: _r, linkPreviews: _l, ...rest } = m
        patchMessages((s) => withUpdatedMessage(s, roomId, { ...rest, body: '', files: [], mentions: [], deletedAt: new Date().toISOString() }))
      }
    },

    async hidePreview(roomId, messageId, linkedMessageId) {
      const m = findMessage(get(), roomId, messageId)
      // gone from the screen at once; the server's message (and its room.message.updated) says the same
      if (m?.linkPreviews) patchMessages((s) => withUpdatedMessage(s, roomId, { ...m, linkPreviews: m.linkPreviews!.map((p) => (p.messageId === linkedMessageId ? { ...p, removed: true as const, body: '', files: { count: 0 } } : p)) }))
      try {
        const next = await api.call(API.hideRoomLinkPreview, { params: { id: roomId, messageId }, body: { linkedMessageId } })
        patchMessages((s) => withUpdatedMessage(s, roomId, next))
      } catch (e) {
        if (m) patchMessages((s) => withUpdatedMessage(s, roomId, m))
        toast({ level: 'error', text: errorText(e, currentLocale(), t('error.network')) })
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
      // the badge goes at once: read to the room's end, nothing is left (a followed thread's mention stays, as the
      // server keeps it); read to a place before it, the count waits for the server
      const place = (r: Room | undefined): ReadPlace => ({ lastReadSeq: r?.lastReadSeq ?? 0, unreadCount: r?.unreadCount ?? 0, mentioned: r?.mentioned ?? false })
      const end = !!room && seq >= room.lastSeq
      const r = await optimistic<ReadPlace, RoomReadState>({
        key: readKey(roomId),
        from: place(room),
        to: room ? { lastReadSeq: Math.max(room.lastReadSeq, seq), unreadCount: end ? 0 : room.unreadCount, mentioned: end ? room.threadsUnread > 0 && room.mentioned : room.mentioned } : place(room),
        show: (p) => set((s) => ({ rooms: s.rooms.map((x) => (x.id === roomId ? { ...x, ...p } : x)) })),
        send: () => api.call(API.markRoomRead, { params: { id: roomId }, body: { seq } }),
        confirmed: (reply) => ({ lastReadSeq: reply.lastReadSeq, unreadCount: reply.unreadCount, mentioned: reply.mentioned ?? false }),
        settle: (reply) => set((s) => withReadState(s, roomId, reply)),
        failText: false,
      })
      // not read: put back as it was, and the room is read again for what came meanwhile. The same place is not asked
      // again until a newer message, the room opening again or the connection coming back (asking at once would repeat
      // while the server says no: the badge is back)
      if (!r.ok && r.newest) void get().fetchRoom(roomId).catch(() => {})
    },

    async setMuted(roomId, muted) {
      const room = await api.call(API.updateRoom, { params: { id: roomId }, body: { muted } })
      set((s) => withRoom(s, room))
    },

    async setNotifyLevel(roomId, level) {
      // on screen at once (the bell, the ticked choice, a grey badge at 끄기); a failure puts it back and says so
      await optimistic<RoomNotifyLevel | null, Room>({
        key: notifyKey(roomId),
        from: ownLevel(get().rooms.find((r) => r.id === roomId)),
        to: level,
        show: (own) => set((s) => ({ rooms: s.rooms.map((r) => (r.id === roomId ? withNotifyLevel(r, own) : r)) })),
        send: () => api.call(API.updateRoom, { params: { id: roomId }, body: { notifyLevel: level } }),
        confirmed: (room) => ownLevel(room),
        settle: (room) => set((s) => withRoom(s, keepPending(s, room))),
      })
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
      const next = name?.trim() || null
      // on screen at once (the header, the list, the members dialog); a failure puts the old name back and says so
      const r = await optimistic<string | null, Room>({
        key: nameKey(roomId),
        from: get().rooms.find((r) => r.id === roomId)?.name ?? null,
        to: next,
        show: (n) => set((s) => ({ rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, name: n } : r)) })),
        send: () => api.call(API.updateRoom, { params: { id: roomId }, body: { name: next } }),
        confirmed: (room) => room.name,
        settle: (room) => set((s) => withRoom(s, keepPending(s, room))),
      })
      return r.ok || !r.newest
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
        forgetRoomOnDevice(roomId)
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
      // on screen at once; a failure puts it back and says so (lib/optimistic.ts)
      await optimistic<string | undefined, Room>({
        key: pinKey(roomId),
        from: get().rooms.find((r) => r.id === roomId)?.pinnedAt,
        to: pinned ? new Date().toISOString() : undefined,
        show: (at) => set((s) => ({ rooms: s.rooms.map((r) => (r.id === roomId ? withPin(r, at) : r)) })),
        send: () => (pinned ? api.call(API.pinRoom, { params }) : api.call(API.unpinRoom, { params })),
        confirmed: (room) => room.pinnedAt,
        settle: (room) => set((s) => withRoom(s, room)),
      })
    },

    async removeMember(roomId, userId) {
      await api.call(API.removeRoomMember, { params: { id: roomId, userId } })
      set((s) => (s.members[roomId] ? { members: { ...s.members, [roomId]: s.members[roomId]!.filter((m) => m.user.id !== userId) } } : {}))
    },

    takeReturned(key) {
      set((s) => ({ returned: omit(s.returned, key) }))
    },

    async shareAnswer(chatId, messageId, body) {
      const r = await api.call(API.shareAnswerToRoom, { params: { id: chatId, messageId }, body })
      if (r.status === 'sent') patchMessages((s) => withMessage(s, body.roomId, r.message, myId()))
      return r
    },

    forgetKept() {
      const open = get().openRoomId
      if (open) markUnsure(open)
      // the kept threads may have missed changes as well: they open from the server again
      keptThreads.clear()
      set({ kept: {} })
    },

    async resync() {
      // the events in between are lost: the rooms left a moment ago may have missed some, so they are read again when
      // opened, as the first time; so is the open one when it is left before its newest page is read again
      get().forgetKept()
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
        await Promise.all([get().loadNewest(open), ...members, ...threads])
      } else await Promise.all([...members, ...threads])
    },

    handleEvent(ev) {
      // a kept thread this changes opens from the server next time
      if (keptThreads.size) {
        if (ev.type === 'room.message' || ev.type === 'room.message.updated') forgetKeptThread(ev.data.roomId, ev.data.message.id, ev.data.message.threadRootId)
        else if (ev.type === 'room.reactions') forgetKeptThread(ev.data.roomId, ev.data.messageId)
        else if (ev.type === 'room.thread') forgetKeptThread(ev.data.roomId, ev.data.rootId)
      }
      switch (ev.type) {
        case 'room.message': {
          const { roomId, message } = ev.data
          const known = get().rooms.some((r) => r.id === roomId)
          patchMessages((s) => withMessage(s, roomId, message, myId()))
          // a room I was just added to whose "added" did not reach this window: its counts come from the server
          if (!known && get().loaded) void get().fetchRoom(roomId).catch(() => {})
          return
        }
        case 'room.message.updated':
          // my edit of it still on its way: the screen has the newer text, the edit's own answer decides (a delete
          // still goes through)
          if (!ev.data.message.deletedAt && optimisticPending(editKey(ev.data.roomId, ev.data.message.id))) return
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
            forgetKeptThreads(roomId)
            const wasOpen = get().openRoomId === roomId
            set((s) => ({ ...withoutRoom(s, roomId), members: omit(s.members, roomId), pending: omit(s.pending, roomId), side: omit(s.side, roomId), ...(wasOpen ? { openRoomId: null } : {}) }))
            useSideChats.getState().drop(roomId)
            forgetRoomOnDevice(roomId)
            if (wasOpen) {
              if (!leaving.has(roomId)) toast({ level: 'info', text: t('rooms.removed') })
              navigateTo('/rooms')
            }
            return
          }
          set((s) => withRoom(s, keepPending(s, room)))
          if (change === 'members') {
            memberReads.delete(roomId)
            // (kept after leaving it, it is read again as the first time: the events do not say whose reactions went)
            set((s) => ({ members: omit(s.members, roomId), kept: omit(s.kept, roomId) }))
            // someone joined or left: the member list, and the reactions they took with them (in place: the reader keeps
            // their place)
            if (get().openRoomId === roomId) {
              markUnsure(roomId)
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
      threadSnaps.clear()
      leaving.clear()
      unsure.clear()
      memberReads.clear()
      roomDrafts.clear()
      roomDraftMentions.clear()
      restoredUnsent.clear()
      goneHere.clear()
      goneElsewhere.clear()
      useSideChats.getState().reset()
      timelineGen++
      threadGens.clear()
      keptThreads.clear()
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
  if (pending === s.pending) return
  for (const [roomId, list] of Object.entries(s.pending)) for (const p of list) if (!pending[roomId]?.includes(p)) goneHere.add(p.clientMessageId)
  useRooms.setState({ pending })
})

// The sends on their way or not sent, kept on this device per room as they change (keptUnsent): closing the app (or a
// reload) does not lose them. Sent, let go or settled: gone from there too. A sign-out empties the store and the device.
// What the store holds now, not the listener's own arguments: the listener above may have settled a send since.
let keptPending: Record<string, PendingSend[]> = {}
useRooms.subscribe(() => {
  const now = useRooms.getState().pending
  if (now === keptPending) return
  const before = keptPending
  keptPending = now
  if (!myId()) return
  for (const roomId of new Set([...Object.keys(now), ...Object.keys(before)])) {
    const list = now[roomId]
    if (list === before[roomId]) continue
    // a room this page has not touched yet (gone from the list: forgetRoomOnDevice; all of them after a reset) keeps
    // what the device has
    if (!restoredUnsent.has(roomId)) continue
    const left = new Set((list ?? []).map((p) => p.clientMessageId))
    for (const p of before[roomId] ?? []) if (!left.has(p.clientMessageId)) goneHere.add(p.clientMessageId)
    keepUnsent(roomId, list)
  }
})

// another tab of mine changed what this device keeps
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => onDeviceChange(e.key, e.newValue))
}
