// Which TCP peers may tell the relay the visitor's address (CF-Connecting-IP). Anyone who reaches the relay's origin
// without going through Cloudflare can send that header too, so it counts only when the socket peer is inside one of
// these ranges; every other peer is identified by its own socket address. Plain code (no Node/Bun-only APIs) so the
// relay runs the same under Node 26 and the unit tests under Bun.
import { isIP } from 'node:net'

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4 and /ips-v6, checked 2026-10-21). The word
 * `cloudflare` in --trusted-proxies / RELAY_TRUSTED_PROXIES stands for this list.
 */
export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]

export interface IpRange {
  v: 4 | 6
  /** network address, host bits cleared */
  net: bigint
  bits: number
}

/** IPv4-mapped IPv6 (::ffff:1.2.3.4) as plain IPv4; anything else unchanged */
export function unmapIp(ip: string): string {
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip
}

function toBig(ip: string): { v: 4 | 6; n: bigint } | null {
  ip = unmapIp(ip.trim())
  const fam = isIP(ip)
  if (fam === 4) return { v: 4, n: ip.split('.').reduce((a, p) => (a << 8n) | BigInt(Number(p)), 0n) }
  if (fam !== 6) return null
  let s = ip.split('%')[0].toLowerCase()
  // a trailing dotted quad (::1.2.3.4, 64:ff9b::1.2.3.4) as two hex groups
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s)
  if (quad) {
    const b = quad.slice(1).map(Number)
    s = s.slice(0, quad.index) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16)
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null]
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === null ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t]
  if (groups.length !== 8) return null
  return { v: 6, n: groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g || '0', 16)), 0n) }
}

function parseRange(s: string): IpRange {
  const [addr, len, extra] = s.split('/')
  const a = extra === undefined ? toBig(addr) : null
  if (!a) throw new Error(`not an IP address or CIDR range: ${s}`)
  const max = a.v === 4 ? 32 : 128
  const bits = len === undefined ? max : /^\d{1,3}$/.test(len) ? Number(len) : NaN
  if (!(bits >= 0 && bits <= max)) throw new Error(`bad prefix length in ${s}`)
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits)
  return { v: a.v, net: a.n & mask, bits }
}

/**
 * Comma separated CIDR ranges or single addresses; `cloudflare` adds Cloudflare's ranges, `none` (or empty) trusts
 * nobody. Throws on anything else, so a typo stops the relay at start instead of silently trusting nothing or all.
 */
export function parseTrustedProxies(spec: string): IpRange[] {
  const out: IpRange[] = []
  for (const part of spec.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)) {
    if (part === 'none') continue
    if (part === 'cloudflare') out.push(...CLOUDFLARE_RANGES.map(parseRange))
    else out.push(parseRange(part))
  }
  return out
}

export function ipInRanges(ip: string | undefined | null, ranges: readonly IpRange[]): boolean {
  if (!ip || !ranges.length) return false
  const a = toBig(ip)
  if (!a) return false
  const max = a.v === 4 ? 32 : 128
  return ranges.some((r) => r.v === a.v && (r.bits === 0 ? true : (a.n >> BigInt(max - r.bits)) === (r.net >> BigInt(max - r.bits))))
}
