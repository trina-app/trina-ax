// The phone app's icon number (badge-v1, mobile/src/badge.ts; docs/DECISIONS.md "휴대폰 앱 아이콘의 숫자"): the app asks for
// the badge with the notification permission, asks an iPhone that answered before once more (iOS shows no second
// dialog), takes the page's number over the bridge only with badge-v1, and sets the latest one.
import { expect, test } from 'bun:test'
import { FileTransfers, MobileReceiver, type TransferIO } from '../../mobile/src/bridge'
import fs from 'node:fs'
import path from 'node:path'
import { AppBadge, askBadgeAgain, PERMISSION_REQUEST, setsIconNumber, validBadge } from '../../mobile/src/badge'
import { BADGE_CAPABILITY, MAX_BADGE, MOBILE_CAPABILITIES, PUSH_CAPABILITY, parseMessage, type MobileConfig } from '../../mobile/src/protocol'
import { PUSH_GATEWAY_MAX_BADGE } from '../../shared/src/cloud-protocol/push-gateway'
import { APP_BADGE_MAX } from '../../shared/src/api/attention'

const config: MobileConfig = { protocol: 1, platform: 'ios', appVersion: '1.0.5', nonce: 'a'.repeat(64), generation: 1, capabilities: [...MOBILE_CAPABILITIES, PUSH_CAPABILITY, BADGE_CAPABILITY] }
const io: TransferIO = { async create() {}, async append() {}, async inspect() { return { size: 0, sha256: '' } }, async share() {}, async remove() {} }
const message = (count: unknown) => JSON.stringify({ v: 1, nonce: config.nonce, generation: 1, id: 'badge-request-1', type: 'badge', count })

test('permission: the badge is asked for with alerts and sounds (QA TC-408: allowBadge was false)', () => {
  expect(PERMISSION_REQUEST).toEqual({ ios: { allowAlert: true, allowBadge: true, allowSound: true } })
})

test('an iPhone that allowed notifications before the app asked for the badge is asked once more, never twice, never on Android', () => {
  const ios = { ios: true, status: 'granted', allowsBadge: false, askedBadge: false }
  expect(askBadgeAgain(ios)).toBe(true)
  expect(askBadgeAgain({ ...ios, allowsBadge: null })).toBe(true)
  // asked once already, or allowed: nothing
  expect(askBadgeAgain({ ...ios, askedBadge: true })).toBe(false)
  expect(askBadgeAgain({ ...ios, allowsBadge: true })).toBe(false)
  // not allowed at all: the "turn on" path asks (or Settings), not this
  expect(askBadgeAgain({ ...ios, status: 'denied' })).toBe(false)
  expect(askBadgeAgain({ ...ios, status: 'undetermined' })).toBe(false)
  // Android: the notification permission covers the icon
  expect(askBadgeAgain({ ...ios, ios: false, allowsBadge: undefined })).toBe(false)
})

test('the badge message is a whole number from 0 to 9999, the same limit as the gateway and the server', () => {
  expect(MAX_BADGE).toBe(PUSH_GATEWAY_MAX_BADGE)
  expect(MAX_BADGE).toBe(APP_BADGE_MAX)
  for (const n of [0, 1, 9999]) expect(parseMessage(message(n))).toMatchObject({ type: 'badge', count: n })
  for (const n of [-1, 1.5, 10_000, '3', null, true]) expect(parseMessage(message(n))).toBeNull()
  for (const n of [0, 42, 9999]) expect(validBadge(n)).toBe(true)
  for (const n of [-1, 1.5, 10_000, Number.NaN]) expect(validBadge(n)).toBe(false)
})

test('the page\'s number reaches the icon only with badge-v1, only from the team\'s page with the current bridge', async () => {
  const set: number[] = []
  const make = (capabilities = config.capabilities) => new MobileReceiver('https://team.example', { ...config, capabilities }, new FileTransfers(io), async () => {}, {
    token: async () => { throw new Error('not here') }, registered: async () => {}, badge: async (n) => { set.push(n) },
  })
  const r = make()
  expect(await r.receive(message(4), 'https://team.example/rooms')).toMatchObject({ ok: true, for: 'badge' })
  expect(set).toEqual([4])
  for (const source of ['https://evil.example', 'about:blank']) expect(await r.receive(message(9), source)).toBeNull()
  expect(await r.receive(JSON.stringify({ ...JSON.parse(message(9)), nonce: 'b'.repeat(64) }), 'https://team.example/')).toBeNull()
  // an app build that does not offer badge-v1 refuses it
  const old = make([...MOBILE_CAPABILITIES, PUSH_CAPABILITY])
  expect(await old.receive(message(5), 'https://team.example/')).toMatchObject({ ok: false, for: 'badge' })
  expect(set).toEqual([4])
})

test('AppBadge: one call at a time, the latest wins, a failure changes nothing, clear sets 0', async () => {
  const set: number[] = []
  let release = () => {}
  let fail = false
  const badge = new AppBadge(async (n) => {
    set.push(n)
    if (set.length === 1) await new Promise<void>((r) => { release = r })
    if (fail) throw new Error('badges off')
  })
  const first = badge.show(1)
  void badge.show(2); void badge.show(3)
  await Promise.resolve()
  expect(set).toEqual([1])
  release(); await first
  // a burst ends on its last number: 2 never goes to the OS
  expect(set).toEqual([1, 3])
  await badge.show(-1); await badge.show(1.5)
  expect(set).toEqual([1, 3])
  fail = true
  await badge.show(7)
  fail = false
  await badge.clear()
  expect(set).toEqual([1, 3, 7, 0])
})

test('the app sets the icon number on the iPhone only; Android never calls setBadgeCountAsync, not even with 0 (QA TC-408)', () => {
  expect(setsIconNumber('ios')).toBe(true)
  for (const p of ['android', 'web', 'windows', 'macos']) expect(setsIconNumber(p)).toBe(false)
  // the one place that sets it goes through that check (sign-out and team change clear through appBadge too)
  const push = fs.readFileSync(path.join(import.meta.dir, '../../mobile/src/push.ts'), 'utf8')
  const calls = push.split('\n').filter((l) => l.includes('setBadgeCountAsync('))
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('setsIconNumber(Platform.OS)')
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8')
  expect(app).not.toContain('setBadgeCountAsync')
})

test('silent syncs: offered by an iPhone and an Android build with its own messaging service; never listed in the foreground', async () => {
  const { takesSync, SYNC_CODE } = await import('../../mobile/src/badge')
  const { PUSH_SYNC_CODE } = await import('../../shared/src/cloud-protocol/push-gateway')
  expect(SYNC_CODE).toBe(PUSH_SYNC_CODE)
  expect([takesSync('ios', false), takesSync('android', true), takesSync('android', false), takesSync('web', true)]).toEqual([true, true, false, false])
  const app = fs.readFileSync(path.join(import.meta.dir, '../../mobile/App.tsx'), 'utf8'), push = fs.readFileSync(path.join(import.meta.dir, '../../mobile/src/push.ts'), 'utf8')
  expect(app).toContain('...(takesSync(Platform.OS, !!labels) ? [PUSH_SYNC_CAPABILITY] : [])')
  expect(push).toContain('shouldShowList: n.request.content.data?.code !== SYNC_CODE')
  // the page's count never clears delivered notifications: a stale count on return to the foreground (or 0 before the
  // lists load at sign-in) would wipe a new one (review of #442); reads elsewhere come by id in a sync
  expect(app).toContain('badge: n => appBadge.show(n),')
  expect(push).not.toContain('dismissNotificationAsync')
})

// docs/AGENTS/plan/20261124-1853-iphone-clear-read-notifications.md (QA TC-8979, TC-8990, TC-8991)
test('iPhone: push-clear-v1 only with the native handler; the background mode; the handler removes by notice id and answers after', async () => {
  const { takesClear } = await import('../../mobile/src/badge')
  const { PUSH_CLEAR_CAPABILITY } = await import('../../mobile/src/protocol')
  const { PUSH_SYNC_CODE, PUSH_SYNC_MAX_CLEAR } = await import('../../shared/src/cloud-protocol/push-gateway')
  expect(PUSH_CLEAR_CAPABILITY).toBe('push-clear-v1')
  expect([takesClear('ios', true), takesClear('ios', false), takesClear('android', true)]).toEqual([true, false, false])
  const mobile = path.join(import.meta.dir, '../../mobile')
  const read = (f: string) => fs.readFileSync(path.join(mobile, f), 'utf8')
  expect(read('App.tsx')).toContain('...(takesClear(Platform.OS, pushSyncNative) ? [PUSH_CLEAR_CAPABILITY] : [])')
  expect(read('src/push.ts')).toContain("Platform.OS === 'ios' && requireOptionalNativeModule('PushSync') !== null")
  // iOS runs the closed app for a content-available push only with the remote-notification background mode
  expect(read('app.config.ts')).toMatch(/\['expo-notifications', \{[^\n]*enableBackgroundRemoteNotifications: true/)
  // the module: iOS only, linked as a module and an app delegate subscriber
  expect(JSON.parse(read('modules/push-sync/expo-module.config.json'))).toEqual({ platforms: ['apple'], apple: { modules: ['PushSyncModule'], appDelegateSubscribers: ['PushSyncAppDelegateSubscriber'] } })
  const swift = read('modules/push-sync/ios/PushSync.swift')
  expect(swift).toContain(`static let code = "${PUSH_SYNC_CODE}"`)
  expect(swift).toContain(`static let maxClear = ${PUSH_SYNC_MAX_CLEAR}`)
  expect(swift).toContain('Name("PushSync")')
  // matched by body.notificationId first, the request identifier (apns-collapse-id) as a fallback
  expect(swift).toContain('ids.contains(noticeId(n) ?? "") || ids.contains(n.request.identifier)')
  // every path answers iOS; the removal answers only from inside getDeliveredNotifications' callback
  expect(swift).toContain('guard let ids = PushSync.ids(userInfo) else { completionHandler(.noData); return }')
  expect(swift).toMatch(/getDeliveredNotifications \{ delivered in[\s\S]*removeDeliveredNotifications[\s\S]*done\(!gone\.isEmpty\)/)
  // never shows anything and never sets the number (iOS applies aps.badge itself)
  expect(swift).not.toMatch(/UNNotificationRequest\(|\.add\(|applicationIconBadgeNumber|setBadgeCount/)
})
