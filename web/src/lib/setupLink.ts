// The first-run setup link (control-plane D7 / SV-7): the hosted service's account console shows the owner
// https://<team>/setup#token=<setup token>&team=<display name>&lang=<ko|en|id|ja|es|zh>[&site=<company website>]. A
// fragment never reaches a server log or a Referer header. Older links (and the installer) use ?token=. Whatever carried
// the token, it leaves the address bar as soon as the page has read it (history.replaceState), so it is not in the
// history or a shared screenshot. `site` (the company website, e.g. from the sign-up email's domain) is kept for this
// tab once the team exists, so the company profile step (components/onboarding/ProfileStep.tsx) can start from it.
// `team` and `lang` come only from the hosted service, which already asked for them at sign-up: the setup page shows
// them as set, not as fields to type again (owner 2026-11-20; the team name changes later in Settings > Team).
import { asLocale, normalizeWebsite, type Locale } from '@mycel/shared/api'

export interface SetupLink {
  token: string | null
  /** team display name to prefill */
  team: string | null
  /** screen / team language to start with */
  lang: Locale | null
  /** the company website to prefill the profile step with (http(s) only, normalized), or null */
  site: string | null
  /** the address to put back without the token, the team, the language and the site (null: nothing to clean) */
  cleanUrl: string | null
}

const clip = (s: string | null, max: number) => (s && s.trim() ? s.trim().slice(0, max) : null)
const KEYS = ['token', 'team', 'lang', 'site'] as const

export function readSetupLink(loc: { pathname: string; search: string; hash: string }): SetupLink {
  const frag = new URLSearchParams(loc.hash.replace(/^#/, ''))
  const query = new URLSearchParams(loc.search)
  const token = clip(frag.get('token'), 256) ?? clip(query.get('token'), 256)
  const team = clip(frag.get('team') ?? query.get('team'), 100)
  const lang = asLocale(frag.get('lang') ?? query.get('lang') ?? '') ?? null
  const rawSite = clip(frag.get('site') ?? query.get('site'), 300)
  const site = rawSite ? normalizeWebsite(rawSite) : null
  const carried = KEYS.some((k) => frag.has(k) || query.has(k))
  if (!carried) return { token, team, lang, site, cleanUrl: null }
  for (const k of KEYS) { query.delete(k); frag.delete(k) }
  const q = query.toString()
  const f = frag.toString()
  return { token, team, lang, site, cleanUrl: `${loc.pathname}${q ? `?${q}` : ''}${f ? `#${f}` : ''}` }
}

const SITE_KEY = 'mycel.setupSite'

/** Keep the link's company website for this tab (after the team was made), for the profile step to prefill. */
export function rememberSetupSite(site: string | null): void {
  try { if (site) sessionStorage.setItem(SITE_KEY, site) } catch { /* storage blocked: the step starts empty */ }
}

/** The company website the setup link carried in this tab, or null. */
export function setupSite(): string | null {
  try { const v = sessionStorage.getItem(SITE_KEY); return v ? normalizeWebsite(v) : null } catch { return null }
}

const TOKEN_KEY = 'mycel.setupToken'
const TEAM_KEY = 'mycel.setupTeam'

/** The team name and language the hosted service chose at sign-up (the setup link's `team` and `lang`). */
export interface SetupTeam { team: string; lang: Locale | null }

/** Keep the setup link's token for this tab, so a reload of /setup (the token is gone from the address by then) still
 * opens the setup page through the relay, which says setup is needed only to a visitor with the token
 * (store/session.ts). sessionStorage: this tab only, gone when it closes; forgotten once the team is made. */
export function rememberSetupToken(token: string | null, team?: SetupTeam | null): void {
  try {
    if (!token) return
    sessionStorage.setItem(TOKEN_KEY, token)
    // a new link replaces what an earlier one left: its team, or none (an installer link asks for the name)
    if (team) sessionStorage.setItem(TEAM_KEY, JSON.stringify(team))
    else sessionStorage.removeItem(TEAM_KEY)
  } catch { /* storage blocked: a reload asks for the token */ }
}

/** The team name and language this tab's setup link carried (kept for a reload, like the token), or null. */
export function keptSetupTeam(): SetupTeam | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(TEAM_KEY) ?? 'null') as { team?: unknown; lang?: unknown } | null
    const team = typeof v?.team === 'string' ? clip(v.team, 100) : null
    return team ? { team, lang: asLocale(typeof v?.lang === 'string' ? v.lang : '') ?? null } : null
  } catch { return null }
}

/** The link's own team when it carried one, else the one kept for this tab (only beside a kept token). */
export function setupTeamOf(link: SetupLink): SetupTeam | null {
  if (link.team) return { team: link.team, lang: link.lang }
  return link.token ? null : keptSetupTeam()
}

/** The setup token this tab's setup link carried, or null. */
export function keptSetupToken(): string | null {
  try { return clip(sessionStorage.getItem(TOKEN_KEY), 256) } catch { return null }
}

export function forgetSetupToken(): void {
  try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TEAM_KEY) } catch { /* nothing kept */ }
}
