// A project room's history for later members (rooms/history.ts historyRoom, HISTORY_ROOM_SQL; docs/decisions/
// 20261120-project-is-room.md D2), at each place that asked historyKinds before: the rule itself (a team room, the
// everyone room and a project room; never a plain group chat or a DM), Rooms.mine opening it (from the floor), a check
// again keeping a set start, and read-scope's SQL (who still waits for the history; a thread reply's audience), which
// chat/answer-share.ts and chat/post-to-room.ts read through.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { HISTORY_ROOM_SQL, historyRoom, openHistories } from '../../server/src/rooms/history'
import { roomRow } from '../../server/src/rooms/store'
import { viewersByHistory } from '../../server/src/chat/read-scope'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

const user = (id: string) => ({ subjectType: 'user', subjectId: id })
const cm = () => 'cm-' + crypto.randomUUID()

test('historyRoom and its SQL: team, everyone and a project room yes; a plain group chat and a DM no; a later member sees from the floor; a check again keeps a set start', async () => {
  h = await harness('b-project-room-history')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const launch = await mia.client.call('POST', '/api/projects', { name: 'Launch site', participants: [user(nora.id)] })
  const room = await mia.client.call('POST', `/api/projects/${launch.id}/room`)
  const group = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id], name: 'Plain' })
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const all = (await mia.client.call('GET', '/api/rooms')).items.find((r: any) => r.kind === 'all')
  const db = h.ctx.db
  const sql = (id: string) => !!db.query(`SELECT 1 FROM rooms r WHERE r.id = ? AND ${HISTORY_ROOM_SQL('r')}`).get(id)
  for (const [id, want] of [[room.id, true], [all.id, true], [group.id, false], [dm.id, false]] as const) {
    expect(`${id} ${historyRoom(db, roomRow(db, id))}`).toBe(`${id} ${want}`)
    expect(`${id} ${sql(id)}`).toBe(`${id} ${want}`)
  }
  // a floor of 2 (as a converted channel's): otto, added later, sees from it, opened when he reads the room (Rooms.mine)
  await mia.client.call('POST', `/api/rooms/${room.id}/messages`, { body: 'one', clientMessageId: cm() })
  await mia.client.call('POST', `/api/rooms/${room.id}/messages`, { body: 'two', clientMessageId: cm() })
  await mia.client.call('POST', `/api/rooms/${room.id}/messages`, { body: 'three', clientMessageId: cm() })
  db.query('UPDATE room_project_links SET history_floor_seq = 2 WHERE room_id = ?').run(room.id)
  const acc = await mia.client.call('GET', `/api/projects/${launch.id}/access`)
  await mia.client.call('PUT', `/api/projects/${launch.id}/participants`, { participants: [user(nora.id), user(otto.id)], expectedHash: acc.rulesHash })
  const before = db.query('SELECT history_from_seq, visible_from_seq FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, otto.id) as { history_from_seq: number | null; visible_from_seq: number }
  expect(before.visible_from_seq).toBe(3)
  // (the sync's own pass may have opened it already; either way from the floor, never 0)
  const page = await otto.client.call('GET', `/api/rooms/${room.id}/messages`)
  expect((page.items as any[]).map((m) => m.body)).toEqual(['three'])
  expect((db.query('SELECT history_from_seq FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, otto.id) as { history_from_seq: number }).history_from_seq).toBe(2)
  // a check again keeps the start that is set
  db.query('UPDATE room_members SET history_recheck = 1 WHERE room_id = ? AND user_id = ?').run(room.id, otto.id)
  openHistories(h.ctx, { roomId: room.id })
  expect((db.query('SELECT history_from_seq, history_recheck FROM room_members WHERE room_id = ? AND user_id = ?').get(room.id, otto.id))).toEqual({ history_from_seq: 2, history_recheck: 0 })
  // read-scope: a member whose project-room history is not worked out yet waits (as in a team room); in a plain
  // group chat nobody waits
  db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ? AND user_id = ?').run(room.id, otto.id)
  expect(viewersByHistory(db, room.id, undefined, 3).hiddenFrom.has(otto.id)).toBe(true)
  await mia.client.call('POST', `/api/rooms/${group.id}/members`, { userIds: [otto.id] })
  db.query('UPDATE room_members SET history_from_seq = NULL WHERE room_id = ?').run(group.id)
  expect(viewersByHistory(db, group.id, undefined, 1).hiddenFrom.size).toBe(0)
})
