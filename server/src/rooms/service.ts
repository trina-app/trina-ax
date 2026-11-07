// Team chat rooms ("대화방" v1, docs/DECISIONS.md "대화방 v1"): what the routes call. Every method takes the signed-in
// person's id from the session and checks their member row first; anyone else, admins included, gets 404.
//
// Events (shared/src/api/ws.ts room.*) go to the room's members only, through the hub's publishEach: a person who is
// not in the room never gets one, and a message only to those who may see it (canSee).
//
// Group chats (kind 'group', docs/DECISIONS.md "그룹 대화와 방 이름"): made by a person with people they pick; any member
// invites or leaves, the manager (store.ts managerOf) and owners or admins in it take someone out; the last one out
// archives it. Rooms.sync never changes who is in one, except that a disabled or deleted account leaves. Not audited,
// like DMs. Renames, invites and leaves are event lines (store.ts): a seq in the room, no unread, notice or AI.
//
// Threads and reactions (docs/DECISIONS.md "스레드와 반응"): send() with threadRootId writes a reply in the thread of a
// message of the timeline; it takes a seq but stays out of the timeline (unless sent to the room too), moves my place in
// the thread, not in the room, and makes me follow the thread (the root's author and people mentioned in it follow it
// too). New replies notify the followers (room notices, as DM messages and mentions do) and mark the root for them;
// nobody else is notified and no badge goes up for them. Reactions (react) take from the sending budget and notify
// nobody. Nobody is told who read what: room.read goes to the reader's own windows only.
//
// Hiding (docs/DECISIONS.md "대화 숨기기"): a member hides a DM, a team room or the everyone room from their own lists
// (setHidden; room_members.hidden_at). Nobody else is told and nothing is audited. It comes back by itself when something
// for them arrives, decided here when the message is stored (notify → unhideFor), so every device agrees; a hidden room
// that stays hidden makes no notice. Opening it again (the app, openDm) shows it again.
//
// The AI (rooms/ai.ts, docs/DECISIONS.md "대화방의 트리나"): send() is the one place a person's message is written,
// and a message that calls the AI ("@트리나 …") starts its turn there, checked before the message is written. The
// answer is the other writer of room_messages (author_kind 'ai', asked_by = who asked); a private preview (visibility
// 'private', visible_to = who asked) is filtered everywhere (canSee / SEE_SQL) and makes no notice (notify()).
import type { Database } from 'bun:sqlite'
import { DEFAULT_LOCALE, inQuietHours, roomAlert, roomLevel, ROOM_GROUP_MAX, type Locale, type RoomAlertSettings, type RoomNotifyLevel, type Room, type RoomMember, type RoomMessage, type RoomReaction, type RoomReactionEmoji, type RoomReadState, type RoomThreadPage, type RoomThreadReadState, type ServerEventInput } from '@mycel/shared/api'
import { decodeCursor, encodeCursor } from '../chat/store'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { notificationsOf, type RoomNoticeEvent } from '../notifications/service'
import { getPreferences, getPreferencesOf } from '../notifications/preferences'
import { cancelPushUser } from '../notifications/push-events'
import { teamTimeZone } from '../admin/settings'
import { alertSettings, ownLevel, setOwnLevel } from './alerts'
import {
  canSee, groupName, isHiddenFor, LIST_SQL, seenSeq, seesFrom, hideable, isOwnerOrAdmin, managerOf, mayRename, roomAuditRef, memberRow, members, membersOut, messageRow, messagesOut, MSG_COLS, reactionsOf, roomOut, roomRow, seeArgs, setRoomPathCheck, sharedAnswerOf,
  lastSeqFor, MENTIONS_SQL, threadable, threadSummary, threadsUnread, TIMELINE_SQL, unreadCount,
  type EventData, type MemberRow, type MessageRow, type RoomRow,
} from './store'
import { roomFilesOf } from './files'
import { historyKinds, openHistories } from './history'
import { countedUnreadIn } from './inbox'
import { roomAiOf, type AskOptions } from './ai'
import { tr } from '../chat/i18n'
import { roomAiCalled, roomMentionAllIn } from '@mycel/shared/api'
import { loadPrincipal } from '../policy/access'
import { authorize, visiblePath } from '../policy/authorize'

const services = new WeakMap<AppContext, Rooms>()
/** Sending: a burst of SEND_BURST messages, then SEND_PER_SECOND a second (per person, all rooms together). More than
 * people type; a script that floods a room gets 429 with the seconds to wait. */
export const SEND_BURST = 20
export const SEND_PER_SECOND = 1
/** New group chats one person may make in an hour, on top of the sending budget each one takes: a chat lands in up to
 * 99 people's lists, so a script cannot fill them. */
export const GROUPS_PER_HOUR = 10
const HOUR_MS = 3_600_000
/** How long one sync works on members still waiting for a room's history (the rest on the next one) */
const HISTORY_BUDGET_MS = 250

export interface SendInput { body: string; replyToId?: string | null; threadRootId?: string | null; alsoInRoom?: boolean; mentions: string[]; mentionsAll?: boolean; fileIds: string[]; clientMessageId: string }
/** Rooms.send's `answer` (never from a request body): the message carries an answer of the sender's own AI chat
 * ("대화방에 보내기", chat/answer-share.ts) that starts at `at` in the body; `cut`: it was cut to fit; `people`: the
 * members who could not read what it used (the person said yes to sending anyway when more than 0), for the audit.
 * The caller took the sending budget's token for the request already (before its check): send takes none more. */
export interface SharedAnswerMark { at: number; cut: boolean; people: number; /** what it used, as checked (chat/answer-share.ts AnswerScopeKept JSON): kept with it for later members (rooms/history.ts) */ scope: string }
/** Nobody: what everyone who sees a message without being in it or following anything sees (one copy for most members). */
const NOBODY: MemberRow = { room_id: '', user_id: '', joined_at: '', last_read_seq: 0, visible_from_seq: 0, history_from_seq: 0, muted: 0, notify_level: null, hidden_at: null }

export class Rooms {
  private lastSync = 0
  private sendBudget = new Map<string, { tokens: number; at: number }>()
  /** the sending budget's clock (tests fix it) */
  clock: () => number = () => Date.now()
  /** when each person made their group chats in the last hour (GROUPS_PER_HOUR) */
  private groupsMade = new Map<string, number[]>()
  constructor(readonly ctx: AppContext) {}
  private get db(): Database { return this.ctx.db }

  // ---------------- access ----------------
  /** The room and my member row, or 404 (not in it, archived, unknown: all the same). */
  mine(userId: string, roomId: string): { room: RoomRow; me: MemberRow } {
    const room = roomRow(this.db, roomId)
    let me = room && !room.archived_at ? memberRow(this.db, roomId, userId) : null
    if (!room || !me) return fail('not_found')
    // a team room or the everyone room whose history is not open to me yet (rooms/history.ts): now, before anything is
    // read; a failure leaves me seeing it from my join on
    if ((me.history_from_seq === null || me.history_recheck) && historyKinds(room.kind)) {
      // (through openHistories: a walk that keeps failing waits before it is tried again)
      try { openHistories(this.ctx, { userId, roomId }) } catch (e) { this.ctx.log.warn('room history not opened', { err: e }) }
      me = memberRow(this.db, roomId, userId) ?? me
    }
    return { room, me }
  }

  // ---------------- events ----------------
  /** Send to the room's members; `build` gets each member's row (null = not to them). */
  fanout(roomId: string, build: (m: MemberRow) => ServerEventInput | null, ms = members(this.db, roomId)) {
    const by = new Map(ms.map((m) => [m.user_id, m]))
    this.ctx.services.realtime.publishEach((uid) => {
      const m = by.get(uid)
      return m ? build(m) : null
    })
  }
  /** `notices`: a new message's notices by recipient (notify()): each one's room.message says theirs (the desktop app
   * tells what the Inbox and push tell, docs/DECISIONS.md "Session markers"). */
  messageEvent(type: 'room.message' | 'room.message.updated', row: MessageRow, notices?: ReadonlyMap<string, RoomNoticeEvent>) {
    this.fanout(row.room_id, (m) => {
      if (!canSee(this.db, row, m)) return null
      const message = messagesOut(this.db, [row], m)[0]!
      const notice = type === 'room.message' ? notices?.get(m.user_id) : undefined
      return type === 'room.message' ? { type, data: { roomId: row.room_id, message, ...(notice ? { notice } : {}) } } : { type, data: { roomId: row.room_id, message } }
    })
  }
  /** room.thread: the root's summary to each member who sees the root. It differs from one person to the next only for
   * those who follow it (new replies) or have a private reply in it (an AI answer's preview): the others get one copy. */
  threadEvent(root: MessageRow) {
    const db = this.db
    const ms = members(db, root.room_id)
    const own = new Set([
      ...(db.query('SELECT user_id FROM room_thread_follows WHERE root_id = ?').all(root.id) as { user_id: string }[]).map((r) => r.user_id),
      ...(db.query("SELECT visible_to FROM room_messages WHERE thread_root_id = ? AND visibility = 'private'").all(root.id) as { visible_to: string }[]).map((r) => r.visible_to),
    ])
    const base = threadSummary(db, root.room_id, root.id, { ...NOBODY, room_id: root.room_id })
    this.fanout(root.room_id, (m) => {
      if (!canSee(this.db, root, m)) return null
      const thread = own.has(m.user_id) ? threadSummary(db, root.room_id, root.id, m) : base
      return { type: 'room.thread', data: { roomId: root.room_id, rootId: root.id, thread } }
    }, ms)
  }
  /** room.reactions: the message's reactions to each member who sees it (only `mine` differs between them). */
  reactionsEvent(m: MessageRow) {
    const base = reactionsOf(this.db, [m.id], NOBODY).get(m.id) ?? []
    const by = new Map<string, Set<string>>()
    for (const r of this.db.query('SELECT emoji, user_id FROM room_reactions WHERE message_id = ?').all(m.id) as { emoji: string; user_id: string }[]) (by.get(r.emoji) ?? by.set(r.emoji, new Set()).get(r.emoji)!).add(r.user_id)
    this.fanout(m.room_id, (x) => canSee(this.db, m, x) ? { type: 'room.reactions', data: { roomId: m.room_id, messageId: m.id, reactions: base.map((r): RoomReaction => ({ ...r, mine: !!by.get(r.emoji)?.has(x.user_id) })) } } : null)
  }
  /** room.updated to each member, with the room as they see it. */
  roomEvent(roomId: string, change: 'added' | 'updated' | 'members', only?: ReadonlySet<string>) {
    const room = roomRow(this.db, roomId)
    if (!room) return
    this.fanout(roomId, (m) => (only && !only.has(m.user_id) ? null : { type: 'room.updated', data: { roomId, change, room: roomOut(this.db, room, m) } }))
  }
  private notifySignal(userId: string) {
    this.ctx.services.realtime.publish(userId, { type: 'notice', data: { level: 'info', code: 'notifications.changed', message: '' } })
  }

  // ---------------- rooms ----------------
  list(userId: string): Room[] {
    // a new account (an invite, the team link) or a group change made outside the admin screens shows here first
    if (this.outOfStep(userId)) this.syncNow()
    else this.syncSoon()
    // my team rooms and everyone room whose history is not open to me yet (rooms/history.ts)
    this.openHistoriesOf(userId)
    const rows = this.db.query(`SELECT r.*, m.user_id, m.joined_at, m.last_read_seq, m.visible_from_seq, m.history_from_seq, m.muted, m.notify_level, m.hidden_at,
      EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = m.user_id) has_hidden FROM rooms r JOIN room_members m ON m.room_id = r.id
      WHERE m.user_id = ? AND r.archived_at IS NULL`).all(userId) as (RoomRow & MemberRow)[]
    const prefs = getPreferences(this.db, userId)
    const out = rows.map((r) => roomOut(this.db, r, { ...r, room_id: r.id }, prefs))
    const rank = (k: Room['kind']) => (k === 'all' ? 0 : k === 'team' ? 1 : 2)
    return out.sort((a, b) => (b.activityAt.localeCompare(a.activityAt)) || rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id))
  }

  get(userId: string, roomId: string): Room {
    const { room, me } = this.mine(userId, roomId)
    return roomOut(this.db, room, me)
  }

  /** The DM with `otherId` (made when there is none yet; not audited). Only an active person other than me. */
  openDm(userId: string, otherId: string): Room {
    if (otherId === userId) fail('validation', undefined, { fields: { 'body.userId': 'yourself' } })
    const other = this.db.query("SELECT id FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(otherId)
    if (!other) fail('not_found')
    const key = [userId, otherId].sort().join('|')
    const find = () => this.db.query("SELECT id FROM rooms WHERE kind = 'dm' AND dm_key = ?").get(key) as { id: string } | null
    let found = find()
    if (!found) {
      const id = newId(), now = nowIso()
      try {
        this.db.transaction(() => {
          this.db.query("INSERT INTO rooms (id, kind, dm_key, created_by, created_at, activity_at) VALUES (?, 'dm', ?, ?, ?, ?)").run(id, key, userId, now, now)
          const add = this.db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
          add.run(id, userId, now)
          add.run(id, otherId, now)
          // not audited: the audit log is the admins' to read, and they must not learn who talks to whom
        })()
      } catch (e) {
        // the other person opened the same DM at the same moment (UNIQUE dm_key): theirs is the one
        if (!find()) throw e
      }
      found = find()!
      this.roomEvent(found.id, 'added')
    } else if (!memberRow(this.db, found.id, userId)) {
      // a DM keeps its two people for good; a row missing here is an inconsistency, not a room to join
      fail('not_found')
    } else {
      // opening a DM I hid: it is in my lists again
      this.unhide(found.id, [userId])
    }
    return this.get(userId, found.id)
  }

  /** A group chat of me and `userIds` (at least two others, active people of this team; not audited). Its name is
   * optional: without one the app shows the other members' names. Everyone in it sees it from its first line. */
  createGroup(userId: string, userIds: readonly string[], name?: string | null, locale: Locale = 'en'): Room {
    const others = [...new Set(userIds)].filter((id) => id !== userId)
    if (others.length < 2) fail('validation', undefined, { fields: { 'body.userIds': 'at least two other people' } })
    if (others.length + 1 > ROOM_GROUP_MAX) fail('validation', undefined, { fields: { 'body.userIds': `at most ${ROOM_GROUP_MAX} people` } })
    this.assertActive(others)
    // it lands in up to 99 people's lists: the same budget as sending, and at most GROUPS_PER_HOUR an hour
    const t = Date.now()
    const made = (this.groupsMade.get(userId) ?? []).filter((x) => x > t - HOUR_MS)
    if (made.length >= GROUPS_PER_HOUR) {
      const wait = Math.max(1, Math.ceil((made[0]! + HOUR_MS - t) / 1000))
      fail('rate_limited', tr('roomGroupLimit', locale, { n: String(GROUPS_PER_HOUR), minutes: String(Math.ceil(wait / 60)) }), { retryAfter: wait })
    }
    this.takeSendToken(userId)
    made.push(t)
    this.groupsMade.set(userId, made)
    const id = newId(), now = nowIso()
    this.db.transaction(() => {
      this.db.query("INSERT INTO rooms (id, kind, created_by, created_at, activity_at, name) VALUES (?, 'group', ?, ?, ?, ?)").run(id, userId, now, now, name?.trim() || null)
      const add = this.db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      for (const u of [userId, ...others]) add.run(id, u, now)
      this.eventLine(id, userId, { type: 'created', userIds: others }, now)
      // not audited: the audit log is the admins' to read, and they must not learn who talks to whom
    })()
    this.roomEvent(id, 'added')
    return this.get(userId, id)
  }

  /** What alerts me besides each room's level (GET /api/rooms `alerts`): thread replies, quiet hours, the time zone. */
  alerts(userId: string): RoomAlertSettings {
    return alertSettings(this.db, getPreferences(this.db, userId))
  }

  /** My level for the room (notifyLevel; null: my default; the older apps' muted: true is 'off', false brings 'off' back
   * to my default) and the room's own name (mayRename: else 403). A name change is an event line. */
  update(userId: string, roomId: string, b: { muted?: boolean; notifyLevel?: RoomNotifyLevel | null; name?: string | null }): Room {
    const { room, me } = this.mine(userId, roomId)
    if (b.name !== undefined) this.rename(userId, room, b.name)
    const level = b.notifyLevel !== undefined ? b.notifyLevel : b.muted === true ? 'off' : b.muted === false ? (ownLevel(me) === 'off' ? null : ownLevel(me)) : undefined
    if (level !== undefined) {
      setOwnLevel(this.db, roomId, userId, level)
      this.roomEvent(roomId, 'updated', new Set([userId]))
      // a push of this room that waits or is on its way is checked again (rooms/alerts.ts noticeWanted)
      cancelPushUser(this.ctx, userId)
    }
    return this.get(userId, roomId)
  }

  setMuted(userId: string, roomId: string, muted: boolean): Room {
    return this.update(userId, roomId, { muted })
  }

  /** Hide the room from my own lists, or show it again (docs/DECISIONS.md "대화 숨기기"). A DM, a team room or the
   * everyone room: a group chat is left instead (403 to hide one; showing one is nothing to do). The same again changes
   * nothing. Nobody else is told; my windows and devices get the room (room.updated). Not audited. */
  setHidden(userId: string, roomId: string, hidden: boolean): Room {
    const { room, me } = this.mine(userId, roomId)
    if (hidden && !hideable(room.kind)) fail('forbidden')
    if (hidden && !me.hidden_at) {
      this.db.query('UPDATE room_members SET hidden_at = ? WHERE room_id = ? AND user_id = ? AND hidden_at IS NULL').run(nowIso(), roomId, userId)
      this.roomEvent(roomId, 'updated', new Set([userId]))
      // a push of this room that waits or is on its way is checked again: a hidden room pushes nothing (alerts.ts)
      cancelPushUser(this.ctx, userId)
      // its rows leave the Inbox (rooms/inbox.ts): when one counted, the count is read again
      if (countedUnreadIn(this.db, userId, roomId)) this.notifySignal(userId)
    } else if (!hidden) this.unhide(roomId, [userId])
    return this.get(userId, roomId)
  }

  /** These members' hidden mark goes (those who had one get the room in all their windows, unless `publish` is false:
   * the caller sends it). Returns who had one. */
  unhide(roomId: string, userIds: readonly string[], publish = true): Set<string> {
    const back = new Set<string>()
    if (!userIds.length) return back
    const ids = [...new Set(userIds)]
    for (const r of this.db.query(`UPDATE room_members SET hidden_at = NULL WHERE room_id = ? AND hidden_at IS NOT NULL AND user_id IN (${ids.map(() => '?').join(',')}) RETURNING user_id`).all(roomId, ...ids) as { user_id: string }[]) back.add(r.user_id)
    if (publish && back.size) this.roomEvent(roomId, 'updated', back)
    // its rows are in the Inbox again (rooms/inbox.ts): when one counts, the count is read again
    for (const u of back) if (countedUnreadIn(this.db, u, roomId)) this.notifySignal(u)
    return back
  }

  /** '' or null: back to the server's name; a team room given its group's own name follows the group again. Team rooms
   * and the everyone room: audited (room.rename), as their other changes are; a group chat not. */
  private rename(userId: string, room: RoomRow, raw: string | null) {
    if (!mayRename(this.db, room, userId)) fail('forbidden')
    let name = raw?.trim() || null
    if (name && room.kind === 'team' && name === groupName(this.db, room)) name = null
    if ((room.name ?? null) === name) return
    // each rename is a line in the room: the same budget as sending
    this.takeSendToken(userId)
    const now = nowIso()
    const line = this.db.transaction(() => {
      this.db.query('UPDATE rooms SET name = ? WHERE id = ?').run(name, room.id)
      if (room.kind !== 'group') audit(this.db, { actor: userId, action: 'room.rename', target: room.id, detail: { kind: room.kind, name } })
      return this.eventLine(room.id, userId, { type: 'renamed', name }, now)
    })()
    this.roomEvent(room.id, 'updated')
    this.messageEvent('room.message', messageRow(this.db, room.id, line)!)
  }

  // ---------------- group chats: who is in one ----------------
  /** Add people to a group chat I am in (any member). Those already in it are skipped; the others see the room from
   * now on (visible_from_seq = the room's last seq, as in a team room) and the line that says they were invited. */
  invite(userId: string, roomId: string, userIds: readonly string[]): Room {
    const { room } = this.mine(userId, roomId)
    // a team room follows its group and the everyone room the team; a DM keeps its two (the app makes a new group chat)
    if (room.kind !== 'group') fail('forbidden')
    const ids = [...new Set(userIds)].filter((id) => id !== userId)
    if (!ids.length) fail('validation', undefined, { fields: { 'body.userIds': 'nobody to add' } })
    this.assertActive(ids)
    const inRoom = new Set(members(this.db, roomId).map((m) => m.user_id))
    const fresh = ids.filter((id) => !inRoom.has(id))
    if (!fresh.length) return this.get(userId, roomId)
    if (inRoom.size + fresh.length > ROOM_GROUP_MAX) fail('validation', undefined, { fields: { 'body.userIds': `at most ${ROOM_GROUP_MAX} people` } })
    this.takeSendToken(userId)
    const now = nowIso()
    const line = this.db.transaction(() => {
      const add = this.db.query('INSERT INTO room_members (room_id, user_id, joined_at, last_read_seq, visible_from_seq) SELECT id, ?, ?, last_seq, last_seq FROM rooms WHERE id = ?')
      for (const u of fresh) add.run(u, now, roomId)
      return this.eventLine(roomId, userId, { type: 'added', userIds: fresh }, now)
    })()
    const added = new Set(fresh)
    this.roomEvent(roomId, 'added', added)
    const r = roomRow(this.db, roomId)!
    this.fanout(roomId, (m) => (added.has(m.user_id) ? null : { type: 'room.updated', data: { roomId, change: 'members', room: roomOut(this.db, r, m) } }))
    this.messageEvent('room.message', messageRow(this.db, roomId, line)!)
    return this.get(userId, roomId)
  }

  /** Leave a group chat (team rooms and the everyone room follow the groups, a DM keeps its two: 403). */
  leave(userId: string, roomId: string): void {
    const { room } = this.mine(userId, roomId)
    if (room.kind !== 'group') fail('forbidden')
    this.dropMembers(room.id, [{ userId, actor: userId, event: { type: 'left' } }])
  }

  /** Take `targetId` out of a group chat: its manager may, and so may an owner or admin who is in it; never oneself
   * (that is leaving). Anyone else in it: 403. */
  removeMember(userId: string, roomId: string, targetId: string): void {
    const { room } = this.mine(userId, roomId)
    if (room.kind !== 'group') fail('forbidden')
    if (targetId === userId) fail('validation', undefined, { fields: { 'params.userId': 'yourself: leave the room instead' } })
    if (managerOf(this.db, room) !== userId && !isOwnerOrAdmin(this.db, userId)) fail('forbidden')
    if (!memberRow(this.db, roomId, targetId)) fail('not_found')
    this.dropMembers(room.id, [{ userId: targetId, actor: userId, event: { type: 'removed', userId: targetId } }])
  }

  /** People out of a group chat at once: their member rows and notices go, each of their windows loses the room (and
   * their replay buffer, so nothing of it is replayed), the others get the line and the new members. The last one out
   * archives the room (rows kept; nobody can read them). */
  private dropMembers(roomId: string, out: { userId: string; actor: string | null; event: EventData }[], inTx = false): { lines: string[]; archived: boolean } {
    const now = nowIso()
    const run = () => {
      const lines: string[] = []
      for (const o of out) {
        this.forgetMember(roomId, o.userId)
        // the maker who leaves (or is taken out, or whose account goes) gives up the manager role for good: invited
        // back, they are a member like the others (store.ts managerOf)
        this.db.query("UPDATE rooms SET created_by = NULL WHERE id = ? AND kind = 'group' AND created_by = ?").run(roomId, o.userId)
      }
      const left = (this.db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ?').get(roomId) as { n: number }).n
      if (!left) {
        this.db.query('UPDATE rooms SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(now, roomId)
        return { lines, archived: true }
      }
      for (const o of out) lines.push(this.eventLine(roomId, o.actor, o.event, now))
      return { lines, archived: false }
    }
    const r = inTx ? run() : this.db.transaction(run)()
    if (!inTx) this.afterDrop(roomId, out.map((o) => o.userId), r)
    return r
  }
  private afterDrop(roomId: string, gone: readonly string[], r: { lines: string[]; archived: boolean }) {
    for (const u of new Set(gone)) {
      roomAiOf(this.ctx).stopFor(roomId, u)
      this.ctx.services.realtime.forgetReplay(u)
      this.ctx.services.realtime.publish(u, { type: 'room.updated', data: { roomId, change: 'removed', room: null } })
    }
    if (r.archived) return
    const room = roomRow(this.db, roomId)
    if (room) this.fanout(roomId, (m) => ({ type: 'room.updated', data: { roomId, change: 'members', room: roomOut(this.db, room, m) } }))
    for (const id of r.lines) this.messageEvent('room.message', messageRow(this.db, roomId, id)!)
  }

  /** Someone is out of a room: their member row, notices, the threads they followed and their reactions there go. */
  private forgetMember(roomId: string, userId: string) {
    // their rows of the room leave the Inbox (rooms/inbox.ts): when one counted, the count is read again
    const counted = countedUnreadIn(this.db, userId, roomId)
    // (and the old answers hidden from them: joining again works them out again, rooms/history.ts)
    for (const t of ['room_members', 'room_notices', 'room_thread_follows', 'room_reactions', 'room_hidden_answers']) this.db.query(`DELETE FROM ${t} WHERE room_id = ? AND user_id = ?`).run(roomId, userId)
    if (counted) this.notifySignal(userId)
  }

  /** Only active accounts of this team; one that is not (disabled, deleted, unknown) refuses the whole request without
   * saying which (the people list already shows who is active). */
  private assertActive(ids: readonly string[]) {
    if (!ids.length) return
    const n = (this.db.query(`SELECT COUNT(*) n FROM users WHERE status = 'active' AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number }).n
    if (n !== ids.length) fail('validation', undefined, { fields: { 'body.userIds': 'not an active person of this team' } })
  }

  /** An event line (store.ts): the room's next seq, written by `actorId` (who did it), inside the caller's transaction.
   * It does not move the room's activity: a rename does not bring a room to the top of the list. */
  private eventLine(roomId: string, actorId: string | null, e: EventData, now: string): string {
    const id = newId()
    const seq = (this.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(roomId) as { last_seq: number }).last_seq
    this.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, mentions, created_at, event)
      VALUES (?, ?, ?, 'user', ?, 'room', '', '[]', ?, ?)`).run(id, roomId, seq, actorId, now, JSON.stringify(e))
    return id
  }

  members(userId: string, roomId: string): RoomMember[] {
    this.mine(userId, roomId)
    return membersOut(this.db, roomId)
  }

  // ---------------- messages ----------------
  messages(userId: string, roomId: string, o: { cursor?: string; limit?: number }) {
    const { me } = this.mine(userId, roomId)
    const cur = decodeCursor(o.cursor, ['s'])
    if (o.cursor && (!cur || !/^\d+$/.test(cur.s))) fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
    const limit = Math.min(200, Math.max(1, o.limit ?? 50))
    // the timeline: replies that stay in their thread are not in it (listThread)
    // an old answer hidden from me is in it as one line (LIST_SQL, messagesOut), never what is in its thread
    const rows = this.db.query(`SELECT ${MSG_COLS} FROM room_messages m WHERE m.room_id = ? AND ${LIST_SQL} AND ${TIMELINE_SQL} ${cur ? 'AND m.seq < ?' : ''} ORDER BY m.seq DESC LIMIT ?`)
      .all(...(cur ? [roomId, ...seeArgs(me), Number(cur.s), limit + 1] : [roomId, ...seeArgs(me), limit + 1])) as MessageRow[]
    const page = rows.slice(0, limit).reverse()
    return { items: messagesOut(this.db, page, me), nextCursor: rows.length > limit && page[0] ? encodeCursor({ s: String(page[0].seq) }) : null }
  }

  /** Send as `userId` (the author is always the signed-in person). Same clientMessageId again: the first message. A
   * message that calls the AI is checked for that first (rooms/ai.ts precheck: a refusal sends nothing), then asks it.
   * With threadRootId it is a reply in that message's thread (see the top of this file).
   * `answer` (chat/answer-share.ts only, never a request's body): the message carries an answer of my own AI chat. It
   * mentions nobody (nor "@전체") and never calls the room's AI, whatever its text says ("@트리나", "@Name" in the answer
   * are the AI's words, not a call), and is neither a reply nor in a thread. */
  send(userId: string, roomId: string, b: SendInput, o: AskOptions = {}, answer?: SharedAnswerMark, carried?: string | null): RoomMessage {
    const { room, me } = this.mine(userId, roomId)
    const again = this.db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE room_id = ? AND author_id = ? AND client_id = ?`).get(roomId, userId, b.clientMessageId) as MessageRow | null
    if (again) return messagesOut(this.db, [again], memberRow(this.db, roomId, userId)!)[0]!
    // a reply goes in a thread or quotes (an older app), never both; "also to the room" is a thread reply's
    if (b.threadRootId && b.replyToId) fail('validation', undefined, { fields: { 'body.replyToId': 'not with threadRootId' } })
    if (b.alsoInRoom && !b.threadRootId) fail('validation', undefined, { fields: { 'body.alsoInRoom': 'only with threadRootId' } })
    if (b.mentionsAll && !answer) this.mayMentionAll(room, userId, b.body, o.locale)
    if (!answer) this.takeSendToken(userId)
    if (b.replyToId) {
      const q = messageRow(this.db, roomId, b.replyToId)
      // an event line is not a message to answer
      if (!q || !canSee(this.db, q, me) || q.event) fail('validation', undefined, { fields: { 'body.replyToId': 'not in this room' } })
    }
    let root: MessageRow | null = null
    if (b.threadRootId) {
      root = messageRow(this.db, roomId, b.threadRootId)
      // the same answer whatever is wrong (not there, not one I see, an event line, a reply itself, deleted, private)
      if (!root || !canSee(this.db, root, me) || !threadable(root) || root.deleted_at) fail('validation', undefined, { fields: { 'body.threadRootId': 'not a message of this room to answer in a thread' } })
    }
    if (answer && (b.threadRootId || b.replyToId || b.fileIds.length || answer.at < 0 || answer.at > b.body.length)) fail('validation')
    const mentions = answer ? [] : this.validMentions(roomId, userId, b.mentions)
    const fileIds = [...new Set(b.fileIds)]
    if (fileIds.length) {
      const n = (this.db.query(`SELECT COUNT(*) n FROM room_files WHERE room_id = ? AND user_id = ? AND message_id IS NULL AND id IN (${fileIds.map(() => '?').join(',')})`).get(roomId, userId, ...fileIds) as { n: number }).n
      if (n !== fileIds.length) fail('validation', undefined, { fields: { 'body.fileIds': 'unknown file' } })
    }
    // "@트리나 …" (a person picked from the list under the same name wins); anything that stops the question stops the send
    const people = mentions.length ? (this.db.query(`SELECT name FROM users WHERE id IN (${mentions.map(() => '?').join(',')})`).all(...mentions) as { name: string }[]).map((r) => r.name) : []
    const ask = !answer && roomAiCalled(b.body, people) ? roomAiOf(this.ctx).precheck(userId, roomId, o) : null
    const now = nowIso(), id = newId()
    // a reply that stays in its thread does not bring the room to the top of the list
    const inTimeline = !root || !!b.alsoInRoom
    let seq = 0
    this.db.transaction(() => {
      seq = (this.db.query(`UPDATE rooms SET last_seq = last_seq + 1${inTimeline ? ', activity_at = ?' : ''} WHERE id = ? RETURNING last_seq`).get(...(inTimeline ? [now, roomId] : [roomId])) as { last_seq: number }).last_seq
      // what it brought in from elsewhere (a shared answer's scope; what an AI app had read: `carried`), for those who
      // join the room later (rooms/history.ts)
      this.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, reply_to_id, mentions, client_id, created_at, thread_root_id, thread_root_seq, also_in_room, mentions_all, answer_at, answer_cut, source_scope)
        VALUES (?, ?, ?, 'user', ?, 'room', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, roomId, seq, userId, b.body, b.replyToId ?? null, JSON.stringify(mentions), b.clientMessageId, now, root?.id ?? null, root?.seq ?? null, root && b.alsoInRoom ? 1 : 0,
        b.mentionsAll && !answer ? 1 : 0, answer ? answer.at : null, answer?.cut ? 1 : 0, answer ? answer.scope : carried ?? null)
      // an answer of my own AI chat: audited without its content or anyone's name; a DM's or group chat's id would let
      // admins see who talks to whom, so only its kind (store.ts roomAuditRef)
      if (answer) audit(this.db, { actor: userId, action: 'room.answer_share', target: id, detail: { ...roomAuditRef(room), people: answer.people, confirmed: answer.people > 0, cut: answer.cut } })
      if (fileIds.length) this.db.query(`UPDATE room_files SET message_id = ? WHERE id IN (${fileIds.map(() => '?').join(',')})`).run(id, ...fileIds)
      // sending in the room means I have seen the room up to here (KakaoTalk): my read position moves to my message;
      // a reply moves my place in its thread instead (the room may be out of sight, on a phone it is)
      if (root) this.follow(root, userId, seq, mentions)
      else this.db.query('UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND user_id = ? AND last_read_seq < ?').run(seq, roomId, userId, seq)
    })()
    if (root) this.markThreadNoticesRead(userId, roomId, root.id, seq)
    else {
      this.readEvent(roomId, userId)
      this.markNoticesRead(userId, roomId, seq)
    }
    const row = messageRow(this.db, roomId, id)!
    this.messageEvent('room.message', row, this.notify(row))
    if (root) this.afterReply(root)
    if (ask) roomAiOf(this.ctx).ask(userId, roomId, row, ask, people)
    return messagesOut(this.db, [row], memberRow(this.db, roomId, userId)!)[0]!
  }

  /** Inside the reply's transaction: its author follows the thread and has read it up to the reply; the root's author
   * (for an AI answer: the person who asked it) follows it from its first reply on (everything after the root is new to
   * them); people mentioned in it who see it follow it from this reply on. Only people in the room now. */
  follow(root: MessageRow, authorId: string | null, seq: number, mentioned: readonly string[] = []) {
    const db = this.db, now = nowIso()
    const ms = new Map(members(db, root.room_id).map((m) => [m.user_id, m]))
    const add = db.query('INSERT OR IGNORE INTO room_thread_follows (root_id, user_id, room_id, last_read_seq, created_at) VALUES (?, ?, ?, ?, ?)')
    const may = (u: string | null): u is string => !!u && !!ms.get(u) && canSee(this.db, root, ms.get(u)!)
    if (may(authorId)) {
      add.run(root.id, authorId, root.room_id, seq, now)
      db.query('UPDATE room_thread_follows SET last_read_seq = ? WHERE root_id = ? AND user_id = ? AND last_read_seq < ?').run(seq, root.id, authorId, seq)
    }
    const owner = root.author_kind === 'ai' ? root.asked_by : root.author_id
    if (may(owner)) add.run(root.id, owner, root.room_id, root.seq, now)
    for (const u of mentioned) if (may(u)) add.run(root.id, u, root.room_id, seq - 1, now)
  }

  /** After a reply came or went: the root's summary to everyone who sees it, and to the followers their room as they see
   * it now (the threads with new replies count in its badge), the reply's author too: their other windows and devices
   * follow their place in the thread. */
  afterReply(root: MessageRow) {
    this.threadEvent(root)
    const followers = new Set((this.db.query('SELECT user_id FROM room_thread_follows WHERE root_id = ?').all(root.id) as { user_id: string }[]).map((r) => r.user_id))
    if (followers.size) this.roomEvent(root.room_id, 'updated', followers)
  }

  /** A message that carries an answer of my own AI chat (sharedAnswer) is not edited: its answer part is the AI's
   * words (409; the app offers no edit there). It can be deleted. */
  edit(userId: string, roomId: string, messageId: string, b: { body: string; mentions: string[]; mentionsAll?: boolean }, locale: Locale = 'en'): RoomMessage {
    const { me } = this.mine(userId, roomId)
    const m = this.own(roomId, messageId, userId, me)
    if (sharedAnswerOf(m)) fail('conflict', tr('roomSharedAnswerEdit', locale), { params: { reason: 'shared_answer' } })
    const mentions = this.validMentions(roomId, userId, b.mentions)
    // "@전체" may be kept or taken out; it is added only by a send, which notifies (an edit notifies nobody)
    if (b.mentionsAll && !m.mentions_all) fail('validation', undefined, { fields: { 'body.mentionsAll': 'only a new message can mention everyone' } })
    if (b.mentionsAll && !roomMentionAllIn(b.body)) fail('validation', undefined, { fields: { 'body.mentionsAll': 'no @everyone mention in the text' } })
    // an edit notifies nobody (only a new message does), so a mention added later is quiet
    this.db.query('UPDATE room_messages SET body = ?, mentions = ?, mentions_all = ?, edited_at = ? WHERE id = ?').run(b.body, JSON.stringify(mentions), b.mentionsAll ? 1 : 0, nowIso(), m.id)
    const row = messageRow(this.db, roomId, messageId)!
    this.messageEvent('room.message.updated', row)
    return messagesOut(this.db, [row], me)[0]!
  }

  /** Delete my own message: its text, mentions and files go; the row stays as "deleted". Its notices go too. */
  remove(userId: string, roomId: string, messageId: string): void {
    const { me } = this.mine(userId, roomId)
    const m = this.removable(roomId, messageId, userId, me)
    const now = nowIso()
    const noticed = this.db.transaction(() => {
      this.db.query("UPDATE room_messages SET body = '', mentions = '[]', mentions_all = 0, deleted_at = ? WHERE id = ?").run(now, m.id)
      // an AI answer's "참고한 파일" go with it, and the reactions on it (a deleted message takes none)
      this.db.query('DELETE FROM room_message_sources WHERE message_id = ?').run(m.id)
      this.db.query('DELETE FROM room_reactions WHERE message_id = ?').run(m.id)
      if (m.author_kind === 'ai' && m.asked_by !== userId) audit(this.db, { actor: userId, action: 'room.ai_delete', target: m.id, detail: roomAuditRef(roomRow(this.db, roomId)!) })
      return [...this.moveRuns(m), ...(this.db.query('DELETE FROM room_notices WHERE source_id = ? AND room_id = ? RETURNING user_id').all(m.id, roomId) as { user_id: string }[]).map((r) => r.user_id)]
    })()
    roomFilesOf(this.ctx).removeForMessage(m.id)
    for (const u of new Set(noticed)) this.notifySignal(u)
    this.messageEvent('room.message.updated', messageRow(this.db, roomId, messageId)!)
    // a reply that goes: its thread has one fewer (the root's summary, the followers' badges)
    const root = m.thread_root_id ? messageRow(this.db, roomId, m.thread_root_id) : null
    if (root) this.afterReply(root)
  }

  /** A deleted message's notices that stand for a run (they held later messages back: rooms/inbox.ts) move to the next
   * message of the run their person may read, so the Inbox keeps the row for the rest; a notice with nothing after it
   * goes with the message (remove). Inside remove's transaction. Returns whose notices moved. */
  private moveRuns(m: MessageRow): string[] {
    const runs = this.db.query('SELECT id, user_id, event_type, last_seq FROM room_notices WHERE source_id = ? AND room_id = ? AND last_seq > ?').all(m.id, m.room_id, m.seq) as { id: string; user_id: string; event_type: string; last_seq: number }[]
    const moved: string[] = []
    for (const n of runs) {
      if (!memberRow(this.db, m.room_id, n.user_id)) continue
      // the next message of the run in the same place: by someone else, for the whole room, and for a mention notice one
      // that mentions them
      const next = this.db.query(`SELECT m.id FROM room_messages m WHERE m.room_id = ? AND m.thread_root_id IS ? AND m.seq > ? AND m.seq <= ?
        AND m.visibility = 'room' AND m.deleted_at IS NULL AND m.event IS NULL AND (m.author_id IS NULL OR m.author_id <> ?) AND (m.author_kind <> 'ai' OR m.asked_by IS NULL OR m.asked_by <> ?)
        AND NOT EXISTS (SELECT 1 FROM room_hidden_answers h WHERE h.room_id = m.room_id AND h.user_id = ? AND h.message_id IN (m.id, m.thread_root_id))
        AND (? = 'room.dm' OR ${MENTIONS_SQL}) ORDER BY m.seq LIMIT 1`).get(m.room_id, m.thread_root_id, m.seq, n.last_seq, n.user_id, n.user_id, n.user_id, n.event_type, n.user_id, n.user_id) as { id: string } | null
      if (next && this.db.query('UPDATE OR IGNORE room_notices SET source_id = ? WHERE id = ?').run(next.id, n.id).changes) moved.push(n.user_id)
    }
    return moved
  }

  // ---------------- threads ----------------
  /** The root of a thread `me` may open: a message of the timeline they see, for the whole room (deleted or not: its
   * replies stay readable). Anything else: 404, the same as a message that is not there. */
  private rootFor(roomId: string, rootId: string, me: MemberRow): MessageRow {
    const root = messageRow(this.db, roomId, rootId)
    if (!root || !canSee(this.db, root, me) || !threadable(root)) return fail('not_found')
    return root
  }

  /** A thread: its root and a page of the replies I can see (the newest `limit`, oldest first; the cursor for older). */
  thread(userId: string, roomId: string, rootId: string, o: { cursor?: string; limit?: number }): RoomThreadPage {
    const { me } = this.mine(userId, roomId)
    const root = this.rootFor(roomId, rootId, me)
    const cur = decodeCursor(o.cursor, ['s'])
    if (o.cursor && (!cur || !/^\d+$/.test(cur.s))) fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
    const limit = Math.min(200, Math.max(1, o.limit ?? 50))
    const rows = this.db.query(`SELECT ${MSG_COLS} FROM room_messages m WHERE m.room_id = ? AND m.thread_root_id = ? AND ${LIST_SQL} ${cur ? 'AND m.seq < ?' : ''} ORDER BY m.seq DESC LIMIT ?`)
      .all(...(cur ? [roomId, root.id, ...seeArgs(me), Number(cur.s), limit + 1] : [roomId, root.id, ...seeArgs(me), limit + 1])) as MessageRow[]
    const page = rows.slice(0, limit).reverse()
    return { root: messagesOut(this.db, [root], me)[0]!, items: messagesOut(this.db, page, me), nextCursor: rows.length > limit && page[0] ? encodeCursor({ s: String(page[0].seq) }) : null }
  }

  /** My place in a thread I follow moves forward to seq (never back); its notices up to there count as read. My own
   * windows get the root's summary and the room's badge; nobody else hears of it. */
  markThreadRead(userId: string, roomId: string, rootId: string, seq: number): RoomThreadReadState {
    const { room, me } = this.mine(userId, roomId)
    const root = this.rootFor(roomId, rootId, me)
    // never past the newest reply I can see: the room's counter (and the thread's other people's previews) are not mine
    // to learn
    const newest = (this.db.query("SELECT MAX(seq) s FROM room_messages WHERE room_id = ? AND thread_root_id = ? AND (visibility = 'room' OR visible_to = ?)").get(roomId, root.id, userId) as { s: number | null }).s
    const to = Math.min(seq, newest ?? root.seq)
    const moved = this.db.query('UPDATE room_thread_follows SET last_read_seq = ? WHERE root_id = ? AND user_id = ? AND last_read_seq < ?').run(to, root.id, userId, to).changes > 0
    this.markThreadNoticesRead(userId, roomId, root.id, to)
    if (moved) {
      this.ctx.services.realtime.publish(userId, { type: 'room.thread', data: { roomId, rootId: root.id, thread: threadSummary(this.db, roomId, root.id, me) } })
      this.roomEvent(roomId, 'updated', new Set([userId]))
    }
    const f = this.db.query('SELECT last_read_seq FROM room_thread_follows WHERE root_id = ? AND user_id = ?').get(root.id, userId) as { last_read_seq: number } | null
    return { lastReadSeq: f?.last_read_seq ?? 0, room: roomOut(this.db, room, memberRow(this.db, roomId, userId)!) }
  }

  // ---------------- reactions ----------------
  /** Put my reaction on a message I can see, or take it off (on: false). The same again changes nothing and costs
   * nothing; a change takes from the sending budget. Event lines, deleted messages and private previews take none.
   * Never a notice, an unread count or anything for the AI. */
  react(userId: string, roomId: string, messageId: string, emoji: RoomReactionEmoji, on: boolean): { reactions: RoomReaction[] } {
    const { me } = this.mine(userId, roomId)
    const m = messageRow(this.db, roomId, messageId)
    if (!m || !canSee(this.db, m, me)) return fail('not_found')
    if (m.event || m.deleted_at || m.visibility !== 'room') fail('validation', undefined, { fields: { 'params.messageId': 'not a message to react to' } })
    const has = !!this.db.query('SELECT 1 FROM room_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(m.id, userId, emoji)
    if (has !== on) {
      this.takeSendToken(userId)
      if (on) this.db.query('INSERT OR IGNORE INTO room_reactions (room_id, message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)').run(roomId, m.id, userId, emoji, nowIso())
      else this.db.query('DELETE FROM room_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(m.id, userId, emoji)
      this.reactionsEvent(m)
    }
    return { reactions: reactionsOf(this.db, [m.id], me).get(m.id) ?? [] }
  }

  /** One token per new message (a resend of the same clientMessageId above costs none) and per reaction change; a
   * shared answer's request takes its own before its check (chat/answer-share.ts). */
  takeSendToken(userId: string) {
    const now = this.clock()
    const b = this.sendBudget.get(userId) ?? { tokens: SEND_BURST, at: now }
    b.tokens = Math.min(SEND_BURST, b.tokens + ((now - b.at) / 1000) * SEND_PER_SECOND)
    b.at = now
    this.sendBudget.set(userId, b)
    if (b.tokens < 1) fail('rate_limited', undefined, { retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / SEND_PER_SECOND)) })
    b.tokens -= 1
  }

  /** What `userId` may delete: their own message; an AI answer they asked for (a private preview of theirs too, which
   * is how they put one away), or any AI answer they can see when they are an owner or admin in the room. */
  private removable(roomId: string, messageId: string, userId: string, me: MemberRow): MessageRow {
    const m = messageRow(this.db, roomId, messageId)
    // my own message (own() decides, also for one hidden from me)
    if (m && m.author_kind !== 'ai' && m.author_id === userId) return this.own(roomId, messageId, userId, me, true)
    if (!m || !canSee(this.db, m, me)) return fail('not_found')
    if (m.author_kind !== 'ai') return this.own(roomId, messageId, userId, me, true)
    const role = (this.db.query('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | null)?.role
    if (m.asked_by !== userId && role !== 'owner' && role !== 'admin') return fail('forbidden')
    if (m.deleted_at) return fail('conflict')
    return m
  }

  /** My own message, and one I can see now: after leaving a group chat and being invited back the messages from before
   * are out of sight, my own too, so not mine to edit or delete either (joining a team room or the everyone room again
   * shows its history, mine included: rooms/history.ts). */
  private own(roomId: string, messageId: string, userId: string, me: MemberRow, forDelete = false): MessageRow {
    const m = messageRow(this.db, roomId, messageId)
    // my own message hidden from me since I joined again (one I shared from my AI chat, or an AI app sent for me, that
    // used something I cannot open now): not mine to read or edit, but mine to take away (its text is not shown)
    const mineHidden = forDelete && !!m && m.author_kind === 'user' && m.author_id === userId && !m.event && seenSeq(m) > seesFrom(me) && isHiddenFor(this.db, m, userId)
    if (!m || (!canSee(this.db, m, me) && !mineHidden)) return fail('not_found')
    // an event line is nobody's message: its author did something, they did not write it
    if (m.author_kind !== 'user' || m.author_id !== userId || m.event) return fail('forbidden')
    if (m.deleted_at) return fail('conflict')
    return m
  }

  /** "@전체" (docs/DECISIONS.md "@전체"): anyone in a group chat, a team room or a DM (there: the other person); in the
   * everyone room only an owner or admin (it reaches the whole team). The text must show it ("@전체" where a mention may
   * start): what notifies is what the message shows. */
  private mayMentionAll(room: RoomRow, userId: string, body: string, locale?: Locale) {
    if (room.kind === 'all' && !isOwnerOrAdmin(this.db, userId)) fail('forbidden', tr('roomMentionAll', locale ?? DEFAULT_LOCALE), { params: { reason: 'room_mention_all' } })
    if (!roomMentionAllIn(body)) fail('validation', undefined, { fields: { 'body.mentionsAll': 'no @everyone mention in the text' } })
  }

  /** The people picked as mentions, kept only when they are in the room (never myself), in the order given. */
  private validMentions(roomId: string, userId: string, ids: readonly string[]): string[] {
    const inRoom = new Set(members(this.db, roomId).map((m) => m.user_id))
    return [...new Set(ids)].filter((id) => id !== userId && inRoom.has(id))
  }

  // ---------------- reading ----------------
  markRead(userId: string, roomId: string, seq: number): RoomReadState {
    const { room, me } = this.mine(userId, roomId)
    const from = Math.max(me.last_read_seq, me.visible_from_seq)
    // never past the newest position of the timeline I can see (Room.lastSeq): the room's own counter moves with replies
    // in threads I cannot see and other people's previews
    const to = Math.min(seq, lastSeqFor(this.db, room.id, me))
    if (to > from) {
      this.db.query('UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND user_id = ? AND last_read_seq < ?').run(to, roomId, userId, to)
      this.readEvent(roomId, userId)
      this.markNoticesRead(userId, roomId, to)
    }
    const now = memberRow(this.db, roomId, userId)!
    return this.readState(roomId, now)
  }

  /** My read position moved: my own windows and devices get it with my badge for the room. Nobody else is told (no
   * read receipts: docs/DECISIONS.md "스레드와 반응"). */
  readEvent(roomId: string, userId: string) {
    const me = memberRow(this.db, roomId, userId)
    if (!me) return
    this.ctx.services.realtime.publish(userId, { type: 'room.read', data: { roomId, ...this.readState(roomId, me) } })
  }
  /** My position, my badge and whether something unread (a message or a followed reply) still mentions me. */
  private readState(roomId: string, me: MemberRow): RoomReadState {
    const unread = unreadCount(this.db, roomId, me)
    return { lastReadSeq: Math.max(me.last_read_seq, me.visible_from_seq), unreadCount: unread.n, mentioned: unread.mentioned || threadsUnread(this.db, roomId, me).mentioned }
  }

  /** My notices of this room's timeline up to `seq` count as read (the inbox and a pending push follow); a thread's
   * own replies are read in the thread (markThreadNoticesRead). */
  markNoticesRead(userId: string, roomId: string, seq: number) {
    // a notice whose run goes on past seq (it held a later message back: last_seq) stays unread: what came after is not
    // read yet, and no other notice stands for it (rooms/inbox.ts)
    const r = this.db.query(`UPDATE room_notices SET read_at = ? WHERE user_id = ? AND room_id = ? AND read_at IS NULL AND (last_seq IS NULL OR last_seq <= ?)
      AND source_id IN (SELECT m.id FROM room_messages m WHERE m.room_id = ? AND m.seq <= ? AND ${TIMELINE_SQL})`).run(nowIso(), userId, roomId, seq, roomId, seq)
    if (r.changes) this.notifySignal(userId)
  }
  /** My notices of the replies in this thread up to `seq` count as read. */
  markThreadNoticesRead(userId: string, roomId: string, rootId: string, seq: number) {
    const r = this.db.query(`UPDATE room_notices SET read_at = ? WHERE user_id = ? AND room_id = ? AND read_at IS NULL AND (last_seq IS NULL OR last_seq <= ?)
      AND source_id IN (SELECT id FROM room_messages WHERE room_id = ? AND thread_root_id = ? AND seq <= ?)`).run(nowIso(), userId, roomId, seq, roomId, rootId, seq)
    if (r.changes) this.notifySignal(userId)
  }

  // ---------------- notices ----------------
  /** Who a new message alerts: each member's level for the room and the shared rule (shared room-alerts.ts roomAlert;
   * docs/DECISIONS.md "대화방 알림 설정"). By default a DM or group chat message notifies the others (code room.dm: a
   * message for me), an @mention each person mentioned (room.mention), a reply in a thread its followers (room.dm too:
   * the push is the same generic line); a room at 모든 메시지 notifies every message of its timeline, one at 끄기 (or a
   * default of 받지 않음) nothing. Only people who see it. One unread notice of each kind per room (and thread) and person
   * (Notifications.roomNotice). Inside a person's quiet hours the notice is kept but marked quiet: never pushed.
   * Private messages (the AI's previews) and event lines notify nobody; an AI answer not the person who asked. The
   * notice is the message id only. Returns who got a notice that may ring, and which (Notifications.roomNotice): the
   * room.message to each of them says so (docs/DECISIONS.md "Session markers"). Never throws: it runs before the
   * room.message goes out, and a failure here must not hold the message back from anyone (it is logged, nobody is
   * marked). */
  notify(row: MessageRow): Map<string, RoomNoticeEvent> {
    // hidden rooms that come back with it, first: their windows get the room before the message
    try { this.unhideFor(row) } catch (e) { this.ctx.log.warn('hidden rooms not shown again', { err: e }) }
    try { return this.recordNotices(row) } catch (e) {
      this.ctx.log.warn('room notices not recorded', { err: e })
      return new Map()
    }
  }

  /** Who gets a hidden room back with this new message (docs/DECISIONS.md "대화 숨기기"): its author (they write in it),
   * the person who asked an AI answer (a private preview: RoomAi.ended), and each member who sees it and for whom it is something to read: a message of a
   * DM's timeline (a group chat's too, should one be hidden), a mention of them, a reply in a thread they follow. Nothing
   * else brings a team room or the everyone room back, at any level: a room still hidden makes no notice
   * (recordNotices). Never an event line, a deleted or a private message. */
  private unhideFor(row: MessageRow) {
    if (row.visibility !== 'room' || row.deleted_at || row.event) return
    const room = roomRow(this.db, row.room_id)
    if (!room) return
    // only the members who hid it (an everyone room may have hundreds of members, few of them hiding it)
    const hidden = (this.db.query('SELECT * FROM room_members WHERE room_id = ? AND hidden_at IS NOT NULL').all(row.room_id) as MemberRow[]).filter((m) => canSee(this.db, row, m))
    if (!hidden.length) return
    const mentioned = new Set(JSON.parse(row.mentions) as string[])
    const followers = row.thread_root_id ? new Set((this.db.query('SELECT user_id FROM room_thread_follows WHERE root_id = ?').all(row.thread_root_id) as { user_id: string }[]).map((r) => r.user_id)) : null
    const direct = (room.kind === 'dm' || room.kind === 'group') && (!row.thread_root_id || !!row.also_in_room)
    const back = hidden.filter((m) => {
      const me = m.user_id
      if (me === row.author_id || (row.author_kind === 'ai' && me === row.asked_by)) return true
      return direct || mentioned.has(me) || !!followers?.has(me)
    })
    this.unhide(row.room_id, back.map((m) => m.user_id))
  }
  private recordNotices(row: MessageRow): Map<string, RoomNoticeEvent> {
    const out = new Map<string, RoomNoticeEvent>()
    if (row.visibility !== 'room' || row.deleted_at || row.event) return out
    const room = roomRow(this.db, row.room_id)
    if (!room) return out
    // a room I still hide (unhideFor did not bring it back) tells me nothing
    const ms = members(this.db, row.room_id).filter((m) => m.user_id !== row.author_id && !(row.author_kind === 'ai' && m.user_id === row.asked_by) && canSee(this.db, row, m) && !m.hidden_at)
    if (!ms.length) return out
    const mentioned = new Set(JSON.parse(row.mentions) as string[])
    const followers = row.thread_root_id ? new Set((this.db.query('SELECT user_id FROM room_thread_follows WHERE root_id = ?').all(row.thread_root_id) as { user_id: string }[]).map((r) => r.user_id)) : null
    const prefs = getPreferencesOf(this.db, ms.map((m) => m.user_id))
    const tz = teamTimeZone(this.db), at = Date.parse(row.created_at)
    const n = notificationsOf(this.ctx)
    for (const m of ms) {
      const p = prefs.get(m.user_id)!
      const alert = roomAlert({
        level: roomLevel(room.kind, ownLevel(m), p.roomLevel), mentioned: mentioned.has(m.user_id) || !!row.mentions_all, reply: !!row.thread_root_id,
        alsoInRoom: !!row.also_in_room, following: !!followers?.has(m.user_id), threadReplies: p.roomThreadReplies,
      })
      if (!alert) continue
      const event: RoomNoticeEvent = alert === 'mention' ? 'room.mention' : 'room.dm'
      try { if (n.roomNotice(m.user_id, event, row.id, row.room_id, row.created_at, row.thread_root_id, inQuietHours(p.quietHours, tz, at), row.seq)) out.set(m.user_id, event) }
      catch (e) { this.ctx.log.warn('room notice not recorded', { err: e }) }
    }
    return out
  }

  // ---------------- team rooms and the everyone room ----------------
  /** At most every 2 s (list(), the minute tick). */
  syncSoon() {
    if (Date.now() - this.lastSync < 2000) return
    this.syncNow()
  }
  syncNow() {
    this.lastSync = Date.now()
    try { this.sync() } catch (e) { this.ctx.log.error('room sync failed', { err: e }) }
  }
  /** Before someone's rooms are read for their AI chat (chat/room-tools.ts): their team rooms and the everyone room put
   * right first when they are out of step (a group left a moment ago is applied before anything is read). */
  syncFor(userId: string) {
    if (this.outOfStep(userId)) this.syncNow()
    this.openHistoriesOf(userId)
  }
  /** This person's team rooms and everyone room whose history is not worked out yet (rooms/history.ts). Never throws. */
  private openHistoriesOf(userId: string) {
    try { openHistories(this.ctx, { userId }) } catch (e) { this.ctx.log.warn('room history not opened', { err: e }) }
  }
  /** Are this person's team rooms and everyone room not what their groups and account say? */
  private outOfStep(userId: string): boolean {
    const active = !!this.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId)
    const want = active ? `SELECT r.id FROM rooms r WHERE r.archived_at IS NULL AND (r.kind = 'all' OR (r.kind = 'team' AND r.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?1)))` : 'SELECT NULL WHERE 0'
    const have = "SELECT m.room_id FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.user_id = ?1 AND r.kind IN ('team', 'all')"
    if (!this.db.query("SELECT 1 FROM rooms WHERE kind = 'all'").get()) return true
    return !!this.db.query(`SELECT 1 FROM (SELECT * FROM (${want}) EXCEPT SELECT * FROM (${have})) UNION ALL SELECT 1 FROM (SELECT * FROM (${have}) EXCEPT SELECT * FROM (${want})) LIMIT 1`).get(userId)
  }

  /**
   * Make the team rooms and the everyone room match the groups and the people: a room for every group and one for
   * everyone; members = the group's active people / every active person. Someone added joins at the room's last seq
   * (they see the messages from then on); someone removed (left the group, disabled, deleted) loses the room, its
   * notices and their replay buffer. A team room whose group was deleted is archived with no members. Audited.
   * Group chats: who is in one is never changed here, nor any room's own name, except that a disabled or deleted
   * account leaves (an event line, not audited; the last one out archives it).
   */
  sync(): void {
    const db = this.db, now = nowIso()
    const added = new Map<string, string[]>(), removed = new Map<string, string[]>()
    const groupOut = new Map<string, { users: string[]; r: { lines: string[]; archived: boolean } }>()
    db.transaction(() => {
      const gone = db.query(`SELECT m.room_id, m.user_id FROM room_members m JOIN rooms r ON r.id = m.room_id JOIN users u ON u.id = m.user_id
        WHERE r.kind = 'group' AND r.archived_at IS NULL AND (u.status <> 'active' OR u.deleted_at IS NOT NULL) ORDER BY m.room_id, m.joined_at, m.user_id`).all() as { room_id: string; user_id: string }[]
      const byRoom = new Map<string, string[]>()
      for (const g of gone) (byRoom.get(g.room_id) ?? byRoom.set(g.room_id, []).get(g.room_id)!).push(g.user_id)
      for (const [roomId, users] of byRoom) {
        groupOut.set(roomId, { users, r: this.dropMembers(roomId, users.map((u) => ({ userId: u, actor: u, event: { type: 'left' as const } })), true) })
      }
      if (!db.query("SELECT 1 FROM rooms WHERE kind = 'all'").get()) {
        const id = newId()
        db.query("INSERT INTO rooms (id, kind, created_at, activity_at) VALUES (?, 'all', ?, ?)").run(id, now, now)
        audit(db, { actor: null, action: 'room.create', target: id, detail: { kind: 'all' } })
      }
      for (const g of db.query("SELECT g.id FROM groups g WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.kind = 'team' AND r.group_id = g.id)").all() as { id: string }[]) {
        const id = newId()
        db.query("INSERT INTO rooms (id, kind, group_id, created_at, activity_at) VALUES (?, 'team', ?, ?, ?)").run(id, g.id, now, now)
        audit(db, { actor: null, action: 'room.create', target: id, detail: { kind: 'team', groupId: g.id } })
      }
      for (const r of db.query("SELECT id FROM rooms WHERE kind = 'team' AND group_id IS NULL AND archived_at IS NULL").all() as { id: string }[]) {
        db.query('UPDATE rooms SET archived_at = ? WHERE id = ?').run(now, r.id)
        audit(db, { actor: null, action: 'room.archive', target: r.id, detail: { kind: 'team', reason: 'group_deleted' } })
      }
      const want = `SELECT r.id room_id, u.id user_id FROM rooms r JOIN users u ON u.status = 'active' AND u.deleted_at IS NULL WHERE r.kind = 'all' AND r.archived_at IS NULL
        UNION SELECT r.id, g.user_id FROM rooms r JOIN group_members g ON g.group_id = r.group_id JOIN users u ON u.id = g.user_id AND u.status = 'active' AND u.deleted_at IS NULL
          WHERE r.kind = 'team' AND r.archived_at IS NULL`
      const have = "SELECT m.room_id, m.user_id FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE r.kind IN ('team', 'all')"
      // each side in its own sub-select: compound SELECTs bind left to right (A EXCEPT B UNION C is (A EXCEPT B) UNION C)
      const toAdd = db.query(`SELECT * FROM (${want}) EXCEPT SELECT * FROM (${have})`).all() as { room_id: string; user_id: string }[]
      const toRemove = db.query(`SELECT * FROM (${have}) EXCEPT SELECT * FROM (${want})`).all() as { room_id: string; user_id: string }[]
      const add = db.query('INSERT INTO room_members (room_id, user_id, joined_at, last_read_seq, visible_from_seq) SELECT id, ?, ?, last_seq, last_seq FROM rooms WHERE id = ?')
      for (const a of toAdd) { add.run(a.user_id, now, a.room_id); (added.get(a.room_id) ?? added.set(a.room_id, []).get(a.room_id)!).push(a.user_id) }
      for (const r of toRemove) {
        this.forgetMember(r.room_id, r.user_id)
        ;(removed.get(r.room_id) ?? removed.set(r.room_id, []).get(r.room_id)!).push(r.user_id)
      }
      for (const id of new Set([...added.keys(), ...removed.keys()])) {
        audit(db, { actor: null, action: 'room.members', target: id, detail: { via: 'groups', added: added.get(id) ?? [], removed: removed.get(id) ?? [] } })
      }
    })()
    // a team room's or the everyone room's history opens to who joined it (rooms/history.ts), before they are told:
    // their first list already has it. Then anyone still waiting (an upgrade, a row an older build made), for a while
    let opened: { roomId: string; userId: string }[] = []
    try {
      const r = openHistories(this.ctx, { budgetMs: HISTORY_BUDGET_MS })
      opened = r.changed
      // more than one pass's time (an upgrade with many later members): the rest in short passes a second apart, so
      // the server answers in between
      if (r.left) this.drainHistories()
    } catch (e) { this.ctx.log.warn('room history not opened', { err: e }) }
    for (const [roomId, g] of groupOut) this.afterDrop(roomId, g.users, g.r)
    for (const [roomId, users] of removed) {
      for (const u of users) {
        // out of a team room or the everyone room: their questions there stop too
        roomAiOf(this.ctx).stopFor(roomId, u)
        // events about this room sit in their replay buffer: a window resuming from before now reloads instead
        this.ctx.services.realtime.forgetReplay(u)
        this.ctx.services.realtime.publish(u, { type: 'room.updated', data: { roomId, change: 'removed', room: null } })
      }
    }
    for (const roomId of new Set([...added.keys(), ...removed.keys()])) {
      const fresh = new Set(added.get(roomId) ?? [])
      if (fresh.size) this.roomEvent(roomId, 'added', fresh)
      const room = roomRow(db, roomId)
      if (room) this.fanout(roomId, (m) => (fresh.has(m.user_id) ? null : { type: 'room.updated', data: { roomId, change: 'members', room: roomOut(db, room, m) } }))
    }
    this.historiesOpened(opened, added)
  }

  /** A history that opened (or showed more) for someone already in the room: their windows read its messages again
   * ('members' is the change that makes an open room load its newest page and thread again). */
  private historiesOpened(opened: readonly { roomId: string; userId: string }[], added?: ReadonlyMap<string, string[]>) {
    for (const o of opened) if (!added?.get(o.roomId)?.includes(o.userId)) this.roomEvent(o.roomId, 'members', new Set([o.userId]))
  }

  private drainTimer: ReturnType<typeof setTimeout> | null = null
  private drainHooked = false
  /** Members still waiting for a room's history after a pass: the next short pass in a second (HISTORY_BUDGET_MS each),
   * until none is left. */
  private drainHistories() {
    if (this.drainTimer) return
    if (!this.drainHooked) { this.drainHooked = true; this.ctx.onClose(() => { if (this.drainTimer) clearTimeout(this.drainTimer); this.drainTimer = null }) }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      try {
        const r = openHistories(this.ctx, { budgetMs: HISTORY_BUDGET_MS })
        this.historiesOpened(r.changed)
        if (r.left) this.drainHistories()
      } catch (e) { this.ctx.log.warn('room history not opened', { err: e }) }
    }, 1000)
    ;(this.drainTimer as { unref?: () => void }).unref?.()
  }
}

export function roomsOf(ctx: AppContext): Rooms {
  let s = services.get(ctx)
  if (!s) {
    s = new Rooms(ctx)
    services.set(ctx, s)
    // an AI answer's file links: shown as links only to people who may open the file now (store.ts openableFor)
    setRoomPathCheck(ctx.db, (userId) => {
      const who = loadPrincipal(ctx.db, userId)
      if (!who) return () => false
      const rules = ctx.files.rules()
      const seen = new Map<string, boolean>()
      return (rel) => {
        let ok = seen.get(rel)
        if (ok === undefined) {
          try { const a = authorize(ctx.files.fx, rules, who, rel, 'read'); ok = !a.st?.isDirectory() && !!visiblePath(ctx.files.fx, rules, who, a.rel) } catch { ok = false }
          seen.set(rel, ok)
        }
        return ok
      }
    })
  }
  return s
}

/** After groups, roles or accounts changed (admin/folders.ts afterAccessChange): rooms follow at once. Never throws. */
export function syncRoomsNow(ctx: AppContext) {
  try { roomsOf(ctx).sync() } catch (e) { ctx.log.error('room sync failed', { err: e }) }
}
