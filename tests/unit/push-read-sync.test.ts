// A phone follows reads made on another device (docs/AGENTS/plan/20261123-0705-phone-badge-sync.md): a notice pushed to
// a phone and then read elsewhere goes to that phone in one silent sync (push-service.ts syncPhones): the ids to take
// off and an iPhone's new icon number, nothing else. A burst of reads is one sync; an Android app from before syncs gets
// none; a gateway from before syncs gets none and never a sync without `sync`.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { roomsOf } from '../../server/src/rooms/service'
import { PushService, SYNC_GAP_MS, SYNC_EVERY_MS, SYNC_PER_DAY } from '../../server/src/notifications/push-service'
import { createNativeTransport, SYNC_NOTHING_SENT, SYNC_UNSUPPORTED, type NativeSend } from '../../server/src/notifications/push-native'
import { parsePushGatewaySend, PUSH_SYNC_CODE } from '../../shared/src/cloud-protocol/push-gateway'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

async function setup(platform: 'ios' | 'android', o: { sync?: boolean; clear?: boolean } = {}) {
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
  const device = p.registerDevice(nora.id, sid, { consent: true, platform, environment: 'production', token, ...(o.sync === false ? {} : { sync: true as const }), ...(o.clear ? { clear: true as const } : {}) })
  await new Promise((r) => setTimeout(r, 5))
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const send = (c: Client, body: string) => c.call('POST', `/api/rooms/${dm.id}/messages`, { body, clientMessageId: cm() })
  const tick = async (ms = SYNC_EVERY_MS) => { now += ms; await p!.tick() }
  return { mia, nora, dm, send, tick, pushes, syncs, device, sid, token, setAnswer: (n: number) => { syncAnswer = n }, advance: (ms: number) => { now += ms }, today: () => new Date(now).toISOString().slice(0, 10) }
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
  // the number only, now or never: never the read ids
  expect(syncs[0]!.sync!.clear).toEqual([])
  expect(syncs[0]!.ttlSeconds).toBe(0)
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
    // an iPhone: the number and the ids the server gave (an app with push-clear-v1), now or never (ttl 0)
    expect(parsePushGatewaySend(seen[0])).toEqual({ v: 1, platform: 'ios', environment: 'production', token: 'ab'.repeat(32), notificationId: 's-1', code: PUSH_SYNC_CODE, locale: 'en', tag: 'dev-1', ttlSeconds: 0, sync: true, badge: 2, clear: ['n-1', 'n-2'] })
    // Android: no number
    await transport(input('android'))
    expect(parsePushGatewaySend(seen[1])).toMatchObject({ platform: 'android', sync: true, clear: ['n-1', 'n-2'], ttlSeconds: 86400 })
    expect('badge' in seen[1]!).toBe(false)
    // an older gateway: refused (an iPhone's ids, then the number alone), never sent without `sync`, none for the hour
    strict = true; seen.length = 0
    expect(await transport(input('ios'))).toEqual({ statusCode: 400, error: 'invalid_body' })
    expect(await transport(input('ios'))).toEqual({ statusCode: 400, error: SYNC_UNSUPPORTED })
    expect(await transport(input('android'))).toEqual({ statusCode: 400, error: SYNC_UNSUPPORTED })
    expect(seen.map((b) => [b.sync, 'clear' in b])).toEqual([[true, true], [true, false]])
  } finally { server.stop(true) }
})

test('a gateway from before iPhone ids: the sync goes again at once with the number alone, Android syncs go on, ids alone send nothing', async () => {
  h = await harness('push-read-sync-old-gateway')
  const seen: Record<string, unknown>[] = []
  // the gateway as deployed before this change: syncs, but `clear` for Android only
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
    const body = JSON.parse(await req.text()) as Record<string, unknown>
    seen.push(body)
    if (body.platform === 'ios' && 'clear' in body) return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 })
    return Response.json({ ok: true })
  } })
  try {
    let now = Date.now()
    const transport = createNativeTransport({ dataDir: h.ctx.config.dataDir, now: () => now })
    const input = (platform: 'ios' | 'android', badge?: number): NativeSend => ({
      device: platform === 'ios' ? { platform, token: 'ab'.repeat(32), environment: 'production' } : { platform, token: `fcm:${'A'.repeat(140)}`, environment: 'production' },
      payload: { notificationId: 's-1', code: PUSH_SYNC_CODE, locale: 'en' }, sync: { notificationId: 's-1', locale: 'en', clear: ['n-1'], ...(badge !== undefined ? { badge } : {}) },
      config: { url: `http://127.0.0.1:${server.port}` }, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 86400,
    })
    // refused with the ids, sent again at once with the number alone
    expect(await transport(input('ios', 1))).toEqual({ statusCode: 200 })
    expect(seen.map((b) => [b.platform, 'clear' in b, b.badge])).toEqual([['ios', true, 1], ['ios', false, 1]])
    // within the hour: no ids tried there; the number goes straight away; ids alone send nothing at all
    seen.length = 0
    expect(await transport(input('ios', 0))).toEqual({ statusCode: 200 })
    expect(await transport(input('ios'))).toEqual({ statusCode: 400, error: SYNC_NOTHING_SENT })
    expect(seen.map((b) => [b.platform, 'clear' in b, b.badge])).toEqual([['ios', false, 0]])
    // Android syncs to that gateway go on, with their ids
    seen.length = 0
    expect(await transport(input('android'))).toEqual({ statusCode: 200 })
    expect(seen.map((b) => [b.platform, b.clear])).toEqual([['android', ['n-1']]])
    // after the hour the ids are tried again
    now += 60 * 60_000 + 1; seen.length = 0
    await transport(input('ios', 1))
    expect(seen.map((b) => 'clear' in b)).toEqual([true, false])
  } finally { server.stop(true) }
})

test('iPhone with push-clear-v1: a read sends the ids with the lower number; a set that changed alone sends the ids without one', async () => {
  const { mia, nora, dm, send, tick, pushes, syncs, device } = await setup('ios', { clear: true })
  expect((h.ctx.db.query('SELECT sync_ok FROM push_subscriptions WHERE id = ?').get(device.id) as { sync_ok: number }).sync_ok).toBe(2)
  await send(mia.client, 'one'); await tick(1000)
  await send(mia.client, 'two'); await tick(1000)
  const ids = pushes.map((s) => s.payload.notificationId)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick()
  expect(syncs).toHaveLength(1)
  expect(syncs[0]!.sync!.badge).toBe(0)
  expect(syncs[0]!.sync!.clear).toEqual([ids[1]!, ids[0]!])
  expect(syncs[0]!.ttlSeconds).toBe(0)
  expect(JSON.stringify(syncs[0]!.sync)).not.toMatch(/one|two|mia/)
  // a pushed notice deleted since (the set changes, the number does not): the ids alone, and no number recorded
  await send(mia.client, 'three'); await tick(1000)
  const recorded = () => (h.ctx.db.query('SELECT badge FROM push_phone_sync WHERE subscription_id = ?').get(device.id) as { badge: number }).badge
  expect(recorded()).toBe(1)
  const third = pushes[2]!.payload.notificationId
  h.ctx.db.query('UPDATE room_notices SET suppressed = 1 WHERE id = ?').run(third)
  ;(p as any).o.badge = () => 1
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(2)
  expect('badge' in syncs[1]!.sync!).toBe(false)
  expect(syncs[1]!.sync!.clear).toContain(third)
  expect(recorded()).toBe(1)
  // nothing new: nothing more
  await tick(SYNC_GAP_MS); await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(2)
})

test('an iPhone app from before push-clear-v1 never gets ids; updating to it lists the notices already read', async () => {
  const { mia, nora, dm, send, tick, pushes, syncs, device, sid, token } = await setup('ios')
  expect((h.ctx.db.query('SELECT sync_ok FROM push_subscriptions WHERE id = ?').get(device.id) as { sync_ok: number }).sync_ok).toBe(1)
  await send(mia.client, 'one'); await tick(1000)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick()
  expect(syncs).toHaveLength(1)
  expect(syncs[0]!.sync!.clear).toEqual([])
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(1)
  // the app is updated and registers again with clear: its next sync lists the notice read before
  const nora2 = h.ctx.db.query('SELECT user_id FROM push_subscriptions WHERE id = ?').get(device.id) as { user_id: string }
  const again = p!.registerDevice(nora2.user_id, sid, { consent: true, platform: 'ios', environment: 'production', token, sync: true, clear: true })
  expect(again.id).toBe(device.id)
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(2)
  expect(syncs[1]!.sync!.clear).toEqual([pushes[0]!.payload.notificationId])
  expect('badge' in syncs[1]!.sync!).toBe(false)
})

test('the server: ids an older gateway could not take (nothing sent) are remembered without using the day\'s syncs', async () => {
  const { mia, send, tick, pushes, syncs, device, today } = await setup('ios', { clear: true })
  const svc = p as any
  svc.o.syncTransport = async (i: NativeSend) => { syncs.push(i); return { statusCode: 400, error: SYNC_NOTHING_SENT } }
  await send(mia.client, 'one'); await tick(1000)
  h.ctx.db.query('UPDATE room_notices SET suppressed = 1 WHERE id = ?').run(pushes[0]!.payload.notificationId)
  svc.o.badge = () => 1
  await tick()
  expect(syncs).toHaveLength(1)
  const st = h.ctx.db.query('SELECT synced_at, day, day_count, digest FROM push_phone_sync WHERE subscription_id = ?').get(device.id) as { synced_at: string | null; day: string | null; day_count: number; digest: string | null }
  expect(st.digest).not.toBeNull()
  expect(st.synced_at).toBeNull()
  expect(st.day === today() ? st.day_count : 0).toBe(0)
  // and it is not tried again every round
  await tick(SYNC_GAP_MS); await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(1)
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

test('an iPhone gets a sync only when its number goes down, never for a higher one; nothing is worked out without a read', async () => {
  const { mia, nora, dm, send, tick, pushes, syncs } = await setup('ios')
  let asked = 0
  const real = (p as any).o.badge
  ;(p as any).o.badge = (id: string) => { asked++; return real(id) }
  await send(mia.client, 'one'); await tick(1000)
  expect(pushes.map((s) => s.payload.badge)).toEqual([1])
  // its first look works the count out once; then, with no read, a round works out nothing, however often
  await tick(SYNC_GAP_MS)
  const before = asked
  for (let i = 0; i < 4; i++) await tick(SYNC_GAP_MS)
  expect(asked).toBe(before)
  expect(syncs).toHaveLength(0)
  // read on the computer: the number went down, one sync
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick(SYNC_GAP_MS)
  expect(syncs.map((s) => s.sync!.badge)).toEqual([0])
})

test('the daily limit: a phone that had SYNC_PER_DAY syncs today gets none until the next day', async () => {
  const { mia, nora, dm, send, tick, syncs, device, today } = await setup('android')
  await send(mia.client, 'x'); await tick(1000)
  h.ctx.db.query('INSERT INTO push_phone_sync(subscription_id,day,day_count) VALUES(?,?,?)').run(device.id, today(), SYNC_PER_DAY)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick(); await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(0)
  // the next UTC day (the count is per day)
  h.ctx.db.query("UPDATE push_phone_sync SET day='2000-01-01' WHERE subscription_id=?").run(device.id)
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(1)
})

test('a sync answered 410 (the phone is gone) removes the device, as a real push does', async () => {
  const { mia, nora, dm, send, tick, syncs, device, setAnswer } = await setup('android')
  await send(mia.client, 'x'); await tick(1000)
  setAnswer(410)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  await tick()
  expect(syncs).toHaveLength(1)
  expect(h.ctx.db.query('SELECT 1 FROM push_subscriptions WHERE id = ?').get(device.id)).toBeNull()
})

test('one transport for pushes and syncs: a sync the gateway has not answered never holds a real push back', async () => {
  h = await harness('push-read-sync-together')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  let roomClock = Date.now()
  roomsOf(h.ctx).clock = () => (roomClock += 2000)
  let now = Date.now(), release = () => {}
  const sent: NativeSend[] = []
  const transport = async (i: NativeSend) => {
    sent.push(i)
    // a sync hangs until released (a slow gateway); a real push is answered at once
    if (i.sync) await new Promise<void>((r) => { release = r })
    return { statusCode: 200 }
  }
  p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), now: () => now, requestTimeoutMs: 60_000,
    transport: async () => { throw new Error('no web push here') }, nativeTransport: transport, syncTransport: transport })
  const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(nora.id) as { id: string }).id
  p.registerDevice(nora.id, sid, { consent: true, platform: 'android', environment: 'production', token: `fcm:${'A'.repeat(140)}`, sync: true })
  await new Promise((r) => setTimeout(r, 5))
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: 'first', clientMessageId: cm() })
  now += 1000; await p.tick()
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  now += SYNC_EVERY_MS; const first = p.tick()
  const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); return ok() }
  expect(await until(() => sent.some((s) => s.sync))).toBe(true)
  // the sync waits at the gateway; a new message is pushed meanwhile
  await mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body: 'second', clientMessageId: cm() })
  now += 1000; void p.tick()
  expect(await until(() => sent.filter((s) => !s.sync).length === 2)).toBe(true)
  release(); await first
})

test('an iPhone whose number went up since its last push gets no sync (the next real push carries it)', async () => {
  const { mia, send, tick, syncs, device } = await setup('ios')
  await send(mia.client, 'one'); await tick(1000)
  await send(mia.client, 'two'); await tick(1000)
  // the phone was last told 1, the count is 2 now (as after a message that pushes nothing); a read elsewhere moves the mark
  h.ctx.db.query('UPDATE push_phone_sync SET badge=1 WHERE subscription_id=?').run(device.id)
  h.ctx.db.query("UPDATE push_phone_sync SET read_mark='old' WHERE subscription_id=?").run(device.id)
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(0)
})

test('a real push that lands while an iPhone sync is under way wins: its number is kept, the sync never writes over it', async () => {
  h = await harness('push-read-sync-race')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  let roomClock = Date.now()
  roomsOf(h.ctx).clock = () => (roomClock += 2000)
  let now = Date.now(), release = () => {}, hang = true
  const pushes: NativeSend[] = [], syncs: NativeSend[] = []
  p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), now: () => now, requestTimeoutMs: 60_000,
    transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { pushes.push(i); return { statusCode: 200 } },
    syncTransport: async (i) => { syncs.push(i); if (hang) await new Promise<void>((r) => { release = r }); return { statusCode: 200 } } })
  const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(nora.id) as { id: string }).id
  const device = p.registerDevice(nora.id, sid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex') })
  await new Promise((r) => setTimeout(r, 5))
  const dm = await mia.client.call('POST', '/api/rooms', { kind: 'dm', userId: nora.id })
  const say = (body: string) => mia.client.call('POST', `/api/rooms/${dm.id}/messages`, { body, clientMessageId: cm() })
  const recorded = () => (h.ctx.db.query('SELECT badge FROM push_phone_sync WHERE subscription_id = ?').get(device.id) as { badge: number }).badge
  const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); return ok() }
  await say('one'); now += 1000; await p.tick()
  await say('two'); now += 1000; await p.tick()
  expect(recorded()).toBe(2)
  // read on the computer: a sync with 0 goes and waits at the gateway
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  now += SYNC_EVERY_MS; const round = p.tick()
  expect(await until(() => syncs.length === 1)).toBe(true)
  expect(syncs[0]!.sync!.badge).toBe(0)
  // meanwhile a new message is pushed with 1
  await say('three'); now += 1000; void p.tick()
  expect(await until(() => pushes.length === 3)).toBe(true)
  expect(pushes[2]!.payload.badge).toBe(1)
  expect(await until(() => recorded() === 1)).toBe(true)
  // the sync is answered: the newer push's 1 stays recorded
  release(); await round
  expect(recorded()).toBe(1)
  // and a later round sends nothing: the count is 1, as recorded (no sync with 0 for an unread notice)
  hang = false
  now += SYNC_GAP_MS; await p.tick()
  now += SYNC_GAP_MS; await p.tick()
  expect(syncs).toHaveLength(1)
})

test('an iPhone ids-only sync whose round began before a real push reached the phone is dropped too', async () => {
  const { mia, send, tick, pushes, syncs, device } = await setup('ios', { clear: true })
  await send(mia.client, 'one'); await tick(1000)
  h.ctx.db.query('UPDATE room_notices SET suppressed = 1 WHERE id = ?').run(pushes[0]!.payload.notificationId)
  const svc = p as any
  svc.o.badge = () => { svc.pushedAt.set(device.id, ++svc.pushSeq); return 1 }
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(0)
  svc.o.badge = () => 1
  await tick(SYNC_GAP_MS)
  expect(syncs.map((s) => s.sync!.clear)).toEqual([[pushes[0]!.payload.notificationId]])
})

test('an iPhone sync whose round began before a real push reached the phone is dropped before it is sent', async () => {
  const { mia, nora, dm, send, tick, syncs, device } = await setup('ios')
  await send(mia.client, 'one'); await tick(1000)
  await send(mia.client, 'two'); await tick(1000)
  await nora.client.call('POST', `/api/rooms/${dm.id}/read`, { seq: 999 })
  // the round works out its number, then a real push reaches the phone before the sync goes
  const svc = p as any, real = svc.o.badge
  svc.o.badge = (id: string) => { svc.pushedAt.set(device.id, ++svc.pushSeq); return real(id) }
  await tick(SYNC_GAP_MS)
  expect(syncs).toHaveLength(0)
  // the next round (no push since it began) sends it
  svc.o.badge = real
  await tick(SYNC_GAP_MS)
  expect(syncs.map((s) => s.sync!.badge)).toEqual([0])
})
