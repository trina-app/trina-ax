// What the in-app browser does with a request to a PUBLIC address (design tab 7 "프롬프트 주입": an address can carry
// data out). The AI can send what the person can read to any server by opening an address, by a redirect from an
// allowed site, or by running script in a page. So:
//  - a page load (main frame, every redirect hop included) while the AI is driving the pane, or while any tab holds a
//    document the AI ran script in (a script can navigate other windows it has a reference to), to a site the person
//    has not allowed: ask the person ("site" scope, like the AI's own navigate)
//  - sub-requests (fetch, images, beacons, iframes, WebSocket) of a document the AI ran script in (or of another tab
//    on the same site, which that script can reach), to another site than the page's own that the person has not
//    allowed: blocked until the tab loads a new page (the script's timers die with its document). "Site" is the
//    registrable domain (site-permissions.ts registrableDomain): media.cnn.com is edition.cnn.com's own site, while
//    static.licdn.com is another site than linkedin.com (UX review: CNN's own images stayed grey)
//  - everything else (the person browsing, pages the AI did not script loading their own resources): as any browser
// With site access "all" (the person's setting, site-permissions.ts) every public site counts as allowed, so none of
// this asks or blocks; office-network addresses keep their own rule (net-guard.ts).
// javascript_tool never runs on a blank tab (no site to allow: pane.ts permit()).
// Pure: unit-tested in tests/unit/e-desktop-common.test.ts; used by main/pane/net-guard.ts.

export type PublicVerdict = 'allow' | 'ask' | 'block'

export interface PublicRequest {
  /** a page load of the tab (Electron resourceType 'mainFrame', each redirect hop) */
  mainFrame: boolean
  /** the request belongs to a pane tab or popup (not a service worker or another requester without a tab) */
  hasOwner: boolean
  /** the pane is running an AI browser call right now */
  driving: boolean
  /** some tab holds a document the AI ran javascript_tool in */
  anyScripted: boolean
  /** the AI ran javascript_tool in this tab's current document, or in a tab on the same site (same-origin access) */
  scripted: boolean
  /** the target is the same site (registrable domain and port) as the tab's current page */
  sameSiteAsTop: boolean
  /** the person allowed the target site (this turn or always) or typed it themselves */
  siteAllowed: boolean
}

export function publicRequestVerdict(r: PublicRequest): PublicVerdict {
  if (r.siteAllowed) return 'allow'
  // service workers and other requesters that are no tab: held back while an AI script lives (it can register one)
  if (!r.hasOwner) return r.anyScripted ? 'block' : 'allow'
  if (r.mainFrame) return r.driving || r.anyScripted || r.scripted ? 'ask' : 'allow'
  return r.scripted && !r.sameSiteAsTop ? 'block' : 'allow'
}

/**
 * Decided before any DNS lookup (security review 2026-10-30 "N3"; docs/DECISIONS.md "Outbound web channels"). A host
 * name can carry data to its DNS server: script the AI ran can build 'https://' + secret + '.attacker.example' (the
 * team server's address check reads only addresses written out in the code), and the lookup alone delivers it, before
 * any block and even when the person says no. So, for a name that needs DNS:
 *  - 'cancel': a request the guard refuses whatever the name resolves to: a sub-request of a document the AI scripted
 *    (or of a requester without a tab while a scripted document is open) to another site the person has not allowed,
 *    neither as a site nor as an office address, from a page that is not an allowed office page
 *  - 'ask': a page load the person must allow anyway (the AI drives the pane, or a scripted document is open) to a
 *    name not allowed yet: the site card comes before the lookup; an office address then asks its own card too
 *  - 'lookup': decided by the address class as before (publicRequestVerdict, the office rules in net-guard.ts)
 * IP literals and local names need no lookup and keep the rules as they were.
 */
export interface BeforeLookup extends PublicRequest {
  /** the name goes through DNS (classify.ts isDnsName) */
  needsDns: boolean
  /** the person allowed the target as an office-network address (or typed it) */
  officeAllowed: boolean
  /** the tab's page is an address the person allowed as an office address (its office resources may load) */
  topOfficeAllowed: boolean
}

export function beforeLookupVerdict(r: BeforeLookup): 'cancel' | 'ask' | 'lookup' {
  if (!r.needsDns || r.siteAllowed || r.officeAllowed) return 'lookup'
  if (!r.hasOwner) return r.anyScripted ? 'cancel' : 'lookup'
  if (r.mainFrame) return r.driving || r.anyScripted || r.scripted ? 'ask' : 'lookup'
  return r.scripted && !r.sameSiteAsTop && !r.topOfficeAllowed ? 'cancel' : 'lookup'
}

/** Browser tools that run the AI's own code in the page: never on a blank tab (no site the person could allow). */
export const RUNS_AI_SCRIPT: ReadonlySet<string> = new Set(['javascript_tool'])

/** A tab URL with no web page in it (fresh tab, about:blank). */
export function isBlankPage(url: string): boolean {
  return url === '' || url === 'about:blank' || url.startsWith('about:blank#') || url.startsWith('about:blank?')
}

/**
 * How a name's DNS lookup (the pane session's own resolver, main/pane/classify.ts) ended: static = no DNS needed (IP
 * literal, local name, test name), answered, failed (error or empty answer), timeout (never settled).
 */
export type DnsOutcome = 'static' | 'answered' | 'failed' | 'timeout'

/**
 * A request whose name DNS gave no answer for (security review: "a slow or failed answer must not skip the office
 * check"). The pane resolves through Chromium's own resolver, so a failed lookup means Chromium has nothing to connect
 * to either: a page load goes on and fails (or, through a proxy, the proxy resolves it) and the address its document
 * came from is checked afterwards. Anything else (images, scripts, fetch, WebSocket, iframes, requests without a tab)
 * is cancelled: a public site loses at most a sub-request while its DNS is down, and no request reaches an address
 * nobody checked. A lookup that never settled (LOOKUP_TIMEOUT_MS) cancels everything: a late answer would still
 * reach Chromium's connection through the shared resolver.
 * 'check': decide by the address class as usual.
 */
export function unresolvedVerdict(r: { dns: DnsOutcome; mainFrame: boolean; hasOwner: boolean }): 'check' | 'cancel' {
  if (r.dns === 'static' || r.dns === 'answered') return 'check'
  if (r.dns === 'timeout') return 'cancel'
  return r.mainFrame && r.hasOwner ? 'check' : 'cancel'
}

/**
 * Did the response come through a proxy? `proxyList` is session.resolveProxy(url) ("PROXY host:port; DIRECT" ...),
 * `proxyAddrs` the addresses of the proxy hosts named there. Only when the connected address IS one of the proxies:
 * "PROXY x; DIRECT" falls back to a direct connection whose address is the site's own (security review: any proxy in
 * the list used to switch the check off).
 */
export function connectedThroughProxy(proxyList: string, ip: string, proxyAddrs: readonly string[]): boolean {
  if (!proxiesIn(proxyList).length) return false
  const bare = (a: string) => a.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '')
  const want = bare(ip)
  return proxyAddrs.some((a) => bare(a) === want)
}

/** Proxy hosts named in a resolveProxy answer (DIRECT entries skipped). */
export function proxiesIn(proxyList: string): string[] {
  const out: string[] = []
  for (const part of proxyList.split(';')) {
    const m = /^\s*(PROXY|HTTPS|HTTP|SOCKS|SOCKS4|SOCKS5|QUIC)\s+(\[[^\]]+\]|[^\s:]+)(?::\d+)?\s*$/i.exec(part)
    if (m) out.push(m[2].replace(/^\[|\]$/g, ''))
  }
  return out
}

export interface ResponseSource {
  /** the address Chromium connected to (CDP remoteIPAddress); absent for cache / service worker answers */
  ip: string | undefined
  /** the connection went to a proxy (connectedThroughProxy): `ip` is the proxy's, not the site's */
  proxied: boolean
  /** `ip` is this computer */
  loopback: boolean
  /** `ip` is an office-network (non-global) address */
  privateIp: boolean
  /** an e2e test name deliberately mapped to 127.0.0.1 */
  testMapped: boolean
  /**
   * the name goes through DNS (not an IP literal or local name, which were decided before the request). A fact about
   * the name, not a remembered lookup: a cache of "looked public" could be flushed by a flood of names (security
   * review) or changed by a later lookup while the response was on its way.
   */
  dnsName: boolean
  /**
   * the person allowed this host as an office-network address (or typed it), or it was let through as one from an
   * allowed office page (intranet browsing)
   */
  privateAllowed: boolean
}

/**
 * Every response's source address is checked after the fact (CDP Network.responseReceived, all resource types):
 * Electron exposes the address Chromium connected to only once the response arrives, so this is the check that holds
 * when DNS answered differently to Chromium than to the lookup before the request (rebinding).
 * Stop the tab ('forbidden': it reached this computer, 'blocked': the office network) or let it be.
 */
export function responseSourceVerdict(r: ResponseSource): 'ok' | 'forbidden' | 'blocked' {
  if (!r.ip || r.proxied || r.testMapped) return 'ok'
  if (r.loopback) return 'forbidden'
  if (!r.privateIp || !r.dnsName || r.privateAllowed) return 'ok'
  return 'blocked'
}
