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
// The AI (rooms/ai.ts, docs/DECISIONS.md "대화방의 트리나"): send() is the one place a person's message is written,
// and a message that calls the AI ("@트리나 …") starts its turn there, checked before the message is written. The
// answer is the other writer of room_messages (author_kind 'ai', asked_by = who asked); a private preview (visibility
// 'private', visible_to = who asked) is filtered everywhere (canSee / SEE_SQL) and makes no notice (notify()).
import type { Database } from 'bun:sqlite'
import { ROOM_GROUP_MAX, type Room, type RoomMember, type RoomMessage, type RoomReadState, type ServerEventInput } from '@mycel/shared/api'
import { decodeCursor, encodeCursor } from '../chat/store'
import type { AppContext } from '../context'
import { newId, nowIso } from '../db'
import { fail } from '../http/errors'
import { audit } from '../admin/audit'
import { notificationsOf } from '../notifications/service'
import {
  canSee, groupName, isOwnerOrAdmin, managerOf, mayRename, memberRow, members, membersOut, messageRow, messagesOut, MSG_COLS, roomOut, roomRow, SEE_SQL, setRoomPathCheck, unreadCount,
  type EventData, type MemberRow, type MessageRow, type RoomRow,
} from './store'
import { roomFilesOf } from './files'
import { roomAiOf, type AskOptions } from './ai'
import { roomAiCalled } from '@mycel/shared/api'
import { loadPrincipal } from '../policy/access'
import { authorize, visiblePath } from '../policy/authorize'

const services = new WeakMap<AppContext, Rooms>()
/** Sending: a burst of SEND_BURST messages, then SEND_PER_SECOND a second (per person, all rooms together). More than
 * people type; a script that floods a room gets 429 with the seconds to wait. */
export const SEND_BURST = 20
export const SEND_PER_SECOND = 1

export interface SendInput { body: string; replyToId?: string | null; mentions: string[]; fileIds: string[]; clientMessageId: string }

export class Rooms {
  private lastSync = 0
  private sendBudget = new Map<string, { tokens: number; at: number }>()
  constructor(readonly ctx: AppContext) {}
  private get db(): Database { return this.ctx.db }

  // ---------------- access ----------------
  /** The room and my member row, or 404 (not in it, archived, unknown: all the same). */
  mine(userId: string, roomId: string): { room: RoomRow; me: MemberRow } {
    const room = roomRow(this.db, roomId)
    const me = room && !room.archived_at ? memberRow(this.db, roomId, userId) : null
    if (!room || !me) return fail('not_found')
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
  messageEvent(type: 'room.message' | 'room.message.updated', row: MessageRow) {
    const ms = members(this.db, row.room_id)
    this.fanout(row.room_id, (m) => canSee(row, m) ? { type, data: { roomId: row.room_id, message: messagesOut(this.db, [row], m, ms)[0]! } } : null, ms)
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
    const rows = this.db.query(`SELECT r.*, m.user_id, m.joined_at, m.last_read_seq, m.visible_from_seq, m.muted FROM rooms r JOIN room_members m ON m.room_id = r.id
      WHERE m.user_id = ? AND r.archived_at IS NULL`).all(userId) as (RoomRow & MemberRow)[]
    const out = rows.map((r) => roomOut(this.db, r, { ...r, room_id: r.id }))
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
    }
    return this.get(userId, found.id)
  }

  /** A group chat of me and `userIds` (at least two others, active people of this team; not audited). Its name is
   * optional: without one the app shows the other members' names. Everyone in it sees it from its first line. */
  createGroup(userId: string, userIds: readonly string[], name?: string | null): Room {
    const others = [...new Set(userIds)].filter((id) => id !== userId)
    if (others.length < 2) fail('validation', undefined, { fields: { 'body.userIds': 'at least two other people' } })
    if (others.length + 1 > ROOM_GROUP_MAX) fail('validation', undefined, { fields: { 'body.userIds': `at most ${ROOM_GROUP_MAX} people` } })
    this.assertActive(others)
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

  /** My setting (muted) and the room's own name (mayRename: else 403). A name change is an event line. */
  update(userId: string, roomId: string, b: { muted?: boolean; name?: string | null }): Room {
    const { room } = this.mine(userId, roomId)
    if (b.name !== undefined) this.rename(userId, room, b.name)
    if (b.muted !== undefined) {
      this.db.query('UPDATE room_members SET muted = ? WHERE room_id = ? AND user_id = ?').run(b.muted ? 1 : 0, roomId, userId)
      this.roomEvent(roomId, 'updated', new Set([userId]))
    }
    return this.get(userId, roomId)
  }

  setMuted(userId: string, roomId: string, muted: boolean): Room {
    return this.update(userId, roomId, { muted })
  }

  /** '' or null: back to the server's name; a team room given its group's own name follows the group again. Team rooms
   * and the everyone room: audited (room.rename), as their other changes are; a group chat not. */
  private rename(userId: string, room: RoomRow, raw: string | null) {
    if (!mayRename(this.db, room, userId)) fail('forbidden')
    let name = raw?.trim() || null
    if (name && room.kind === 'team' && name === groupName(this.db, room)) name = null
    if ((room.name ?? null) === name) return
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
        this.db.query('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, o.userId)
        this.db.query('DELETE FROM room_notices WHERE room_id = ? AND user_id = ?').run(roomId, o.userId)
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
      this.ctx.services.realtime.forgetReplay(u)
      this.ctx.services.realtime.publish(u, { type: 'room.updated', data: { roomId, change: 'removed', room: null } })
    }
    if (r.archived) return
    const room = roomRow(this.db, roomId)
    if (room) this.fanout(roomId, (m) => ({ type: 'room.updated', data: { roomId, change: 'members', room: roomOut(this.db, room, m) } }))
    for (const id of r.lines) this.messageEvent('room.message', messageRow(this.db, roomId, id)!)
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
    const rows = this.db.query(`SELECT ${MSG_COLS} FROM room_messages m WHERE m.room_id = ? AND ${SEE_SQL} ${cur ? 'AND m.seq < ?' : ''} ORDER BY m.seq DESC LIMIT ?`)
      .all(...(cur ? [roomId, me.visible_from_seq, userId, Number(cur.s), limit + 1] : [roomId, me.visible_from_seq, userId, limit + 1])) as MessageRow[]
    const page = rows.slice(0, limit).reverse()
    return { items: messagesOut(this.db, page, me), nextCursor: rows.length > limit && page[0] ? encodeCursor({ s: String(page[0].seq) }) : null }
  }

  /** Send as `userId` (the author is always the signed-in person). Same clientMessageId again: the first message. A
   * message that calls the AI is checked for that first (rooms/ai.ts precheck: a refusal sends nothing), then asks it. */
  send(userId: string, roomId: string, b: SendInput, o: AskOptions = {}): RoomMessage {
    const { me } = this.mine(userId, roomId)
    const again = this.db.query(`SELECT ${MSG_COLS} FROM room_messages WHERE room_id = ? AND author_id = ? AND client_id = ?`).get(roomId, userId, b.clientMessageId) as MessageRow | null
    if (again) return messagesOut(this.db, [again], memberRow(this.db, roomId, userId)!)[0]!
    this.takeSendToken(userId)
    if (b.replyToId) {
      const q = messageRow(this.db, roomId, b.replyToId)
      // an event line is not a message to answer
      if (!q || !canSee(q, me) || q.event) fail('validation', undefined, { fields: { 'body.replyToId': 'not in this room' } })
    }
    const mentions = this.validMentions(roomId, userId, b.mentions)
    const fileIds = [...new Set(b.fileIds)]
    if (fileIds.length) {
      const n = (this.db.query(`SELECT COUNT(*) n FROM room_files WHERE room_id = ? AND user_id = ? AND message_id IS NULL AND id IN (${fileIds.map(() => '?').join(',')})`).get(roomId, userId, ...fileIds) as { n: number }).n
      if (n !== fileIds.length) fail('validation', undefined, { fields: { 'body.fileIds': 'unknown file' } })
    }
    // "@트리나 …" (a person picked from the list under the same name wins); anything that stops the question stops the send
    const people = mentions.length ? (this.db.query(`SELECT name FROM users WHERE id IN (${mentions.map(() => '?').join(',')})`).all(...mentions) as { name: string }[]).map((r) => r.name) : []
    const ask = roomAiCalled(b.body, people) ? roomAiOf(this.ctx).precheck(userId, roomId, o) : null
    const now = nowIso(), id = newId()
    let fromSeq = 0, seq = 0
    this.db.transaction(() => {
      seq = (this.db.query('UPDATE rooms SET last_seq = last_seq + 1, activity_at = ? WHERE id = ? RETURNING last_seq').get(now, roomId) as { last_seq: number }).last_seq
      this.db.query(`INSERT INTO room_messages (id, room_id, seq, author_kind, author_id, visibility, body, reply_to_id, mentions, client_id, created_at)
        VALUES (?, ?, ?, 'user', ?, 'room', ?, ?, ?, ?, ?)`).run(id, roomId, seq, userId, b.body, b.replyToId ?? null, JSON.stringify(mentions), b.clientMessageId, now)
      if (fileIds.length) this.db.query(`UPDATE room_files SET message_id = ? WHERE id IN (${fileIds.map(() => '?').join(',')})`).run(id, ...fileIds)
      // sending means I have seen the room up to here (KakaoTalk): my read position moves to my message
      fromSeq = Math.max(me.last_read_seq, me.visible_from_seq)
      this.db.query('UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND user_id = ?').run(seq, roomId, userId)
    })()
    if (fromSeq < seq - 1) this.readEvent(roomId, userId, fromSeq, seq - 1)
    this.markNoticesRead(userId, roomId, seq)
    const row = messageRow(this.db, roomId, id)!
    this.messageEvent('room.message', row)
    this.notify(row)
    if (ask) roomAiOf(this.ctx).ask(userId, roomId, row, ask, people)
    return messagesOut(this.db, [row], memberRow(this.db, roomId, userId)!)[0]!
  }

  edit(userId: string, roomId: string, messageId: string, b: { body: string; mentions: string[] }): RoomMessage {
    const { me } = this.mine(userId, roomId)
    const m = this.own(roomId, messageId, userId)
    const mentions = this.validMentions(roomId, userId, b.mentions)
    // an edit notifies nobody (only a new message does), so a mention added later is quiet
    this.db.query('UPDATE room_messages SET body = ?, mentions = ?, edited_at = ? WHERE id = ?').run(b.body, JSON.stringify(mentions), nowIso(), m.id)
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
      this.db.query("UPDATE room_messages SET body = '', mentions = '[]', deleted_at = ? WHERE id = ?").run(now, m.id)
      // an AI answer's "참고한 파일" go with it
      this.db.query('DELETE FROM room_message_sources WHERE message_id = ?').run(m.id)
      if (m.author_kind === 'ai' && m.asked_by !== userId) audit(this.db, { actor: userId, action: 'room.ai_delete', target: m.id, detail: { roomId } })
      return (this.db.query('DELETE FROM room_notices WHERE source_id = ? AND room_id = ? RETURNING user_id').all(m.id, roomId) as { user_id: string }[]).map((r) => r.user_id)
    })()
    roomFilesOf(this.ctx).removeForMessage(m.id)
    for (const u of new Set(noticed)) this.notifySignal(u)
    this.messageEvent('room.message.updated', messageRow(this.db, roomId, messageId)!)
  }

  /** One token per new message (a resend of the same clientMessageId above costs none). */
  private takeSendToken(userId: string) {
    const now = Date.now()
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
    if (!m || (m.author_kind === 'ai' && !canSee(m, me))) return fail('not_found')
    if (m.author_kind !== 'ai') return this.own(roomId, messageId, userId)
    const role = (this.db.query('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | null)?.role
    if (m.asked_by !== userId && role !== 'owner' && role !== 'admin') return fail('forbidden')
    if (m.deleted_at) return fail('conflict')
    return m
  }

  private own(roomId: string, messageId: string, userId: string): MessageRow {
    const m = messageRow(this.db, roomId, messageId)
    if (!m) return fail('not_found')
    // an event line is nobody's message: its author did something, they did not write it
    if (m.author_kind !== 'user' || m.author_id !== userId || m.event) return fail('forbidden')
    if (m.deleted_at) return fail('conflict')
    return m
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
    const to = Math.min(seq, room.last_seq)
    if (to > from) {
      this.db.query('UPDATE room_members SET last_read_seq = ? WHERE room_id = ? AND user_id = ? AND last_read_seq < ?').run(to, roomId, userId, to)
      this.readEvent(roomId, userId, from, to)
      this.markNoticesRead(userId, roomId, to)
    }
    const now = memberRow(this.db, roomId, userId)!
    return { lastReadSeq: Math.max(now.last_read_seq, now.visible_from_seq), unreadCount: unreadCount(this.db, roomId, now).n }
  }

  /** Someone read fromSeq < seq <= toSeq: the others are not told who; my own windows recount my badge. */
  readEvent(roomId: string, userId: string, fromSeq: number, toSeq: number) {
    this.fanout(roomId, (m) => ({ type: 'room.read', data: { roomId, fromSeq, toSeq, mine: m.user_id === userId } }))
  }

  /** My notices of this room up to `seq` count as read (the inbox and a pending push follow). */
  markNoticesRead(userId: string, roomId: string, seq: number) {
    const r = this.db.query(`UPDATE room_notices SET read_at = ? WHERE user_id = ? AND room_id = ? AND read_at IS NULL
      AND source_id IN (SELECT id FROM room_messages WHERE room_id = ? AND seq <= ?)`).run(nowIso(), userId, roomId, roomId, seq)
    if (r.changes) this.notifySignal(userId)
  }

  // ---------------- notices ----------------
  /** A DM or group chat message notifies the others (code room.dm: a conversation of picked people, as Slack's group
   * DMs), an @mention each person mentioned; nobody who muted the room. One unread notice of each kind per room and
   * person (Notifications.roomNotice). Private messages (the AI's previews) and event lines notify nobody; an AI answer
   * not the person who asked. The notice is the message id only. */
  notify(row: MessageRow) {
    if (row.visibility !== 'room' || row.deleted_at || row.event) return
    const room = roomRow(this.db, row.room_id)
    if (!room) return
    const ms = members(this.db, row.room_id).filter((m) => m.user_id !== row.author_id && !(row.author_kind === 'ai' && m.user_id === row.asked_by) && canSee(row, m))
    const mentioned = new Set(JSON.parse(row.mentions) as string[])
    const n = notificationsOf(this.ctx)
    for (const m of ms) {
      if (m.muted) continue
      try {
        if (mentioned.has(m.user_id)) n.roomNotice(m.user_id, 'room.mention', row.id, row.room_id, row.created_at)
        else if (room.kind === 'dm' || room.kind === 'group') n.roomNotice(m.user_id, 'room.dm', row.id, row.room_id, row.created_at)
      } catch (e) { this.ctx.log.warn('room notice not recorded', { err: e }) }
    }
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
        db.query('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(r.room_id, r.user_id)
        db.query('DELETE FROM room_notices WHERE room_id = ? AND user_id = ?').run(r.room_id, r.user_id)
        ;(removed.get(r.room_id) ?? removed.set(r.room_id, []).get(r.room_id)!).push(r.user_id)
      }
      for (const id of new Set([...added.keys(), ...removed.keys()])) {
        audit(db, { actor: null, action: 'room.members', target: id, detail: { via: 'groups', added: added.get(id) ?? [], removed: removed.get(id) ?? [] } })
      }
    })()
    for (const [roomId, g] of groupOut) this.afterDrop(roomId, g.users, g.r)
    for (const [roomId, users] of removed) {
      for (const u of users) {
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
