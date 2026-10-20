// Team addresses as people type them on the first-run screen ("acme", "acme.treesoop.com", "http://acme.localhost:19161").
// Pure: no Electron, unit-tested in tests/unit/e-address.test.ts.

/** Hosted team addresses are <team>.TEAM_DOMAIN (design tab 6; a separate domain comes before public launch). */
export const TEAM_DOMAIN = 'treesoop.com'

export type AddressError = 'empty' | 'invalid' | 'insecure' | 'credentials' | 'unsupported_scheme'
export type ParsedAddress = { ok: true; origin: string; host: string; dev: boolean } | { ok: false; error: AddressError }

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

/** Hosts that only exist on this machine (development): plain http is allowed only for these. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

export function parseTeamAddress(raw: string): ParsedAddress {
  const s = raw.trim()
  if (!s) return { ok: false, error: 'empty' }
  if (/\s/.test(s)) return { ok: false, error: 'invalid' }
  let text = s
  if (LABEL.test(s) && s.toLowerCase() !== 'localhost') text = `https://${s.toLowerCase()}.${TEAM_DOMAIN}`
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[/:?#]/)[0] ?? ''
    text = `${isLoopbackHost(host) || s.startsWith('[::1]') ? 'http' : 'https'}://${s}`
  }
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return { ok: false, error: 'invalid' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'unsupported_scheme' }
  if (u.username || u.password) return { ok: false, error: 'credentials' }
  if (!u.hostname || u.hostname.endsWith('.') || u.hostname.includes('..')) return { ok: false, error: 'invalid' }
  const dev = isLoopbackHost(u.hostname)
  if (u.protocol === 'http:' && !dev) return { ok: false, error: 'insecure' }
  return { ok: true, origin: u.origin, host: u.host, dev }
}

/** Origin of a URL, or '' (about:blank, garbage). */
export function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : ''
  } catch {
    return ''
  }
}

/** A short label for a team address: the team name part of acme.treesoop.com, else the host. */
export function teamLabel(origin: string): string {
  try {
    const u = new URL(origin)
    const h = u.hostname
    if (h.endsWith(`.${TEAM_DOMAIN}`)) return h.slice(0, -TEAM_DOMAIN.length - 1)
    if (h.endsWith('.localhost')) return h.slice(0, -'.localhost'.length)
    return u.host
  } catch {
    return origin
  }
}
