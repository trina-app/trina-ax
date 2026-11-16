// The one count n (docs/DECISIONS.md "Session markers"): the AI chats that need me and the rooms that want me, each
// once. Pure: no stores, no database. The page counts with it (web/src/lib/sessionMarkers.ts: the tab title, the Mac
// Dock, an installed web app's icon, the phone app's icon while it is open) and the server counts the same for a phone
// push's badge (server/src/notifications/push-badge.ts), so the icon shows one number whichever set it last.
import type { Chat } from './entities'
import type { Room } from './rooms'

export type MarkerKind = 'ask' | 'running' | 'new'
/** why: the first line of the hover peek and the row's label */
export type MarkerReason = 'card' | 'error' | 'paused' | 'running' | 'queued' | 'new'
export interface Marker { kind: MarkerKind; reason: MarkerReason }

export type MarkedChat = Pick<Chat, 'runState' | 'waiting' | 'unseen' | 'lastOutcome'>
/** How this window sees a chat: `here`, it is on screen and the window is visible; `card`, a card of it is open in this
 * window (a card one desktop window shows alone is in no list). */
export interface MarkerView { here?: boolean; card?: boolean }

/** The chat's one marker (null: nothing). */
export function markerOf(c: MarkedChat, v: MarkerView = {}): Marker | null {
  if (c.waiting || v.card) return { kind: 'ask', reason: 'card' }
  if (c.runState === 'running') return { kind: 'running', reason: 'running' }
  if (c.runState === 'queued') return { kind: 'running', reason: 'queued' }
  if (!c.unseen || v.here) return null
  if (c.lastOutcome) return { kind: 'ask', reason: c.lastOutcome }
  return { kind: 'new', reason: 'new' }
}

/** A chat that needs me: its row shows "?" or a dot (the spinner does not: it works on its own). */
export const needsMe = (m: Marker | null) => m?.kind === 'ask' || m?.kind === 'new'

/** A room's count for me: its unread messages, and the threads I follow there with replies I have not read (each one
 * thing to read). Thread replies never count otherwise (docs/DECISIONS.md "스레드와 반응"). */
export const roomUnread = (r: Pick<Room, 'unreadCount'> & Partial<Pick<Room, 'threadsUnread'>>) => r.unreadCount + (r.threadsUnread ?? 0)

/** My level for the room (Room.notify.level); an older server without levels: muted is 끄기, DMs and group chats are 모든
 * 메시지, team rooms and the everyone room mentions. */
const levelOf = (r: Pick<Room, 'kind' | 'muted'> & Partial<Pick<Room, 'notify'>>) =>
  r.notify?.level ?? (r.muted ? 'off' : r.kind === 'team' || r.kind === 'all' ? 'mentions' : 'all')

/** What a room shows and adds for me (docs/decisions/20261116-mentions-only-no-count.md), the one rule every surface
 * reads, the server's phone icon number included, so they cannot drift apart:
 * - `bold`: something is unread there (its row's name is bold), at every level.
 * - `mention`: one of the unread messages (or followed replies) mentions me: the row's "@".
 * - `number`: the row's number. At 모든 메시지 every unread message and followed reply. At 멘션만 (a team room or the
 *   everyone room at its default, or a level I picked) plain messages add nothing, as in Slack: only the replies in
 *   threads I follow (their own rule, docs/DECISIONS.md "스레드와 반응"), and once a message mentions me all of them
 *   (the row shows "@" then). At 끄기 the unread count, grey.
 * - `quiet`: my level is 끄기 (muted, or my default "nothing"): its badge is grey and it adds to no total.
 * - `counts`: it adds to the totals (the 대화 count on the rail and the phone tab bar, a folder's pill, the one count
 *   through roomWantsMe): not quiet, and a number or a mention. Hiding is the caller's: a hidden room shows nowhere.
 * An older server without levels: muted is 끄기, DMs and group chats are 모든 메시지, team rooms and the everyone room
 * 멘션만. */
export interface RoomCounts { bold: boolean; mention: boolean; number: number; quiet: boolean; counts: boolean }
export type CountedRoomFields = Pick<Room, 'kind' | 'unreadCount' | 'muted'> & Partial<Pick<Room, 'threadsUnread' | 'mentioned' | 'notify'>>
export function roomCounts(r: CountedRoomFields): RoomCounts {
  const level = levelOf(r)
  const unread = roomUnread(r)
  const quiet = level === 'off'
  if (unread <= 0) return { bold: false, mention: false, number: 0, quiet, counts: false }
  const mention = !!r.mentioned
  const number = level === 'mentions' && !mention ? (r.threadsUnread ?? 0) : unread
  return { bold: true, mention, number, quiet, counts: !quiet && (mention || number > 0) }
}

/** Does this room want me (docs/DECISIONS.md "Session markers"): it counts (roomCounts) and what counts is for me by
 * my switches: an @mention, a reply in a thread I follow ("내가 참여한 스레드의 답글" on), or any message of a room at
 * 모든 메시지 (by default: DMs and group chats). Nothing from a room at 끄기. Plain unread messages in a room at 멘션만 (a
 * team room or the everyone room at its default) only make the row bold, as in Slack. Counted once in the one count n. */
export function roomWantsMe(r: CountedRoomFields & Pick<Room, 'mentioned'> & Partial<Pick<Room, 'hidden'>>, threadReplies = true): boolean {
  // a room I hid wants nothing of me: whatever is for me brings it back first (the server decides it)
  if (r.hidden) return false
  const c = roomCounts(r)
  if (!c.counts) return false
  return c.mention || (threadReplies && (r.threadsUnread ?? 0) > 0) || (levelOf(r) === 'all' && r.unreadCount > 0)
}

/** The room has unread messages (or followed replies) and I neither hid it nor turned it off (끄기: its own level, or my
 * default "nothing"): the Mac Dock's dot while nothing wants me (docs/DECISIONS.md "The Dock's dot for unread rooms"). */
export function roomLightsDot(r: CountedRoomFields & Partial<Pick<Room, 'hidden'>>): boolean {
  const c = roomCounts(r)
  return !r.hidden && c.bold && !c.quiet
}

type CountedChat = MarkedChat & Pick<Chat, 'id'>
type CountedRoom = Parameters<typeof roomWantsMe>[0]
/** The one count n: the AI chats showing "?" or a dot, and the rooms that want me (roomWantsMe: unread messages for me by my
 * level for the room: by default a DM or group chat message, an @mention, a reply
 * in a thread I follow), each once. Chats and rooms, not events: a chat that ended twice counts once. `ask`: any of
 * the chats is a "?"; `chats` and `chatAsk`: the AI chats' part of it (the mark on 트리나 in the rail and the phone tabs).
 * `unread`: some other room has unread messages n does not count, in a room I did not turn off or hide (roomLightsDot:
 * a plain message in a team room at its default), the app icon's dot while n is 0 (iconBadge). `here`: the chat on
 * screen in a visible window; `cards`: the chats with a card open in this window; `threadReplies`: my "replies in
 * threads I follow" switch (the rooms list's alerts). */
export function attentionCount(chats: readonly CountedChat[], rooms: readonly CountedRoom[], o: { here?: string | null; cards?: ReadonlySet<string>; threadReplies?: boolean } = {}): { n: number; ask: boolean; chats: number; chatAsk: boolean; unread: boolean } {
  let chatsN = 0, chatAsk = false
  for (const c of chats) {
    const m = markerOf(c, { here: c.id === o.here, card: o.cards?.has(c.id) })
    if (!needsMe(m)) continue
    chatsN++
    if (m!.kind === 'ask') chatAsk = true
  }
  let n = chatsN, unread = false
  for (const r of rooms) {
    if (roomWantsMe(r, o.threadReplies ?? true)) n++
    else if (roomLightsDot(r)) unread = true
  }
  return { n, ask: chatAsk, chats: chatsN, chatAsk, unread }
}

/** The most an app icon's number shows (iOS and Android launchers cut longer numbers anyway). */
export const APP_BADGE_MAX = 9999
/** n as a phone icon's number: a whole number from 0 to APP_BADGE_MAX. */
export const appBadgeOf = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(APP_BADGE_MAX, Math.floor(n)) : 0)
