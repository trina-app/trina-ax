// A Google Drive sign-in started in the desktop app finishes in the system browser, which is not signed in
// (server/src/integrations/google-drive/app-browser.ts; owner's QA 2026-11-20: the browser ended on "This browser is not
// signed in to Trina AX" and the app waited forever). The app opens a one-time address first; that browser then
// finishes the flow by its cookie, and the last page says to go back to the app (with the app's link), never the web
// app. Nothing else gets in: a used, late or unknown ticket, another flow's cookie, a browser with no cookie and no
// session. A sign-in started in a browser keeps today's page. Fake Google only.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { harness, withOwner, addMember, OWNER_PW, type Harness, type Client } from './a-lib'
import { googleDriveOf, type GoogleDrive } from '../../server/src/integrations/google-drive/oauth'
import { AppSignIns, BIND_COOKIE, OPEN_PATH, TICKET_MS, bindCookie, cookieValue } from '../../server/src/integrations/google-drive/app-browser'
import { backToAppHref, googleReturnPage, GOOGLE_RETURN_CSP } from '../../server/src/integrations/google-drive/callback-page'
import { FakeGoogleDrive, DRIVE_CONFIG } from '../lib/fake-google-drive'
import { isShownTeamStart } from '../../desktop/src/common/address'
import { desktopOpenUrl } from '../../web/src/lib/driveSignIn'

let h: Harness, owner: Client, svc: GoogleDrive, fake: FakeGoogleDrive, seq = 0
const base = '/api/integrations/google-drive'
beforeEach(async () => {
  h = await harness('drive-app-browser-' + ++seq); owner = await withOwner(h)
  fake = new FakeGoogleDrive(); svc = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch, now: () => fake.now })
})
afterEach(async () => { await h?.close() })

/** the owner signed in again as the desktop or phone app does (its own session kind) */
async function appSession(client: 'desktop' | 'mobile' | 'web') {
  const c = h.client()
  await c.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, client, tokenMode: client === 'mobile' ? 'bearer' : 'cookie' })
  return c
}
/** the system browser: no session, only what it was given */
const browser = (path: string, cookie?: string) => h.fetch(path, { headers: cookie ? { cookie } : {}, ip: '10.0.0.9' })
const cbUrl = (q: { state: string; code: string }) => `${base}/callback?${new URLSearchParams(q)}`
const setCookie = (r: Response) => r.headers.getSetCookie().find((x) => x.startsWith(`${BIND_COOKIE}=`)) ?? ''
const cookieOf = (sc: string) => sc.split(';')[0]!

test('desktop: the one-time address gives the system browser a cookie, then Google; that browser finishes; the page says go back to the app', async () => {
  const desk = await appSession('desktop')
  const f = await desk.call('POST', base + '/authorize', {})
  expect(f.openPath).toMatch(/^\/api\/integrations\/google-drive\/open\?flow=[A-Za-z0-9_-]+&t=[A-Za-z0-9_-]{43}$/)
  // the web takes exactly that shape on its own origin
  expect(desktopOpenUrl(f, 'https://acme.trina.app')).toBe(`https://acme.trina.app${f.openPath}`)
  expect(desktopOpenUrl({ openPath: '/elsewhere?flow=a&t=b' }, 'https://acme.trina.app')).toBeNull()
  expect(desktopOpenUrl({}, 'https://acme.trina.app')).toBeNull()

  const open = await browser(f.openPath)
  expect(open.status).toBe(302)
  expect(open.headers.get('location')).toBe(f.authorizationUrl)
  const sc = setCookie(open)
  expect(sc).toContain(`Path=${base}/callback`); expect(sc).toContain('HttpOnly'); expect(sc).toContain('SameSite=Lax')
  // once only
  const again = await browser(f.openPath)
  expect(again.status).toBe(400); expect(again.headers.get('location')).toBeNull(); expect(setCookie(again)).toBe('')

  // Google answers; the system browser has no session but the cookie
  const cb = fake.authorize(f.authorizationUrl, 'alice')
  const done = await browser(cbUrl(cb), cookieOf(sc))
  const html = await done.text()
  expect(done.status).toBe(200)
  expect(done.headers.get('content-security-policy')).toBe(GOOGLE_RETURN_CSP)
  expect(html).toContain('연결됐어요') // the team's language (Korean)
  expect(html).toContain('앱으로 돌아가기')
  expect(html).toContain('trina-ax://open?url=')
  expect(html).not.toMatch(/href="\/login|href="\/"|location\.(replace|href)/) // never on to the web app
  expect(setCookie(done)).toContain('Max-Age=0')
  // the app's wait flips by itself: its next poll reads "ready" and shows the account to confirm
  const flow = await desk.call('GET', `${base}/flows/${f.flowId}`)
  expect(flow.state).toBe('ready'); expect(flow.account.email).toBeTruthy()
  expect((await desk.call('POST', `${base}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
})

test('desktop: no cookie, another flow\'s cookie or a late ticket finishes nothing; the page sends the person back to the app', async () => {
  const desk = await appSession('desktop')
  const f1 = await desk.call('POST', base + '/authorize', {})
  const sc1 = setCookie(await browser(f1.openPath))
  // a second flow replaces the first (one at a time): its cookie is not the first's
  const f2 = await desk.call('POST', base + '/authorize', {})
  const cb2 = fake.authorize(f2.authorizationUrl)
  // no cookie: refused, the flow still waits
  let p = await browser(cbUrl(cb2))
  let html = await p.text()
  expect(p.status).toBe(400)
  expect(html).toContain('이 창에서는 연결을 마치지 못했어요')
  expect(html).toContain('trina-ax://open?url=')
  expect(html).toContain('href="/login?next=%2Fsettings%2Fconnectors%2Fgoogle-drive"')
  expect((await desk.call('GET', `${base}/flows/${f2.flowId}`)).state).toBe('pending')
  // the first flow's cookie does not open the second
  p = await browser(cbUrl(cb2), cookieOf(sc1))
  expect(p.status).toBe(400)
  expect((await desk.call('GET', `${base}/flows/${f2.flowId}`)).state).toBe('pending')
  // a ticket opened too late: the expired page, no cookie
  fake.now += TICKET_MS + 1
  const late = await browser(f2.openPath)
  expect(late.status).toBe(400); expect(setCookie(late)).toBe('')
  expect(await late.text()).toContain('시간이 지났거나')
  // unknown flow or ticket
  expect((await browser(`${OPEN_PATH}?flow=nope&t=${'A'.repeat(43)}`)).status).toBe(400)
  expect((await browser(`${OPEN_PATH}?flow=${f2.flowId}`)).status).toBe(400)
})

test('a cancelled flow\'s address is dead; somebody else\'s browser with the cookie still cannot use another person\'s flow', async () => {
  const desk = await appSession('desktop')
  const f = await desk.call('POST', base + '/authorize', {})
  await desk.call('DELETE', `${base}/flows/${f.flowId}`)
  expect((await browser(f.openPath)).status).toBe(400)
  // bob's own desktop flow: his cookie, Olga's flow state → refused
  const bob = (await addMember(h, owner, { username: 'bob' })).client
  const fo = await desk.call('POST', base + '/authorize', {})
  const bobDesk = h.client(); await bobDesk.call('POST', '/api/auth/login', { username: 'bob', password: 'river stone lamp 7', client: 'desktop' })
  const fb = await bobDesk.call('POST', base + '/authorize', {})
  const scBob = setCookie(await browser(fb.openPath))
  const cbOlga = fake.authorize(fo.authorizationUrl)
  expect((await browser(cbUrl(cbOlga), cookieOf(scBob))).status).toBe(400)
  expect((await desk.call('GET', `${base}/flows/${fo.flowId}`)).state).toBe('pending')
  void bob
})

test('a sign-in from a browser: no one-time address, today\'s pages (signed in: "Almost done"; not: sign in and connect here)', async () => {
  const f = await owner.call('POST', base + '/authorize', {})
  expect(f.openPath).toBeUndefined()
  const cb = fake.authorize(f.authorizationUrl)
  let p = await browser(cbUrl(cb))
  let html = await p.text()
  expect(p.status).toBe(400)
  expect(html).toMatch(/이 브라우저는 .+에 로그인되어 있지 않아요/)
  expect(html).toContain('href="/login?next=%2Fsettings%2Fconnectors%2Fgoogle-drive"')
  expect(html).not.toContain('trina-ax://')
  p = await owner.raw('GET', cbUrl(cb))
  html = await p.text()
  expect(p.status).toBe(200); expect(html).toContain('거의 다 됐어요'); expect(html).not.toContain('trina-ax://')
})

test('the phone app: no one-time address (its browser hand-off takes Google only); a signed-in browser ends on "go back to the app"', async () => {
  const phone = await appSession('mobile')
  const f = await phone.call('POST', base + '/authorize', {})
  expect(f.openPath).toBeUndefined()
  const cb = fake.authorize(f.authorizationUrl)
  // the same person signed in in that browser: connected, back to the app, no desktop link
  const p = await owner.raw('GET', cbUrl(cb))
  const html = await p.text()
  expect(p.status).toBe(200); expect(html).toContain('연결됐어요'); expect(html).not.toContain('trina-ax://')
})

test('the pieces: tickets once and in time, cookies by hash, the cookie line, the app link, the desktop link check', () => {
  let now = 0
  const apps = new AppSignIns(() => now)
  expect(apps.start('f1', 'mobile', 'https://accounts.google.com/x')).toBeNull()
  expect(apps.client('f1')).toBe('mobile')
  const t = apps.start('f2', 'desktop', 'https://accounts.google.com/y')!
  expect(apps.open('f2', 'x'.repeat(43))).toBeNull()
  const o = apps.open('f2', t)!
  expect(o.url).toBe('https://accounts.google.com/y')
  expect(apps.open('f2', t)).toBeNull()
  expect(apps.bound('f2', o.bind)).toBe(true); expect(apps.bound('f2', undefined)).toBe(false); expect(apps.bound('f1', o.bind)).toBe(false)
  const t3 = apps.start('f3', 'desktop', 'u')!
  now += TICKET_MS + 1
  expect(apps.open('f3', t3)).toBeNull()
  now += 10 * 60_000
  expect(apps.bound('f2', o.bind)).toBe(false); expect(apps.client('f2')).toBeNull()

  expect(cookieValue(`a=1; ${BIND_COOKIE}=abc; b=2`, BIND_COOKIE)).toBe('abc')
  expect(cookieValue('a=1', BIND_COOKIE)).toBeUndefined()
  expect(bindCookie('https://acme.trina.app/x', '/cb', 'v', 600)).toBe(`${BIND_COOKIE}=v; Path=/cb; HttpOnly; SameSite=Lax; Max-Age=600; Secure`)
  expect(bindCookie('http://localhost/x', '/cb', 'v', 600)).not.toContain('Secure')

  expect(backToAppHref('https://acme.trina.app')).toBe('trina-ax://open?url=https%3A%2F%2Facme.trina.app%2F')
  // the desktop app brings the window forward for the team it shows, and only that one
  expect(isShownTeamStart(backToAppHref('https://acme.trina.app'), 'https://acme.trina.app')).toBe(true)
  expect(isShownTeamStart(backToAppHref('https://acme.trina.app'), 'https://other.trina.app')).toBe(false)
  expect(isShownTeamStart(backToAppHref('https://acme.trina.app'), null)).toBe(false)
  expect(isShownTeamStart('trina-ax://open?url=https%3A%2F%2Facme.trina.app%2Fc%2Fx', 'https://acme.trina.app')).toBe(false)
  // a desktop button only on https/http origins, never on another value
  expect(googleReturnPage('ok', 'en', { app: 'desktop', origin: 'javascript:alert(1)' }).html).not.toContain('trina-ax://')
  expect(googleReturnPage('ok', 'en', { app: 'desktop', origin: 'https://acme.trina.app' }).html).toContain('Back to the app')
})
