// Office mode's Tailscale address (docs/OFFICE.md "Tailscale 주소"): the server Mac answers
// https://<machine>.<tailnet>.ts.net:<port> to the devices of its tailnet, from anywhere, with a real certificate
// (Let's Encrypt, through `tailscale cert`). No office CA to install on a phone.
//
// How it works:
//   - the supervisor (cli.ts) finds the Tailscale CLI, reads `tailscale status --json` (the certificate name, the
//     node's IPv4 address, the HTTPS capability) and gets the certificate with `tailscale cert` into tls/tailnet.crt +
//     tls/tailnet.key. It asks again every 12 hours: tailscaled renews the certificate itself before it ends, and
//     the server swaps the listener when the file changes (main.ts).
//   - server.json `tailnet` names the listener: bound to the node's Tailscale IPv4 address only (not 0.0.0.0), so
//     the port does not exist on the office network. Tailscale routes 100.64.0.0/10 through its own interface, so a
//     LAN device that gives itself a 100.x address cannot complete a TCP handshake with it either.
//   - the server answers that listener only for peers in 100.64.0.0/10 and only for Host <name>[:port]
//     (http/middleware.ts hostCheck), and treats every request on it as coming from outside the office: the first-run
//     setup is refused, health says only "alive" to a signed-out visitor, sign-in failures use the internet limits.
//
// Not `tailscale serve`: it hands requests to the loopback app port, where they look like they come from the Mac
// itself (the first-run setup and the office-network check would see 127.0.0.1).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** where the Tailscale CLI may be, in this order (the LaunchAgent's PATH has none of them) */
export const TAILSCALE_BINS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale', // the Mac app (App Store or standalone)
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
]

/** the CGNAT range Tailscale gives its IPv4 addresses from */
export const TAILNET_V4 = '100.64.0.0/10'
/** how often the supervisor asks `tailscale cert` again (it returns the cached certificate until it renews it) */
export const TAILNET_CERT_CHECK_MS = 12 * 3600_000
/** warn when the certificate has fewer days than this (tailscaled renews well before) */
export const TAILNET_WARN_DAYS = 7

/** <machine>.<tailnet>.ts.net, lower case */
export const TS_NET_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$/

export type Run = (args: string[]) => { code: number; out: string; err: string }

export function findTailscaleBin(o: { configured?: string | null; exists?: (f: string) => boolean } = {}): string | null {
  const exists = o.exists ?? ((f: string) => { try { return fs.statSync(f).isFile() } catch { return false } })
  if (o.configured) return exists(o.configured) ? o.configured : null
  return TAILSCALE_BINS.find(exists) ?? null
}

export function runner(bin: string, timeoutMs = 60_000): Run {
  return (args) => {
    // TAILSCALE_BE_CLI: the Mac app's binary is the CLI only when started from a login shell, else it tries to open
    // the app ("The Tailscale GUI failed to start"); the LaunchAgent and an SSH command have no such shell
    const p = Bun.spawnSync([bin, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', TAILSCALE_BE_CLI: '1' } })
    return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() }
  }
}

export interface TailnetNode {
  /** the certificate name (CertDomains[0]), null when HTTPS certificates are off for the tailnet */
  certName: string | null
  /** the node's Tailscale IPv4 address */
  ipv4: string | null
  /** BackendState is Running */
  running: boolean
  /** why the address cannot work, in words for the owner (null = fine) */
  problem: string | null
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
export function inTailnetV4(ip: string | null | undefined): boolean {
  const m = V4.exec(ip ?? '')
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return false
  return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127
}

/** `tailscale status --json` → what the office server needs */
export function parseStatus(json: string): TailnetNode {
  let j: Record<string, unknown>
  try { j = JSON.parse(json) } catch { return { certName: null, ipv4: null, running: false, problem: 'tailscale status --json gave no JSON' } }
  const running = j.BackendState === 'Running'
  const self = (j.Self ?? {}) as { TailscaleIPs?: unknown; Capabilities?: unknown }
  const ips = Array.isArray(j.TailscaleIPs) ? j.TailscaleIPs : Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []
  const ipv4 = (ips as unknown[]).find((i): i is string => typeof i === 'string' && inTailnetV4(i)) ?? null
  const domains = Array.isArray(j.CertDomains) ? (j.CertDomains as unknown[]).filter((d): d is string => typeof d === 'string') : []
  const certName = domains.map((d) => d.toLowerCase().replace(/\.$/, '')).find((d) => TS_NET_NAME.test(d)) ?? null
  const caps = Array.isArray(self.Capabilities) ? self.Capabilities as unknown[] : []
  const https = caps.includes('https') || certName !== null
  const problem = !running ? `Tailscale is not connected (state ${String(j.BackendState ?? 'unknown')}): open the Tailscale app and sign in`
    : !https || !certName ? 'HTTPS certificates are off for this tailnet: turn on "HTTPS Certificates" at https://login.tailscale.com/admin/dns (and MagicDNS), then try again'
    : !ipv4 ? 'this Mac has no Tailscale IPv4 address'
    : null
  return { certName, ipv4, running, problem }
}

/** the TCP ports `tailscale serve` / Funnel already take on this node (tailscaled answers them, our listener would get
 * nothing): `tailscale serve status --json` TCP keys */
export function servePorts(json: string): number[] {
  try {
    const tcp = (JSON.parse(json) as { TCP?: Record<string, unknown> }).TCP ?? {}
    return Object.keys(tcp).map(Number).filter((n) => Number.isInteger(n) && n > 0)
  } catch { return [] }
}

export function readNode(run: Run): TailnetNode {
  const r = run(['status', '--json'])
  if (r.code !== 0 && !r.out.trim().startsWith('{')) return { certName: null, ipv4: null, running: false, problem: `tailscale status failed: ${(r.err || r.out).trim().split('\n')[0] ?? ''}` }
  return parseStatus(r.out)
}

export function readServePorts(run: Run): number[] {
  const r = run(['serve', 'status', '--json'])
  return r.code === 0 ? servePorts(r.out) : []
}

// ---- the certificate -------------------------------------------------------------------------------------------

export interface TailnetCertPaths { crt: string; key: string }
export const tailnetCertPaths = (tlsDir: string): TailnetCertPaths => ({ crt: path.join(tlsDir, 'tailnet.crt'), key: path.join(tlsDir, 'tailnet.key') })

/** Why a certificate + key pair cannot serve this name now (null = it can). `cert` is the full PEM chain. */
export function pairProblem(certPem: string, keyPem: string, name: string, now = new Date()): string | null {
  let leaf: crypto.X509Certificate
  try { leaf = new crypto.X509Certificate(certPem) } catch { return 'unreadable certificate' }
  try { if (!leaf.checkPrivateKey(crypto.createPrivateKey(keyPem))) return 'the key does not belong to the certificate' } catch { return 'unreadable key' }
  if (!leaf.checkHost(name)) return `the certificate is not for ${name}`
  if (leaf.validToDate.getTime() <= now.getTime()) return 'the certificate has ended'
  if (leaf.validFromDate.getTime() > now.getTime() + 3600_000) return 'the certificate is not valid yet'
  return null
}

/** days left on the certificate in this file, or null */
export function daysLeft(certFile: string, now = new Date()): number | null {
  try { return (new crypto.X509Certificate(fs.readFileSync(certFile)).validToDate.getTime() - now.getTime()) / 86400_000 } catch { return null }
}

export interface CertResult {
  /** a new certificate (or key) was written */
  changed: boolean
  /** the certificate in place can serve the name */
  ok: boolean
  daysLeft: number | null
  /** a line for the owner: a failure, or few days left */
  warning: string | null
}

/**
 * Ask `tailscale cert` for the name's certificate into temporary files, check the pair, and put it in place (rename)
 * when it differs from the one there. A failure keeps the certificate in place (it may still have weeks left).
 */
export function refreshTailnetCert(tlsDir: string, name: string, run: Run, now = new Date()): CertResult {
  const p = tailnetCertPaths(tlsDir)
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const tmp = { crt: `${p.crt}.new-${tag}`, key: `${p.key}.new-${tag}` }
  const current = (): CertResult => {
    let cur: string | null = null
    try { cur = pairProblem(fs.readFileSync(p.crt, 'utf8'), fs.readFileSync(p.key, 'utf8'), name, now) } catch { cur = 'missing' }
    const left = cur ? null : daysLeft(p.crt, now)
    return { changed: false, ok: cur === null, daysLeft: left, warning: null }
  }
  try {
    const old = process.umask(0o077)
    let r: ReturnType<Run>
    try { r = run(['cert', '--cert-file', tmp.crt, '--key-file', tmp.key, name]) } finally { process.umask(old) }
    if (r.code !== 0 || !fs.existsSync(tmp.crt) || !fs.existsSync(tmp.key)) {
      const c = current()
      return { ...c, warning: `tailscale cert ${name} failed: ${(r.err || r.out).trim().split('\n').slice(-1)[0] ?? ''}${c.ok ? ` (the certificate in place has ${Math.floor(c.daysLeft ?? 0)} days left)` : ''}` }
    }
    const crt = fs.readFileSync(tmp.crt, 'utf8'), key = fs.readFileSync(tmp.key, 'utf8')
    const bad = pairProblem(crt, key, name, now)
    if (bad) { const c = current(); return { ...c, warning: `tailscale cert ${name} gave an unusable certificate (${bad})` } }
    let same = false
    try { same = fs.readFileSync(p.crt, 'utf8') === crt && fs.readFileSync(p.key, 'utf8') === key } catch {}
    if (!same) {
      // key first, then the certificate: the server reloads on a new certificate and checks the pair first (main.ts)
      fs.chmodSync(tmp.key, 0o600); fs.renameSync(tmp.key, p.key)
      fs.chmodSync(tmp.crt, 0o644); fs.renameSync(tmp.crt, p.crt)
    }
    const left = daysLeft(p.crt, now)
    const warning = left !== null && left < TAILNET_WARN_DAYS ? `the Tailscale certificate for ${name} ends in ${Math.max(0, Math.floor(left))} days and Tailscale has not renewed it yet` : null
    return { changed: !same, ok: true, daysLeft: left, warning }
  } finally {
    for (const f of Object.values(tmp)) fs.rmSync(f, { force: true })
  }
}

/** Is a refresh due? Always when the pair in place is missing or bad, else every TAILNET_CERT_CHECK_MS. */
export function certCheckDue(tlsDir: string, name: string, lastCheck: number, now = new Date()): boolean {
  const p = tailnetCertPaths(tlsDir)
  try { if (pairProblem(fs.readFileSync(p.crt, 'utf8'), fs.readFileSync(p.key, 'utf8'), name, now)) return true } catch { return true }
  return now.getTime() - lastCheck >= TAILNET_CERT_CHECK_MS
}
