// A phone push for every message (docs/decisions/20261120-push-every-message.md, QA TC-5585, TC-5586): five DMs in a
// row from one person are five notices and five pushes, each with its own id (so its own apns-collapse-id), and the
// icon number the push carries goes up with each one. Reading the room reads them all and cancels what still waits.
// Quiet hours keep one quiet notice per unread run (never pushed).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { roomsOf } from '../../server/src/rooms/service'
import { notificationsOf } from '../../server/src/notifications/service'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup() {
  h = await harness('push-every-message')
  const owner = await withOwner(h)
  const nora = await addMember(h, owner, { username: 'nora' })
  const mia = await addMember(h, owner, { username: 'mia' })
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 1000)
  const send = (c: Client, roomId: string, body: string) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm() })
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const sent: NativeSend[] = []
  // nora is away (no window, no computer): every phone push goes
  p = new PushService(h.ctx, {
    config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } },
    phoneDecision: () => ({ kind: 'send' }),
  })
  const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(nora.id) as { id: string }).id
  p.registerDevice(nora.id, sid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex') })
  await new Promise((r) => setTimeout(r, 5))
  getChatRuntime(h.ctx)
  const notices = () => (h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE user_id = ? AND room_id = ?').get(nora.id, dm.id) as { n: number }).n
  return { owner, nora, mia, dm, send, sent, notices }
}

test('five DMs in a row from one person: five notices, five phone pushes with their own ids, the icon number going up', async () => {
  const { nora, mia, dm, send, sent, notices } = await setup()
  for (let i = 1; i <= 5; i++) {
    await send(mia.client, dm.id, `message ${i}`)
    await p!.tick()
  }
  expect(notices()).toBe(5)
  expect(sent).toHaveLength(5)
  expect(sent.every((s) => s.payload.code === 'room.dm')).toBe(true)
  expect(new Set(sent.map((s) => s.payload.notificationId)).size).toBe(5)
  // the icon counts the DM's unread messages: 1, 2, 3, 4, 5 (nothing else waits for nora)
  expect(sent.map((s) => s.payload.badge)).toEqual([1, 2, 3, 4, 5])
  // reading the room reads all five
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  expect((h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE user_id = ? AND room_id = ? AND read_at IS NULL').get(nora.id, dm.id) as { n: number }).n).toBe(0)
})

test('a burst read before its pushes go: what still waits is cancelled, nothing rings for a read message', async () => {
  const { nora, mia, dm, send, sent } = await setup()
  await send(mia.client, dm.id, 'one')
  await send(mia.client, dm.id, 'two')
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await p!.tick()
  expect(sent).toHaveLength(0)
  await send(mia.client, dm.id, 'three')
  await p!.tick()
  expect(sent).toHaveLength(1)
  expect(sent[0]!.payload.badge).toBe(1)
})

test('mentions in a channel: each one is its own push; plain messages there still none (멘션만)', async () => {
  const { nora, mia, send, sent } = await setup()
  const ch = await mia.client.call('POST', '/api/rooms', { kind: 'group', name: 'burst-test', userIds: [nora.id] })
  // the channel at 멘션만 for nora
  await nora.client.call('PATCH', `/api/rooms/${ch.id}`, { notifyLevel: 'mentions' })
  for (let i = 1; i <= 3; i++) {
    await mia.client.call('POST', `/api/rooms/${ch.id}/messages`, { body: `@nora ping ${i}`, mentions: [nora.id], clientMessageId: cm() })
    await p!.tick()
  }
  await send(mia.client, ch.id, 'no mention')
  await p!.tick()
  expect(sent.filter((s) => s.payload.code === 'room.mention')).toHaveLength(3)
  expect(sent).toHaveLength(3)
})

test('quiet notices stay one per unread run', async () => {
  const { nora, mia, dm, sent, notices } = await setup()
  const n = notificationsOf(h.ctx)
  const post = async (body: string) => {
    const m = await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body, clientMessageId: cm() })
    return m as { id: string; seq: number; createdAt: string }
  }
  // the messages' own notices are made by the room (not quiet); drop them so the quiet path is tested on its own
  const a = await post('night 1'), b = await post('night 2')
  h.ctx.db.query('DELETE FROM room_notices WHERE user_id = ? AND room_id = ?').run(nora.id, dm.id)
  expect(n.roomNotice(nora.id, 'room.dm', a.id, dm.id, new Date().toISOString(), null, true, a.seq)).toBe(false)
  expect(n.roomNotice(nora.id, 'room.dm', b.id, dm.id, new Date().toISOString(), null, true, b.seq)).toBe(false)
  expect(notices()).toBe(1)
  await p!.tick()
  expect(sent).toHaveLength(0)
  // after the quiet hours: the next message is a notice of its own that rings, though the quiet one is unread
  const c = await post('morning')
  h.ctx.db.query('DELETE FROM room_notices WHERE source_id = ?').run(c.id)
  expect(n.roomNotice(nora.id, 'room.dm', c.id, dm.id, new Date().toISOString(), null, false, c.seq)).toBe(true)
  expect(notices()).toBe(2)
})

test("an app's burst stays one notice per unread run (review of #108, finding 2); a person's message after it still rings", async () => {
  h = await harness('push-every-message-app', { publicOrigins: ['https://team.acme-corp.com'] })
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const all = ((await owner.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'all')!.id as string
  // mia hears every message of the everyone room: without the run rule an app's 30-message burst would be 30 pushes
  await mia.client.call('PATCH', `/api/rooms/${all}`, { notifyLevel: 'all' })
  const r = await owner.call('POST', `/api/rooms/${all}/apps`, { kind: 'other', name: 'Backups' })
  const token = (r.address as string).split('/in/')[1]!
  const appPost = (text: string) => h.fetch(`/in/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
  for (let i = 1; i <= 5; i++) expect((await appPost(`backup ${i} finished`)).status).toBe(200)
  await new Promise((r) => setTimeout(r, 5))
  const unread = () => (h.ctx.db.query('SELECT COUNT(*) n FROM room_notices WHERE user_id = ? AND room_id = ? AND read_at IS NULL').get(mia.id, all) as { n: number }).n
  expect(unread()).toBe(1)
  // a person's message is a notice of its own, unread app notice or not
  await owner.call('POST', `/api/rooms/${all}/messages`, { body: 'all done', clientMessageId: cm() })
  expect(unread()).toBe(2)
  // read: the next app message makes a notice again
  await mia.client.call('POST', `/api/rooms/${all}/read`, { seq: 999 })
  expect(unread()).toBe(0)
  await appPost('backup 6 finished')
  await new Promise((r) => setTimeout(r, 5))
  expect(unread()).toBe(1)
})
