import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FileTransfers, MobileReceiver, PushRefused, type TransferIO } from '../../mobile/src/bridge'
import { currentDevice, leaveTeam, rememberDevice, retryRemovals, type DeviceDeps, type TeamDevice } from '../../mobile/src/device'
import { MOBILE_CAPABILITIES, PUSH_CAPABILITY, notificationPath, parseMessage, tappedNotificationPath, validConfig, validPushToken, type MobileConfig, type PushToken } from '../../mobile/src/protocol'
import { IOS_USAGE, offlineError, stringsFor } from '../../mobile/src/strings'
import appConfig from '../../mobile/app.config'

const config: MobileConfig = { protocol: 1, platform: 'ios', appVersion: '1.0.0', nonce: 'a'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY] }
const ios: PushToken = { platform: 'ios', token: 'ab'.repeat(32), environment: 'production' }
const io: TransferIO = { async create() {}, async append() {}, async inspect() { return { size: 0, sha256: '' } }, async share() {}, async remove() {} }
function make(source: (() => Promise<PushToken>) | undefined, capabilities = config.capabilities) {
  let asked = 0
  const registered: { deviceId: string; removeKey: string }[] = []
  const receiver = new MobileReceiver('https://team.example', { ...config, capabilities }, new FileTransfers(io), async () => {}, source && {
    token: async () => { asked++; return source() }, registered: async d => { registered.push(d) },
  })
  const request = (over: object = {}) => JSON.stringify({ v: 1, nonce: config.nonce, generation: 1, id: 'push-request-1', type: 'push-token', ...over })
  return { receiver, request, asked: () => asked, registered }
}

test('push-token-v1 is optional: a protocol 1 bridge without it stays valid, and the message has no payload', () => {
  expect(validConfig({ ...config, capabilities: [...MOBILE_CAPABILITIES] })).toBe(true)
  expect(validConfig(config)).toBe(true)
  expect(parseMessage(JSON.stringify({ v: 1, nonce: config.nonce, generation: 1, id: 'push-request-1', type: 'push-token' }))?.type).toBe('push-token')
  expect(parseMessage(JSON.stringify({ v: 1, nonce: 'x', generation: 1, id: 'push-request-1', type: 'push-token' }))).toBeNull()
})

test('the token goes only to the trusted origin with the current nonce and generation; nothing asks the OS otherwise', async () => {
  const f = make(async () => ios)
  for (const source of ['https://evil.example', 'about:blank', 'blob:https://team.example/id', 'https://u@team.example/']) expect(await f.receiver.receive(f.request(), source)).toBeNull()
  for (const over of [{ nonce: 'b'.repeat(64) }, { generation: 2 }, { v: 2 }]) expect(await f.receiver.receive(f.request(over), 'https://team.example/')).toBeNull()
  expect(f.asked()).toBe(0)
  const reply = await f.receiver.receive(f.request(), 'https://team.example/settings')
  expect(reply).toMatchObject({ ok: true, for: 'push-token', push: ios, nonce: config.nonce, generation: 1 })
  expect(Object.keys(reply!.push!).sort()).toEqual(['environment', 'platform', 'token'])
  expect(f.asked()).toBe(1)
})

test('refusals reach the page as push_denied / push_unavailable; other failures stay generic', async () => {
  expect((await make(async () => { throw new PushRefused('push_denied') }).receiver.receive(make(undefined).request(), 'https://team.example'))?.error).toBe('push_denied')
  expect((await make(undefined).receiver.receive(make(undefined).request(), 'https://team.example'))?.error).toBe('push_unavailable')
  const withoutCapability = make(async () => ios, [...MOBILE_CAPABILITIES])
  expect((await withoutCapability.receiver.receive(withoutCapability.request(), 'https://team.example'))?.error).toBe('push_unavailable')
  expect(withoutCapability.asked()).toBe(0)
  const bad = make(async () => ({ ...ios, token: 'not-hex' }))
  expect(await bad.receiver.receive(bad.request(), 'https://team.example')).toMatchObject({ ok: false, error: 'push_unavailable' })
  const broken = make(async () => { throw new Error('native detail') })
  expect(await broken.receiver.receive(broken.request(), 'https://team.example')).toMatchObject({ ok: false, error: 'mobile_operation_failed' })
})

test('a token that arrives after logout or navigation is not delivered to the next session', async () => {
  let release!: (t: PushToken) => void
  const f = make(() => new Promise<PushToken>(r => { release = r }))
  const pending = f.receiver.receive(f.request(), 'https://team.example')
  await Bun.sleep(1)
  await f.receiver.receive(f.request({ id: 'session-reset-1', type: 'session-reset' }), 'https://team.example')
  release(ios)
  expect(await pending).toBeNull()
  const g = make(() => new Promise<PushToken>(r => { release = r }))
  const pageGone = g.receiver.receive(g.request(), 'https://team.example')
  await Bun.sleep(1); await g.receiver.disable(); release(ios)
  expect(await pageGone).toBeNull()
})

test('device tokens: APNs lower-case hex, FCM opaque and production only', () => {
  expect(validPushToken(ios)).toBe(true)
  expect(validPushToken({ ...ios, environment: 'sandbox' })).toBe(true)
  for (const token of ['AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), 'ab'.repeat(101), 'ExponentPushToken[xyz]']) expect(validPushToken({ ...ios, token })).toBe(false)
  expect(validPushToken({ platform: 'android', environment: 'production', token: 'fcm:' + 'A'.repeat(140) })).toBe(true)
  expect(validPushToken({ platform: 'android', environment: 'sandbox', token: 'fcm:' + 'A'.repeat(140) })).toBe(false)
  expect(validPushToken({ platform: 'web', environment: 'production', token: 'ab'.repeat(32) })).toBe(false)
})

test('a tapped notification may only open an id path on the current team', () => {
  for (const p of ['/', '/rooms/abc_123', '/rooms/0193-ab/messages']) expect(notificationPath(p)).toBe(p)
  for (const p of ['', 'rooms/a', '//evil.example', '/rooms/../admin', '/rooms/a?x=1', '/rooms/a#x', 'https://evil.example/', '/\\evil', '/rooms//a', '/rooms/a/', 'javascript:alert(1)', '/' + 'a'.repeat(200), 42, null])
    expect(notificationPath(p)).toBeNull()
  const since = Date.UTC(2026, 10, 5)
  expect(tappedNotificationPath({ path: '/rooms/r1' }, since / 1000 + 5, since)).toBe('/rooms/r1') // iOS: seconds
  expect(tappedNotificationPath({ path: '/rooms/r1' }, since + 5000, since)).toBe('/rooms/r1') // Android: ms
  expect(tappedNotificationPath({ path: '/rooms/r1' }, since / 1000 - 60, since)).toBeNull() // before this team was chosen
  expect(tappedNotificationPath({ path: 'https://evil.example' }, since + 5000, since)).toBeNull()
  expect(tappedNotificationPath(null, since + 5000, since)).toBeNull()
})

test('the path rule matches the push gateway contract when it exists', async () => {
  const contract = path.join(import.meta.dir, '../../shared/src/cloud-protocol/push-gateway.ts')
  if (!fs.existsSync(contract)) return
  const { validPushPath } = await import(contract) as { validPushPath(p: string): boolean }
  for (const p of ['/', '/rooms/abc_123', '//evil.example', '/rooms/../admin', '/rooms/a?x=1', '/rooms/a/', '/' + 'a'.repeat(200)]) expect(validPushPath(p)).toBe(notificationPath(p) !== null)
})

test('native screens speak Korean or English; offline is told apart from an unreachable team', () => {
  expect(stringsFor('ko').retry).toBe('다시 시도')
  expect(stringsFor('ko-KR').offlineTitle).toContain('인터넷')
  expect(stringsFor('en').retry).toBe('Try again')
  expect(stringsFor(undefined)).toBe(stringsFor('fr'))
  expect(Object.keys(stringsFor('ko')).sort()).toEqual(Object.keys(stringsFor('en')).sort())
  expect(offlineError(-1009, undefined)).toBe(true)
  expect(offlineError(-2, 'net::ERR_INTERNET_DISCONNECTED')).toBe(true)
  expect(offlineError(-1004, 'Could not connect to the server.')).toBe(false)
  expect(Object.keys(IOS_USAGE.ko).sort()).toEqual(Object.keys(IOS_USAGE.en).sort())
})

const env = { ...process.env }
afterEach(() => { process.env = { ...env } })
const mobileRoot = path.join(import.meta.dir, '../../mobile')
test('the Trina edition builds app.trina.ax for iPhone only, with usage strings, no encryption claim and relative assets', () => {
  process.env.MYCEL_MOBILE_EDITION = 'trina'
  delete process.env.MYCEL_MOBILE_GOOGLE_SERVICES; delete process.env.MYCEL_MOBILE_BUILD_NUMBER
  const c = appConfig({ config: {}, projectRoot: mobileRoot } as never)
  expect(c.name).toBe('Trina AX'); expect(c.version).toBe('1.0.0')
  expect(c.ios).toMatchObject({ bundleIdentifier: 'app.trina.ax', supportsTablet: false, buildNumber: '1', appleTeamId: 'YWW96288YY', infoPlist: { ITSAppUsesNonExemptEncryption: false } })
  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSPhotoLibraryUsageDescription']) {
    expect(c.ios?.infoPlist?.[key]).toBeTruthy()
    expect((c.locales?.ko as { ios: Record<string, string> }).ios[key]).toMatch(/[가-힣]/)
  }
  expect(c.android).toMatchObject({ package: 'app.trina.ax', versionCode: 1 })
  expect(JSON.stringify(c.plugins)).toContain('"targetSdkVersion":36')
  expect(JSON.stringify(c.plugins)).toContain('expo-notifications')
  expect(c.extra?.pushEnabled).toEqual({ ios: true, android: false })
  for (const asset of [c.icon, c.android?.adaptiveIcon?.foregroundImage]) {
    expect(asset).toMatch(/^\.\.\/editions\/trina\/branding\/mobile\/[a-z-]+\.png$/)
    expect(fs.existsSync(path.join(mobileRoot, asset!))).toBe(true)
  }
  expect(JSON.stringify(c)).not.toContain(mobileRoot)
  process.env.MYCEL_MOBILE_BUILD_NUMBER = '7'
  expect(appConfig({ config: {}, projectRoot: mobileRoot } as never).ios?.buildNumber).toBe('7')
  for (const bad of ['0', '1.2', '-1', 'x']) { process.env.MYCEL_MOBILE_BUILD_NUMBER = bad; expect(() => appConfig({ config: {}, projectRoot: mobileRoot } as never)).toThrow() }
})
test('without an edition the neutral Team AX defaults stay; an edition name cannot leave the editions folder', () => {
  delete process.env.MYCEL_MOBILE_EDITION; delete process.env.MYCEL_MOBILE_BUILD_NUMBER
  const c = appConfig({ config: {}, projectRoot: mobileRoot } as never)
  expect(c.name).toBe('Team AX'); expect(c.ios?.bundleIdentifier).toBe('app.teamax.mobile.dev'); expect(c.icon).toBeUndefined()
  expect(JSON.stringify(c)).not.toContain('Trina')
  for (const bad of ['../trina', 'Trina', 'trina/../x']) { process.env.MYCEL_MOBILE_EDITION = bad; expect(() => appConfig({ config: {}, projectRoot: mobileRoot } as never)).toThrow() }
})

test('push-registered: the page hands over its device id and removal key through the same checks', async () => {
  const f = make(async () => ios)
  const msg = (over: object = {}) => f.request({ type: 'push-registered', deviceId: 'dev_1', removeKey: 'k'.repeat(43), ...over })
  expect(await f.receiver.receive(msg(), 'https://evil.example')).toBeNull()
  expect(await f.receiver.receive(msg({ nonce: 'b'.repeat(64) }), 'https://team.example')).toBeNull()
  for (const bad of [{ removeKey: 'short' }, { deviceId: '../x' }, { deviceId: 42 }]) expect(await f.receiver.receive(msg(bad), 'https://team.example')).toBeNull()
  expect(f.registered).toHaveLength(0)
  expect((await f.receiver.receive(msg(), 'https://team.example/'))?.ok).toBe(true)
  expect(f.registered).toEqual([{ deviceId: 'dev_1', removeKey: 'k'.repeat(43) }])
  const old = make(async () => ios, [...MOBILE_CAPABILITIES])
  expect((await old.receiver.receive(old.request({ type: 'push-registered', deviceId: 'dev_1', removeKey: 'k'.repeat(43) }), 'https://team.example'))?.error).toBe('push_unavailable')
})

test('a tap whose tag is another device (another team) opens nothing; no tag (older server) still opens', () => {
  const since = Date.UTC(2026, 10, 5), at = since + 5000
  expect(tappedNotificationPath({ path: '/rooms/r1', tag: 'dev_now' }, at, since, 'dev_now')).toBe('/rooms/r1')
  expect(tappedNotificationPath({ path: '/rooms/r1', tag: 'dev_old_team' }, at, since, 'dev_now')).toBeNull()
  expect(tappedNotificationPath({ path: '/rooms/r1' }, at, since, 'dev_now')).toBe('/rooms/r1')
  expect(tappedNotificationPath({ path: '/rooms/r1', tag: 'dev_x' }, at, since, null)).toBe('/rooms/r1')
})

function memory(remove: (d: TeamDevice) => Promise<boolean>) {
  const store = new Map<string, string>(); let t = Date.UTC(2026, 10, 5)
  const slot = (k: string) => ({ get: async () => store.get(k) ?? null, set: async (v: string | null) => { if (v === null) store.delete(k); else store.set(k, v) } })
  const deps: DeviceDeps = { current: slot('current'), pending: slot('pending'), remove, now: () => t }
  return { deps, store, advance: (ms: number) => { t += ms } }
}
const dev = (origin: string, deviceId: string): TeamDevice => ({ origin, deviceId, removeKey: 'r'.repeat(43), at: 0 })
test('leaving a team removes the device there; an unreachable team is retried at the next start, for 30 days at most', async () => {
  const calls: string[] = []; let online = false
  const m = memory(async d => { calls.push(d.deviceId); return online })
  await rememberDevice(m.deps, dev('https://a.example', 'dev_a'))
  expect((await currentDevice(m.deps, 'https://a.example'))?.deviceId).toBe('dev_a')
  expect(await currentDevice(m.deps, 'https://b.example')).toBeNull()
  await leaveTeam(m.deps, 'https://a.example')
  expect(calls).toEqual(['dev_a'])
  expect(await currentDevice(m.deps, 'https://a.example')).toBeNull()
  expect(JSON.parse(m.store.get('pending')!)).toHaveLength(1)
  online = true; await retryRemovals(m.deps)
  expect(calls).toEqual(['dev_a', 'dev_a']); expect(m.store.has('pending')).toBe(false)
  online = false
  await rememberDevice(m.deps, dev('https://b.example', 'dev_b')); await leaveTeam(m.deps, 'https://b.example')
  m.advance(31 * 86_400_000); await retryRemovals(m.deps)
  expect(calls.filter(c => c === 'dev_b')).toHaveLength(1)
  expect(m.store.has('pending')).toBe(false)
  for (let i = 0; i < 6; i++) { await rememberDevice(m.deps, dev(`https://t${i}.example`, `dev_${i}`)); await leaveTeam(m.deps, `https://t${i}.example`) }
  expect(JSON.parse(m.store.get('pending')!).map((d: TeamDevice) => d.deviceId)).toEqual(['dev_2', 'dev_3', 'dev_4', 'dev_5'])
})
