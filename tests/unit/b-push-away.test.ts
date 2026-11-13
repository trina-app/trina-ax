// Phone notifications only when I'm away (docs/DECISIONS.md "Phone notifications when I'm away";
// server/src/notifications/away.ts), Slack's default: decided once per notice when its phone push would go. The person
// at Trina then (a window in use) saw it on the computer: that phone push is cancelled, never held or sent later. Away
// (idle, no window, manual away): it goes as before. "Always": as before. Right after a start it waits once for the
// windows to reconnect. Someone else's phone is never affected.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { roomsOf } from '../../server/src/rooms/service'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import type { PhoneDecision } from '../../server/src/notifications/away'
import { presenceFor } from '../../server/src/realtime/presence'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup(o: { phoneDecision?: (u: string) => PhoneDecision } = {}) {
  h = await harness('push-away')
  const owner = await withOwner(h)
  const nora = await addMember(h, owner, { username: 'nora' })
  const mia = await addMember(h, owner, { username: 'mia' })
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 1000)
  const send = (c: Client, roomId: string, body: string) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm() })
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  // a room has one unread notice at a time: read it before the next message makes a new one
  const read = (c: Client) => c.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  const sent: NativeSend[] = []
  p = new PushService(h.ctx, {
    config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } },
    ...(o.phoneDecision ? { phoneDecision: o.phoneDecision } : {}),
  })
  const phone = (userId: string) => {
    const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as { id: string }).id
    p!.registerDevice(userId, sid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex') })
  }
  phone(nora.id)
  await new Promise((r) => setTimeout(r, 5))
  const states = (userId = nora.id) => (h.ctx.db.query(`SELECT d.state, COUNT(*) n FROM room_push_deliveries d JOIN room_notices x ON x.id = d.notification_id WHERE x.user_id = ? GROUP BY d.state ORDER BY d.state`).all(userId) as { state: string; n: number }[])
  getChatRuntime(h.ctx)
  const pr = presenceFor(h.ctx)!
  return { owner, nora, mia, dm, send, read, sent, phone, states, pr }
}

test('at Trina: that phone push is cancelled, and not sent later when they leave; away: the next one goes', async () => {
  const { nora, mia, dm, send, read, sent, states, pr } = await setup()
  pr.open(nora.id, 'w1')
  await send(mia.client, dm.id, 'hi nora')
  await p!.tick()
  expect(sent).toHaveLength(0)
  expect(states()).toEqual([{ state: 'cancelled', n: 1 }])
  // leaving does not bring it back: the computer showed it
  pr.activity(nora.id, 'w1', 'idle')
  await p!.tick()
  expect(sent).toHaveLength(0)
  await read(nora.client)
  await send(mia.client, dm.id, 'are you there')
  await p!.tick()
  expect(sent).toHaveLength(1)
  expect(sent[0]!.payload.code).toBe('room.dm')
})

test('closed while in use (a reload): still at Trina for the grace; closed after saying idle, or no window: sent', async () => {
  const { nora, mia, dm, send, read, sent, pr } = await setup()
  pr.open(nora.id, 'w1')
  pr.close(nora.id, 'w1')
  await send(mia.client, dm.id, 'one')
  await p!.tick()
  expect(sent).toHaveLength(0)
  pr.open(nora.id, 'w2')
  pr.activity(nora.id, 'w2', 'idle')
  pr.close(nora.id, 'w2')
  await read(nora.client)
  await send(mia.client, dm.id, 'two')
  await p!.tick()
  expect(sent).toHaveLength(1)
})

test('manual away sends; "Always" sends while at Trina; the setting is the caller\'s own', async () => {
  const { nora, mia, dm, send, read, sent, pr } = await setup()
  pr.open(nora.id, 'w1')
  pr.setAway(nora.id, true)
  await send(mia.client, dm.id, 'one')
  await p!.tick()
  expect(sent).toHaveLength(1)
  pr.setAway(nora.id, false)
  const prefs = await nora.client.call('PATCH', '/api/notification-preferences', { phoneWhen: 'always' })
  expect(prefs.phoneWhen).toBe('always')
  await read(nora.client)
  await send(mia.client, dm.id, 'two')
  await p!.tick()
  expect(sent).toHaveLength(2)
  expect((await mia.client.call('GET', '/api/notification-preferences')).phoneWhen).toBe('away')
  expect((await nora.client.call('GET', '/api/notification-preferences')).phoneWhen).toBe('always')
})

test('one person at Trina never touches another\'s phone', async () => {
  const { owner, nora, mia, dm, send, sent, phone, states, pr } = await setup()
  phone(mia.id)
  await new Promise((r) => setTimeout(r, 5))
  pr.open(nora.id, 'w1')
  // a DM for mia from nora, and one for nora from the owner (writing in a room reads it for the writer)
  await send(nora.client, dm.id, 'for mia')
  const ownerDm = await owner.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  await send(owner, ownerDm.id, 'for nora')
  await p!.tick()
  expect(sent).toHaveLength(1)
  const miaPhone = (h.ctx.db.query("SELECT id FROM push_subscriptions WHERE user_id = ? AND kind = 'native'").get(mia.id) as { id: string }).id
  expect(sent[0]!.payload.tag).toBe(miaPhone)
  expect(states(nora.id)).toEqual([{ state: 'cancelled', n: 1 }])
})

test('right after a start: the phone push waits once for the warm-up, then is decided', async () => {
  let decision: PhoneDecision = { kind: 'wait', until: Date.now() + 60_000 }
  const { mia, dm, send, sent, states } = await setup({ phoneDecision: () => decision })
  await send(mia.client, dm.id, 'hi')
  await p!.tick()
  expect(sent).toHaveLength(0)
  expect(states()).toEqual([{ state: 'pending', n: 1 }])
  decision = { kind: 'send' }
  h.ctx.db.query("UPDATE room_push_deliveries SET next_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE state = 'pending'").run()
  await p!.tick()
  expect(sent).toHaveLength(1)
})

test('a cancelled phone push does not silence the rest of the unread run: the next DM, unread, is a new notice and goes when away', async () => {
  const { nora, mia, dm, send, sent, pr } = await setup()
  pr.open(nora.id, 'w1')
  await send(mia.client, dm.id, 'first')
  await p!.tick()
  expect(sent).toHaveLength(0)
  pr.activity(nora.id, 'w1', 'idle')
  // nora never read the room: before, this second message folded into the first notice and the phone stayed silent
  await send(mia.client, dm.id, 'second')
  await p!.tick()
  expect(sent).toHaveLength(1)
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE user_id = ? AND room_id = ?').get(nora.id, dm.id) as { n: number }).n).toBe(2)
  // a notice whose push went holds the run back as before: a third message adds none
  await send(mia.client, dm.id, 'third')
  await p!.tick()
  expect(sent).toHaveLength(1)
})

test('at Trina: Web Push still goes, a retry still goes, the owner\'s locked password check still goes', async () => {
  const { nora, mia, dm, send, read, sent, pr } = await setup()
  // Web Push for nora on another session of hers (one push row per session)
  const e = crypto.createECDH('prime256v1'); e.generateKeys()
  const keys = { publicKey: e.getPublicKey().toString('base64url'), privateKey: e.getPrivateKey().toString('base64url') }
  const web: unknown[] = []
  const phoneSent: NativeSend[] = []
  await p!.stop()
  p = new PushService(h.ctx, { config: () => ({ enabled: true, subject: 'mailto:push@example.test', ...keys }), native: () => ({ url: 'https://push.example.test' }),
    transport: async (i) => { web.push(i.payload); return { statusCode: 201 } }, nativeTransport: async (i) => { phoneSent.push(i); return { statusCode: 200 } } })
  const second = h.auth.createSession(nora.id, 'web', null)
  const k = crypto.createECDH('prime256v1'); k.generateKeys()
  p.subscribe(nora.id, second.id, { consent: true, endpoint: 'https://fcm.googleapis.com/fcm/send/synthetic-away', keys: { p256dh: k.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } })
  await new Promise((r) => setTimeout(r, 5))
  pr.open(nora.id, 'w1')
  await send(mia.client, dm.id, 'hi')
  await p.tick()
  expect(web).toHaveLength(1)
  expect(phoneSent).toHaveLength(0)
  // a retry (the first try failed) is not decided again
  await read(nora.client)
  await send(mia.client, dm.id, 'again')
  // the tick makes the rows (and decides the phone one: cancelled); then it is a retry, as after a failed first try
  await p.tick()
  const before = phoneSent.length
  h.ctx.db.query(`UPDATE room_push_deliveries SET state = 'pending', attempts = 1, next_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')
    WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE kind = 'native') AND notification_id = (SELECT id FROM room_notices WHERE user_id = ? ORDER BY created_at DESC LIMIT 1)`).run(nora.id)
  await p.tick()
  expect(phoneSent.length).toBe(before + 1)
  // the owner's locked password check: never cancelled
  const owner = h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }
  const osid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(owner.id) as { id: string }).id
  p.registerDevice(owner.id, osid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex') })
  await new Promise((r) => setTimeout(r, 5))
  pr.open(owner.id, 'wo')
  const { notificationsOf } = await import('../../server/src/notifications/service')
  notificationsOf(h.ctx).handoverNotice(owner.id, 'owner.reauth_locked', `reauth-test-${Date.now()}`, new Date().toISOString())
  await p.tick()
  expect(phoneSent.some((s) => s.payload.code === 'owner.reauth_locked')).toBe(true)
})
