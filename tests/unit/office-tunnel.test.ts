// Office mode's internet address (docs/OFFICE.md "인터넷 주소"): requests that cloudflared delivers to the loopback app
// port. CF-Connecting-IP trust rules, Host / Origin with a public host, Secure __Host- cookies through the tunnel path,
// the first-run setup refused from the internet, the optional allow-list, upload sizes under Cloudflare's 100 MB
// request limit, the office settings / server.json / LaunchAgent / token file, and scripts/office/public-address.ts's
// refusal rules against a mocked Cloudflare API. The real run over the internet: tests/install/office-tunnel-e2e.ts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { SMALL_UPLOAD_MAX, UPLOAD_CHUNK_SIZE } from '@mycel/shared/api'
import { loadAppConfig } from '../../server/src/app-config'
import { originsFor, publicAddressRefusal, visitorScheme } from '../../server/src/http/middleware'
import { cfClientIp, directFetch, isLoopback, tunnelRequest } from '../../server/src/http/tunnel'
import { peerIp } from '../../server/src/main'
import { classifyPublic, configure, portProblems, publicProblem, readTunnelToken, tunnelIdOf, tunnelPlist } from '../../server/src/office/cli'
import { deskCard } from '../../server/src/office/helper'
import { loadSettings, officePaths, parseCountries, parsePublicHost, serverConfig, settingsFrom, settingsText, tunnelLabel } from '../../server/src/office/settings'
import { checkRecords, ingressFor, main as publicAddressMain, normHost, readCert, Refused, removeAddress, sameJson, setAddress, type Api } from '../../scripts/office/public-address'
import { harness, OWNER_PW, SETUP_TOKEN, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const HOST = 'app.clinic-test.example'
const PUB = `https://${HOST}`
const LAN = 'https://192.168.1.18:8443'
const BASE = path.join(WORK, 'office-tunnel')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const mode = (f: string) => fs.statSync(f).mode & 0o777
const TUNNEL_ID = '6f1c1a8e-1111-4222-8333-944455556666'
const fakeToken = (t = TUNNEL_ID) => Buffer.from(JSON.stringify({ a: 'acc0123456789', t, s: 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0' })).toString('base64')

describe('which requests came through the tunnel (CF-Connecting-IP trust)', () => {
  const cfg = { tunnel: { host: HOST, allowFrom: [], countries: [] }, listen: { host: '127.0.0.1', port: 47830 } }
  const req = (host: string, h: Record<string, string> = {}) => new Request(`http://${host}/api/health?x=1`, { headers: { host, 'cf-connecting-ip': '203.0.113.9', ...h } })

  test('app port + loopback peer + Host = public host: https URL, client IP from CF-Connecting-IP', () => {
    const t = tunnelRequest(cfg, req(HOST), '127.0.0.1', 47830)!
    expect(t.req.url).toBe(`${PUB}/api/health?x=1`)
    expect(t.req.headers.get('host')).toBe(HOST)
    expect(t.ip).toBe('203.0.113.9')
    expect(tunnelRequest(cfg, req(HOST.toUpperCase()), '127.0.0.1', 47830)?.ip).toBe('203.0.113.9')
    expect(tunnelRequest(cfg, req(HOST, { 'cf-connecting-ip': '2001:db8::7' }), '127.0.0.1', 47830)?.ip).toBe('2001:db8::7')
  })

  test('CF-Connecting-IP is ignored everywhere else', () => {
    expect(tunnelRequest({ ...cfg, tunnel: null }, req(HOST), '127.0.0.1', 47830)).toBeNull() // no public address
    expect(tunnelRequest(cfg, req('localhost:47830'), '127.0.0.1', 47830)).toBeNull() // the Mac itself
    expect(tunnelRequest(cfg, req(HOST), '192.168.1.50', 47830)).toBeNull() // not loopback
    expect(tunnelRequest(cfg, req(HOST), '127.0.0.1', 8443)).toBeNull() // the LAN port
    expect(tunnelRequest(cfg, req(`${HOST}:47830`), '127.0.0.1', 47830)).toBeNull()
    expect(tunnelRequest(cfg, req('evil.example'), '127.0.0.1', 47830)).toBeNull()
  })

  test('a missing or forged-looking CF-Connecting-IP falls back to the loopback peer (one shared bucket)', () => {
    expect(tunnelRequest(cfg, req(HOST, { 'cf-connecting-ip': '' }), '127.0.0.1', 47830)?.ip).toBe('127.0.0.1')
    expect(tunnelRequest(cfg, req(HOST, { 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' }), '127.0.0.1', 47830)?.ip).toBe('127.0.0.1')
    expect(tunnelRequest(cfg, req(HOST, { 'cf-connecting-ip': 'not-an-ip' }), '127.0.0.1', 47830)?.ip).toBe('127.0.0.1')
    expect(cfClientIp('::ffff:198.51.100.4')).toBe('198.51.100.4')
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('10.0.0.1')).toBe(false)
    expect(isLoopback(null)).toBe(false)
  })

  test('visitor scheme and the optional allow-list', () => {
    expect(visitorScheme('{"scheme":"http"}', 'https')).toBe('http')
    expect(visitorScheme(undefined, 'https')).toBe('https')
    const t = { host: HOST, allowFrom: ['198.51.100.0/24'], countries: ['KR'] }
    expect(publicAddressRefusal(null, '1.1.1.1', 'http', undefined)).toBe('http')
    expect(publicAddressRefusal({ host: HOST, allowFrom: [], countries: [] }, '1.1.1.1', 'https', 'US')).toBeNull()
    expect(publicAddressRefusal(t, '1.1.1.1', 'https', 'KR')).toBe('ip')
    expect(publicAddressRefusal(t, '2001:db8::1', 'https', 'KR')).toBe('ip') // the IPv4 list refuses IPv6 visitors
    expect(publicAddressRefusal(t, '198.51.100.7', 'https', 'JP')).toBe('country')
    expect(publicAddressRefusal(t, '198.51.100.7', 'https', 'kr')).toBeNull()
  })
})

describe('the app through the tunnel path', () => {
  let h: Harness
  let serve: ReturnType<typeof directFetch>
  const send = (p: string, o: { method?: string; host?: string; peer?: string; port?: number; ip?: string; cookie?: string | null; origin?: string | null; body?: unknown; headers?: Record<string, string> } = {}) => {
    const host = o.host ?? HOST
    const headers: Record<string, string> = { host, ...(o.headers ?? {}) }
    if (o.ip !== undefined) headers['cf-connecting-ip'] = o.ip
    if (o.cookie) headers.cookie = o.cookie
    if (o.origin) headers.origin = o.origin
    if (o.method && o.method !== 'GET') headers['x-mycel-csrf'] = '1'
    if (o.body !== undefined) headers['content-type'] = 'application/json'
    const req = new Request(`http://${host}${p}`, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) })
    return serve(req, { requestIP: () => ({ address: o.peer ?? '127.0.0.1' }), port: o.port ?? 47830 }) as Promise<Response>
  }
  const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('__Host-sid=') || c.startsWith('mycel-dev-sid=')) ?? null

  beforeAll(async () => {
    h = await harness('office-tunnel', {
      office: true, listen: { host: '127.0.0.1', port: 47830 },
      tunnel: { host: HOST, allowFrom: [], countries: [] },
      allowedHosts: ['192.168.1.18:8443', 'localhost:47830', '127.0.0.1:47830'], allowedPeers: ['192.168.1.0/24'],
      publicOrigins: [PUB, LAN, 'http://localhost:47830', 'http://127.0.0.1:47830'],
    })
    serve = directFetch(h.ctx.config, (req, env) => h.app.fetch(req, env), peerIp)
  })
  afterAll(async () => { await h.close() })

  test('the public host answers only through the tunnel path; HSTS on it', async () => {
    const r = await send('/api/health', { ip: '203.0.113.5' })
    expect(r.status).toBe(200)
    expect(r.headers.get('strict-transport-security')).toBe('max-age=31536000')
    // the same name on the LAN port, or with the app port in it, is not ours (421)
    expect((await send('/api/health', { port: 8443, peer: '192.168.1.50' })).status).toBe(421)
    expect((await send('/api/health', { host: `${HOST}:47830` })).status).toBe(421)
    // the Mac itself: no HSTS on http://localhost
    const local = await send('/api/health', { host: 'localhost:47830', ip: '203.0.113.5' })
    expect(local.status).toBe(200)
    expect(local.headers.get('strict-transport-security')).toBeNull()
  })

  test('Origins: the tunnel accepts only https://<public host>; the LAN and the Mac never accept it', () => {
    expect(originsFor(h.ctx.config, { via: 'direct', port: 47830, tunnel: true })).toEqual([PUB])
    expect(originsFor(h.ctx.config, { via: 'direct', port: 47830 })).toEqual(['http://localhost:47830', 'http://127.0.0.1:47830'])
    expect(originsFor(h.ctx.config, { via: 'direct', port: 8443 })).toEqual([LAN])
  })

  test('the first-run setup is refused from the internet, even with the right token; it works on the Mac', async () => {
    const body = { setupToken: SETUP_TOKEN, teamName: 'Clinic', locale: 'ko', owner: { username: 'director', name: 'Dr', password: OWNER_PW } }
    const r = await send('/api/setup', { method: 'POST', ip: '203.0.113.5', origin: PUB, body })
    expect(r.status).toBe(403)
    expect(JSON.stringify(await r.json())).toContain('internet address')
    expect(r.headers.get('set-cookie')).toBeNull()
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0)
    // the internet address does not say that the team is not set up yet, and shows no setup form (attack review
    // finding 2, do-it review 3): the web app shows its sign-in page there; the Mac still sees the setup
    const st = await (await send('/api/setup', { ip: '203.0.113.5' })).text()
    expect(st).not.toContain(SETUP_TOKEN)
    expect(JSON.parse(st).needed).toBe(false)
    expect((await (await send('/api/setup', { host: 'localhost:47830' })).json() as { needed: boolean }).needed).toBe(true)
    expect((await (await send('/api/setup', { port: 8443, peer: '192.168.1.50', host: '192.168.1.18:8443' })).json() as { needed: boolean }).needed).toBe(true)
    const local = await send('/api/setup', { method: 'POST', host: 'localhost:47830', origin: 'http://localhost:47830', body })
    expect(local.status).toBe(201)
  })

  test('sign-in through the tunnel: CSRF Origin https://<host>, Secure __Host- cookie, real IP in the audit and the limits', async () => {
    const bad = await send('/api/auth/login', { method: 'POST', ip: '198.51.100.23', origin: PUB, body: { username: 'director', password: 'wrong wrong wrong' } })
    expect(bad.status).toBe(401)
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login_failed' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }
    expect(row.detail).toContain('198.51.100.23')
    const ok = await send('/api/auth/login', { method: 'POST', ip: '198.51.100.24', origin: PUB, body: { username: 'director', password: OWNER_PW } })
    expect(ok.status).toBe(200)
    const sc = ok.headers.getSetCookie().find((x) => x.startsWith('__Host-sid='))!
    expect(sc).toMatch(/; Secure/)
    expect(sc).toMatch(/HttpOnly/)
    expect(sc).toMatch(/Path=\//)
    const cookie = cookieOf(ok)!
    const me = await send('/api/me', { ip: '198.51.100.24', cookie })
    expect(me.status).toBe(200)
    // the dev cookie name is not accepted on the https address (session fixation)
    expect((await send('/api/me', { ip: '198.51.100.24', cookie: cookie.replace('__Host-sid', 'mycel-dev-sid') })).status).toBe(401)
    // CSRF: other origins are refused on the tunnel
    for (const origin of ['http://localhost:47830', LAN, 'https://evil.example', `http://${HOST}`]) {
      expect((await send('/api/auth/logout', { method: 'POST', ip: '198.51.100.24', cookie, origin })).status).toBe(403)
    }
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }
    expect(audit.detail).toContain('198.51.100.24')
    // an invite made through the internet address links there; one made on the Mac too (the main path)
    const inv = await (await send('/api/admin/invites', { method: 'POST', ip: '198.51.100.24', cookie, origin: PUB, body: { role: 'member' } })).json() as { url: string }
    expect(inv.url.startsWith(`${PUB}/invite/`)).toBe(true)
  })

  test('sign-in limits count the visitor\'s IP, not the tunnel\'s loopback address', async () => {
    let limited = false
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await send('/api/auth/login', { method: 'POST', ip: '192.0.2.66', origin: PUB, body: { username: `nobody${i}`, password: 'wrong wrong wrong' } })
      limited = r.status === 429
    }
    expect(limited).toBe(true)
    // another visitor is not affected, and neither is the Mac itself
    expect((await send('/api/auth/login', { method: 'POST', ip: '192.0.2.67', origin: PUB, body: { username: 'nobody', password: 'wrong wrong wrong' } })).status).toBe(401)
    expect((await send('/api/auth/login', { method: 'POST', host: 'localhost:47830', origin: 'http://localhost:47830', body: { username: 'nobody', password: 'wrong wrong wrong' } })).status).toBe(401)
  })

  test('plain http visitors are sent to https (GET) or refused; the allow-list refuses other networks', async () => {
    const r = await send('/login', { ip: '203.0.113.5', headers: { 'cf-visitor': '{"scheme":"http"}' } })
    expect(r.status).toBe(308)
    expect(r.headers.get('location')).toBe(`${PUB}/login`)
    expect((await send('/api/auth/logout', { method: 'POST', ip: '203.0.113.5', origin: `http://${HOST}`, headers: { 'cf-visitor': '{"scheme":"http"}' } })).status).toBe(403)
    h.ctx.config.tunnel = { host: HOST, allowFrom: ['198.51.100.0/24'], countries: [] }
    try {
      expect((await send('/api/health', { ip: '203.0.113.5' })).status).toBe(403)
      expect((await send('/api/health', { ip: '198.51.100.5' })).status).toBe(200)
      // the Mac and the LAN are not affected by the internet allow-list
      expect((await send('/api/health', { host: 'localhost:47830' })).status).toBe(200)
    } finally { h.ctx.config.tunnel = { host: HOST, allowFrom: [], countries: [] } }
  })

  test('health on the internet address, signed out: liveness only, no version / schema / uptime (attack review finding 1)', async () => {
    const pub = await (await send('/api/health', { ip: '203.0.113.5' })).json() as Record<string, unknown>
    expect(pub.ok).toBe(true)
    expect(typeof pub.time).toBe('string')
    expect(Object.keys(pub).sort()).toEqual(['ok', 'time'])
    // the Mac itself and the office LAN keep the full answer (menubar, update check)
    const local = await (await send('/api/health', { host: 'localhost:47830' })).json() as Record<string, unknown>
    expect(typeof local.version).toBe('string')
    expect(local.schema).toBeTruthy()
    const lan = await (await send('/api/health', { port: 8443, peer: '192.168.1.50', host: '192.168.1.18:8443' })).json() as Record<string, unknown>
    expect(typeof lan.version).toBe('string')
    // a signed-in person on the internet address sees it too
    const ok = await send('/api/auth/login', { method: 'POST', ip: '198.51.100.40', origin: PUB, body: { username: 'director', password: OWNER_PW } })
    const signed = await (await send('/api/health', { ip: '198.51.100.40', cookie: cookieOf(ok) })).json() as Record<string, unknown>
    expect(typeof signed.version).toBe('string')
  })

  test('sign-ins through the internet address are marked via "internet" in the audit log; the Mac stays "direct" (do-it review 5)', async () => {
    await send('/api/auth/login', { method: 'POST', ip: '198.51.100.41', origin: PUB, body: { username: 'director', password: 'wrong wrong wrong' } })
    const pubRow = JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login_failed' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }).detail)
    expect(pubRow).toMatchObject({ ip: '198.51.100.41', via: 'internet' })
    await send('/api/auth/login', { method: 'POST', host: 'localhost:47830', origin: 'http://localhost:47830', body: { username: 'director', password: 'wrong wrong wrong' } })
    const macRow = JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login_failed' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }).detail)
    expect(macRow).toMatchObject({ ip: '127.0.0.1', via: 'direct' })
  })

  test('guessing invite / reset tokens through the internet address is limited per visitor IP (attack review finding 5)', async () => {
    let limited = false
    for (let i = 0; i < 60 && !limited; i++) {
      const r = await send(`/api/invites/${'x'.repeat(30)}${i}`, { ip: '192.0.2.90' })
      limited = r.status === 429
    }
    expect(limited).toBe(true)
    expect((await send(`/api/password-resets/${'y'.repeat(32)}`, { ip: '192.0.2.90' })).status).toBe(429)
    // another visitor still gets a plain "not found"
    expect((await send(`/api/invites/${'x'.repeat(32)}`, { ip: '192.0.2.91' })).status).toBe(404)
  })

  test('every request body fits Cloudflare\'s 100 MB limit: bigger files go through 8 MB chunks', () => {
    const CF_LIMIT = 100 * 1000 * 1000
    expect(SMALL_UPLOAD_MAX + 1024 * 1024).toBeLessThan(CF_LIMIT) // main.ts maxRequestBodySize
    expect(UPLOAD_CHUNK_SIZE).toBeLessThan(CF_LIMIT)
  })
})

describe('office settings with an internet address', () => {
  test('TEAMAX_PUBLIC_HOST and the allow-lists: parsed, checked, written back', () => {
    expect(parsePublicHost('')).toBeNull()
    expect(parsePublicHost(' https://app.example.com/ ')).toBe('app.example.com')
    for (const bad of ['192.168.1.1', 'localhost', 'a b.com', 'http://x', '-x.com', 'x.com:443']) expect(() => parsePublicHost(bad)).toThrow()
    expect(parseCountries('kr, jp')).toEqual(['KR', 'JP'])
    expect(() => parseCountries('KOR')).toThrow()
    const s = settingsFrom(path.join(BASE, 'h1'), { TEAMAX_PUBLIC_HOST: HOST, TEAMAX_PUBLIC_ALLOW_FROM: '198.51.100.0/24', TEAMAX_PUBLIC_COUNTRIES: 'KR' })
    expect(s.publicHost).toBe(HOST)
    expect(s.publicAllowFrom).toEqual(['198.51.100.0/24'])
    expect(s.publicCountries).toEqual(['KR'])
    expect(settingsText(s)).toContain(`TEAMAX_PUBLIC_HOST=${HOST}`)
    expect(settingsFrom(path.join(BASE, 'h1'), {}).publicHost).toBeNull()
    expect(tunnelLabel(s)).toBe('app.team-ax.office.tunnel')
  })

  test('server.json: the internet origin first (links), the tunnel block, LAN unchanged; the server reads it back', () => {
    const home = path.join(BASE, 'h2')
    const s = settingsFrom(home, { TEAMAX_PUBLIC_HOST: HOST })
    const cfg = serverConfig(s, { dns: ['mini.local'], ips: ['192.168.1.18'] }, [['192.168.1.0', '255.255.255.0']])
    expect(cfg.publicOrigins[0]).toBe(PUB)
    expect(cfg.tunnel).toEqual({ host: HOST, allowFrom: [], countries: [] })
    expect(cfg.allowedHosts).not.toContain(HOST) // only the tunnel path answers it (no port in that Host)
    expect(cfg.listen).toEqual({ host: '127.0.0.1', port: 47830 })
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify(cfg))
    const back = loadAppConfig({ argv: ['--config', path.join(home, 'server.json')], env: {} })
    expect(back.tunnel).toEqual({ host: HOST, allowFrom: [], countries: [] })
    expect(serverConfig(settingsFrom(home, {}), { dns: ['mini.local'], ips: ['192.168.1.18'] }).tunnel).toBeNull()
    fs.writeFileSync(path.join(home, 'bad.json'), JSON.stringify({ ...cfg, tunnel: { host: 'Not A Host' } }))
    expect(() => loadAppConfig({ argv: ['--config', path.join(home, 'bad.json')], env: {} })).toThrow(/tunnel.host/)
  })

  test('the connector token: checked, stored 600, never on the command line; a wrong file is refused', () => {
    const home = path.join(BASE, 'h3')
    const tf = path.join(BASE, 'token.txt')
    fs.writeFileSync(tf, fakeToken() + '\n')
    expect(readTunnelToken(tf)).toBe(fakeToken())
    expect(tunnelIdOf(fakeToken())).toBe(TUNNEL_ID)
    const bad = path.join(BASE, 'cert.pem')
    fs.writeFileSync(bad, '-----BEGIN ARGO TUNNEL TOKEN-----\nabc\n-----END ARGO TUNNEL TOKEN-----\n')
    expect(() => readTunnelToken(bad)).toThrow(/not a Cloudflare Tunnel connector token/)
    expect(() => configure(home, ['--tunnel-token-file', tf])).toThrow(/--public-host/)
    configure(home, ['--public-host', HOST, '--tunnel-token-file', tf])
    const p = officePaths(home)
    expect(fs.readFileSync(p.tunnelToken, 'utf8')).toBe(fakeToken())
    expect(mode(p.tunnelToken)).toBe(0o600)
    expect(mode(p.config)).toBe(0o700)
    expect(loadSettings(home).publicHost).toBe(HOST)
    const pl = tunnelPlist(loadSettings(home))
    expect(pl).toContain('<string>--token-file</string>')
    expect(pl).toContain(p.tunnelToken)
    expect(pl).toContain('<string>--no-autoupdate</string>')
    expect(pl).toContain('<string>app.team-ax.office.tunnel</string>')
    expect(pl).toContain('<key>KeepAlive</key><true/>')
    expect(pl).not.toContain(fakeToken())
    // off: the name is cleared (the token file is removed by `teamax public-address off`)
    configure(home, ['--public-host', ''])
    expect(loadSettings(home).publicHost).toBeNull()
  })

  test('teamax public-address tells a tunnel pointing at the wrong port (502) from a missing connector (530) (do-it review 1)', async () => {
    expect(classifyPublic(200)).toBe('ok')
    expect(classifyPublic(502)).toBe('origin')
    expect(classifyPublic(504)).toBe('origin')
    expect(classifyPublic(530)).toBe('tunnel')
    expect(classifyPublic(null)).toBe('none')
    const s = { publicHost: HOST, appPort: 47931 }
    const wrongPort = publicProblem(s, 'origin', '/x/tunnel.log')
    expect(wrongPort).toContain('502')
    expect(wrongPort).toContain(`public-address.ts set ${HOST} --port 47931`)
    expect(publicProblem(s, 'tunnel', '/x/tunnel.log')).toContain('530')
    // a busy app port: the hint says the tunnel must follow the new port
    const busy = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    try {
      const p = await portProblems({ appPort: busy.port, lanPort: busy.port, helperPort: 0 })
      expect(p.join('\n')).toContain('--port <that port>')
    } finally { busy.stop(true) }
  })

  test('the desk card puts the internet address first and keeps the LAN steps as the fallback', () => {
    const st = { caPem: '', caDer: new Uint8Array(), sha256: 'AA', sha1: 'BB'.repeat(10), origins: [LAN], caName: 'x' }
    const card = deskCard(st, { helper: 'http://192.168.1.18:8442', caCer: '/x/ca.cer', made: 'now', public: PUB })
    expect(card.indexOf(PUB)).toBeGreaterThan(0)
    expect(card.indexOf(PUB)).toBeLessThan(card.indexOf('인증서 받기'))
    expect(card).toContain('사무실 안 대체 경로')
    expect(deskCard(st, { helper: null, caCer: '/x/ca.cer', made: 'now' })).not.toContain('인터넷 주소')
  })
})

// ---- scripts/office/public-address.ts against a mocked Cloudflare API ----------------------------------------------

interface FakeCf { api: Api; calls: string[]; dns: { id: string; type: string; name: string; content: string; proxied: boolean }[]; tunnels: { id: string; name: string; config_src: string; deleted_at: string | null; config: any }[] }
function fakeCloudflare(): FakeCf {
  const f: FakeCf = {
    calls: [],
    dns: [
      { id: 'r-apex', type: 'AAAA', name: 'clinic-test.example', content: '100::', proxied: true },
      { id: 'r-www', type: 'CNAME', name: 'www.clinic-test.example', content: 'clinic-test.example', proxied: true },
      { id: 'r-mx', type: 'MX', name: 'mail.clinic-test.example', content: 'mx.example', proxied: false },
    ],
    tunnels: [],
    api: null as unknown as Api,
  }
  let n = 0
  f.api = async (method, p, body: any) => {
    f.calls.push(`${method} ${p}`)
    const u = new URL('https://x' + p)
    let m: RegExpExecArray | null
    if (method === 'GET' && (m = /^\/zones\/(\w+)$/.exec(u.pathname))) return { id: m[1], name: 'clinic-test.example', account: { id: 'acc1' } }
    if (method === 'GET' && u.pathname === '/zones') return u.searchParams.get('name') === 'clinic-test.example' ? [{ id: 'z1', name: 'clinic-test.example', account: { id: 'acc1' } }] : []
    if ((m = /^\/zones\/z1\/dns_records(?:\/([\w-]+))?$/.exec(u.pathname))) {
      if (method === 'GET') return f.dns.filter((r) => r.name === u.searchParams.get('name'))
      if (method === 'POST') { const r = { id: `r${++n}`, ...body }; f.dns.push(r); return r }
      const i = f.dns.findIndex((r) => r.id === m![1])
      if (i < 0) throw new Error('no such record')
      if (method === 'PATCH') { Object.assign(f.dns[i]!, body); return f.dns[i] }
      if (method === 'DELETE') { f.dns.splice(i, 1); return { id: m[1] } }
    }
    if ((m = /^\/accounts\/acc1\/cfd_tunnel(?:\/([\w-]+))?(?:\/(configurations|token|connections))?$/.exec(u.pathname))) {
      const t = m[1] ? f.tunnels.find((x) => x.id === m![1] && !x.deleted_at) : undefined
      if (!m[1] && method === 'GET') return f.tunnels.filter((x) => !x.deleted_at && x.name === u.searchParams.get('name'))
      if (!m[1] && method === 'POST') { const id = `aaaaaaaa-bbbb-4ccc-8ddd-${String(++n).padStart(12, '0')}`; const x = { id, name: body.name, config_src: body.config_src, deleted_at: null, config: null }; f.tunnels.push(x); return x }
      if (!t) throw new Error('tunnel not found')
      if (m[2] === 'configurations' && method === 'GET') return { config: t.config }
      if (m[2] === 'configurations' && method === 'PUT') { t.config = body.config; return { config: t.config } }
      if (m[2] === 'token') return fakeToken(t.id)
      if (m[2] === 'connections') return null
      if (!m[2] && method === 'GET') return t
      if (!m[2] && method === 'DELETE') { t.deleted_at = 'now'; return t }
    }
    throw new Error(`unexpected ${method} ${p}`)
  }
  return f
}
const writes = (f: FakeCf) => f.calls.filter((c) => !c.startsWith('GET'))
const cred = { zoneId: 'z1', accountId: 'acc1' }

describe('public-address.ts (mocked Cloudflare API)', () => {
  const tokenOut = path.join(BASE, 'pa', 'app.tunnel-token')

  test('refusal rules: the apex, any non-tunnel record, a CNAME to somewhere else, a name outside the zone', async () => {
    const f = fakeCloudflare()
    await expect(setAddress(f.api, cred, { host: 'clinic-test.example', tokenOut })).rejects.toThrow(/zone apex/)
    await expect(setAddress(f.api, cred, { host: 'www.clinic-test.example', tokenOut })).rejects.toThrow(/already has CNAME/)
    await expect(setAddress(f.api, cred, { host: 'mail.clinic-test.example', tokenOut })).rejects.toThrow(/already has MX/)
    await expect(setAddress(f.api, cred, { host: 'app.other.example', tokenOut })).rejects.toThrow(/not in clinic-test.example/)
    await expect(setAddress(f.api, cred, { host: 'not a name', tokenOut })).rejects.toBeInstanceOf(Refused)
    await expect(removeAddress(f.api, cred, { host: 'www.clinic-test.example' })).rejects.toThrow(/already has CNAME/)
    await expect(removeAddress(f.api, cred, { host: 'clinic-test.example' })).rejects.toThrow(/zone apex/)
    expect(writes(f)).toEqual([]) // nothing was changed by any refusal
    expect(() => checkRecords('x.clinic-test.example', { name: 'clinic-test.example' }, [{ id: '1', type: 'A', name: 'x.clinic-test.example', content: '1.2.3.4' }], {})).toThrow(Refused)
    expect(normHost('https://App.Clinic-Test.Example/')).toBe('app.clinic-test.example')
  })

  test('set: creates the tunnel, its ingress (app port, Host, 404 last) and ONLY that name\'s proxied CNAME; token file 600', async () => {
    const f = fakeCloudflare()
    const before = JSON.stringify(f.dns)
    const r = await setAddress(f.api, cred, { host: HOST, tokenOut })
    expect(r.created).toBe(true)
    expect(r.dns).toBe('created')
    const t = f.tunnels[0]!
    expect(t.name).toBe('teamax-app-clinic-test-example')
    expect(t.config_src).toBe('cloudflare')
    expect(t.config.ingress).toEqual([{ hostname: HOST, service: 'http://127.0.0.1:47830', originRequest: { httpHostHeader: HOST } }, { service: 'http_status:404' }])
    const rec = f.dns.find((x) => x.name === HOST)!
    expect(rec).toMatchObject({ type: 'CNAME', content: `${t.id}.cfargotunnel.com`, proxied: true })
    expect(JSON.stringify(f.dns.filter((x) => x.name !== HOST))).toBe(before) // the other records are untouched
    expect(fs.readFileSync(tokenOut, 'utf8')).toBe(fakeToken(t.id))
    expect(mode(tokenOut)).toBe(0o600)
    // again: nothing to change, same tunnel; another port only repoints the ingress
    const again = await setAddress(f.api, cred, { host: HOST, tokenOut })
    expect(again.actions).toEqual([])
    expect(again.tunnelId).toBe(t.id)
    const n = writes(f).length
    await setAddress(f.api, cred, { host: HOST, tokenOut, port: 28430 })
    expect(writes(f).slice(n).every((c) => c.includes('/configurations'))).toBe(true)
    expect(t.config.ingress[0].service).toBe('http://127.0.0.1:28430')
    // --dry-run changes nothing
    const g = fakeCloudflare()
    const dry = await setAddress(g.api, cred, { host: HOST, dryRun: true })
    expect(dry.actions.length).toBe(3)
    expect(writes(g)).toEqual([])
  })

  test('set reuses the tunnel an existing CNAME points to (repointing a placeholder), and keeps other names\' rules', async () => {
    const f = fakeCloudflare()
    const id = 'abcdabcd-1111-4222-8333-944455556666'
    f.tunnels.push({ id, name: 'teamax-office-app', config_src: 'cloudflare', deleted_at: null, config: { ingress: [{ hostname: HOST, service: 'http://127.0.0.1:19100', originRequest: {} }, { hostname: 'other.clinic-test.example', service: 'http://127.0.0.1:9000' }, { service: 'http_status:404' }], 'warp-routing': { enabled: false } } })
    f.dns.push({ id: 'r-app', type: 'CNAME', name: HOST, content: `${id}.cfargotunnel.com`, proxied: true })
    const r = await setAddress(f.api, cred, { host: HOST, tokenOut })
    expect(r.created).toBe(false)
    expect(r.dns).toBe('unchanged')
    expect(r.tunnelName).toBe('teamax-office-app')
    const cfg = f.tunnels[0]!.config
    expect(cfg.ingress[0]).toEqual({ hostname: HOST, service: 'http://127.0.0.1:47830', originRequest: { httpHostHeader: HOST } })
    expect(cfg.ingress[1].hostname).toBe('other.clinic-test.example')
    expect(cfg.ingress.at(-1)).toEqual({ service: 'http_status:404' })
    expect(cfg['warp-routing']).toEqual({ enabled: false })
    await expect(setAddress(f.api, cred, { host: HOST, tokenOut, tunnel: 'someone-else' })).rejects.toThrow(/already points to the tunnel/)
    expect(ingressFor(HOST, 47830, []).length).toBe(2)
    // Cloudflare hands the rules back with their keys reordered (service first): a second run changes nothing
    f.tunnels[0]!.config.ingress = f.tunnels[0]!.config.ingress.map((r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).reverse()))
    const again = await setAddress(f.api, cred, { host: HOST, tokenOut, dryRun: true })
    expect(again.actions).toEqual([])
    expect(sameJson({ a: 1, b: [{ c: 2, d: 3 }] }, { b: [{ d: 3, c: 2 }], a: 1 })).toBe(true)
    expect(sameJson([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }])).toBe(false)
  })

  test('remove: deletes only that CNAME and the tunnel (when no other name uses it) and the local token', async () => {
    const f = fakeCloudflare()
    await setAddress(f.api, cred, { host: HOST, tokenOut })
    const r = await removeAddress(f.api, cred, { host: HOST, tokenOut })
    expect(r.actions.join('\n')).toMatch(/delete CNAME/)
    expect(f.dns.find((x) => x.name === HOST)).toBeUndefined()
    expect(f.dns.map((x) => x.id)).toEqual(['r-apex', 'r-www', 'r-mx'])
    expect(f.tunnels[0]!.deleted_at).toBe('now')
    expect(f.calls).toContain(`DELETE /accounts/acc1/cfd_tunnel/${f.tunnels[0]!.id}/connections`)
    expect(fs.existsSync(tokenOut)).toBe(false)
    // a tunnel another name still uses is kept, without this name
    const g = fakeCloudflare()
    await setAddress(g.api, cred, { host: HOST, tokenOut, tunnel: 'shared' })
    await setAddress(g.api, cred, { host: 'b.clinic-test.example', tokenOut: tokenOut + '2', tunnel: 'shared' })
    await removeAddress(g.api, cred, { host: HOST, tokenOut })
    expect(g.tunnels[0]!.deleted_at).toBeNull()
    expect(g.tunnels[0]!.config.ingress.map((x: { hostname?: string }) => x.hostname ?? '*')).toEqual(['b.clinic-test.example', '*'])
  })

  test('command line: one credential, never printed; a refusal exits 3 with nothing changed', async () => {
    const certFile = path.join(BASE, 'cert-test.pem')
    const secret = 'SECRET-API-TOKEN-0123456789abcdefghij'
    fs.writeFileSync(certFile, `-----BEGIN ARGO TUNNEL TOKEN-----\n${Buffer.from(JSON.stringify({ zoneID: 'z1', accountID: 'acc1', apiToken: secret })).toString('base64')}\n-----END ARGO TUNNEL TOKEN-----\n`)
    expect(readCert(certFile)).toEqual({ apiToken: secret, zoneId: 'z1', accountId: 'acc1' })
    const f = fakeCloudflare()
    const out: string[] = []
    const log = console.log, err = console.error
    console.log = (...a: unknown[]) => { out.push(a.join(' ')) }
    console.error = (...a: unknown[]) => { out.push(a.join(' ')) }
    try {
      let seen = ''
      expect(await publicAddressMain(['set', 'clinic-test.example', '--cert', certFile], (c) => { seen = c.apiToken; return f.api })).toBe(3)
      expect(seen).toBe(secret)
      expect(await publicAddressMain(['set', HOST, '--cert', certFile, '--token-out', path.join(BASE, 'cli.token')], () => f.api)).toBe(0)
      expect(await publicAddressMain(['set', HOST], () => f.api)).toBe(2)
    } finally { console.log = log; console.error = err }
    const text = out.join('\n')
    expect(text).not.toContain(secret)
    expect(text).not.toContain(fakeToken(f.tunnels[0]!.id))
    expect(text).toContain('teamax public-address set app.clinic-test.example')
    expect(mode(path.join(BASE, 'cli.token'))).toBe(0o600)
  })
})
