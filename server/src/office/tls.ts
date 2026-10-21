// Office mode TLS (docs/OFFICE.md): a small certificate authority made once on the server Mac, and a server
// certificate it signs for every office-network address and name of the Mac. The desks install the CA once
// (double-click the .cer); after that https://<mac>.local:<port> and https://<LAN IP>:<port> are ordinary trusted
// sites, and a new address (DHCP, another network) only needs a new server certificate, never a new CA on the desks.
//
// Files (<home>/tls, folder 700):
//   ca.key       CA private key (600). Never served, never leaves the Mac; only this module reads it.
//   ca.crt       CA certificate (PEM), served by the helper page as .crt; ca.cer = the same in DER for Windows
//   ca.json      the CA's name constraints (what the server certificate may name)
//   server.key   server private key (600), server.crt server certificate (397 days, renewed 30 days before the end)
//
// The CA is name-constrained (critical nameConstraints): it can only vouch for *.local, this Mac's bare host name and
// private addresses (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7). Ten desks trust it; if its key ever leaked,
// it still could not impersonate a bank or any public site to them. Chrome / Edge (Windows, Mac), Electron, Safari,
// Firefox, curl and Node enforce these constraints; Bun's own fetch (BoringSSL) refuses IP constraints altogether,
// which only matters for tests. TEAMAX_CA_CONSTRAINTS=0 when the CA is first made leaves them out.
//
// Keys are ECDSA P-256 written as named-curve SEC1 (`openssl ecparam -noout`), the same way scripts/install-macos.sh
// makes the production LAN certificate: LibreSSL's `req -newkey ec` writes explicit curve parameters, which Bun's
// BoringSSL refuses.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SERVER_CERT_DAYS = 397
export const RENEW_BEFORE_DAYS = 30
export const CA_DAYS = 3650

/** Private ranges the CA may vouch for: [first address, mask] as openssl writes them. */
export const PRIVATE_V4: [string, string][] = [
  ['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0'], ['100.64.0.0', '255.192.0.0'],
]
export const PRIVATE_V6: [string, string][] = [['fc00:0:0:0:0:0:0:0', 'fe00:0:0:0:0:0:0:0']]

export interface CaConstraints { dns: string[]; v4: [string, string][]; v6: [string, string][] }
export interface OfficeNames { dns: string[]; ips: string[] }
export interface CertSummary { file: string; sha256: string; sha1: string; notAfter: string; names: OfficeNames }

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

// ---- addresses and names -------------------------------------------------------------------------------------

function v4num(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const p = m.slice(1).map(Number)
  if (p.some((x) => x > 255)) return null
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0
}

function inV4(ip: string, base: string, mask: string): boolean {
  const a = v4num(ip), b = v4num(base), m = v4num(mask)
  return a !== null && b !== null && m !== null && ((a & m) >>> 0) === ((b & m) >>> 0)
}

/** Is this IPv6 address in fc00::/7 (unique local: the first byte is fc or fd)? The only IPv6 range the CA names. */
function inUla(ip: string): boolean {
  return /^f[cd][0-9a-f]{0,2}:/.test(ip.toLowerCase())
}

/** May a certificate signed by a CA with these constraints name this address? (no IP constraints = any address) */
export function ipPermitted(ip: string, c: CaConstraints): boolean {
  if (c.v4.length === 0 && c.v6.length === 0) return true
  if (ip.includes(':')) return c.v6.length > 0 && inUla(ip)
  return c.v4.some(([b, m]) => inV4(ip, b, m))
}

/** RFC 5280: a dNSName constraint matches the name itself and every name with more labels on the left. */
export function dnsPermitted(name: string, c: CaConstraints): boolean {
  if (c.dns.length === 0) return true
  const n = name.toLowerCase()
  return c.dns.some((d) => n === d || n.endsWith(`.${d}`))
}

/** IPv6 addresses macOS marks temporary / deprecated / detached in `ifconfig`: they rotate (privacy addresses)
 * and would make the certificate change every day. */
export function unstableV6(ifconfig: string): Set<string> {
  const out = new Set<string>()
  for (const line of ifconfig.split('\n')) {
    const m = /^\s*inet6\s+([0-9a-f:]+)(?:%\S+)?\s.*\b(temporary|deprecated|detached|tentative|duplicated)\b/i.exec(line)
    if (m) out.add(m[1]!.toLowerCase())
  }
  return out
}

/**
 * The Mac's office-network addresses: every non-internal IPv4 and IPv6 of every interface, minus link-local
 * (169.254/16, fe80::/10: a browser cannot use them in a URL), loopback and the rotating IPv6 privacy addresses.
 * IPv4 first (office ranges 192.168 / 10 / 172.16 before VPN ranges such as 100.64/10), then IPv6.
 */
export function lanAddresses(o: { ifaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>; ifconfig?: string | null } = {}): string[] {
  const ifaces = o.ifaces ?? os.networkInterfaces()
  const ifconfig = o.ifconfig === undefined ? readIfconfig() : o.ifconfig
  const skip = ifconfig ? unstableV6(ifconfig) : new Set<string>()
  const v4: string[] = [], v6: string[] = []
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal) continue
      const addr = a.address.toLowerCase().replace(/%.*$/, '')
      if (a.family === 'IPv4') {
        if (inV4(addr, '169.254.0.0', '255.255.0.0') || inV4(addr, '127.0.0.0', '255.0.0.0')) continue
        v4.push(addr)
      } else {
        if (/^fe[89ab][0-9a-f]:/.test(addr) || addr === '::1' || skip.has(addr)) continue
        v6.push(addr)
      }
    }
  }
  // office ranges before VPN / carrier-grade NAT ones (100.64/10: Tailscale and the like), then numeric
  const rank = (a: string) => ['192.168.0.0/255.255.0.0', '10.0.0.0/255.0.0.0', '172.16.0.0/255.240.0.0'].findIndex((r) => inV4(a, ...(r.split('/') as [string, string])))
  const r = (a: string) => { const i = rank(a); return i < 0 ? (inV4(a, '100.64.0.0', '255.192.0.0') ? 4 : 3) : i }
  const byV4 = (a: string, b: string) => r(a) - r(b) || v4num(a)! - v4num(b)!
  return [...new Set(v4)].sort(byV4).concat([...new Set(v6)].sort())
}

function readIfconfig(): string | null {
  if (process.platform !== 'darwin') return null
  try { return Bun.spawnSync(['/sbin/ifconfig'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString() } catch { return null }
}

/** This Mac's Bonjour name (System Settings → General → Sharing → Local hostname), lower case; null if unusable. */
export function localHostName(): string | null {
  let n = ''
  if (process.platform === 'darwin') {
    try { n = Bun.spawnSync(['/usr/sbin/scutil', '--get', 'LocalHostName'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim() } catch {}
  }
  if (!n) n = os.hostname().replace(/\.local$/i, '').split('.')[0] ?? ''
  n = n.toLowerCase()
  return LABEL.test(n) ? n : null
}

/** Names the server certificate should carry: <host>.local and <host>, then the addresses (only what the CA may
 * name). `left` = addresses left out because the CA may not vouch for them (e.g. a public IPv6). */
export function wantedNames(host: string | null, addrs: string[], c: CaConstraints): OfficeNames & { left: string[] } {
  const dns = host ? [`${host}.local`, host].filter((d) => dnsPermitted(d, c)) : []
  const ips = addrs.filter((a) => ipPermitted(a, c))
  return { dns, ips, left: addrs.filter((a) => !ipPermitted(a, c)) }
}

/** host:port as a browser sends it in the Host header (IPv6 in brackets), lower case. */
export function hostPort(name: string, port: number): string {
  return (name.includes(':') ? `[${name}]` : name).toLowerCase() + `:${port}`
}

// ---- certificates --------------------------------------------------------------------------------------------

const OPENSSL = '/usr/bin/openssl'
export class TlsError extends Error { name = 'TlsError' }

function openssl(args: string[], cwd: string) {
  const bin = fs.existsSync(OPENSSL) ? OPENSSL : 'openssl'
  const p = Bun.spawnSync([bin, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
  if (p.exitCode !== 0) throw new TlsError(`openssl ${args[0]} failed: ${p.stderr.toString().trim().split('\n').slice(-2).join(' ')}`)
}

/** Write `data` to `file` through a temporary sibling + rename (never half a key, never through a planted link). */
function writeAtomic(file: string, data: string | Uint8Array, mode: number) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, data, { mode, flag: 'wx' })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}

function readCert(file: string): crypto.X509Certificate | null {
  try { return new crypto.X509Certificate(fs.readFileSync(file)) } catch { return null }
}

/** SAN entries of a certificate as { dns, ips } (IPv6 normalised to lower-case compressed form). */
export function certNames(cert: crypto.X509Certificate): OfficeNames {
  const dns: string[] = [], ips: string[] = []
  for (const part of (cert.subjectAltName ?? '').split(/,\s*/)) {
    const d = /^DNS:(.+)$/.exec(part)
    const i = /^IP Address:(.+)$/.exec(part)
    if (d) dns.push(d[1]!.toLowerCase())
    else if (i) ips.push(normIp(i[1]!))
  }
  return { dns, ips }
}

/** 1:2:0:0:0:0:0:3 (how X509Certificate prints IPv6) → 1:2::3, lower case; IPv4 unchanged. */
export function normIp(ip: string): string {
  if (!ip.includes(':')) return ip
  const u = new URL(`http://[${ip}]/`)
  return u.hostname.slice(1, -1)
}

export function fingerprints(cert: crypto.X509Certificate): { sha256: string; sha1: string } {
  return { sha256: cert.fingerprint256, sha1: cert.fingerprint }
}

export interface TlsPaths { dir: string; caKey: string; caCrt: string; caCer: string; caJson: string; key: string; crt: string }
export function tlsPaths(dir: string): TlsPaths {
  return {
    dir, caKey: path.join(dir, 'ca.key'), caCrt: path.join(dir, 'ca.crt'), caCer: path.join(dir, 'ca.cer'),
    caJson: path.join(dir, 'ca.json'), key: path.join(dir, 'server.key'), crt: path.join(dir, 'server.crt'),
  }
}

function mkdirPrivate(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new TlsError(`${dir} is not a folder`)
  if (st.uid !== process.getuid?.()) throw new TlsError(`${dir} belongs to another user`)
  fs.chmodSync(dir, 0o700)
}

/**
 * The CA: kept when ca.key + ca.crt exist, belong together and the CA is valid for another 30 days; made otherwise.
 * `host` goes into the constraints (the Mac's bare name) and the CA's common name.
 */
export function ensureCa(dir: string, o: { host: string | null; constraints?: boolean; now?: Date } = { host: null }): { made: boolean; cert: crypto.X509Certificate; constraints: CaConstraints } {
  const p = tlsPaths(dir)
  mkdirPrivate(dir)
  const now = o.now ?? new Date()
  const existing = readCert(p.caCrt)
  if (existing && fs.existsSync(p.caKey) && existing.ca && existing.validToDate.getTime() - now.getTime() > RENEW_BEFORE_DAYS * 86400_000) {
    try {
      const key = crypto.createPrivateKey(fs.readFileSync(p.caKey))
      if (existing.checkPrivateKey(key)) {
        fs.chmodSync(p.caKey, 0o600)
        if (!fs.existsSync(p.caCer)) writeAtomic(p.caCer, existing.raw, 0o644)
        return { made: false, cert: existing, constraints: readConstraints(p.caJson) }
      }
    } catch {}
  }
  const constraints: CaConstraints = o.constraints === false
    ? { dns: [], v4: [], v6: [] }
    : { dns: ['local', ...(o.host ? [o.host] : [])], v4: PRIVATE_V4, v6: PRIVATE_V6 }
  const stamp = now.toISOString().slice(0, 10)
  const subj = `/O=Team AX/CN=Team AX office CA ${o.host ?? 'server'} ${stamp}`
  const tmpKey = `ca.key.new-${process.pid}`
  const tmpCrt = `ca.crt.new-${process.pid}`
  try {
    // umask 077 for the key: openssl creates it, then we check the mode anyway
    const old = process.umask(0o077)
    try { openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', tmpKey], dir) } finally { process.umask(old) }
    const ext = ['-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash']
    const nc = [...constraints.dns.map((d) => `permitted;DNS:${d}`), ...constraints.v4.map(([b, m]) => `permitted;IP:${b}/${m}`), ...constraints.v6.map(([b, m]) => `permitted;IP:${b}/${m}`)]
    if (nc.length) ext.push('-addext', `nameConstraints=critical,${nc.join(',')}`)
    openssl(['req', '-new', '-x509', '-sha256', '-key', tmpKey, '-days', String(CA_DAYS), '-subj', subj, ...ext, '-out', tmpCrt], dir)
    fs.chmodSync(path.join(dir, tmpKey), 0o600)
    const cert = new crypto.X509Certificate(fs.readFileSync(path.join(dir, tmpCrt)))
    // the old CA (if any) is kept next to it: desks that trusted it are not silently orphaned without a trace
    for (const f of [p.caKey, p.caCrt]) if (fs.existsSync(f)) fs.renameSync(f, `${f}.old-${stamp}`)
    fs.renameSync(path.join(dir, tmpKey), p.caKey)
    fs.renameSync(path.join(dir, tmpCrt), p.caCrt)
    fs.chmodSync(p.caCrt, 0o644)
    writeAtomic(p.caCer, cert.raw, 0o644)
    writeAtomic(p.caJson, JSON.stringify({ format: 1, constraints }, null, 1) + '\n', 0o644)
    for (const f of [p.key, p.crt]) fs.rmSync(f, { force: true }) // signed by the old CA
    return { made: true, cert, constraints }
  } finally {
    for (const f of [tmpKey, tmpCrt]) fs.rmSync(path.join(dir, f), { force: true })
  }
}

function readConstraints(file: string): CaConstraints {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')).constraints
    if (Array.isArray(j?.dns) && Array.isArray(j?.v4) && Array.isArray(j?.v6)) return j
  } catch {}
  return { dns: ['local'], v4: PRIVATE_V4, v6: PRIVATE_V6 } // a CA from before ca.json: assume the default
}

/** Why the current server certificate must be replaced (null = it is fine). */
export function serverCertProblem(dir: string, want: OfficeNames, now = new Date()): string | null {
  const p = tlsPaths(dir)
  const cert = readCert(p.crt)
  const ca = readCert(p.caCrt)
  if (!cert || !ca) return 'missing'
  if (!fs.existsSync(p.key)) return 'missing key'
  try { if (!cert.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(p.key)))) return 'key does not match' } catch { return 'unreadable key' }
  if (!cert.verify(ca.publicKey)) return 'not signed by the current CA'
  if (cert.validToDate.getTime() - now.getTime() < RENEW_BEFORE_DAYS * 86400_000) return 'expires soon'
  const have = certNames(cert)
  const missing = [...want.dns.filter((d) => !have.dns.includes(d)), ...want.ips.filter((i) => !have.ips.includes(normIp(i)))]
  return missing.length ? `new name or address: ${missing.join(', ')}` : null
}

/** Sign a fresh server certificate for exactly these names (key replaced too). */
export function issueServerCert(dir: string, names: OfficeNames): crypto.X509Certificate {
  const p = tlsPaths(dir)
  if (names.dns.length + names.ips.length === 0) throw new TlsError('no name or address to put in the certificate')
  for (const d of names.dns) if (!/^[a-z0-9.-]{1,253}$/i.test(d)) throw new TlsError(`bad name ${d}`)
  for (const i of names.ips) if (!/^[0-9a-f:.]{2,45}$/i.test(i)) throw new TlsError(`bad address ${i}`)
  const san = [...names.dns.map((d) => `DNS:${d}`), ...names.ips.map((i) => `IP:${i}`)].join(',')
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const f = { key: `server.key.new-${tag}`, csr: `server.csr-${tag}`, ext: `server.ext-${tag}`, crt: `server.crt.new-${tag}`, srl: `ca.srl-${tag}` }
  try {
    const old = process.umask(0o077)
    try { openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f.key], dir) } finally { process.umask(old) }
    const cn = names.dns[0] ?? names.ips[0]!
    openssl(['req', '-new', '-sha256', '-key', f.key, '-subj', `/O=Team AX/CN=${cn}`, '-out', f.csr], dir)
    fs.writeFileSync(path.join(dir, f.ext), [
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=serverAuth',
      `subjectAltName=${san}`, 'authorityKeyIdentifier=keyid', 'subjectKeyIdentifier=hash', '',
    ].join('\n'), { mode: 0o600 })
    fs.writeFileSync(path.join(dir, f.srl), crypto.randomBytes(16).toString('hex').replace(/^[89a-f]/, '1') + '\n', { mode: 0o600 })
    openssl(['x509', '-req', '-sha256', '-in', f.csr, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAserial', f.srl, '-days', String(SERVER_CERT_DAYS), '-extfile', f.ext, '-out', f.crt], dir)
    const cert = new crypto.X509Certificate(fs.readFileSync(path.join(dir, f.crt)))
    fs.chmodSync(path.join(dir, f.key), 0o600)
    fs.renameSync(path.join(dir, f.key), p.key)
    fs.chmodSync(path.join(dir, f.crt), 0o644)
    fs.renameSync(path.join(dir, f.crt), p.crt)
    return cert
  } finally {
    for (const n of Object.values(f)) fs.rmSync(path.join(dir, n), { force: true })
  }
}

/** CA + server certificate for the names the Mac has now. `changed` = a new server certificate was written. */
export function ensureOfficeTls(dir: string, o: { host: string | null; addrs: string[]; constraints?: boolean; now?: Date }) {
  const ca = ensureCa(dir, { host: o.host, constraints: o.constraints, now: o.now })
  const want = wantedNames(o.host, o.addrs, ca.constraints)
  const problem = serverCertProblem(dir, want, o.now)
  let cert: crypto.X509Certificate
  if (problem) cert = issueServerCert(dir, want)
  else cert = new crypto.X509Certificate(fs.readFileSync(tlsPaths(dir).crt))
  return { caMade: ca.made, changed: problem !== null, reason: problem, ca: ca.cert, cert, names: certNames(cert), left: want.left, constraints: ca.constraints }
}
