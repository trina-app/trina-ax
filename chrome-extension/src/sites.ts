// Which sites the AI may read or act on in the person's own Chrome (docs/decisions/20261128-trina-in-chrome.md
// "Rule, sites"). This browser holds the person's real cookies, so besides what the person allowed (the call's
// `sites`, `office`, `anySite`), some places are off limits whatever the server says: hard blocks, each with a plain
// sentence the AI hands to the person. Banking, payment and crypto sites are not covered by "Allow all websites": they
// need the person's own Allow for that site. Office addresses (private IPs, local names) need the office card.
// Pure: unit-tested in tests/unit/chrome-ext-sites.test.ts.
import { classifyIp, isIpLiteral, isLocalName, isLoopbackName } from '../../desktop/src/common/netaddr'

/** What the person allowed for one call (BrowserCall sites / office / anySite). */
export interface SiteRules {
  sites?: readonly string[]
  office?: readonly string[]
  anySite?: boolean
}

export type SiteVerdict =
  | { kind: 'ok'; host: string }
  /** about:blank: an empty tab (nothing to read, no script runs there) */
  | { kind: 'blank' }
  | { kind: 'blocked'; message: string }
  | { kind: 'need'; host: string; office?: true }

const norm = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

/** host[:port] as the server keys sites: lower case, no "www.", brackets kept off IPv6 for matching. */
export function hostKey(u: URL): string {
  const name = norm(u.hostname).replace(/^www\./, '')
  return u.port ? `${name.includes(':') ? `[${name}]` : name}:${u.port}` : name.includes(':') ? `[${name}]` : name
}

/** Split host[:port] (IPv6 in brackets) into a bare name and its port ('' when none). */
export function splitHost(key: string): { name: string; port: string } {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(key)
  if (m) return { name: norm(m[1]), port: m[2] ?? '' }
  const i = key.lastIndexOf(':')
  if (i > 0 && /^\d+$/.test(key.slice(i + 1)) && key.indexOf(':') === i) return { name: norm(key.slice(0, i)).replace(/^www\./, ''), port: key.slice(i + 1) }
  return { name: norm(key).replace(/^www\./, ''), port: '' }
}

/** A site key covers a host when the names are equal or the host is a subdomain of it; a key with a port only that port. */
export function keyMatches(key: string, host: string): boolean {
  const k = splitHost(key)
  const h = splitHost(host)
  if (!k.name) return false
  if (k.port && k.port !== h.port) return false
  return h.name === k.name || h.name.endsWith(`.${k.name}`)
}

const anyMatch = (keys: readonly string[] | undefined, host: string) => (keys ?? []).some((k) => keyMatches(k, host))

// ------------------------------------------------------------------ hard blocks

/** Account-security, sign-in consent and password pages: hosts (and their subdomains when written with a leading dot). */
const ACCOUNT_HOSTS = [
  'accounts.google.com', 'myaccount.google.com', 'passwords.google.com',
  'login.microsoftonline.com', 'login.live.com', 'account.live.com', 'account.microsoft.com', 'mysignins.microsoft.com',
  'appleid.apple.com', 'account.apple.com', 'iforgot.apple.com',
  'nid.naver.com', 'accounts.kakao.com', 'kauth.kakao.com',
  // sign-in and OAuth consent hosts: one press there gives an app access to the person's account
  'id.atlassian.com', 'auth.atlassian.com', 'login.salesforce.com',
  '.1password.com', '1password.com', 'vault.bitwarden.com', 'lastpass.com', '.lastpass.com', '.dashlane.com', 'dashlane.com',
  'keepersecurity.com', '.keepersecurity.com',
]
/** host (a leading dot: that host and its subdomains) + path: settings, app installs and OAuth consent screens */
const ACCOUNT_PATHS: [string, RegExp][] = [
  ['github.com', /^\/settings/],
  ['github.com', /^\/login\/oauth/],
  ['github.com', /^\/login\/device/],
  ['github.com', /^\/sessions/],
  ['github.com', /^\/[^/]+\/[^/]+\/settings/],
  ['github.com', /^\/organizations\/[^/]+\/settings/],
  ['github.com', /^\/apps\/[^/]+\/installations/],
  ['.slack.com', /^\/oauth/],
  ['.okta.com', /^\/oauth2\/[^/]+\/v1\/authorize|^\/oauth2\/[^/]+\/authorize|^\/oauth2\/v1\/authorize/],
  ['.auth0.com', /^\/authorize/],
  ['appleid.apple.com', /^\/auth/],
  ['discord.com', /^\/oauth2/],
  ['facebook.com', /^\/(v[\d.]+\/)?dialog\/oauth/],
  ['twitter.com', /^\/i\/oauth2/],
  ['x.com', /^\/i\/oauth2/],
]
const STORE_HOSTS = ['chromewebstore.google.com', 'microsoftedge.microsoft.com']
const STORE_PATHS: [string, string][] = [['chrome.google.com', '/webstore']]

const hostIs = (name: string, list: readonly string[]) => list.some((e) => (e.startsWith('.') ? name.endsWith(e) : name === e))
const pathUnder = (name: string, path: string, list: readonly [string, string][]) =>
  list.some(([h, p]) => name === h && path.startsWith(p))
const pathMatches = (name: string, path: string, list: readonly [string, RegExp][]) =>
  list.some(([h, re]) => (h.startsWith('.') ? name === h.slice(1) || name.endsWith(h) : name === h) && re.test(path))

export const BLOCK = {
  scheme: 'The AI can only open web pages (http or https) in Chrome. Ask the user to open that page themselves.',
  team: (host: string) => `The AI may not open the team's own address (${host}) in the user's Chrome. Use the team's own tools for team data instead of the browser.`,
  loopback: (host: string) => `The AI may not open addresses on the user's computer (${host}) in Chrome. Ask the user to open it themselves.`,
  store: 'The AI may not use extension store pages. Ask the user to do that themselves.',
  account: (host: string) => `${host} is an account-security or password page. The AI may not read or use it; ask the user to do this step themselves, then continue.`,
} as const

/** One of the team's own host names, or a subdomain of one (`name`: a bare host name, no port). */
export function isTeamHost(name: string, teamHosts: readonly string[]): boolean {
  const n = norm(name)
  const bare = n.replace(/^www\./, '')
  return teamHosts.some((t) => {
    const th = splitHost(norm(t)).name
    return Boolean(th) && (n === th || n.endsWith(`.${th}`) || bare === th)
  })
}

/** This computer: localhost, *.localhost, 127/8, 0.0.0.0, ::1 (a bare host name). */
export const isThisComputer = (name: string) => isLoopbackName(norm(name))

/** Why this URL is off limits whatever the server allowed, or null. `teamHosts`: every host name of the team. */
export function hardBlock(url: URL, teamHosts: readonly string[]): string | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return BLOCK.scheme
  const name = norm(url.hostname)
  const bare = name.replace(/^www\./, '')
  if (isTeamHost(name, teamHosts)) return BLOCK.team(url.host)
  if (isLoopbackName(name)) return BLOCK.loopback(url.host)
  const path = url.pathname.toLowerCase()
  if (hostIs(bare, STORE_HOSTS) || hostIs(name, STORE_HOSTS) || pathUnder(bare, path, STORE_PATHS)) return BLOCK.store
  if (hostIs(name, ACCOUNT_HOSTS) || hostIs(bare, ACCOUNT_HOSTS) || pathMatches(bare, path, ACCOUNT_PATHS)) return BLOCK.account(bare)
  return null
}

// ------------------------------------------------------------------ sensitive and office

/** Banking, payment and crypto sites (registrable names; subdomains count). "Allow all websites" never covers them. */
const SENSITIVE = [
  'paypal.com', 'wise.com', 'stripe.com', 'venmo.com', 'revolut.com', 'payoneer.com', 'americanexpress.com',
  'coinbase.com', 'binance.com', 'kraken.com', 'crypto.com', 'upbit.com', 'bithumb.com', 'korbit.co.kr', 'coinone.co.kr',
  'toss.im', 'tossbank.com', 'kbstar.com', 'shinhan.com', 'wooribank.com', 'kebhana.com', 'hanabank.com', 'ibk.co.kr', 'nonghyup.com',
  'kakaobank.com', 'kakaopay.com', 'naverpay.com', 'citibank.com', 'citi.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com',
  'capitalone.com', 'usbank.com', 'schwab.com', 'fidelity.com', 'hsbc.com', 'barclays.co.uk', 'mufg.jp', 'smbc.co.jp', 'mizuhobank.co.jp',
]

/** Banking, payment or crypto: needs the person's own Allow for this site (call.sites), never covered by anySite. */
export function sensitive(host: string): boolean {
  const { name } = splitHost(host)
  if (SENSITIVE.some((s) => name === s || name.endsWith(`.${s}`))) return true
  if (isIpLiteral(name)) return false
  // every label but the last (the top-level domain): mybank.com, online.kbbank.co.kr
  return name.split('.').slice(0, -1).some((l) => l.includes('bank'))
}

/** An office-network address: a private IP literal or a name that only resolves inside the office. */
export function office(host: string): boolean {
  const { name } = splitHost(host)
  if (isIpLiteral(name)) return classifyIp(name) === 'private'
  return isLocalName(name)
}

/** May the AI use this host (host[:port]) in this call? Hard blocks are checked separately (checkUrl). */
export function allowed(host: string, rules: SiteRules): boolean {
  if (office(host)) return anyMatch(rules.office, host)
  if (anyMatch(rules.sites, host)) return true
  return Boolean(rules.anySite) && !sensitive(host)
}

/** The verdict for a page address: blank, hard-blocked, allowed, or the site the person must allow first. */
export function checkUrl(raw: string, rules: SiteRules, teamHosts: readonly string[]): SiteVerdict {
  if (isBlank(raw)) return { kind: 'blank' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { kind: 'blocked', message: BLOCK.scheme }
  }
  const block = hardBlock(u, teamHosts)
  if (block) return { kind: 'blocked', message: block }
  const host = hostKey(u)
  if (allowed(host, rules)) return { kind: 'ok', host }
  return office(host) ? { kind: 'need', host, office: true } : { kind: 'need', host }
}

/** A tab with no page in it yet. */
export function isBlank(url: string): boolean {
  return url === '' || url === 'about:blank' || url.startsWith('about:blank#') || url.startsWith('about:blank?')
}

/** The address the AI typed, made a URL as the desktop browser does ("example.com" -> https://example.com). */
export function normalizeUrl(raw: string): string {
  const u = raw.trim()
  return /^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z0-9.-]+:\d+/i.test(u) ? u : `https://${u}`
}

/** The page's origin as tabs_context shows it. */
export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol.startsWith('http') ? u.origin : u.protocol.replace(':', '')
  } catch {
    return url
  }
}
