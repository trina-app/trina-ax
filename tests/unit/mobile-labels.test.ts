// Who and where in a room push on the iPhone, the app's side (docs/DECISIONS.md "아이폰 알림의 이름"): the label key the
// app makes and keeps for its notification service extension (mobile/src/labels.ts), the bridge (push-label-v1, the
// sign-out signal), the Trina edition's extension and keychain groups (app.config.ts, plugins/notification-service.js),
// and that the extension's Swift source reads what the app writes.
import { afterEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { FileTransfers, MobileReceiver, type PushBridge, type TransferIO } from '../../mobile/src/bridge'
import { LABEL_ITEM, LABEL_SERVICE, LabelStore, base64url, labelSetup, parseLabelItem, type LabelDeps } from '../../mobile/src/labels'
import { MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_LABEL_CAPABILITY, PUSH_REGISTERED_CAPABILITY, parseMessage, type MobileConfig, type PushToken } from '../../mobile/src/protocol'
import appConfig from '../../mobile/app.config'

const mobileRoot = path.resolve(import.meta.dir, '../../mobile')
const ORIGIN = 'https://team.example', OTHER = 'https://other.example'
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** a keychain item in memory; `fail` makes the next writes throw */
function keychain() {
  let value: string | null = null, fail = false, writes = 0
  const deps: LabelDeps = {
    slot: { async get() { return value }, async set(v) { if (fail) throw new Error('errSecMissingEntitlement'); writes++; value = v } },
    async random() { return new Uint8Array(crypto.randomBytes(32)) },
    async sha256Hex(text) { return sha256(text) },
  }
  return { deps, get value() { return value }, set value(v: string | null) { value = v }, set fail(v: boolean) { fail = v }, get writes() { return writes } }
}
const item = (k: ReturnType<typeof keychain>) => parseLabelItem(k.value)

test('the label key is made on the phone, kept for this team, and only its hash leaves the store', async () => {
  const k = keychain(), store = new LabelStore(k.deps)
  const hash = await store.keyHash(ORIGIN)
  expect(item(k)).toMatchObject({ v: 1, origin: ORIGIN })
  expect(item(k)!.key).toMatch(/^[A-Za-z0-9_-]{43}$/)
  // the server's check: sha256 of the key as sent (push-service.ts label)
  expect(hash).toBe(sha256(item(k)!.key))
  // again for the same team: the same key (the page registers at every load; nothing rotates)
  expect(await store.keyHash(ORIGIN)).toBe(hash)
  expect(k.writes).toBe(1)
  // the team registered the phone: the extension may ask now
  await store.registered(ORIGIN, 'device-1')
  expect(item(k)).toMatchObject({ origin: ORIGIN, deviceId: 'device-1' })
  expect(await store.keyHash(ORIGIN)).toBe(hash)
  // another team's registration never lands on this item
  await store.registered(OTHER, 'device-2')
  expect(item(k)!.deviceId).toBe('device-1')
  // another team: a new key, no device until that team registers the phone
  const other = await store.keyHash(OTHER)
  expect(other).not.toBe(hash)
  expect(item(k)).toEqual({ v: 1, origin: OTHER, key: expect.any(String) })
  for (const bad of ['http://team.example', 'https://team.example/x', 'https://u@team.example', 'nope']) expect(await store.keyHash(bad)).toBeNull()
})

test('sign-out, team change and reinstall forget it; a launch keeps it only for this team and this device', async () => {
  const k = keychain(), store = new LabelStore(k.deps)
  await store.keyHash(ORIGIN); await store.registered(ORIGIN, 'device-1')
  await store.forget()
  expect(k.value).toBeNull()
  await store.keyHash(ORIGIN); await store.registered(ORIGIN, 'device-1')
  await store.tidy(ORIGIN, 'device-1')
  expect(item(k)?.deviceId).toBe('device-1')
  for (const [origin, device] of [[OTHER, 'device-1'], [ORIGIN, 'device-2'], [ORIGIN, null], [null, null]] as const) {
    await store.keyHash(ORIGIN); await store.registered(ORIGIN, 'device-1')
    await store.tidy(origin, device)
    expect(k.value).toBeNull()
  }
  // a key not yet registered (no device id) stays for its own team
  await store.keyHash(ORIGIN)
  await store.tidy(ORIGIN, null)
  expect(item(k)?.origin).toBe(ORIGIN)
  // something this app does not write goes too
  k.value = '{"v":2}'
  await store.tidy(ORIGIN, null)
  expect(k.value).toBeNull()
})

test('one keychain operation at a time: a sign-out\'s delete never lands after the next sign-in\'s key', async () => {
  const k = keychain()
  let release!: () => void
  const slow: LabelDeps = { ...k.deps, slot: { get: k.deps.slot.get, async set(v) { if (v === null) await new Promise<void>(r => { release = r }); await k.deps.slot.set(v) } } }
  const store = new LabelStore(slow)
  await store.keyHash(ORIGIN)
  const forgetting = store.forget()
  const hashing = store.keyHash(ORIGIN)
  await Bun.sleep(5); release(); await forgetting
  const hash = await hashing
  expect(item(k)).not.toBeNull()
  expect(hash).toBe(sha256(item(k)!.key))
})

test('a keychain that refuses (no entitlement) gives no hash, so nothing unusable is registered', async () => {
  const k = keychain(); k.fail = true
  const store = new LabelStore(k.deps)
  expect(await store.keyHash(ORIGIN).catch(() => 'threw')).toBe('threw')
  // the bridge turns that into a token reply without a hash (below)
  // a write that seems to work but is not there when read back (another group answered): no hash either
  const lost: LabelDeps = { ...keychain().deps, slot: { async get() { return null }, async set() {} } }
  expect(await new LabelStore(lost).keyHash(ORIGIN)).toBeNull()
})

test('base64url and the stored item: the server\'s key format, nothing else accepted', () => {
  for (let i = 0; i < 50; i++) { const b = crypto.randomBytes(32); expect(base64url(new Uint8Array(b))).toBe(b.toString('base64url')) }
  expect(base64url(new Uint8Array([1, 2]))).toBe(Buffer.from([1, 2]).toString('base64url'))
  const key = 'k'.repeat(43)
  expect(parseLabelItem(JSON.stringify({ v: 1, origin: ORIGIN, key, deviceId: 'd-1' }))).toEqual({ v: 1, origin: ORIGIN, key, deviceId: 'd-1' })
  for (const bad of [null, '', 'x', '{}', JSON.stringify({ v: 1, origin: ORIGIN, key: 'short' }), JSON.stringify({ v: 1, origin: 'http://team.example', key }),
    JSON.stringify({ v: 1, origin: ORIGIN + '/', key }), JSON.stringify({ v: 1, origin: ORIGIN, key, deviceId: '../x' }), JSON.stringify({ v: 2, origin: ORIGIN, key })]) expect(parseLabelItem(bad)).toBeNull()
})

const io: TransferIO = { async create() {}, async append() {}, async inspect() { return { size: 0, sha256: '' } }, async share() {}, async remove() {} }
const ios: PushToken = { platform: 'ios', token: 'ab'.repeat(32), environment: 'production' }
const base: MobileConfig = { protocol: 1, platform: 'ios', appVersion: '1.0.1', nonce: 'a'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, PUSH_REGISTERED_CAPABILITY] }
const msg = (o: object) => JSON.stringify({ v: 1, nonce: base.nonce, generation: 1, id: 'request-0001', ...o })

test('push-label-v1: the token reply carries the label key\'s hash, only with the capability and only on iOS', async () => {
  const hash = sha256('k'.repeat(43))
  const bridge = (token: PushToken, labelHash: () => Promise<string | null>): PushBridge => ({ token: async () => token, registered: async () => {}, labelHash })
  const withLabels = new MobileReceiver(ORIGIN, { ...base, capabilities: [...base.capabilities, PUSH_LABEL_CAPABILITY] }, new FileTransfers(io), async () => {}, bridge(ios, async () => hash))
  expect(await withLabels.receive(msg({ type: 'push-token' }), ORIGIN + '/')).toMatchObject({ ok: true, push: ios, labelHash: hash })
  const without = new MobileReceiver(ORIGIN, base, new FileTransfers(io), async () => {}, bridge(ios, async () => hash))
  expect((await without.receive(msg({ type: 'push-token' }), ORIGIN))!.labelHash).toBeUndefined()
  const android = new MobileReceiver(ORIGIN, { ...base, platform: 'android', capabilities: [...base.capabilities, PUSH_LABEL_CAPABILITY] }, new FileTransfers(io), async () => {},
    bridge({ platform: 'android', token: 'fcm:' + 'A'.repeat(140), environment: 'production' }, async () => hash))
  expect((await android.receive(msg({ type: 'push-token' }), ORIGIN))!.labelHash).toBeUndefined()
  // a keychain that refuses, or something that is no hash: the token still goes, without a hash
  for (const failing of [async () => { throw new Error('keychain') }, async () => null, async () => 'not-a-hash']) {
    const r = new MobileReceiver(ORIGIN, { ...base, capabilities: [...base.capabilities, PUSH_LABEL_CAPABILITY] }, new FileTransfers(io), async () => {}, bridge(ios, failing as () => Promise<string | null>))
    const reply = await r.receive(msg({ type: 'push-token' }), ORIGIN)
    expect(reply).toMatchObject({ ok: true, push: ios }); expect(reply!.labelHash).toBeUndefined()
  }
  // push-registered carries no key (the key never crossed the bridge); an extra field is not passed on
  const got: unknown[] = []
  const r = new MobileReceiver(ORIGIN, { ...base, capabilities: [...base.capabilities, PUSH_LABEL_CAPABILITY] }, new FileTransfers(io), async () => {}, { token: async () => ios, registered: async d => { got.push(d) } })
  await r.receive(msg({ type: 'push-registered', deviceId: 'device-1', removeKey: 'r'.repeat(43), labelKey: 'k'.repeat(43) }), ORIGIN)
  expect(got).toEqual([{ deviceId: 'device-1', removeKey: 'r'.repeat(43) }])
})

test('signedOut on a session reset: done before the reset is answered; a reset without it (sign-in, reload) touches nothing', async () => {
  const events: string[] = []
  let release!: () => void
  const r = new MobileReceiver(ORIGIN, base, new FileTransfers(io), async () => {}, {
    token: async () => ios, registered: async () => {},
    async signedOut() { events.push('signed-out start'); await new Promise<void>(res => { release = res }); events.push('signed-out done') },
  })
  const answer = r.receive(msg({ type: 'session-reset', signedOut: true }), ORIGIN).then(reply => { events.push('answered'); return reply })
  await Bun.sleep(5)
  expect(events).toEqual(['signed-out start'])
  release()
  expect(await answer).toMatchObject({ ok: true, nextGeneration: 2 })
  expect(events).toEqual(['signed-out start', 'signed-out done', 'answered'])
  events.length = 0
  await r.receive(JSON.stringify({ v: 1, nonce: base.nonce, generation: 2, id: 'request-0002', type: 'session-reset' }), ORIGIN)
  expect(events).toEqual([])
  // from another origin or with the wrong nonce: nothing
  await r.receive(JSON.stringify({ v: 1, nonce: base.nonce, generation: 3, id: 'request-0003', type: 'session-reset', signedOut: true }), OTHER)
  await r.receive(JSON.stringify({ v: 1, nonce: 'b'.repeat(64), generation: 3, id: 'request-0003', type: 'session-reset', signedOut: true }), ORIGIN)
  expect(events).toEqual([])
  expect(parseMessage(msg({ type: 'session-reset', signedOut: 'yes' }))).toBeNull()
  // an older page's reset (no field) still parses
  expect(parseMessage(msg({ type: 'session-reset' }))?.type).toBe('session-reset')
})

afterEach(() => { delete process.env.MYCEL_MOBILE_EDITION; delete process.env.MYCEL_MOBILE_BUILD_NUMBER })

test('the Trina edition (1.0.4) gets the extension and the shared keychain group; the neutral app neither', () => {
  expect(labelSetup({ bundleId: 'app.trina.ax', appleTeamId: 'YWW96288YY' })).toEqual({ accessGroup: 'YWW96288YY.app.trina.ax.notifications', extensionId: 'app.trina.ax.NotificationService' })
  expect(labelSetup({ bundleId: 'app.teamax.mobile.dev' })).toBeNull()
  process.env.MYCEL_MOBILE_EDITION = 'trina'; process.env.MYCEL_MOBILE_BUILD_NUMBER = '12'
  const c = appConfig({ config: {}, projectRoot: mobileRoot } as never)
  expect(c.version).toBe('1.0.4')
  expect(c.extra?.pushLabels).toEqual({ accessGroup: 'YWW96288YY.app.trina.ax.notifications', extensionId: 'app.trina.ax.NotificationService' })
  const plugin = (c.plugins as unknown[]).find(x => Array.isArray(x) && x[0] === './plugins/notification-service.js') as [string, Record<string, string>]
  expect(plugin[1]).toEqual({ accessGroup: 'YWW96288YY.app.trina.ax.notifications', extensionId: 'app.trina.ax.NotificationService', teamId: 'YWW96288YY', version: '1.0.4', build: '12' })
  delete process.env.MYCEL_MOBILE_EDITION
  const neutral = appConfig({ config: {}, projectRoot: mobileRoot } as never)
  expect(neutral.extra?.pushLabels).toBeNull()
  expect(JSON.stringify(neutral.plugins)).not.toContain('notification-service')
})

test('the plugin: the app keeps its own keychain group first, the extension gets the shared one only, the app\'s numbers', () => {
  const plugin = require('../../mobile/plugins/notification-service.js') as ((config: object, o: object) => object) & { infoPlist(o: object): string; entitlements(g: string[]): string }
  const o = { accessGroup: 'YWW96288YY.app.trina.ax.notifications', extensionId: 'app.trina.ax.NotificationService', teamId: 'YWW96288YY', version: '1.0.1', build: '12' }
  const info = plugin.infoPlist(o)
  for (const want of ['<string>1.0.1</string>', '<string>12</string>', '<string>YWW96288YY.app.trina.ax.notifications</string>', 'com.apple.usernotifications.service', '$(PRODUCT_MODULE_NAME).NotificationService']) expect(info).toContain(want)
  expect(plugin.entitlements([o.accessGroup]).match(/<string>[^<]+<\/string>/g)).toEqual(['<string>YWW96288YY.app.trina.ax.notifications</string>'])
  // the extension must belong to the app it is added to; options are checked
  expect(() => plugin({ ios: { bundleIdentifier: 'app.other' } }, o)).toThrow()
  for (const bad of [{ ...o, teamId: 'x' }, { ...o, accessGroup: 'OTHERTEAM1.app.trina.ax.notifications' }, { ...o, build: '0' }, { ...o, version: '1.0' }]) expect(() => plugin({ ios: { bundleIdentifier: 'app.trina.ax' } }, bad)).toThrow()
  const src = fs.readFileSync(path.join(mobileRoot, 'plugins/notification-service.js'), 'utf8')
  // the app's entitlements: its own group first (where its other keychain items have always been), then the shared one
  expect(src).toContain("c.modResults['keychain-access-groups'] = [`${o.teamId}.${appId}`, o.accessGroup]")
})

test('the extension reads what the app writes, only for its device and team, and never follows the payload elsewhere', () => {
  const swift = fs.readFileSync(path.join(mobileRoot, 'plugins/notification-service/NotificationService.swift'), 'utf8')
  // expo-secure-store's naming (the plugin also checks the installed module at prebuild)
  expect(swift).toContain(`static let service = "${LABEL_SERVICE}:no-auth"`)
  expect(swift).toContain(`static let item = "${LABEL_ITEM}"`)
  expect(swift).toContain('kSecAttrAccount as String: Data(item.utf8)')
  expect(swift).toContain('kSecAttrAccessGroup as String: group')
  // room notices of this device only; the stored team origin only, https, no redirects, no cookies, 5 s
  expect(swift).toContain('code.hasPrefix("room.")')
  expect(swift).toContain('access.deviceId == device')
  expect(swift).toContain('relativeTo: access.origin')
  expect(swift).toContain('c.scheme == "https"')
  expect(swift).toContain('willPerformHTTPRedirection')
  expect(swift).toContain('completionHandler(nil)')
  expect(swift).toContain('URLSessionConfiguration.ephemeral')
  expect(swift).toContain('config.httpCookieStorage = nil')
  expect(swift).toContain('static let timeout: TimeInterval = 5')
  expect(swift).toContain('"x-mycel-csrf"')
  // Apple's content on any failure; threadIdentifier from the team's answer
  expect(swift).toContain('return handler(original)')
  expect(swift).toContain('content.threadIdentifier = roomId')
  // nothing of the payload but code, notificationId and device is read
  const reads = [...swift.matchAll(/data\["([a-zA-Z]+)"\]/g)].map(m => m[1]).sort()
  expect([...new Set(reads)]).toEqual(['code', 'device', 'notificationId'])
})

test('the release script checks the extension, its profile and both targets\' keychain groups', () => {
  const sh = fs.readFileSync(path.join(mobileRoot, 'scripts/ios-release.sh'), 'utf8')
  for (const want of ['PlugIns/NotificationService.appex', 'embedded.mobileprovision', '$bundle_id.NotificationService', 'CFBundleShortVersionString CFBundleVersion',
    'codesign -d --entitlements - --xml', "t+'.'+b,t+'.'+b+'.notifications'", 'APPLE_TEAM_ID must be the edition']) expect(sh).toContain(want)
})
