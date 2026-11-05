import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FileTransfers, MobileReceiver, onceEvery, PushRefused, type TransferIO } from '../../mobile/src/bridge'
import { currentDevice, leaveTeam, rememberDevice, retryRemovals, type DeviceDeps, type TeamDevice } from '../../mobile/src/device'
import { APPEARANCE_CAPABILITY, MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_PERMISSION_CAPABILITY, PUSH_REGISTERED_CAPABILITY, notificationPath, parseMessage, tappedNotificationPath, validConfig, validPushToken, type MobileConfig, type PushPermission, type PushToken } from '../../mobile/src/protocol'
import { DARK, LIGHT, NO_INSETS, frame, insetScript, isDark, padding, pageInsets } from '../../mobile/src/look'
import { IOS_USAGE, offlineError, stringsFor } from '../../mobile/src/strings'
import appConfig from '../../mobile/app.config'

const config: MobileConfig = { protocol: 1, platform: 'ios', appVersion: '1.0.0', nonce: 'a'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
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
  // camera and microphone for the team page as on iOS; no overlay windows
  expect(c.android?.permissions).toEqual(['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'])
  expect(c.android?.blockedPermissions).toEqual(['android.permission.SYSTEM_ALERT_WINDOW'])
  expect(JSON.stringify(c.plugins)).toContain('"targetSdkVersion":36,"compileSdkVersion":37')
  expect(c.plugins).toContain('./plugins/release-signing.js')
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
  const old = make(async () => ios, [...MOBILE_CAPABILITIES, PUSH_CAPABILITY])
  expect((await old.receiver.receive(old.request({ type: 'push-registered', deviceId: 'dev_1', removeKey: 'k'.repeat(43) }), 'https://team.example'))?.error).toBe('push_unavailable')
})

test('a tap whose device is another one (another team) opens nothing; none (older server) still opens', () => {
  const since = Date.UTC(2026, 10, 5), at = since + 5000
  expect(tappedNotificationPath({ path: '/rooms/r1', device: 'dev_now' }, at, since, 'dev_now')).toBe('/rooms/r1')
  expect(tappedNotificationPath({ path: '/rooms/r1', device: 'dev_old_team' }, at, since, 'dev_now')).toBeNull()
  expect(tappedNotificationPath({ path: '/rooms/r1' }, at, since, 'dev_now')).toBe('/rooms/r1')
  expect(tappedNotificationPath({ path: '/rooms/r1', device: 'dev_x' }, at, since, null)).toBe('/rooms/r1')
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

test('Android release signing comes from the environment only: no key, path or password is written into the build file', async () => {
  const { applyReleaseSigning } = await import('../../mobile/plugins/release-signing-gradle.js')
  const template = `android {\n    signingConfigs {\n        debug {\n            storeFile file('debug.keystore')\n        }\n    }\n    buildTypes {\n        debug {\n            signingConfig signingConfigs.debug\n        }\n        release {\n            // Caution!\n            signingConfig signingConfigs.debug\n            minifyEnabled false\n        }\n    }\n}\n`
  const out = applyReleaseSigning(template)
  expect(out).toContain("storeFile file(System.getenv('ANDROID_KEYSTORE_PATH'))")
  expect(out).toContain("storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')")
  expect(out).toContain("signingConfig System.getenv('ANDROID_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug")
  expect(out.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(1) // the debug build type keeps the debug key
  expect(applyReleaseSigning(out)).toBe(out)
  expect(() => applyReleaseSigning('android {}')).toThrow()
})

test('with MYCEL_MOBILE_GOOGLE_SERVICES Android has push, and the file path stays out of the config the app embeds', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'acme-fcm-'))
  const file = path.join(dir, 'google-services.json'); fs.writeFileSync(file, '{"project_info":{"project_id":"acme-test"},"client":[]}')
  try {
    process.env.MYCEL_MOBILE_EDITION = 'trina'; process.env.MYCEL_MOBILE_GOOGLE_SERVICES = file
    const c = appConfig({ config: {}, projectRoot: mobileRoot } as never)
    expect(c.extra?.pushEnabled).toEqual({ ios: true, android: true })
    expect(JSON.stringify(c)).not.toContain(dir)
    expect(c.plugins).toContain('./plugins/google-services.js')
    process.env.MYCEL_MOBILE_GOOGLE_SERVICES = path.join(dir, 'other.json')
    expect(() => appConfig({ config: {}, projectRoot: mobileRoot } as never)).toThrow()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

function permissionApp(answer: PushPermission | (() => Promise<PushPermission>), capabilities: readonly string[] = [...config.capabilities, PUSH_PERMISSION_CAPABILITY, APPEARANCE_CAPABILITY]) {
  const calls: string[] = [], looks: { dark: boolean; system: boolean }[] = []
  const receiver = new MobileReceiver('https://team.example', { ...config, capabilities }, new FileTransfers(io), async () => {}, {
    token: async () => { calls.push('token'); return ios }, registered: async () => {},
    permission: async () => { calls.push('permission'); return typeof answer === 'function' ? answer() : answer },
    openSettings: async () => { calls.push('settings') },
  }, look => { looks.push(look) })
  const send = (type: string, over: object = {}, source = 'https://team.example/rooms') => receiver.receive(JSON.stringify({ v: 1, nonce: config.nonce, generation: 1, id: 'permission-1', type, ...over }), source)
  return { receiver, send, calls, looks }
}

test('push-permission-v1: the page learns the OS answer without a prompt, through the same origin and nonce checks', async () => {
  for (const answer of ['granted', 'undetermined', 'denied'] as const) {
    const f = permissionApp(answer)
    expect(await f.send('push-permission')).toMatchObject({ ok: true, for: 'push-permission', permission: answer })
    expect(f.calls).toEqual(['permission']) // never the token request, so never the OS prompt
  }
  const f = permissionApp('granted')
  expect(await f.send('push-permission', {}, 'https://evil.example/')).toBeNull()
  expect(await f.send('push-permission', { nonce: 'b'.repeat(64) })).toBeNull()
  expect(f.calls).toEqual([])
  expect(await f.send('open-settings')).toMatchObject({ ok: true, for: 'open-settings' })
  expect(f.calls).toEqual(['settings'])
  // an app without the capability (store builds 1 and 2) answers neither
  const old = permissionApp('granted', config.capabilities)
  expect((await old.send('push-permission'))?.error).toBe('push_unavailable')
  expect((await old.send('open-settings'))?.error).toBe('push_unavailable')
  expect(old.calls).toEqual([])
  // a build without push says so; an odd native answer is not passed on
  expect((await permissionApp(async () => { throw new PushRefused('push_unavailable') }).send('push-permission'))?.error).toBe('push_unavailable')
  expect((await permissionApp(async () => 'provisional' as PushPermission).send('push-permission'))?.error).toBe('push_unavailable')
})

test('appearance-v1: only a boolean look (and whether it follows the phone), only with the capability', async () => {
  for (const bad of [{ dark: 'yes' }, { dark: true, system: 'no' }]) expect(parseMessage(JSON.stringify({ v: 1, nonce: config.nonce, generation: 1, id: 'appearance-1', type: 'appearance', ...bad }))).toBeNull()
  const f = permissionApp('granted')
  expect((await f.send('appearance', { dark: true }))?.ok).toBe(true)
  expect((await f.send('appearance', { dark: false, system: true }))?.ok).toBe(true)
  expect(await f.send('appearance', { dark: true }, 'https://evil.example')).toBeNull()
  expect(f.looks).toEqual([{ dark: true, system: false }, { dark: false, system: true }])
  const old = permissionApp('granted', config.capabilities)
  expect((await old.send('appearance', { dark: true }))?.ok).toBe(false)
  expect(old.looks).toEqual([])
})

test('the look: the page says first, the phone before that; insets reach the page as CSS variables, even before it has a root', () => {
  expect(isDark(null, 'dark')).toBe(true); expect(isDark(null, 'light')).toBe(false); expect(isDark(null, null)).toBe(false)
  expect(isDark(false, 'dark')).toBe(false); expect(isDark(true, 'light')).toBe(true)
  expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort())
  const css = fs.readFileSync(path.join(import.meta.dir, '../../web/src/theme.edition.css'), 'utf8')
  expect(css).toContain(`--c-canvas: ${LIGHT.canvas};`); expect(css).toContain(`--c-canvas: ${DARK.canvas};`)
  const set = new Map<string, string>()
  let root: object | null = null, observer: (() => void) | null = null
  const document = { get documentElement() { return root } }
  class MutationObserver { constructor(cb: () => void) { observer = cb } observe() {} disconnect() { observer = null } }
  const script = insetScript({ top: 59, right: 0, bottom: 34, left: Number.NaN })
  new Function('document', 'MutationObserver', script)(document, MutationObserver)
  expect(set.size).toBe(0); expect(observer).not.toBeNull()
  root = { style: { setProperty: (k: string, v: string) => set.set(k, v) } }
  observer!()
  expect(Object.fromEntries(set)).toEqual({ '--app-inset-top': '59px', '--app-inset-right': '0px', '--app-inset-bottom': '34px', '--app-inset-left': '0px' })
  expect(observer).toBeNull()
})

test('a page that does not pad itself (a team server not updated yet) keeps the app padding it had before', () => {
  const insets = { top: 59, right: 0, bottom: 34, left: 0 }
  const f = (o: Partial<Parameters<typeof frame>[0]>) => frame({ selfPadded: false, android: false, footer: false, keyboard: 0, insets, ...o })
  // iOS: below the status bar; the page itself keeps clear of the home indicator through env(), as before
  expect(f({})).toEqual({ top: 59, bottom: 0 })
  // Android: below the status bar and above the navigation bar (its WebView reports no insets), not under the footer
  expect(f({ android: true })).toEqual({ top: 59, bottom: 34 })
  expect(f({ android: true, footer: true })).toEqual({ top: 59, bottom: 0 })
  // once the page said it pads itself (appearance-v1): the whole screen
  expect(f({ selfPadded: true })).toEqual({ top: 0, bottom: 0 })
  expect(f({ selfPadded: true, android: true })).toEqual({ top: 0, bottom: 0 })
  // the Android keyboard lifts the page either way, by its height plus the navigation bar
  expect(f({ android: true, keyboard: 300 })).toEqual({ top: 59, bottom: 334 })
  expect(f({ android: true, keyboard: 300, selfPadded: true })).toEqual({ top: 0, bottom: 334 })
  expect(f({ keyboard: 300 })).toEqual({ top: 59, bottom: 0 }) // iOS: WKWebView handles its keyboard
})

test('open-settings: at most once every few seconds, whatever the page sends', () => {
  let t = 1_000_000
  const once = onceEvery(3000, () => t)
  expect(once()).toBe(true)
  t += 100; expect(once()).toBe(false)
  t += 2899; expect(once()).toBe(false)
  t += 1; expect(once()).toBe(true)
})

test('padding on full loads: the old page keeps its frame at load start; no padding back while the team pads itself', () => {
  const predicted = { selfPadded: true, confirmed: false }
  const confirmed = padding(predicted, 'appearance')
  expect(confirmed).toEqual({ selfPadded: true, confirmed: true })
  // a reload: the old page is still on screen, the frame stays edge to edge (iOS fires load start before the page)
  const reloading = padding(confirmed, 'load-start')
  expect(reloading.selfPadded).toBe(true)
  expect(padding(reloading, 'appearance')).toEqual(confirmed) // the new page says so again: nothing moved
  // a page that never said it pads itself (an older web app came back): the app pads it again
  expect(padding(reloading, 'unconfirmed')).toEqual({ selfPadded: false, confirmed: false })
  expect(padding(confirmed, 'unconfirmed')).toEqual(confirmed) // a confirmed page is never padded twice
  // a team server that has not updated: padded throughout
  const old = { selfPadded: false, confirmed: false }
  expect(padding(padding(old, 'load-start'), 'unconfirmed')).toEqual(old)
  // the page's inset variables: real ones only while it pads itself, zero while the app pads it
  const insets = { top: 24, right: 0, bottom: 48, left: 0 }
  expect(pageInsets(true, insets)).toEqual(insets)
  expect(pageInsets(false, insets)).toEqual(NO_INSETS)
})
