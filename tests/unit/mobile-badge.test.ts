// badge-v1 (mobile/src/protocol.ts BADGE_CAPABILITY): the page's one count on the app icon. The message is an integer
// from 0 to 9999 and nothing else; only the team's current document on an app that offers the capability sets it; the
// answer says badgeOff when iOS has badges off; the capability is optional (never required by protocol 1).
import { expect, test } from 'bun:test'
import { FileTransfers, MobileReceiver, type SetBadge, type TransferIO } from '../../mobile/src/bridge'
import { BADGE_CAPABILITY, MAX_BADGE, MOBILE_CAPABILITIES, parseMessage, validBadge, validConfig, type MobileConfig } from '../../mobile/src/protocol'
import { PUSH_GATEWAY_MAX_BADGE } from '../../shared/src/cloud-protocol/push-gateway'

const base = { v: 1 as const, nonce: 'a'.repeat(64), generation: 1, id: 'badge-1234' }
const config: MobileConfig = { protocol: 1, platform: 'ios', appVersion: '1.0.5', nonce: base.nonce, generation: 1, capabilities: [...MOBILE_CAPABILITIES, BADGE_CAPABILITY] }
const io: TransferIO = { async create() {}, async append() {}, async inspect() { return { size: 0, sha256: '' } }, async share() {}, async remove() {} }
const msg = (o: Record<string, unknown>) => JSON.stringify({ ...base, type: 'badge', ...o })
function receiver(capabilities = config.capabilities, off = false, fail = false) {
  const set: number[] = []
  const badge: SetBadge = async (count) => { if (fail) throw new Error('native'); set.push(count); return { off } }
  const r = new MobileReceiver('https://team.example', { ...config, capabilities }, new FileTransfers(io), async () => {}, undefined, undefined, undefined, undefined, undefined, badge)
  return { r, set }
}

test('the message: an integer from 0 to 9999, nothing else', () => {
  for (const count of [0, 1, 42, MAX_BADGE]) expect(parseMessage(msg({ count }))).toEqual({ ...base, type: 'badge', count } as never)
  for (const count of [-1, MAX_BADGE + 1, 1.5, '3', null, undefined, true, Number.NaN]) expect(parseMessage(msg({ count }))).toBeNull()
  for (const n of [0, MAX_BADGE]) expect(validBadge(n)).toBe(true)
  for (const n of [-1, MAX_BADGE + 1, 0.5, '1']) expect(validBadge(n)).toBe(false)
  // the same bound as the push gateway's badge
  expect(MAX_BADGE).toBe(PUSH_GATEWAY_MAX_BADGE)
})

test('optional: a bridge without badge-v1 is still a phone app; badge-v1 is not required', () => {
  expect(MOBILE_CAPABILITIES as readonly string[]).not.toContain(BADGE_CAPABILITY)
  expect(validConfig({ ...config, capabilities: [...MOBILE_CAPABILITIES] })).toBe(true)
  expect(validConfig(config)).toBe(true)
})

test('the receiver sets the number only for the team\'s current document on an app that offers badge-v1', async () => {
  const off = receiver([...MOBILE_CAPABILITIES])
  expect(await off.r.receive(msg({ count: 3 }), 'https://team.example/')).toMatchObject({ ok: false, error: 'mobile_operation_failed' })
  expect(off.set).toEqual([])
  const { r, set } = receiver()
  for (const source of ['https://evil.example/', 'blob:https://team.example/x']) expect(await r.receive(msg({ count: 3 }), source)).toBeNull()
  expect(await r.receive(msg({ count: 3, nonce: 'b'.repeat(64) }), 'https://team.example/')).toBeNull()
  expect(await r.receive(msg({ count: 3, generation: 2 }), 'https://team.example/')).toBeNull()
  expect(await r.receive(msg({ count: -1 }), 'https://team.example/')).toBeNull()
  expect(set).toEqual([])
  const reply = await r.receive(msg({ count: 3 }), 'https://team.example/rooms/x')
  expect(reply).toMatchObject({ ok: true, for: 'badge', id: base.id })
  expect(reply).not.toHaveProperty('badgeOff')
  expect(await r.receive(msg({ count: 0 }), 'https://team.example/')).toMatchObject({ ok: true })
  expect(set).toEqual([3, 0])
  // a disabled bridge (a navigation, a team change) sets nothing
  await r.disable()
  expect(await r.receive(msg({ count: 5 }), 'https://team.example/')).toBeNull()
  expect(set).toEqual([3, 0])
})

test('the answer says badgeOff when iOS has badges off; a native failure is a plain failure', async () => {
  const off = receiver(config.capabilities, true)
  expect(await off.r.receive(msg({ count: 2 }), 'https://team.example/')).toMatchObject({ ok: true, badgeOff: true })
  const failing = receiver(config.capabilities, false, true)
  expect(await failing.r.receive(msg({ count: 2 }), 'https://team.example/')).toMatchObject({ ok: false, error: 'mobile_operation_failed' })
})
