// Office mode (docs/OFFICE.md): the office CA and server certificate (names, regeneration, constraints), the
// settings and the server.json they produce, Host / Origin / cookie handling on the office address, the helper
// page's allow-list, the LaunchAgent, restore swap, and the installer's dry paths (no install, no LaunchAgent).
// The real install from the zip, over the LAN address with one real Claude turn, is tests/install/office-lan.mjs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadAppConfig } from '../../server/src/app-config'
import { sessionCookie } from '../../server/src/auth/service'
import { hostAllowed } from '../../server/src/http/middleware'
import { peerIp } from '../../server/src/main'
import { agentPlist, configure, helperOrigins, prepare, swapInRestore } from '../../server/src/office/cli'
import { HELPER_PATHS, helperFetch, type HelperState } from '../../server/src/office/helper'
import { allowedHosts, deskOrigins, officePaths, parseEnvFile, serverConfig, settingsFrom } from '../../server/src/office/settings'
import { certNames, dnsPermitted, ensureOfficeTls, ipPermitted, lanAddresses, normIp, PRIVATE_V4, PRIVATE_V6, serverCertProblem, tlsPaths, unstableV6, wantedNames } from '../../server/src/office/tls'
import { parseTeamAddress } from '../../desktop/src/common/address'
import { harness, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'office')
const REPO = path.resolve(import.meta.dir, '..', '..')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const C = { dns: ['local', 'mini'], v4: PRIVATE_V4, v6: PRIVATE_V6 }
const mode = (f: string) => fs.statSync(f).mode & 0o777
const openssl = (args: string[]) => Bun.spawnSync(['/usr/bin/openssl', ...args], { stdout: 'pipe', stderr: 'pipe' })

describe('office addresses and names', () => {
  const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false) => ({ address, family, internal, netmask: '', mac: '', cidr: null }) as os.NetworkInterfaceInfo
  test('LAN addresses: no loopback, link-local or rotating IPv6; office ranges before VPN ranges', () => {
    const ifaces = {
      lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)],
      en0: [iface('192.168.1.18', 'IPv4'), iface('fe80::1c17:7e97:bb9e:1c27', 'IPv6'), iface('fd00::5', 'IPv6'), iface('fd00::77', 'IPv6')],
      utun5: [iface('100.125.180.119', 'IPv4')],
      en7: [iface('169.254.3.4', 'IPv4'), iface('10.0.0.9', 'IPv4')],
    }
    const ifconfig = '\tinet6 fd00::5 prefixlen 64 autoconf secured \n\tinet6 fd00::77 prefixlen 64 autoconf temporary \n'
    expect(unstableV6(ifconfig)).toEqual(new Set(['fd00::77']))
    expect(lanAddresses({ ifaces, ifconfig })).toEqual(['192.168.1.18', '10.0.0.9', '100.125.180.119', 'fd00::5'])
  })

  test('the certificate names only what the CA may vouch for (private ranges, .local, the Mac name)', () => {
    for (const ip of ['192.168.0.1', '10.200.1.1', '172.31.255.1', '100.64.0.1', 'fd7a:115c::1', 'fc00::1']) expect(ipPermitted(ip, C)).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '100.128.0.1']) expect(ipPermitted(ip, C)).toBe(false)
    expect(dnsPermitted('mini.local', C)).toBe(true)
    expect(dnsPermitted('mini', C)).toBe(true)
    expect(dnsPermitted('evil.com', C)).toBe(false)
    expect(dnsPermitted('notmini', C)).toBe(false)
    const w = wantedNames('mini', ['192.168.1.18', '8.8.8.8', 'fd00::5', '2001:db8::1'], C)
    expect(w).toEqual({ dns: ['mini.local', 'mini'], ips: ['192.168.1.18', 'fd00::5'], left: ['8.8.8.8', '2001:db8::1'] })
    // a CA without constraints (TEAMAX_CA_CONSTRAINTS=0) names every address
    expect(wantedNames('mini', ['8.8.8.8'], { dns: [], v4: [], v6: [] }).ips).toEqual(['8.8.8.8'])
    expect(normIp('FD00:0:0:0:0:0:0:5')).toBe('fd00::5')
  })
})

describe('office CA and server certificate', () => {
  const dir = path.join(BASE, 'tls')
  let first: ReturnType<typeof ensureOfficeTls>
  beforeAll(() => { first = ensureOfficeTls(dir, { host: 'mini', addrs: ['192.168.1.18', 'fd00::5', '8.8.8.8'] }) })

  test('made once: CA key 600 in a 700 folder, server certificate for every name and address', () => {
    const p = tlsPaths(dir)
    expect(first.caMade).toBe(true)
    expect(first.changed).toBe(true)
    expect(mode(dir)).toBe(0o700)
    expect(mode(p.caKey)).toBe(0o600)
    expect(mode(p.key)).toBe(0o600)
    expect(certNames(first.cert)).toEqual({ dns: ['mini.local', 'mini'], ips: ['192.168.1.18', 'fd00::5'] })
    expect(first.left).toEqual(['8.8.8.8'])
    expect(first.cert.verify(first.ca.publicKey)).toBe(true)
    expect(first.ca.ca).toBe(true)
    // .cer = the same CA in DER (what Windows double-clicks)
    expect(Buffer.from(fs.readFileSync(p.caCer)).equals(Buffer.from(first.ca.raw))).toBe(true)
  })

  test('the CA is name-constrained, the server certificate is a TLS server certificate', () => {
    const ca = openssl(['x509', '-in', tlsPaths(dir).caCrt, '-noout', '-text']).stdout.toString()
    expect(ca).toMatch(/Name Constraints: critical/)
    expect(ca).toMatch(/DNS:local/)
    expect(ca).toMatch(/IP:192\.168\.0\.0\/255\.255\.0\.0/)
    expect(ca).toMatch(/CA:TRUE, pathlen:0/)
    const leaf = openssl(['x509', '-in', tlsPaths(dir).crt, '-noout', '-text']).stdout.toString()
    expect(leaf).toMatch(/TLS Web Server Authentication/)
    expect(leaf).toMatch(/CA:FALSE/)
    const v = openssl(['verify', '-CAfile', tlsPaths(dir).caCrt, tlsPaths(dir).crt])
    expect(v.stdout.toString()).toContain(': OK')
  })

  test('a certificate for a public name, signed with the same CA key, fails verification (constraints work)', () => {
    const d = path.join(BASE, 'evil')
    fs.mkdirSync(d, { recursive: true })
    const p = tlsPaths(dir)
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(d, 'k')])
    openssl(['req', '-new', '-key', path.join(d, 'k'), '-subj', '/CN=bank.example', '-out', path.join(d, 'csr')])
    fs.writeFileSync(path.join(d, 'ext'), 'subjectAltName=DNS:bank.example,IP:8.8.8.8\nextendedKeyUsage=serverAuth\n')
    openssl(['x509', '-req', '-in', path.join(d, 'csr'), '-CA', p.caCrt, '-CAkey', p.caKey, '-CAcreateserial', '-CAserial', path.join(d, 'srl'), '-days', '30', '-extfile', path.join(d, 'ext'), '-out', path.join(d, 'crt')])
    const v = openssl(['verify', '-CAfile', p.caCrt, path.join(d, 'crt')])
    expect(v.exitCode).not.toBe(0)
    expect(v.stdout.toString() + v.stderr.toString()).toMatch(/subtree violation/)
  })

  test.if(process.platform === 'darwin')('macOS trust evaluation accepts it for the LAN address and .local, not for another address', () => {
    const p = tlsPaths(dir)
    const ok = (host: string) => Bun.spawnSync(['/usr/bin/security', 'verify-cert', '-c', p.crt, '-r', p.caCrt, '-p', 'ssl', '-s', host], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0
    expect(ok('192.168.1.18')).toBe(true)
    expect(ok('mini.local')).toBe(true)
    expect(ok('192.168.1.19')).toBe(false)
  })

  test('same addresses: nothing changes; a new address: new server certificate, same CA', () => {
    const again = ensureOfficeTls(dir, { host: 'mini', addrs: ['192.168.1.18', 'fd00::5'] })
    expect(again.changed).toBe(false)
    expect(again.caMade).toBe(false)
    const moved = ensureOfficeTls(dir, { host: 'mini', addrs: ['192.168.0.42'] })
    expect(moved.changed).toBe(true)
    expect(moved.reason).toContain('192.168.0.42')
    expect(moved.ca.fingerprint256).toBe(first.ca.fingerprint256)
    expect(certNames(moved.cert).ips).toEqual(['192.168.0.42'])
    // an address that went away does not force a new certificate (no churn); a renamed Mac does (.local)
    expect(ensureOfficeTls(dir, { host: 'mini', addrs: [] }).changed).toBe(false)
    expect(ensureOfficeTls(dir, { host: 'front', addrs: ['192.168.0.42'] }).names.dns).toEqual(['front.local'])
  })

  test('renewed 30 days before it ends, and replaced when it is not signed by the current CA', () => {
    const want = { dns: ['front.local'], ips: ['192.168.0.42'] }
    expect(serverCertProblem(dir, want)).toBeNull()
    expect(serverCertProblem(dir, want, new Date(Date.now() + 380 * 86400_000))).toBe('expires soon')
    const other = path.join(BASE, 'tls-other')
    ensureOfficeTls(other, { host: 'x', addrs: ['10.0.0.1'] })
    fs.copyFileSync(tlsPaths(other).crt, tlsPaths(dir).crt)
    fs.copyFileSync(tlsPaths(other).key, tlsPaths(dir).key)
    expect(serverCertProblem(dir, want)).toBe('not signed by the current CA')
    expect(ensureOfficeTls(dir, { host: 'front', addrs: ['192.168.0.42'] }).changed).toBe(true)
  })
})

describe('office settings and server.json', () => {
  test('office.env: KEY=VALUE only, defaults, port and label checks', () => {
    expect(parseEnvFile('# c\nTEAMAX_LAN_PORT=9443\nOTHER=1\nTEAMAX_RUN_DIR=/a b/c\n')).toEqual({ TEAMAX_LAN_PORT: '9443', TEAMAX_RUN_DIR: '/a b/c' })
    const s = settingsFrom('/h', {})
    expect(s).toMatchObject({ label: 'app.team-ax.office', appPort: 47830, lanPort: 8443, helperPort: 8442, caConstraints: true })
    expect(settingsFrom('/h', { TEAMAX_LAN_PORT: '18443' }).helperPort).toBe(18442)
    expect(settingsFrom('/h', { TEAMAX_HELPER_PORT: '0' }).helperPort).toBe(0)
    expect(() => settingsFrom('/h', { TEAMAX_LAN_PORT: '70000' })).toThrow()
    expect(() => settingsFrom('/h', { TEAMAX_APP_PORT: '8443' })).toThrow(/must differ/)
    expect(() => settingsFrom('/h', { TEAMAX_LABEL: 'bad label;' })).toThrow()
  })

  test('configure merges with what is there; a new LAN port moves the helper page; long socket paths are refused', () => {
    const home = path.join(BASE, 'cfg-home')
    configure(home, ['--lan-port', '18443', '--label', 'app.team-ax.office-t'])
    configure(home, ['--app-port', '18430'])
    const s = settingsFrom(home, parseEnvFile(fs.readFileSync(officePaths(home).env, 'utf8')))
    expect(s).toMatchObject({ label: 'app.team-ax.office-t', lanPort: 18443, helperPort: 18442, appPort: 18430 })
    expect(mode(officePaths(home).env)).toBe(0o600)
    expect(() => configure(path.join(BASE, 'x'.repeat(120)), [])).toThrow(/longer than macOS allows/)
    expect(() => configure(path.join(BASE, 'x'.repeat(120)), ['--run-dir', '/tmp/tx'])).not.toThrow()
  })

  test('server.json: dev engine setup with office on, plain HTTP on loopback only, TLS on every interface', () => {
    const s = settingsFrom('/Users/x/TeamAX', { TEAMAX_CLAUDE_BIN: '/Users/x/.local/bin/claude' })
    const names = { dns: ['mini.local', 'mini'], ips: ['192.168.1.18', 'fd00::5'] }
    const cfg = serverConfig(s, names)
    expect(cfg).toMatchObject({ mode: 'dev', office: true, listen: { host: '127.0.0.1', port: 47830 }, tls: { host: '::', port: 8443 }, validateResponses: false, relay: { url: null } })
    expect(cfg.engine).toMatchObject({ authMode: 'local-login', claudeBin: '/Users/x/.local/bin/claude', runDir: '/Users/x/TeamAX/data/run' })
    expect(cfg.publicOrigins[0]).toBe('https://192.168.1.18:8443')
    expect(cfg.dataDir.startsWith('/Users/x/TeamAX/app')).toBe(false)
    expect(allowedHosts(names, s).sort()).toEqual(['127.0.0.1:47830', '192.168.1.18:8443', '[fd00::5]:8443', 'localhost:47830', 'mini.local:8443', 'mini:8443'].sort())
    expect(deskOrigins(names, 8443, { shown: true })).toEqual(['https://192.168.1.18:8443', 'https://mini.local:8443'])
    expect(helperOrigins(s, ['https://192.168.1.18:8443'])).toEqual(['http://192.168.1.18:8442'])
    expect(helperOrigins({ ...s, helperPort: 0 }, ['https://192.168.1.18:8443'])).toEqual([])
  })

  test('the server reads it back: office flag, allowed hosts, TLS host', () => {
    const home = path.join(BASE, 'srv-home')
    configure(home, ['--lan-port', '18443', '--app-port', '18430'])
    prepare(home, { addrs: ['192.168.1.18'], host: 'mini' })
    const p = officePaths(home)
    expect(mode(p.serverJson)).toBe(0o600)
    const cfg = loadAppConfig({ argv: ['--config', p.serverJson], env: {} })
    expect(cfg).toMatchObject({ mode: 'dev', office: true, listen: { host: '127.0.0.1', port: 18430 }, tls: { host: '::', port: 18443 } })
    expect(cfg.allowedHosts).toContain('192.168.1.18:18443')
    expect(cfg.allowedHosts).toContain('mini.local:18443')
    expect(fs.readFileSync(p.info, 'utf8')).toContain('https://192.168.1.18:18443')
    expect(fs.readFileSync(p.info, 'utf8')).toContain('http://192.168.1.18:18442')
  })
})

describe('Host, Origin, cookies and client IP on the office address', () => {
  let h: Harness
  const LAN = 'https://192.168.1.18:8443'
  beforeAll(async () => {
    h = await harness('office-http', { office: true, allowedHosts: ['192.168.1.18:8443', 'mini.local:8443', 'localhost:47830', '127.0.0.1:47830'], publicOrigins: [LAN, 'https://mini.local:8443'] })
  })
  afterAll(async () => { await h.close() })

  test('hostAllowed: exact host:port, case-insensitive; empty list = any', () => {
    expect(hostAllowed('192.168.1.18:8443', ['192.168.1.18:8443'])).toBe(true)
    expect(hostAllowed('MINI.local:8443', ['mini.local:8443'])).toBe(true)
    expect(hostAllowed('192.168.1.18', ['192.168.1.18:8443'])).toBe(false)
    expect(hostAllowed(undefined, ['x:1'])).toBe(false)
    expect(hostAllowed('anything', [])).toBe(true)
    expect(hostAllowed('anything', undefined)).toBe(true)
  })

  test('a direct request with another Host (DNS rebinding) gets 421, before the API or a cookie is touched', async () => {
    const bad = await h.fetch('/api/setup', { base: 'https://evil.example:8443', via: 'direct' })
    expect(bad.status).toBe(421)
    expect(bad.headers.get('set-cookie')).toBeNull()
    const loop = await h.fetch('/api/health', { base: 'http://127.0.0.1:47830', via: 'direct', headers: { host: 'attacker.test:47830' } })
    expect(loop.status).toBe(421)
    expect((await h.fetch('/api/health', { base: LAN, via: 'direct' })).status).toBe(200)
    expect((await h.fetch('/api/health', { base: 'http://localhost:47830', via: 'direct' })).status).toBe(200)
    // relayed requests are the relay's business (its own host routing)
    expect((await h.fetch('/api/health', { base: 'https://evil.example', via: 'relay' })).status).toBe(200)
  })

  test('setup and sign-in over https://<LAN IP>: CSRF accepts the office origin, the cookie is __Host- and Secure', async () => {
    const c = h.client({ base: LAN, via: 'direct', ip: '192.168.1.50' })
    const res = await c.raw('POST', '/api/setup', { setupToken: 'setup-token-for-tests-0123456789', teamName: 'Clinic', locale: 'ko', owner: { username: 'director', name: 'Dr', password: 'owner horse battery 42' } }, { origin: LAN })
    expect(res.status).toBe(201)
    const sc = res.headers.getSetCookie().find((x) => x.startsWith('__Host-sid='))!
    expect(sc).toMatch(/; Secure/)
    expect(sc).toMatch(/HttpOnly/)
    const me = await c.try('GET', '/api/me')
    expect(me.status).toBe(200)
    expect(me.body.server.dev).toBe(false) // office mode: no DEV banner on the desks
    const evil = await c.try('POST', '/api/auth/logout', undefined, { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    // the login audit records the desk's address (rate limits key on it too)
    const d = h.client({ base: LAN, via: 'direct', ip: '192.168.1.51' })
    await d.try('POST', '/api/auth/login', { username: 'director', password: 'wrong wrong wrong' }, { origin: LAN })
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'auth.login_failed' ORDER BY rowid DESC LIMIT 1").get() as { detail: string } | null
    expect(row?.detail ?? '').toContain('192.168.1.51')
  })

  test('an invite made on the server Mac itself (http://localhost) links to the office address', async () => {
    const local = h.client({ base: 'http://localhost:47830', via: 'direct', ip: '127.0.0.1' })
    await local.call('POST', '/api/auth/login', { username: 'director', password: 'owner horse battery 42' }, { origin: 'http://localhost:47830' })
    const inv = await local.call('POST', '/api/admin/invites', { role: 'member' }, { origin: 'http://localhost:47830' })
    expect(inv.url.startsWith(`${LAN}/invite/`)).toBe(true)
    const desk = h.client({ base: 'https://mini.local:8443', via: 'direct', ip: '192.168.1.60' })
    await desk.call('POST', '/api/auth/login', { username: 'director', password: 'owner horse battery 42' }, { origin: 'https://mini.local:8443' })
    const inv2 = await desk.call('POST', '/api/admin/invites', { role: 'member' }, { origin: 'https://mini.local:8443' })
    expect(inv2.url.startsWith('https://mini.local:8443/invite/')).toBe(true)
  })

  test('cookies: Secure __Host- on https, the dev name on http://localhost; IPv4-mapped peers are written as IPv4', () => {
    expect(sessionCookie('https://192.168.1.18:8443/api/auth/login', 'x'.repeat(30), 60)).toMatch(/^__Host-sid=.*; Secure$/)
    expect(sessionCookie('http://localhost:47830/api/auth/login', 'x'.repeat(30), 60)).not.toMatch(/Secure/)
    expect(peerIp('::ffff:192.168.1.50')).toBe('192.168.1.50')
    expect(peerIp('fd00::5')).toBe('fd00::5')
    expect(peerIp(undefined)).toBeNull()
  })

  test('the desktop app accepts office https addresses (trust comes from the CA the OS trusts) and refuses plain http', () => {
    expect(parseTeamAddress('192.168.1.18:8443')).toMatchObject({ ok: true, origin: 'https://192.168.1.18:8443', dev: false })
    expect(parseTeamAddress('mini.local:8443')).toMatchObject({ ok: true, origin: 'https://mini.local:8443' })
    expect(parseTeamAddress('http://192.168.1.18:8443')).toMatchObject({ ok: false, error: 'insecure' })
  })
})

describe('helper page (plain HTTP on the office network)', () => {
  const der = new Uint8Array(crypto.randomBytes(64))
  const st: HelperState = { caPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', caDer: der, sha256: 'AB:CD', sha1: '12:34', origins: ['https://192.168.1.18:8443', 'https://mini.local:8443'], caName: 'Team AX office CA mini' }
  const get = (p: string, init: RequestInit = {}) => helperFetch(new Request('http://192.168.1.18:8442' + p, init), st)

  test('serves only /, /ca.cer and /ca.crt', async () => {
    expect([...HELPER_PATHS]).toEqual(['/', '/ca.cer', '/ca.crt'])
    const page = get('/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await page.text()
    expect(html).toContain('/ca.cer')
    expect(html).toContain('https://192.168.1.18:8443/')
    expect(html).toContain('AB:CD')
    expect(html).toContain('12:34')
    expect(html).toContain('신뢰할 수 있는 루트 인증 기관')
    expect(html).toContain('Trusted Root Certification Authorities')
    expect(html).not.toContain('<script')
    const cer = get('/ca.cer')
    expect(cer.headers.get('content-type')).toBe('application/pkix-cert')
    expect(Buffer.from(await cer.arrayBuffer()).equals(Buffer.from(der))).toBe(true)
    expect(get('/ca.crt').headers.get('content-disposition')).toContain('.crt')
  })

  test('no API, no redirect, no key, nothing from the request in the page', async () => {
    for (const p of ['/api/health', '/api/setup', '/api/ws', '/setup', '/ca.key', '/tls/ca.key', '/%2e%2e/tls/ca.key', '/index.html', '//evil.example/']) {
      const r = get(p)
      expect(r.status).toBe(404)
      expect(r.headers.get('location')).toBeNull()
    }
    expect(get('/api/setup', { method: 'POST', body: '{}' }).status).toBe(405)
    const html = await helperFetch(new Request('http://192.168.1.18:8442/?x=<img src=x>', { headers: { host: 'evil"><script>.test' } }), st).text()
    expect(html).not.toContain('evil')
    expect(html).not.toContain('<img src=x>')
  })
})

describe('LaunchAgent and restore', () => {
  test('agent: own label, runs office.js run, kept alive, logs to logs/office.log', () => {
    const s = settingsFrom('/Users/x/TeamAX', { TEAMAX_LABEL: 'app.team-ax.office', TEAMAX_CLAUDE_BIN: '/Users/x/.local/bin/claude' })
    const text = agentPlist(s, '/Users/x/TeamAX/app/bin/bun')
    expect(text).toContain('<key>Label</key><string>app.team-ax.office</string>')
    expect(text).not.toContain('app.team-ax.dev')
    expect(text).toContain('<string>/Users/x/TeamAX/app/bin/bun</string><string>/Users/x/TeamAX/app/server/src/office.js</string><string>run</string>')
    expect(text).toContain('<key>KeepAlive</key><true/>')
    expect(text).toContain('/Users/x/TeamAX/logs/office.log')
    expect(text).toMatch(/<key>PATH<\/key><string>\/Users\/x\/TeamAX\/app\/bin:\/Users\/x\/\.local\/bin:/)
    if (process.platform === 'darwin') {
      const f = path.join(BASE, 'agent.plist')
      fs.writeFileSync(f, text)
      expect(Bun.spawnSync(['plutil', '-lint', f]).stdout.toString()).toContain('OK')
    }
  })

  test('restore swap: archive database and team folder in place, the previous ones kept beside them, setup token gone', () => {
    const home = path.join(BASE, 'restore-home')
    const p = officePaths(home)
    fs.mkdirSync(p.data, { recursive: true })
    fs.mkdirSync(path.join(p.team, 'old'), { recursive: true })
    fs.writeFileSync(path.join(p.data, 'app.db'), 'old-db')
    fs.writeFileSync(path.join(p.data, 'app.db-wal'), 'wal')
    fs.writeFileSync(p.setupToken, 'token')
    const r = path.join(home, 'restore-1')
    fs.mkdirSync(path.join(r, 'db'), { recursive: true })
    fs.mkdirSync(path.join(r, 'team', 'users', 'desk1'), { recursive: true })
    fs.writeFileSync(path.join(r, 'db', 'app.sqlite'), 'new-db')
    const kept = swapInRestore(home, r, 'T')
    expect(fs.readFileSync(path.join(p.data, 'app.db'), 'utf8')).toBe('new-db')
    expect(fs.existsSync(path.join(p.data, 'app.db-wal'))).toBe(false)
    expect(fs.existsSync(path.join(p.team, 'users', 'desk1'))).toBe(true)
    expect(fs.readFileSync(kept.db, 'utf8')).toBe('old-db')
    expect(fs.existsSync(path.join(kept.team, 'old'))).toBe(true)
    expect(fs.existsSync(p.setupToken)).toBe(false)
    expect(fs.existsSync(r)).toBe(false)
  })
})

describe('office-install.sh / office-uninstall.sh dry paths', () => {
  const B = path.join(BASE, 'bundle')
  const fakeClaude = (loggedIn: boolean) => {
    const f = path.join(BASE, `claude-${loggedIn}`)
    fs.writeFileSync(f, `#!/bin/sh\n[ "$1 $2" = "auth status" ] && echo '{ "loggedIn": ${loggedIn}, "authMethod": "claude.ai" }'\nexit 0\n`, { mode: 0o755 })
    return f
  }
  beforeAll(() => {
    fs.mkdirSync(path.join(B, 'app', 'bin', 'darwin-arm64'), { recursive: true })
    fs.mkdirSync(path.join(B, 'app', 'server', 'src'), { recursive: true })
    fs.writeFileSync(path.join(B, 'app', 'VERSION'), '9.9.9\n')
    fs.symlinkSync(process.execPath, path.join(B, 'app', 'bin', 'darwin-arm64', 'bun'))
    fs.writeFileSync(path.join(B, 'app', 'server', 'src', 'office.js'), `const { main } = await import(${JSON.stringify(path.join(REPO, 'server', 'src', 'office', 'cli.ts'))}); process.exit(await main(process.argv.slice(2)))\n`)
    for (const f of ['office-install.sh', 'office-uninstall.sh']) fs.copyFileSync(path.join(REPO, 'scripts', 'office', f), path.join(B, f))
  })
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawnSync(['bash', path.join(B, script), ...args], {
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: path.join(BASE, 'fakehome'), TEAMAX_TEST_UNAME: 'Darwin', TEAMAX_TEST_OSVERSION: '15.1', TEAMAX_TEST_ARCH: 'arm64', ...env },
    })
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  }
  const prefix = path.join(BASE, 'inst')

  test('check-only with a logged-in Claude: prints the settings, changes nothing', () => {
    const r = run('office-install.sh', ['--prefix', prefix, '--lan-port', '18443', '--check-only'], { TEAMAX_CLAUDE_BIN: fakeClaude(true) })
    expect(r.out).toContain('TEAMAX_LAN_PORT=18443')
    expect(r.out).toContain('TEAMAX_HELPER_PORT=18442')
    expect(r.out).toContain('check only: nothing changed')
    expect(r.code).toBe(0)
    expect(fs.existsSync(prefix)).toBe(false)
  })

  test('refuses: Claude not logged in, Claude missing, old macOS, other OS, unknown processor, bad port, long path', () => {
    const ok = { TEAMAX_CLAUDE_BIN: fakeClaude(true) }
    const cases: [string[], Record<string, string>, RegExp][] = [
      [[], { TEAMAX_CLAUDE_BIN: fakeClaude(false) }, /not logged in/],
      [[], { TEAMAX_CLAUDE_BIN: path.join(BASE, 'no-claude') }, /not installed/],
      [[], { ...ok, TEAMAX_TEST_OSVERSION: '12.7' }, /macOS 13 or newer/],
      [[], { ...ok, TEAMAX_TEST_UNAME: 'Linux' }, /runs on macOS/],
      [[], { ...ok, TEAMAX_TEST_ARCH: 'ppc' }, /unsupported processor/],
      [[], { ...ok, TEAMAX_TEST_ARCH: 'x86_64' }, /not an unpacked TeamAX-office bundle for darwin-amd64/],
      [['--lan-port', '99999'], ok, /must be a port number/],
      [['--lan-port', '47830'], ok, /must differ/],
      [['--bogus'], ok, /unknown option/],
    ]
    for (const [args, env, re] of cases) {
      const r = run('office-install.sh', ['--prefix', prefix, '--check-only', ...args], env)
      expect(r.code, `${args.join(' ')} ${JSON.stringify(env)}`).not.toBe(0)
      expect(r.out).toMatch(re)
    }
    const long = run('office-install.sh', ['--prefix', path.join(BASE, 'y'.repeat(100)), '--check-only'], ok)
    expect(long.code).not.toBe(0)
    expect(long.out).toMatch(/longer than macOS allows/)
    expect(fs.existsSync(prefix)).toBe(false)
  })

  test('uninstall refuses a folder that is not an installation, and the home folder itself', () => {
    const r = run('office-uninstall.sh', ['--prefix', path.join(BASE, 'nothing-here')])
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/not a Team AX office installation/)
    const home = path.join(BASE, 'fakehome')
    fs.mkdirSync(path.join(home, 'config'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config', 'office.env'), 'TEAMAX_LABEL=app.team-ax.office-x\n')
    const r2 = run('office-uninstall.sh', ['--prefix', home, '--delete-data', '--yes'])
    expect(r2.code).not.toBe(0)
    expect(r2.out).toMatch(/refusing/)
    expect(fs.existsSync(path.join(home, 'config', 'office.env'))).toBe(true)
  })
})
