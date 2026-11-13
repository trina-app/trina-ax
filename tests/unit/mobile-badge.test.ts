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
