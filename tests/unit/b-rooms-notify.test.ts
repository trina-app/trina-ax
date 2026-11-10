// Room notification settings (docs/DECISIONS.md "대화방 알림 설정"): my default for rooms (1:1·그룹 대화와 나를 멘션한 메시지 /
// 모든 새 메시지 / 받지 않음), replies in threads I follow, quiet hours in the team's time zone, and each room's own level
// (기본값 / 모든 메시지 / 멘션만 / 끄기). The same rule makes the notices, the pushes and (in the web app) the sound:
// these tests go through the API, the notices and the push service; the rule itself is tests/unit/room-alerts.test.ts.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { notificationsOf } from '../../server/src/notifications/service'
import { roomsOf } from '../../server/src/rooms/service'
import { noticeWanted } from '../../server/src/rooms/alerts'
import { zonedClock } from '../../shared/src/api/room-alerts'
import { addMember, harness, RecordingHub, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })

/** Records what each listed person would receive (publishEach builds per person, like the real hub). */
class FanoutHub extends RecordingHub {
  users: string[] = []
  override publishEach(build: (userId: string) => unknown) {
    for (const u of this.users) { const ev = build(u); if (ev) this.events.push({ kind: 'publish', target: u, data: ev }) }
  }
  clear() { this.events = []; this.forgotten = [] }
}
const cm = () => 'cm-' + crypto.randomUUID()

async function setup() {
  h = await harness('b-rooms-notify')
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
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const mine = await rooms(mia.client)
  const team = mine.find((r) => r.kind === 'team' && r.groupId === group.id)
  const all = mine.find((r) => r.kind === 'all')
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const chat = await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [nora.id, otto.id] })
  /** nora's unread notices of a room, by code (quiet ones marked) */
  const notices = (roomId: string, uid = nora.id) => (h.ctx.db.query('SELECT event_type, quiet FROM room_notices WHERE user_id = ? AND room_id = ? AND read_at IS NULL ORDER BY created_at, id').all(uid, roomId) as { event_type: string; quiet: number }[])
    .map((r) => r.event_type + (r.quiet ? ' (quiet)' : ''))
  /** read everything of a room as nora (the next notice of a run is new) */
  const readAll = async (roomId: string, c: Client = nora.client) => { await c.call('POST', `/api/rooms/${roomId}/read`, { seq: 999 }) }
  const prefs = (c: Client, body: Record<string, unknown>) => c.call('PATCH', '/api/notification-preferences', body)
  const level = (c: Client, roomId: string, notifyLevel: string | null) => c.call('PATCH', `/api/rooms/${roomId}`, { notifyLevel })
  return { owner, ada, mia, nora, otto, group, hub, rooms, send, team, all, dm, chat, notices, readAll, prefs, level }
}

/** A window of quiet hours that holds `now` in `tz` (an hour either side), and one that does not. */
function windowAround(now: number, tz: string, inside = true) {
  const m = zonedClock(now, tz).minute
  const hhmm = (x: number) => { const v = ((x % 1440) + 1440) % 1440; return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}` }
  return inside ? { on: true, start: hhmm(m - 60), end: hhmm(m + 60), weekends: false } : { on: true, start: hhmm(m + 120), end: hhmm(m + 180), weekends: false }
}

test('preferences: the room default, thread replies and quiet hours; strict; the older apps\' roomMessages follows', async () => {
  const { nora, prefs } = await setup()
  const got = await nora.client.call('GET', '/api/notification-preferences')
  expect(got).toEqual({
    scheduleSuccess: true, scheduleFailure: true, connectionReconnect: true, skillSuggestions: true,
    roomMessages: true, roomLevel: 'direct', roomThreadReplies: true, messagePreview: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false },
  })
  // the message preview (default on) is saved like the rest
  expect(await prefs(nora.client, { messagePreview: false })).toMatchObject({ messagePreview: false })
  expect(h.ctx.db.query('SELECT message_preview FROM notification_preferences WHERE user_id = ?').get(nora.id)).toEqual({ message_preview: 0 })
  expect(await prefs(nora.client, { messagePreview: true })).toMatchObject({ messagePreview: true })
  expect(await prefs(nora.client, { roomLevel: 'all', roomThreadReplies: false, quietHours: { on: true, start: '23:30', end: '07:15', weekends: true } }))
    .toMatchObject({ roomLevel: 'all', roomMessages: true, roomThreadReplies: false, quietHours: { on: true, start: '23:30', end: '07:15', weekends: true } })
  expect(h.ctx.db.query('SELECT room_level, room_messages, room_thread_replies, quiet_on, quiet_start, quiet_end, quiet_weekends FROM notification_preferences WHERE user_id = ?').get(nora.id))
    .toEqual({ room_level: 'all', room_messages: 1, room_thread_replies: 0, quiet_on: 1, quiet_start: 23 * 60 + 30, quiet_end: 7 * 60 + 15, quiet_weekends: 1 })
  // strict: nothing else, quiet hours whole and valid
  for (const bad of [
    { roomLevel: 'everything' }, { roomLevel: 'mentions' }, { quietHours: { on: true, start: '22:00', end: '22:00', weekends: false } },
    { quietHours: { on: true, start: '22:00' } }, { quietHours: { on: true, start: '25:00', end: '08:00', weekends: false } },
    { quietHours: { on: true, start: '22:00', end: '08:00', weekends: false, timeZone: 'UTC' } }, { timeZone: 'UTC' }, { roomThreadReplies: 'yes' },
  ]) expect({ bad, status: (await nora.client.try('PATCH', '/api/notification-preferences', bad)).status }).toEqual({ bad, status: 400 })
  // the older apps' one switch: off is 받지 않음, on brings 받지 않음 back to the default and leaves 모든 새 메시지 alone
  expect(await prefs(nora.client, { roomMessages: false })).toMatchObject({ roomMessages: false, roomLevel: 'none' })
  expect(await prefs(nora.client, { roomMessages: true })).toMatchObject({ roomMessages: true, roomLevel: 'direct' })
  await prefs(nora.client, { roomLevel: 'all' })
  expect(await prefs(nora.client, { roomMessages: true })).toMatchObject({ roomLevel: 'all' })
  // roomLevel wins when both come
  expect(await prefs(nora.client, { roomMessages: false, roomLevel: 'direct' })).toMatchObject({ roomLevel: 'direct', roomMessages: true })
  // an older build changes room_messages only: it is the source of truth for 받지 않음
  h.ctx.db.query('UPDATE notification_preferences SET room_messages = 0 WHERE user_id = ?').run(nora.id)
  expect(await nora.client.call('GET', '/api/notification-preferences')).toMatchObject({ roomLevel: 'none', roomMessages: false })
  h.ctx.db.query("UPDATE notification_preferences SET room_messages = 1, room_level = 'none' WHERE user_id = ?").run(nora.id)
  expect(await nora.client.call('GET', '/api/notification-preferences')).toMatchObject({ roomLevel: 'direct', roomMessages: true })
})

test('migration 255: someone who had turned room messages off is 받지 않음; a muted room is 끄기', async () => {
  const { nora, dm, rooms } = await setup()
  // what 255 did to rows written before it (the same UPDATEs, run again on rows put back the way an older build left them)
  h.ctx.db.query("INSERT INTO notification_preferences(user_id, room_messages, room_level) VALUES(?, 0, 'direct') ON CONFLICT(user_id) DO UPDATE SET room_messages = 0, room_level = 'direct'").run(nora.id)
  h.ctx.db.query('UPDATE room_members SET muted = 1, notify_level = NULL WHERE room_id = ? AND user_id = ?').run(dm.id, nora.id)
  const sql = await Bun.file(new URL('../../server/migrations/255_b_room_notify_prefs.sql', import.meta.url)).text()
  for (const stmt of sql.split(';').map((x) => x.replace(/^(\s*--.*\n)+/g, '').trim()).filter((x) => x.startsWith('UPDATE'))) h.ctx.db.exec(stmt)
  expect(h.ctx.db.query('SELECT room_level FROM notification_preferences WHERE user_id = ?').get(nora.id)).toEqual({ room_level: 'none' })
  expect(h.ctx.db.query('SELECT notify_level FROM room_members WHERE room_id = ? AND user_id = ?').get(dm.id, nora.id)).toEqual({ notify_level: 'off' })
  expect((await rooms(nora.client)).find((r) => r.id === dm.id)).toMatchObject({ muted: true, notify: { own: 'off', byDefault: 'off', level: 'off' } })
  // an older build unmutes (muted only): the room is back on the default, whatever notify_level still says
  h.ctx.db.query('UPDATE room_members SET muted = 0 WHERE room_id = ? AND user_id = ?').run(dm.id, nora.id)
  expect((await rooms(nora.client)).find((r) => r.id === dm.id).notify).toEqual({ own: null, byDefault: 'off', level: 'off' })
})

test('a room\'s own level: PATCH notifyLevel (members only, strict), muted in step, what the list and the events say', async () => {
  const { owner, ada, nora, otto, hub, rooms, dm, team, chat, level } = await setup()
  const list = await nora.client.call('GET', '/api/rooms')
  expect(list.alerts).toEqual({ threadReplies: true, quietHours: { on: false, start: '22:00', end: '08:00', weekends: false }, timeZone: expect.any(String), messagePreview: true })
  const of = (id: string) => list.items.find((r: any) => r.id === id)
  expect(of(dm.id).notify).toEqual({ own: null, byDefault: 'all', level: 'all' })
  expect(of(chat.id).notify).toEqual({ own: null, byDefault: 'all', level: 'all' })
  expect(of(team.id).notify).toEqual({ own: null, byDefault: 'mentions', level: 'mentions' })
  hub.clear()
  expect(await level(nora.client, team.id, 'all')).toMatchObject({ muted: false, notify: { own: 'all', byDefault: 'mentions', level: 'all' } })
  // only my own windows hear of it
  const updates = hub.events.filter((e) => (e.data as any).type === 'room.updated')
  expect(updates.map((e) => e.target)).toEqual([nora.id])
  expect((await level(nora.client, team.id, 'off')).muted).toBe(true)
  expect(h.ctx.db.query('SELECT muted, notify_level FROM room_members WHERE room_id = ? AND user_id = ?').get(team.id, nora.id)).toEqual({ muted: 1, notify_level: 'off' })
  expect(await level(nora.client, team.id, null)).toMatchObject({ muted: false, notify: { own: null, level: 'mentions' } })
  expect(h.ctx.db.query('SELECT muted, notify_level FROM room_members WHERE room_id = ? AND user_id = ?').get(team.id, nora.id)).toEqual({ muted: 0, notify_level: null })
  // the older apps' muted: true is 끄기, false brings 끄기 back to the default and leaves another level alone
  expect((await nora.client.call('PATCH', `/api/rooms/${dm.id}`, { muted: true })).notify).toMatchObject({ own: 'off', level: 'off' })
  expect((await nora.client.call('PATCH', `/api/rooms/${dm.id}`, { muted: false })).notify).toMatchObject({ own: null, level: 'all' })
  await level(nora.client, dm.id, 'mentions')
  expect((await nora.client.call('PATCH', `/api/rooms/${dm.id}`, { muted: false })).notify).toMatchObject({ own: 'mentions' })
  // strict: one of them, a known level
  expect((await nora.client.try('PATCH', `/api/rooms/${dm.id}`, { muted: true, notifyLevel: 'all' })).status).toBe(400)
  expect((await nora.client.try('PATCH', `/api/rooms/${dm.id}`, { notifyLevel: 'loud' })).status).toBe(400)
  expect((await nora.client.try('PATCH', `/api/rooms/${dm.id}`, { notifyLevel: 'all', userId: otto.id })).status).toBe(400)
  // not a member: 404, admins and the owner included; my setting is mine only
  for (const c of [owner, ada.client, otto.client]) expect((await c.try('PATCH', `/api/rooms/${dm.id}`, { notifyLevel: 'off' })).status).toBe(404)
  expect((await rooms(otto.client)).find((r) => r.id === chat.id).notify).toEqual({ own: null, byDefault: 'all', level: 'all' })
  // my default moves every room without a level of its own (and says so to my windows only)
  hub.clear()
  await nora.client.call('PATCH', '/api/notification-preferences', { roomLevel: 'all' })
  expect(hub.events.filter((e) => (e.data as any).data?.code === 'room_alerts_changed').map((e) => e.target)).toEqual([nora.id])
  const after = await rooms(nora.client)
  expect(after.find((r) => r.id === team.id).notify).toEqual({ own: null, byDefault: 'all', level: 'all' })
  expect(after.find((r) => r.id === dm.id).notify).toEqual({ own: 'mentions', byDefault: 'all', level: 'mentions' })
  // a change of something else says nothing about rooms
  hub.clear()
  await nora.client.call('PATCH', '/api/notification-preferences', { scheduleSuccess: false })
  expect(hub.events.filter((e) => (e.data as any).data?.code === 'room_alerts_changed')).toEqual([])
  // a new team time zone: everyone's windows read their rooms' alerts again (the quiet hours are read in it)
  await owner.call('PATCH', '/api/admin/settings', { timeZone: 'Asia/Tokyo' })
  expect(hub.events.filter((e) => (e.data as any).data?.code === 'room_alerts_changed').map((e) => e.target).sort()).toEqual(['olga', ada.id, nora.id, otto.id, hub.users[2]].sort())
  expect((await nora.client.call('GET', '/api/rooms')).alerts.timeZone).toBe('Asia/Tokyo')
})

test('notices: my default × room kinds × mentions, and each room\'s own level winning over it', async () => {
  const { mia, nora, send, team, all, dm, chat, notices, readAll, prefs, level } = await setup()
  const fresh = async () => { for (const r of [team, all, dm, chat]) await readAll(r.id) }
  const each = async () => {
    await fresh()
    await send(mia.client, dm.id, 'dm')
    await send(mia.client, chat.id, 'group chat')
    await send(mia.client, team.id, 'team')
    await send(mia.client, all.id, 'everyone')
    return { dm: notices(dm.id), chat: notices(chat.id), team: notices(team.id), all: notices(all.id) }
  }
  // 1:1·그룹 대화와 나를 멘션한 메시지 (the default): picked people's conversations, not the rooms everyone is put in
  expect(await each()).toEqual({ dm: ['room.dm'], chat: ['room.dm'], team: [], all: [] })
  await fresh()
  await send(mia.client, team.id, '@NORA', { mentions: [nora.id] })
  await send(mia.client, all.id, '@NORA', { mentions: [nora.id] })
  expect([notices(team.id), notices(all.id)]).toEqual([['room.mention'], ['room.mention']])
  // 모든 새 메시지: every room I am in
  await prefs(nora.client, { roomLevel: 'all' })
  expect(await each()).toEqual({ dm: ['room.dm'], chat: ['room.dm'], team: ['room.dm'], all: ['room.dm'] })
  // 받지 않음: nothing, mentions included
  await prefs(nora.client, { roomLevel: 'none' })
  expect(await each()).toEqual({ dm: [], chat: [], team: [], all: [] })
  await send(mia.client, team.id, '@NORA', { mentions: [nora.id] })
  expect(notices(team.id)).toEqual([])
  // a room's own level wins: 모든 메시지 in a team room, 멘션만 in a DM, even under 받지 않음
  await level(nora.client, team.id, 'all')
  await level(nora.client, dm.id, 'mentions')
  expect(await each()).toEqual({ dm: [], chat: [], team: ['room.dm'], all: [] })
  await fresh()
  await send(mia.client, dm.id, '@NORA here', { mentions: [nora.id] })
  expect(notices(dm.id)).toEqual(['room.mention'])
  // 끄기 under 모든 새 메시지: nothing from that room, mentions included
  await prefs(nora.client, { roomLevel: 'all' })
  await level(nora.client, chat.id, 'off')
  expect((await each()).chat).toEqual([])
  await send(mia.client, chat.id, '@NORA', { mentions: [nora.id] })
  expect(notices(chat.id)).toEqual([])
  // the sender never gets one
  expect(notices(dm.id, mia.id)).toEqual([])
})

test('notices: replies in threads I follow (and the switch for them), mentions in replies, replies sent to the room too', async () => {
  const { mia, nora, otto, send, team, dm, notices, readAll, prefs, level } = await setup()
  const reply = (c: Client, roomId: string, rootId: string, body: string, extra: Record<string, unknown> = {}) => send(c, roomId, body, { threadRootId: rootId, ...extra })
  const threadNotices = (roomId: string, uid = nora.id) => (h.ctx.db.query('SELECT n.event_type FROM room_notices n JOIN room_messages m ON m.id = n.source_id WHERE n.user_id = ? AND n.room_id = ? AND n.read_at IS NULL AND m.thread_root_id IS NOT NULL').all(uid, roomId) as { event_type: string }[]).map((r) => r.event_type)
  const readThread = async (roomId: string, rootId: string, c: Client = nora.client) => c.call('POST', `/api/rooms/${roomId}/messages/${rootId}/thread/read`, { seq: 999 })
  // nora wrote the root: she follows its thread
  const root = await send(nora.client, team.id, 'root by nora')
  await reply(mia.client, team.id, root.id, 'first reply')
  expect(threadNotices(team.id)).toEqual(['room.dm'])
  await readThread(team.id, root.id)
  // the switch off: a followed reply is quiet, a mention in a reply is not
  await prefs(nora.client, { roomThreadReplies: false })
  await reply(mia.client, team.id, root.id, 'second reply')
  expect(threadNotices(team.id)).toEqual([])
  await reply(mia.client, team.id, root.id, '@NORA look', { mentions: [nora.id] })
  expect(threadNotices(team.id)).toEqual(['room.mention'])
  await readThread(team.id, root.id)
  await prefs(nora.client, { roomThreadReplies: true })
  // the room at 끄기: no reply notifies
  await level(nora.client, team.id, 'off')
  await reply(mia.client, team.id, root.id, 'third reply')
  await reply(mia.client, team.id, root.id, '@NORA again', { mentions: [nora.id] })
  expect(threadNotices(team.id)).toEqual([])
  await level(nora.client, team.id, null)
  // a reply that stays in its thread does not reach otto (no follower), even at 모든 메시지; sent to the room too, it does
  await prefs(otto.client, { roomLevel: 'all' })
  await readAll(team.id, otto.client)
  await reply(mia.client, team.id, root.id, 'only in the thread')
  expect(notices(team.id, otto.id)).toEqual([])
  await reply(mia.client, team.id, root.id, 'to the room too', { alsoInRoom: true })
  expect(notices(team.id, otto.id)).toEqual(['room.dm'])
  // its push is checked again when it is sent: otto does not follow the thread, so at 멘션만 it no longer goes
  const ottoNotice = (h.ctx.db.query('SELECT id FROM room_notices WHERE user_id = ? AND room_id = ? AND read_at IS NULL').get(otto.id, team.id) as { id: string }).id
  expect(noticeWanted(h.ctx.db, ottoNotice)).toBe(true)
  await level(otto.client, team.id, 'mentions')
  expect(noticeWanted(h.ctx.db, ottoNotice)).toBe(false)
  await level(otto.client, team.id, null)
  // nora follows: her notice of a reply still goes at 멘션만, and not inside her quiet hours (nothing that waited is pushed)
  await reply(mia.client, team.id, root.id, 'for the followers')
  const noraNotice = (h.ctx.db.query("SELECT n.id FROM room_notices n JOIN room_messages m ON m.id = n.source_id WHERE n.user_id = ? AND n.room_id = ? AND n.read_at IS NULL AND n.event_type = 'room.dm' AND m.thread_root_id IS NOT NULL").get(nora.id, team.id) as { id: string }).id
  expect(noticeWanted(h.ctx.db, noraNotice)).toBe(true)
  updateTeamSettings(h.ctx.db, { timeZone: 'Asia/Seoul' })
  await prefs(nora.client, { quietHours: windowAround(Date.now(), 'Asia/Seoul') })
  expect(noticeWanted(h.ctx.db, noraNotice)).toBe(false)
  expect(noticeWanted(h.ctx.db, noraNotice, Date.now() + 3 * 3_600_000)).toBe(true)
  await prefs(nora.client, { quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } })
  // in a DM at 멘션만, a reply in a thread I follow still counts (a mention-level alert)
  const dmRoot = await send(nora.client, dm.id, 'dm root')
  await level(nora.client, dm.id, 'mentions')
  await reply(mia.client, dm.id, dmRoot.id, 'dm reply')
  expect(threadNotices(dm.id)).toEqual(['room.dm'])
})

test('quiet hours: notices are kept but marked quiet, never pushed; the team\'s time zone decides; the next run after them pushes', async () => {
  const { mia, nora, send, dm, notices, readAll, prefs } = await setup()
  const { PushService } = await import('../../server/src/notifications/push-service')
  const e = crypto.createECDH('prime256v1'); e.generateKeys()
  const keys = { publicKey: e.getPublicKey().toString('base64url'), privateKey: e.getPrivateKey().toString('base64url') }
  const web: any[] = [], phone: any[] = []
  let now = Date.now()
  const p = new PushService(h.ctx, { config: () => ({ enabled: true, subject: 'mailto:push@example.test', ...keys }), native: () => ({ url: 'https://push.example.test' }), now: () => now,
    transport: async (i) => { web.push(i.payload); return { statusCode: 201 } }, nativeTransport: async (i) => { phone.push(i.payload); return { statusCode: 200 } } })
  try {
    const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC').get(nora.id) as { id: string }).id
    const k = crypto.createECDH('prime256v1'); k.generateKeys()
    p.subscribe(nora.id, sid, { consent: true, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-quiet', keys: { p256dh: k.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
    // the team in Seoul; nora's quiet hours hold this moment there
    updateTeamSettings(h.ctx.db, { timeZone: 'Asia/Seoul' })
    await prefs(nora.client, { quietHours: windowAround(Date.now(), 'Asia/Seoul') })
    expect((await nora.client.call('GET', '/api/rooms')).alerts).toMatchObject({ timeZone: 'Asia/Seoul', quietHours: { on: true } })
    now += 10
    await send(mia.client, dm.id, 'at night')
    await send(mia.client, dm.id, 'still at night')
    // one notice for the run, kept (the inbox can open it, the badge counts the messages), but quiet
    expect(notices(dm.id)).toEqual(['room.dm (quiet)'])
    const quietId = (h.ctx.db.query('SELECT id FROM room_notices WHERE user_id = ? AND quiet = 1').get(nora.id) as { id: string }).id
    expect(notificationsOf(h.ctx).get(nora.id, quietId)).toMatchObject({ code: 'room.dm', room: { id: dm.id } })
    expect((await nora.client.call('GET', `/api/rooms/${dm.id}`)).unreadCount).toBe(2)
    now = Date.now() + 20
    await p.tick(); await p.tick()
    expect(web).toEqual([])
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM room_push_deliveries').get()).toEqual({ n: 0 })
    // the same hours in Los Angeles' time (16 or 17 hours away) do not hold this moment: the team's zone counts
    updateTeamSettings(h.ctx.db, { timeZone: 'America/Los_Angeles' })
    // the quiet notice is still unread: once the quiet hours are over, the next message makes a notice that pushes
    await send(mia.client, dm.id, 'morning')
    expect(notices(dm.id)).toEqual(['room.dm (quiet)', 'room.dm'])
    now = Date.now() + 40
    await p.tick(); await p.tick()
    expect(web).toEqual([{ notificationId: expect.any(String), subscriptionId: expect.any(String), code: 'room.dm' }])
    // and a run that is not quiet holds back the next notice as before
    await send(mia.client, dm.id, 'morning again')
    expect(notices(dm.id)).toEqual(['room.dm (quiet)', 'room.dm'])
    await readAll(dm.id)
    // quiet hours that do not hold this moment, and weekends left off: pushed
    updateTeamSettings(h.ctx.db, { timeZone: 'Asia/Seoul' })
    await prefs(nora.client, { quietHours: windowAround(Date.now(), 'Asia/Seoul', false) })
    await send(mia.client, dm.id, 'daytime')
    expect(notices(dm.id)).toEqual(['room.dm'])
  } finally { await p.stop() }
})

test('push: what waits for a push is checked again against the room\'s level and my default', async () => {
  const { mia, nora, send, team, dm, readAll, prefs, level } = await setup()
  const { PushService } = await import('../../server/src/notifications/push-service')
  const e = crypto.createECDH('prime256v1'); e.generateKeys()
  const keys = { publicKey: e.getPublicKey().toString('base64url'), privateKey: e.getPrivateKey().toString('base64url') }
  const sent: any[] = []
  let now = Date.now(), down = false
  const p = new PushService(h.ctx, { config: () => ({ enabled: true, subject: 'mailto:push@example.test', ...keys }), now: () => now, transport: async (i) => {
    if (down) return { statusCode: 503 }
    sent.push(i.payload); return { statusCode: 201 }
  } })
  try {
    const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC').get(nora.id) as { id: string }).id
    const k = crypto.createECDH('prime256v1'); k.generateKeys()
    p.subscribe(nora.id, sid, { consent: true, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-levels', keys: { p256dh: k.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
    now += 10
    // a DM message waits; the DM goes to 끄기 before it is sent: cancelled
    await send(mia.client, dm.id, 'one')
    await level(nora.client, dm.id, 'off')
    now = Date.now() + 20
    await p.tick()
    expect(sent).toEqual([])
    await level(nora.client, dm.id, null)
    await readAll(dm.id)
    // a DM message waits; the DM goes to 멘션만: cancelled; a mention that waits in a room at 멘션만 still goes
    await send(mia.client, dm.id, 'two')
    await send(mia.client, team.id, '@NORA', { mentions: [nora.id] })
    await level(nora.client, dm.id, 'mentions')
    now = Date.now() + 40
    await p.tick(); await p.tick()
    expect(sent.map((x) => x.code)).toEqual(['room.mention'])
    await level(nora.client, dm.id, null)
    await readAll(dm.id); await readAll(team.id)
    // my default to 받지 않음 while a push waits for its retry: cancelled at once (the preference transaction)
    await send(mia.client, dm.id, 'three')
    down = true
    now = Date.now() + 50
    await p.tick()
    expect(h.ctx.db.query("SELECT d.state FROM room_push_deliveries d JOIN room_notices n ON n.id = d.notification_id WHERE n.user_id = ? AND n.read_at IS NULL").all(nora.id)).toEqual([{ state: 'pending' }])
    await prefs(nora.client, { roomLevel: 'none' })
    expect(h.ctx.db.query("SELECT d.state FROM room_push_deliveries d JOIN room_notices n ON n.id = d.notification_id WHERE n.user_id = ? AND n.read_at IS NULL").all(nora.id)).toEqual([{ state: 'cancelled' }])
    down = false
    now = Date.now() + 200_000
    await p.tick()
    expect(sent.map((x) => x.code)).toEqual(['room.mention'])
  } finally { await p.stop() }
})
