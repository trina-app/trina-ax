// "@전체" in rooms (docs/DECISIONS.md "@전체"): a message sent with mentionsAll mentions every member who can see it but its
// sender. It notifies as a mention under every level but 끄기 (and 받지 않음 without a room level of its own), quiet hours
// keep its push back, a reply in a thread reaches the members who can see the thread, the everyone room takes it from
// owners and admins only, and only the flag notifies: "@전체" as text is text.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { roomsOf } from '../../server/src/rooms/service'
import { noticeWanted } from '../../server/src/rooms/alerts'
import { zonedClock } from '../../shared/src/api/room-alerts'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup() {
  h = await harness('b-rooms-mention-all')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id, otto.id] })
  // these tests send many messages: the sending budget's clock moves 2 s a send (the budget is tested in b-rooms)
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 2000)
  const rooms = async (c: Client) => (await c.call('GET', '/api/rooms')).items as any[]
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const trySend = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.try('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const mine = await rooms(mia.client)
  const team = mine.find((r) => r.kind === 'team' && r.groupId === group.id)
  const all = mine.find((r) => r.kind === 'all')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const chat = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  /** someone's unread notices of a room, by code (quiet ones marked) */
  const notices = (roomId: string, uid: string) => (h.ctx.db.query('SELECT event_type, quiet FROM room_notices WHERE user_id = ? AND room_id = ? AND read_at IS NULL ORDER BY created_at, id').all(uid, roomId) as { event_type: string; quiet: number }[])
    .map((r) => r.event_type + (r.quiet ? ' (quiet)' : ''))
  const readAll = async (roomId: string, ...cs: Client[]) => { for (const c of cs) await c.call('POST', `/api/rooms/${roomId}/read`, { seq: 999 }) }
  const prefs = (c: Client, body: Record<string, unknown>) => c.call('PATCH', '/api/notification-preferences', body)
  const level = (c: Client, roomId: string, notifyLevel: string | null) => c.call('PATCH', `/api/rooms/${roomId}`, { notifyLevel })
  return { owner, ada, mia, nora, otto, group, rooms, send, trySend, team, all, dm, chat, notices, readAll, prefs, level }
}

test('every member who can see it gets a mention, also where only mentions alert; never the sender; "@전체" as text is text', async () => {
  const { mia, nora, otto, rooms, send, team, chat, dm, notices, readAll } = await setup()
  // a team room alerts only mentions by default: the flag makes it one for each of them
  const m = await send(mia.client, team.id, '@전체 3시에 회의해요', { mentionsAll: true })
  expect(m).toMatchObject({ body: '@전체 3시에 회의해요', mentions: [], mentionsAll: true })
  expect([notices(team.id, nora.id), notices(team.id, otto.id), notices(team.id, mia.id)]).toEqual([['room.mention'], ['room.mention'], []])
  // the rooms list says it mentions them (the "@" badge), not the sender
  expect((await rooms(nora.client)).find((r) => r.id === team.id)).toMatchObject({ mentioned: true, unreadCount: 1 })
  expect((await rooms(mia.client)).find((r) => r.id === team.id)).toMatchObject({ mentioned: false })
  // each of them reads it back with the flag
  const page = await nora.client.call('GET', `/api/rooms/${team.id}/messages`)
  expect(page.items.at(-1)).toMatchObject({ id: m.id, mentionsAll: true })
  // text that only looks like it notifies nobody there
  await readAll(team.id, nora.client, otto.client)
  const plain = await send(mia.client, team.id, '@전체 (붙여 넣은 글)')
  expect(plain.mentionsAll).toBeUndefined()
  expect([notices(team.id, nora.id), notices(team.id, otto.id)]).toEqual([[], []])
  expect((await rooms(nora.client)).find((r) => r.id === team.id)).toMatchObject({ mentioned: false })
  // a group chat: a mention instead of the plain message notice
  await send(mia.client, chat.id, '@전체 다들 확인', { mentionsAll: true })
  expect([notices(chat.id, nora.id), notices(chat.id, otto.id), notices(chat.id, mia.id)]).toEqual([['room.mention'], ['room.mention'], []])
  // a DM: the other person
  await send(mia.client, dm.id, '@전체 hi', { mentionsAll: true })
  expect([notices(dm.id, nora.id), notices(dm.id, mia.id)]).toEqual([['room.mention'], []])
})

test('levels: 멘션만 and the defaults alert it; 끄기 and 받지 않음 do not, unless the room\'s own level says so', async () => {
  const { mia, nora, otto, send, team, chat, notices, readAll, prefs, level } = await setup()
  await level(nora.client, chat.id, 'mentions')
  await level(otto.client, chat.id, 'off')
  await send(mia.client, chat.id, '@전체 a', { mentionsAll: true })
  expect([notices(chat.id, nora.id), notices(chat.id, otto.id)]).toEqual([['room.mention'], []])
  // 받지 않음 is 끄기 for every room without a level of its own …
  await readAll(team.id, nora.client)
  await prefs(nora.client, { roomLevel: 'none' })
  await send(mia.client, team.id, '@전체 b', { mentionsAll: true })
  expect(notices(team.id, nora.id)).toEqual([])
  // … and a room's own level wins over it
  await level(nora.client, team.id, 'mentions')
  await send(mia.client, team.id, '@전체 c', { mentionsAll: true })
  expect(notices(team.id, nora.id)).toEqual(['room.mention'])
  // its push is checked again before it goes: still wanted at 멘션만, not once the room is 끄기
  const id = (h.ctx.db.query("SELECT id FROM room_notices WHERE user_id = ? AND room_id = ? AND read_at IS NULL").get(nora.id, team.id) as { id: string }).id
  expect(noticeWanted(h.ctx.db, id)).toBe(true)
  await level(nora.client, team.id, 'off')
  expect(noticeWanted(h.ctx.db, id)).toBe(false)
})

test('the everyone room: owners and admins only (403 for a member, in a send and in an edit); a member keeps nothing there', async () => {
  const { owner, ada, mia, nora, send, trySend, all, notices } = await setup()
  const refused = await trySend(mia.client, all.id, '@전체 공지', { mentionsAll: true })
  expect(refused.status).toBe(403)
  expect(refused.body.error).toMatchObject({ code: 'forbidden', params: { reason: 'room_mention_all' } })
  expect(h.ctx.db.query("SELECT COUNT(*) n FROM room_messages WHERE room_id = ? AND body = '@전체 공지'").get(all.id)).toEqual({ n: 0 })
  // an admin and the owner may: everyone else in it gets a mention (the default for the everyone room alerts only those)
  await send(ada.client, all.id, '@전체 공지입니다', { mentionsAll: true })
  expect([notices(all.id, nora.id), notices(all.id, mia.id), notices(all.id, 'olga'), notices(all.id, ada.id)]).toEqual([['room.mention'], ['room.mention'], ['room.mention'], []])
  await send(owner, all.id, '@전체 또 공지', { mentionsAll: true })
  // a member cannot add it to their message there in an edit either; without it the edit goes through
  const plain = await send(mia.client, all.id, '공지 아님')
  expect((await mia.client.try('PATCH', `/api/rooms/${all.id}/messages/${plain.id}`, { body: '@전체 공지 아님', mentionsAll: true })).status).toBe(403)
  expect(await mia.client.call('PATCH', `/api/rooms/${all.id}/messages/${plain.id}`, { body: '공지 아님 (고침)' })).toMatchObject({ body: '공지 아님 (고침)' })
  // an admin's edit keeps it, or takes it out; an edit notifies nobody
  const msg = await send(ada.client, all.id, '@전체 하나 더', { mentionsAll: true })
  const before = (h.ctx.db.query('SELECT COUNT(*) n FROM room_notices').get() as { n: number }).n
  expect(await ada.client.call('PATCH', `/api/rooms/${all.id}/messages/${msg.id}`, { body: '@전체 하나 더 (고침)', mentionsAll: true })).toMatchObject({ mentionsAll: true })
  const off = await ada.client.call('PATCH', `/api/rooms/${all.id}/messages/${msg.id}`, { body: '하나 더 (고침)' })
  expect(off.mentionsAll).toBeUndefined()
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_notices').get() as { n: number }).n).toBe(before)
})

test('a thread: the members who can see the thread (not someone who joined after its root), no one starts following it', async () => {
  const { owner, mia, nora, otto, send, chat, notices, readAll } = await setup()
  const root = await send(mia.client, chat.id, 'the root')
  // pia joins the group chat after the root: she sees nothing of its thread
  const pia = await addMember(h, owner, { username: 'pia' })
  await mia.client.call('POST', `/api/rooms/${chat.id}/members`, { userIds: [pia.id] })
  await readAll(chat.id, mia.client, nora.client, otto.client, pia.client)
  const follows = () => (h.ctx.db.query('SELECT user_id FROM room_thread_follows WHERE root_id = ? ORDER BY user_id').all(root.id) as { user_id: string }[]).map((r) => r.user_id)
  await send(nora.client, chat.id, '@전체 보세요', { mentionsAll: true, threadRootId: root.id })
  expect([notices(chat.id, mia.id), notices(chat.id, otto.id), notices(chat.id, pia.id), notices(chat.id, nora.id)]).toEqual([['room.mention'], ['room.mention'], [], []])
  // the reply's author and the root's author follow it, as with any reply; "@전체" adds nobody
  expect(follows()).toEqual([mia.id, nora.id].sort())
  // a new member of the room afterwards gets nothing of an earlier one
  const quinn = await addMember(h, owner, { username: 'quinn' })
  await mia.client.call('POST', `/api/rooms/${chat.id}/members`, { userIds: [quinn.id] })
  expect(notices(chat.id, quinn.id)).toEqual([])
})

test('quiet hours: the mention is kept but quiet (no push); someone not in the room gets nothing', async () => {
  const { owner, mia, nora, otto, send, team, notices, prefs } = await setup()
  updateTeamSettings(h.ctx.db, { timeZone: 'Asia/Seoul' })
  const m = zonedClock(Date.now(), 'Asia/Seoul').minute
  const hhmm = (x: number) => { const v = ((x % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}` }
  await prefs(nora.client, { quietHours: { on: true, start: hhmm(m - 60), end: hhmm(m + 60), weekends: false } })
  // owner is in the everyone room but not in this team room
  await send(mia.client, team.id, '@전체 밤에도', { mentionsAll: true })
  expect([notices(team.id, nora.id), notices(team.id, otto.id), notices(team.id, 'olga')]).toEqual([['room.mention (quiet)'], ['room.mention'], []])
  const quiet = (h.ctx.db.query('SELECT id FROM room_notices WHERE user_id = ? AND room_id = ?').get(nora.id, team.id) as { id: string }).id
  expect(noticeWanted(h.ctx.db, quiet)).toBe(false)
  expect((await owner.try('GET', `/api/rooms/${team.id}/messages`)).status).toBe(404)
})
