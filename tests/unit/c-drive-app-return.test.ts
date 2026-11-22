// A Google Drive sign-in started in the desktop app, answered by Google in a system browser that is not signed in
// (server/src/integrations/google-drive/app-return.ts; owner's QA 2026-11-20; security review of #98). The browser does
// not finish it: the server keeps the result sealed and still "waiting", and the page hands a one-time code to the app
// on THAT computer, in the link's fragment. Only the session that started the flow can redeem it.
//
// The attack the review found (any member, or a `client: 'desktop'` login made with curl, phishes a victim into
// Google's consent) must FAIL to connect: (A) the victim's browser has no session, (B) it is signed in as the victim.
// Fake Google only.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { harness, withOwner, addMember, OWNER_PW, type Harness, type Client } from './a-lib'
import { googleDriveOf, type GoogleDrive } from '../../server/src/integrations/google-drive/oauth'
import { CLAIM_MS, GO_PATH, appLink, tokenMatches, tokenHash } from '../../server/src/integrations/google-drive/app-return'
import { googleReturnPage, GOOGLE_RETURN_CSP } from '../../server/src/integrations/google-drive/callback-page'
import { FakeGoogleDrive, DRIVE_CONFIG } from '../lib/fake-google-drive'
import { isShownTeamStart, signInCode } from '../../desktop/src/common/address'
import { desktopOpenUrl } from '../../web/src/lib/driveSignIn'

let h: Harness, owner: Client, svc: GoogleDrive, fake: FakeGoogleDrive, seq = 0
const base = '/api/integrations/google-drive'
const BOB_PW = 'river stone lamp 7'
beforeEach(async () => {
  h = await harness('drive-app-return-' + ++seq); owner = await withOwner(h)
  await addMember(h, owner, { username: 'bob', password: BOB_PW })
  fake = new FakeGoogleDrive(); svc = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch, now: () => fake.now })
})
afterEach(async () => { await h?.close() })

/** a session as an app makes it — or as anyone with curl may: the login says which app it is */
async function session(username: string, password: string, client: 'desktop' | 'mobile' | 'web') {
  const c = h.client()
  await c.call('POST', '/api/auth/login', { username, password, client, tokenMode: client === 'mobile' ? 'bearer' : 'cookie' })
  return c
}
/** a system browser with no session at all */
const bare = (path: string) => h.fetch(path, { ip: '10.0.0.9' })
const cbUrl = (q: { state: string; code: string }) => `${base}/callback?${new URLSearchParams(q)}`
/** the one-time code on a return page: only ever in the app link's fragment */
function codeOf(html: string): string | null {
  const m = /href="trina-ax:\/\/open\?url=[^"#]+#code=([A-Za-z0-9_-]{43})"/.exec(html)
  return m ? m[1]! : null
}
const claim = (c: Client, code: string) => c.try('POST', base + '/claim', { code })
const driveStatus = async (c: Client) => (await c.call('GET', base)).status

test('the desktop app: the page before Google names the person; Google answered without a session; the app\'s own session finishes with the code', async () => {
  const desk = await session('olga', OWNER_PW, 'desktop')
  const f = await desk.call('POST', base + '/authorize', {})
  expect(f.openPath).toMatch(/^\/api\/integrations\/google-drive\/go\?flow=[A-Za-z0-9_-]+&k=[A-Za-z0-9_-]{43}$/)
  expect(desktopOpenUrl(f, 'https://acme.trina.app')).toBe(`https://acme.trina.app${f.openPath}`)
  // before Google: whose Trina gets the Drive, then on to the sign-in page (it may be opened again)
  for (let i = 0; i < 2; i++) {
    const go = await bare(f.openPath)
    const html = await go.text()
    expect(go.status).toBe(200)
    expect(go.headers.get('content-security-policy')).toBe(GOOGLE_RETURN_CSP)
    expect(html).toContain('Olga Owner(olga) 님의')
    expect(html).toContain(`href="${f.authorizationUrl.replace(/&/g, '&#38;')}"`)
    expect(go.headers.getSetCookie()).toEqual([])
  }
  // a wrong key shows nothing about the flow
  const wrong = await bare(`${GO_PATH}?flow=${f.flowId}&k=${'A'.repeat(43)}`)
  expect(wrong.status).toBe(400); expect(await wrong.text()).not.toContain('olga')

  // Google answers in the system browser, which has no session: the result waits, the code goes to the app link
  const page = await bare(cbUrl(fake.authorize(f.authorizationUrl, 'alice')))
  const html = await page.text()
  expect(page.status).toBe(200)
  const code = codeOf(html)!
  expect(code).toBeTruthy()
  // the code never in a query string, nor anywhere but the app link's fragment: the button and the page's own opening
  // of that same link (it opens the app without the button)
  expect(html.split(code).length - 1).toBe(2)
  expect(html).toMatch(new RegExp(`<meta http-equiv="refresh" content="0;url=trina-ax://open\\?url=[^"#]+#code=${code}">`))
  expect(html).not.toMatch(new RegExp(`[?&]code=${code}`))
  expect(html).toContain('앱으로 돌아가기')
  // whose Trina account and which Google account, and keep the link to yourself
  expect(html).toContain('연결할 Trina AX 계정: Olga Owner (@olga)')
  expect(html).toContain('Google 계정: alice@example.test')
  expect(html).toContain('이 링크는 내 Trina AX 앱에서만 여세요. 다른 사람에게 보내지 마세요.')
  // plain "pending" to the app, no account shown until the code comes back
  let flow = await desk.call('GET', `${base}/flows/${f.flowId}`)
  expect(flow.state).toBe('pending'); expect(flow.account).toBeNull()
  // the desktop app reads the code from the link, for the team it shows, and posts it with its own session
  expect(signInCode(appLink('https://acme.trina.app', code), 'https://acme.trina.app')).toBe(code)
  const r = await claim(desk, code)
  expect(r.status).toBe(200); expect(r.body.state).toBe('ready'); expect(r.body.account.email).toBeTruthy()
  // used up
  expect((await claim(desk, code)).status).toBe(400)
  flow = await desk.call('GET', `${base}/flows/${f.flowId}`)
  expect(flow.state).toBe('ready')
  expect((await desk.call('POST', `${base}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
})

test('ATTACK (A): a curl "desktop" login phishes a victim whose browser has no session: the victim\'s Drive never connects to the attacker', async () => {
  // any member can say it is the desktop app
  const attacker = await session('bob', BOB_PW, 'desktop')
  const f = await attacker.call('POST', base + '/authorize', {})
  // the victim opens the attacker's page: it names the attacker, not the victim
  expect(await (await bare(f.openPath)).text()).toContain('BOB(bob) 님의')
  // the victim consents at Google in a browser with no session
  const html = await (await bare(cbUrl(fake.authorize(f.authorizationUrl, 'alice')))).text()
  const code = codeOf(html)!
  // the return page says it joins bob's account, not the victim's
  expect(html).toContain('BOB (@bob)')
  // the attacker sees nothing: still waiting, no account
  const seen = await attacker.call('GET', `${base}/flows/${f.flowId}`)
  expect(seen.state).toBe('pending'); expect(seen.account).toBeNull()
  // the code goes to the victim's own computer: the victim's desktop app (her session) cannot finish the attacker's flow
  const victimApp = await session('olga', OWNER_PW, 'desktop')
  expect((await claim(victimApp, code)).status).toBe(400)
  // the attacker has no code; a guess does nothing
  expect((await claim(attacker, 'B'.repeat(43))).status).toBe(400)
  // the attacker cannot confirm ("맞아요") either: the flow never became ready
  const done = await attacker.try('POST', `${base}/flows/${f.flowId}/complete`, {})
  expect(done.status).toBe(409)
  expect(await driveStatus(attacker)).toBe('disconnected')
  expect(await driveStatus(victimApp)).toBe('disconnected')
  // it ends by itself
  fake.now += CLAIM_MS + 1
  expect((await claim(attacker, code)).status).toBe(400)
  expect(await driveStatus(attacker)).toBe('disconnected')
})

test('ATTACK (B): the victim\'s browser is signed in as the victim: refused as before, nothing waits, no code', async () => {
  const attacker = await session('bob', BOB_PW, 'desktop')
  const f = await attacker.call('POST', base + '/authorize', {})
  const p = await owner.raw('GET', cbUrl(fake.authorize(f.authorizationUrl, 'alice')))
  const html = await p.text()
  expect(p.status).toBe(400)
  expect(html).toContain('다른 사람의 계정으로')
  expect(codeOf(html)).toBeNull(); expect(html).not.toContain('#code=')
  expect((await attacker.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('pending')
  expect(await driveStatus(attacker)).toBe('disconnected')
})

test('the code: another session of the same person cannot use it, a late one ends the flow, a browser signed in as the person still finishes at once', async () => {
  const desk1 = await session('olga', OWNER_PW, 'desktop'), desk2 = await session('olga', OWNER_PW, 'desktop')
  let f = await desk1.call('POST', base + '/authorize', {})
  let code = codeOf(await (await bare(cbUrl(fake.authorize(f.authorizationUrl)))).text())!
  expect((await claim(desk2, code)).status).toBe(400)
  expect((await desk1.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('pending')
  // late
  fake.now += CLAIM_MS + 1
  const late = await claim(desk1, code)
  expect(late.status).toBe(400); expect(late.body.error.message).toContain('이 로그인 링크는 만료됐거나'); expect(late.body.error.message).not.toContain('drive_')
  expect((await desk1.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('failed')
  // the same person signed in in that browser: ready at once, no code
  f = await desk1.call('POST', base + '/authorize', {})
  const p = await desk1.raw('GET', cbUrl(fake.authorize(f.authorizationUrl)))
  const html = await p.text()
  expect(p.status).toBe(200); expect(codeOf(html)).toBeNull()
  expect(html).toContain('연결됐어요'); expect(html).toContain('trina-ax://open?url=')
  expect((await desk1.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('ready')
  void code
})

test('a browser\'s or the phone app\'s sign-in: no code, no page before Google; a browser without a session gets a way on', async () => {
  const web = await owner.call('POST', base + '/authorize', {})
  expect(web.openPath).toBeUndefined()
  let html = await (await bare(cbUrl(fake.authorize(web.authorizationUrl)))).text()
  expect(codeOf(html)).toBeNull()
  expect(html).toMatch(/이 브라우저는 .+에 로그인되어 있지 않아요/)
  expect(html).toContain('href="/login?next=%2Fsettings%2Fconnectors%2Fgoogle-drive"')
  expect(html).not.toContain('trina-ax://')
  const phone = await session('olga', OWNER_PW, 'mobile')
  const pf = await phone.call('POST', base + '/authorize', {})
  expect(pf.openPath).toBeUndefined()
  html = await (await bare(cbUrl(fake.authorize(pf.authorizationUrl)))).text()
  expect(codeOf(html)).toBeNull()
  expect(html).toContain('이 창에서는 연결을 마치지 못했어요')
  // a cancelled desktop flow's page before Google shows nothing
  const desk = await session('olga', OWNER_PW, 'desktop')
  const f = await desk.call('POST', base + '/authorize', {})
  await desk.call('DELETE', `${base}/flows/${f.flowId}`)
  const gone = await bare(f.openPath)
  expect(gone.status).toBe(400)
  expect(await gone.text()).toContain('취소') // a cancel says so; a wrong key or a late flow says "expired or already used"
  expect(await (await bare(`${GO_PATH}?flow=nope&k=${'A'.repeat(43)}`)).text()).toContain('시간이 지났거나 이미 사용됐어요')
  // the claim of an unknown code says it in words, never the raw code
  const bad = await claim(desk, 'Z'.repeat(43))
  expect(bad.status).toBe(400); expect(bad.body.error.message).not.toContain('drive_')
})

test('the pieces: tokens by hash, the app link, the desktop link checks', () => {
  const t = 'Q'.repeat(43)
  expect(tokenMatches(t, tokenHash(t))).toBe(true)
  expect(tokenMatches('R'.repeat(43), tokenHash(t))).toBe(false)
  expect(tokenMatches(undefined, tokenHash(t))).toBe(false)
  expect(appLink('https://acme.trina.app')).toBe('trina-ax://open?url=https%3A%2F%2Facme.trina.app%2F')
  expect(appLink('https://acme.trina.app', t)).toBe(`trina-ax://open?url=https%3A%2F%2Facme.trina.app%2F#code=${t}`)
  // the window comes forward for the team it shows, and only that one
  expect(isShownTeamStart(appLink('https://acme.trina.app'), 'https://acme.trina.app')).toBe(true)
  expect(isShownTeamStart(appLink('https://acme.trina.app'), 'https://other.trina.app')).toBe(false)
  expect(isShownTeamStart('trina-ax://open?url=https%3A%2F%2Facme.trina.app%2Fc%2Fx', 'https://acme.trina.app')).toBe(false)
  // the code only from the fragment, only for the team on screen
  expect(signInCode(appLink('https://acme.trina.app', t), 'https://other.trina.app')).toBeNull()
  expect(signInCode(`trina-ax://open?url=https%3A%2F%2Facme.trina.app%2F%3Fcode%3D${t}`, 'https://acme.trina.app')).toBeNull()
  expect(signInCode(`${appLink('https://acme.trina.app')}#code=short`, 'https://acme.trina.app')).toBeNull()
  // no desktop button on anything but a plain origin
  expect(googleReturnPage('ok', 'en', { app: 'desktop', origin: 'javascript:alert(1)', code: t }).html).not.toContain('trina-ax://')
})

const tick = () => new Promise((r) => setTimeout(r, 20))
const revokes = () => fake.calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke') || c.url.includes('/revoke')).length

test('tokens that will never be used are revoked at Google: a late code, a cancel, a result never confirmed, a replaced one', async () => {
  const desk = await session('olga', OWNER_PW, 'desktop')
  // a held result whose code comes too late
  let f = await desk.call('POST', base + '/authorize', {})
  let code = codeOf(await (await bare(cbUrl(fake.authorize(f.authorizationUrl)))).text())!
  let before = revokes()
  fake.now += CLAIM_MS + 1
  expect((await claim(desk, code)).status).toBe(400)
  await tick(); expect(revokes()).toBe(before + 1)
  // a held result cancelled in the app
  f = await desk.call('POST', base + '/authorize', {})
  code = codeOf(await (await bare(cbUrl(fake.authorize(f.authorizationUrl)))).text())!
  before = revokes()
  await desk.call('DELETE', `${base}/flows/${f.flowId}`)
  await tick(); expect(revokes()).toBe(before + 1)
  // a held result never claimed: its flow runs out
  f = await desk.call('POST', base + '/authorize', {})
  codeOf(await (await bare(cbUrl(fake.authorize(f.authorizationUrl)))).text())
  before = revokes()
  fake.now += 10 * 60_000 + 1
  expect((await desk.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('expired')
  await tick(); expect(revokes()).toBe(before + 1)
  // a ready result never confirmed ("맞아요" never pressed): runs out, or is replaced by a new sign-in
  f = await desk.call('POST', base + '/authorize', {})
  await desk.raw('GET', cbUrl(fake.authorize(f.authorizationUrl)))
  expect((await desk.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('ready')
  before = revokes()
  fake.now += 10 * 60_000 + 1
  await desk.call('GET', `${base}/flows/${f.flowId}`)
  await tick(); expect(revokes()).toBe(before + 1)
  f = await desk.call('POST', base + '/authorize', {})
  await desk.raw('GET', cbUrl(fake.authorize(f.authorizationUrl)))
  before = revokes()
  await desk.call('POST', base + '/authorize', {})
  await tick(); expect(revokes()).toBe(before + 1)
  // a ready result cancelled
  f = await desk.call('POST', base + '/authorize', {})
  await desk.raw('GET', cbUrl(fake.authorize(f.authorizationUrl)))
  before = revokes()
  await desk.call('DELETE', `${base}/flows/${f.flowId}`)
  await tick(); expect(revokes()).toBe(before + 1)
  // a confirmed one is not revoked
  f = await desk.call('POST', base + '/authorize', {})
  await desk.raw('GET', cbUrl(fake.authorize(f.authorizationUrl)))
  before = revokes()
  await desk.call('POST', `${base}/flows/${f.flowId}/complete`, {})
  await tick(); expect(revokes()).toBe(before)
})

test('the held page in every language: whose account, which Google account, keep the link to yourself', () => {
  const t = 'Q'.repeat(43)
  const en = googleReturnPage('ok', 'en', { app: 'desktop', origin: 'https://acme.trina.app', code: t, who: { name: 'Olga $& Owner', username: 'olga' }, google: 'olga@example.test' }).html
  expect(en).toContain('account it joins: Olga $&#38; Owner (@olga)')
  expect(en).toContain('Google account: olga@example.test')
  expect(en).toContain('Open this link only in your own')
  for (const L of ['ko', 'id', 'ja', 'es', 'zh'] as const) {
    const h = googleReturnPage('ok', L, { app: 'desktop', origin: 'https://acme.trina.app', code: t, who: { name: 'Olga', username: 'olga' }, google: 'g@example.test' }).html
    expect(h).toContain('@olga'); expect(h).toContain('g@example.test'); expect(h).not.toContain('{product}')
    expect(h).not.toContain('Open this link only')
  }
})

test('a team Drive share started in the desktop app finishes the same way: held, the code, the claim, the share dialog\'s poll sees the account (owner 2026-11-22)', async () => {
  const desk = await session('olga', OWNER_PW, 'desktop')
  const f = await desk.call('POST', '/api/admin/google-drive/shares/authorize', {})
  expect(desktopOpenUrl(f, 'https://acme.trina.app')).toBe(`https://acme.trina.app${f.openPath}`)
  const page = await bare(cbUrl(fake.authorize(f.authorizationUrl, 'alice')))
  const code = codeOf(await page.text())!
  expect(code).toBeTruthy()
  expect((await desk.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('pending')
  expect(signInCode(appLink('https://acme.trina.app', code), 'https://acme.trina.app')).toBe(code)
  const r = await claim(desk, code)
  expect(r.status).toBe(200); expect(r.body.state).toBe('ready')
  const flow = await desk.call('GET', `${base}/flows/${f.flowId}`)
  expect(flow.state).toBe('ready'); expect(flow.account.email).toBe('alice@example.test')
  const share = await desk.call('POST', `/api/admin/google-drive/shares/flows/${f.flowId}/complete`, { name: 'Company Drive' })
  expect(share.name).toBe('Company Drive')
})
