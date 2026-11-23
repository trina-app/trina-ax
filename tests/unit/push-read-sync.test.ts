// A phone follows reads made on another device (docs/AGENTS/plan/20261123-0705-phone-badge-sync.md): a notice pushed to
// a phone and then read elsewhere goes to that phone in one silent sync (push-service.ts syncPhones): the ids to take
// off and an iPhone's new icon number, nothing else. A burst of reads is one sync; an Android app from before syncs gets
// none; a gateway from before syncs gets none and never a sync without `sync`.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { roomsOf } from '../../server/src/rooms/service'
import { PushService, SYNC_GAP_MS, SYNC_EVERY_MS } from '../../server/src/notifications/push-service'
import { createNativeTransport, SYNC_UNSUPPORTED, type NativeSend } from '../../server/src/notifications/push-native'
import { parsePushGatewaySend, PUSH_SYNC_CODE } from '../../shared/src/cloud-protocol/push-gateway'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup(platform: 'ios' | 'android', o: { sync?: boolean } = {}) {
  h = await harness('push-read-sync')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  let roomClock = Date.now()
  roomsOf(h.ctx).clock = () => (roomClock += 2000)
  let now = Date.now()
  const pushes: NativeSend[] = [], syncs: NativeSend[] = []
  let syncAnswer = 200
  p = new PushService(h.ctx, {
    config: () => null, native: () => ({ url: 'https://push.example.test' }), now: () => now,
    transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { pushes.push(i); return { statusCode: 200 } },
    syncTransport: async (i) => { syncs.push(i); return { statusCode: syncAnswer } },
  })
  const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(nora.id) as { id: string }).id
  const token = platform === 'ios' ? crypto.randomBytes(32).toString('hex') : `fcm:${'A'.repeat(140)}`
  const device = p.registerDevice(nora.id, sid, { consent: true, platform, environment: 'production', token, ...(o.sync === false ? {} : { sync: true as const }) })
  await new Promise((r) => setTimeout(r, 5))
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const send = (c: Client, body: string) => c.call('POST', `/api/rooms/${dm.id}/messages`, { body, clientMessageId: cm() })
  const tick = async (ms = SYNC_EVERY_MS) => { now += ms; await p!.tick() }
  return { mia, nora, dm, send, tick, pushes, syncs, device, setAnswer: (n: number) => { syncAnswer = n }, advance: (ms: number) => { now += ms } }
}

test('Android: notices read on the desktop leave the phone in one sync, ids only, no number, no text', async () => {
  const { mia, nora, dm, send, tick, pushes, syncs, device } = await setup('android')
  for (const body of ['one', 'two', 'three']) { await send(mia.client, body); await tick(1000) }
  expect(pushes.map((s) => s.payload.code)).toEqual(['room.dm', 'room.dm', 'room.dm'])
  const ids = pushes.map((s) => s.payload.notificationId)
  // nothing read yet: no sync
  await tick()
  expect(syncs).toHaveLength(0)
  // read on the computer: one sync with every id, newest first
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick()
  expect(syncs).toHaveLength(1)
  const s = syncs[0]!
  expect(s.sync).toBeDefined()
  expect([...s.sync!.clear].sort()).toEqual([...ids].sort())
  expect(s.sync!.clear[0]).toBe(ids[2]!)
  expect(s.sync!.tag).toBe(device.id)
  expect('badge' in s.sync!).toBe(false)
  expect(s.payload.code).toBe(PUSH_SYNC_CODE)
  // nothing but ids, the device and the language: never a path, a label or words
  expect(Object.keys(s.sync!).sort()).toEqual(['clear', 'locale', 'notificationId', 'tag'])
  expect(JSON.stringify(s.sync)).not.toMatch(/one|two|three|mia/)
  // nothing new: no second sync, however long
  await tick(SYNC_GAP_MS + 1)
  await tick(SYNC_GAP_MS + 1)
  expect(syncs).toHaveLength(1)
})

test('a burst of reads is one sync; the next read waits out the gap and then lists the whole set again', async () => {
  const { mia, nora, dm, send, tick, pushes, syncs } = await setup('android')
  await send(mia.client, 'a'); await tick(1000)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick()
  expect(syncs).toHaveLength(1)
  // another notice, pushed and read 5 s later: within the gap, nothing yet
  await send(mia.client, 'b'); await tick(1000)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick()
  expect(syncs).toHaveLength(1)
  // after the gap: one more, with both ids (a sync lost while the phone was offline costs nothing)
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(2)
  expect([...syncs[1]!.sync!.clear].sort()).toEqual(pushes.map((x) => x.payload.notificationId).sort())
})

test('iPhone: the icon number follows reads; a failed sync is tried again; a number unchanged sends nothing', async () => {
  const { mia, nora, dm, send, tick, pushes, syncs, setAnswer } = await setup('ios')
  await send(mia.client, 'hi'); await tick(1000)
  await send(mia.client, 'again'); await tick(1000)
  expect(pushes.map((s) => s.payload.badge)).toEqual([1, 2])
  setAnswer(502)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick()
  expect(syncs).toHaveLength(1)
  expect(syncs[0]!.sync!.badge).toBe(0)
  // the gateway failed: the same sync again after the gap
  setAnswer(200)
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(2)
  expect(syncs[1]!.sync!.badge).toBe(0)
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(2)
})

test('an Android app from before syncs (no push-sync-v1) gets none; a phone push switched off gets none', async () => {
  const { mia, nora, dm, send, tick, syncs } = await setup('android', { sync: false })
  await send(mia.client, 'x'); await tick(1000)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick(); await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(0)
})

test('the transport sends a sync once, as a contract sync; a gateway that refuses it gets none for an hour and never one without sync', async () => {
  h = await harness('push-read-sync-transport')
  const seen: Record<string, unknown>[] = []
  let strict = false
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
    const body = JSON.parse(await req.text()) as Record<string, unknown>
    seen.push(body)
    if (strict && 'sync' in body) return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 })
    return Response.json({ ok: true })
  } })
  try {
    const now = Date.now()
    const transport = createNativeTransport({ dataDir: h.ctx.config.dataDir, now: () => now })
    const input = (platform: 'ios' | 'android'): NativeSend => ({
      device: platform === 'ios' ? { platform, token: 'ab'.repeat(32), environment: 'production' } : { platform, token: `fcm:${'A'.repeat(140)}`, environment: 'production' },
      payload: { notificationId: 's-1', code: PUSH_SYNC_CODE, locale: 'en' }, sync: { notificationId: 's-1', locale: 'en', tag: 'dev-1', badge: 2, clear: ['n-1', 'n-2', 'bad id!'] },
      config: { url: `http://127.0.0.1:${server.port}` }, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 86400,
    })
    expect(await transport(input('ios'))).toEqual({ statusCode: 200 })
    expect(parsePushGatewaySend(seen[0])).toEqual({ v: 1, platform: 'ios', environment: 'production', token: 'ab'.repeat(32), notificationId: 's-1', code: PUSH_SYNC_CODE, locale: 'en', tag: 'dev-1', ttlSeconds: 86400, sync: true, badge: 2, clear: ['n-1', 'n-2'] })
    // Android: no number
    await transport(input('android'))
    expect(parsePushGatewaySend(seen[1])).toMatchObject({ platform: 'android', sync: true, clear: ['n-1', 'n-2'] })
    expect('badge' in seen[1]!).toBe(false)
    // an older gateway: refused once, nothing sent again (never without `sync`), and none for the hour
    strict = true; seen.length = 0
    expect(await transport(input('ios'))).toEqual({ statusCode: 400, error: 'invalid_body' })
    expect(await transport(input('ios'))).toEqual({ statusCode: 400, error: SYNC_UNSUPPORTED })
    expect(seen).toHaveLength(1)
  } finally { server.stop(true) }
})

test('a pushed notice deleted since (its delivery row goes with it) leaves the phone too; an unread one stays', async () => {
  const { mia, send, tick, pushes, syncs } = await setup('android')
  await send(mia.client, 'first'); await tick(1000)
  await send(mia.client, 'second'); await tick(1000)
  const [gone, kept] = pushes.map((s) => s.payload.notificationId)
  h.ctx.db.query('DELETE FROM room_notices WHERE id = ?').run(gone!)
  await tick()
  expect(syncs).toHaveLength(1)
  expect(syncs[0]!.sync!.clear).toEqual([gone!])
  expect(syncs[0]!.sync!.clear).not.toContain(kept!)
})
