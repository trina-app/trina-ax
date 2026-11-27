// A desktop sign-in's one-time code goes back to the app over 127.0.0.1, whatever the browser
// (docs/decisions/20261127-desktop-sign-in-code-loopback.md; server google-drive/app-return.ts heldLink; desktop
// common/code-return.ts).
//
// REPRO (owner, 0.20.0, 2026-11-27): Google Drive from the desktop app, the system browser (ego lite) has no session of
// the team, so the result is held for the app and the page handed the code ONLY through `trina-ax://open?…#code=…`.
// ego lite opens no apps (ERR_UNKNOWN_URL_SCHEME, also on a click): the page with its button was replaced by an error
// page and the app waited "Waiting for Google…" until its 5-minute limit. Now the app tells its server a return port on
// every call and the held page sends the browser to http://127.0.0.1:<port>/sign-in-code?code=…, where the app redeems
// the code with its own session. Fake Google only.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { request } from 'node:http'
import { harness, withOwner, OWNER_PW, type Harness, type Client } from './a-lib'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { appReturnPort, heldLink, noteAppReturn } from '../../server/src/integrations/google-drive/app-return'
import { heldPage } from '../../server/src/integrations/connections/return-page'
import { FakeGoogleDrive, DRIVE_CONFIG } from '../lib/fake-google-drive'
import { CodeReturn, returnedCode } from '../../desktop/src/common/code-return'
import { APP_CODE_RETURN_PATH, APP_RETURN_HEADER, appReturnPortOf } from '../../shared/src/desktop-bridge'

let h: Harness, fake: FakeGoogleDrive, seq = 0
const base = '/api/integrations/google-drive'
beforeEach(async () => {
  h = await harness('sign-in-code-loopback-' + ++seq); await withOwner(h)
  fake = new FakeGoogleDrive(); googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: fake.fetch, now: () => fake.now })
})
afterEach(async () => { await h?.close() })

async function session(client: 'desktop' | 'web') {
  const c = h.client()
  await c.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, client, tokenMode: 'cookie' })
  return c
}
/** the system browser: no session */
const bare = (path: string) => h.fetch(path, { ip: '10.0.0.9' })
const cbUrl = (q: { state: string; code: string }) => `${base}/callback?${new URLSearchParams(q)}`
const refreshOf = (html: string) => /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(html)?.[1]?.replace(/&#38;/g, '&') ?? null

/** a page load of the app's return address, as a browser sends it */
function load(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...headers } }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('REPRO: a browser that opens no apps still finishes a desktop Drive sign-in: the held page goes to the app on 127.0.0.1, the app redeems the code', async () => {
  const desk = await session('desktop')
  // the desktop app: its return address, which hands a code to this app's own session (main.ts → claimReturnedCode)
  const claims: Promise<{ status: number; body: any }>[] = []
  // main.ts → AppWindow.claimReturnedCode: only for the team on screen (here the test server's address)
  const ret = new CodeReturn({ deliver: (code, team) => { if (team !== 'http://team.localhost') return false; claims.push(desk.try('POST', base + '/claim', { code })); return true }, page: () => 'Back in the app' })
  try {
    const port = (await ret.port())!
    expect(port).toBeGreaterThan(1023)
    // every call of the desktop page names it (web lib/api.ts)
    const f = await desk.call('POST', base + '/authorize', {}, { [APP_RETURN_HEADER]: String(port) })
    // Google answers in the system browser, which has no session: held for the app
    const page = await bare(cbUrl(fake.authorize(f.authorizationUrl, 'alice')))
    const html = await page.text()
    expect(page.status).toBe(200)
    const next = refreshOf(html)!
    // not the app link a browser may not open: the app's own address on this computer, opened by the page itself and
    // by its button
    expect(next).toStartWith(`http://127.0.0.1:${port}${APP_CODE_RETURN_PATH}?code=`)
    expect(html).toContain(`class="cta" href="${next.replace(/&/g, '&#38;')}"`)
    const u = new URL(next)
    expect(u.searchParams.get('team')).toBe('http://team.localhost')
    // the app link stays beside it, for an app that quit meanwhile (it starts the app): the same code
    expect(html).toContain('data-testid="held-app-link"')
    expect(html).toContain(`trina-ax://open?url=http%3A%2F%2Fteam.localhost%2F#code=${u.searchParams.get('code')}`)
    // the flow waits for the app
    expect((await desk.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('pending')
    // the browser follows it: the app hands the code to its session, which finishes it; the browser sees a short page
    const back = await load(port, u.pathname + u.search, { host: `127.0.0.1:${port}` })
    expect(back.status).toBe(200); expect(back.body).toContain('Back in the app')
    expect(claims).toHaveLength(1)
    const r = await claims[0]!
    expect(r.status).toBe(200); expect(r.body.state).toBe('ready')
    expect((await desk.call('GET', `${base}/flows/${f.flowId}`)).state).toBe('ready')
    // a reload of that page hands nothing on again
    expect((await load(port, u.pathname + u.search, { host: `127.0.0.1:${port}` })).status).toBe(404)
    expect(claims).toHaveLength(1)
    // the person confirms in the app: connected
    expect((await desk.call('POST', `${base}/flows/${f.flowId}/complete`, {})).status).toBe('connected')
  } finally { ret.close() }
})

test('an app from before (no port said): the held page keeps the app link; a web session\'s port is never kept', async () => {
  const desk = await session('desktop')
  const f = await desk.call('POST', base + '/authorize', {})
  const html = await (await bare(cbUrl(fake.authorize(f.authorizationUrl, 'alice')))).text()
  expect(refreshOf(html)).toMatch(/^trina-ax:\/\/open\?url=[^"#]+#code=[A-Za-z0-9_-]{43}$/)
  const web = await session('web')
  await web.call('GET', base, undefined, { [APP_RETURN_HEADER]: '50123' })
  const s = h.ctx.db.query("SELECT id FROM sessions WHERE client='web' ORDER BY created_at DESC LIMIT 1").get() as { id: string }
  expect(appReturnPort(s.id)).toBeNull()
})

test('the port: only a desktop session, only a plain unprivileged port; the link carries the code in the address of this computer only', () => {
  for (const bad of ['80', '0', '65536', '1023', 'abc', '5000 ', '05000', '', '1e4']) expect(appReturnPortOf(bad)).toBeNull()
  expect(appReturnPortOf('50123')).toBe(50123)
  noteAppReturn({ id: 's-desk', client: 'desktop' }, '80'); expect(appReturnPort('s-desk')).toBeNull()
  noteAppReturn({ id: 's-desk', client: 'desktop' }, '50123'); expect(appReturnPort('s-desk')).toBe(50123)
  noteAppReturn({ id: 's-mob', client: 'mobile' }, '50123'); expect(appReturnPort('s-mob')).toBeNull()
  const code = 'C'.repeat(43)
  expect(heldLink('https://acme.trina.app', code, 50123)).toBe(`http://127.0.0.1:50123/sign-in-code?code=${code}&team=https%3A%2F%2Facme.trina.app`)
  expect(heldLink('https://acme.trina.app', code, null)).toBe(`trina-ax://open?url=https%3A%2F%2Facme.trina.app%2F#code=${code}`)
  // the app connections' and Slack's held page too
  const page = heldPage('en', 'https://acme.trina.app', { code, who: { name: 'Olga', username: 'olga' }, name: 'Slack', returnPort: 50123 })
  expect(refreshOf(page)).toBe(`http://127.0.0.1:50123/sign-in-code?code=${code}&team=https%3A%2F%2Facme.trina.app`)
  expect(page).toContain('data-testid="held-app-link"')
})

test('the app\'s return address: only GET /sign-in-code?code=<token> from its own Host as a page load; once per code; nothing else hands on', async () => {
  const got: string[] = []
  let onScreen = 'https://acme.trina.app'
  const ret = new CodeReturn({ deliver: (c, team) => { if (team !== onScreen) return false; got.push(c); return true }, page: () => 'ok <b>' })
  try {
    const port = (await ret.port())!
    expect(await ret.port()).toBe(port) // one address while the app runs
    const host = { host: `127.0.0.1:${port}` }
    const code = 'A'.repeat(43), path = `${APP_CODE_RETURN_PATH}?code=${code}&team=${encodeURIComponent('https://acme.trina.app')}`
    // not a page load (a fetch, an image, a frame of another page), another Host, another path or shape: 404
    expect((await load(port, path, { ...host, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(404)
    expect((await load(port, path, { ...host, 'sec-fetch-dest': 'image' })).status).toBe(404)
    expect((await load(port, path, { ...host, 'sec-fetch-dest': 'iframe' })).status).toBe(404)
    expect((await load(port, path, { host: `localhost:${port}` })).status).toBe(404)
    expect((await load(port, `/callback?code=${code}`, host)).status).toBe(404)
    expect((await load(port, `${path}&code=${code}`, host)).status).toBe(404)
    expect((await load(port, `${APP_CODE_RETURN_PATH}?code=${code}`, host)).status).toBe(404) // no team
    expect((await load(port, `${APP_CODE_RETURN_PATH}?code=${code}&team=${encodeURIComponent('https://acme.trina.app/x')}`, host)).status).toBe(404)
    expect((await load(port, `${path}&state=x`, host)).status).toBe(404)
    expect((await load(port, `${APP_CODE_RETURN_PATH}?code=short`, host)).status).toBe(404)
    expect(got).toEqual([])
    // another team on screen: never sent to that team's server, nothing kept (back on the team, a reload hands it on)
    onScreen = 'https://other.trina.app'
    expect((await load(port, path, host)).status).toBe(404)
    onScreen = 'https://acme.trina.app'
    const ok = await load(port, path, host)
    expect(ok.status).toBe(200); expect(ok.body).toContain('ok &lt;b&gt;'); expect(ok.body).not.toContain(code)
    expect(got).toEqual([code])
    expect((await load(port, path, host)).status).toBe(404)
    expect(got).toEqual([code])
    expect(returnedCode(path)).toEqual({ code, team: 'https://acme.trina.app' }); expect(returnedCode('/sign-in-code')).toBeNull()
  } finally { ret.close() }
})
