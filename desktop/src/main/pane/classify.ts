// Public or office-network? IP literals and local names decide alone; other names are resolved (cached briefly).
// Residual risk (documented in docs/DECISIONS.md): Chromium resolves again when it connects, so a name that
// changes its answer in between (DNS rebinding) can slip past this check; net-guard.ts re-checks the address a
// response actually came from (stopIfRebound).
//
// A lookup that fails, times out or answers nothing says nothing about where the name points: the request goes on
// to Chromium's own resolution (which fails the same way, or connects) and the address it connected to is checked
// afterwards. Treating "no answer" as office network blocked public sites whenever the system resolver was slow
// (split DNS such as Tailscale MagicDNS, VPNs, captive portals).
import { lookup } from 'node:dns/promises'
import { classifyHostStatic, classifyResolved, isLoopbackIp, isLoopbackName, type AddressClass } from '../../common/netaddr'

const TTL_MS = 30_000
/** a lookup that gave no usable answer is tried again this soon */
const UNKNOWN_TTL_MS = 5_000
/** longest the browser waits for the system resolver before letting Chromium resolve it itself */
export const LOOKUP_TIMEOUT_MS = 3_000

/** Resolve a name to its addresses (node's getaddrinfo by default; tests inject slow or failing ones). */
export type Resolver = (hostname: string) => Promise<string[]>

const systemResolver: Resolver = async (h) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address)

interface Entry {
  cls: AddressClass
  loopback: boolean
  /** DNS answered with addresses (false: failed, timed out or empty, let through to Chromium) */
  answered: boolean
  at: number
}

export class HostClassifier {
  private cache = new Map<string, Entry>()
  /** one lookup per name at a time (a page asks for the same CDN name dozens of times at once) */
  private pending = new Map<string, Promise<Entry>>()

  /**
   * testPublic: names the e2e tests map to 127.0.0.1 but want treated as public sites; testMapped: every name the
   * tests map to 127.0.0.1 (also office names such as nas.lan). Unpackaged builds only.
   */
  constructor(
    private testPublic: ReadonlySet<string> = new Set(),
    private testMapped: ReadonlySet<string> = testPublic,
    private resolve: Resolver = systemResolver,
    private timeoutMs = LOOKUP_TIMEOUT_MS,
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
    if (hit && Date.now() - hit.at < (hit.answered ? TTL_MS : UNKNOWN_TTL_MS)) return hit
    let p = this.pending.get(h)
    if (!p) {
      p = this.resolveOnce(h).finally(() => this.pending.delete(h))
      this.pending.set(h, p)
    }
    return p
  }

  private async resolveOnce(h: string): Promise<Entry> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), this.timeoutMs)
    })
    let addrs: string[] | null
    try {
      addrs = await Promise.race([this.resolve(h), timeout])
    } catch {
      addrs = null
    } finally {
      clearTimeout(timer)
    }
    const entry: Entry =
      addrs && addrs.length
        ? { cls: classifyResolved(addrs), loopback: addrs.some(isLoopbackIp), answered: true, at: Date.now() }
        : // no answer (error, timeout, nothing): Chromium resolves it itself; where it connected is checked afterwards
          { cls: 'public', loopback: false, answered: false, at: Date.now() }
    this.cache.delete(h)
    this.cache.set(h, entry)
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value as string)
    return entry
  }

  /** The name was let through as public (by DNS, or without an answer) — a private answer for it now means rebinding. */
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
