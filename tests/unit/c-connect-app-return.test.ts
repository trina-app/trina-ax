// An app connection's sign-in started in the desktop app finishes in the app, never by signing in again in the system
// browser (owner 2026-11-21: "The sign-in could not be completed … sign in to the same team account in this browser"):
// server/src/integrations/connections/service.ts hold/claim, routes/integrations.ts (the page), routes/drive.ts (the one
// claim address the desktop app posts every code to). docs/decisions/20261121-connect-browser-handoff.md.
//
// The attack this must stop (security review of trina-ax #98, google-drive/app-return.ts): anyone can make a
// `client: 'desktop'` session with curl, start a sign-in on THEIR connection and phish a victim with the service's
// address. (A) a victim browser without a session, (B) a victim browser signed in as the victim: the victim's account
// must never land on the attacker's connection. The code goes only to the victim's own computer, whose app has the
// victim's session, not the attacker's.
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { createLogger } from '../../server/src/log'
import { say } from '../../server/src/integrations/connections/text'

setDefaultTimeout(30_000)

let h: Harness, olga: Client, desk: Client, bob: { client: Client; password: string }, fake: FakeServices
let logs: string[] = []
let seq = 0
beforeAll(() => { fake = new FakeServices() })
afterAll(() => fake?.stop())
beforeEach(async () => {
  logs = []
  h = await harness('int-app-return-' + ++seq, {}, { log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  olga = await withOwner(h)
  desk = await session('olga', OWNER_PW, 'desktop')
  bob = await addMember(h, olga, { username: 'bob', role: 'member' })
  fake.now = Date.now(); fake.refreshCount = 0; fake.revoked = []; fake.delayRefresh = null; fake.seen.length = 0
  integrationsOf(h.ctx, { net: fake.net(), now: () => fake.now })
})
afterEach(async () => { await h?.close() })

/** a session as an app makes it — or as anyone with curl may: the login says which app it is */
async function session(username: string, password: string, client: 'desktop' | 'mobile' | 'web') {
  const c = h.client()
  await c.call('POST', '/api/auth/login', { username, password, client, tokenMode: client === 'mobile' ? 'bearer' : 'cookie' })
  return c
}
const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
/** a system browser with no session at all */
const bare = (path: string) => h.fetch(path, { ip: '10.0.0.9' })
/** the one-time code on a return page: only ever in the app link's fragment */
function codeOf(html: string): string | null {
  const m = /href="trina-ax:\/\/open\?url=[^"#]+#code=([A-Za-z0-9_-]{43})"/.exec(html)
  return m ? m[1]! : null
}
const claim = (c: Client, code: string) => c.try('POST', '/api/integrations/google-drive/claim', { code })
const create = (by: Client, name = 'Board') => by.call('POST', '/api/integrations', { kind: 'mcp', name, url: `${fake.base}/mcp-oauth?n=${name}`, auth: 'oauth' })
const statusOf = async (by: Client, id: string) => (await by.call('GET', '/api/integrations')).items.find((i: any) => i.id === id)
const tokenCalls = () => fake.seen.filter((s) => s.path === '/as/token').length
async function start(by: Client, owner: Client = olga) {
  const c = await create(owner)
  const f = await by.call('POST', `/api/integrations/${c.id}/authorize`, {})
  return { id: c.id as string, flow: f, cb: fake.authorize(f.authorizationUrl) }
}

test('desktop sign-in, system browser without a session: held for the app, the app\'s own session finishes it; no sign-in asked', async () => {
  const { id, flow, cb } = await start(desk)
  const page = await bare(callback(cb))
  expect(page.status).toBe(200)
  expect(page.headers.get('cache-control')).toBe('no-store')
  expect(page.headers.get('referrer-policy')).toBe('no-referrer')
  const html = await page.text()
  // never the old dead end, never a sign-in link
  expect(html).not.toContain('same team account')
  expect(html).not.toContain('같은 계정으로 로그인')
  expect(html).not.toContain('href="/login')
  // the code only in the fragment of the app's link (button and refresh), never in a query string
  const code = codeOf(html)!
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(html).toContain(`<meta http-equiv="refresh" content="0;url=trina-ax://open?url=`)
  expect(html).not.toContain(`?code=${code}`)
  expect(html).not.toContain(`&code=${code}`)
  // whose account it joins, and not to send it on
  expect(html).toContain('@olga')
  expect(html).toContain('data-testid="held-own-app"')
  // exchanged once, nothing stored on the connection yet; the app's screen still reads "waiting"
  expect(tokenCalls()).toBe(1)
  expect(await statusOf(olga, id)).toMatchObject({ status: 'needs_auth', hasSecret: false })
  expect(await desk.call('GET', `/api/integrations/flows/${flow.flowId}`)).toMatchObject({ state: 'pending', reason: null })
  // the desktop app posts it with its own session: connected
  const r = await claim(desk, code)
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ flowId: flow.flowId, state: 'completed', account: null })
  expect(await statusOf(olga, id)).toMatchObject({ status: 'connected', hasSecret: true })
  expect(await desk.call('GET', `/api/integrations/flows/${flow.flowId}`)).toMatchObject({ state: 'completed' })
  // the code and the tokens are nowhere in the database, the audit or the logs
  const all = JSON.stringify(h.ctx.db.query('SELECT * FROM integration_oauth_flows').all()) + JSON.stringify(h.ctx.db.query('SELECT * FROM audit_log').all()) + logs.join('\n')
  expect(all).not.toContain(code)
  expect(all).not.toContain(cb.code)
})


test('a browser signed in as another person of the team (a desktop sign-in): refused in plain words, as for Drive and the Google apps; the starter can still finish', async () => {
  const { id, flow, cb } = await start(desk)
  const page = await bob.client.raw('GET', callback(cb))
  expect(page.status).toBe(400)
  const html = await page.text()
  expect(codeOf(html)).toBeNull()
  expect(html).toContain(say('callbackOtherAccount', 'ko'))
  expect(say('callbackOtherAccount', 'en')).toBe('This browser is signed in as someone else. Sign out here, or go back to the app and press Connect again.')
  expect(html).not.toContain('href="/login')
  expect(tokenCalls()).toBe(0)
  expect(await statusOf(olga, id)).toMatchObject({ hasSecret: false })
  expect((await desk.call('GET', `/api/integrations/flows/${flow.flowId}`)).state).toBe('pending')
  // the same return in a browser with no session (after signing out there) is held for the starter's app
  const code = codeOf(await (await bare(callback(cb))).text())!
  expect((await claim(desk, code)).status).toBe(200)
  expect(await statusOf(olga, id)).toMatchObject({ status: 'connected' })
})

test('cancel in the app ends a held result: the code is refused afterwards and its tokens revoked', async () => {
  const { id, flow, cb } = await start(desk)
  const code = codeOf(await (await bare(callback(cb))).text())!
  await desk.call('DELETE', `/api/integrations/flows/${flow.flowId}`)
  expect((await claim(desk, code)).status).toBe(400)
  expect(await statusOf(olga, id)).toMatchObject({ hasSecret: false })
  await Bun.sleep(50)
  expect(fake.revoked.length).toBeGreaterThan(0)
})


test('a new try replaces a held result: the old code is refused', async () => {
  const { id, cb } = await start(desk)
  const code = codeOf(await (await bare(callback(cb))).text())!
  await desk.call('POST', `/api/integrations/${id}/authorize`, {})
  expect((await claim(desk, code)).status).toBe(400)
  expect(await statusOf(olga, id)).toMatchObject({ hasSecret: false })
})


test('a held result whose connection changed meanwhile is not stored', async () => {
  const { id, cb } = await start(desk)
  const code = codeOf(await (await bare(callback(cb))).text())!
  await olga.call('PATCH', `/api/integrations/${id}`, { name: 'Renamed', url: `${fake.base}/mcp-oauth?n=moved` })
  const r = await claim(desk, code)
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ state: 'failed', reason: 'changed' })
  expect(await statusOf(olga, id)).toMatchObject({ hasSecret: false })
})


test('web and phone sign-ins keep needing the person\'s browser session; the page says it plainly, with no sign-in link', async () => {
  for (const client of ['web', 'mobile'] as const) {
    const who = await session('olga', OWNER_PW, client)
    const { id, flow, cb } = await start(who)
    const page = await bare(callback(cb))
    expect(page.status).toBe(400)
    const html = await page.text()
    expect(codeOf(html)).toBeNull()
    expect(html).toContain(say('callbackFail', 'ko'))
    expect(say('callbackFail', 'en')).toBe('This link expired. Go back to the app and press Connect again.')
    expect(html).not.toContain('href="/login')
    expect(tokenCalls()).toBe(0)
    expect((await who.call('GET', `/api/integrations/flows/${flow.flowId}`)).state).toBe('pending')
    // the same person's browser still finishes it
    expect((await olga.raw('GET', callback(cb))).status).toBe(200)
    expect(await statusOf(olga, id)).toMatchObject({ status: 'connected' })
    fake.seen.length = 0
  }
})


test('the same person signed in in the browser finishes a desktop sign-in at once, as before', async () => {
  const { id, cb } = await start(desk)
  const page = await olga.raw('GET', callback(cb))
  expect(page.status).toBe(200)
  expect(codeOf(await page.text())).toBeNull()
  expect(await statusOf(olga, id)).toMatchObject({ status: 'connected' })
})


test('the return pages are one styled card (logo, light and dark, phone width) with one next step that fits where it started', async () => {
  const styleHash = (html: string) => {
    const css = /<style>([^<]*)<\/style>/.exec(html)![1]!
    return `'sha256-${new Bun.CryptoHasher('sha256').update(css).digest('base64')}'`
  }
  // desktop, browser signed in as someone else: Back to the app
  const d = await start(desk)
  const other = await bob.client.raw('GET', callback(d.cb))
  const oh = await other.text()
  expect(other.headers.get('content-security-policy')).toContain(`style-src ${styleHash(oh)}`)
  expect(other.headers.get('content-security-policy')).toContain("img-src 'self'")
  expect(oh).toContain('<img class="logo" src="/favicon.svg"')
  expect(oh).toContain('prefers-color-scheme:dark')
  expect(oh).toContain('width=device-width,initial-scale=1')
  expect(oh).toMatch(/<a class="cta" href="trina-ax:\/\/open\?url=[^"#]+">/)
  // web, browser without a session: Open Connectors on the web
  const web = await session('olga', OWNER_PW, 'web')
  const w = await start(web)
  const wh = await (await bare(callback(w.cb))).text()
  expect(wh).toContain('<a class="cta" href="/settings/connectors">')
  expect(wh).not.toContain('trina-ax://')
  // phone: words only
  const phone = await session('olga', OWNER_PW, 'mobile')
  const m = await start(phone)
  const mh = await (await bare(callback(m.cb))).text()
  expect(mh).not.toContain('class="cta"')
  // an unknown state: words only
  expect(await (await bare(callback({ state: 'x'.repeat(43), code: 'c' }))).text()).not.toContain('class="cta"')
})
