// Is a browser URL an office-network (private) address? Such pages need the person's OK before the AI opens them
// in the in-app browser (tab 3 "사내망 주소는 사람 확인"). The browser runs on the person's computer, so this is a
// best-effort check from the server: literal private IPs, local names, and names that resolve to private IPs here.
// Like the web_fetch SSRF rule (tab 3), addresses count as public only when they are global unicast: everything
// else (loopback, private, link-local, documentation, NAT64, 6to4, IPv4 inside IPv6, ...) asks first.
import dns from 'node:dns/promises'
import net from 'node:net'

const LOCAL_SUFFIXES = ['.local', '.internal', '.intranet', '.lan', '.corp', '.home', '.home.arpa', '.localdomain', '.localhost', '.test']

function v4Private(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true
  const [a, b, c] = p as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
}

/** IPv6 text -> 8 groups (handles "::" and a dotted IPv4 tail); null when it is not IPv6. */
export function v6Groups(ip: string): number[] | null {
  if (net.isIP(ip) !== 6) return null
  let s = ip.toLowerCase().replace(/%.*$/, '')
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    const p = v4[1]!.split('.').map(Number)
    s = s.slice(0, -v4[1]!.length) + ((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16)
  }
  const [head, tail] = s.includes('::') ? s.split('::') as [string, string] : [s, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const fill = tail === null ? [] : new Array(8 - h.length - t.length).fill('0')
  const all = [...h, ...fill, ...t].map((x) => parseInt(x, 16))
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null
}

function v6Private(ip: string): boolean {
  const g = v6Groups(ip)
  if (!g) return true
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated): judge the IPv4 inside
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true // :: and ::1
    return v4Private(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`)
  }
  // global unicast is 2000::/3; minus documentation 2001:db8::/32, 6to4 2002::/16, Teredo 2001::/32, ORCHID 2001:10::/28
  if ((g[0]! & 0xe000) !== 0x2000) return true
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0 || (g[1]! & 0xfff0) === 0x0010)) return true
  if (g[0] === 0x2002) return true
  return false
}

export function privateIp(ip: string): boolean {
  const k = net.isIP(ip)
  if (k === 4) return v4Private(ip)
  if (k === 6) return v6Private(ip)
  return false
}

/** URL schemes the AI may open in the Browser pane. Others (file:, javascript:, data:, chrome: ...) are refused:
 * they would read the person's own computer or run code outside any web origin. */
export type BrowserUrl = { ok: true; host: string | null; href: string | null } | { ok: false; reason: string }

/**
 * Classify a URL the AI wants to open. A bare "host[:port]/path" gets https:// (as the desktop app does);
 * "about:blank" is allowed with no host; any other scheme is refused.
 */
export function browserUrl(url: string): BrowserUrl {
  const s = url.trim()
  if (s === 'about:blank') return { ok: true, host: null, href: null }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|file|about|blob|view-source|chrome|chrome-extension|devtools|filesystem|vbscript|mailto|ftp|ws|wss|intent|x-[a-z0-9-]+):/i.test(s)
  let u: URL
  try { u = new URL(hasScheme ? s : `https://${s}`) } catch { return { ok: false, reason: 'not a valid URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `${u.protocol} addresses cannot be opened (only http and https)` }
  return { ok: true, host: normHost(u.hostname), href: u.href }
}

const normHost = (h: string) => h.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()

/** Host part of an http(s) URL the AI wants to open; null for other schemes / bad URLs. */
export function hostOf(url: string): string | null {
  const r = browserUrl(url)
  return r.ok ? r.host : null
}

/** What can be told without DNS: true / false for an IP literal or a local name, null when only a lookup can tell
 * (chat/tools.ts asks the address card first then: the name itself can carry data to its DNS server). */
export function staticPrivateHost(host: string): boolean | null {
  host = normHost(host)
  if (!host) return false
  if (net.isIP(host)) return privateIp(host)
  if (host === 'localhost' || !host.includes('.') || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true
  return null
}

export async function isPrivateHost(host: string, resolve: (h: string) => Promise<string[]> = defaultResolve): Promise<boolean> {
  host = normHost(host)
  const known = staticPrivateHost(host)
  if (known !== null) return known
  try {
    const ips = await resolve(host)
    return ips.some(privateIp)
  } catch { return false }
}

async function defaultResolve(host: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<string[]>((_, rej) => { timer = setTimeout(() => rej(new Error('dns timeout')), 1500) })
  try {
    const r = dns.lookup(host, { all: true }).then((xs) => xs.map((x) => x.address))
    return await Promise.race([r, t])
  } finally { clearTimeout(timer) }
}
