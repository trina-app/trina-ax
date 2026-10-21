// Office-network TLS certificate (design tab 4 "사무실 직접 연결", tab 6 "설치"). The installed server's direct
// address is https://<LocalHostName>.local:<tls port> or https://<LAN IP>:<tls port>, so the self-signed certificate
// has to name every one of them: <LocalHostName>.local, localhost, 127.0.0.1, ::1 and every LAN IPv4 / IPv6 address
// of this Mac. Addresses change (another Wi-Fi, a new DHCP lease, a second network port), so the installer creates it
// and the server checks it again at start and every minute, and makes a new one when an address is not covered, the
// host name changed, or it expires within 30 days. A new certificate has a new fingerprint: setup/lan-cert.sha256 is
// rewritten, and the desktop app picks the new one up from the server (it pins what the server says over the relay).
//
// Not named: IPv6 link-local addresses (fe80::/10 need a %zone, no browser takes them), IPv6 temporary (privacy)
// addresses (they rotate daily and would make a new certificate every day; the stable "secured" address of the same
// interface is named), CLAT46 addresses and 192.0.0.0/29 (IPv6-only networks' internal IPv4 shim).
//
// ECDSA P-256 with a named-curve SEC1 key (LibreSSL's "req -newkey ec" writes explicit curve parameters, which Bun's
// BoringSSL refuses), 825 days (Apple platforms refuse TLS server certificates valid for longer), serverAuth.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LAN_CERT_DAYS = 825
export const LAN_CERT_RENEW_MS = 30 * 86400_000

export interface LanNames { dns: string[]; ips: string[] }

/** Canonical text of an IP address (IPv6 fully expanded, lower case, no zone) so SAN entries and interface addresses compare. */
export function canonIp(ip: string): string {
  let s = ip.trim().toLowerCase().replace(/%.*$/, '')
  if (!s.includes(':')) return s
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    const p = v4[1]!.split('.').map(Number)
    s = s.slice(0, -v4[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16)
  }
  const [head, tail] = s.includes('::') ? s.split('::', 2) as [string, string] : [s, null]
  const a = head ? head.split(':') : []
  const b = tail === null ? [] : tail ? tail.split(':') : []
  const groups = tail === null ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b]
  return groups.map((g) => parseInt(g || '0', 16).toString(16)).join(':')
}

const isLinkLocal6 = (ip: string) => /^fe[89ab][0-9a-f]?:/i.test(ip)
const isShim4 = (ip: string) => /^192\.0\.0\.[0-7]$/.test(ip)

/**
 * The LAN addresses to name, from `ifconfig` on macOS (it marks temporary / CLAT addresses; node's
 * networkInterfaces() does not), else from os.networkInterfaces(). Loopback is added by the caller.
 */
export function lanAddresses(o: { ifconfig?: string | null; interfaces?: ReturnType<typeof os.networkInterfaces> } = {}): string[] {
  const out = new Set<string>()
  const text = o.ifconfig !== undefined ? o.ifconfig : process.platform === 'darwin' ? runText(['/sbin/ifconfig']) : null
  if (text) {
    let loopback = false
    for (const line of text.split('\n')) {
      const head = /^([a-z0-9]+): flags=\w+<([^>]*)>/i.exec(line)
      if (head) { loopback = head[2]!.split(',').includes('LOOPBACK'); continue }
      if (loopback) continue
      const m = /^\s+inet(6?) ([0-9a-fA-F:.%a-z]+)(.*)$/.exec(line)
      if (!m) continue
      const ip = m[2]!.replace(/%.*$/, '')
      const flags = m[3]!
      if (m[1]) {
        if (isLinkLocal6(ip) || /\b(temporary|deprecated|detached|tentative|duplicated|clat46)\b/.test(flags)) continue
      } else if (isShim4(ip) || ip.startsWith('127.')) continue
      out.add(canonIp(ip))
    }
    return [...out]
  }
  for (const list of Object.values(o.interfaces ?? os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal) continue
      if (a.family === 'IPv6' && isLinkLocal6(a.address)) continue
      if (a.family === 'IPv4' && isShim4(a.address)) continue
      out.add(canonIp(a.address))
    }
  }
  return [...out]
}

/** <LocalHostName> (Bonjour name, what <name>.local resolves to), else the host name without a domain. */
export function localHostName(): string {
  const scutil = process.platform === 'darwin' ? runText(['/usr/sbin/scutil', '--get', 'LocalHostName'])?.trim() : null
  const name = scutil || os.hostname().replace(/\.local\.?$/i, '').split('.')[0] || 'localhost'
  return name.replace(/[^A-Za-z0-9-]/g, '-')
}

/** Every name the certificate must carry right now. */
export function wantedNames(o: { host?: string; addresses?: string[] } = {}): LanNames {
  const host = o.host ?? localHostName()
  const ips = ['127.0.0.1', canonIp('::1'), ...(o.addresses ?? lanAddresses())]
  return { dns: [`${host.toLowerCase()}.local`, 'localhost'], ips: [...new Set(ips.map(canonIp))] }
}

/** Names a certificate carries (SAN), canonical. */
export function certNames(pem: string | Buffer): LanNames & { notAfter: number; fingerprint: string } {
  const c = new crypto.X509Certificate(pem)
  const dns: string[] = [], ips: string[] = []
  for (const part of (c.subjectAltName ?? '').split(/,\s*/)) {
    if (part.startsWith('DNS:')) dns.push(part.slice(4).toLowerCase())
    else if (part.startsWith('IP Address:')) ips.push(canonIp(part.slice(11)))
  }
  return { dns, ips, notAfter: Date.parse(c.validTo), fingerprint: c.fingerprint256 }
}

/** What the certificate in `pem` lacks for `want` ([] = covers everything). */
export function missingNames(pem: string | Buffer, want: LanNames): string[] {
  const have = certNames(pem)
  return [...want.dns.filter((d) => !have.dns.includes(d)), ...want.ips.filter((i) => !have.ips.includes(i))]
}

export interface LanCertFiles { certFile: string; keyFile: string; fingerprintFile?: string | null }
export interface LanCertResult { changed: boolean; reason: string | null; fingerprint: string; names: LanNames }

/**
 * Keep the certificate covering `want` (default: this Mac now). Returns changed=true when it wrote a new key and
 * certificate (temp file + rename, key 0600, certificate 0644) and the fingerprint file (0640).
 */
export function ensureLanCert(f: LanCertFiles, o: { want?: LanNames; now?: number; openssl?: string } = {}): LanCertResult {
  const want = o.want ?? wantedNames()
  const now = o.now ?? Date.now()
  let reason: string | null = null
  let pem: Buffer | null = null
  try {
    pem = fs.readFileSync(f.certFile)
    const key = fs.readFileSync(f.keyFile, 'utf8')
    if (!key.includes('BEGIN EC PRIVATE KEY')) reason = 'key is not a named-curve EC key'
    const info = certNames(pem)
    if (!reason && !keyMatches(key, pem)) reason = 'key does not belong to the certificate'
    if (!reason && info.notAfter - now < LAN_CERT_RENEW_MS) reason = 'expires within 30 days'
    if (!reason) {
      const miss = missingNames(pem, want)
      if (miss.length) reason = `does not name ${miss.join(', ')}`
    }
  } catch (e) {
    reason = pem ? `unreadable (${(e as Error).message})` : 'missing'
  }
  if (!reason && pem) {
    const fp = certNames(pem).fingerprint
    if (f.fingerprintFile && readText(f.fingerprintFile)?.trim() !== fp) writeAtomic(f.fingerprintFile, fp + '\n', 0o640)
    return { changed: false, reason: null, fingerprint: fp, names: want }
  }
  const fp = generate(f, want, o.openssl ?? '/usr/bin/openssl')
  if (f.fingerprintFile) writeAtomic(f.fingerprintFile, fp + '\n', 0o640)
  return { changed: true, reason, fingerprint: fp, names: want }
}

function keyMatches(keyPem: string, certPem: Buffer): boolean {
  const a = crypto.createPublicKey(crypto.createPrivateKey(keyPem)).export({ format: 'der', type: 'spki' }) as Buffer
  const b = new crypto.X509Certificate(certPem).publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  return a.equals(b)
}

function generate(f: LanCertFiles, want: LanNames, openssl: string): string {
  const dir = fs.mkdtempSync(path.join(path.dirname(f.certFile), '.lan-cert-'))
  try {
    fs.chmodSync(dir, 0o700)
    const key = path.join(dir, 'key.pem'), crt = path.join(dir, 'crt.pem')
    run([openssl, 'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key])
    fs.chmodSync(key, 0o600)
    const san = [...want.dns.map((d) => `DNS:${d}`), ...want.ips.map((i) => `IP:${i}`)].join(',')
    run([openssl, 'req', '-new', '-x509', '-key', key, '-days', String(LAN_CERT_DAYS), '-subj', `/CN=${want.dns[0]}`,
      '-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth', '-addext', 'keyUsage=critical,digitalSignature',
      '-addext', 'basicConstraints=critical,CA:FALSE', '-out', crt])
    fs.chmodSync(crt, 0o644)
    const fp = new crypto.X509Certificate(fs.readFileSync(crt)).fingerprint256
    // key first: a server that reads between the two renames gets the old certificate with the new key and fails
    // that one handshake; the other order would serve a certificate whose key it does not have either way
    fs.renameSync(key, f.keyFile)
    fs.renameSync(crt, f.certFile)
    return fp
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function run(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } })
  if (p.exitCode !== 0) throw new Error(`${path.basename(cmd[0]!)} ${cmd[1]} failed: ${p.stderr.toString().trim().slice(0, 300)}`)
}

function runText(cmd: string[]): string | null {
  try {
    const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore' })
    return p.exitCode === 0 ? p.stdout.toString() : null
  } catch { return null }
}

function readText(f: string): string | null {
  try { return fs.readFileSync(f, 'utf8') } catch { return null }
}

function writeAtomic(file: string, text: string, mode: number): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.rmSync(tmp, { force: true })
  fs.writeFileSync(tmp, text, { mode, flag: 'wx' })
  fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, file)
}
