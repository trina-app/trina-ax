import { expect, test } from 'bun:test'
import { MobileReceiver, FileTransfers, type TransferIO } from '../../mobile/src/bridge'
import { MOBILE_CAPABILITIES, MAX_CHUNK_BYTES, base64Size, type MobileConfig } from '../../mobile/src/protocol'
import { parseTeamAddress, readTeamInput } from '../../mobile/src/address'
import { accentInk, installGuide, mobileProduct, mobileService } from '../../mobile/src/product'
import { fill, inputError, stringsFor } from '../../mobile/src/strings'
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
test('team address keeps the page of an invite or team link, never a cut-off link; edition settings cannot add capabilities or URLs', () => {
  expect(parseTeamAddress('team.example')).toEqual({ origin: 'https://team.example', entryPath: '/' })
  expect(parseTeamAddress('https://team.example/invite/abcd1234')).toEqual({ origin: 'https://team.example', entryPath: '/invite/abcd1234' })
  expect(parseTeamAddress('https://team.example/join#t=0INpvAqjFG3OhdmwH4CfCuxr')).toEqual({ origin: 'https://team.example', entryPath: '/join#t=0INpvAqjFG3OhdmwH4CfCuxr' })
  // another page of the team (copied from a browser's address bar) opens the team's start
  for (const s of ['https://team.example/random', 'https://team.example?token=a']) expect(parseTeamAddress(s)).toEqual({ origin: 'https://team.example', entryPath: '/' })
  for (const s of ['http://team.example', 'https://user:pass@team.example', 'javascript:alert(1)', 'https://team.example/invite/x', 'https://team.example/join', 'acme']) expect(parseTeamAddress(s)).toBeNull()
  // the first-run box: a bare name is the edition's hosted address, https only on the phone
  expect(readTeamInput('acme', 'trina.app')).toMatchObject({ ok: true, origin: 'https://acme.trina.app', hosted: true })
  expect(readTeamInput('acme', null)).toEqual({ ok: false, error: 'invalid' })
  expect(readTeamInput('http://acme.localhost:19883', 'trina.app')).toEqual({ ok: false, error: 'insecure' })
  expect(mobileProduct({ name: 'Example Team', accent: '#123456', url: 'https://evil.example', capabilities: ['shell'] })).toEqual({ name: 'Example Team', accent: '#123456', userAgent: 'TeamAX-Mobile', scheme: 'teamax-mobile', bundleId: 'app.teamax.mobile.dev' })
})

test('the default accent is the Trina orange, and the label on it stays readable', () => {
  expect(mobileProduct(undefined).accent).toBe('#e8521a')
  expect(accentInk('#e8521a')).toBe('#14110f') // 5.06:1; white would be 3.71:1
  expect(accentInk('#176b55')).toBe('#ffffff') // a dark accent keeps white text
})

test('edition install identity preserves a valid two-segment app id and rejects malformed ids', () => {
  expect(mobileProduct({ bundleId: 'app.example' }).bundleId).toBe('app.example')
  for (const bundleId of ['single', 'app..example', 'app.0example', 'app.example/path', 'https://example', 'app.example\n']) {
    expect(mobileProduct({ bundleId }).bundleId).toBe('app.teamax.mobile.dev')
  }
})

test('navigation blocks custom/opaque schemes and external frames while permitting same-origin child blob previews', async () => {
  const { navigationDecision } = await import('../../mobile/src/protocol')
  for (const url of ['intent://launch', 'tel:123', 'file:///secret', 'data:text/html,body', 'about:blank', 'javascript:alert(1)']) expect(navigationDecision('https://team.example', url, true)).toBe('deny')
  expect(navigationDecision('https://team.example', 'https://outside.example', false)).toBe('deny')
  expect(navigationDecision('https://team.example', 'https://outside.example', true)).toBe('external')
  expect(navigationDecision('https://team.example', 'blob:https://team.example/id', false)).toBe('internal')
  expect(navigationDecision('https://team.example', 'blob:https://team.example/id', true)).toBe('deny')
})

test('the edition gives the team domain and the install guide; anything odd is dropped', () => {
  expect(mobileService({ teamDomain: 'trina.app' }, { repository: 'https://github.com/trina-app/trina-ax' })).toEqual({ teamDomain: 'trina.app', repository: 'https://github.com/trina-app/trina-ax' })
  for (const d of ['https://trina.app', 'trina', 'evil.example/x', 42, '']) expect(mobileService({ teamDomain: d }, {}).teamDomain).toBeNull()
  for (const r of ['http://github.com/a/b', 'https://evil.example/a/b', 'https://github.com/a/b?x', 'https://github.com/a/b/../c']) expect(mobileService({}, { repository: r }).repository).toBeNull()
  expect(mobileService(undefined, undefined)).toEqual({ teamDomain: null, repository: null })
  // ③'s link: the repository's install guide (no signup or pricing link on it)
  expect(installGuide('https://github.com/trina-app/trina-ax', true)).toBe('https://github.com/trina-app/trina-ax/blob/main/docs/INSTALL-LINUX.md')
  expect(installGuide('https://github.com/trina-app/trina-ax', false)).toBe('https://github.com/trina-app/trina-ax/blob/main/docs/INSTALL-LINUX.en.md')
  expect(installGuide(null, true)).toBeNull()
})

test('the first-run screen speaks Korean or English; the questions name both teams and never promise notifications', () => {
  const ko = stringsFor('ko'), en = stringsFor('en')
  expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort())
  for (const v of Object.values(en)) expect(/[\uAC00-\uD7A3\u3130-\u318F]/.test(v)).toBe(false)
  expect(fill(ko.switchTitle, { old: 'acme.trina.app', new: 'beta.trina.app' })).toBe('acme.trina.app에서 나가고 beta.trina.app에 연결할까요?')
  expect(fill(ko.switchBody, { old: 'acme.trina.app' })).toBe('이제 acme.trina.app 알림은 이 휴대폰으로 오지 않아요.')
  expect(fill(ko.backTo, { team: 'acme.trina.app' })).toBe('acme.trina.app(으)로 돌아가기')
  expect(fill(ko.teamUnknown, { name: 'acme' })).toBe("'acme' 팀을 찾지 못했어요. 철자를 확인하거나 초대 링크를 붙여 넣어 주세요.")
  // a value is never read as a pattern
  expect(fill('{a}', { a: '{b}', b: 'x' })).toBe('{b}')
  expect(inputError(ko, 'hangul')).toBe('한글로 입력됐어요. 한/영 키를 누르고 다시 입력하거나 초대 링크를 붙여 넣어 주세요.')
  expect(inputError(ko, 'email')).toBe('이메일 주소는 쓰지 않아요. 초대 링크나 팀 주소를 넣어 주세요.')
  expect(inputError(ko, 'unsupported_scheme')).toBe(ko.invalidAddress)
  for (const v of [ko.switchBody, ko.switchTitle, en.switchBody]) expect(v).not.toMatch(/옮겨|move/i)
})

test('the phone has no "create a team" link (App Review 3.1.1, Google Play payments) and leaves a team only after a yes', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, '../../mobile/App.tsx'), 'utf8') as string
  expect(app).not.toMatch(/signup|accountHost|noTeamCreate|account\./i)
  // leaving happens in connect(), which only the box's yes (or a first team) reaches
  expect(app.match(/leaveTeam\(/g)?.length).toBe(1)
  expect(app).toMatch(/async function connect\(address: TeamAddress\) \{\n\s*if \(team && team\.origin !== address\.origin\) await leave\(team\.origin\)/)
  expect(app).toMatch(/onChangeTeam=\{\(\) => setAdding\(true\)\}/)
})
