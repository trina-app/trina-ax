// The phone app's icon number (docs/DECISIONS.md "휴대폰 앱 아이콘의 숫자"): each native push carries the recipient's one
// count n at send time (server/src/notifications/push-badge.ts, the page's rules in shared/src/api/attention.ts), only
// what wants that person; the transport sends it to the gateway as `badge` and, for a gateway from before the field
// (400: its body schema is strict), the same push again without it.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import type https from 'node:https'
import { roomsOf } from '../../server/src/rooms/service'
import { pushBadge } from '../../server/src/notifications/push-badge'
import { PushService } from '../../server/src/notifications/push-service'
import { createNativeTransport, NO_BADGE_RETRY_MS, type NativeSend } from '../../server/src/notifications/push-native'
import { parsePushGatewaySend } from '../../shared/src/cloud-protocol/push-gateway'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup() {
  h = await harness('push-badge')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const group = await owner.call('POST', '/api/admin/groups', { name: 'design', memberIds: [mia.id, nora.id, otto.id] })
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 2000)
  const send = (c: Client, roomId: string, body: string, extra: Record<string, unknown> = {}) => c.call('POST', `/api/rooms/${roomId}/messages`, { body, clientMessageId: cm(), ...extra })
  const team = ((await mia.client.call('GET', '/api/rooms')).items as any[]).find((r) => r.kind === 'team' && r.groupId === group.id)
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const badge = (id: string) => pushBadge(h.ctx, id)
  return { mia, nora, otto, team, dm, send, badge }
}

test('the badge counts only what wants that person: a DM for its other member, an @mention for the one named, not a plain team message', async () => {
  const { mia, nora, otto, team, dm, send, badge } = await setup()
  expect([badge(mia.id), badge(nora.id), badge(otto.id)]).toEqual([0, 0, 0])
  await send(mia.client, dm.id, 'hi nora')
  // the DM wants nora (1:1 at its default: every message), never its sender, never anyone outside it
  expect([badge(mia.id), badge(nora.id), badge(otto.id)]).toEqual([0, 1, 0])
  // a plain message in a team room at its default (mentions only) makes the row bold but wants nobody
  await send(mia.client, team.id, 'hello team')
  expect([badge(mia.id), badge(nora.id), badge(otto.id)]).toEqual([0, 1, 0])
  // an @mention wants the one named; the same room again counts once (rooms, not messages)
  await send(mia.client, team.id, '@otto', { mentions: [otto.id] })
  await send(mia.client, team.id, '@otto again', { mentions: [otto.id] })
  expect([badge(mia.id), badge(nora.id), badge(otto.id)]).toEqual([0, 1, 1])
  // read: gone from the count
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  expect(badge(nora.id)).toBe(0)
  // a room the person turned off (끄기) never counts
  await nora.client.call('PATCH', `/api/rooms/${dm.id}`, { notifyLevel: 'off' })
  await send(mia.client, dm.id, 'are you there')
  expect(badge(nora.id)).toBe(0)
})

test('a phone push carries the recipient\'s count at send time, a number only', async () => {
  const { mia, nora, dm, send } = await setup()
  const sent: NativeSend[] = []
  p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') }, nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } } })
  const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(nora.id) as { id: string }).id
  p.registerDevice(nora.id, sid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex') })
  await new Promise((r) => setTimeout(r, 5))
  await send(mia.client, dm.id, 'hi nora')
  await p.tick()
  expect(sent).toHaveLength(1)
  expect(sent[0]!.payload.code).toBe('room.dm')
  expect(sent[0]!.payload.badge).toBe(1)
  expect(Object.keys(sent[0]!.payload).sort()).toEqual(['badge', 'code', 'locale', 'notificationId', 'path', 'tag'])
  // an Android phone gets no count (launchers count the notifications there): not even worked out
  let asked = 0
  await p.stop()
  p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') }, nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } }, badge: () => { asked++; return 5 } })
  const msid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(mia.id) as { id: string }).id
  p.registerDevice(mia.id, msid, { consent: true, platform: 'android', environment: 'production', token: `fcm:${'A'.repeat(140)}` })
  await new Promise((r) => setTimeout(r, 5))
  await send(nora.client, dm.id, 'hi mia')
  await p.tick()
  const toMia = sent.filter((s) => s.device.platform === 'android')
  expect(toMia).toHaveLength(1)
  expect('badge' in toMia[0]!.payload).toBe(false)
  expect(asked).toBe(0)
  sent.length = 1
  // a count that could not be read: no badge, the push goes as before
  await p.stop()
  p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') }, nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } }, badge: () => null })
  // the next notice of a room comes once the first is read
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await send(mia.client, dm.id, 'second')
  await p.tick()
  expect(sent).toHaveLength(2)
  expect('badge' in sent[1]!.payload).toBe(false)
})

test('the gateway gets badge in the signed body; a gateway from before it (400) gets the push again without it, then none for an hour', async () => {
  h = await harness('push-badge-transport')
  const seen: Record<string, unknown>[] = []
  let strict = false
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
    const body = JSON.parse(await req.text()) as Record<string, unknown>
    seen.push(body)
    // an older gateway: its strict schema refuses the unknown key
    if (strict && 'badge' in body) return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 })
    return Response.json({ ok: true })
  } })
  try {
    let now = Date.now()
    const transport = createNativeTransport({ dataDir: h.ctx.config.dataDir, now: () => now })
    const input = (badge?: number): NativeSend => ({ device: { platform: 'ios', token: 'ab'.repeat(32), environment: 'production' }, payload: { notificationId: 'n-1', code: 'room.dm' as never, locale: 'en', ...(badge === undefined ? {} : { badge }) }, config: { url: `http://127.0.0.1:${server.port}` }, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 60 })
    expect(await transport(input(3))).toEqual({ statusCode: 200 })
    expect(seen.map((b) => b.badge)).toEqual([3])
    // the body is a valid contract request with the badge
    expect(parsePushGatewaySend(seen[0])?.badge).toBe(3)
    // out of range or not a whole number: not sent at all
    seen.length = 0
    for (const b of [-1, 1.5, 10_000]) await transport(input(b))
    expect(seen.every((b) => !('badge' in b))).toBe(true)
    // an older gateway
    strict = true; seen.length = 0
    expect(await transport(input(4))).toEqual({ statusCode: 200 })
    expect(seen.map((b) => b.badge ?? null)).toEqual([4, null])
    seen.length = 0
    await transport(input(5))
    expect(seen.map((b) => b.badge ?? null)).toEqual([null])
    // an hour later it tries with the number again (the gateway may have been updated)
    strict = false; now += NO_BADGE_RETRY_MS + 1; seen.length = 0
    await transport(input(6))
    expect(seen.map((b) => b.badge ?? null)).toEqual([6])
  } finally { server.stop(true) }
})

test('over https too: only a 400 invalid_body to a push with a badge is an older gateway; any other 400 is the push\'s answer', async () => {
  h = await harness('push-badge-https')
  const bodies: Record<string, unknown>[] = []
  let answer = (_b: Record<string, unknown>) => ({ status: 200, text: '{"ok":true}' })
  const request = ((options: any, cb: any) => {
    options.lookup(options.hostname, {}, () => {})
    const req = new EventEmitter() as any; req.destroy = () => {}
    req.end = (b: Buffer) => {
      const body = JSON.parse(b.toString()) as Record<string, unknown>; bodies.push(body)
      const a = answer(body)
      queueMicrotask(() => {
        const res = new EventEmitter() as any
        res.statusCode = a.status; res.destroy = () => {}; res.setEncoding = () => {}
        cb(res)
        queueMicrotask(() => { res.emit('data', a.text); res.emit('end') })
      })
    }
    return req
  }) as unknown as typeof https.request
  const transport = createNativeTransport({ dataDir: h.ctx.config.dataDir, request, lookup: async () => [{ address: '8.8.8.8', family: 4 }] })
  const input = (badge?: number): NativeSend => ({ device: { platform: 'ios', token: 'ab'.repeat(32), environment: 'production' }, payload: { notificationId: 'n-1', code: 'room.dm' as never, locale: 'en', ...(badge === undefined ? {} : { badge }) }, config: { url: 'https://push.example.test' }, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 60 })
  // a 400 that is not invalid_body (or no JSON): the push's own answer, sent once
  answer = () => ({ status: 400, text: 'nope' })
  expect(await transport(input(2))).toEqual({ statusCode: 400 })
  expect(bodies.map((b) => b.badge ?? null)).toEqual([2])
  // the older gateway: invalid_body for the badge, then the same push without it
  bodies.length = 0
  answer = (b) => ('badge' in b ? { status: 400, text: '{"ok":false,"error":"invalid_body"}' } : { status: 200, text: '{"ok":true}' })
  expect(await transport(input(3))).toEqual({ statusCode: 200 })
  expect(bodies.map((b) => b.badge ?? null)).toEqual([3, null])
  // invalid_body to a push without a badge: nothing to drop, its answer
  bodies.length = 0
  answer = () => ({ status: 400, text: '{"ok":false,"error":"invalid_body"}' })
  expect(await transport(input())).toEqual({ statusCode: 400, error: 'invalid_body' })
  expect(bodies).toHaveLength(1)
})
