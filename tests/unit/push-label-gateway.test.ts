// The team server's request to the push gateway for an Android app that names who and where (docs/DECISIONS.md "Android
// notifications name who and where"): `label: true` for a room code or chat.shared to an Android device only; a gateway
// from before it (400 invalid_body) gets the same push again without it, and none with it for an hour
// (server/src/notifications/push-native.ts createNativeTransport).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { parsePushGatewaySend } from '@mycel/shared/cloud-protocol'
import { createNativeTransport, NO_BADGE_RETRY_MS, type NativeSend } from '../../server/src/notifications/push-native'
import { harness, type Harness } from './a-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('label goes to Android for a room code or chat.shared; an older gateway gets the push again without it, then none for an hour', async () => {
  h = await harness('push-label-gateway')
  const seen: Record<string, unknown>[] = []
  let strict = false
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => {
    const body = JSON.parse(await req.text()) as Record<string, unknown>
    seen.push(body)
    if (strict && 'label' in body) return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 })
    return Response.json({ ok: true })
  } })
  try {
    let now = Date.now()
    const transport = createNativeTransport({ dataDir: h.ctx.config.dataDir, now: () => now })
    const android = { platform: 'android' as const, token: 'fcm:' + 'A'.repeat(140), environment: 'production' as const }
    const ios = { platform: 'ios' as const, token: 'ab'.repeat(32), environment: 'production' as const }
    const input = (code: string, device: NativeSend['device'] = android, label = true): NativeSend => ({ device, payload: { notificationId: 'n-1', code: code as never, locale: 'en', ...(label ? { label: true as const } : {}) }, config: { url: `http://127.0.0.1:${server.port}` }, signal: new AbortController().signal, beforeSend: () => true, ttlSeconds: 60 })
    expect(await transport(input('room.dm'))).toEqual({ statusCode: 200 })
    expect(seen[0]!.label).toBe(true)
    expect(parsePushGatewaySend(seen[0])?.label).toBe(true)
    seen.length = 0
    await transport(input('chat.shared'))
    // never for another code, an iPhone, or without the flag
    await transport(input('schedule.success'))
    await transport(input('room.dm', ios))
    await transport(input('room.dm', android, false))
    expect(seen.map((b) => b.label ?? null)).toEqual([true, null, null, null])
    // an older gateway: the same push without it, then none with it
    strict = true; seen.length = 0
    expect(await transport(input('room.mention'))).toEqual({ statusCode: 200 })
    expect(seen.map((b) => b.label ?? null)).toEqual([true, null])
    seen.length = 0
    await transport(input('room.dm'))
    expect(seen.map((b) => b.label ?? null)).toEqual([null])
    strict = false; now += NO_BADGE_RETRY_MS + 1; seen.length = 0
    await transport(input('room.dm'))
    expect(seen.map((b) => b.label ?? null)).toEqual([true])
  } finally { server.stop(true) }
})
