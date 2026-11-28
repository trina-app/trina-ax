// A desktop sign-in's held code is redeemed only by the app that started it (docs/decisions/20261128-held-sign-in-app-key.md;
// server google-drive/app-return.ts heldProofOk; desktop common/code-return.ts key/proof).
//
// Why (owner 2026-11-28, with "Copy link" on the desktop wait): the sign-in address can now be copied and pasted into
// any browser, and so somewhere else. A return in a browser without the app's session is held for the app's one-time
// code. Before: anything with the starter's session redeemed that code (the page's own script too), and a browser
// session that merely SAID `client: 'desktop'` at the start got its returns held. Now the app keeps a secret per team,
// its page sends the sha256 with every call, the held result seals it, and the claim must carry the secret, which only
// the app's main process sends. Gmail and Slack: tests/unit/c-google-connect-finish.test.ts, c-slack.test.ts.
// Fake Google and fake services only.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { harness, withOwner, OWNER_PW, type Harness, type Client } from './a-lib'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { appReturnKey, appReturnPort, heldProofOk, noteAppReturn } from '../../server/src/integrations/google-drive/app-return'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { FakeGoogleDrive, DRIVE_CONFIG } from '../lib/fake-google-drive'
import { FakeServices } from '../lib/fake-services'
import { CodeReturn } from '../../desktop/src/common/code-return'
import { APP_RETURN_KEY_HEADER, APP_RETURN_PROOF_HEADER, appReturnKeyOf } from '../../shared/src/desktop-bridge'

setDefaultTimeout(30_000)

const TEAM = 'http://team.localhost'
let h: Harness, drive: FakeGoogleDrive, services: FakeServices, seq = 0
beforeAll(() => { services = new FakeServices() })
afterAll(() => services?.stop())
beforeEach(async () => {
  h = await harness('held-app-key-' + ++seq); await withOwner(h)
  drive = new FakeGoogleDrive(); googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: drive.fetch, now: () => drive.now })
  services.now = Date.now(); services.seen.length = 0
  integrationsOf(h.ctx, { net: services.net(), now: () => services.now })
})
afterEach(async () => { await h?.close() })

async function session(client: 'desktop' | 'web') {
  const c = h.client()
  await c.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, client, tokenMode: 'cookie' })
  return c
}
/** a desktop app: its key for the team page's calls, its proof for its claim */
function app() {
  const r = new CodeReturn({ deliver: () => false, page: () => '' })
  return { key: { [APP_RETURN_KEY_HEADER]: r.key(TEAM)! }, proof: r.proof(TEAM)! }
}
/** the system browser: no session */
const bare = (path: string) => h.fetch(path, { ip: '10.0.0.9' })
const codeOf = (html: string) => /href="trina-ax:\/\/open\?url=[^"#]+#code=([A-Za-z0-9_-]{43})"/.exec(html)?.[1] ?? null
const claim = (c: Client, code: string, proof?: string) => c.try('POST', '/api/integrations/google-drive/claim', { code }, proof ? { [APP_RETURN_PROOF_HEADER]: proof } : {})
const driveBase = '/api/integrations/google-drive'
const driveReturn = (q: { state: string; code: string }) => `${driveBase}/callback?${new URLSearchParams(q)}`

test('ATTACK (Drive): a held code reaches the starter\'s session without the app (the page\'s script, a code from a copied link): refused; the app\'s proof finishes it', async () => {
  const desk = await session('desktop'), me = app()
  const f = await desk.call('POST', driveBase + '/authorize', { client: 'desktop' }, me.key)
  const code = codeOf(await (await bare(driveReturn(drive.authorize(f.authorizationUrl, 'alice')))).text())!
  expect(code).toBeTruthy()
  // the session alone (before this change: 200 and the flow "ready" with the account to confirm)
  expect((await claim(desk, code)).status).toBe(400)
  // another app's proof, a proof of the wrong shape, another team's proof of this app
  expect((await claim(desk, code, app().proof)).status).toBe(400)
  expect((await claim(desk, code, 'x'.repeat(43))).status).toBe(400)
  expect((await claim(desk, code, new CodeReturn({ deliver: () => false, page: () => '' }).proof('https://other.example')!)).status).toBe(400)
  expect((await desk.call('GET', `${driveBase}/flows/${f.flowId}`)).state).toBe('pending')
  // the app: its proof
  const r = await claim(desk, code, me.proof)
  expect(r.status).toBe(200); expect(r.body.state).toBe('ready')
  expect((await claim(desk, code, me.proof)).status).toBe(400)
  expect((await desk.call('POST', `${driveBase}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
})

test('ATTACK (Drive): a browser\'s session that only SAYS client desktop gets no held result (it needs the app\'s key)', async () => {
  const web = await session('web')
  const f = await web.call('POST', driveBase + '/authorize', { client: 'desktop' })
  // before this change: held, with a code on the page for that session to redeem
  const page = await bare(driveReturn(drive.authorize(f.authorizationUrl, 'alice')))
  const html = await page.text()
  // "This browser is not signed in", as in 0.20.2
  expect(page.status).toBe(400)
  expect(codeOf(html)).toBeNull(); expect(html).not.toContain('#code=')
  expect((await web.call('GET', `${driveBase}/flows/${f.flowId}`)).state).not.toBe('ready')
})

test('an app from before (a desktop session, no key said): held as before, its claim needs no proof', async () => {
  const desk = await session('desktop')
  const f = await desk.call('POST', driveBase + '/authorize', {})
  const code = codeOf(await (await bare(driveReturn(drive.authorize(f.authorizationUrl, 'alice')))).text())!
  const r = await claim(desk, code)
  expect(r.status).toBe(200); expect(r.body.state).toBe('ready')
})

test('ATTACK (app connection): a held code without the app\'s proof is refused, nothing stored; with it, connected', async () => {
  const olga = await session('web'), desk = await session('desktop'), me = app()
  const c = await olga.call('POST', '/api/integrations', { kind: 'mcp', name: 'Board', url: `${services.base}/mcp-oauth?n=Board`, auth: 'oauth' })
  const f = await desk.call('POST', `/api/integrations/${c.id}/authorize`, {}, me.key)
  const html = await (await bare('/api/integrations/oauth/callback?' + new URLSearchParams(services.authorize(f.authorizationUrl)))).text()
  const code = codeOf(html)!
  expect(code).toBeTruthy()
  const status = async () => (await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)
  expect((await claim(desk, code)).status).toBe(400)
  expect((await claim(desk, code, app().proof)).status).toBe(400)
  expect(await status()).toMatchObject({ hasSecret: false })
  const r = await claim(desk, code, me.proof)
  expect(r.status).toBe(200); expect(r.body).toMatchObject({ flowId: f.flowId, state: 'completed' })
  expect(await status()).toMatchObject({ status: 'connected', hasSecret: true })
})

test('the app\'s key and proof: one secret per run, one proof per team, the key its sha256; only an origin; the server keeps a key per session', () => {
  const a = new CodeReturn({ deliver: () => false, page: () => '' }), b = new CodeReturn({ deliver: () => false, page: () => '' })
  const p = a.proof(TEAM)!
  expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(a.proof(TEAM)).toBe(p)
  expect(b.proof(TEAM)).not.toBe(p)
  expect(a.proof('https://other.example')).not.toBe(p)
  expect(appReturnKeyOf(a.key(TEAM))).toBe(a.key(TEAM))
  for (const bad of [TEAM + '/', 'team.localhost', 'javascript:alert(1)', 'ftp://x.example', '']) { expect(a.proof(bad)).toBeNull(); expect(a.key(bad)).toBeNull() }
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(65)]) expect(appReturnKeyOf(bad)).toBeNull()
  expect(heldProofOk(a.key(TEAM), p)).toBe(true)
  expect(heldProofOk(a.key(TEAM), b.proof(TEAM))).toBe(false)
  expect(heldProofOk(a.key(TEAM), null)).toBe(false)
  // held without a key (an app from before): no proof needed
  expect(heldProofOk(null, null)).toBe(true)
  // the server: per session, never a phone app's; a port and a key apart
  noteAppReturn({ id: 'k-desk', client: 'desktop' }, '50123', a.key(TEAM)!)
  expect(appReturnKey('k-desk')).toBe(a.key(TEAM)); expect(appReturnPort('k-desk')).toBe(50123)
  noteAppReturn({ id: 'k-mob', client: 'mobile' }, '50123', a.key(TEAM)!); expect(appReturnKey('k-mob')).toBeNull()
  noteAppReturn({ id: 'k-bad', client: 'desktop' }, undefined, 'nope'); expect(appReturnKey('k-bad')).toBeNull()
  noteAppReturn({ id: 'k-only', client: 'web' }, undefined, a.key(TEAM)!); expect(appReturnKey('k-only')).toBe(a.key(TEAM)); expect(appReturnPort('k-only')).toBeNull()
})
