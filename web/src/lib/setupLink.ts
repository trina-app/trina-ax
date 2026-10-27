// The first-run setup link (control-plane D7 / SV-7): the hosted service's account console shows the owner
// https://<team>/setup#token=<setup token>&team=<display name>&lang=<ko|en|id>. A fragment never reaches a server log or
// a Referer header. Older links (and the installer) use ?token=. Whatever carried the token, it leaves the address bar
// as soon as the page has read it (history.replaceState), so it is not in the history or a shared screenshot.
import { asLocale, type Locale } from '@mycel/shared/api'

export interface SetupLink {
  token: string | null
  /** team display name to prefill */
  team: string | null
  /** screen / team language to start with */
  lang: Locale | null
  /** the address to put back without the token, the team and the language (null: nothing to clean) */
  cleanUrl: string | null
}

const clip = (s: string | null, max: number) => (s && s.trim() ? s.trim().slice(0, max) : null)

export function readSetupLink(loc: { pathname: string; search: string; hash: string }): SetupLink {
  const frag = new URLSearchParams(loc.hash.replace(/^#/, ''))
  const query = new URLSearchParams(loc.search)
  const token = clip(frag.get('token'), 256) ?? clip(query.get('token'), 256)
  const team = clip(frag.get('team') ?? query.get('team'), 100)
  const lang = asLocale(frag.get('lang') ?? query.get('lang') ?? '') ?? null
  const carried = frag.has('token') || frag.has('team') || frag.has('lang') || query.has('token') || query.has('team') || query.has('lang')
  if (!carried) return { token, team, lang, cleanUrl: null }
  for (const k of ['token', 'team', 'lang']) { query.delete(k); frag.delete(k) }
  const q = query.toString()
  const f = frag.toString()
  return { token, team, lang, cleanUrl: `${loc.pathname}${q ? `?${q}` : ''}${f ? `#${f}` : ''}` }
}
