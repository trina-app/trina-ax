// Which addresses are "office network / this machine" for the in-app browser (design tab 7 "내부망 공격":
// the app browser asks the person before it opens one). Only global unicast addresses count as public; the same
// rule web_fetch uses on the server. Pure: unit-tested in tests/unit/e-netaddr.test.ts.

export type AddressClass = 'public' | 'private'

function v4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((p) => p <= 255) ? parts : null
}

const inV4 = (a: number[], base: string, bits: number) => {
  const b = v4(base)!
  const ai = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0
  const bi = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (ai & mask) === (bi & mask)
}

const V4_NON_GLOBAL: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

function classifyV4(a: number[]): AddressClass {
  return V4_NON_GLOBAL.some(([b, n]) => inV4(a, b, n)) ? 'private' : 'public'
}

/** Expand an IPv6 literal to 8 16-bit groups (embedded IPv4 tail allowed). */
export function parseV6(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null
  // embedded IPv4 tail ("::ffff:1.2.3.4"): rewrite it as two hex groups, then parse normally
  const lastColon = s.lastIndexOf(':')
  const tailText = s.slice(lastColon + 1)
  if (tailText.includes('.')) {
    const a = v4(tailText)
    if (!a) return null
    s = `${s.slice(0, lastColon + 1)}${((a[0] << 8) | a[1]).toString(16)}:${((a[2] << 8) | a[3]).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parse = (h: string) => (h === '' ? [] : h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)))
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  if ([...head, ...rest].some(Number.isNaN)) return null
  const have = head.length + rest.length
  if (halves.length === 2) return have > 7 ? null : [...head, ...new Array<number>(8 - have).fill(0), ...rest]
  return have === 8 ? head : null
}

const v4From = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]

function classifyV6(g: number[]): AddressClass {
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0)
  if (zeroUpTo(8)) return 'private' // ::
  if (zeroUpTo(7) && g[7] === 1) return 'private' // ::1
  if (zeroUpTo(5) && g[5] === 0xffff) return classifyV4(v4From(g[6], g[7])) // ::ffff:a.b.c.d
  if (zeroUpTo(6)) return 'private' // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyV4(v4From(g[6], g[7])) // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'private' // local-use NAT64
  if (g[0] === 0x2002) return classifyV4(v4From(g[1], g[2])) // 6to4
  if (g[0] === 0x2001 && g[1] === 0) {
    // Teredo: server IPv4 in groups 2-3, client IPv4 obfuscated (bit-inverted) in groups 6-7
    const server = classifyV4(v4From(g[2], g[3]))
    const client = classifyV4(v4From(~g[6] & 0xffff, ~g[7] & 0xffff))
    return server === 'public' && client === 'public' ? 'public' : 'private'
  }
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'private' // documentation
  if ((g[0] & 0xe000) !== 0x2000) return 'private' // outside 2000::/3: ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, 100::/64 ...
  return 'public'
}

/** Is this IP literal a global unicast address? Anything unparseable counts as private (fail closed). */
export function classifyIp(ip: string): AddressClass {
  const s = ip.replace(/^\[|\]$/g, '')
  const a = v4(s)
  if (a) return classifyV4(a)
  const g = parseV6(s)
  return g ? classifyV6(g) : 'private'
}

export function isIpLiteral(host: string): boolean {
  const s = host.replace(/^\[|\]$/g, '')
  return v4(s) !== null || parseV6(s) !== null
}

/**
 * Names that resolve inside the office or on this machine without public DNS: localhost, *.localhost, mDNS
 * (*.local), home.arpa, *.internal / *.lan / *.intranet / *.corp, and single-label names (search domains).
 */
export function isLocalName(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h.includes('.')) return true
  return /(^|\.)(localhost|local|home\.arpa|internal|intranet|lan|corp|localdomain)$/.test(h)
}

/** Classify a hostname before DNS: an IP literal or a local name decide alone; otherwise DNS must be asked. */
export function classifyHostStatic(hostname: string): AddressClass | 'resolve' {
  const h = hostname.replace(/^\[|\]$/g, '')
  if (isIpLiteral(h)) return classifyIp(h)
  if (isLocalName(h)) return 'private'
  return 'resolve'
}

/** After DNS: private when ANY resolved address is private (a name pointing at both is an attack shape). */
export function classifyResolved(addresses: string[]): AddressClass {
  if (!addresses.length) return 'private'
  return addresses.some((a) => classifyIp(a) === 'private') ? 'private' : 'public'
}
