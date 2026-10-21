// Public or office-network? IP literals and local names decide alone; other names are resolved by the pane's own
// session (Chromium's host resolver, ses.resolveHost), the same resolver and host cache Chromium uses when it
// connects. So the check and the connection see the same answer, and when the check gets none, Chromium has nothing
// to connect to either.
//
// No timeout of our own and no cache of our own (security review of the quiet-browsing branch): a lookup that waited
// 3 s and then let the request through let a DNS server that answers late (3.5 s, 192.168.1.1) past the check, and a
// cache of "this name was public" could be flushed by a flood of names. Chromium's resolver has its own timeouts; the
// check waits exactly as long as the connection would. Only concurrent lookups of one name are shared.
//
// What a lookup without an answer means is decided in net-guard.ts (common/net-policy.ts unresolvedVerdict): a page
// load goes on (Chromium fails the same way), sub-requests and WebSockets are cancelled. It is never "office network":
// that blocked public sites whenever DNS was slow (split DNS such as Tailscale MagicDNS, VPNs, captive portals).
//
// Residual risk (docs/DECISIONS.md): a name whose answer changes between the check and the connection (DNS rebinding
// with TTL 0); net-guard.ts re-checks the address every response actually came from (stopIfRebound).
import { lookup as nodeLookup } from 'node:dns/promises'
import type { Session } from 'electron'
import { classifyHostStatic, classifyResolved, isLoopbackIp, isLoopbackName, type AddressClass } from '../../common/netaddr'
import type { DnsOutcome } from '../../common/net-policy'

/** last resort: a resolver that never settles does not hold a request forever (Chromium gives up well before) */
export const LOOKUP_TIMEOUT_MS = 60_000

/** Resolve a name to its addresses (the pane session's resolver in the app; tests inject slow or failing ones). */
export type Resolver = (hostname: string) => Promise<string[]>

/** getaddrinfo, for tests and tools without a session */
export const systemResolver: Resolver = async (h) => (await nodeLookup(h, { all: true, verbatim: true })).map((a) => a.address)

/** Chromium's own resolver for this session (honours its host cache, secure DNS and host-resolver rules). */
export const sessionResolver =
  (ses: Session): Resolver =>
  async (h) =>
    (await ses.resolveHost(h)).endpoints.map((e) => e.address)

export interface Lookup {
  cls: AddressClass
  loopback: boolean
  /** how the class was found: static (IP literal, local name, test name), DNS answered, failed, or never settled */
  dns: DnsOutcome
}

export class HostClassifier {
  /** one lookup per name at a time (a page asks for the same CDN name dozens of times at once) */
  private pending = new Map<string, Promise<Lookup>>()

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

  /** The same test names with another resolver (each pane resolves through its own session). */
  withResolver(resolve: Resolver): HostClassifier {
    return new HostClassifier(this.testPublic, this.testMapped, resolve, this.timeoutMs)
  }

  /** Public or office network. A name DNS gave no answer for counts as public here: see lookup().dns. */
  async classify(hostname: string): Promise<AddressClass> {
    return (await this.lookup(hostname)).cls
  }

  /** The name is this computer: localhost-style names, loopback literals, or DNS answering with a loopback address. */
  async isLoopback(hostname: string): Promise<boolean> {
    const h = norm(hostname)
    if (isLoopbackName(h)) return true
    return (await this.lookup(h)).loopback
  }

  async lookup(hostname: string): Promise<Lookup> {
    const h = norm(hostname)
    if (this.testPublic.has(h)) return { cls: 'public', loopback: false, dns: 'static' }
    const s = classifyHostStatic(h)
    if (s !== 'resolve') return { cls: s, loopback: isLoopbackName(h), dns: 'static' }
    let p = this.pending.get(h)
    if (!p) {
      p = this.resolveOnce(h).finally(() => this.pending.delete(h))
      this.pending.set(h, p)
    }
    return p
  }

  private async resolveOnce(h: string): Promise<Lookup> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), this.timeoutMs)
    })
    let addrs: string[] | 'timeout' | null
    try {
      addrs = await Promise.race([this.resolve(h), timeout])
    } catch {
      addrs = null
    } finally {
      clearTimeout(timer)
    }
    if (addrs === 'timeout') return { cls: 'public', loopback: false, dns: 'timeout' }
    if (!addrs || !addrs.length) return { cls: 'public', loopback: false, dns: 'failed' }
    return { cls: classifyResolved(addrs), loopback: addrs.some(isLoopbackIp), dns: 'answered' }
  }

  /** A name that goes through DNS (not an IP literal, local name or test name): its connected address is checked. */
  isDnsName(hostname: string): boolean {
    const h = norm(hostname)
    return !this.testMapped.has(h) && !this.testPublic.has(h) && classifyHostStatic(h) === 'resolve'
  }

  isTestPublic(hostname: string): boolean {
    return this.testPublic.has(norm(hostname))
  }

  /** A test name deliberately mapped to 127.0.0.1 (its responses come from loopback on purpose). */
  isTestMapped(hostname: string): boolean {
    return this.testMapped.has(norm(hostname))
  }

  /** Synchronous view for addresses already known (response IPs). */
  classifyIpNow(ip: string): AddressClass {
    const s = classifyHostStatic(ip)
    return s === 'resolve' ? 'private' : s
  }
}

const norm = (hostname: string) => hostname.toLowerCase().replace(/^\[|\]$/g, '')
