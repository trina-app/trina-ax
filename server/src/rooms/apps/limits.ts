// The /in/ address's own limits (docs/DECISIONS.md "Apps posting in rooms"), checked before a byte of the body is read:
//   - an unknown or malformed address: per client address and its network (IPv4 /24, IPv6 /48), per minute;
//   - a live app: a burst, then one request a second.
// In memory, per server process (one process serves a team): minute buckets need no history, and nothing here is
// shared with the external apps' sign-in limits (RemoteOAuth.ingress answers 503 while app connectors are off). The
// day's received count lives in room_app_days (it must outlive a restart). Bounded: at most MAX_KEYS keys, the oldest
// dropped first.
import { ROOM_APP_BURST, ROOM_APP_PER_SECOND, ROOM_APP_UNKNOWN_PER_MINUTE, ROOM_APP_UNKNOWN_PER_MINUTE_EXEMPT } from '@mycel/shared/api'

const MAX_KEYS = 50_000
const MINUTE = 60_000

/** The network of an address: IPv4 /24, IPv6 /48 (unknown: one shared key). */
export function networkOf(ip: string | null): string {
  if (!ip) return 'none'
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip) ?? /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip)
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`
  if (ip.includes(':')) {
    const [head] = ip.toLowerCase().split('::')
    const parts = (head ?? '').split(':').filter(Boolean)
    // the first three groups (a "::" before them means zeros)
    while (parts.length < 3) parts.push('0')
    return `${parts.slice(0, 3).join(':')}::/48`
  }
  return ip
}

export class AppLimits {
  /** minute buckets of unknown addresses: key -> [minute, count] */
  private unknown = new Map<string, [number, number]>()
  /** per app: tokens and when they were counted */
  private apps = new Map<string, { tokens: number; at: number }>()
  constructor(public clock: () => number = () => Date.now()) {}

  private bound<V>(m: Map<string, V>) {
    if (m.size <= MAX_KEYS) return
    // Maps keep insertion order: the oldest go first
    let drop = m.size - MAX_KEYS + Math.floor(MAX_KEYS / 10)
    for (const k of m.keys()) { if (drop-- <= 0) break; m.delete(k) }
  }

  /** One request with an address that is not a live app's: false when this client (or its network) is over the limit.
   * `strict`: it came through the server's own public address that has a country or network list (the /in/ exemption):
   * a smaller number. */
  unknownOk(ip: string | null, strict = false): boolean {
    const limit = strict ? ROOM_APP_UNKNOWN_PER_MINUTE_EXEMPT : ROOM_APP_UNKNOWN_PER_MINUTE
    const minute = Math.floor(this.clock() / MINUTE)
    let ok = true
    // the client and its network (a network gets a few clients' worth)
    for (const [k, max] of [[`ip:${ip ?? 'none'}`, limit], [`net:${networkOf(ip)}`, limit * 4]] as const) {
      const b = this.unknown.get(k)
      const n = b && b[0] === minute ? b[1] + 1 : 1
      this.unknown.delete(k)
      this.unknown.set(k, [minute, n])
      if (n > max) ok = false
    }
    this.bound(this.unknown)
    return ok
  }

  /** One request to a live app: null when it may go on, else the seconds to wait (a burst of ROOM_APP_BURST, then
   * ROOM_APP_PER_SECOND a second). */
  appWait(appId: string): number | null {
    const now = this.clock()
    const b = this.apps.get(appId) ?? { tokens: ROOM_APP_BURST, at: now }
    b.tokens = Math.min(ROOM_APP_BURST, b.tokens + ((now - b.at) / 1000) * ROOM_APP_PER_SECOND)
    b.at = now
    this.apps.delete(appId)
    this.apps.set(appId, b)
    this.bound(this.apps)
    if (b.tokens < 1) return Math.max(1, Math.ceil((1 - b.tokens) / ROOM_APP_PER_SECOND))
    b.tokens -= 1
    return null
  }

  forget(appId: string) { this.apps.delete(appId) }
}
