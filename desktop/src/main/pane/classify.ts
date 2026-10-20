// Public or office-network? IP literals and local names decide alone; other names are resolved (cached briefly).
// Residual risk (documented in docs/DECISIONS.md): Chromium resolves again when it connects, so a name that
// changes its answer in between (DNS rebinding) can slip past this check; net-guard.ts re-checks the address a
// main-frame response actually came from.
import { lookup } from 'node:dns/promises'
import { classifyHostStatic, classifyResolved, type AddressClass } from '../../common/netaddr'

const TTL_MS = 30_000

export class HostClassifier {
  private cache = new Map<string, { cls: AddressClass; at: number }>()

  /** testPublic: names the e2e tests map to 127.0.0.1 but want treated as public sites (unpackaged builds only). */
  constructor(private testPublic: ReadonlySet<string> = new Set()) {}

  async classify(hostname: string): Promise<AddressClass> {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (this.testPublic.has(h)) return 'public'
    const s = classifyHostStatic(h)
    if (s !== 'resolve') return s
    const hit = this.cache.get(h)
    if (hit && Date.now() - hit.at < TTL_MS) return hit.cls
    let cls: AddressClass
    try {
      const addrs = await lookup(h, { all: true, verbatim: true })
      cls = classifyResolved(addrs.map((a) => a.address))
    } catch {
      // no answer: the browser cannot connect either; let it fail with its own error page
      cls = 'public'
    }
    this.cache.set(h, { cls, at: Date.now() })
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value as string)
    return cls
  }

  /** The name was let through as public (by DNS) — a private answer for it now means rebinding. */
  wasResolvedPublic(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return !this.testPublic.has(h) && classifyHostStatic(h) === 'resolve' && this.cache.get(h)?.cls === 'public'
  }

  isTestPublic(hostname: string): boolean {
    return this.testPublic.has(hostname.toLowerCase())
  }

  /** Synchronous view for addresses already known (response IPs). */
  classifyIpNow(ip: string): AddressClass {
    const s = classifyHostStatic(ip)
    return s === 'resolve' ? 'private' : s
  }
}
