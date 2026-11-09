// Pinned conversations (docs/DECISIONS.md "Pinned conversations", shared/src/api/rooms.ts pinRoom / unpinRoom): a member
// pins a DM, a team room, the everyone room or a group chat to the top of their own 대화 list. Room.pinnedAt is each
// member's own; only their windows hear a pin or an unpin. Members only (404 for anyone else, the owner included).
// The pin goes when they leave or are taken out (also by a group change), when the room is deleted (archived with
// nobody in it, or its row gone), when the person is deleted, and when they hide the room (a hidden room cannot be
// pinned). At most ROOM_PINS_MAX.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { newId } from '../../server/src/db'
import { ROOM_PINS_MAX, roomsOf } from '../../server/src/rooms/service'
import { addMember, harness, RecordingHub, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

/** Records what each listed person would receive (publishEach builds per person, like the real hub). */
class FanoutHub extends RecordingHub {
  users: string[] = []
  override publishEach(build: (userId: string) => unknown) {
    for (const u of this.users) { const ev = build(u); if (ev) this.events.push({ kind: 'publish', target: u, data: ev }) }
  }
  /** what one person got, in order */
  of(uid: string) { return this.events.filter((e) => e.target === uid).map((e) => e.data as { type: string; data: any }) }
  clear() { this.events = []; this.forgotten = [] }
}

async function setup(name = 'b-rooms-pins') {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id] })
  const hub = new FanoutHub()
  hub.users = ['olga', mia.id, nora.id, otto.id]
  h.ctx.services.realtime = hub
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 2000)
  const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as any[]
  const roomOf = async (c: Client, id: string) => (await rooms(c)).find((r) => r.id === id)
  const pin = (c: Client, id: string) => c.try('POST', `/api/rooms/${id}/pin`)
  const unpin = (c: Client, id: string) => c.try('DELETE', `/api/rooms/${id}/pin`)
  const pinRows = (id: string) => (h.ctx.db.query('SELECT user_id FROM room_pins WHERE room_id = ? ORDER BY user_id').all(id) as { user_id: string }[]).map((r) => r.user_id)
  const mine = await rooms(mia.client)
  const team = mine.find((r) => r.kind === 'team' && r.groupId === group.id)
  const all = mine.find((r) => r.kind === 'all')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const chat = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  return { owner, mia, nora, otto, group, hub, rooms, roomOf, pin, unpin, pinRows, team, all, dm, chat }
}

test('pin and unpin every kind: mine only, the same again changes nothing, only my windows hear it, not audited', async () => {
  const { mia, nora, otto, hub, roomOf, pin, unpin, pinRows, team, all, dm, chat } = await setup()
  const audits = (h.ctx.db.query('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n
  for (const room of [dm, team, all, chat]) {
    hub.clear()
    const r = await pin(mia.client, room.id)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: room.id, kind: room.kind })
    expect(r.body.pinnedAt).toBeString()
    // the list and the room say the same
    expect((await roomOf(mia.client, room.id)).pinnedAt).toBe(r.body.pinnedAt)
    expect((await mia.client.call('GET', `/api/rooms/${room.id}`)).pinnedAt).toBe(r.body.pinnedAt)
    // my windows get the room with my pin; nobody else gets anything
    expect(hub.of(mia.id)).toEqual([{ type: 'room.updated', data: { roomId: room.id, change: 'updated', room: expect.objectContaining({ id: room.id, pinnedAt: r.body.pinnedAt }) } }])
    for (const u of ['olga', nora.id, otto.id]) expect(hub.of(u)).toEqual([])
    // the others in it see no pin
    expect((await roomOf(nora.client, room.id)).pinnedAt).toBeUndefined()
    // the same again: kept as it was (its place does not move), nothing sent
    hub.clear()
    const again = await pin(mia.client, room.id)
    expect([again.status, again.body.pinnedAt]).toEqual([200, r.body.pinnedAt])
    expect(hub.events).toEqual([])
    expect(pinRows(room.id)).toEqual([mia.id])
  }
  // pins are per person: nora pins the DM too, each sees their own moment
  const theirs = await pin(nora.client, dm.id)
  expect(theirs.body.pinnedAt).not.toBe((await roomOf(mia.client, dm.id)).pinnedAt)
  expect(pinRows(dm.id)).toEqual([mia.id, nora.id].sort())
  // a message in the room sends each member their own copy, each with their own pin
  hub.clear()
  await mia.client.call('PATCH', `/api/rooms/${chat.id}`, { name: 'plans' })
  const copies = (u: string) => hub.of(u).filter((e) => e.type === 'room.updated' && e.data.roomId === chat.id).map((e) => e.data.room.pinnedAt)
  expect(copies(mia.id).every((x) => typeof x === 'string')).toBe(true)
  expect(copies(nora.id).length).toBeGreaterThan(0)
  expect(copies(nora.id).every((x) => x === undefined)).toBe(true)

  // unpin: the field goes, my windows hear it; the same again changes nothing and sends nothing
  for (const room of [dm, team, all, chat]) {
    hub.clear()
    const r = await unpin(mia.client, room.id)
    expect(r.status).toBe(200)
    expect(r.body.pinnedAt).toBeUndefined()
    expect((await roomOf(mia.client, room.id)).pinnedAt).toBeUndefined()
    expect(hub.of(mia.id).map((e) => [e.type, e.data.change, e.data.room.pinnedAt])).toEqual([['room.updated', 'updated', undefined]])
    for (const u of ['olga', nora.id, otto.id]) expect(hub.of(u)).toEqual([])
    hub.clear()
    expect((await unpin(mia.client, room.id)).status).toBe(200)
    expect(hub.events).toEqual([])
  }
  // nora's pin of the DM is hers: mia's unpin left it
  expect(pinRows(dm.id)).toEqual([nora.id])
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n).toBe(audits)
})

test('the order: the most recently pinned first, also two pins in the same instant; the list keeps its order by activity', async () => {
  const { mia, rooms, pin, team, all, dm, chat } = await setup()
  const before = (await rooms(mia.client)).map((r) => r.id)
  for (const room of [team, dm, all, chat]) await pin(mia.client, room.id)
  const list = await rooms(mia.client)
  // the server's list stays by latest activity (the app puts the pins first)
  expect(list.map((r) => r.id)).toEqual(before)
  const byPin = list.filter((r) => r.pinnedAt).sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt)).map((r) => r.id)
  expect(byPin).toEqual([chat.id, all.id, dm.id, team.id])
  // pins made in the same millisecond still differ
  expect(new Set(list.map((r) => r.pinnedAt)).size).toBe(4)
})

test('members only: anyone else gets 404, the owner included, and nothing is written', async () => {
  const { owner, mia, otto, pin, unpin, pinRows, team, dm } = await setup()
  for (const [c, id] of [[owner, dm.id], [otto.client, dm.id], [otto.client, team.id], [owner, team.id]] as const) {
    expect((await pin(c, id)).status).toBe(404)
    expect((await unpin(c, id)).status).toBe(404)
  }
  expect(pinRows(dm.id)).toEqual([])
  expect(pinRows(team.id)).toEqual([])
  // an unknown room too
  expect((await pin(mia.client, newId())).status).toBe(404)
})

test('leaving, being taken out and a group change take the pin; coming back, the room is not pinned', async () => {
  const { owner, mia, nora, otto, group, pin, pinRows, roomOf, team, chat } = await setup()
  await pin(mia.client, chat.id)
  await pin(nora.client, chat.id)
  await pin(otto.client, chat.id)
  expect(pinRows(chat.id)).toEqual([mia.id, nora.id, otto.id].sort())
  // otto leaves
  expect((await otto.client.try('POST', `/api/rooms/${chat.id}/leave`)).status).toBe(204)
  expect(pinRows(chat.id)).toEqual([mia.id, nora.id].sort())
  // the manager takes nora out
  expect((await mia.client.try('DELETE', `/api/rooms/${chat.id}/members/${nora.id}`)).status).toBe(204)
  expect(pinRows(chat.id)).toEqual([mia.id])
  // invited back: not pinned
  await mia.client.call('POST', `/api/rooms/${chat.id}/members`, { userIds: [nora.id] })
  expect((await roomOf(nora.client, chat.id)).pinnedAt).toBeUndefined()
  // a team room: out of the group, out of the room, the pin with it; back in the group, not pinned
  await pin(nora.client, team.id)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id] })
  expect(pinRows(team.id)).toEqual([])
  expect((await pin(nora.client, team.id)).status).toBe(404)
  await owner.call('PATCH', `/api/admin/groups/${group.id}`, { memberIds: [mia.id, nora.id] })
  expect((await roomOf(nora.client, team.id)).pinnedAt).toBeUndefined()
  // a disabled account leaves its group chats: the pin goes too
  await pin(otto.client, (await otto.client.call('POST', '/api/rooms', { kind: 'group', userIds: [mia.id, nora.id] })).id)
  const ottoChat = (h.ctx.db.query('SELECT room_id FROM room_pins WHERE user_id = ?').get(otto.id) as { room_id: string }).room_id
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'disabled' })
  expect(pinRows(ottoChat)).toEqual([])
})

test('a deleted room takes everyone\'s pin: a deleted group\'s room, the last one out of a group chat, the room\'s row', async () => {
  const { owner, mia, nora, otto, group, pin, pinRows, team, chat, dm } = await setup()
  await pin(mia.client, team.id)
  await pin(nora.client, team.id)
  await owner.call('DELETE', `/api/admin/groups/${group.id}`)
  expect((h.ctx.db.query('SELECT archived_at FROM rooms WHERE id = ?').get(team.id) as { archived_at: string | null }).archived_at).toBeTruthy()
  expect(pinRows(team.id)).toEqual([])
  // the last one out of a group chat archives it: nobody's pin is left
  for (const c of [mia.client, nora.client, otto.client]) await pin(c, chat.id)
  for (const c of [mia.client, nora.client, otto.client]) await c.call('POST', `/api/rooms/${chat.id}/leave`)
  expect((h.ctx.db.query('SELECT archived_at FROM rooms WHERE id = ?').get(chat.id) as { archived_at: string | null }).archived_at).toBeTruthy()
  expect(pinRows(chat.id)).toEqual([])
  // a room's row gone (no route deletes one): its pins go with it (the foreign key)
  await pin(mia.client, dm.id)
  await pin(nora.client, dm.id)
  h.ctx.db.query('DELETE FROM rooms WHERE id = ?').run(dm.id)
  expect(pinRows(dm.id)).toEqual([])
})

test("a deleted person's pins go (their DMs keep their member row)", async () => {
  const { owner, nora, pin, pinRows, dm, all } = await setup()
  await pin(nora.client, dm.id)
  await pin(nora.client, all.id)
  await owner.call('DELETE', `/api/admin/users/${nora.id}`)
  expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_members WHERE room_id = ? AND user_id = ?').get(dm.id, nora.id)).toEqual({ n: 1 })
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_pins WHERE user_id = ?').get(nora.id) as { n: number }).n).toBe(0)
  expect(pinRows(dm.id)).toEqual([])
})

test('a hidden room: hiding unpins it, a hidden room cannot be pinned (409), shown again it can', async () => {
  const { mia, nora, hub, pin, unpin, pinRows, roomOf, dm, team } = await setup()
  await pin(mia.client, dm.id)
  await pin(nora.client, dm.id)
  hub.clear()
  const hidden = await mia.client.call('PUT', `/api/rooms/${dm.id}/hidden`, { hidden: true })
  expect(hidden).toMatchObject({ hidden: true })
  expect(hidden.pinnedAt).toBeUndefined()
  // one room.updated to my windows, already without the pin; nora's pin of the same DM stays
  expect(hub.of(mia.id).filter((e) => e.type === 'room.updated').map((e) => [e.data.room.hidden, e.data.room.pinnedAt])).toEqual([[true, undefined]])
  expect(pinRows(dm.id)).toEqual([nora.id])
  // pinning it while hidden: refused, in the person's language, nothing written
  const no = await pin(mia.client, dm.id)
  expect(no.status).toBe(409)
  expect(no.body.error.params.reason).toBe('room_hidden')
  expect(pinRows(dm.id)).toEqual([nora.id])
  // unpinning a hidden room is nothing to do
  expect((await unpin(mia.client, dm.id)).status).toBe(200)
  // a new message brings it back, not pinned
  await nora.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: 'hi', clientMessageId: 'cm-' + crypto.randomUUID() })
  const back = await roomOf(mia.client, dm.id)
  expect([back.hidden, back.pinnedAt]).toEqual([undefined, undefined])
  expect((await pin(mia.client, dm.id)).status).toBe(200)
  // a team room the same; shown again by hand, it can be pinned again
  await pin(mia.client, team.id)
  await mia.client.call('PUT', `/api/rooms/${team.id}/hidden`, { hidden: true })
  expect(pinRows(team.id)).toEqual([])
  await mia.client.call('PUT', `/api/rooms/${team.id}/hidden`, { hidden: false })
  expect((await pin(mia.client, team.id)).body.pinnedAt).toBeString()
})

test(`at most ${ROOM_PINS_MAX} pins; pins of rooms I am no longer in do not count`, async () => {
  const { mia, pin, unpin, dm } = await setup()
  // ROOM_PINS_MAX group chats of mia's, written as the server does (a group chat a minute would take an hour)
  const db = h.ctx.db
  const now = new Date().toISOString()
  const ids: string[] = []
  for (let i = 0; i < ROOM_PINS_MAX; i++) {
    const id = newId()
    ids.push(id)
    db.query("INSERT INTO rooms (id, kind, created_at, activity_at) VALUES (?, 'group', ?, ?)").run(id, now, now)
    db.query('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, mia.id, now)
  }
  for (const id of ids) expect((await pin(mia.client, id)).status).toBe(200)
  const full = await pin(mia.client, dm.id)
  expect(full.status).toBe(409)
  expect(full.body.error.params.reason).toBe('room_pins_full')
  expect(full.body.error.message).toContain(String(ROOM_PINS_MAX))
  // one pinned again: still fine (nothing new)
  expect((await pin(mia.client, ids[0]!)).status).toBe(200)
  // a pin of a room I am no longer in (a row an older build left) does not count
  db.query('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(ids[0]!, mia.id)
  expect((await pin(mia.client, dm.id)).status).toBe(200)
  // and an unpin makes room
  await unpin(mia.client, dm.id)
  await unpin(mia.client, ids[1]!)
  expect((await pin(mia.client, dm.id)).status).toBe(200)
})
