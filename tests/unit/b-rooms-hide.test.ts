// Hiding a conversation (docs/DECISIONS.md "대화 숨기기", shared/src/api/rooms.ts setRoomHidden): a member hides a DM, a
// team room or the everyone room from their own lists (a group chat is left instead: 403). Nobody else is told, nothing
// is audited. It comes back by itself when something for them arrives, decided when the message is stored (rooms/
// service.ts unhideFor): their own message, an answer to their question, a DM's timeline message, a mention of them, a
// reply in a thread they follow; nothing else, at any level, and a room still hidden makes no notice. Opening the DM
// again shows it too. Members only, as every room route: anyone else gets 404 (the owner and admins included).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { migrate, newId, readMigrations } from '../../server/src/db'
import { roomAiOf } from '../../server/src/rooms/ai'
import { noticeWanted } from '../../server/src/rooms/alerts'
import { listRooms } from '../../server/src/rooms/reader'
import { roomsOf } from '../../server/src/rooms/service'
import { messageRow } from '../../server/src/rooms/store'
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
  /** what one person got, in order: [type, data] */
  of(uid: string) { return this.events.filter((e) => e.target === uid).map((e) => e.data as { type: string; data: any }) }
  clear() { this.events = []; this.forgotten = [] }
}

const cm = () => 'cm-' + crypto.randomUUID()

async function setup(name = 'b-rooms-hide') {
  h = await harness(name)
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id, otto.id] })
  const hub = new FanoutHub()
  hub.users = ['olga', ada.id, mia.id, nora.id, otto.id]
  h.ctx.services.realtime = hub
  // these tests send many messages: the sending budget's clock moves 2 s a send (the budget is tested in b-rooms)
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 2000)
  const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as any[]
  const roomOf = async (c: Client, id: string) => (await rooms(c)).find((r) => r.id === id)
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const hide = (c: Client, roomId: string, hidden = true) => c.try('PUT', `/api/rooms/${roomId}/hidden`, { hidden })
  /** is the room hidden for this person, as the list says (and the room itself says the same) */
  const hidden = async (c: Client, roomId: string) => {
    const inList = (await roomOf(c, roomId)).hidden
    const one = (await c.call('GET', `/api/rooms/${roomId}`)).hidden
    expect(one).toBe(inList)
    return inList === true
  }
  const hiddenAt = (roomId: string, uid: string) => (h.ctx.db.query('SELECT hidden_at FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, uid) as { hidden_at: string | null }).hidden_at
  /** this person's unread notices of a room, by code */
  const notices = (roomId: string, uid: string) => (h.ctx.db.query('SELECT event_type FROM room_notices WHERE user_id = ? AND room_id = ? AND read_at IS NULL ORDER BY created_at, id').all(uid, roomId) as { event_type: string }[]).map((r) => r.event_type)
  const readAll = (c: Client, roomId: string) => c.call('POST', `/api/rooms/${roomId}/read`, { seq: 999 })
  const mine = await rooms(mia.client)
  const team = mine.find((r) => r.kind === 'team' && r.groupId === group.id)
  const all = mine.find((r) => r.kind === 'all')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const chat = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  return { owner, ada, mia, nora, otto, group, hub, rooms, roomOf, send, hide, hidden, hiddenAt, notices, readAll, team, all, dm, chat }
}

/** the index of the first event of this type for this room in a person's events (-1: none) */
const at = (evs: { type: string; data: any }[], type: string, roomId: string) => evs.findIndex((e) => e.type === type && e.data.roomId === roomId)

test('hide and show: a DM, a team room and the everyone room; a group chat is 403; the same again changes nothing; mine only; not audited', async () => {
  const { owner, mia, nora, hub, send, hide, hidden, hiddenAt, roomOf, team, all, dm, chat } = await setup()
  // nora writes twice before mia hides the DM: the badge stays the server's
  await send(nora.client, dm.id, 'one')
  await send(nora.client, dm.id, 'two')
  const audits = (h.ctx.db.query('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n
  for (const room of [dm, team, all]) {
    const r = await hide(mia.client, room.id)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: room.id, kind: room.kind, hidden: true })
    expect(await hidden(mia.client, room.id)).toBe(true)
    const when = hiddenAt(room.id, mia.id)
    expect(when).toBeTruthy()
    // the same again: still hidden, the moment kept, nothing sent
    hub.clear()
    const again = await hide(mia.client, room.id)
    expect([again.status, again.body.hidden]).toEqual([200, true])
    expect(hiddenAt(room.id, mia.id)).toBe(when)
    expect(hub.events).toEqual([])
  }
  // the others' view of the same rooms is untouched
  for (const room of [dm, team, all]) {
    expect(await hidden(nora.client, room.id)).toBe(false)
    expect(hiddenAt(room.id, nora.id)).toBeNull()
  }
  expect((await owner.call('GET', `/api/rooms/${all.id}`)).hidden).toBeUndefined()
  // hiding resets nothing: the two unread messages still count (the app leaves them out of its badges)
  expect(await roomOf(mia.client, dm.id)).toMatchObject({ hidden: true, unreadCount: 2, lastMessage: { excerpt: 'two' } })
  // shown again: the mark goes, the field is absent; the same again changes nothing and sends nothing
  for (const room of [dm, team, all]) {
    const r = await hide(mia.client, room.id, false)
    expect(r.status).toBe(200)
    expect(r.body.hidden).toBeUndefined()
    expect(hiddenAt(room.id, mia.id)).toBeNull()
    expect(await hidden(mia.client, room.id)).toBe(false)
    hub.clear()
    expect((await hide(mia.client, room.id, false)).status).toBe(200)
    expect(hub.events).toEqual([])
  }
  // a group chat is left, not hidden: 403 to hide it; showing it is nothing to do (200, nothing sent)
  hub.clear()
  expect((await hide(mia.client, chat.id)).status).toBe(403)
  expect(hiddenAt(chat.id, mia.id)).toBeNull()
  const show = await hide(mia.client, chat.id, false)
  expect(show.status).toBe(200)
  expect(show.body.hidden).toBeUndefined()
  expect(hub.events).toEqual([])
  // nobody reads it in the audit log
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n).toBe(audits)
})

test('the body is strict: hidden only, a boolean; naming someone else is refused and changes nothing', async () => {
  const { mia, nora, hiddenAt, dm } = await setup()
  for (const bad of [{ hidden: true, userId: nora.id }, {}, { hidden: 'true' }, { hidden: null }, { hidden: 1 }, { muted: true }]) {
    const r = await mia.client.try('PUT', `/api/rooms/${dm.id}/hidden`, bad)
    expect({ bad, status: r.status }).toEqual({ bad, status: 400 })
  }
  expect(hiddenAt(dm.id, mia.id)).toBeNull()
  expect(hiddenAt(dm.id, nora.id)).toBeNull()
})

test('members only: anyone outside the room gets 404 (the owner and admins too), the same as for a room that is not there', async () => {
  const { owner, ada, mia, otto, hiddenAt, dm, chat } = await setup()
  const same = (e: any) => ({ ...e, requestId: undefined })
  const none = await otto.client.try('PUT', `/api/rooms/${newId()}/hidden`, { hidden: true })
  expect(none.status).toBe(404)
  for (const c of [owner, ada.client, otto.client]) {
    for (const hidden of [true, false]) {
      const r = await c.try('PUT', `/api/rooms/${dm.id}/hidden`, { hidden })
      expect(r.status).toBe(404)
      expect(same(r.body.error)).toEqual(same(none.body.error))
    }
  }
  // a group chat they are not in: 404 as well, never the members' 403
  for (const c of [owner, ada.client]) expect((await c.try('PUT', `/api/rooms/${chat.id}/hidden`, { hidden: true })).status).toBe(404)
  expect(hiddenAt(dm.id, mia.id)).toBeNull()
  // signed out: 401
  expect((await h.client().try('PUT', `/api/rooms/${dm.id}/hidden`, { hidden: true })).status).toBe(401)
})

test('realtime: hiding and showing tell my own windows only (room.updated with the room as I see it)', async () => {
  const { mia, hub, hide, dm, team } = await setup()
  for (const room of [dm, team]) {
    hub.clear()
    await hide(mia.client, room.id)
    expect(hub.events.map((e) => [e.target, (e.data as any).type])).toEqual([[mia.id, 'room.updated']])
    expect(hub.of(mia.id)[0]!.data).toMatchObject({ roomId: room.id, change: 'updated', room: { id: room.id, hidden: true } })
    hub.clear()
    await hide(mia.client, room.id, false)
    expect(hub.events.map((e) => [e.target, (e.data as any).type])).toEqual([[mia.id, 'room.updated']])
    const back = hub.of(mia.id)[0]!.data
    expect(back).toMatchObject({ roomId: room.id, change: 'updated', room: { id: room.id } })
    expect(back.room.hidden).toBeUndefined()
  }
})

test('a DM comes back with the other person\'s message: room.updated before room.message, and a notice as usual', async () => {
  const { mia, nora, hub, send, hide, hidden, notices, readAll, dm } = await setup()
  await hide(mia.client, dm.id)
  hub.clear()
  const m = await send(nora.client, dm.id, 'are you there?')
  expect(await hidden(mia.client, dm.id)).toBe(false)
  const evs = hub.of(mia.id)
  const up = at(evs, 'room.updated', dm.id), msg = at(evs, 'room.message', dm.id)
  expect(up).toBeGreaterThanOrEqual(0)
  expect(up).toBeLessThan(msg)
  expect(evs[up]!.data).toMatchObject({ change: 'updated', room: { id: dm.id, unreadCount: 1, lastMessage: { id: m.id } } })
  expect(evs[up]!.data.room.hidden).toBeUndefined()
  // it came back before the notices were decided: hers is made, and the message says so
  expect(notices(dm.id, mia.id)).toEqual(['room.dm'])
  expect(evs[msg]!.data.notice).toBe('room.dm')
  // nora (the sender) is told nothing about mia's list
  expect(hub.of(nora.id).filter((e) => e.type === 'room.updated')).toEqual([])
  // a reply that stays in its thread is for its followers only: mia neither wrote the root nor replied, so it stays hidden
  await readAll(mia.client, dm.id)
  const root = await send(nora.client, dm.id, 'nora\'s own root')
  await readAll(mia.client, dm.id)
  await hide(mia.client, dm.id)
  hub.clear()
  await send(nora.client, dm.id, 'a note in my own thread', { threadRootId: root.id })
  expect(await hidden(mia.client, dm.id)).toBe(true)
  expect(notices(dm.id, mia.id)).toEqual([])
  expect(hub.of(mia.id).filter((e) => e.type === 'room.updated')).toEqual([])
  // the same reply sent to the room too is a message of the DM: back
  await send(nora.client, dm.id, 'and to the room', { threadRootId: root.id, alsoInRoom: true })
  expect(await hidden(mia.client, dm.id)).toBe(false)
  expect(notices(dm.id, mia.id)).toEqual(['room.dm'])
})

test('a team room and the everyone room come back with a mention of me, not with a plain message', async () => {
  const { mia, nora, otto, hub, send, hide, hidden, notices, team, all } = await setup()
  for (const room of [team, all]) {
    await hide(nora.client, room.id)
    hub.clear()
    await send(mia.client, room.id, 'for everyone')
    expect(await hidden(nora.client, room.id)).toBe(true)
    expect(hub.of(nora.id).filter((e) => e.type === 'room.updated')).toEqual([])
    // a mention of someone else does not bring it back for me
    await send(mia.client, room.id, '@OTTO look', { mentions: [otto.id] })
    expect(await hidden(nora.client, room.id)).toBe(true)
    hub.clear()
    await send(mia.client, room.id, '@NORA look', { mentions: [nora.id] })
    expect(await hidden(nora.client, room.id)).toBe(false)
    const evs = hub.of(nora.id)
    expect(at(evs, 'room.updated', room.id)).toBeGreaterThanOrEqual(0)
    expect(at(evs, 'room.updated', room.id)).toBeLessThan(at(evs, 'room.message', room.id))
    expect(notices(room.id, nora.id)).toEqual(['room.mention'])
  }
})

test('a plain message in a hidden team room brings nothing, even at 모든 메시지: no notice, the badge still counts', async () => {
  const { mia, nora, hub, send, hide, hidden, notices, readAll, roomOf, team } = await setup()
  await nora.client.call('PATCH', `/api/rooms/${team.id}`, { notifyLevel: 'all' })
  // at 모든 메시지 a plain message notifies her while the room is shown
  await send(mia.client, team.id, 'shown: noticed')
  expect(notices(team.id, nora.id)).toEqual(['room.dm'])
  await readAll(nora.client, team.id)
  expect(notices(team.id, nora.id)).toEqual([])
  await hide(nora.client, team.id)
  hub.clear()
  await send(mia.client, team.id, 'hidden: one')
  await send(mia.client, team.id, 'hidden: two')
  expect(await hidden(nora.client, team.id)).toBe(true)
  expect(notices(team.id, nora.id)).toEqual([])
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE user_id = ? AND room_id = ?').get(nora.id, team.id) as { n: number }).n).toBe(1)
  // her windows still get the messages (the app keeps the room up to date), with no notice and no room.updated
  const evs = hub.of(nora.id)
  expect(evs.filter((e) => e.type === 'room.message').map((e) => e.data.notice)).toEqual([undefined, undefined])
  expect(evs.filter((e) => e.type === 'room.updated')).toEqual([])
  expect(await roomOf(nora.client, team.id)).toMatchObject({ hidden: true, unreadCount: 2, notify: { level: 'all' } })
  // the default 모든 새 메시지 does not either
  await nora.client.call('PATCH', `/api/rooms/${team.id}`, { notifyLevel: null })
  await nora.client.call('PATCH', '/api/notification-preferences', { roomLevel: 'all' })
  await send(mia.client, team.id, 'hidden: three')
  expect(await hidden(nora.client, team.id)).toBe(true)
  expect(notices(team.id, nora.id)).toEqual([])
  // shown again by hand: the next message notifies as before
  await hide(nora.client, team.id, false)
  await send(mia.client, team.id, 'shown again')
  expect(notices(team.id, nora.id)).toEqual(['room.dm'])
})

test('an event line never brings a room back (a rename of the everyone room; a group chat\'s rename, should one be hidden)', async () => {
  const { owner, mia, nora, hub, send, hide, hidden, hiddenAt, notices, all, chat } = await setup()
  await hide(nora.client, all.id)
  hub.clear()
  await owner.call('PATCH', `/api/rooms/${all.id}`, { name: '우리 회사' })
  expect(await hidden(nora.client, all.id)).toBe(true)
  // the rename's room.updated reaches her as she sees the room: still hidden
  const up = hub.of(nora.id).find((e) => e.type === 'room.updated')
  expect(up?.data.room).toMatchObject({ name: '우리 회사', hidden: true })
  // a group chat cannot be hidden through the API; one marked so (an older or newer build) still follows the rules: its
  // event lines do not bring it back, a message of its timeline does
  h.ctx.db.query('UPDATE room_members SET hidden_at = ? WHERE room_id = ? AND user_id = ?').run(new Date().toISOString(), chat.id, nora.id)
  expect(await hidden(nora.client, chat.id)).toBe(true)
  await mia.client.call('PATCH', `/api/rooms/${chat.id}`, { name: 'Plan' })
  expect(hiddenAt(chat.id, nora.id)).toBeTruthy()
  expect(notices(chat.id, nora.id)).toEqual([])
  await send(mia.client, chat.id, 'a real message')
  expect(hiddenAt(chat.id, nora.id)).toBeNull()
  expect(notices(chat.id, nora.id)).toEqual(['room.dm'])
})

test('a reply in a thread I follow brings a team room back; one in a thread I do not follow does not, even sent to the room too', async () => {
  const { mia, nora, otto, hub, send, hide, hidden, notices, team } = await setup()
  // nora wrote the root: she follows its thread from its first reply on
  const root = await send(nora.client, team.id, 'ROOT by nora')
  await hide(nora.client, team.id)
  await hide(otto.client, team.id)
  hub.clear()
  await send(mia.client, team.id, 'first reply', { threadRootId: root.id })
  expect(await hidden(nora.client, team.id)).toBe(false)
  const evs = hub.of(nora.id)
  expect(at(evs, 'room.updated', team.id)).toBeLessThan(at(evs, 'room.message', team.id))
  expect(notices(team.id, nora.id)).toEqual(['room.dm'])
  // otto follows nothing there: stays hidden, nothing for him
  expect(await hidden(otto.client, team.id)).toBe(true)
  expect(notices(team.id, otto.id)).toEqual([])
  await send(mia.client, team.id, 'second reply, to the room too', { threadRootId: root.id, alsoInRoom: true })
  expect(await hidden(otto.client, team.id)).toBe(true)
  expect(notices(team.id, otto.id)).toEqual([])
  // once he replies he follows; hidden again, the next reply brings it back
  await send(otto.client, team.id, 'otto replies', { threadRootId: root.id })
  await hide(otto.client, team.id)
  await send(mia.client, team.id, 'third reply', { threadRootId: root.id })
  expect(await hidden(otto.client, team.id)).toBe(false)
  // a mention in a reply brings back someone who did not follow before
  const root2 = await send(mia.client, team.id, 'ROOT 2 by mia')
  await hide(otto.client, team.id)
  await send(nora.client, team.id, 'plain reply', { threadRootId: root2.id })
  expect(await hidden(otto.client, team.id)).toBe(true)
  await send(nora.client, team.id, '@OTTO here', { threadRootId: root2.id, mentions: [otto.id] })
  expect(await hidden(otto.client, team.id)).toBe(false)
})

test('my own message brings my hidden room back (the timeline or a thread), room.updated before room.message', async () => {
  const { mia, nora, hub, send, hide, hidden, team, dm } = await setup()
  for (const room of [team, dm]) {
    await hide(mia.client, room.id)
    await hide(nora.client, room.id)
    hub.clear()
    const m = await send(mia.client, room.id, 'I write here')
    expect(await hidden(mia.client, room.id)).toBe(false)
    const evs = hub.of(mia.id)
    expect(at(evs, 'room.updated', room.id)).toBeGreaterThanOrEqual(0)
    expect(at(evs, 'room.updated', room.id)).toBeLessThan(at(evs, 'room.message', room.id))
    // nora: back in a DM (a message for her), still hidden in the team room
    expect(await hidden(nora.client, room.id)).toBe(room.kind !== 'dm')
    await hide(mia.client, room.id)
    await send(mia.client, room.id, 'my reply', { threadRootId: m.id })
    expect(await hidden(mia.client, room.id)).toBe(false)
  }
})

test('a posted AI answer brings the room back for the person who asked; notify() leaves a private one alone (RoomAi.ended shows it to the asker: b-rooms-ai)', async () => {
  const { nora, otto, hide, hidden, hiddenAt, team } = await setup()
  const put = (visibility: 'room' | 'private') => {
    const id = newId()
    h.ctx.db.transaction(() => {
      const seq = (h.ctx.db.query('UPDATE rooms SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq').get(team.id) as { last_seq: number }).last_seq
      h.ctx.db.query("INSERT INTO room_messages (id, room_id, seq, author_kind, asked_by, visibility, visible_to, body, mentions, created_at) VALUES (?, ?, ?, 'ai', ?, ?, ?, 'THE ANSWER', '[]', ?)")
        .run(id, team.id, seq, nora.id, visibility, visibility === 'private' ? nora.id : null, new Date().toISOString())
    })()
    // what the AI does once its answer is stored (rooms/ai.ts): notify, then room.message
    roomsOf(h.ctx).notify(messageRow(h.ctx.db, team.id, id)!)
  }
  await hide(nora.client, team.id)
  await hide(otto.client, team.id)
  put('private')
  expect(await hidden(nora.client, team.id)).toBe(true)
  put('room')
  expect(await hidden(nora.client, team.id)).toBe(false)
  expect(hiddenAt(team.id, otto.id)).toBeTruthy()
})

test('a card of my question to the AI opening brings the room back (rooms/ai.ts waiting); a card closing does not', async () => {
  const { nora, hub, hide, hidden, team } = await setup()
  // the card's state is the chat runtime's (tests/unit/b-rooms-ai.test.ts drives a real one); here it is given
  const ai = roomAiOf(h.ctx)
  const waitsFor = ai.waitsFor
  try {
    await hide(nora.client, team.id)
    ai.waitsFor = () => false
    hub.clear()
    ai.waiting({ roomId: team.id, userId: nora.id, opened: true })
    expect(await hidden(nora.client, team.id)).toBe(true)
    expect(hub.events.map((e) => [e.target, (e.data as any).type])).toEqual([[nora.id, 'room.updated']])
    // a card closing while another of hers still waits brings nothing
    ai.waitsFor = () => true
    hub.clear()
    ai.waiting({ roomId: team.id, userId: nora.id, opened: false })
    expect(await hidden(nora.client, team.id)).toBe(true)
    hub.clear()
    ai.waiting({ roomId: team.id, userId: nora.id, opened: true })
    expect(await hidden(nora.client, team.id)).toBe(false)
    // one room.updated, to her only, with the room shown and waiting
    expect(hub.events.map((e) => [e.target, (e.data as any).type])).toEqual([[nora.id, 'room.updated']])
    const room = hub.of(nora.id)[0]!.data.room
    expect(room.hidden).toBeUndefined()
    expect(room.aiWaits).toBe(true)
  } finally { ai.waitsFor = waitsFor }
})

test('a push that waits is not sent once I hide the room; shown again, it may go', async () => {
  const { mia, nora, send, hide, dm } = await setup()
  await send(nora.client, dm.id, 'are you there?')
  const id = (h.ctx.db.query('SELECT id FROM room_notices WHERE user_id = ? AND room_id = ? AND read_at IS NULL').get(mia.id, dm.id) as { id: string }).id
  expect(noticeWanted(h.ctx.db, id)).toBe(true)
  expect((await hide(mia.client, dm.id)).status).toBe(200)
  expect(noticeWanted(h.ctx.db, id)).toBe(false)
  expect((await hide(mia.client, dm.id, false)).status).toBe(200)
  expect(noticeWanted(h.ctx.db, id)).toBe(true)
})

test('opening the DM again shows it for me (POST /api/rooms), not for the other person', async () => {
  const { mia, nora, hub, hide, hidden, dm } = await setup()
  await hide(mia.client, dm.id)
  await hide(nora.client, dm.id)
  hub.clear()
  const opened = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  expect(opened.id).toBe(dm.id)
  expect(opened.hidden).toBeUndefined()
  expect(await hidden(mia.client, dm.id)).toBe(false)
  expect(await hidden(nora.client, dm.id)).toBe(true)
  expect(hub.events.map((e) => [e.target, (e.data as any).type])).toEqual([[mia.id, 'room.updated']])
  // opened when shown: nothing to send
  hub.clear()
  await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  expect(hub.events).toEqual([])
})

test('the AI chat\'s room list says which rooms the user hid (rooms/reader.ts listRooms)', async () => {
  const { mia, nora, hide, team, dm } = await setup()
  await hide(mia.client, dm.id)
  const line = (uid: string, roomId: string, ref?: string) => listRooms(h.ctx.db, uid, 'UTC', ref).text.split('\n').find((l) => l.includes(`room_id=${roomId}`))
  expect(line(mia.id, dm.id)).toContain(', hidden by the user')
  expect(line(mia.id, team.id)).not.toContain('hidden')
  expect(line(nora.id, dm.id)).not.toContain('hidden')
  // narrowed to the room (by id), the same
  expect(line(mia.id, dm.id, dm.id)).toContain(', hidden by the user')
  await hide(mia.client, dm.id, false)
  expect(line(mia.id, dm.id)).not.toContain('hidden')
})

test('migration 260 is additive (reader 1): one nullable column, an older build reads the database as before', async () => {
  h = await harness('b-rooms-hide-reader')
  const m = readMigrations().find((x) => x.name === '260_b_room_hidden.sql')!
  expect(m.minCompatibleReader).toBe(1)
  expect(m.sql).toMatch(/^-- min_compatible_reader: 1$/m)
  expect(m.sql).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME/i)
  const statements = m.sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
  expect(statements).toEqual(['ALTER TABLE room_members ADD COLUMN hidden_at TEXT'])
  // a database with 258 asks no more of its reader than one without it
  const before = Math.max(...readMigrations().filter((x) => x.version < 260).map((x) => x.minCompatibleReader))
  const dir = path.join(h.ctx.config.dataDir, 'with-hidden')
  fs.mkdirSync(dir, { recursive: true })
  for (const x of readMigrations()) if (x.version <= 258) fs.writeFileSync(path.join(dir, x.name), x.sql)
  const file = path.join(h.ctx.config.dataDir, 'hidden.db')
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true })
  // a bare file (openDb would apply every migration of this build)
  const db = new Database(file)
  try {
    expect(() => migrate(db, { migrationsDir: dir, readerLevel: before })).not.toThrow()
    expect(db.query("SELECT \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('room_members') WHERE name = 'hidden_at'").get()).toEqual({ nn: 0, d: null })
  } finally { db.close() }
})
