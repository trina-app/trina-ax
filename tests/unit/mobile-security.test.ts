import { expect, test } from 'bun:test'
import { MobileReceiver, FileTransfers, type TransferIO } from '../../mobile/src/bridge'
import { MOBILE_CAPABILITIES, MAX_CHUNK_BYTES, base64Size, type MobileConfig } from '../../mobile/src/protocol'
import { parseTeamAddress } from '../../mobile/src/address'
import { mobileProduct } from '../../mobile/src/product'
const config: MobileConfig = { protocol: 1, platform: 'ios', appVersion: '0.2.2', nonce: 'a'.repeat(64), generation: 1, capabilities: MOBILE_CAPABILITIES }
function make() {
  let opened = 0, writes = 0
  const io: TransferIO = { async create() { writes++ }, async append() {}, async inspect() { return { size: 0, sha256: '' } }, async share() {}, async remove() {} }
  const receiver = new MobileReceiver('https://team.example', { ...config }, new FileTransfers(io), async () => { opened++ })
  const request = (over: object = {}) => JSON.stringify({ v: 1, nonce: config.nonce, generation: 1, id: 'request-123', type: 'external-open', purpose: 'google-oauth', url: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque', ...over })
  return { receiver, request, opened: () => opened, writes: () => writes }
}
test('native messages require the trusted origin and the current top-document nonce/generation', async () => {
  const f = make()
  for (const source of ['https://evil.example', 'data:foo', 'about:blank', 'blob:https://team.example/id']) expect(await f.receiver.receive(f.request(), source)).toBeNull()
  for (const over of [{ nonce: 'b'.repeat(64) }, { generation: 2 }, { v: 0 }]) expect(await f.receiver.receive(f.request(over), 'https://team.example/chat')).toBeNull()
  expect(f.opened()).toBe(0)
  expect((await f.receiver.receive(f.request(), 'https://team.example/chat'))?.ok).toBe(true)
  expect(f.opened()).toBe(1)
})
test('logout generation and page disable refuse late messages; reset replies carry the new generation', async () => {
  const f = make()
  const reply = await f.receiver.receive(f.request({ type: 'session-reset' }), 'https://team.example')
  expect(reply?.nextGeneration).toBe(2)
  expect(await f.receiver.receive(f.request(), 'https://team.example')).toBeNull()
  await f.receiver.disable()
  expect(await f.receiver.receive(f.request({ generation: f.receiver.config.generation }), 'https://team.example')).toBeNull()
  expect(f.opened()).toBe(0)
})
test('base64 boundary is exact and malformed or oversized chunks are rejected', () => {
  expect(base64Size(Buffer.alloc(MAX_CHUNK_BYTES).toString('base64'))).toBe(MAX_CHUNK_BYTES)
  expect(base64Size(Buffer.alloc(MAX_CHUNK_BYTES + 1).toString('base64'))).toBeNull()
  for (const s of ['', 'a', '====', 'a===', 'YQ==\n', '<script>']) expect(base64Size(s)).toBeNull()
})
test('team address preserves only an explicit invite path; edition settings cannot add capabilities or URLs', () => {
  expect(parseTeamAddress('team.example')).toEqual({ origin: 'https://team.example', entryPath: '/' })
  expect(parseTeamAddress('https://team.example/invite/abcd1234')).toEqual({ origin: 'https://team.example', entryPath: '/invite/abcd1234' })
  for (const s of ['http://team.example', 'https://user:pass@team.example', 'https://team.example/random', 'https://team.example?token=a', 'javascript:alert(1)']) expect(parseTeamAddress(s)).toBeNull()
  expect(mobileProduct({ name: 'Example Team', accent: '#123456', url: 'https://evil.example', capabilities: ['shell'] })).toEqual({ name: 'Example Team', accent: '#123456', userAgent: 'TeamAX-Mobile', scheme: 'teamax-mobile', bundleId: 'app.teamax.mobile.dev' })
})

test('navigation blocks custom/opaque schemes and external frames while permitting same-origin child blob previews', async () => {
  const { navigationDecision } = await import('../../mobile/src/protocol')
  for (const url of ['intent://launch', 'tel:123', 'file:///secret', 'data:text/html,body', 'about:blank', 'javascript:alert(1)']) expect(navigationDecision('https://team.example', url, true)).toBe('deny')
  expect(navigationDecision('https://team.example', 'https://outside.example', false)).toBe('deny')
  expect(navigationDecision('https://team.example', 'https://outside.example', true)).toBe('external')
  expect(navigationDecision('https://team.example', 'blob:https://team.example/id', false)).toBe('internal')
  expect(navigationDecision('https://team.example', 'blob:https://team.example/id', true)).toBe('deny')
})
