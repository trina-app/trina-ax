// Office mode (docs/OFFICE.md): the office CA and server certificate (names, regeneration, constraints), the
// settings and the server.json they produce, Host / Origin / cookie handling on the office address, the helper
// page's allow-list, the LaunchAgent, restore swap, the installer's dry paths (no install, no LaunchAgent), and the
// check of the staged bundle before the zip is made.
// The real install from the zip, over the LAN address with one real Claude turn, is tests/install/office-lan.mjs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { openDb } from '../../server/src/db'
import { loadAppConfig } from '../../server/src/app-config'
import { sessionCookie } from '../../server/src/auth/service'
import { ipKeys, limitIp, RateLimiter, tokenIpKeys } from '../../server/src/auth/rate-limit'
import { hostAllowed, originsFor, peerAllowed } from '../../server/src/http/middleware'
import { peerIp } from '../../server/src/main'
import { agentPlist, archiveSummary, backupSummary, configure, helperOrigins, portProblems, prepare, swapInRestore } from '../../server/src/office/cli'
import { deskCard, HELPER_PATHS, helperFetch, windowsThumbprint, type HelperState } from '../../server/src/office/helper'
import { allowedHosts, allowedPeers, cidr, deskOrigins, officePaths, parseAllowFrom, parseEnvFile, serverConfig, settingsFrom } from '../../server/src/office/settings'
import { caConstraintsFor, certNames, dnsPermitted, ensureOfficeTls, ipPermitted, lanInfo, normIp, PRIVATE_V4, serverCertProblem, tldWideConstraint, tlsPaths, wantedNames } from '../../server/src/office/tls'
import { parseTeamAddress } from '../../desktop/src/common/address'
import { bundleManifest, missingFromStage } from '../../scripts/build-office'
import { connectionStatus } from '../../server/src/system/connection'
import { harness, type Harness } from './a-lib'
import { WORK } from '../lib/env'

const BASE = path.join(WORK, 'office')
const REPO = path.resolve(import.meta.dir, '..', '..')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const NET: [string, string][] = [['192.168.1.0', '255.255.255.0']]
const C = caConstraintsFor('mini', NET)
const mode = (f: string) => fs.statSync(f).mode & 0o777
const openssl = (args: string[]) => Bun.spawnSync(['/usr/bin/openssl', ...args], { stdout: 'pipe', stderr: 'pipe' })

describe('office addresses and names', () => {
  const iface = (address: string, family: 'IPv4' | 'IPv6', netmask = '255.255.255.0', internal = false) => ({ address, family, internal, netmask, mac: '', cidr: null }) as os.NetworkInterfaceInfo
  test('LAN addresses: IPv4 only, no loopback, link-local, VPN (utun, 100.64/10) or VM bridges; subnets for the CA', () => {
    const ifaces = {
      lo0: [iface('127.0.0.1', 'IPv4', '255.0.0.0', true), iface('::1', 'IPv6', '', true)],
      en0: [iface('192.168.1.18', 'IPv4'), iface('fe80::1c17:7e97:bb9e:1c27', 'IPv6', 'ffff:ffff:ffff:ffff::'), iface('fd00::5', 'IPv6', 'ffff:ffff:ffff:ffff::')],
      utun5: [iface('100.125.180.119', 'IPv4', '255.255.255.255'), iface('fd7a:115c:a1e0::d436:b477', 'IPv6', '')],
      en7: [iface('169.254.3.4', 'IPv4', '255.255.0.0'), iface('10.0.0.9', 'IPv4', '255.255.0.0')],
      bridge100: [iface('192.168.64.1', 'IPv4')],
      en9: [iface('100.70.1.2', 'IPv4', '255.192.0.0')],
    }
    expect(lanInfo({ ifaces })).toEqual({ addrs: ['192.168.1.18', '10.0.0.9'], subnets: [['192.168.1.0', '255.255.255.0'], ['10.0.0.0', '255.255.0.0']] })
    // opt-in (TEAMAX_INCLUDE_VPN=1): the VPN addresses come back, still no IPv6
    expect(lanInfo({ ifaces, includeVpn: true }).addrs).toEqual(['192.168.1.18', '192.168.64.1', '10.0.0.9', '100.70.1.2', '100.125.180.119'])
    expect(cidr(['192.168.1.0', '255.255.255.0'])).toBe('192.168.1.0/24')
    expect(cidr(['10.0.0.0', '255.0.0.0'])).toBe('10.0.0.0/8')
  })

  test('the certificate names only what the CA may vouch for (this Mac\'s names, its office subnet)', () => {
    // security review 4 (office-lan 2): never the bare name: an RFC 5280 subtree "dental" is every site under .dental
    expect(C).toEqual({ dns: ['mini.local'], v4: NET, v6: [] })
    for (const ip of ['192.168.1.1', '192.168.1.254']) expect(ipPermitted(ip, C)).toBe(true)
    // security review 5: not every private address (the EMR server, NAS or router of another subnet), no IPv6
    for (const ip of ['192.168.0.1', '10.200.1.1', '172.31.255.1', '100.64.0.1', 'fd7a:115c::1', 'fc00::1', '8.8.8.8', '2001:db8::1']) expect(ipPermitted(ip, C)).toBe(false)
    expect(dnsPermitted('mini.local', C)).toBe(true)
    for (const d of ['evil.com', 'notmini', 'nas.local', 'printer.local', 'local', 'mini', 'www.x.mini']) expect(dnsPermitted(d, C)).toBe(false)
    const w = wantedNames('mini', ['192.168.1.18', '8.8.8.8', '192.168.2.5'], C)
    expect(w).toEqual({ dns: ['mini.local'], ips: ['192.168.1.18'], left: ['8.8.8.8', '192.168.2.5'] })
    expect(caConstraintsFor('dental', NET).dns).toEqual(['dental.local'])
    expect(tldWideConstraint({ dns: ['dental.local', 'dental'], v4: NET, v6: [] })).toBe('dental')
    for (const dns of [['dental.local'], ['local'], []]) expect(tldWideConstraint({ dns, v4: NET, v6: [] })).toBeNull()
    // never an empty side (that would mean "any name" / "any address"): no host name or no subnet known yet
    expect(caConstraintsFor(null, [])).toEqual({ dns: ['local'], v4: PRIVATE_V4, v6: [] })
    // a CA without constraints (TEAMAX_CA_CONSTRAINTS=0) names every address
    expect(wantedNames('mini', ['8.8.8.8'], { dns: [], v4: [], v6: [] }).ips).toEqual(['8.8.8.8'])
    expect(normIp('FD00:0:0:0:0:0:0:5')).toBe('fd00::5')
  })
})

describe('office CA and server certificate', () => {
  const dir = path.join(BASE, 'tls')
  let first: ReturnType<typeof ensureOfficeTls>
  beforeAll(() => { first = ensureOfficeTls(dir, { host: 'mini', addrs: ['192.168.1.18', '8.8.8.8'], subnets: NET }) })

  test('made once: CA key 600 in a 700 folder, server certificate for every name and address', () => {
    const p = tlsPaths(dir)
    expect(first.caMade).toBe(true)
    expect(first.changed).toBe(true)
    expect(mode(dir)).toBe(0o700)
    expect(mode(p.caKey)).toBe(0o600)
    expect(mode(p.key)).toBe(0o600)
    expect(certNames(first.cert)).toEqual({ dns: ['mini.local'], ips: ['192.168.1.18'] })
    expect(first.left).toEqual(['8.8.8.8'])
    expect(first.cert.verify(first.ca.publicKey)).toBe(true)
    expect(first.ca.ca).toBe(true)
    // .cer = the same CA in DER (what Windows double-clicks)
    expect(Buffer.from(fs.readFileSync(p.caCer)).equals(Buffer.from(first.ca.raw))).toBe(true)
  })

  test('the CA is name-constrained, the server certificate is a TLS server certificate', () => {
    const ca = openssl(['x509', '-in', tlsPaths(dir).caCrt, '-noout', '-text']).stdout.toString()
    expect(ca).toMatch(/Name Constraints: critical/)
    expect(ca).toMatch(/DNS:mini\.local/)
    expect(ca).toMatch(/IP:192\.168\.1\.0\/255\.255\.255\.0/)
    expect(ca).not.toMatch(/DNS:local\b(?!\.)/)
    expect(ca).not.toMatch(/IP:10\.0\.0\.0|IP:192\.168\.0\.0\/255\.255\.0\.0|IP:100\.64|IP:FC00/i)
    expect(ca).toMatch(/CA:TRUE, pathlen:0/)
    const leaf = openssl(['x509', '-in', tlsPaths(dir).crt, '-noout', '-text']).stdout.toString()
    expect(leaf).toMatch(/TLS Web Server Authentication/)
    expect(leaf).toMatch(/CA:FALSE/)
    const v = openssl(['verify', '-CAfile', tlsPaths(dir).caCrt, tlsPaths(dir).crt])
    expect(v.stdout.toString()).toContain(': OK')
  })

  test('a certificate for a public name, another .local device or another private subnet, signed with the same CA key, fails verification', () => {
    const p = tlsPaths(dir)
    const forged = (tag: string, san: string) => {
      const d = path.join(BASE, `evil-${tag}`)
      fs.mkdirSync(d, { recursive: true })
      openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(d, 'k')])
      openssl(['req', '-new', '-key', path.join(d, 'k'), '-subj', '/CN=x', '-out', path.join(d, 'csr')])
      fs.writeFileSync(path.join(d, 'ext'), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`)
      openssl(['x509', '-req', '-in', path.join(d, 'csr'), '-CA', p.caCrt, '-CAkey', p.caKey, '-CAcreateserial', '-CAserial', path.join(d, 'srl'), '-days', '30', '-extfile', path.join(d, 'ext'), '-out', path.join(d, 'crt')])
      return openssl(['verify', '-CAfile', p.caCrt, path.join(d, 'crt')])
    }
    // security review 5: a leaked ca.key could sign these; the desks' browsers refuse them
    for (const [tag, san] of [['bank', 'DNS:bank.example,IP:8.8.8.8'], ['nas', 'DNS:nas.local'], ['emr', 'IP:192.168.0.10'], ['ten', 'IP:10.1.2.3'], ['v6', 'IP:fd00::1']] as const) {
      const v = forged(tag, san)
      expect(v.exitCode, tag).not.toBe(0)
      expect(v.stdout.toString() + v.stderr.toString(), tag).toMatch(/subtree violation|name constraint/i)
    }
    expect(forged('ok', 'DNS:mini.local,IP:192.168.1.77').stdout.toString()).toContain(': OK')
  })

  test.if(process.platform === 'darwin')('macOS trust evaluation accepts it for the LAN address and .local, not for another address', () => {
    const p = tlsPaths(dir)
    const ok = (host: string) => Bun.spawnSync(['/usr/bin/security', 'verify-cert', '-c', p.crt, '-r', p.caCrt, '-p', 'ssl', '-s', host], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0
    expect(ok('192.168.1.18')).toBe(true)
    expect(ok('mini.local')).toBe(true)
    expect(ok('192.168.1.19')).toBe(false)
  })

  test('same addresses: nothing changes; a new address: new server certificate, same CA', () => {
    const again = ensureOfficeTls(dir, { host: 'mini', addrs: ['192.168.1.18'], subnets: NET })
    expect(again.changed).toBe(false)
    expect(again.caMade).toBe(false)
    const moved = ensureOfficeTls(dir, { host: 'mini', addrs: ['192.168.1.42'], subnets: NET })
    expect(moved.changed).toBe(true)
    expect(moved.reason).toContain('192.168.1.42')
    expect(moved.ca.fingerprint256).toBe(first.ca.fingerprint256)
    expect(certNames(moved.cert).ips).toEqual(['192.168.1.42'])
    // an address that went away does not force a new certificate (no churn)
    expect(ensureOfficeTls(dir, { host: 'mini', addrs: [] }).changed).toBe(false)
    // another subnet (new router) or a renamed Mac: outside the CA's constraints, left out (docs: new CA)
    const other = ensureOfficeTls(dir, { host: 'front', addrs: ['192.168.0.42', '192.168.1.42'] })
    expect(other.left).toEqual(['192.168.0.42'])
    expect(other.changed).toBe(false) // nothing it may add: the certificate stays as it is
  })

  test('renewed 30 days before it ends, and replaced when it is not signed by the current CA', () => {
    ensureOfficeTls(dir, { host: 'mini', addrs: ['192.168.1.42'], subnets: NET })
    const want = { dns: ['mini.local'], ips: ['192.168.1.42'] }
    expect(serverCertProblem(dir, want)).toBeNull()
    expect(serverCertProblem(dir, want, new Date(Date.now() + 380 * 86400_000))).toBe('expires soon')
    const other = path.join(BASE, 'tls-other')
    ensureOfficeTls(other, { host: 'x', addrs: ['10.0.0.1'], subnets: [['10.0.0.0', '255.0.0.0']] })
    fs.copyFileSync(tlsPaths(other).crt, tlsPaths(dir).crt)
    fs.copyFileSync(tlsPaths(other).key, tlsPaths(dir).key)
    expect(serverCertProblem(dir, want)).toBe('not signed by the current CA')
    expect(ensureOfficeTls(dir, { host: 'mini', addrs: ['192.168.1.42'] }).changed).toBe(true)
  })
})

describe('office settings and server.json', () => {
  test('office.env: KEY=VALUE only, defaults, port and label checks', () => {
    expect(parseEnvFile('# c\nTEAMAX_LAN_PORT=9443\nOTHER=1\nTEAMAX_RUN_DIR=/a b/c\n')).toEqual({ TEAMAX_LAN_PORT: '9443', TEAMAX_RUN_DIR: '/a b/c' })
    const s = settingsFrom('/h', {})
    expect(s).toMatchObject({ label: 'app.team-ax.office', appPort: 47830, lanPort: 8443, helperPort: 8442, caConstraints: true, includeVpn: false, allowFrom: 'subnet' })
    expect(parseAllowFrom('any')).toBe('any')
    expect(parseAllowFrom(' 192.168.1.0/24, 10.20.0.0/16 ')).toEqual(['192.168.1.0/24', '10.20.0.0/16'])
    expect(() => parseAllowFrom('192.168.1.0')).toThrow(/CIDR/)
    expect(() => parseAllowFrom('300.1.1.0/24')).toThrow(/CIDR/)
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

  test('server.json: dev engine setup with office on, plain HTTP on loopback only, TLS on IPv4 for the office subnet, no Codex', () => {
    const s = settingsFrom('/Users/x/TeamAX', { TEAMAX_CLAUDE_BIN: '/Users/x/.local/bin/claude' })
    const names = { dns: ['mini.local'], ips: ['192.168.1.18', '10.0.0.9'] }
    const cfg = serverConfig(s, names, NET)
    expect(cfg).toMatchObject({ mode: 'dev', office: true, listen: { host: '127.0.0.1', port: 47830 }, tls: { host: '0.0.0.0', port: 8443 }, validateResponses: false, relay: { url: null } })
    expect(cfg.engine).toMatchObject({ authMode: 'local-login', claudeBin: '/Users/x/.local/bin/claude', runDir: '/Users/x/TeamAX/data/run' })
    // do-it review 2: Codex is never picked up from PATH in office mode ('' = off)
    expect(cfg.engine.codexBin).toBe('')
    // security review 6: only the office subnet reaches the office port (a Tailscale peer does not)
    expect(cfg.allowedPeers).toEqual(['192.168.1.0/24'])
    expect(allowedPeers({ allowFrom: 'any' }, NET)).toEqual([])
    expect(allowedPeers({ allowFrom: 'subnet' }, [])).toEqual(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])
    expect(cfg.publicOrigins[0]).toBe('https://192.168.1.18:8443')
    expect(cfg.dataDir.startsWith('/Users/x/TeamAX/app')).toBe(false)
    expect(allowedHosts(names, s).sort()).toEqual(['10.0.0.9:8443', '127.0.0.1:47830', '192.168.1.18:8443', 'localhost:47830', 'mini.local:8443'].sort())
    // do-it review 7: the desks see the main address (and the .local name), not every address
    expect(deskOrigins(names, 8443, { shown: true })).toEqual(['https://192.168.1.18:8443', 'https://mini.local:8443'])
    expect(helperOrigins(s, ['https://192.168.1.18:8443'])).toEqual(['http://192.168.1.18:8442'])
    expect(helperOrigins({ ...s, helperPort: 0 }, ['https://192.168.1.18:8443'])).toEqual([])
  })

  test('the server reads it back: office flag, allowed hosts, TLS host', () => {
    const home = path.join(BASE, 'srv-home')
    configure(home, ['--lan-port', '18443', '--app-port', '18430'])
    const first = prepare(home, { addrs: ['192.168.1.18'], subnets: NET, host: 'mini' })
    const p = officePaths(home)
    expect(mode(p.serverJson)).toBe(0o600)
    const cfg = loadAppConfig({ argv: ['--config', p.serverJson], env: {} })
    expect(cfg).toMatchObject({ mode: 'dev', office: true, listen: { host: '127.0.0.1', port: 18430 }, tls: { host: '0.0.0.0', port: 18443 }, allowedPeers: ['192.168.1.0/24'] })
    expect(cfg.engine.codexBin).toBe('')
    expect(cfg.allowedHosts).toContain('192.168.1.18:18443')
    expect(cfg.allowedHosts).toContain('mini.local:18443')
    const info = fs.readFileSync(p.info, 'utf8')
    expect(info).toContain('https://192.168.1.18:18443')
    expect(info).toContain('http://192.168.1.18:18442')
    // security review 1: the trusted copy of the thumbprint is on the server Mac, in Windows' own format, and the card
    expect(info).toContain(windowsThumbprint(first.helper.sha1))
    expect(info).toContain(p.card)
    expect(info).toContain(path.join(p.tls, 'ca.cer'))
    expect(fs.readFileSync(p.card, 'utf8')).toContain(windowsThumbprint(first.helper.sha1))
    // same addresses: no restart; a new office subnet changes server.json (allowedPeers): restart
    expect(prepare(home, { addrs: ['192.168.1.18'], subnets: NET, host: 'mini' }).changed).toBe(false)
    const moved = prepare(home, { addrs: ['192.168.1.18'], subnets: [...NET, ['10.0.0.0', '255.255.0.0']], host: 'mini' })
    expect(moved.changed).toBe(true)
    expect(moved.peers).toEqual(['192.168.1.0/24', '10.0.0.0/16'])
  })
})

describe('Host, Origin, cookies and client IP on the office address', () => {
  let h: Harness
  const LAN = 'https://192.168.1.18:8443'
  beforeAll(async () => {
    h = await harness('office-http', {
      office: true, allowedHosts: ['192.168.1.18:8443', 'mini.local:8443', 'localhost:47830', '127.0.0.1:47830'], allowedPeers: ['192.168.1.0/24'],
      publicOrigins: [LAN, 'https://mini.local:8443', 'http://localhost:47830', 'http://127.0.0.1:47830'],
    })
  })
  afterAll(async () => { await h.close() })

  test('hostAllowed: exact host:port, case-insensitive; empty list = any', () => {
    expect(hostAllowed('192.168.1.18:8443', ['192.168.1.18:8443'])).toBe(true)
    expect(hostAllowed('MINI.local:8443', ['mini.local:8443'])).toBe(true)
    expect(hostAllowed('192.168.1.18', ['192.168.1.18:8443'])).toBe(false)
    expect(hostAllowed(undefined, ['x:1'])).toBe(false)
    expect(hostAllowed('anything', [])).toBe(true)
    expect(hostAllowed('anything', undefined)).toBe(true)
    // with the listener's port: the other listener's names are not answered
    expect(hostAllowed('localhost:47830', ['localhost:47830', '192.168.1.18:8443'], 8443)).toBe(false)
    expect(hostAllowed('192.168.1.18:8443', ['localhost:47830', '192.168.1.18:8443'], 8443)).toBe(true)
  })

  test('security review 3: a request without a Host header gets 421, not a 500 with a stack trace', async () => {
    const r = await h.fetch('/api/health', { base: LAN, via: 'direct', ip: '192.168.1.50', noHost: true })
    expect(r.status).toBe(421)
  })

  test('security review 4: the office port does not answer the loopback Host or accept the loopback Origin', async () => {
    const r = await h.fetch('/api/health', { base: LAN, via: 'direct', ip: '192.168.1.50', port: 8443, headers: { host: 'localhost:47830' } })
    expect(r.status).toBe(421)
    const back = await h.fetch('/api/health', { base: 'http://127.0.0.1:47830', via: 'direct', ip: '127.0.0.1', port: 47830, headers: { host: '192.168.1.18:8443' } })
    expect(back.status).toBe(421)
    const lanInfo = { via: 'direct', port: 8443 }
    expect(originsFor(h.ctx.config, lanInfo)).toEqual([LAN, 'https://mini.local:8443'])
    expect(originsFor(h.ctx.config, { via: 'direct', port: 47830 })).toEqual(['http://localhost:47830', 'http://127.0.0.1:47830'])
    expect(originsFor(h.ctx.config, { via: 'relay' })).toEqual(h.ctx.config.publicOrigins)
    // CSRF: a state-changing request on the office port with the loopback Origin is refused
    const c = h.client({ base: LAN, via: 'direct', ip: '192.168.1.52' })
    const res = await c.raw('POST', '/api/auth/login', { username: 'x', password: 'y' }, { origin: 'http://localhost:47830' })
    expect(res.status).toBe(403)
  })

  test('security review 6: only the office subnet reaches the office port (a VPN peer gets 403); this Mac always does', async () => {
    expect((await h.fetch('/api/health', { base: LAN, via: 'direct', ip: '100.125.180.119' })).status).toBe(403)
    expect((await h.fetch('/api/health', { base: LAN, via: 'direct', ip: 'fe80::1' })).status).toBe(403)
    expect((await h.fetch('/api/health', { base: LAN, via: 'direct', ip: '192.168.1.77' })).status).toBe(200)
    expect((await h.fetch('/api/health', { base: 'http://localhost:47830', via: 'direct', ip: '127.0.0.1' })).status).toBe(200)
    expect(peerAllowed('10.0.0.1', [])).toBe(true)
    expect(peerAllowed('10.0.0.1', ['10.0.0.0/8'])).toBe(true)
    expect(peerAllowed('11.0.0.1', ['10.0.0.0/8'])).toBe(false)
    expect(peerAllowed(null, ['10.0.0.0/8'])).toBe(false)
  })

  test('security review 2: per-IP sign-in limits count an IPv6 client by its /64, so new addresses do not reset them', () => {
    expect(limitIp('192.168.1.50')).toBe('192.168.1.50')
    expect(limitIp('fe80::1c17:7e97:bb9e:1c27%en0')).toBe(limitIp('fe80::99'))
    expect(limitIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(limitIp('2001:db8:1:3::1')).not.toBe(limitIp('2001:db8:1:2::1'))
    expect(limitIp('::ffff:10.0.0.1')).toBe('10.0.0.1')
    const rl = new RateLimiter(h.ctx.db)
    for (let i = 0; i < 30; i++) rl.fail([...tokenIpKeys(`fe80::${(i + 1).toString(16)}`), ...ipKeys(`fe80::${(i + 1).toString(16)}`)])
    expect(rl.retryAfter(tokenIpKeys('fe80::abcd'))).toBeGreaterThan(0)
    expect(rl.retryAfter(ipKeys('fe80::abcd'))).toBeGreaterThan(0)
  })

  test('a direct request with another Host (DNS rebinding) gets 421, before the API or a cookie is touched', async () => {
    const desk = '192.168.1.50'
    const bad = await h.fetch('/api/setup', { base: 'https://evil.example:8443', via: 'direct', ip: desk })
    expect(bad.status).toBe(421)
    expect(bad.headers.get('set-cookie')).toBeNull()
    const loop = await h.fetch('/api/health', { base: 'http://127.0.0.1:47830', via: 'direct', ip: '127.0.0.1', headers: { host: 'attacker.test:47830' } })
    expect(loop.status).toBe(421)
    expect((await h.fetch('/api/health', { base: LAN, via: 'direct', ip: desk })).status).toBe(200)
    expect((await h.fetch('/api/health', { base: 'http://localhost:47830', via: 'direct', ip: '127.0.0.1' })).status).toBe(200)
    // relayed requests are the relay's business (its own host routing)
    expect((await h.fetch('/api/health', { base: 'https://evil.example', via: 'relay' })).status).toBe(200)
  })

  test('setup and sign-in over https://<LAN IP>: CSRF accepts the office origin, the cookie is __Host- and Secure', async () => {
    const c = h.client({ base: LAN, via: 'direct', ip: '192.168.1.50' })
    const res = await c.raw('POST', '/api/setup', { setupToken: 'setup-token-for-tests-0123456789', teamName: 'Office', locale: 'ko', owner: { username: 'director', name: 'Dr', password: 'owner horse battery 42' } }, { origin: LAN })
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

  test('do-it review 3: Admin > System tells office mode as it is (sandbox on, no relay, updates from a zip, no Codex, CA fingerprint, no mode change)', async () => {
    fs.mkdirSync(path.join(h.ctx.config.dataDir, 'tls'), { recursive: true })
    const local = h.client({ base: 'http://localhost:47830', via: 'direct', ip: '127.0.0.1' })
    await local.call('POST', '/api/auth/login', { username: 'director', password: 'owner horse battery 42' }, { origin: 'http://localhost:47830' })
    const d = await local.call('GET', '/api/admin/diagnostics?locale=ko')
    const by = (id: string) => d.checks.find((x: { id: string }) => x.id === id)
    expect(by('relay')).toMatchObject({ status: 'ok' })
    expect(by('relay').detail).toContain('사무실 모드')
    expect(by('pf_anchor').detail).toContain('운영 설치')
    if (process.platform === 'darwin') expect(by('sandbox')).toMatchObject({ status: 'ok' })
    expect(by('sandbox').detail).not.toMatch(/샌드박스 프로필을 쓰지 않습니다|without the sandbox profile/)
    expect(by('update').detail).toMatch(/zip/)
    expect(d.checks.some((x: { id: string }) => x.id === 'engine.codex')).toBe(false)
    const conn = await local.call('GET', '/api/admin/connection')
    expect(conn.availableModes).toEqual(['direct-only'])
    const put = await local.raw('PUT', '/api/admin/connection', { mode: 'self-relay', relayUrl: 'wss://relay.example/connect', teamName: 'office', password: 'owner horse battery 42' }, { origin: 'http://localhost:47830' })
    expect(put.status).toBe(409)
  })

  test('the connection card shows the office CA fingerprint (what the desks compare), not the server certificate', () => {
    const t = ensureOfficeTls(path.join(BASE, 'conn-tls'), { host: 'mini', addrs: ['192.168.1.18'], subnets: NET })
    const cfg = { ...h.ctx.config, tls: { host: '0.0.0.0', port: 8443, certFile: path.join(BASE, 'conn-tls', 'server.crt'), keyFile: path.join(BASE, 'conn-tls', 'server.key') } }
    expect(connectionStatus({ ...h.ctx, config: cfg } as typeof h.ctx).direct.fingerprintSha256).toBe(t.ca.fingerprint256)
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
  const SHA1 = 'C8:71:62:D4:D9:B3:BF:5B:00:11:22:33:44:55:66:77:88:99:AA:BB'
  const st: HelperState = { caPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', caDer: der, sha256: 'AB:CD:EF:01', sha1: SHA1, origins: ['https://192.168.1.18:8443', 'https://mini.local:8443'], caName: 'Team AX office CA mini' }
  const get = (p: string, init: RequestInit = {}) => helperFetch(new Request('http://192.168.1.18:8442' + p, init), st)

  test('serves only /, /ca.cer and /ca.crt', async () => {
    expect([...HELPER_PATHS]).toEqual(['/', '/ca.cer', '/ca.crt'])
    const page = get('/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await page.text()
    expect(html).toContain('/ca.cer')
    expect(html).toContain('https://192.168.1.18:8443/')
    expect(html).toContain('신뢰할 수 있는 루트 인증 기관')
    expect(html).toContain('Trusted Root Certification Authorities')
    expect(html).not.toContain('<script')
    const cer = get('/ca.cer')
    expect(cer.headers.get('content-type')).toBe('application/pkix-cert')
    expect(Buffer.from(await cer.arrayBuffer()).equals(Buffer.from(der))).toBe(true)
    expect(get('/ca.crt').headers.get('content-disposition')).toContain('.crt')
  })

  test('security review 1: the page shows no fingerprint and sends the desk to the card printed on the server Mac', async () => {
    const html = await get('/').text()
    for (const v of [st.sha256, SHA1, windowsThumbprint(SHA1), 'c87162d4']) expect(html).not.toContain(v)
    expect(html).toContain('데스크 카드')
    expect(html).toContain('desk card')
    expect(html).toContain('teamax info')
    expect(html).toContain('USB')
    // do-it review 4: compare under 자세히 → 지문 before installing; Current User (the store whose install warns)
    expect(html.indexOf('<b>지문</b>')).toBeLessThan(html.indexOf('인증서 설치…'))
    expect(html).toContain('<b>현재 사용자</b>')
    expect(windowsThumbprint(SHA1)).toBe('c87162d4 d9b3bf5b 00112233 44556677 8899aabb')
    const card = deskCard(st, { helper: 'http://192.168.1.18:8442', caCer: '/Users/x/TeamAX/tls/ca.cer', made: '2026-10-21 10:00' })
    expect(card).toContain('c87162d4 d9b3bf5b 00112233 44556677 8899aabb')
    expect(card).toContain('https://192.168.1.18:8443')
    expect(card).toContain('http://192.168.1.18:8442')
    expect(card).not.toContain('<script')
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

describe('teamax command', () => {
  test('do-it review 10: backup and archive answer in a sentence, not JSON', () => {
    const b = backupSummary({ id: '2026-10-21T10-00-00Z-manual', createdAt: '2026-10-21T10:00:00Z', db: { size: 3 * 1024 * 1024 }, team: { archiveSize: 1024 * 1024 } })
    expect(b).toContain('백업을 만들었습니다')
    expect(b).toContain('3.0 MB')
    expect(b).not.toContain('{')
    const a = archiveSummary({ file: '/Volumes/Backup/teamax.age', size: 2 * 1024 * 1024, sha256: 'ab', encrypted: true, files: 12 })
    expect(a).toContain('/Volumes/Backup/teamax.age')
    expect(a).toContain('암호화됨')
  })

  test('do-it review 1: archive --out FILE and restore-archive --in FILE pass the file, not "--out"', () => {
    const home = path.join(BASE, 'wrapper-home')
    fs.mkdirSync(path.join(home, 'app', 'bin'), { recursive: true })
    fs.mkdirSync(path.join(home, 'app', 'server', 'src'), { recursive: true })
    fs.writeFileSync(path.join(home, 'app', 'server', 'src', 'office.js'), '')
    // a stand-in bun that writes its arguments and stdin where the test can read them
    const log = path.join(home, 'args.txt')
    fs.writeFileSync(path.join(home, 'app', 'bin', 'bun'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${JSON.stringify(log)}\ncat >> ${JSON.stringify(log)}\n`, { mode: 0o755 })
    fs.copyFileSync(path.join(REPO, 'scripts', 'office', 'teamax'), path.join(home, 'app', 'teamax'))
    fs.chmodSync(path.join(home, 'app', 'teamax'), 0o755)
    const cwd = path.join(home, 'cwd')
    fs.mkdirSync(cwd, { recursive: true })
    const run = (args: string[], input: string) => {
      fs.rmSync(log, { force: true })
      const p = Bun.spawnSync(['bash', path.join(home, 'app', 'teamax'), ...args], { cwd, stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' })
      return { code: p.exitCode, args: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n') : [], err: p.stderr.toString() }
    }
    for (const form of [['archive', '--out', '/Volumes/X/a.age'], ['archive', '/Volumes/X/a.age']]) {
      const r = run(form, 'password1\npassword1\n')
      expect(r.code, form.join(' ')).toBe(0)
      const i = r.args.indexOf('--out')
      expect(r.args[i + 1]).toBe('/Volumes/X/a.age')
      expect(r.args.at(-1)).toBe('password1')
    }
    for (const form of [['restore-archive', '--in', '/Volumes/X/a.age', '--replace'], ['restore-archive', '/Volumes/X/a.age', '--replace']]) {
      const r = run(form, 'password1\n')
      expect(r.code, form.join(' ')).toBe(0)
      expect(r.args[r.args.indexOf('--in') + 1]).toBe('/Volumes/X/a.age')
      expect(r.args).toContain('--replace')
    }
    expect(fs.readdirSync(cwd)).toEqual([]) // no stray file named --out
    expect(run(['archive'], '').code).toBe(2)
  })

  test('do-it review 8: a port another program holds is reported before anything is installed', async () => {
    const busy = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    try {
      const free = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
      const freePort = free.port
      free.stop(true)
      const bad = await portProblems({ appPort: busy.port, lanPort: freePort, helperPort: 0 })
      expect(bad).toHaveLength(1)
      expect(bad[0]).toContain(`port ${busy.port}`)
      expect(bad[0]).toContain('--app-port')
    } finally { busy.stop(true) }
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

  test('restore swap: archive database and team folder in place, the previous ones kept beside them, setup token gone, every sign-in ended', () => {
    const home = path.join(BASE, 'restore-home')
    const p = officePaths(home)
    fs.mkdirSync(p.data, { recursive: true })
    fs.mkdirSync(path.join(p.team, 'old'), { recursive: true })
    fs.writeFileSync(path.join(p.data, 'app.db'), 'old-db')
    fs.writeFileSync(path.join(p.data, 'app.db-wal'), 'wal')
    fs.mkdirSync(path.join(p.data, 'sessions', 'chat-1'), { recursive: true })
    fs.writeFileSync(path.join(p.data, 'sessions', 'chat-1', 's.jsonl'), 'stash')
    fs.writeFileSync(p.setupToken, 'token')
    const r = path.join(home, 'restore-1')
    fs.mkdirSync(path.join(r, 'db'), { recursive: true })
    fs.mkdirSync(path.join(r, 'team', 'users', 'desk1'), { recursive: true })
    // a real database as an archive holds it: sign-ins, a used and an unused reset link, a used and an unused invite
    const ndb = openDb(path.join(r, 'db', 'app.sqlite'))
    ndb.run("INSERT INTO users (id, username, name, role) VALUES ('u1', 'desk1', 'Desk', 'member')")
    for (const id of ['s1', 's2']) ndb.run("INSERT INTO sessions (id, user_id, token_hash, client, created_at, last_seen_at, expires_at) VALUES (?, 'u1', ?, 'web', 'x', 'x', '2999-01-01')", [id, `h-${id}`])
    ndb.run("INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at) VALUES ('r1', 'u1', 'hr1', 'x', '2999-01-01', NULL), ('r2', 'u1', 'hr2', 'x', '2999-01-01', 'x')")
    ndb.run("INSERT INTO invites (id, role, token_hash, expires_at, used_at) VALUES ('i1', 'member', 'hi1', '2999-01-01', NULL), ('i2', 'member', 'hi2', '2999-01-01', 'x')")
    ndb.close()
    const kept = swapInRestore(home, r, 'T')
    expect(fs.existsSync(path.join(p.data, 'app.db-wal'))).toBe(false) // the old WAL is gone, the new copy has none
    const db = new Database(path.join(p.data, 'app.db'))
    const ids = (t: string) => (db.query(`SELECT id FROM ${t} ORDER BY id`).all() as { id: string }[]).map((x) => x.id)
    expect(ids('users')).toEqual(['u1'])
    expect(ids('sessions')).toEqual([])
    expect(ids('password_resets')).toEqual(['r2'])
    expect(ids('invites')).toEqual(['i2'])
    db.close()
    expect(fs.existsSync(path.join(p.data, 'sessions'))).toBe(false)
    expect(fs.readFileSync(path.join(kept.sessions!, 'chat-1', 's.jsonl'), 'utf8')).toBe('stash')
    expect(fs.existsSync(path.join(p.team, 'users', 'desk1'))).toBe(true)
    expect(fs.readFileSync(kept.db, 'utf8')).toBe('old-db')
    expect(fs.existsSync(path.join(kept.team, 'old'))).toBe(true)
    expect(fs.existsSync(p.setupToken)).toBe(false)
    expect(fs.existsSync(r)).toBe(false)
  })

  test('restore swap: an unreadable archive database leaves the installation untouched', () => {
    const home = path.join(BASE, 'restore-home-bad')
    const p = officePaths(home)
    fs.mkdirSync(p.data, { recursive: true })
    fs.writeFileSync(path.join(p.data, 'app.db'), 'old-db')
    const r = path.join(home, 'restore-1')
    fs.mkdirSync(path.join(r, 'db'), { recursive: true })
    fs.mkdirSync(path.join(r, 'team'), { recursive: true })
    fs.writeFileSync(path.join(r, 'db', 'app.sqlite'), 'not a database')
    expect(() => swapInRestore(home, r, 'T')).toThrow()
    expect(fs.readFileSync(path.join(p.data, 'app.db'), 'utf8')).toBe('old-db')
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

  test('check-only with a logged-in Claude: prints the settings, changes nothing; Codex on PATH is not used', () => {
    const bin = path.join(BASE, 'pathbin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const r = run('office-install.sh', ['--prefix', prefix, '--lan-port', '18443', '--app-port', '18430', '--check-only'], { TEAMAX_CLAUDE_BIN: fakeClaude(true), PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` })
    expect(r.out).toContain('TEAMAX_LAN_PORT=18443')
    expect(r.out).toContain('TEAMAX_HELPER_PORT=18442')
    expect(r.out).toContain('ports: free')
    expect(r.out).toContain('check only: nothing changed')
    // do-it review 2: Codex is not connected in office mode
    expect(r.out).toMatch(/TEAMAX_CODEX_BIN=\s*\n/)
    expect(r.out).not.toContain(path.join(bin, 'codex'))
    expect(r.code).toBe(0)
    expect(fs.existsSync(prefix)).toBe(false)
  })

  test('do-it review 8: check-only refuses a port another program holds', async () => {
    const busy = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    try {
      const r = run('office-install.sh', ['--prefix', prefix, '--app-port', String(busy.port), '--lan-port', '18443', '--check-only'], { TEAMAX_CLAUDE_BIN: fakeClaude(true) })
      expect(r.code).not.toBe(0)
      expect(r.out).toContain(`port ${busy.port} is in use`)
    } finally { busy.stop(true) }
  })

  test('refuses: Claude not logged in, Claude missing, old macOS, other OS, unknown processor, bad port, long path', () => {
    const ok = { TEAMAX_CLAUDE_BIN: fakeClaude(true) }
    const cases: [string[], Record<string, string>, RegExp][] = [
      [[], { TEAMAX_CLAUDE_BIN: fakeClaude(false) }, /not logged in/],
      [[], { TEAMAX_CLAUDE_BIN: path.join(BASE, 'no-claude') }, /not installed/],
      [[], { ...ok, TEAMAX_TEST_OSVERSION: '12.7' }, /macOS 13 or newer/],
      [[], { ...ok, TEAMAX_TEST_UNAME: 'Linux' }, /runs on macOS/],
      [[], { ...ok, TEAMAX_TEST_ARCH: 'ppc' }, /unsupported processor/],
      [[], { ...ok, TEAMAX_TEST_ARCH: 'x86_64' }, /not an unpacked office bundle for darwin-amd64/],
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
    expect(r.out).toMatch(/is not an office installation of the team server/) // no app/product.env in this folder
    const home = path.join(BASE, 'fakehome')
    fs.mkdirSync(path.join(home, 'config'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config', 'office.env'), 'TEAMAX_LABEL=app.team-ax.office-x\n')
    const r2 = run('office-uninstall.sh', ['--prefix', home, '--delete-data', '--yes'])
    expect(r2.code).not.toBe(0)
    expect(r2.out).toMatch(/refusing/)
    expect(fs.existsSync(path.join(home, 'config', 'office.env'))).toBe(true)
  })
})

describe('build-office.ts: the staged bundle is checked before the zip is made', () => {
  const stage = path.join(BASE, 'stage')
  const fill = (manifest: string[]) => {
    fs.rmSync(stage, { recursive: true, force: true })
    for (const m of manifest) {
      const p = path.join(stage, m.endsWith('/') ? path.join(m, 'x') : m)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, 'x')
    }
  }

  test('both architectures, what office-install.sh reads; pandoc and desktop.sha256 only when built in', () => {
    const m = bundleManifest({ pandoc: true, desktop: false })
    for (const f of ['office-install.sh', 'app/VERSION', 'app/product.env', 'app/server/src/office.js', 'app/server/src/office-worker.js', 'app/server/migrations/',
      'app/bin/darwin-arm64/bun', 'app/bin/darwin-amd64/cloudflared', 'app/bin/darwin-amd64/pandoc', 'app/native/bin/darwin-arm64/mycel-launcher',
      'app/native/bin/darwin-amd64/mycel-ocr', 'app/scripts/macos/engine.sb', 'app/web/dist/index.html']) expect(m).toContain(f)
    expect(m).not.toContain('desktop.sha256')
    expect(bundleManifest({ pandoc: false, desktop: true }).filter((f) => f.endsWith('/pandoc'))).toEqual([])
    expect(bundleManifest({ pandoc: false, desktop: true })).toContain('desktop.sha256')
  })

  test('a complete stage passes; one missing file fails with its name; an empty folder counts as missing', () => {
    const m = bundleManifest({ pandoc: true, desktop: true })
    fill(m)
    expect(missingFromStage(stage, m)).toEqual([])
    fs.rmSync(path.join(stage, 'app', 'native', 'bin', 'darwin-amd64', 'mycel-gate'))
    expect(missingFromStage(stage, m)).toEqual(['app/native/bin/darwin-amd64/mycel-gate'])
    fill(m)
    fs.rmSync(path.join(stage, 'app', 'server', 'migrations', 'x'))
    fs.rmSync(path.join(stage, 'app', 'VERSION'))
    expect(missingFromStage(stage, m)).toEqual(['app/VERSION', 'app/server/migrations/'])
  })
})
