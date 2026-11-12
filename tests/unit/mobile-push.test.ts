import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { FileTransfers, MobileReceiver, onceEvery, PushRefused, StuckLoad, stillStuck, type TransferIO } from '../../mobile/src/bridge'
import { currentDevice, leaveTeam, rememberDevice, retryRemovals, startRemovals, type DeviceDeps, type TeamDevice } from '../../mobile/src/device'
import { readSessionCheck, sessionCheckScript } from '../../mobile/src/session-check'
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
  expect(c.name).toBe('Trina AX'); expect(c.version).toBe('1.0.4')
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

test('Android stuck load: the bridge comes back only on the page that was loading, and never after it was cancelled', () => {
  // fake timers: what was armed, and its callback
  let pending: (() => void) | null = null
  const set = ((fn: () => void) => { pending = fn; return 1 as unknown as ReturnType<typeof setTimeout> }) as unknown as typeof setTimeout
  const unset = (() => { pending = null }) as unknown as typeof clearTimeout
  const origin = 'https://team.example', page = 'https://team.example/rooms'
  let current = page, ready = false, failed = false
  const reinstalled: string[] = []
  const stuck = new StuckLoad(10_000, set, unset)
  const arm = () => stuck.arm(page, saved => stillStuck({ saved, current, origin, ready, failed }), url => reinstalled.push(url))
  arm(); pending!()
  expect(reinstalled).toEqual([page]) // still that page, not ready: installed again
  arm(); current = 'https://team.example/rooms/r1'; pending!() // a later navigation (reported as not loading) moved on
  arm(); current = 'https://other.example/'; pending!()
  current = page; arm(); ready = true; pending!() // its load end came after all
  ready = false; arm(); failed = true; pending!() // the failure screen is up
  expect(reinstalled).toEqual([page])
  // cancelled on the next load start, on load end, on the failure screen and when the team page goes away
  failed = false; arm(); expect(stuck.armed).toBe(true)
  stuck.cancel(); expect(stuck.armed).toBe(false); expect(pending).toBeNull()
  // the URL check alone
  expect(stillStuck({ saved: page, current: page, origin, ready: false, failed: false })).toBe(true)
  expect(stillStuck({ saved: 'https://evil.example/', current: 'https://evil.example/', origin, ready: false, failed: false })).toBe(false)
})

test('Android: turned off in the phone\'s Settings reads as denied; before the first question as undetermined', async () => {
  const { permissionFrom } = await import('../../mobile/src/permission')
  // Android 13+ reports "denied, may ask" before the first question and after the person turned it off
  expect(permissionFrom({ status: 'denied', canAskAgain: true, android: true, askedBefore: false })).toBe('undetermined')
  expect(permissionFrom({ status: 'denied', canAskAgain: true, android: true, askedBefore: true })).toBe('denied')
  expect(permissionFrom({ status: 'denied', canAskAgain: false, android: true, askedBefore: false })).toBe('denied')
  expect(permissionFrom({ status: 'granted', canAskAgain: true, android: true, askedBefore: true })).toBe('granted')
  // iOS says it plainly
  expect(permissionFrom({ status: 'undetermined', canAskAgain: true, android: false, askedBefore: true })).toBe('undetermined')
  expect(permissionFrom({ status: 'denied', canAskAgain: false, android: false, askedBefore: true })).toBe('denied')
})

test('a reinstall (keychain id kept, files gone) asks for the sign-out until it got an answer; an update or a first install does not', async () => {
  const { wasReinstalled, reinstallDone, MAX_SIGN_OUT_LAUNCHES } = await import('../../mobile/src/install')
  const make = (id: string | null, file: boolean, writable = true) => {
    let key = id, exists = file, tries: string | null = null
    const deps = {
      keychain: { get: async () => key, set: async (v: string | null) => { key = v } },
      tries: { get: async () => tries, set: async (v: string | null) => { tries = v } },
      marker: { exists: () => exists, create: () => { if (!writable) throw new Error('read-only'); exists = true }, remove: () => { exists = false } },
      newId: () => 'install-1',
    }
    return { deps, state: () => ({ key, exists, tries }) }
  }
  const ios = { ios: true, hasTeam: true }
  const reinstall = make('install-0', false)
  expect(await wasReinstalled(reinstall.deps, ios)).toBe(true)
  expect(reinstall.state().exists).toBe(false) // no marker until the sign-out got its answer
  expect(await wasReinstalled(reinstall.deps, ios)).toBe(true) // the server did not answer: the next launch tries again
  await reinstallDone(reinstall.deps)
  expect(reinstall.state()).toEqual({ key: 'install-0', exists: true, tries: null })
  expect(await wasReinstalled(reinstall.deps, ios)).toBe(false)
  // a server that never answers: given up after a few launches
  const unreachable = make('install-0', false)
  for (let i = 0; i < MAX_SIGN_OUT_LAUNCHES; i++) expect(await wasReinstalled(unreachable.deps, ios)).toBe(true)
  expect(await wasReinstalled(unreachable.deps, ios)).toBe(false)
  expect(unreachable.state().exists).toBe(true)
  const update = make(null, false) // from a build that wrote neither, or a first install
  expect(await wasReinstalled(update.deps, ios)).toBe(false)
  expect(update.state()).toMatchObject({ key: 'install-1', exists: true })
  expect(await wasReinstalled(make('install-0', true).deps, ios)).toBe(false) // an ordinary launch
  expect(await wasReinstalled(make('install-0', false, false).deps, ios)).toBe(false) // cannot write the marker: never act
})

test('a normal update whose marker cannot be written saves no id, so the next launch signs nobody out', async () => {
  const { wasReinstalled } = await import('../../mobile/src/install')
  let key: string | null = null, exists = false, writable = false
  const deps = {
    keychain: { get: async () => key, set: async (v: string | null) => { key = v } },
    tries: { get: async () => null, set: async () => {} },
    marker: { exists: () => exists, create: () => { if (!writable) throw new Error('disk full'); exists = true }, remove: () => { exists = false } },
    newId: () => 'install-1',
  }
  expect(await wasReinstalled(deps, { ios: true, hasTeam: true })).toBe(false)
  expect(key).toBeNull() // no id without the marker
  expect(await wasReinstalled(deps, { ios: true, hasTeam: true })).toBe(false) // the next launch: still no reinstall
  writable = true
  expect(await wasReinstalled(deps, { ios: true, hasTeam: true })).toBe(false)
  expect(key as string | null).toBe('install-1'); expect(exists).toBe(true)
})

test('a reinstall with no team saved writes the marker at once: a sign-in made later is never signed out', async () => {
  const { wasReinstalled } = await import('../../mobile/src/install')
  let exists = false, tries: string | null = '2'
  const deps = {
    keychain: { get: async () => 'install-0', set: async () => {} },
    tries: { get: async () => tries, set: async (v: string | null) => { tries = v } },
    marker: { exists: () => exists, create: () => { exists = true }, remove: () => { exists = false } },
    newId: () => 'install-1',
  }
  expect(await wasReinstalled(deps, { ios: true, hasTeam: false })).toBe(false)
  expect(exists).toBe(true); expect(tries as string | null).toBeNull()
  expect(await wasReinstalled(deps, { ios: true, hasTeam: true })).toBe(false) // the next launch, signed in: nothing
})

test('Android never takes the reinstall path, whatever the storage says', async () => {
  const { wasReinstalled } = await import('../../mobile/src/install')
  let touched = false
  const deps = {
    keychain: { get: async () => { touched = true; return 'install-0' }, set: async () => { touched = true } },
    tries: { get: async () => null, set: async () => { touched = true } },
    marker: { exists: () => { touched = true; return false }, create: () => { touched = true }, remove: () => { touched = true } },
    newId: () => 'install-1',
  }
  expect(await wasReinstalled(deps, { ios: false, hasTeam: true })).toBe(false)
  expect(touched).toBe(false)
})

test('the reinstall sign-out: once per launch, only on the team page saved at launch, done only on the server answer', async () => {
  const { ReinstallSignOut, MAX_SIGN_OUT_PAGES } = await import('../../mobile/src/install')
  let finished = 0, n = 0
  const a = 'https://a.example', b = 'https://b.example'
  const s = new ReinstallSignOut(a, async () => { finished++ }, () => `token-${++n}`)
  // not another team, not another origin's URL on screen
  expect(s.script(b, `${b}/rooms`)).toBeNull()
  expect(s.script(a, 'https://evil.example/')).toBeNull()
  const first = s.script(a, `${a}/rooms`)!
  expect(first).toContain(JSON.stringify(`${a}/api/auth/logout`)) // the team's own origin, never a relative URL
  expect(first).toContain('"token-1"')
  // a forged or stale answer is not taken; a server error leaves it for the next page load
  expect(s.answer(JSON.stringify({ signOut: 'token-0', status: 204 }))).toBe(false)
  expect(s.answer(JSON.stringify({ signOut: 'token-1', status: 503 }))).toBe(true)
  expect(finished).toBe(0)
  const second = s.script(a, `${a}/`)!
  expect(s.answer(JSON.stringify({ signOut: 'token-2', status: 204 }))).toBe(true)
  expect(finished).toBe(1); expect(s.finished).toBe(true)
  expect(second).toContain('"token-2"')
  // the person signs in, switches to B and back to A: never signed out again in this launch
  expect(s.script(a, `${a}/rooms`)).toBeNull()
  // 401 (there was no session) also counts; at most a few page loads per launch
  let m = 0
  const quiet = new ReinstallSignOut(a, async () => { m++ }, () => 't')
  expect(quiet.script(a, `${a}/`)).not.toBeNull()
  expect(quiet.answer(JSON.stringify({ signOut: 't', status: 401 }))).toBe(true)
  expect(m).toBe(1)
  const capped = new ReinstallSignOut(a, async () => {}, () => 'x')
  for (let i = 0; i < MAX_SIGN_OUT_PAGES; i++) expect(capped.script(a, `${a}/`)).not.toBeNull()
  expect(capped.script(a, `${a}/`)).toBeNull()
})
test('Android team-address screen: the form is lifted by the keyboard (it covered the Connect button)', () => {
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  // the setup screen pads itself by the keyboard on Android (KeyboardAvoidingView only works on iOS here)
  expect(app).toMatch(/keyboard = useAndroidKeyboard\(\)[\s\S]{0,8000}?return <View style=\{\[s\.fill, \{ backgroundColor: c\.canvas, paddingTop: i\.top, paddingBottom: keyboard \? keyboard \+ i\.bottom : i\.bottom/)
})

test('Android: the look around an older team page is read from the OS each time, not a stale cache', () => {
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  // the cached useColorScheme is gone; the scheme is read again on mount, on foreground and on change
  expect(app).not.toContain('useColorScheme(')
  expect(app).toContain("NativeAppearance?.getColorScheme()")
  expect(app).toMatch(/AppState\.addEventListener\('change', state => \{ if \(state === 'active'\) read\(\) \}\)/)
})

test('the reinstall sign-out is injected only after the bridge went on this team page, and its answer is not a bridge message', () => {
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  expect(app).toContain('async function loaded(url: string): Promise<boolean>')
  expect(app).toContain('ready.current = installed && !loadFailed.current')
  expect(app).toContain('ready.current && sameTeam(address.origin, currentUrl.current) ? signOut?.script(address.origin, currentUrl.current, address.origin + address.entryPath) : null')
  expect(app).toContain('if (signOut && sameTeam(address.origin, event.nativeEvent.url) && signOut.answer(event.nativeEvent.data)) return')
  // one object for the launch (not a flag per team page); a team left without a confirmed sign-out gets its own
  expect(app).toContain('signOut={owed.current?.origin === team.origin ? owed.current : signOut.current}')
})

test('leaving a team signs out of it (QA TC-369): the page clears and posts the sign-out, owed until the server answered', async () => {
  const { leaveScript, readLeaveAnswer, ended, oweSignOut, owesSignOut, signedOut } = await import('../../mobile/src/leave')
  const { ReinstallSignOut, signOutScript } = await import('../../mobile/src/install')
  const a = 'https://a.example', b = 'https://b.example'
  const js = leaveScript(a, 'tok-1')
  // the team's own origin, the page's own session, its storage cleared before the request
  expect(js).toContain(JSON.stringify(`${a}/api/auth/logout`))
  expect(js).toContain("credentials:'same-origin'")
  expect(js.indexOf('localStorage.clear()')).toBeLessThan(js.indexOf('fetch('))
  for (const part of ['sessionStorage.clear()', 'document.cookie', 'caches.delete', 'indexedDB.deleteDatabase', 'unregister()']) expect(js).toContain(part)
  expect(js).not.toContain('location.') // the page is going away: no navigation
  // only this leave's answer is taken
  expect(readLeaveAnswer(JSON.stringify({ mycelLeave: 'tok-1', status: 204 }), 'tok-1')).toBe(204)
  expect(readLeaveAnswer(JSON.stringify({ mycelLeave: 'tok-0', status: 204 }), 'tok-1')).toBeNull()
  expect(readLeaveAnswer(JSON.stringify({ mycelLeave: 'tok-1', status: 204 }), null)).toBeNull()
  expect(readLeaveAnswer(JSON.stringify({ signOut: 'tok-1', status: 204 }), 'tok-1')).toBeNull()
  expect(readLeaveAnswer('{"mycelLeave":', 'tok-1')).toBeNull()
  expect([204, 401, 0, 503].map(ended)).toEqual([true, true, false, false])
  // owed sign-outs: one per team, kept until the server answered
  const store = new Map<string, string>()
  const slot = { get: async () => store.get('s') ?? null, set: async (v: string | null) => { if (v === null) store.delete('s'); else store.set('s', v) } }
  await oweSignOut(slot, a); await oweSignOut(slot, b); await oweSignOut(slot, a)
  expect(JSON.parse(store.get('s')!)).toEqual([b, a])
  expect(await owesSignOut(slot, a)).toBe(true)
  await signedOut(slot, a)
  expect(await owesSignOut(slot, a)).toBe(false)
  await signedOut(slot, b)
  expect(store.has('s')).toBe(false)
  store.set('s', 'not json')
  expect(await owesSignOut(slot, a)).toBe(false)
  // the next visit to a team owed a sign-out: the reinstall sign-out, with the page's storage cleared too
  const owed = new ReinstallSignOut(a, async () => {}, () => 't', true)
  expect(owed.script(a, `${a}/`)).toContain('localStorage.clear()')
  expect(signOutScript(a, 't')).not.toContain('localStorage.clear()')
})

test('App leave(): owed first, the page asked, the cookies cleared with or without an answer', () => {
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  const leave = app.slice(app.indexOf('async function leave(origin: string)'), app.indexOf('const closeAdding'))
  const order = ['leaveTeam(devices, origin)', 'leaving.current?.(origin)', 'if (ended(status)) await signedOut(leftSessions, origin)', 'await clearWebCookies()']
  for (let i = 1; i < order.length; i++) expect(leave.indexOf(order[i])).toBeGreaterThan(leave.indexOf(order[i - 1]))
  expect(leave.indexOf(order[0])).toBeGreaterThan(-1)
  // the old team is left before the new team's page mounts (its cookies must not be cleared)
  const connect = app.slice(app.indexOf('function connect('), app.indexOf('// Android: the status bar icons', app.indexOf('function connect(')))
  expect(connect.indexOf('if (old) await leave(old)')).toBeLessThan(connect.indexOf('setTeam(address)'))
  // owed before the new team is saved (an app stopped in between), taken back when the save fails; one switch at a time
  expect(connect.indexOf('await oweForSwitch(leftSessions, old)')).toBeLessThan(connect.indexOf('await saveTeamUrl(address.origin)'))
  expect(connect).toContain('catch (e) { await undo?.().catch(() => {}); throw e }')
  expect(connect).toContain('return switching.current.run(async () => {')
  // a switch that was busy: the link question and the box stay open and say so; a link that came meanwhile stays
  expect(app).toContain('const ok = await connect(address); if (ok) setLink(l => l?.id === link.id ? null : l); return ok')
  expect(app.match(/setError\(t\.stillSwitching\)/g)?.length).toBe(4)
  expect(app).toContain('gate.clear(offer.id)')
  // the answer is checked before the bridge sees the message, only from this team's page
  expect(app).toContain("if (sameTeam(address.origin, event.nativeEvent.url) && leaveAsk.current.answer(event.nativeEvent.data)) return")
  // while the switch waits for the sign-out, [Cancel], [Back to …] and Android back cancel nothing, so they are off
  for (const id of ['setup-ask-cancel', 'setup-back', 'link-cancel']) expect(app).toMatch(new RegExp(`disabled=\\{busy\\}[^>]*testID="${id}"|testID="${id}"[^>]*disabled=\\{busy\\}`))
  expect(app).toContain('if (busy) return true')
  expect(app).toContain("if (!busyRef.current) no(); return true")
  expect(app).toContain("TurboModuleRegistry.get<NetworkingModule>('Networking')")
})

test('a switch cut short (the new team saved, the old one not left yet): the old device is owed a removal at the next start', async () => {
  const calls: string[] = []; let online = false
  const m = memory(async d => { calls.push(d.deviceId); return online })
  await rememberDevice(m.deps, dev('https://a.example', 'dev_a'))
  // the same team saved: only the owed removals are tried (none)
  await startRemovals(m.deps, 'https://a.example')
  expect(calls).toEqual([])
  expect((await currentDevice(m.deps, 'https://a.example'))?.deviceId).toBe('dev_a')
  // the app stopped after saving b: a's device is removed now, or kept owed while a cannot be reached
  await startRemovals(m.deps, 'https://b.example')
  expect(calls).toEqual(['dev_a'])
  expect(m.store.get('current')).toBeUndefined()
  expect(JSON.parse(m.store.get('pending')!).map((d: TeamDevice) => d.deviceId)).toEqual(['dev_a'])
  online = true
  await startRemovals(m.deps, 'https://b.example')
  expect(m.store.get('pending')).toBeUndefined()
  // no team saved at all (left, then stopped before a new one was saved)
  await rememberDevice(m.deps, dev('https://c.example', 'dev_c'))
  await startRemovals(m.deps, null)
  expect(calls).toEqual(['dev_a', 'dev_a', 'dev_c'])
  // App.tsx starts the removals once, after it knows the saved team (no other retry beside it)
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  expect(app).toContain('void startRemovals(devices, origin).catch(() => {})')
  expect(app).not.toContain('retryRemovals(')
})

// x's removal is owed and its first try is slow; every other try answers at once
function slowFirst(ok = false) {
  let release: ((ok: boolean) => void) | null = null, first = true
  const m = memory(() => { if (!first) return Promise.resolve(ok); first = false; return new Promise<boolean>(r => { release = r }) })
  return { m, release: (v: boolean) => release!(v) }
}
const owedIds = (m: ReturnType<typeof memory>) => JSON.parse(m.store.get('pending') ?? '[]').map((d: TeamDevice) => d.deviceId).sort()
const tick = () => new Promise(r => setTimeout(r, 10))

test('a slow network cannot make two runs drop an owed removal: a retry takes out only what it removed', async () => {
  // meanwhile the start finds a's device (the app stopped mid-switch) and a switch leaves b; side by side, the slow
  // run used to write back its old list [x] last and drop a
  const { m, release } = slowFirst()
  await m.deps.pending.set(JSON.stringify([{ ...dev('https://x.example', 'dev_x'), at: m.deps.now() }]))
  await rememberDevice(m.deps, dev('https://a.example', 'dev_a'))
  const runs = [retryRemovals(m.deps), startRemovals(m.deps, 'https://b.example'), leaveTeam(m.deps, 'https://b.example')]
  await tick()
  release(false)
  await Promise.all(runs)
  expect(owedIds(m)).toEqual(['dev_a', 'dev_x'])
  expect(m.store.get('current')).toBeUndefined()
})

test('a slow removal holds back neither a leave nor the new team\'s device', async () => {
  const { m, release } = slowFirst()
  await m.deps.pending.set(JSON.stringify([{ ...dev('https://x.example', 'dev_x'), at: m.deps.now() }]))
  await rememberDevice(m.deps, dev('https://a.example', 'dev_a'))
  const retry = retryRemovals(m.deps)
  await tick()
  const leave = leaveTeam(m.deps, 'https://a.example')
  await tick()
  // the leave is stored while x's removal is still out
  expect(m.store.get('current')).toBeUndefined()
  expect(owedIds(m)).toEqual(['dev_a', 'dev_x'])
  // the new team registers this phone meanwhile; x's removal then succeeds late
  await rememberDevice(m.deps, dev('https://b.example', 'dev_b'))
  release(true)
  await Promise.all([retry, leave])
  expect((await currentDevice(m.deps, 'https://b.example'))?.deviceId).toBe('dev_b')
  expect(owedIds(m)).toEqual(['dev_a'])
  // leaving a team that is not the current one keeps the current device
  await leaveTeam(m.deps, 'https://a.example')
  expect((await currentDevice(m.deps, 'https://b.example'))?.deviceId).toBe('dev_b')
})

test('the session check: the page answers GET /api/me with the check number; anything else is not an answer', () => {
  const script = sessionCheckScript(7)
  expect(script).toContain("fetch('/api/me',{credentials:'same-origin'")
  expect(script).toContain('mycelSessionCheck:7')
  expect(readSessionCheck(JSON.stringify({ mycelSessionCheck: 7, ok: true }), 7)).toBe(true)
  expect(readSessionCheck(JSON.stringify({ mycelSessionCheck: 7, ok: false }), 7)).toBe(false)
  expect(readSessionCheck(JSON.stringify({ mycelSessionCheck: 6, ok: true }), 7)).toBeNull() // an older check
  for (const other of ['{"v":1,"type":"push-token"}', 'not json', JSON.stringify({ mycelSessionCheck: 7, ok: 'yes' }), 'x'.repeat(300)]) expect(readSessionCheck(other, 7)).toBeNull()
  // the footer follows the rule shared with the desktop (shared/src/team-link.ts hostLineNow): it waits for this check
  // (or 300 ms) before it shows, so a signed-in page does not jump; the check's answer counts as answered
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  expect(app).toContain('const showFooter = hostLineNow({ path: pathname, signedIn, answered, waited })')
  expect(app).toContain('if (session !== null) { setSignedIn(session); setAnswered(true); return }')
  expect(app).toContain('if (!waitTimer.current) waitTimer.current = setTimeout(() => setWaited(true), 300)')
})

/** Runs a page script against a stand-in page: what it cleared, fetched, posted and where it went. `at`: the page's
 * address, `session`: its session storage (what is left of it is in there afterwards). */
async function runPage(script: string, status: number, at = 'https://a.example/join#t=abc', session = new Map<string, string>()) {
  const log: string[] = []
  let url = new URL(at)
  const location = {
    get href() { return url.href }, get pathname() { return url.pathname }, get search() { return url.search },
    replace: (u: string) => log.push(`replace ${u}`), reload: () => log.push(`reload ${url.href}`),
  }
  const page = {
    localStorage: { clear: () => log.push('localStorage') },
    sessionStorage: { clear: () => { log.push('sessionStorage'); session.clear() }, getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v) } },
    document: { cookie: '' }, caches: undefined, indexedDB: undefined, navigator: {},
    fetch: async (u: string) => { log.push(`fetch ${u}`); if (!status) throw new Error('offline'); return { status } },
    ReactNativeWebView: { postMessage: (m: string) => log.push(`post ${m}`) },
    history: { state: { idx: 0 }, replaceState: (_s: unknown, _t: string, u: string) => { url = new URL(u, url); log.push(`address ${url.href}`) } },
    location, URL,
  }
  const g = { ...page, window: page } as Record<string, unknown>
  new Function(...Object.keys(g), script)(...Object.values(g))
  await new Promise(r => setTimeout(r, 10))
  return log
}

test('the sign-out owed to a team left keeps the invite page the person opened (no /login), the reinstall one goes to /login', async () => {
  const { signOutScript } = await import('../../mobile/src/install')
  const a = 'https://a.example'
  // owed (wipe): 204 reloads the same page (/join#t=… or /invite/<token> stays), 401 leaves it as it is
  const ok = await runPage(signOutScript(a, 't', true), 204)
  expect(ok).toEqual(['localStorage', 'sessionStorage', `fetch ${a}/api/auth/logout`, 'post {"signOut":"t","status":204}', `reload ${a}/join#t=abc`])
  const none = await runPage(signOutScript(a, 't', true), 401)
  expect(none.some(l => l.startsWith('replace') || l === 'reload')).toBe(false)
  const offline = await runPage(signOutScript(a, 't', true), 0)
  expect(offline.at(-1)).toBe('post {"signOut":"t","status":0}')
  // the reinstall sign-out is unchanged: the sign-in page on 204 and 401
  expect((await runPage(signOutScript(a, 't'), 204)).at(-1)).toBe('replace /login')
  expect((await runPage(signOutScript(a, 't'), 401)).at(-1)).toBe('replace /login')
  // the leave script never navigates
  const { leaveScript } = await import('../../mobile/src/leave')
  expect((await runPage(leaveScript(a, 'x'), 204)).at(-1)).toBe('post {"mycelLeave":"x","status":204}')
})

test('the owed sign-out on a team link (/join#t=…) keeps the person on the join page: token kept, the link opened again after a 204', async () => {
  const { signOutScript, ReinstallSignOut } = await import('../../mobile/src/install')
  const { JOIN_TOKEN_KEY } = await import('../../mobile/src/leave')
  const web = await import('../../web/src/lib/team-link')
  expect(JOIN_TOKEN_KEY).toBe(web.JOIN_TOKEN_KEY)
  const a = 'https://a.example', entry = `${a}/join#t=tok123`
  // signed out: the join page took #t= out of the address into session storage; the wipe keeps that one key
  const session = new Map([[JOIN_TOKEN_KEY, 'tok123'], ['mycel.window', 'w1']])
  const joinPage = await runPage(signOutScript(a, 't', true, entry), 204, `${a}/join`, session)
  expect([...session]).toEqual([[JOIN_TOKEN_KEY, 'tok123']])
  // same page, only the #fragment differs: the address is set back first, then reloaded (a fragment change would not load)
  expect(joinPage.slice(-2)).toEqual([`address ${entry}`, `reload ${entry}`])
  // signed in, /join had sent the person Home: the link's page is opened again
  expect((await runPage(signOutScript(a, 't', true, entry), 204, `${a}/`)).at(-1)).toBe(`replace ${entry}`)
  expect((await runPage(signOutScript(a, 't', true, `${a}/invite/abc`), 204, `${a}/rooms`)).at(-1)).toBe(`replace ${a}/invite/abc`)
  // no session (401): the page stays as it is, with the token still kept
  const kept = new Map([[JOIN_TOKEN_KEY, 'tok123']])
  const none = await runPage(signOutScript(a, 't', true, entry), 401, `${a}/join`, kept)
  expect(none.some(l => l.startsWith('replace') || l.startsWith('reload') || l.startsWith('address'))).toBe(false)
  expect(kept.get(JOIN_TOKEN_KEY)).toBe('tok123')
  // the reinstall sign-out and the leave script still empty all of session storage
  const { leaveScript } = await import('../../mobile/src/leave')
  const all = new Map([[JOIN_TOKEN_KEY, 'x']])
  await runPage(leaveScript(a, 'x'), 204, `${a}/`, all)
  expect(all.size).toBe(0)
  // the entry goes in only for the same team
  const owed = new ReinstallSignOut(a, async () => {}, () => 't', true)
  expect(owed.script(a, `${a}/join`, entry)).toContain(JSON.stringify(entry))
  const other = new ReinstallSignOut(a, async () => {}, () => 't', true)
  expect(other.script(a, `${a}/join`, 'https://evil.example/join#t=x')).not.toContain('evil.example')
})

test('one switch at a time: a second one answers false at once and runs nothing; the next one after it runs', async () => {
  const { OneSwitch } = await import('../../mobile/src/leave')
  const one = new OneSwitch(), ran: string[] = []
  let finish = () => {}
  const first = one.run(() => new Promise<void>(r => { ran.push('b'); finish = r }))
  expect(one.busy).toBe(true)
  expect(await one.run(async () => { ran.push('c') })).toBe(false)
  finish()
  expect(await first).toBe(true)
  expect(await one.run(async () => { ran.push('c') })).toBe(true)
  expect(ran).toEqual(['b', 'c'])
  // a failed switch lets the next one run
  await expect(one.run(async () => { throw new Error('save') })).rejects.toThrow('save')
  expect(one.busy).toBe(false)
})

test('a failed save takes back only the sign-out this switch owed, never an older one', async () => {
  const { oweForSwitch, owesSignOut, oweSignOut } = await import('../../mobile/src/leave')
  const a = 'https://a.example', b = 'https://b.example'
  const store = new Map<string, string>()
  const slot = { get: async () => store.get('s') ?? null, set: async (v: string | null) => { if (v === null) store.delete('s'); else store.set('s', v) } }
  // new: the undo removes it
  await (await oweForSwitch(slot, a))()
  expect(await owesSignOut(slot, a)).toBe(false)
  // owed by an earlier switch (its server never answered): the undo keeps it, and the other entries too
  await oweSignOut(slot, a); await oweSignOut(slot, b)
  const undo = await oweForSwitch(slot, a)
  expect(await owesSignOut(slot, a)).toBe(true)
  await undo()
  expect(await owesSignOut(slot, a)).toBe(true)
  expect(await owesSignOut(slot, b)).toBe(true)
})

test('a leave sign-out always resolves: its answer, the wait running out, a newer one, the page going, a failed inject', async () => {
  const { LeaveAsk } = await import('../../mobile/src/leave')
  const a = 'https://a.example'
  let n = 0
  const ask = new LeaveAsk(() => `tok-${++n}`, 30)
  const scripts: string[] = []
  const first = ask.start(a, js => scripts.push(js))
  expect(scripts[0]).toContain('"tok-1"')
  // a forged token is no answer; the right one resolves with its status, once
  expect(ask.answer(JSON.stringify({ mycelLeave: 'tok-0', status: 204 }))).toBe(false)
  expect(ask.answer(JSON.stringify({ mycelLeave: 'tok-1', status: 204 }))).toBe(true)
  expect(await first).toBe(204)
  expect(ask.answer(JSON.stringify({ mycelLeave: 'tok-1', status: 204 }))).toBe(false)
  // a newer start replaces the pending one, which resolves 0 (it never hung), and only the newer answer counts
  const older = ask.start(a, () => {}), newer = ask.start(a, () => {})
  expect(await older).toBe(0)
  expect(ask.answer(JSON.stringify({ mycelLeave: 'tok-2', status: 204 }))).toBe(false)
  expect(ask.answer(JSON.stringify({ mycelLeave: 'tok-3', status: 401 }))).toBe(true)
  expect(await newer).toBe(401)
  // no answer in time
  expect(await ask.start(a, () => {})).toBe(0)
  // the page went (TeamWeb unmounted)
  const gone = ask.start(a, () => {}); ask.cancel()
  expect(await gone).toBe(0)
  // the inject failed
  expect(await ask.start(a, () => { throw new Error('no page') })).toBe(0)
})
