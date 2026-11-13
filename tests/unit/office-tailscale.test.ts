// Office mode's Tailscale address (docs/OFFICE.md "Tailscale 주소", server/src/office/tailscale.ts): settings parsing,
// `tailscale status` / `serve status` reading, the peer and Host check of the Tailscale listener, requests on it
// treated as from outside the office (no first-run setup, signed-out health, internet sign-in limits), the
// certificate renewal (fake `tailscale cert`, injected clock), the listener reload, and `teamax tailscale-address`.
// The real run on a Mac with Tailscale: see the PR description (Mac mini, office 0.5.1 home).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { loadAppConfig } from '../../server/src/app-config'
import { hostAllowed, originsFor, tailnetHostAllowed, tailnetOriginOf } from '../../server/src/http/middleware'
import { directFetch, fromOutside } from '../../server/src/http/tunnel'
import { readPair, tailnetListener, type Serve } from '../../server/src/http/tailnet-listener'
import { peerIp } from '../../server/src/main'
import { portProblems, tailnetCertStep, tailnetNode, tailscaleAddress } from '../../server/src/office/cli'
import { loadSettings, officePaths, parseTailscaleHost, serverConfig, settingsFrom, settingsText, tailnetOrigin } from '../../server/src/office/settings'
import {
  certCheckDue, findTailscaleBin, inTailnetV4, pairProblem, parseStatus, refreshTailnetCert, servePorts, tailnetCertPaths,
  TAILNET_CERT_CHECK_MS, type Run,
} from '../../server/src/office/tailscale'
import { viaOf } from '../../server/src/auth/accounts'
import { harness, OWNER_PW, SETUP_TOKEN, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const TS = 'mini.tail1234.ts.net'
const TS_IP = '100.98.13.58'
const BASE = path.join(WORK, 'office-ts')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const NAMES = { dns: ['mini.local'], ips: ['192.168.1.18'] }
const NET: [string, string][] = [['192.168.1.0', '255.255.255.0']]
const DAY = 86400_000

/** a self-signed EC certificate for `name`, valid `days` days from now (the full "chain" is this one certificate) */
function makeCert(dir: string, name: string, days: number): { crt: string; key: string } {
  fs.mkdirSync(dir, { recursive: true })
  const key = path.join(dir, `${name}-${days}.key`), crt = path.join(dir, `${name}-${days}.crt`)
  const run = (a: string[]) => { const p = Bun.spawnSync(['/usr/bin/openssl', ...a], { stderr: 'pipe' }); if (p.exitCode !== 0) throw new Error(p.stderr.toString()) }
  run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key])
  run(['req', '-new', '-x509', '-sha256', '-key', key, '-days', String(days), '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-out', crt])
  return { crt: fs.readFileSync(crt, 'utf8'), key: fs.readFileSync(key, 'utf8') }
}

/** a fake Tailscale CLI: status / serve status answers, and `cert` writes the given pair to --cert-file / --key-file */
function fakeTs(o: { status?: object; serve?: object; pair?: () => { crt: string; key: string } | null; calls?: string[][] } = {}): Run {
  return (args) => {
    o.calls?.push(args)
    if (args[0] === 'status') return { code: 0, out: JSON.stringify(o.status ?? STATUS), err: '' }
    if (args[0] === 'serve') return { code: 0, out: JSON.stringify(o.serve ?? {}), err: '' }
    if (args[0] === 'cert') {
      const pair = o.pair?.()
      if (!pair) return { code: 1, out: '', err: 'error: 500 Internal Server Error: acme: rate limited' }
      fs.writeFileSync(args[args.indexOf('--cert-file') + 1]!, pair.crt)
      fs.writeFileSync(args[args.indexOf('--key-file') + 1]!, pair.key)
      return { code: 0, out: '', err: '' }
    }
    return { code: 2, out: '', err: 'unknown' }
  }
}
const STATUS = {
  BackendState: 'Running', TailscaleIPs: [TS_IP, 'fd7a:115c:a1e0::6136:d3a'], CertDomains: [TS],
  Self: { DNSName: `${TS}.`, TailscaleIPs: [TS_IP], Capabilities: ['https', 'funnel'] },
}

describe('settings', () => {
  test('TEAMAX_TAILSCALE_HOST: a *.ts.net name; the port defaults to the LAN port + 1; written back', () => {
    expect(parseTailscaleHost('')).toBeNull()
    expect(parseTailscaleHost(' https://Mini.Tail1234.TS.net./ ')).toBe(TS)
    for (const bad of ['example.com', 'mini.ts.net', 'a.b.c.ts.net', '100.98.13.58', 'mini.tail1234.ts.net:443', '-x.tail.ts.net']) expect(() => parseTailscaleHost(bad)).toThrow()
    const s = settingsFrom(path.join(BASE, 'h1'), { TEAMAX_TAILSCALE_HOST: TS, TEAMAX_LAN_PORT: '9443' })
    expect(s.tailscaleHost).toBe(TS)
    expect(s.tailscalePort).toBe(9444)
    expect(tailnetOrigin(s)).toBe(`https://${TS}:9444`)
    expect(tailnetOrigin({ tailscaleHost: TS, tailscalePort: 443 })).toBe(`https://${TS}`)
    const text = settingsText(s)
    expect(text).toContain(`TEAMAX_TAILSCALE_HOST=${TS}`)
    expect(text).toContain('TEAMAX_TAILSCALE_PORT=9444')
    expect(settingsFrom(path.join(BASE, 'h1'), { TEAMAX_TAILSCALE_HOST: TS, TEAMAX_TAILSCALE_PORT: '443' }).tailscalePort).toBe(443)
  })

  test('the Tailscale port must differ from the other ports (only when the address is on)', () => {
    expect(() => settingsFrom(path.join(BASE, 'h1'), { TEAMAX_TAILSCALE_HOST: TS, TEAMAX_TAILSCALE_PORT: '8443' })).toThrow(/TEAMAX_TAILSCALE_PORT/)
    expect(() => settingsFrom(path.join(BASE, 'h1'), { TEAMAX_TAILSCALE_PORT: '8443' })).not.toThrow()
    expect(() => settingsFrom(path.join(BASE, 'h1'), { TEAMAX_TAILSCALE_HOST: TS, TEAMAX_TAILSCALE_PORT: '70000' })).toThrow()
  })

  test('defaults unchanged: no Tailscale setting gives the same server.json as before (no tailnet key, same hosts, peers, origins)', () => {
    const s = settingsFrom(path.join(BASE, 'h2'), {})
    expect(s.tailscaleHost).toBeNull()
    expect(settingsText(s)).toContain('TEAMAX_TAILSCALE_HOST=\n')
    expect(settingsText(s)).toContain('TEAMAX_TAILSCALE_PORT=\n')
    const cfg = serverConfig(s, NAMES, NET, TS_IP)
    expect('tailnet' in cfg).toBe(false)
    expect(cfg.allowedHosts).toEqual(['mini.local:8443', '192.168.1.18:8443', 'localhost:47830', '127.0.0.1:47830'])
    expect(cfg.allowedPeers).toEqual(['192.168.1.0/24'])
    expect(cfg.publicOrigins).toEqual(['https://192.168.1.18:8443', 'https://mini.local:8443', 'http://localhost:47830', 'http://127.0.0.1:47830'])
  })

  test('server.json with the address: the tailnet block bound to the Tailscale IPv4, its origin after the internet one, LAN unchanged; read back', () => {
    const home = path.join(BASE, 'h3')
    const s = settingsFrom(home, { TEAMAX_TAILSCALE_HOST: TS, TEAMAX_PUBLIC_HOST: 'app.example.com' })
    const cfg = serverConfig(s, NAMES, NET, TS_IP)
    expect(cfg.tailnet).toEqual({ host: TS, port: 8444, bind: TS_IP, certFile: path.join(home, 'tls', 'tailnet.crt'), keyFile: path.join(home, 'tls', 'tailnet.key') })
    expect(cfg.publicOrigins.slice(0, 3)).toEqual(['https://app.example.com', `https://${TS}:8444`, 'https://192.168.1.18:8443'])
    // never on the LAN port's lists: the office port does not answer the Tailscale name or a tailnet peer
    expect(cfg.allowedHosts.some((h) => h.includes('ts.net'))).toBe(false)
    expect(cfg.allowedPeers).toEqual(['192.168.1.0/24'])
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify(cfg))
    expect(loadAppConfig({ argv: ['--config', path.join(home, 'server.json')], env: {} }).tailnet).toEqual(cfg.tailnet)
    // Tailscale not up yet: no address to bind, still a valid file
    fs.writeFileSync(path.join(home, 'nobind.json'), JSON.stringify(serverConfig(s, NAMES, NET, null)))
    expect(loadAppConfig({ argv: ['--config', path.join(home, 'nobind.json')], env: {} }).tailnet?.bind).toBeNull()
    fs.writeFileSync(path.join(home, 'bad.json'), JSON.stringify({ ...cfg, tailnet: { ...cfg.tailnet, bind: '0.0.0.0' } }))
    expect(() => loadAppConfig({ argv: ['--config', path.join(home, 'bad.json')], env: {} })).toThrow(/tailnet.bind/)
  })
})

describe('tailscale status', () => {
  test('the certificate name, the IPv4 address and the HTTPS capability', () => {
    expect(parseStatus(JSON.stringify(STATUS))).toEqual({ certName: TS, ipv4: TS_IP, running: true, problem: null })
    expect(parseStatus(JSON.stringify({ ...STATUS, BackendState: 'Stopped' })).problem).toMatch(/not connected/)
    expect(parseStatus(JSON.stringify({ ...STATUS, CertDomains: null, Self: { ...STATUS.Self, Capabilities: [] } })).problem).toMatch(/HTTPS Certificates/)
    expect(parseStatus('not json').problem).toMatch(/no JSON/)
    expect(inTailnetV4('100.64.0.1')).toBe(true)
    expect(inTailnetV4('100.127.255.255')).toBe(true)
    expect(inTailnetV4('100.128.0.1')).toBe(false)
    expect(inTailnetV4('100.63.0.1')).toBe(false)
  })

  test('the ports `tailscale serve` / Funnel hold, and the CLI search order', () => {
    expect(servePorts(JSON.stringify({ TCP: { '443': { HTTPS: true }, '8443': {} }, Web: {} }))).toEqual([443, 8443])
    expect(servePorts('{}')).toEqual([])
    expect(findTailscaleBin({ exists: (f) => f === '/opt/homebrew/bin/tailscale' })).toBe('/opt/homebrew/bin/tailscale')
    expect(findTailscaleBin({ exists: () => true })).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
    expect(findTailscaleBin({ configured: '/x/tailscale', exists: () => false })).toBeNull()
    expect(findTailscaleBin({ exists: () => false })).toBeNull()
  })

  test('a renamed Mac (another certificate name) or no CLI is a problem the supervisor reports', () => {
    const s = { tailscaleHost: TS, tailscaleBin: null }
    expect(tailnetNode(s, fakeTs())?.problem).toBeNull()
    expect(tailnetNode(s, fakeTs({ status: { ...STATUS, CertDomains: ['other.tail1234.ts.net'] } }))?.problem).toMatch(/now other\.tail1234\.ts\.net/)
    expect(tailnetNode(s, null)?.problem).toMatch(/CLI was not found/)
    expect(tailnetNode({ tailscaleHost: null, tailscaleBin: null }, fakeTs())).toBeNull()
  })

  test('check-ports: a port `tailscale serve` uses is refused', async () => {
    const bad = await portProblems({ appPort: 0, lanPort: 0, helperPort: 0, tailscaleHost: TS, tailscalePort: 8443 } as never, { servePorts: [443, 8443] })
    expect(bad.join('\n')).toMatch(/port 8443 is used by `tailscale serve`/)
  })
})

describe('the Tailscale listener: peers, Host, and requests from outside the office', () => {
  let h: Harness
  let onTs: ReturnType<typeof directFetch>
  let onLan: ReturnType<typeof directFetch>
  const ORIGIN = `https://${TS}:8444`
  const send = (fn: () => ReturnType<typeof directFetch>, p: string, o: { method?: string; host?: string; peer?: string; port?: number; origin?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const host = o.host ?? `${TS}:8444`
    const headers: Record<string, string> = { host, ...(o.headers ?? {}) }
    if (o.origin) headers.origin = o.origin
    if (o.method && o.method !== 'GET') headers['x-mycel-csrf'] = '1'
    if (o.body !== undefined) headers['content-type'] = 'application/json'
    const req = new Request(`https://${host}${p}`, { method: o.method ?? 'GET', headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) })
    return fn()(req, { requestIP: () => ({ address: o.peer ?? '100.101.1.2' }), port: o.port ?? 8444 }) as Promise<Response>
  }
  const ts = (p: string, o: Parameters<typeof send>[2] = {}) => send(() => onTs, p, o)

  beforeAll(async () => {
    h = await harness('office-ts', {
      office: true, listen: { host: '127.0.0.1', port: 47830 },
      tailnet: { host: TS, port: 8444, bind: TS_IP, certFile: '/nonexistent.crt', keyFile: '/nonexistent.key' },
      allowedHosts: ['192.168.1.18:8443', 'localhost:47830', '127.0.0.1:47830'], allowedPeers: ['192.168.1.0/24'],
      publicOrigins: [ORIGIN, 'https://192.168.1.18:8443', 'http://localhost:47830', 'http://127.0.0.1:47830'],
    })
    onTs = directFetch(h.ctx.config, (req, env) => h.app.fetch(req, env), peerIp, { tailnet: true })
    onLan = directFetch(h.ctx.config, (req, env) => h.app.fetch(req, env), peerIp)
  })
  afterAll(async () => { await h.close() })

  test('Host: only <name>:<port>, and the bare name on 443', () => {
    const t = { host: TS, port: 8444 }
    expect(tailnetHostAllowed(`${TS}:8444`, t)).toBe(true)
    expect(tailnetHostAllowed(`MINI.TAIL1234.TS.NET:8444`, t)).toBe(true)
    expect(tailnetHostAllowed(TS, t)).toBe(false)
    expect(tailnetHostAllowed(`${TS}:8443`, t)).toBe(false)
    expect(tailnetHostAllowed(`${TS_IP}:8444`, t)).toBe(false)
    expect(tailnetHostAllowed(`evil.example:8444`, t)).toBe(false)
    expect(tailnetHostAllowed(null, t)).toBe(false)
    expect(tailnetHostAllowed(TS, { host: TS, port: 443 })).toBe(true)
    expect(tailnetHostAllowed(`${TS}:443`, { host: TS, port: 443 })).toBe(true)
    expect(tailnetHostAllowed(TS, null)).toBe(false)
    expect(tailnetOriginOf({ host: TS, port: 443 })).toBe(`https://${TS}`)
  })

  test('tailnet peers with the right Host get in; others get 403 / 421; loopback is not a tailnet peer here', async () => {
    const ok = await ts('/api/health')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('strict-transport-security')).toBe('max-age=31536000')
    expect((await ts('/api/health', { peer: '192.168.1.50' })).status).toBe(403)
    expect((await ts('/api/health', { peer: '127.0.0.1' })).status).toBe(403)
    expect((await ts('/api/health', { peer: '100.128.0.1' })).status).toBe(403)
    expect((await ts('/api/health', { peer: 'fd7a:115c:a1e0::1' })).status).toBe(403)
    expect((await ts('/api/health', { host: `${TS_IP}:8444` })).status).toBe(421)
    expect((await ts('/api/health', { host: 'evil.example:8444' })).status).toBe(421)
    // the LAN port does not answer the Tailscale name, nor a tailnet peer (office-network only, as before)
    expect((await send(() => onLan, '/api/health', { port: 8443, peer: '192.168.1.50' })).status).toBe(421)
    expect((await send(() => onLan, '/api/health', { port: 8443, peer: '100.101.1.2', host: '192.168.1.18:8443' })).status).toBe(403)
    expect(hostAllowed(`${TS}:8444`, h.ctx.config.allowedHosts, 8444)).toBe(false)
  })

  test('Origins on the Tailscale listener: only its own origin', () => {
    expect(originsFor(h.ctx.config, { via: 'direct', port: 8444, tailnet: true })).toEqual([ORIGIN])
    expect(originsFor({ ...h.ctx.config, tailnet: { host: TS, port: 443, bind: TS_IP, certFile: '', keyFile: '' } }, { via: 'direct', port: 443, tailnet: true })).toEqual([`https://${TS}`])
    expect(originsFor({ ...h.ctx.config, tailnet: null }, { via: 'direct', port: 8444, tailnet: true })).toEqual([])
    expect(originsFor(h.ctx.config, { via: 'direct', port: 8443 })).toEqual(['https://192.168.1.18:8443'])
    expect(fromOutside({ tailnet: true })).toBe(true)
    expect(fromOutside({})).toBe(false)
    expect(viaOf({ via: 'direct', tailnet: true })).toBe('tailnet')
  })

  test('signed out: health says only "alive"; the first-run setup is refused even with the token; the Mac still can', async () => {
    const health = await (await ts('/api/health')).json() as Record<string, unknown>
    expect(Object.keys(health).sort()).toEqual(['ok', 'time'])
    const body = { setupToken: SETUP_TOKEN, teamName: 'Office', locale: 'ko', owner: { username: 'director', name: 'Dr', password: OWNER_PW } }
    const r = await ts('/api/setup', { method: 'POST', origin: ORIGIN, body })
    expect(r.status).toBe(403)
    expect(r.headers.get('set-cookie')).toBeNull()
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0)
    expect((await (await ts('/api/setup', { headers: { 'x-mycel-setup-token': SETUP_TOKEN } })).json() as { needed: boolean }).needed).toBe(false)
    const local = await send(() => onLan, '/api/setup', { method: 'POST', host: 'localhost:47830', port: 47830, peer: '127.0.0.1', origin: 'http://localhost:47830', body })
    expect(local.status).toBe(201)
  })

  test('sign-in on the Tailscale address: CSRF Origin is its origin, Secure __Host- cookie, audit via "tailnet"', async () => {
    const wrongOrigin = await ts('/api/auth/login', { method: 'POST', origin: 'https://192.168.1.18:8443', body: { username: 'director', password: OWNER_PW } })
    expect(wrongOrigin.status).toBe(403)
    const r = await ts('/api/auth/login', { method: 'POST', origin: ORIGIN, peer: '100.101.1.9', body: { username: 'director', password: OWNER_PW } })
    expect(r.status).toBe(200)
    expect(r.headers.getSetCookie().some((c) => c.startsWith('__Host-sid=') && /secure/i.test(c))).toBe(true)
    await ts('/api/auth/login', { method: 'POST', origin: ORIGIN, peer: '100.101.1.9', body: { username: 'director', password: 'wrong wrong wrong' } })
    const row = JSON.parse((h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login_failed' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }).detail)
    expect(row).toMatchObject({ ip: '100.101.1.9', via: 'tailnet' })
  })
})

describe('the certificate (fake tailscale cert, injected clock)', () => {
  const certs = path.join(BASE, 'certs')
  const now = new Date()
  let a: { crt: string; key: string }, b: { crt: string; key: string }, other: { crt: string; key: string }
  beforeAll(() => {
    a = makeCert(certs, TS, 60)
    b = makeCert(certs, TS, 90)
    other = makeCert(certs, 'other.tail1234.ts.net', 90)
  })

  test('pairProblem: the name, the key, the dates', () => {
    expect(pairProblem(a.crt, a.key, TS, now)).toBeNull()
    expect(pairProblem(a.crt, b.key, TS, now)).toMatch(/key does not belong/)
    expect(pairProblem(other.crt, other.key, TS, now)).toMatch(/not for/)
    expect(pairProblem(a.crt, a.key, TS, new Date(now.getTime() + 61 * DAY))).toMatch(/ended/)
    expect(pairProblem('junk', a.key, TS, now)).toMatch(/unreadable/)
  })

  test('first run writes the pair (key 600); the same answer changes nothing; a renewed one is put in place', () => {
    const dir = path.join(BASE, 'tls1'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    let give = a
    const r1 = refreshTailnetCert(dir, TS, fakeTs({ pair: () => give }), now)
    expect(r1).toMatchObject({ changed: true, ok: true, warning: null })
    expect(Math.round(r1.daysLeft!)).toBe(60)
    const p = tailnetCertPaths(dir)
    expect(fs.statSync(p.key).mode & 0o777).toBe(0o600)
    expect(refreshTailnetCert(dir, TS, fakeTs({ pair: () => give }), now).changed).toBe(false)
    give = b
    expect(refreshTailnetCert(dir, TS, fakeTs({ pair: () => give }), now)).toMatchObject({ changed: true, ok: true })
    expect(fs.readFileSync(p.crt, 'utf8')).toBe(b.crt)
    expect(fs.readdirSync(dir).filter((f) => f.includes('.new-'))).toEqual([]) // no temporary file left
  })

  test('a failed or wrong answer keeps the certificate in place and says why; few days left warns', () => {
    const dir = path.join(BASE, 'tls2'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    refreshTailnetCert(dir, TS, fakeTs({ pair: () => a }), now)
    const failed = refreshTailnetCert(dir, TS, fakeTs({ pair: () => null }), now)
    expect(failed).toMatchObject({ changed: false, ok: true })
    expect(failed.warning).toMatch(/rate limited.*60 days left|rate limited.*59 days left/)
    const wrong = refreshTailnetCert(dir, TS, fakeTs({ pair: () => other }), now)
    expect(wrong.changed).toBe(false)
    expect(wrong.warning).toMatch(/unusable certificate \(the certificate is not for/)
    expect(fs.readFileSync(tailnetCertPaths(dir).crt, 'utf8')).toBe(a.crt)
    // 55 days later Tailscale still gives the same one: 5 days left
    const late = refreshTailnetCert(dir, TS, fakeTs({ pair: () => a }), new Date(now.getTime() + 55 * DAY))
    expect(late.warning).toMatch(/ends in 4 days|ends in 5 days/)
    // no certificate at all and the CLI fails: not ok
    const empty = path.join(BASE, 'tls3'); fs.mkdirSync(empty, { recursive: true })
    expect(refreshTailnetCert(empty, TS, fakeTs({ pair: () => null }), now)).toMatchObject({ ok: false, changed: false })
  })

  test('when a check is due: a missing or bad pair at once, else every 12 hours; the supervisor step logs a renewal', () => {
    const home = path.join(BASE, 'home-step')
    const s = settingsFrom(home, { TEAMAX_TAILSCALE_HOST: TS })
    const dir = officePaths(home).tls; fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    expect(certCheckDue(dir, TS, Date.now(), now)).toBe(true) // missing
    const calls: string[][] = []
    const run = fakeTs({ pair: () => a, calls })
    const first = tailnetCertStep(s, run, 0, now)
    expect(first.checked).toBe(true)
    expect(first.line).toMatch(/written/)
    const t0 = now.getTime()
    expect(certCheckDue(dir, TS, t0, new Date(t0 + TAILNET_CERT_CHECK_MS - 1000))).toBe(false)
    expect(tailnetCertStep(s, run, t0, new Date(t0 + 3600_000))).toEqual({ line: '', checked: false })
    expect(certCheckDue(dir, TS, t0, new Date(t0 + TAILNET_CERT_CHECK_MS))).toBe(true)
    expect(calls.filter((c) => c[0] === 'cert').length).toBe(1)
    expect(tailnetCertStep({ ...s, tailscaleHost: null }, run, 0, now)).toEqual({ line: '', checked: false })
  })
})

describe('the listener reload (main.ts)', () => {
  test('waits for Tailscale and the certificate, starts, keeps a pair that does not match, reloads a new one', () => {
    const dir = path.join(BASE, 'listener'); fs.mkdirSync(dir, { recursive: true })
    const a = makeCert(dir, TS, 60), b = makeCert(dir, TS, 90)
    const crt = path.join(dir, 'tailnet.crt'), key = path.join(dir, 'tailnet.key')
    const started: { hostname: string; port: number; cert: string }[] = []
    let stopped = 0
    let failNext = false
    const serve: Serve = (o) => {
      if (failNext) { failNext = false; throw new Error('EADDRNOTAVAIL') }
      started.push({ hostname: o.hostname, port: o.port, cert: o.tls.cert })
      return { stop: () => { stopped++ } }
    }
    const log = { info() {}, warn() {} }
    expect(tailnetListener({ host: TS, port: 8444, bind: null, certFile: crt, keyFile: key }, serve, log).tick()).toBe('waiting')
    const l = tailnetListener({ host: TS, port: 8444, bind: TS_IP, certFile: crt, keyFile: key }, serve, log)
    expect(l.tick()).toBe('waiting') // no files yet
    fs.writeFileSync(crt, a.crt); fs.writeFileSync(key, a.key)
    failNext = true
    expect(l.tick()).toBe('waiting') // bind failed (Tailscale interface not up): tried again next time
    expect(l.up).toBe(false)
    expect(l.tick()).toBe('started')
    expect(started.at(-1)).toMatchObject({ hostname: TS_IP, port: 8444, cert: a.crt })
    expect(l.tick()).toBe('same')
    fs.writeFileSync(crt, b.crt) // the certificate before its key: not loaded
    expect(l.tick()).toBe('waiting')
    expect(l.up).toBe(true)
    fs.writeFileSync(key, b.key)
    expect(l.tick()).toBe('reloaded')
    expect(stopped).toBe(1)
    expect(started.at(-1)!.cert).toBe(b.crt)
    expect('problem' in readPair(crt, key)).toBe(false)
    l.stop()
  })
})

describe('teamax tailscale-address', () => {
  test('on: name from tailscale status, certificate first, settings written, server restarted; off removes it', async () => {
    const home = path.join(BASE, 'cmd')
    fs.mkdirSync(path.join(home, 'config'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config', 'office.env'), 'TEAMAX_LAN_PORT=9443\nTEAMAX_RUN_DIR=/tmp/ts-run\n')
    const pair = makeCert(path.join(BASE, 'certs'), TS, 80)
    const out: string[] = []
    let restarts = 0
    const o = { run: fakeTs({ pair: () => pair }), restart: async () => { restarts++ }, probe: async () => 'ok' as const, out: (l: string) => out.push(l) }
    expect(await tailscaleAddress(home, ['on'], o)).toBe(0)
    const s = loadSettings(home)
    expect(s.tailscaleHost).toBe(TS)
    expect(s.tailscalePort).toBe(9444)
    expect(s.lanPort).toBe(9443)
    expect(fs.readFileSync(tailnetCertPaths(officePaths(home).tls).crt, 'utf8')).toBe(pair.crt)
    expect(restarts).toBe(1)
    expect(out.join('\n')).toContain(`https://${TS}:9444`)
    expect(out.join('\n')).toMatch(/first-run setup is refused/)

    // a port `tailscale serve` holds is refused, nothing changes
    const busy = { ...o, run: fakeTs({ pair: () => pair, serve: { TCP: { '443': {} } } }) }
    expect(await tailscaleAddress(home, ['on', '--port', '443'], busy)).toBe(1)
    expect(loadSettings(home).tailscalePort).toBe(9444)

    // HTTPS off for the tailnet: a clear refusal, nothing written
    const home2 = path.join(BASE, 'cmd2')
    fs.mkdirSync(path.join(home2, 'config'), { recursive: true })
    fs.writeFileSync(path.join(home2, 'config', 'office.env'), 'TEAMAX_RUN_DIR=/tmp/ts-run\n')
    const off = { ...o, run: fakeTs({ status: { ...STATUS, CertDomains: null, Self: { ...STATUS.Self, Capabilities: [] } } }), out: (l: string) => out.push(l) }
    expect(await tailscaleAddress(home2, ['on'], off)).toBe(1)
    expect(out.at(-1)).toMatch(/HTTPS Certificates/)
    expect(loadSettings(home2).tailscaleHost).toBeNull()

    expect(await tailscaleAddress(home, ['off'], o)).toBe(0)
    expect(loadSettings(home).tailscaleHost).toBeNull()
    expect(fs.existsSync(tailnetCertPaths(officePaths(home).tls).key)).toBe(false)
    expect(restarts).toBe(2)
  })
})
