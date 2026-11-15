// Services that take only an app on the computer as the place to come back to (RFC 8252's 127.0.0.1 return address):
// server/src/integrations/connections/oauth.ts loopbackClient and service.ts clientFor. The shapes are the services'
// recorded answers (unauthenticated probes 2026-11-13, Square again 2026-11-15): Canva registers any app but its sign-in
// page refuses an https return address ("Invalid redirect URI.") and takes 127.0.0.1; Intercom and Square refuse to
// register an https one ("domain not in allowlist") and take 127.0.0.1; Figma refuses both (403). A desktop session
// with the app's return port signs in through 127.0.0.1; a web or phone session is told to use the desktop app
// (oauth_desktop_only); a port from any other session is dropped; the 20 tries an hour hold.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { harness, OWNER_PW, withOwner, type Client, type Harness } from './a-lib'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { getRow } from '../../server/src/integrations/connections/store'
import { loopbackPortOk, loopbackRedirect } from '../../server/src/integrations/connections/oauth'
import { reasonText, say, TEXT } from '../../server/src/integrations/connections/text'

setDefaultTimeout(30_000)

const TEAM = 'https://team.example.com'
const PUBLIC = { origin: TEAM }
const PORT = 51234
let h: Harness, olga: Client, desk: Client, fake: FakeServices
let seq = 0
beforeAll(() => { fake = new FakeServices() })
afterAll(() => fake?.stop())
beforeEach(async () => {
  h = await harness('int-desktop-' + ++seq, { publicOrigins: [TEAM] })
  olga = await withOwner(h)
  // the same person in the desktop app: its session says so at sign-in
  desk = h.client()
  await desk.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, client: 'desktop' })
  fake.strict = {}
  fake.seen.length = 0
  fake.now = Date.now()
  integrationsOf(h.ctx, { net: fake.net(), now: () => fake.now })
})
afterEach(async () => { await h?.close() })

const callback = (q: Record<string, string>) => '/api/integrations/oauth/callback?' + new URLSearchParams(q)
let n = 0
const service = (name = 'Canva') => olga.call('POST', '/api/integrations', { kind: 'mcp', name, url: `${fake.base}/mcp-strict?n=${++n}`, auth: 'oauth' }, PUBLIC)
const authorize = (who: Client, id: string, body: Record<string, unknown> = {}) => who.try('POST', `/api/integrations/${id}/authorize`, body, PUBLIC)
const redirectOf = (r: { body: any }) => new URL(r.body.authorizationUrl).searchParams.get('redirect_uri')
const registrations = () => fake.seen.filter((s) => s.path === '/as-strict/register').length
const flows = (id: string) => h.ctx.db.query('SELECT state, reason FROM integration_oauth_flows WHERE integration_id = ? ORDER BY created_at').all(id)
const desktopOnly = (name: string) => say('oauth_desktop_only', 'ko', { name })

describe('the desktop app signs in through its 127.0.0.1 return address', () => {
  test('Canva (registers, but its sign-in page refuses the https address): a 127.0.0.1 app; the callback exchanges with that address; refresh', async () => {
    fake.strict = { loopback: 'page' }
    const c = await service()
    const r = await authorize(desk, c.id, { loopbackPort: PORT })
    expect(r.status).toBe(200)
    expect(redirectOf(r)).toBe(`http://127.0.0.1:${PORT}/callback`)
    expect(r.body.loopback).toBe(true)
    // the https try first (registered, its page refused), then one 127.0.0.1 registration
    expect(registrations()).toBe(2)
    // the service sends the browser to 127.0.0.1, the app sends it on to the team's return page: any live session of
    // the same person finishes it (here the system browser's own)
    const cb = fake.authorize(r.body.authorizationUrl, `${fake.base}/as-strict`)
    const page = await olga.raw('GET', callback(cb))
    expect(page.status).toBe(200)
    const token = new URLSearchParams(fake.seen.filter((s) => s.path === '/as/token').at(-1)!.body)
    expect(token.get('redirect_uri')).toBe(`http://127.0.0.1:${PORT}/callback`)
    expect(token.get('grant_type')).toBe('authorization_code')
    expect((await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)).toMatchObject({ status: 'connected', hasSecret: true })
    expect(await desk.call('GET', `/api/integrations/flows/${r.body.flowId}`)).toMatchObject({ state: 'completed' })
    // a refresh sends no return address
    fake.refreshCount = 0
    fake.now += 3600_000 + 1
    await olga.call('POST', `/api/integrations/${c.id}/refresh`, {})
    expect(fake.refreshCount).toBe(1)
    const refresh = new URLSearchParams(fake.seen.filter((s) => s.path === '/as/token').at(-1)!.body)
    expect(refresh.get('grant_type')).toBe('refresh_token')
    expect(refresh.get('redirect_uri')).toBeNull()
  })

  test('Intercom and Square (refuse to register an https address): one 127.0.0.1 registration; learned, the next sign-in goes there at once', async () => {
    fake.strict = { loopback: 'register' }
    const c = await service('Intercom')
    const r = await authorize(desk, c.id, { loopbackPort: PORT })
    expect(r.status).toBe(200)
    expect(redirectOf(r)).toBe(`http://127.0.0.1:${PORT}/callback`)
    // the refused https registration created nothing there, then the 127.0.0.1 one
    expect(registrations()).toBe(2)
    expect(fake.seen.filter((s) => s.path === '/as-strict/register').map((s) => JSON.parse(s.body).redirect_uris[0]))
      .toEqual([`${TEAM}/api/integrations/oauth/callback`, `http://127.0.0.1:${PORT}/callback`])
    // another port, another sign-in: only the 127.0.0.1 registration (no https try that is known to be refused)
    const before = registrations()
    const again = await authorize(desk, c.id, { loopbackPort: PORT + 1 })
    expect(redirectOf(again)).toBe(`http://127.0.0.1:${PORT + 1}/callback`)
    expect(registrations()).toBe(before + 1)
    // the newer sign-in replaced the first one
    expect(await desk.call('GET', `/api/integrations/flows/${r.body.flowId}`)).toMatchObject({ state: 'failed', reason: 'superseded' })
    const cb = fake.authorize(again.body.authorizationUrl, `${fake.base}/as-strict`)
    expect((await desk.raw('GET', callback(cb))).status).toBe(200)
    expect(getRow(h.ctx.db, c.id)!.secret_enc).not.toBeNull()
  })

  test('a service that takes the https address keeps it: the port is not used and the answer says so', async () => {
    const c = await service('Linear')
    const r = await authorize(desk, c.id, { loopbackPort: PORT })
    expect(r.status).toBe(200)
    expect(redirectOf(r)).toBe(`${TEAM}/api/integrations/oauth/callback`)
    expect(r.body.loopback).toBeUndefined()
    expect(registrations()).toBe(1)
  })

  test('Figma (refuses even 127.0.0.1): still "approved apps only", from the desktop app too', async () => {
    fake.strict = { register: 403 }
    const c = await service('Figma')
    const r = await authorize(desk, c.id, { loopbackPort: PORT })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(TEXT.oauth_approved_apps_only.ko)
    expect(getRow(h.ctx.db, c.id)!.last_error).toBe('oauth_approved_apps_only')
    // learned: a web try now asks nothing more of it than before this change (its own https registration)
    const before = registrations()
    const web = await authorize(olga, c.id)
    expect(web.body.error.message).toBe(TEXT.oauth_approved_apps_only.ko)
    expect(registrations()).toBe(before + 1)
  })

  test('a desktop app from before the return address (no port): the old words, no probe', async () => {
    fake.strict = { loopback: 'page' }
    const c = await service()
    const r = await authorize(desk, c.id)
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(TEXT.oauth_approved_apps_only.ko)
    expect(registrations()).toBe(1)
  })

  test('a port outside 1024-65535 is refused by the contract', async () => {
    const c = await service()
    for (const p of [80, 0, 70000, 1.5]) expect((await authorize(desk, c.id, { loopbackPort: p })).status).toBe(400)
    expect(loopbackPortOk(1024) && loopbackPortOk(65535) && !loopbackPortOk(1023) && !loopbackPortOk('5000')).toBe(true)
    expect(loopbackRedirect(5000)).toBe('http://127.0.0.1:5000/callback')
  })
})

describe('the web and the phone app are told to use the desktop app', () => {
  test('Canva from the web: oauth_desktop_only in words naming it, a refused try, and a code the page links the download with', async () => {
    fake.strict = { loopback: 'page' }
    const c = await service()
    const r = await authorize(olga, c.id)
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(desktopOnly('Canva'))
    expect(r.body.error.message).toBe('Canva는 컴퓨터에 설치한 앱에서만 로그인할 수 있어요. 트리나 데스크톱 앱을 열고 거기서 연결해 주세요.')
    expect(r.body.error.params).toEqual({ reason: 'oauth_desktop_only' })
    expect(getRow(h.ctx.db, c.id)).toMatchObject({ status: 'needs_auth', last_error: 'oauth_desktop_only' })
    // the connection's line says the same
    expect((await olga.call('GET', '/api/integrations')).items.find((i: any) => i.id === c.id)).toMatchObject({ lastErrorReason: 'oauth_desktop_only', lastError: desktopOnly('Canva') })
    expect(flows(c.id)).toEqual([{ state: 'failed', reason: 'refused' }])
    // the https registration, then one probe registration for 127.0.0.1 (never used)
    expect(registrations()).toBe(2)
    // learned: the next web try registers nothing
    const again = await authorize(olga, c.id)
    expect(again.body.error.message).toBe(desktopOnly('Canva'))
    expect(registrations()).toBe(2)
    // and the desktop app goes straight to its 127.0.0.1 app
    const d = await authorize(desk, c.id, { loopbackPort: PORT })
    expect(d.status).toBe(200)
    expect(redirectOf(d)).toBe(`http://127.0.0.1:${PORT}/callback`)
    expect(registrations()).toBe(3)
  })

  test('Square from the web: the same', async () => {
    fake.strict = { loopback: 'register' }
    const c = await service('Square')
    const r = await authorize(olga, c.id)
    expect(r.body.error.message).toBe('Square는 컴퓨터에 설치한 앱에서만 로그인할 수 있어요. 트리나 데스크톱 앱을 열고 거기서 연결해 주세요.')
    expect(getRow(h.ctx.db, c.id)!.last_error).toBe('oauth_desktop_only')
  })

  test('a port sent from a web session is dropped: never a 127.0.0.1 sign-in there', async () => {
    fake.strict = { loopback: 'page' }
    const c = await service()
    const r = await authorize(olga, c.id, { loopbackPort: PORT })
    expect(r.status).toBe(400)
    expect(r.body.error.params).toEqual({ reason: 'oauth_desktop_only' })
    expect(h.ctx.db.query("SELECT count(*) AS n FROM integration_oauth_flows WHERE integration_id = ? AND state = 'pending'").get(c.id)).toEqual({ n: 0 })
    // and on a service that takes the https address it changes nothing either (a fresh service: the fake's other
    // service shares this sign-in server, whose answer is remembered)
    fake.strict = {}
    integrationsOf(h.ctx, { net: fake.net(), now: () => fake.now })
    const ok = await service('Linear')
    const w = await authorize(olga, ok.id, { loopbackPort: PORT })
    expect(w.body.error).toBeUndefined()
    expect(redirectOf(w)).toBe(`${TEAM}/api/integrations/oauth/callback`)
    expect(w.body.loopback).toBeUndefined()
  })

  test('the phone app: the desktop words too (it cannot open a return address for another browser)', async () => {
    fake.strict = { loopback: 'register' }
    const phone = h.client()
    await phone.call('POST', '/api/auth/login', { username: 'olga', password: OWNER_PW, client: 'mobile', tokenMode: 'bearer' })
    const c = await service('Intercom')
    const r = await authorize(phone, c.id, { loopbackPort: PORT })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe(desktopOnly('Intercom'))
    expect(r.body.error.message).toStartWith('Intercom은 ')
  })

  test('Figma from the web: still "approved apps only" (the probe was refused too), and only once', async () => {
    fake.strict = { register: 403 }
    const c = await service('Figma')
    const r = await authorize(olga, c.id)
    expect(r.body.error.message).toBe(TEXT.oauth_approved_apps_only.ko)
    expect(registrations()).toBe(2)
    await authorize(olga, c.id)
    expect(registrations()).toBe(3)
  })

  test('a probe the service is too busy for says nothing either way: the old words, nothing learned', async () => {
    fake.strict = { loopback: 'register' }
    const c = await service('Square')
    let calls = 0
    // the second registration (the probe) answers 429
    const route = (fake as any).route.bind(fake)
    ;(fake as any).route = async (req: Request) => (new URL(req.url).pathname === '/as-strict/register' && ++calls === 2 ? Response.json({ error: 'slow_down' }, { status: 429 }) : route(req))
    try {
      const r = await authorize(olga, c.id)
      expect(r.body.error.message).toBe(TEXT.oauth_approved_apps_only.ko)
      // not remembered: the next try probes again and says the desktop words
      const again = await authorize(olga, c.id)
      expect(again.body.error.message).toBe(desktopOnly('Square'))
    } finally { (fake as any).route = route }
  })

  test('refused tries count toward the 20 sign-in tries an hour, as before', async () => {
    fake.strict = { loopback: 'page' }
    const c = await service()
    for (let i = 0; i < 20; i++) expect((await authorize(olga, c.id)).status).toBe(400)
    const regs = registrations()
    expect((await authorize(olga, c.id)).status).toBe(429)
    expect((await authorize(desk, c.id, { loopbackPort: PORT })).status).toBe(429)
    expect(registrations()).toBe(regs)
  })
})

describe('words', () => {
  test('oauth_desktop_only in six languages names the service and the desktop app, without technical words', () => {
    for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
      expect(TEXT.oauth_desktop_only[l]).toContain('{name}')
      expect(say('oauth_desktop_only', l, { name: 'Canva' })).toContain('Canva')
      expect(reasonText('oauth_desktop_only', l, undefined, 'Canva')).toBe(say('oauth_desktop_only', l, { name: 'Canva' }))
      // a member on a team connection: tell the admin
      expect(reasonText('oauth_desktop_only', l, { address: true, key: false }, 'Canva')).toBe(TEXT.keyMember[l])
    }
    expect(TEXT.oauth_desktop_only.en).toBe('{name} only lets you sign in from an app on your computer. Open the Trina desktop app and connect it there.')
    expect(TEXT.oauth_desktop_only.en).not.toMatch(/loopback|redirect|127|OAuth|client|port/i)
    // the Korean particle follows the name as it is read
    expect(say('oauth_desktop_only', 'ko', { name: 'Notion' })).toStartWith('Notion은 ')
    expect(say('oauth_desktop_only', 'en', { name: 'Notion' })).toStartWith('Notion only ')
  })
})
