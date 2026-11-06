// The sites that a dev environment on srt may reach (docs/research/srt-dev-env.md section 3.2). The default list
// changes only with a release. An admin can add more for the team (setting devEnv.team). Every other host is
// blocked by srt's proxy.

/** The default allowlist: package registries and GitHub. */
export const DEV_ENV_DEFAULT_DOMAINS: readonly string[] = [
  // npm
  'registry.npmjs.org', 'registry.yarnpkg.com',
  // Python
  'pypi.org', 'files.pythonhosted.org',
  // GitHub (clone over https, release downloads, raw files)
  'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com',
]

/** At most this many domains an admin can add. */
export const DEV_ENV_MAX_EXTRA_DOMAINS = 50

/** Public suffixes that an admin may not allow as a whole ("*.com"). A short list: it catches mistakes, it is not
 * the full public suffix list. */
const PUBLIC_SUFFIXES = new Set([
  'com', 'net', 'org', 'io', 'dev', 'app', 'co', 'ai', 'me', 'info', 'biz', 'xyz', 'cloud', 'site', 'online',
  'kr', 'co.kr', 'or.kr', 'go.kr', 'ne.kr', 'jp', 'co.jp', 'ne.jp', 'id', 'co.id', 'or.id', 'es', 'com.es',
  'uk', 'co.uk', 'org.uk', 'de', 'fr', 'cn', 'com.cn', 'us', 'eu', 'au', 'com.au',
  'github.io', 'pages.dev', 'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'amazonaws.com', 'cloudfront.net',
])

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** Why this domain cannot go on the team's list, or null when it can. `teamHosts`: the host names of this Trina
 * server (the AI must not reach its own server through the proxy). */
export function extraDomainProblem(domain: string, teamHosts: readonly string[] = []): string | null {
  const d = domain.trim()
  if (d !== d.toLowerCase()) return 'use lowercase letters'
  if (d.length > 253) return 'too long'
  const host = d.startsWith('*.') ? d.slice(2) : d
  if (host.includes('*')) return 'a "*" is allowed only as "*." at the start'
  if (PUBLIC_SUFFIXES.has(host)) return 'a public suffix is too wide'
  const labels = host.split('.')
  if (labels.length < 2) return 'a domain needs at least two parts, for example example.com'
  if (!labels.every((l) => LABEL.test(l))) return 'not a host name'
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return 'an IP address is not allowed'
  // 0x7f.1 and other spellings of an address; no real top-level domain is all digits
  if (labels.every((l) => /^(0x[0-9a-f]+|[0-9]+)$/.test(l)) || /^[0-9]+$/.test(labels[labels.length - 1]!)) return 'an IP address is not allowed'
  const lowerTeam = teamHosts.map((t) => t.toLowerCase())
  for (const t of lowerTeam) {
    if (host === t || t.endsWith('.' + host)) return 'this is the host name of this Trina server'
  }
  return null
}

/** The team's list after the checks: lowercase, no duplicates, in the order given. */
export function cleanExtraDomains(list: readonly string[]): string[] {
  return [...new Set(list.map((d) => d.trim().toLowerCase()).filter(Boolean))]
}

// ---------------- sites a person allows (docs/DECISIONS.md "Dev environment: sites a person allows") ----------------

/** At most this many sites one person can allow "always". */
export const DEV_ENV_MAX_USER_SITES = 100

/** The warning that a person accepts to turn Full internet on. A new version (other words) turns it off for everyone
 * until each person accepts again; it never needs an admin. */
export const DEV_ENV_FULL_WARNING_VERSION = 1

/** Names of the local network and of metadata services. A person may not allow them (the browser's office-network
 * names, chat/browser-gate.ts, use the same idea). */
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'corp', 'home', 'home.arpa', 'intranet', 'private', 'localdomain', 'test', 'invalid', 'example']

/** The host of what the AI asked for: "https://Api.Example.com:443/x" -> "api.example.com". Null when nothing is left. */
export function siteFromInput(raw: string): string | null {
  let h = raw.trim().toLowerCase()
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  h = h.split(/[/?#]/, 1)[0]!
  h = h.replace(/^[^@]*@/, '')
  if (h.startsWith('[')) return h.length > 1 ? h : null
  // one colon: a port ("host:443") or scp's path ("github.com:org/repo"); more: an IPv6 address, refused later
  if (h.split(':').length === 2) h = h.slice(0, h.indexOf(':'))
  h = h.replace(/\.+$/, '')
  return h || null
}

/** Why a person may not allow this site, or null when they may. The checks of an admin's site (extraDomainProblem),
 * and no local or metadata name. */
export function userSiteProblem(host: string, teamHosts: readonly string[] = []): string | null {
  const p = extraDomainProblem(host, teamHosts)
  if (p) return p
  const h = host.startsWith('*.') ? host.slice(2) : host
  if (LOCAL_SUFFIXES.some((s) => h === s || h.endsWith('.' + s))) return 'a local or internal name is not allowed'
  return null
}

/** Does a site pattern cover this host? Exact, or "*.example.com" for every name under example.com (srt's rule). */
export function siteCovers(pattern: string, host: string): boolean {
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1))
  return pattern === host
}

/** The sites of one person's run: the default list, the team's sites, the person's own and the once-allowed ones,
 * lowercase and with no duplicates. */
export function mergeSites(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat().map((d) => d.trim().toLowerCase()).filter(Boolean))]
}
