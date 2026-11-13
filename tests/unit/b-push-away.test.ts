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
