// The page Google sends the browser back to after a Google sign-in (server/src/integrations/google-drive/callback-page.ts,
// routes/drive.ts, routes/google-apps.ts; QA TC-2956, TC-2978, TC-2979): in the person's language (the session's, else
// the anonymous locale), with the real reason and one next step, never "received" before the account is confirmed in
// the app, and static words with a same-origin link only. Fake Google only.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { harness, withOwner, addMember, type Harness, type Client } from './a-lib'
import { googleDriveOf, type GoogleDrive } from '../../server/src/integrations/google-drive/oauth'
import { googleReturnOf, googleReturnPage, type GoogleReturn } from '../../server/src/integrations/google-drive/callback-page'
import { FakeGoogleDrive, DRIVE_CONFIG, membersMayConnect } from '../lib/fake-google-drive'
import { LOCALE_ORDER as LOCALES } from '../../shared/src/api'

let h: Harness, c: Client, other: Client, svc: GoogleDrive, fake: FakeGoogleDrive, seq = 0
const base = '/api/integrations/google-drive'
beforeEach(async () => {
  h = await harness('google-return-' + ++seq); c = await withOwner(h); other = (await addMember(h, c, { username: 'bob', role: 'member' })).client
  fake = new FakeGoogleDrive(); svc = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch, now: () => fake.now }); membersMayConnect(h.ctx.db)
})
afterEach(async () => { await h?.close() })

const cbUrl = (q: Record<string, string>) => `${base}/callback?${new URLSearchParams(q)}`
async function page(res: Response) { return { status: res.status, html: await res.text() } }

test('reasons map to plain pages; "browser_session_required" tells signed-out from someone else', () => {
  const cases: [string, boolean, GoogleReturn][] = [
    ['consent_denied', true, 'cancelled'], ['consent_denied_service', true, 'denied_service'], ['scope_denied', true, 'scope'],
    ['invalid_flow', true, 'expired'], ['expired', true, 'expired'], ['browser_session_required', false, 'signed_out'],
    ['browser_session_required', true, 'other_account'], ['provider_unavailable', true, 'failed'], ['anything_else', true, 'failed'],
  ]
  for (const [reason, signedIn, want] of cases) expect(googleReturnOf({ ok: false, reason }, signedIn)).toBe(want)
  expect(googleReturnOf({ ok: true }, true)).toBe('ok')
  // every page in every language: its own words, no code, the sign-in link only where signing in is the fix
  const all: GoogleReturn[] = ['ok', 'cancelled', 'denied_service', 'scope', 'expired', 'signed_out', 'other_account', 'failed']
  for (const L of LOCALES) for (const r of all) {
    const p = googleReturnPage(r, L)
    expect(p.status).toBe(r === 'ok' ? 200 : 400)
    expect(p.html).toContain(`<html lang="${L}">`)
    expect(p.html).not.toMatch(/received|consent_denied|scope_denied|\{product\}/)
    expect(/href="\/login/.test(p.html)).toBe(r === 'signed_out' || r === 'other_account')
    // a browser not signed in: sign in and connect here (the connector's page after the sign-in), not a bare line
    if (r === 'signed_out') expect(p.html).toContain('href="/login?next=%2Fsettings%2Fconnectors"')
    if (L !== 'en') expect(p.html).not.toBe(googleReturnPage(r, 'en').html)
  }
})

test('Drive: the return page in the person\'s language with the real reason; success says to confirm in the app', async () => {
  h.ctx.db.query("UPDATE users SET locale='ko' WHERE username='olga'").run()
  // this server's own Google client (a company's own app): no "unverified app" line
  expect((await c.call('GET', base)).hostedApp).toBe(false)
  // cancelled at Google
  let f = await c.call('POST', base + '/authorize', {})
  let cb = fake.authorize(f.authorizationUrl)
  let p = await page(await c.raw('GET', cbUrl({ state: cb.state, error: 'access_denied' })))
  expect(p.status).toBe(400)
  expect(p.html).toContain('<html lang="ko">')
  expect(p.html).toContain('Google 로그인을 취소해서 연결하지 않았어요')
  expect(p.html).not.toContain('href="/login"')
  expect((await c.call('GET', `${base}/flows/${f.flowId}`)).reason).toBe('consent_denied')
  // the same link again: expired or used
  p = await page(await c.raw('GET', cbUrl({ state: cb.state, error: 'access_denied' })))
  expect(p.html).toContain('시간이 지났거나 이미 사용됐어요')
  // a permission not ticked
  fake.scope = 'https://www.googleapis.com/auth/drive.file'
  f = await c.call('POST', base + '/authorize', {}); cb = fake.authorize(f.authorizationUrl)
  p = await page(await c.raw('GET', cbUrl(cb)))
  expect(p.html).toContain('일부 권한에 체크하지 않아서')
  fake.scope = 'https://www.googleapis.com/auth/drive.readonly'
  // the time ran out
  f = await c.call('POST', base + '/authorize', {}); cb = fake.authorize(f.authorizationUrl); fake.now += 600_001
  p = await page(await c.raw('GET', cbUrl(cb)))
  expect(p.html).toContain('시간이 지났거나')
})

test('Drive: a browser not signed in (the desktop app\'s system browser) or signed in as someone else gets what to do', async () => {
  const f = await c.call('POST', base + '/authorize', {}), cb = fake.authorize(f.authorizationUrl)
  // nobody signed in: the language the sign-in screen picked (else the team default)
  let p = await page(await h.fetch(cbUrl(cb), { headers: { 'x-mycel-locale': 'ko' } }))
  expect(p.status).toBe(400)
  expect(p.html).toContain('<html lang="ko">')
  expect(p.html).toMatch(/이 브라우저는 .+에 로그인되어 있지 않아요/)
  expect(p.html).toContain('href="/login?next=%2Fsettings%2Fconnectors%2Fgoogle-drive"')
  // someone else signed in here (in that person's language)
  h.ctx.db.query("UPDATE users SET locale='en' WHERE username IN ('olga','bob')").run()
  p = await page(await other.raw('GET', cbUrl(cb)))
  expect(p.html).toContain('<html lang="en">')
  expect(p.html).toContain('as someone else')
  // the flow is still open: the browser of the session that started it finishes it right here (no second trip to the
  // first tab), and the page says so; never "the app" in a browser
  p = await page(await c.raw('GET', cbUrl(cb)))
  expect(p.status).toBe(200)
  expect(p.html).toContain('<h1>Connected</h1>')
  expect(p.html).toContain('close this tab and go back to the first one')
  expect(p.html).not.toMatch(/received|the .* app/)
  expect((await c.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('completed')
  expect((await c.call('GET', base)).status).toBe('connected')
})

test('Drive: 20 sign-ins started in an hour: its own reason in the refusal, which the app words as "about an hour" (QA TC-3034)', async () => {
  for (let k = 0; k < 20; k++) await c.call('POST', base + '/authorize', {})
  const r = await c.raw('POST', base + '/authorize', {})
  expect(r.status).toBe(429)
  expect((await r.json()).error.message).toBe('drive_signin_limit')
})

test('a browser sign-in that still waits for its confirm (a Drive share, a team account) points to the first tab, never "the app" (Windows QA 2026-11-28)', () => {
  const ko = googleReturnPage('ok', 'ko').html
  expect(ko).toContain('원래 탭으로 돌아가 ‘이 계정 연결’을 누르세요')
  expect(ko).not.toContain('앱으로')
  for (const l of LOCALES) {
    const { html, status } = googleReturnPage('ok', l)
    expect(status).toBe(200)
    expect(html).not.toMatch(/\bapp\b|アプリ|aplikasi|aplicación|应用|앱/)
  }
  // started in the desktop app: the app is still named
  expect(googleReturnPage('ok', 'ko', { app: 'desktop', origin: 'https://team.example' }).html).toContain('앱으로 돌아가세요')
  // connected in this tab
  expect(googleReturnOf({ ok: true, done: 'connected' }, true)).toBe('connected')
  expect(googleReturnPage('connected', 'ko').html).toContain('연결됐어요')
})
