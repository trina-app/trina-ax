// Public or office-network? IP literals and local names decide alone; other names are resolved (cached briefly).
// Residual risk (documented in docs/DECISIONS.md): Chromium resolves again when it connects, so a name that
// changes its answer in between (DNS rebinding) can slip past this check; net-guard.ts re-checks the address a
// main-frame response actually came from.
import { lookup } from 'node:dns/promises'
import { classifyHostStatic, classifyResolved, isLoopbackIp, isLoopbackName, type AddressClass } from '../../common/netaddr'

const TTL_MS = 30_000

export class HostClassifier {
  private cache = new Map<string, { cls: AddressClass; loopback: boolean; at: number }>()

  /**
   * testPublic: names the e2e tests map to 127.0.0.1 but want treated as public sites; testMapped: every name the
   * tests map to 127.0.0.1 (also office names such as nas.lan). Unpackaged builds only.
   */
  constructor(
    private testPublic: ReadonlySet<string> = new Set(),
    private testMapped: ReadonlySet<string> = testPublic,
  ) {}

  async classify(hostname: string): Promise<AddressClass> {
    return (await this.lookup(hostname)).cls
  }

  /** The name is this computer: localhost-style names, loopback literals, or DNS answering with a loopback address. */
  async isLoopback(hostname: string): Promise<boolean> {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (isLoopbackName(h)) return true
    return (await this.lookup(h)).loopback
  }

  private async lookup(hostname: string): Promise<{ cls: AddressClass; loopback: boolean }> {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (this.testPublic.has(h)) return { cls: 'public', loopback: false }
    const s = classifyHostStatic(h)
    if (s !== 'resolve') return { cls: s, loopback: isLoopbackName(h) }
    const hit = this.cache.get(h)
    if (hit && Date.now() - hit.at < TTL_MS) return hit
    let entry: { cls: AddressClass; loopback: boolean; at: number }
    try {
      const addrs = (await lookup(h, { all: true, verbatim: true })).map((a) => a.address)
      entry = { cls: classifyResolved(addrs), loopback: addrs.some(isLoopbackIp), at: Date.now() }
    } catch {
      // no answer: the browser cannot connect either; let it fail with its own error page
      entry = { cls: 'public', loopback: false, at: Date.now() }
    }
    this.cache.delete(h)
    this.cache.set(h, entry)
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value as string)
    return entry
  }

  /** The name was let through as public (by DNS) — a private answer for it now means rebinding. */
  wasResolvedPublic(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return !this.testPublic.has(h) && classifyHostStatic(h) === 'resolve' && this.cache.get(h)?.cls === 'public'
  }

  isTestPublic(hostname: string): boolean {
    return this.testPublic.has(hostname.toLowerCase())
  }

  /** A test name deliberately mapped to 127.0.0.1 (its responses come from loopback on purpose). */
  isTestMapped(hostname: string): boolean {
    return this.testMapped.has(hostname.toLowerCase())
  }

  /** Synchronous view for addresses already known (response IPs). */
  classifyIpNow(ip: string): AddressClass {
    const s = classifyHostStatic(ip)
    return s === 'resolve' ? 'private' : s
  }
}
