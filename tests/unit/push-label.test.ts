// Who and where in a room push on the iPhone (docs/DECISIONS.md "아이폰 알림의 이름"): the app's notification extension
// asks POST /api/push/devices/:id/label with the label key whose hash came with the registration. The answer is the
// browser push's title and body in the person's language, never the message's text, and only for a room notice of that
// device's person that was sent to that device, unread, still wanted and still theirs to read; every failure gets the
// same {} (server/src/notifications/push-service.ts label).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { plainLabel } from '@mycel/shared/api'
import { PushService, LABEL_PER_MINUTE, pushOf } from '../../server/src/notifications/push-service'
import { notificationsOf } from '../../server/src/notifications/service'
import { TEXT } from '../../server/src/notifications/text'
import { setUserLocale } from '../../server/src/auth/users'
import type { NativeSend } from '../../server/src/notifications/push-native'
import type { Logger } from '../../server/src/log'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(60_000)
const GATEWAY = 'https://push.example.test'
let h: Harness, p: PushService
afterEach(async () => { await p?.stop(); await h?.close() })

const cm = () => 'cm-' + crypto.randomUUID()
const newKey = () => crypto.randomBytes(32).toString('base64url')
const hashOf = (key: string) => crypto.createHash('sha256').update(key).digest('hex')
const iosDevice = (labelHash?: string, token = crypto.randomBytes(32).toString('hex')) => ({ consent: true as const, platform: 'ios' as const, environment: 'production' as const, token, ...(labelHash ? { labelHash } : {}) })
const sessionOf = (userId: string) => (h.ctx.db.query('SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId) as { id: string }).id

/** A team with a group room "design"; nora's iPhone registered with a label key; mia writes to her. */
async function world(o: { log?: Logger; http?: boolean } = {}) {
  h = await harness('push-label', o.http ? { push: { gatewayUrl: GATEWAY } } as never : {}, o.log ? { log: o.log } : {})
  // the server's own push service sends nowhere in a test; this one hands deliveries to a fake gateway
  if (o.http) await pushOf(h.ctx).stop()
  let now = Date.now()
  const sent: NativeSend[] = []
  p = new PushService(h.ctx, { config: () => null, native: () => ({ url: GATEWAY }), nativeTransport: async i => { sent.push(i); return { statusCode: 200 } }, now: () => now })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id, otto.id] })
  const team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find(r => r.kind === 'team' && r.groupId === group.id)
  const key = newKey(), token = crypto.randomBytes(32).toString('hex')
  const device = p.registerDevice(nora.id, sessionOf(nora.id), iosDevice(hashOf(key), token))
  now += 5
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const noticeOf = (messageId: string, userId = nora.id) => (h.ctx.db.query('SELECT id FROM room_notices WHERE source_id=? AND user_id=?').get(messageId, userId) as { id: string } | null)?.id ?? null
  /** the message's notice for nora, pushed to her phone */
  const pushed = async (messageId: string) => { now = Math.max(now + 5, Date.now()); await p.tick(); const id = noticeOf(messageId); expect(id).not.toBeNull(); return id! }
  const ask = (notificationId: string, k = key, id = device.id) => p.label(id, { key: k, notificationId })
  return { owner, mia, nora, otto, team, key, token, device, sent, send, noticeOf, pushed, ask, clock: { get now() { return now }, set now(v: number) { now = v } } }
}

test('a DM, a mention and a thread reply: the browser push\'s title and body, in the person\'s language, never the text', async () => {
  const w = await world()
  const n = notificationsOf(h.ctx)
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  const hello = await w.send(w.mia.client, dm.id, '비밀 계획: 금요일 출시')
  const dmNotice = await w.pushed(hello.id)
  // the phone was sent this notice through the gateway, ids only
  expect(w.sent.map(s => s.payload.notificationId)).toContain(dmNotice)
  const a = w.ask(dmNotice)
  expect(a).toEqual({ title: 'MIA', body: TEXT['room.dm'].ko, roomId: dm.id })
  // the same title as a browser push (GET /api/notifications/:id room.label)
  expect(a.title).toBe(n.get(w.nora.id, dmNotice).room!.label!)
  expect(JSON.stringify(a)).not.toContain('비밀')

  const mention = await w.send(w.mia.client, w.team.id, '회의록 링크는 여기', { mentions: [w.nora.id] })
  const mentionNotice = await w.pushed(mention.id)
  expect(w.ask(mentionNotice)).toEqual({ title: 'MIA · #design', body: TEXT['room.mention'].ko, roomId: w.team.id })

  // a reply in a thread nora follows (she wrote its root); in English for an English account
  const root = await w.send(w.nora.client, w.team.id, 'nora asks')
  setUserLocale(h.ctx.db, w.nora.id, 'en')
  const reply = await w.send(w.mia.client, w.team.id, 'the answer is QZXWV-SECRET', { threadRootId: root.id })
  const replyNotice = await w.pushed(reply.id)
  const r = w.ask(replyNotice)
  expect(r).toEqual({ title: 'MIA · #design › Thread', body: TEXT['room.dm'].en, roomId: w.team.id, threadId: root.id })
  expect(r.title).toBe(n.get(w.nora.id, replyNotice).room!.label!)
  expect(JSON.stringify(r)).not.toContain('QZXWV')
})

test('names are one plain line: no bidirectional or zero-width characters, no line breaks, at most 120 characters', async () => {
  const w = await world()
  h.ctx.db.query('UPDATE users SET name = ? WHERE id = ?').run(`Mi‮a​\nEve⁦x⁩ ${'긴'.repeat(200)}`, w.mia.id)
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  const m = await w.send(w.mia.client, dm.id, 'hello')
  const title = w.ask(await w.pushed(m.id)).title!
  expect(title).not.toMatch(/[‪-‮⁦-⁩​\n\r]/)
  expect([...title].length).toBeLessThanOrEqual(120)
  expect(title.startsWith('Mia Evex ')).toBe(true)
  expect(title.endsWith('…')).toBe(true)
  expect(title).toBe(plainLabel(title, 120))
})

test('every failure is the same {}: key, device, notice, person, reading, level, visibility, session, gateway', async () => {
  const w = await world()
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  const notice = await w.pushed((await w.send(w.mia.client, dm.id, 'one')).id)
  expect(w.ask(notice).title).toBe('MIA')
  // the key: wrong, malformed, the right one for another device, none at all
  expect(w.ask(notice, newKey())).toEqual({})
  for (const bad of ['', 'short', w.key + 'x', w.key.slice(0, 42) + '=', hashOf(w.key)]) expect(w.ask(notice, bad)).toEqual({})
  expect(w.ask(notice, w.key, 'no-such-device')).toEqual({})
  expect(w.ask(notice, w.key, '../../etc')).toEqual({})
  // the notice: unknown, malformed, another person's, not a room notice
  expect(w.ask('no-such-notice')).toEqual({})
  expect(w.ask('x'.repeat(150))).toEqual({})
  const toMia = await w.send(w.nora.client, dm.id, 'back to mia')
  expect(w.noticeOf(toMia.id, w.mia.id)).not.toBeNull()
  expect(w.ask(w.noticeOf(toMia.id, w.mia.id)!)).toEqual({})
  notificationsOf(h.ctx).connectionReconnect(w.nora.id, 'reconnect-1', new Date(w.clock.now).toISOString())
  await p.tick()
  const inbox = (h.ctx.db.query("SELECT id FROM notification_inbox WHERE user_id=?").get(w.nora.id) as { id: string }).id
  expect(w.ask(inbox)).toEqual({})
  // read: nothing more to say
  const second = await w.pushed((await w.send(w.mia.client, w.team.id, 'two', { mentions: [w.nora.id] })).id)
  expect(w.ask(second).title).toBe('MIA · #design')
  notificationsOf(h.ctx).read(w.nora.id, second)
  expect(w.ask(second)).toEqual({})
})

test('only a notice that was sent to this device: not one made before it registered, not one never tried, not after a day', async () => {
  const w = await world()
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  // a notice whose push was never tried (no delivery for this device yet)
  const waiting = await w.send(w.mia.client, dm.id, 'not pushed yet')
  const id = w.noticeOf(waiting.id)!
  expect(w.ask(id)).toEqual({})
  w.clock.now = Date.now(); await p.tick()
  expect(w.ask(id).title).toBe('MIA')
  // a second phone of nora (another session) was not sent this notice
  const c2 = h.client(); await c2.login('nora', w.nora.password)
  const key2 = newKey(), other = p.registerDevice(w.nora.id, sessionOf(w.nora.id), iosDevice(hashOf(key2)))
  expect(w.ask(id, key2, other.id)).toEqual({})
  // older than a push's day
  w.clock.now = Date.now() + 86_400_000 + 60_000
  expect(w.ask(id)).toEqual({})
})

test('the room\'s level, a hidden or left room, a deleted message and a private preview give nothing', async () => {
  const w = await world()
  // one notice per unread run (Notifications.roomNotice): each case reads the one before, so a mention makes a new one
  let last: string | null = null
  const ask = async (body: string, extra: Record<string, unknown> = { mentions: [w.nora.id] }) => {
    if (last) notificationsOf(h.ctx).read(w.nora.id, last)
    const m = await w.send(w.mia.client, w.team.id, body, extra)
    last = await w.pushed(m.id)
    return { m, id: last }
  }
  // muted after the push was sent
  const a = await ask('a')
  expect(w.ask(a.id).title).toBe('MIA · #design')
  await w.nora.client.call('PATCH', `/api/rooms/${w.team.id}`, { notifyLevel: 'off' })
  expect(w.ask(a.id)).toEqual({})
  await w.nora.client.call('PATCH', `/api/rooms/${w.team.id}`, { notifyLevel: null })
  expect(w.ask(a.id).title).toBe('MIA · #design')
  // hidden
  await w.nora.client.call('PUT', `/api/rooms/${w.team.id}/hidden`, { hidden: true })
  expect(w.ask(a.id)).toEqual({})
  await w.nora.client.call('PUT', `/api/rooms/${w.team.id}/hidden`, { hidden: false })
  // the message deleted
  const b = await ask('b')
  expect(w.ask(b.id).title).toBe('MIA · #design')
  h.ctx.db.query('UPDATE room_messages SET deleted_at=? WHERE id=?').run(new Date().toISOString(), b.m.id)
  expect(w.ask(b.id)).toEqual({})
  // a preview private to someone else
  const c = await ask('c')
  h.ctx.db.query("UPDATE room_messages SET visibility='private', visible_to=? WHERE id=?").run(w.otto.id, c.m.id)
  expect(w.ask(c.id)).toEqual({})
  // no longer in the room
  const d = await ask('d')
  expect(w.ask(d.id).title).toBe('MIA · #design')
  h.ctx.db.query('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(w.team.id, w.nora.id)
  expect(w.ask(d.id)).toEqual({})
})

test('a stale device: push off, the session ended, the gateway moved, no label key, Android', async () => {
  const w = await world()
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  const id = await w.pushed((await w.send(w.mia.client, dm.id, 'x')).id)
  expect(w.ask(id).title).toBe('MIA')
  // the gateway address changed: the device row is not used any more
  const moved = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push2.example.test' }), now: () => w.clock.now })
  try { expect(moved.label(w.device.id, { key: w.key, notificationId: id })).toEqual({}) } finally { await moved.stop() }
  // the server has no gateway at all
  const off = new PushService(h.ctx, { config: () => null, native: () => null, now: () => w.clock.now })
  try { expect(off.label(w.device.id, { key: w.key, notificationId: id })).toEqual({}) } finally { await off.stop() }
  // push turned off (also in the preferences row)
  h.ctx.db.query('UPDATE push_preferences SET enabled=0 WHERE user_id=?').run(w.nora.id)
  expect(w.ask(id)).toEqual({})
  h.ctx.db.query('UPDATE push_preferences SET enabled=1 WHERE user_id=?').run(w.nora.id)
  expect(w.ask(id).title).toBe('MIA')
  // the person disabled, or made to change the password first
  h.ctx.db.query("UPDATE users SET status='disabled' WHERE id=?").run(w.nora.id)
  expect(w.ask(id)).toEqual({})
  h.ctx.db.query("UPDATE users SET status='active', must_change_password=1 WHERE id=?").run(w.nora.id)
  expect(w.ask(id)).toEqual({})
  h.ctx.db.query('UPDATE users SET must_change_password=0 WHERE id=?').run(w.nora.id)
  expect(w.ask(id).title).toBe('MIA')
  // the session ended (sign-out removes the device with it; an expired one stays until the next sweep)
  h.ctx.db.query('UPDATE sessions SET expires_at=? WHERE id=?').run(new Date(w.clock.now - 1000).toISOString(), (h.ctx.db.query('SELECT session_id FROM push_subscriptions WHERE id=?').get(w.device.id) as { session_id: string }).session_id)
  expect(w.ask(id)).toEqual({})
  // no label key: registered without a hash, or an Android phone (whose hash is not kept)
  const sid = sessionOf(w.mia.id)
  const plain = p.registerDevice(w.mia.id, sid, iosDevice())
  expect(h.ctx.db.query('SELECT label_hash FROM push_subscriptions WHERE id=?').get(plain.id)).toEqual({ label_hash: null })
  const k = newKey()
  const android = p.registerDevice(w.otto.id, sessionOf(w.otto.id), { consent: true, platform: 'android', environment: 'production', token: 'fcm:' + 'A'.repeat(140), labelHash: hashOf(k) })
  expect(h.ctx.db.query('SELECT label_hash FROM push_subscriptions WHERE id=?').get(android.id)).toEqual({ label_hash: null })
})

test('the label key is the app\'s: registering again with it changes nothing; without it the key is gone', async () => {
  const w = await world()
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  const id = await w.pushed((await w.send(w.mia.client, dm.id, 'x')).id)
  const stored = () => (h.ctx.db.query('SELECT label_hash FROM push_subscriptions WHERE id=?').get(w.device.id) as { label_hash: string | null }).label_hash
  expect(stored()).toBe(hashOf(w.key))
  // the key is not in the database, only its hash
  expect(JSON.stringify(h.ctx.db.query('SELECT * FROM push_subscriptions').all())).not.toContain(w.key)
  // the page registers again at every load with the same hash: the extension's key keeps working
  const again = p.registerDevice(w.nora.id, sessionOf(w.nora.id), iosDevice(hashOf(w.key), w.token))
  expect(again.id).toBe(w.device.id)
  expect(w.ask(id).title).toBe('MIA')
  // a new key (after a sign-out on the phone and back): the old one stops working at once
  const next = newKey()
  p.registerDevice(w.nora.id, sessionOf(w.nora.id), iosDevice(hashOf(next), w.token))
  expect(w.ask(id)).toEqual({})
  expect(w.ask(id, next).title).toBe('MIA')
  // a registration without a hash (an app without the extension) leaves no key
  p.registerDevice(w.nora.id, sessionOf(w.nora.id), iosDevice(undefined, w.token))
  expect(stored()).toBeNull()
  expect(w.ask(id, next)).toEqual({})
  // the same phone signed in as someone else: the token moves, nora's row and its key go
  const otherKey = newKey()
  const moved = p.registerDevice(w.otto.id, sessionOf(w.otto.id), iosDevice(hashOf(otherKey), w.token))
  expect(h.ctx.db.query('SELECT id FROM push_subscriptions WHERE id=?').get(w.device.id)).toBeNull()
  expect(h.ctx.db.query('SELECT user_id,label_hash FROM push_subscriptions WHERE id=?').get(moved.id)).toEqual({ user_id: w.otto.id, label_hash: hashOf(otherKey) })
  // nora's notice is not otto's to read, whatever key he has
  expect(p.label(moved.id, { key: otherKey, notificationId: id })).toEqual({})
})

test(`at most ${LABEL_PER_MINUTE} answers a minute for a device; wrong keys do not use them up`, async () => {
  const w = await world()
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  const id = await w.pushed((await w.send(w.mia.client, dm.id, 'x')).id)
  for (let i = 0; i < 200; i++) expect(w.ask(id, newKey())).toEqual({})
  for (let i = 0; i < LABEL_PER_MINUTE; i++) expect(w.ask(id).title).toBe('MIA')
  expect(w.ask(id)).toEqual({})
  w.clock.now += 60_000
  expect(w.ask(id).title).toBe('MIA')
})

test('a failure inside (here: the gateway setting throws) is the same {}, never a 500', async () => {
  const w = await world()
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  const id = await w.pushed((await w.send(w.mia.client, dm.id, 'x')).id)
  const broken = new PushService(h.ctx, { config: () => null, native: () => { throw new Error('boom') }, now: () => w.clock.now })
  try { expect(broken.label(w.device.id, { key: w.key, notificationId: id })).toEqual({}) } finally { await broken.stop() }
})

test('HTTP: no session, never cached, 200 {} for every failure, and nothing of the names or the text in the log', async () => {
  const lines: string[] = []
  const record = (msg: string, fields?: Record<string, unknown>) => { lines.push(msg + ' ' + JSON.stringify(fields ?? {})) }
  const log: Logger = { debug: record, info: record, warn: record, error: record, child: () => log }
  const w = await world({ http: true, log })
  h.ctx.db.query('UPDATE users SET name = ? WHERE id = ?').run('Miasecret', w.mia.id)
  const dm = await w.mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: w.nora.id })
  const id = await w.pushed((await w.send(w.mia.client, dm.id, 'textsecret')).id)
  const anyone = h.client()
  const post = (body: unknown, device = w.device.id) => anyone.raw('POST', `/api/push/devices/${device}/label`, body)
  const ok = await post({ key: w.key, notificationId: id })
  expect(ok.status).toBe(200)
  expect(ok.headers.get('cache-control')).toBe('no-store')
  expect(await ok.json()).toEqual({ title: 'Miasecret', body: TEXT['room.dm'].ko, roomId: dm.id })
  for (const [body, device] of [[{ key: newKey(), notificationId: id }, w.device.id], [{ key: w.key, notificationId: id }, 'no-such-device'], [{ key: 'x', notificationId: 'y' }, w.device.id], [{ key: w.key, notificationId: 'nope' }, w.device.id]] as const) {
    const r = await post(body, device)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({})
    expect(r.headers.get('cache-control')).toBe('no-store')
  }
  // a signed-in caller gets nothing more
  expect(await (await w.nora.client.raw('POST', `/api/push/devices/${w.device.id}/label`, { key: newKey(), notificationId: id })).json()).toEqual({})
  expect(lines.join('\n')).not.toContain('Miasecret')
  expect(lines.join('\n')).not.toContain('textsecret')
  expect(lines.join('\n')).not.toContain(w.key)
})
