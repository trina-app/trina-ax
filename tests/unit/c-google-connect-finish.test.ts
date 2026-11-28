// A Google sign-in that worked never ends on a failure page (owner 2026-11-21: "This browser can't finish it" and
// "Not connected: this sign-in has expired or was already used" after connecting Google Drive or Gmail, and back in
// the app it was sometimes connected anyway; qa.trina.app flows and the broker log of that morning). Covered, for
// Google Drive and the Google apps:
//  - a second return of one sign-in (a reload, a duplicate request while the first still talks to Google): one
//    exchange, and both pages say it worked; after the confirm, "Connected";
//  - a window of an earlier try that comes back after a later try connected: "Connected";
//  - the desktop app's sign-in of Gmail, Calendar, Docs or Sheets: the system browser has no session, so the result
//    waits for the app's one-time code (as Drive's since #98), which the Drive claim address the desktop app already
//    calls now redeems too, for the starter's session only (the phishing case of #98's review fails as for Drive);
//  - a refusal at the claim address (a Google app's), one waiter per sign-in, results never used revoked at Google
//    (unless that ends a live sign-in), and the confirm step's line for a Google account that is not the person's own;
//  - a held page opened again: "go back to the app", never a second code and never finished there (the starter has
//    the state too: it is in the Google address; review of this change).
// Fake Google only.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { harness, withOwner, addMember, OWNER_PW, SETUP_TOKEN, type Harness, type Client } from './a-lib'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { googleAppsOf } from '../../server/src/integrations/google-apps/service'
import { googleReturnOf, googleReturnPage } from '../../server/src/integrations/google-drive/callback-page'
import { GOOGLE_TOKEN, type DriveFetch } from '../../server/src/integrations/google-drive/client'
import { FakeGoogleDrive, DRIVE_CONFIG, membersMayConnect } from '../lib/fake-google-drive'
import { APP_CLIENT, FakeGoogle, FakeLibrary } from '../lib/fake-google-apps'
import { LOCALE_ORDER as LOCALES } from '../../shared/src/api'
import { notOwnEmail } from '../../web/src/lib/googleAccount'
import { CodeReturn } from '../../desktop/src/common/code-return'
import { APP_RETURN_KEY_HEADER, APP_RETURN_PROOF_HEADER } from '../../shared/src/desktop-bridge'

setDefaultTimeout(30_000)

let h: Harness, owner: Client, bob: Client, fake: FakeGoogleDrive, google: FakeGoogle, lib: FakeLibrary, seq = 0
/** a gate on Google's token exchange: a return that reaches it waits until the test opens it */
let gate: Promise<void> | null = null
const BOB_PW = 'river stone lamp 7'
const drive = '/api/integrations/google-drive'
const gmail = '/api/integrations/google-apps/gmail'
const gated = (f: DriveFetch): DriveFetch => async (url, init) => { if (url === GOOGLE_TOKEN && gate) await gate; return f(url, init) }

beforeAll(() => { lib = new FakeLibrary().start(); process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL = lib.url })
afterAll(() => { lib.stop(); delete process.env.MYCEL_GOOGLE_APPS_LIBRARY_URL })
beforeEach(async () => {
  gate = null
  h = await harness('google-connect-finish-' + ++seq); owner = await withOwner(h)
  ;(h.ctx.config as any).tunnel = { host: 'team.example.test' }
  await addMember(h, owner, { username: 'bob', password: BOB_PW })
  bob = await login('bob', BOB_PW, 'web')
  fake = new FakeGoogleDrive(); googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: gated(fake.fetch), now: () => fake.now }); membersMayConnect(h.ctx.db)
  google = new FakeGoogle(lib); googleAppsOf(h.ctx, { fetch: gated(google.fetch) })
})
afterEach(async () => { await h?.close() })

async function login(username: string, password: string, client: 'desktop' | 'web') {
  const c = h.client()
  await c.call('POST', '/api/auth/login', { username, password, client, tokenMode: 'cookie' })
  return c
}
/** a system browser with no session at all */
const bare = (path: string) => h.fetch(path, { ip: '10.0.0.9' })
const cb = (base: string, q: { state: string; code: string }) => `${base}/callback?${new URLSearchParams(q)}`
const gmailReturn = (q: { state: string; code: string }) => `/api/integrations/google-apps/callback?${new URLSearchParams(q)}`
function codeOf(html: string): string | null {
  const m = /href="trina-ax:\/\/open\?url=[^"#]+#code=([A-Za-z0-9_-]{43})"/.exec(html)
  return m ? m[1]! : null
}
const claim = (c: Client, code: string, proof?: string | null) => c.try('POST', drive + '/claim', { code }, proof ? { [APP_RETURN_PROOF_HEADER]: proof } : {})
/** a desktop app's key and proof (desktop/src/common/code-return.ts; docs/decisions/20261128-held-sign-in-app-key.md) */
function appKey(team = 'http://team.localhost') {
  const r = new CodeReturn({ deliver: () => false, page: () => '' })
  return { header: { [APP_RETURN_KEY_HEADER]: r.key(team)! }, proof: r.proof(team)! }
}
const exchanges = () => fake.calls.filter((c) => c.url === GOOGLE_TOKEN).length
async function setUpGmail() {
  const r = await owner.try('PUT', '/api/admin/google-apps/gmail/client', { clientId: APP_CLIENT.clientId, clientSecret: APP_CLIENT.clientSecret })
  expect(r.status).toBe(200)
}
/** the person's own address: a return page connects a personal sign-in at once only for it (login CSRF review) */
const ownEmail = (email: string, username = 'olga') => h.ctx.db.query('UPDATE users SET email=? WHERE username=?').run(email, username)
const EXPIRED = '시간이 지났거나 이미 사용됐어요'
const CONNECTED = '이미 연결됐어요'

test('Drive: the browser of the session that started it connects at once; a reload says Connected; never "expired or already used"', async () => {
  ownEmail('alice@example.test')
  const f = await owner.call('POST', drive + '/authorize', {})
  const url = cb(drive, fake.authorize(f.authorizationUrl))
  const first = await owner.raw('GET', url)
  const firstHtml = await first.text()
  // Windows QA 2026-11-28: no "go back to the app and confirm" in a browser; the first tab's poll sees it completed
  expect(first.status).toBe(200); expect(firstHtml).toContain('연결됐어요'); expect(firstHtml).toContain('원래 탭'); expect(firstHtml).not.toContain('앱')
  expect((await owner.call('GET', `${drive}/flows/${f.flowId}`)).state).toBe('completed')
  expect((await owner.call('GET', drive)).status).toBe('connected')
  // a reload (or the browser opening the address again): Connected, and nothing is exchanged again
  const n = exchanges()
  const again = await owner.raw('GET', url)
  const html = await again.text()
  expect(again.status).toBe(200); expect(html).toContain(CONNECTED); expect(html).not.toContain(EXPIRED)
  expect(exchanges()).toBe(n)
})

test('Drive: another session of the same person brings Google back: the account waits for the confirm in the first tab', async () => {
  const f = await owner.call('POST', drive + '/authorize', {})
  const url = cb(drive, fake.authorize(f.authorizationUrl))
  const second = await login('olga', OWNER_PW, 'web')
  const p = await second.raw('GET', url)
  const html = await p.text()
  expect(p.status).toBe(200); expect(html).toContain('거의 다 됐어요'); expect(html).toContain('원래 탭으로 돌아가 ‘이 계정 연결’을 누르세요')
  expect((await owner.call('GET', `${drive}/flows/${f.flowId}`)).state).toBe('ready')
  expect((await owner.call('POST', `${drive}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
  const done = await second.raw('GET', url)
  expect(done.status).toBe(200); expect(await done.text()).toContain(CONNECTED)
})

test('Drive: two returns of one sign-in at the same time: Google is asked once, both pages say it worked', async () => {
  ownEmail('alice@example.test')
  const f = await owner.call('POST', drive + '/authorize', {})
  const url = cb(drive, fake.authorize(f.authorizationUrl))
  let open!: () => void
  gate = new Promise((r) => { open = r })
  const a = owner.raw('GET', url)
  await Bun.sleep(50)
  const b = owner.raw('GET', url) // the second arrives while the first still waits for Google
  await Bun.sleep(300)
  open()
  const pages = await Promise.all([a, b].map(async (p) => { const r = await p; return { status: r.status, html: await r.text() } }))
  for (const p of pages) { expect(p.status).toBe(200); expect(p.html).not.toContain(EXPIRED) }
  expect(exchanges()).toBe(1)
  expect((await owner.call('GET', `${drive}/flows/${f.flowId}`)).state).toBe('completed')
})

test('Drive: a window of an earlier try that comes back after a later try connected says Connected; one that did not, expired', async () => {
  ownEmail('alice@example.test')
  let f1 = await owner.call('POST', drive + '/authorize', {})
  let old = cb(drive, fake.authorize(f1.authorizationUrl))
  // Try again: a new sign-in replaces the first; nothing connected yet, so the first window's return is "expired"
  let f2 = await owner.call('POST', drive + '/authorize', {})
  let p = await owner.raw('GET', old)
  expect(p.status).toBe(400); expect(await p.text()).toContain(EXPIRED)
  // the later try connects, then the earlier window comes back: Connected
  f1 = await owner.call('POST', drive + '/authorize', {})
  old = cb(drive, fake.authorize(f1.authorizationUrl))
  f2 = await owner.call('POST', drive + '/authorize', {})
  await owner.raw('GET', cb(drive, fake.authorize(f2.authorizationUrl)))
  expect((await owner.call('GET', `${drive}/flows/${f2.flowId}`)).state).toBe('completed')
  p = await owner.raw('GET', old)
  expect(p.status).toBe(200); expect(await p.text()).toContain(CONNECTED)
  // and it did not reopen the replaced flow
  expect((await owner.call('GET', `${drive}/flows/${f1.flowId}`)).state).toBe('failed')
})

test('Drive desktop: the held page loaded again says to go back to the app, with no new code; the first code still works', async () => {
  const desk = await login('olga', OWNER_PW, 'desktop')
  const f = await desk.call('POST', drive + '/authorize', {})
  const url = cb(drive, fake.authorize(f.authorizationUrl))
  const p1 = await (await bare(url)).text()
  const c1 = codeOf(p1)!
  expect(c1).toBeTruthy()
  expect(p1).toContain('Trina AX 앱으로 돌아가서 마치세요')
  const n = exchanges()
  const p2 = await bare(url)
  const h2 = await p2.text()
  expect(codeOf(h2)).toBeNull(); expect(h2).not.toContain('#code=')
  expect(h2).toContain('앱이 마치기를 기다리고 있어요'); expect(h2).not.toContain(EXPIRED)
  expect(exchanges()).toBe(n)
  expect((await desk.call('GET', `${drive}/flows/${f.flowId}`)).state).toBe('pending')
  const r = await claim(desk, c1)
  expect(r.status).toBe(200); expect(r.body.state).toBe('ready')
})

for (const which of ['Drive', 'Gmail'] as const) {
  test(`ATTACK (${which}): the starter brings the state of a held result again, signed out or signed in: no code, nothing finished`, async () => {
    if (which === 'Gmail') await setUpGmail()
    const base = which === 'Drive' ? drive : gmail
    const back = (q: { state: string; code: string }) => (which === 'Drive' ? cb(drive, q) : gmailReturn(q))
    const attackerApp = await login('bob', BOB_PW, 'desktop')
    const f = await attackerApp.call('POST', base + '/authorize', {})
    // the state is in the Google address the attacker's app was given
    const state = new URL(f.authorizationUrl).searchParams.get('state')!
    // the victim consents in a browser without a session: held, the code only on the victim's page
    const victimPage = await (await bare(back(which === 'Drive' ? fake.authorize(f.authorizationUrl, 'alice') : google.authorize(f.authorizationUrl, 'olga')))).text()
    expect(codeOf(victimPage)).toBeTruthy()
    // the attacker opens the return address with that state: without a session, and signed in as himself
    for (const res of [await bare(`${base}/callback?state=${state}`), await attackerApp.raw('GET', `${base}/callback?state=${state}`), await bob.raw('GET', `${base}/callback?state=${state}`)]) {
      const html = await res.text()
      expect(codeOf(html)).toBeNull(); expect(html).not.toContain('#code=')
    }
    expect((await attackerApp.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('pending')
    expect((await attackerApp.try('POST', `${base}/flows/${f.flowId}/complete`, {})).status).toBe(409)
  })
}

test('Gmail from the desktop app: the system browser without a session gets the app link with a one-time code; the app\'s own session finishes it', async () => {
  await setUpGmail()
  const desk = await login('olga', OWNER_PW, 'desktop')
  const f = await desk.call('POST', gmail + '/authorize', {})
  const url = gmailReturn(google.authorize(f.authorizationUrl, 'olga'))
  // before: "This browser can't finish it" (no session), and the flow waited for a browser that never came
  const page = await bare(url)
  const html = await page.text()
  expect(page.status).toBe(200)
  expect(html).not.toContain('이 브라우저에서는 마칠 수 없어요')
  expect(html).toContain('Trina AX 앱으로 돌아가서 마치세요')
  expect(html).toContain('연결할 Trina AX 계정: Olga Owner (@olga)')
  const code = codeOf(html)!
  expect(code).toBeTruthy()
  expect(html).not.toMatch(new RegExp(`[?&]code=${code}`))
  // plain "pending" to the app, no account until the code comes back
  let flow = await desk.call('GET', `${gmail}/flows/${f.flowId}`)
  expect(flow.state).toBe('pending'); expect(flow.account).toBeNull()
  // another session of the same person cannot use it
  const desk2 = await login('olga', OWNER_PW, 'desktop')
  expect((await claim(desk2, code)).status).toBe(400)
  // the desktop app posts every code to the Drive claim address: it finishes this Gmail sign-in
  const r = await claim(desk, code)
  expect(r.status).toBe(200); expect(r.body.state).toBe('ready'); expect(r.body.account.email).toBe('olga@acme.example')
  expect((await claim(desk, code)).status).toBe(400)
  flow = await desk.call('GET', `${gmail}/flows/${f.flowId}`)
  expect(flow.state).toBe('ready')
  expect((await desk.call('POST', `${gmail}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
  // the page again after the confirm: Connected
  const done = await bare(url)
  expect(done.status).toBe(200); expect(await done.text()).toContain(CONNECTED)
})

test('ATTACK: a "desktop" login made with curl phishes a victim into Gmail\'s consent: nothing connects to the attacker', async () => {
  await setUpGmail()
  const attacker = await login('bob', BOB_PW, 'desktop')
  const f = await attacker.call('POST', gmail + '/authorize', {})
  const html = await (await bare(gmailReturn(google.authorize(f.authorizationUrl, 'olga')))).text()
  const code = codeOf(html)!
  // the page says it joins bob's account
  expect(html).toContain('(@bob)')
  // the attacker sees only "waiting"
  const seen = await attacker.call('GET', `${gmail}/flows/${f.flowId}`)
  expect(seen.state).toBe('pending'); expect(seen.account).toBeNull()
  // the code goes to the victim's own computer, whose app has the victim's session
  const victimApp = await login('olga', OWNER_PW, 'desktop')
  expect((await claim(victimApp, code)).status).toBe(400)
  expect((await claim(attacker, 'B'.repeat(43))).status).toBe(400)
  expect((await attacker.try('POST', `${gmail}/flows/${f.flowId}/complete`, {})).status).toBe(409)
  // signed in as the victim in that browser: refused as before, no code
  const f2 = await attacker.call('POST', gmail + '/authorize', {})
  const p = await owner.raw('GET', gmailReturn(google.authorize(f2.authorizationUrl, 'olga')))
  const ph = await p.text()
  expect(p.status).toBe(400); expect(codeOf(ph)).toBeNull()
  expect((await attacker.call('GET', `${gmail}/flows/${f2.flowId}`)).state).toBe('pending')
})

test('REPRO (QA 2026-11-27): the desktop app with a session recorded as "web": its page says desktop at the start, so Gmail and Drive are handed back to the app, not "not signed in"', async () => {
  ownEmail('olga@acme.example')
  await setUpGmail()
  // a desktop app's session the server recorded as a browser's (made before the app said so, or by a page that did not)
  const desk = await login('olga', OWNER_PW, 'web'), app = appKey()
  // before: the start said nothing, the return in the system browser was "This browser is not signed in" and the app
  // waited until its wait ran out
  const before = await desk.call('POST', gmail + '/authorize', {})
  const old = await bare(gmailReturn(google.authorize(before.authorizationUrl, 'olga')))
  expect(old.status).toBe(400); expect(codeOf(await old.text())).toBeNull()
  expect((await desk.call('GET', `${gmail}/flows/${before.flowId}`)).state).toBe('pending')
  // now: the desktop app's page says it is the desktop app (web/src/lib/driveSignIn.ts googleStartBody)
  for (const [base, ret, auth] of [
    [gmail, gmailReturn, (u: string) => google.authorize(u, 'olga')],
    [drive, (q: { state: string; code: string }) => cb(drive, q), (u: string) => fake.authorize(u)],
  ] as const) {
    // with the app's key, as every call of the desktop app's page (web lib/api.ts; 2026-11-28: a word without it is not held)
    const f = await desk.call('POST', base + '/authorize', { client: 'desktop' }, app.header)
    const page = await bare(ret(auth(f.authorizationUrl)))
    const html = await page.text()
    expect(page.status).toBe(200)
    const code = codeOf(html)!
    expect(code).toBeTruthy()
    expect((await desk.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('pending')
    // only this session redeems it, as for a session recorded as the desktop app's
    expect((await claim(await login('olga', OWNER_PW, 'desktop'), code, app.proof)).status).toBe(400)
    // and only with the app's proof (the page's script, or whoever got the code, has none)
    expect((await claim(desk, code)).status).toBe(400)
    const r = await claim(desk, code, app.proof)
    expect(r.status).toBe(200); expect(r.body.state).toBe('ready')
    // the held page opened again: go back to the app, no second code
    const again = await (await bare(ret(auth(f.authorizationUrl)))).text()
    expect(codeOf(again)).toBeNull()
  }
  // a browser signed in as the same person still finishes at once, with no code, when the page says desktop (the word
  // without the app's key is a browser's: connected right there)
  const f = await owner.call('POST', gmail + '/authorize', { client: 'desktop' })
  const direct = await owner.raw('GET', gmailReturn(google.authorize(f.authorizationUrl, 'olga')))
  expect(direct.status).toBe(200); expect(codeOf(await direct.text())).toBeNull()
  expect((await owner.call('GET', `${gmail}/flows/${f.flowId}`)).state).toBe('completed')
  // the team sign-in's start takes it too (a strict body)
  expect((await owner.try('POST', '/api/admin/google-apps/gmail/team/authorize', { client: 'desktop' })).status).toBe(200)
  expect((await owner.try('POST', '/api/admin/google-apps/gmail/team/authorize', { client: 'mobile' })).status).toBe(400)
})

test('ATTACK: a browser session that says "desktop" at the start phishes a victim into Gmail\'s consent: nothing connects to the attacker', async () => {
  await setUpGmail()
  // the word alone (no app key: a browser's page): not held since 2026-11-28, the browser without a session is refused
  const f0 = await bob.call('POST', gmail + '/authorize', { client: 'desktop' })
  const p0 = await bare(gmailReturn(google.authorize(f0.authorizationUrl, 'olga')))
  expect(p0.status).toBe(400); expect(codeOf(await p0.text())).toBeNull()
  // with a key of his own (curl can send one): held, which is no more than a curl "desktop" login already gives anyone
  const own = appKey()
  const f = await bob.call('POST', gmail + '/authorize', { client: 'desktop' }, own.header)
  const html = await (await bare(gmailReturn(google.authorize(f.authorizationUrl, 'olga')))).text()
  const code = codeOf(html)!
  expect(html).toContain('(@bob)')
  expect((await bob.call('GET', `${gmail}/flows/${f.flowId}`)).account).toBeNull()
  // the code reaches the victim's own app, whose session and proof are the victim's: refused
  expect((await claim(await login('olga', OWNER_PW, 'desktop'), code, appKey().proof)).status).toBe(400)
  expect((await claim(bob, 'B'.repeat(43), own.proof)).status).toBe(400)
  expect((await bob.try('POST', `${gmail}/flows/${f.flowId}/complete`, {})).status).toBe(409)
})

test('Gmail: two returns of one sign-in at the same time and a reload: one exchange, no failure page', async () => {
  await setUpGmail(); ownEmail('olga@acme.example')
  const f = await owner.call('POST', gmail + '/authorize', {})
  const url = gmailReturn(google.authorize(f.authorizationUrl, 'olga'))
  let open!: () => void
  gate = new Promise((r) => { open = r })
  const a = owner.raw('GET', url)
  await Bun.sleep(50)
  const b = owner.raw('GET', url)
  await Bun.sleep(300)
  open()
  for (const p of await Promise.all([a, b])) { expect(p.status).toBe(200); expect(await p.text()).not.toContain(EXPIRED) }
  expect(google.tokenCalls.filter((c) => c.get('grant_type') === 'authorization_code')).toHaveLength(1)
  expect((await owner.call('GET', `${gmail}/flows/${f.flowId}`)).state).toBe('completed')
  // a web sign-in that is cancelled stays "expired or already used" on a reload (no new meaning for a failed one)
  const g = await owner.call('POST', gmail + '/authorize', {})
  const q = google.authorize(g.authorizationUrl, 'olga')
  await owner.call('DELETE', `${gmail}/flows/${g.flowId}`)
  const late = await owner.raw('GET', gmailReturn(q))
  expect(late.status).toBe(400); expect(await late.text()).toContain(EXPIRED)
})

test('LOGIN CSRF: a leaked sign-in address consented with someone else\'s Google never connects by itself; the confirm card shows it', async () => {
  // the person's own address is known: another Google account (or an unknown one) goes to the confirm step
  ownEmail('olga@team.example')
  const f = await owner.call('POST', drive + '/authorize', {})
  const p = await owner.raw('GET', cb(drive, fake.authorize(f.authorizationUrl, 'mallory')))
  const html = await p.text()
  expect(p.status).toBe(200); expect(html).toContain('거의 다 됐어요'); expect(html).not.toContain('연결됐어요')
  const flow = await owner.call('GET', `${drive}/flows/${f.flowId}`)
  expect(flow.state).toBe('ready'); expect(flow.account.email).toBe('mallory@example.test')
  expect((await owner.call('GET', drive)).status).toBe('disconnected')
  // no address known for the person: never at once either
  h.ctx.db.query("UPDATE users SET email=NULL WHERE username='olga'").run()
  const g = await owner.call('POST', drive + '/authorize', {})
  await owner.raw('GET', cb(drive, fake.authorize(g.authorizationUrl, 'olga')))
  expect((await owner.call('GET', `${drive}/flows/${g.flowId}`)).state).toBe('ready')
  // a Gmail return with another address: the same
  await setUpGmail(); ownEmail('olga@team.example')
  const m = await owner.call('POST', gmail + '/authorize', {})
  await owner.raw('GET', gmailReturn(google.authorize(m.authorizationUrl, 'mallory')))
  expect((await owner.call('GET', `${gmail}/flows/${m.flowId}`)).state).toBe('ready')
  // case and spaces aside, the person's own address connects at once
  ownEmail(' Olga@Acme.Example ')
  const o = await owner.call('POST', gmail + '/authorize', {})
  await owner.raw('GET', gmailReturn(google.authorize(o.authorizationUrl, 'olga')))
  expect((await owner.call('GET', `${gmail}/flows/${o.flowId}`)).state).toBe('completed')
})

test('never at once: a Drive share, a Google app\'s team account, a Gmail return from another session of the person', async () => {
  await setUpGmail()
  // a Drive share (the admin names it), with the admin's own address
  ownEmail('alice@example.test')
  const s = await owner.call('POST', '/api/admin/google-drive/shares/authorize', {})
  const sp = await owner.raw('GET', cb(drive, fake.authorize(s.authorizationUrl)))
  expect(sp.status).toBe(200); expect(await sp.text()).toContain('원래 탭으로 돌아가')
  expect(h.ctx.db.query('SELECT state FROM drive_oauth_flows WHERE id=?').get(s.flowId)).toEqual({ state: 'ready' })
  // Gmail's team account (an admin's choice), with the admin's own address
  ownEmail('olga@acme.example')
  const t = await owner.call('POST', '/api/admin/google-apps/gmail/team/authorize', {})
  const tp = await owner.raw('GET', gmailReturn(google.authorize(t.authorizationUrl, 'olga')))
  expect(tp.status).toBe(200); expect(await tp.text()).toContain('원래 탭으로 돌아가')
  expect(h.ctx.db.query('SELECT state FROM google_app_flows WHERE id=?').get(t.flowId)).toEqual({ state: 'ready' })
  // Gmail brought back by another session of the same person (own address): the first tab confirms
  const g = await owner.call('POST', gmail + '/authorize', {})
  const other = await login('olga', OWNER_PW, 'web')
  const gp = await other.raw('GET', gmailReturn(google.authorize(g.authorizationUrl, 'olga')))
  expect(gp.status).toBe(200); expect(await gp.text()).toContain('원래 탭으로 돌아가')
  expect((await owner.call('GET', `${gmail}/flows/${g.flowId}`)).state).toBe('ready')
})

test('the "Connected" page and the held page in every language', () => {
  expect(googleReturnOf({ ok: true, done: 'completed' }, true)).toBe('done')
  expect(googleReturnOf({ ok: true, done: 'ready' }, true)).toBe('ok')
  const t = 'Q'.repeat(43)
  for (const L of LOCALES) {
    const d = googleReturnPage('done', L, { app: 'desktop', origin: 'https://acme.trina.app' })
    expect(d.status).toBe(200); expect(d.html).not.toContain('{product}'); expect(d.html).not.toContain('#code=')
    expect(d.html).toContain('trina-ax://open?url=')
    const held = googleReturnPage('ok', L, { app: 'desktop', origin: 'https://acme.trina.app', code: t })
    expect(held.html).toContain(`<meta http-equiv="refresh" content="0;url=trina-ax://open?url=https%3A%2F%2Facme.trina.app%2F#code=${t}">`)
    expect(held.html).not.toContain('{product}')
    if (L !== 'en') expect(d.html).not.toBe(googleReturnPage('done', 'en', { app: 'desktop', origin: 'https://acme.trina.app' }).html)
  }
  // a plain browser's "Connected": no app button
  expect(googleReturnPage('done', 'en').html).not.toContain('trina-ax://')
})

test('a Google app\'s refusal at the claim address is a plain refusal, never a 500, and ends the held result (an admin who is no longer one)', async () => {
  await setUpGmail()
  const ADAM_PW = 'harbor kite violet 9'
  await addMember(h, owner, { username: 'adam', role: 'admin', password: ADAM_PW })
  const adminApp = await login('adam', ADAM_PW, 'desktop')
  const f = await adminApp.call('POST', '/api/admin/google-apps/gmail/team/authorize', {})
  const code = codeOf(await (await bare(gmailReturn(google.authorize(f.authorizationUrl, 'adam')))).text())!
  expect(code).toBeTruthy()
  h.ctx.db.query("UPDATE users SET role='member' WHERE username='adam'").run()
  const r = await claim(adminApp, code)
  expect(r.status).toBe(403); expect(r.body.error.params.reason).toBe('access_denied')
  const row = h.ctx.db.query('SELECT state, secret_enc FROM google_app_flows WHERE id=?').get(f.flowId) as { state: string; secret_enc: string | null }
  expect(row).toEqual({ state: 'failed', secret_enc: null })
  // the code is gone with it
  expect((await claim(adminApp, code)).status).toBe(400)
})

test('one waiter per sign-in: a third return while another waits gets the "almost done" page at once', async () => {
  await setUpGmail(); ownEmail('olga@acme.example')
  const f = await owner.call('POST', gmail + '/authorize', {})
  const url = gmailReturn(google.authorize(f.authorizationUrl, 'olga'))
  let open!: () => void
  gate = new Promise((r) => { open = r })
  const first = owner.raw('GET', url) // takes the sign-in, waits for Google
  await Bun.sleep(50)
  const waiter = owner.raw('GET', url) // waits for the first
  await Bun.sleep(50)
  const t0 = Date.now()
  const third = await owner.raw('GET', url) // answered at once, while Google still has not answered
  expect(Date.now() - t0).toBeLessThan(1000)
  expect(third.status).toBe(200); expect(await third.text()).not.toContain(EXPIRED)
  open()
  for (const p of await Promise.all([first, waiter])) expect(p.status).toBe(200)
  expect((await owner.call('GET', `${gmail}/flows/${f.flowId}`)).state).toBe('completed')
})

test('results that will never be used are revoked at Google (cancelled, replaced, run out), unless that would end a live sign-in', async () => {
  await setUpGmail()
  const desk = await login('olga', OWNER_PW, 'desktop')
  const held = async () => {
    const f = await desk.call('POST', gmail + '/authorize', {})
    expect(codeOf(await (await bare(gmailReturn(google.authorize(f.authorizationUrl, 'olga')))).text())).toBeTruthy()
    return f
  }
  const tick = () => Bun.sleep(30)
  // cancelled in the app
  let f = await held(), before = google.revoked.length
  await desk.call('DELETE', `${gmail}/flows/${f.flowId}`)
  await tick(); expect(google.revoked.length).toBe(before + 1)
  // replaced by Try again
  f = await held(); before = google.revoked.length
  await desk.call('POST', gmail + '/authorize', {})
  await tick(); expect(google.revoked.length).toBe(before + 1)
  // run out
  f = await held(); before = google.revoked.length
  h.ctx.db.query("UPDATE google_app_flows SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.flowId)
  googleAppsOf(h.ctx).sweep()
  await tick(); expect(google.revoked.length).toBe(before + 1)
  // the person keeps a Google sign-in here (Gmail connected): a dropped result is not revoked (Google ends a whole grant)
  f = await desk.call('POST', gmail + '/authorize', {})
  await owner.raw('GET', gmailReturn(google.authorize(f.authorizationUrl, 'olga')))
  expect((await desk.call('POST', `${gmail}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
  f = await held(); before = google.revoked.length
  await desk.call('DELETE', `${gmail}/flows/${f.flowId}`)
  await tick(); expect(google.revoked.length).toBe(before)
})

test('Drive: a dropped result is not revoked while the person keeps a live Drive connection', async () => {
  const desk = await login('olga', OWNER_PW, 'desktop')
  let f = await desk.call('POST', drive + '/authorize', {})
  await desk.raw('GET', cb(drive, fake.authorize(f.authorizationUrl)))
  expect((await desk.call('POST', `${drive}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
  f = await desk.call('POST', drive + '/authorize', {})
  expect(codeOf(await (await bare(cb(drive, fake.authorize(f.authorizationUrl)))).text())).toBeTruthy()
  fake.revoked = false
  await desk.call('DELETE', `${drive}/flows/${f.flowId}`)
  await Bun.sleep(30)
  expect(fake.revoked).toBe(false)
  expect((await desk.call('GET', drive)).status).toBe('connected')
})

test('the confirm step marks a Google account that is not the person\'s own sign-in email', () => {
  expect(notOwnEmail('Mallory@Evil.test', 'olga@acme.test')).toBe(true)
  expect(notOwnEmail(' OLGA@acme.test', 'olga@acme.test')).toBe(false)
  expect(notOwnEmail('olga@gmail.com', null)).toBe(false)
  expect(notOwnEmail(null, 'olga@acme.test')).toBe(false)
})

test('a team made in the desktop app gets a desktop session (the setup page says which app it runs in); a browser\'s stays "web"', async () => {
  const sessionKind = (c: Client) => c.call('GET', '/api/me').then((m: any) => m.session?.client ?? m.me?.session?.client)
  expect(await sessionKind(owner)).toBe('web')
  const h2 = await harness('google-connect-finish-setup-' + seq)
  try {
    const c = h2.client()
    await c.call('POST', '/api/setup', { setupToken: SETUP_TOKEN, teamName: 'Acme', locale: 'ko', owner: { username: 'olga', name: 'Olga Owner', password: OWNER_PW }, client: 'desktop' })
    expect(await sessionKind(c)).toBe('desktop')
  } finally { await h2.close() }
})

test('a phone app\'s session that says "desktop" at the start stays the phone\'s: no app code, no page before Google', async () => {
  await setUpGmail()
  const phone = h.client()
  await phone.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, client: 'mobile', tokenMode: 'bearer' })
  const d = await phone.call('POST', drive + '/authorize', { client: 'desktop' })
  expect(d.openPath).toBeUndefined()
  const g = await phone.call('POST', gmail + '/authorize', { client: 'desktop' })
  for (const url of [cb(drive, fake.authorize(d.authorizationUrl)), gmailReturn(google.authorize(g.authorizationUrl, 'olga'))]) {
    expect(codeOf(await (await bare(url)).text())).toBeNull()
  }
})
