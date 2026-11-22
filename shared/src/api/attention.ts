// The one count n (docs/DECISIONS.md "Session markers"): the AI chats that need me and the rooms that want me, each
// once. Pure: no stores, no database. The page counts with it (web/src/lib/sessionMarkers.ts: the tab title, the Mac
// Dock, an installed web app's icon, the phone app's icon while it is open) and the server counts the same for a phone
// push's badge (server/src/notifications/push-badge.ts), so the icon shows one number whichever set it last.
import type { Chat } from './entities'
import type { Room } from './rooms'

export type MarkerKind = 'ask' | 'running' | 'new'
/** why: the first line of the hover peek and the row's label */
export type MarkerReason = 'card' | 'error' | 'paused' | 'running' | 'queued' | 'new' | 'message'
/** `count`: a chat shared with people, its unread messages (the row shows the number, as a group chat's) */
export interface Marker { kind: MarkerKind; reason: MarkerReason; count?: number; mention?: boolean }

export type MarkedChat = Pick<Chat, 'runState' | 'waiting' | 'unseen' | 'lastOutcome'> & Partial<Pick<Chat, 'unreadCount' | 'mentioned'>>
/** How this window sees a chat: `here`, it is on screen and the window is visible; `card`, a card of it is open in this
 * window (a card one desktop window shows alone is in no list). */
export interface MarkerView { here?: boolean; card?: boolean }

/** The chat's one marker (null: nothing). */
export function markerOf(c: MarkedChat, v: MarkerView = {}): Marker | null {
  if (c.waiting || v.card) return { kind: 'ask', reason: 'card' }
  // a chat shared with people: messages of others I have not read (docs/decisions/20261122-shared-chat-new-message-notices.md),
  // their number before the ring of an answer running (someone's message there starts one: the number is the news)
  if (c.unreadCount && c.unseen && !v.here) return { kind: 'new', reason: 'message', count: c.unreadCount, ...(c.mentioned ? { mention: true } : {}) }
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
 * reads, the server's phone icon number included, so they cannot drift apart. A row goes by the room's own timeline, as
 * in Slack (docs/decisions/20261119-room-unread-after-read.md): a thread I follow with new replies does not make it
 * bold or add to its number (the root's dot and the room's thread mark show it, and its notices), so a room read to its
 * end is plain again; only a followed reply that mentions me shows on the row ("@"):
 * - `bold`: an unread message of the timeline, or an unread mention, at every level.
 * - `mention`: one of the unread messages (or followed replies) mentions me: the row's "@".
 * - `number`: the row's number. At 모든 메시지 every unread message of the timeline. At 멘션만 (a team room or the
 *   everyone room at its default, or a level I picked) plain messages add nothing, as in Slack, and once a message
 *   mentions me all of them (the row shows "@" then). At 끄기 the unread count, grey.
 * - `quiet`: my level is 끄기 (muted, or my default "nothing"): its badge is grey and it adds to no total.
 * - `counts`: it adds to the totals (the 대화 count on the rail and the phone tab bar, a folder's pill): not quiet, and a
 *   number or a mention. Hiding is the caller's: a hidden room shows nowhere.
 * An older server without levels: muted is 끄기, DMs and group chats are 모든 메시지, team rooms and the everyone room
 * 멘션만. */
export interface RoomCounts { bold: boolean; mention: boolean; number: number; quiet: boolean; counts: boolean }
export type CountedRoomFields = Pick<Room, 'kind' | 'unreadCount' | 'muted'> & Partial<Pick<Room, 'threadsUnread' | 'mentioned' | 'notify'>>
export function roomCounts(r: CountedRoomFields): RoomCounts {
  const level = levelOf(r)
  const quiet = level === 'off'
  // (`mentioned` covers a followed reply too: the server's word, true only while something it covers is unread)
  const mention = roomUnread(r) > 0 && !!r.mentioned
  if (r.unreadCount <= 0 && !mention) return { bold: false, mention: false, number: 0, quiet, counts: false }
  const number = level === 'mentions' && !mention ? 0 : r.unreadCount
  return { bold: true, mention, number, quiet, counts: !quiet && (mention || number > 0) }
}

/** Does this room want me (docs/DECISIONS.md "Session markers"): the same rule as its row (roomCounts `counts`,
 * docs/decisions/20261119-room-unread-after-read.md): an @mention (in a thread I follow too), or a message of the
 * timeline in a room at 모든 메시지 (by default: DMs and group chats). Nothing from a room at 끄기 or one I hid; plain
 * unread messages in a room at 멘션만 only make the row bold, and a followed thread's reply without a mention adds to no
 * number (it is in 멘션·스레드 and under its root), as in Slack. Only such a room adds to the one count n (the tab title,
 * the Dock, the phone icon; how much: attentionCount), so the icon never shows a number with nothing marked in the list. */
export function roomWantsMe(r: CountedRoomFields & Pick<Room, 'mentioned'> & Partial<Pick<Room, 'hidden'>>): boolean {
  // a room I hid wants nothing of me: whatever is for me brings it back first (the server decides it)
  return !r.hidden && roomCounts(r).counts
}

/** Is a new message of this room still worth the desktop app's notice: it wants me (roomWantsMe), or it is a reply in a
 * thread I follow with "내가 참여한 스레드의 답글" on (`threadReplies`), still unread. Notices only: no number. */
export function roomNoticeWanted(r: CountedRoomFields & Pick<Room, 'mentioned'> & Partial<Pick<Room, 'hidden'>>, threadReplies = false): boolean {
  if (roomWantsMe(r)) return true
  return !r.hidden && levelOf(r) !== 'off' && threadReplies && (r.threadsUnread ?? 0) > 0
}

/** The room has unread messages (or followed replies) and I neither hid it nor turned it off (끄기: its own level, or my
 * default "nothing"): the Mac Dock's dot while nothing wants me (docs/DECISIONS.md "The Dock's dot for unread rooms"). */
export function roomLightsDot(r: CountedRoomFields & Partial<Pick<Room, 'hidden'>>): boolean {
  return !r.hidden && roomUnread(r) > 0 && levelOf(r) !== 'off'
}

type CountedChat = MarkedChat & Pick<Chat, 'id'>
type CountedRoom = Parameters<typeof roomWantsMe>[0]
/** The one count n: the AI chats showing "?" or a dot (each once: a chat that ended twice counts once), and the unread
 * messages of the rooms that want me (roomWantsMe: by my level for the room, by default a DM or group chat message, an
 * @mention, in a thread too): a room at 모든 메시지 (a DM or group chat by default) by its row's number (roomCounts
 * `number`; at least 1 for a mention in a thread only), as Slack's and KakaoTalk's app icons count messages
 * (docs/decisions/20261120-push-every-message.md: before, five DMs from one person showed 1); a room at 멘션만 (a team
 * room or the everyone room by default) only 1, as Slack counts a channel's mention and not its plain messages: its row
 * shows every unread message once one mentions me, so one "@전체" in a busy everyone room would put hundreds on every
 * member's icon after one push (review of #108, finding 1). `ask`: any of
 * the chats is a "?"; `chats` and `chatAsk`: the AI chats' part of it (the mark on 트리나 in the rail and the phone tabs).
 * `unread`: some other room has unread messages n does not count, in a room I did not turn off or hide (roomLightsDot:
 * a plain message in a team room at its default), the app icon's dot while n is 0 (iconBadge). `here`: the chat on
 * screen in a visible window; `cards`: the chats with a card open in this window. `mentions`: my unread thread mentions
 * under the AI chats' answers (each mentioned thread once, the 프로젝트 list's counts), added to n as a room's mention is
 * (never to `chats`: 트리나's mark is the AI's). */
export function attentionCount(chats: readonly CountedChat[], rooms: readonly CountedRoom[], o: { here?: string | null; cards?: ReadonlySet<string>; mentions?: number } = {}): { n: number; ask: boolean; chats: number; chatAsk: boolean; unread: boolean } {
  let chatsN = 0, chatAsk = false
  for (const c of chats) {
    const m = markerOf(c, { here: c.id === o.here, card: o.cards?.has(c.id) })
    if (!needsMe(m)) continue
    // a chat shared with people counts its unread messages, as a group chat in a room does (push-every-message)
    chatsN += m!.count ?? 1
    if (m!.kind === 'ask') chatAsk = true
  }
  let n = chatsN + Math.max(0, Math.floor(o.mentions ?? 0)), unread = false
  for (const r of rooms) {
    if (roomWantsMe(r)) n += levelOf(r) === 'all' ? Math.max(1, roomCounts(r).number) : 1
    else if (roomLightsDot(r)) unread = true
  }
  return { n, ask: chatAsk, chats: chatsN, chatAsk, unread }
}

/** The most an app icon's number shows (iOS and Android launchers cut longer numbers anyway). */
export const APP_BADGE_MAX = 9999
/** n as a phone icon's number: a whole number from 0 to APP_BADGE_MAX. */
export const appBadgeOf = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(APP_BADGE_MAX, Math.floor(n)) : 0)
