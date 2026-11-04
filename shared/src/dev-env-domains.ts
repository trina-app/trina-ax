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
