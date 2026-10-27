// Team address names: <name>.treesoop.com (dev: <name>.localhost). ASCII lowercase letters, digits and hyphens only
// (design tab 6 "팀 등록"). Names that collide with the domain's own records or look official are reserved.

export const TEAM_NAME_MIN = 3
export const TEAM_NAME_MAX = 40
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/**
 * Reserved forever: the domain's own records (www exists on treesoop.com today; the relay control address is
 * relay.<domain>; releases.<domain> serves updates), common service names, and names that would look official.
 */
export const RESERVED_TEAM_NAMES: readonly string[] = [
  'www', 'relay', 'releases', 'release', 'api', 'app', 'apps', 'mail', 'email', 'smtp', 'imap', 'pop', 'pop3', 'mx',
  'ns', 'ns1', 'ns2', 'ns3', 'dns', 'ftp', 'sftp', 'ssh', 'vpn', 'cdn', 'static', 'assets', 'img', 'images', 'media',
  'files', 'download', 'downloads', 'update', 'updates', 'status', 'health', 'docs', 'doc', 'help', 'support', 'blog',
  'news', 'admin', 'administrator', 'root', 'system', 'sys', 'login', 'signin', 'signup', 'register', 'auth', 'oauth',
  'sso', 'account', 'accounts', 'billing', 'pay', 'payment', 'payments', 'security', 'abuse', 'report', 'postmaster',
  'hostmaster', 'webmaster', 'noreply', 'no-reply', 'info', 'contact', 'autodiscover', 'autoconfig', 'wpad', 'isatap',
  'localhost', 'local', 'internal', 'intranet', 'gateway', 'proxy', 'connect', 'console', 'dashboard', 'portal',
  'staging', 'stage', 'preview', 'beta', 'alpha', 'canary', 'test', 'testing', 'demo', 'example', 'invalid',
  'team', 'teams', 'treesoop', 'mycel', 'teamax', 'team-ax', 'anthropic', 'claude', 'openai', 'chatgpt', 'codex',
  'google', 'apple', 'microsoft', 'cloudflare', 'github', 'kakao', 'naver', 'slack',
  // the hosted service (control-plane RL-7): the control plane's and the operators' own names, mail and billing words, and
  // the operators' probe team ax-probe (made from the relay host's CLI, which may use a reserved name)
  'cloud', 'cp', 'ops', 'operator', 'agent', 'agents', 'metrics', 'monitor', 'monitoring', 'grafana', 'prometheus',
  'backup', 'backups', 'notify', 'bounce', 'mailer', 'invoice', 'invoices', 'receipt', 'receipts', 'checkout', 'legal',
  'terms', 'privacy', 'trust', 'changelog', 'teamax-cloud', 'ax-probe',
]

export type TeamNameProblem = 'too_short' | 'too_long' | 'invalid' | 'reserved'

/** Normalize what a person typed (trim, lowercase). Does not make an invalid name valid. */
export function normalizeTeamName(s: string): string {
  return s.trim().toLowerCase()
}

/** null when the name can be used, else why not. Reservations held in the registry are checked separately. */
export function checkTeamName(name: string, extraReserved: readonly string[] = []): TeamNameProblem | null {
  if (name.length < TEAM_NAME_MIN) return 'too_short'
  if (name.length > TEAM_NAME_MAX) return 'too_long'
  if (!NAME_RE.test(name)) return 'invalid'
  // "xn--" style labels are IDNA (punycode); no double hyphen in positions 3-4 at all
  if (name.slice(2, 4) === '--') return 'invalid'
  if (RESERVED_TEAM_NAMES.includes(name) || extraReserved.includes(name)) return 'reserved'
  return null
}

/** The team name of a Host header under `domain` ("acme.treesoop.com:443" -> "acme"), else null. One label only. */
export function teamFromHost(host: string, domain: string): string | null {
  const h = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  const d = domain.toLowerCase()
  if (!h.endsWith('.' + d)) return null
  const label = h.slice(0, -(d.length + 1))
  if (!label || label.includes('.')) return null
  return label
}
