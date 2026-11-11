// The team invite link on the web side (contract: shared/src/api/team-links.ts). Pure helpers, so they are tested
// without a browser: reading the token from the address's #fragment, the ready-made message a leader copies into a
// chat app, and where a new member may be sent after joining.
import { TEAM_LINK_FRAGMENT_KEY } from '@mycel/shared/api'
import type { MessageKey, Params } from '../i18n'
import { namedProduct } from './tabs'

/**
 * The token of a /join#t=<token> address, and the address to put back without it. A fragment never reaches a server
 * log, a proxy or a Referer; the page takes it out of the address bar too (history, screenshots, a shared screen).
 */
export function readJoinToken(loc: { pathname: string; search: string; hash: string }): { token: string | null; cleanUrl: string | null } {
  const frag = new URLSearchParams(loc.hash.replace(/^#/, ''))
  if (!frag.has(TEAM_LINK_FRAGMENT_KEY)) return { token: null, cleanUrl: null }
  const raw = (frag.get(TEAM_LINK_FRAGMENT_KEY) ?? '').trim()
  frag.delete(TEAM_LINK_FRAGMENT_KEY)
  const rest = frag.toString()
  return { token: /^[A-Za-z0-9_-]{16,200}$/.test(raw) ? raw : null, cleanUrl: `${loc.pathname}${loc.search}${rest ? `#${rest}` : ''}` }
}

/** The text a leader pastes into KakaoTalk or Slack: who invites, to which team (`team`: the team's name, so the
 * message says where the link leads; docs/DECISIONS.md "W3"), and the ONE skill to try together when the link names one
 * (the skill the link opens: several shared skills are never listed, docs/DECISIONS.md "W5"), on the product as the app
 * names it beside its AI ("트리나에서", tabs.ts namedProduct); `ownAi`: people who join
 * sign in to their own AI (the link's `memberAi` is `connect_own`), so the message says "본인 AI 계정이 필요해요" before
 * they hit it; `made`: the team skill they just made ("Acme에 '견적서 쓰기' 스킬을 만들어 뒀어요…"). `name` is the
 * person copying it (they are the one sending it). */
export function teamLinkMessage(t: (key: MessageKey, params?: Params) => string, o: { name: string; team: string; url: string; skill?: string | null; made?: boolean; ownAi?: boolean }): string {
  // a team skill the lead just made from their own work (docs/DECISIONS.md "S"), in their voice
  if (o.made && o.skill) return t('teamLink.messageMade', { team: o.team, skill: o.skill, url: o.url })
  const product = namedProduct(t)
  if (o.skill) return t(o.ownAi ? 'teamLink.messageSkillOwnAi' : 'teamLink.messageSkill', { ...product, name: o.name, team: o.team, url: o.url, skill: o.skill })
  return t(o.ownAi ? 'teamLink.messageOwnAi' : 'teamLink.message', { ...product, name: o.name, team: o.team, url: o.url })
}

/** Where to go after joining: only the skill form the server named (`/skills?run=<path>`), anything else is Home. */
export function joinNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/skills?run=')) return '/'
  try {
    const u = new URL(next, 'http://x')
    const run = u.searchParams.get('run')
    return u.pathname === '/skills' && run && run.startsWith('skills/') && [...u.searchParams.keys()].length === 1 ? `/skills?run=${encodeURIComponent(run)}` : '/'
  } catch { return '/' }
}

/**
 * Where the person who just joined goes, kept for the signed-in app's /join route (App.tsx AfterJoin). The join page
 * sets it right before the session switches to signed in: that switch re-renders /join as a signed-in page at once,
 * while the router's own navigation is a transition and would arrive after it.
 */
let afterJoin: string | null = null
export const setAfterJoin = (next: string) => { afterJoin = next }
export const afterJoinTarget = (): string => afterJoin ?? '/'
export const clearAfterJoin = () => { afterJoin = null }

/**
 * "앱에서 열기" on the join pages (docs/DECISIONS.md "First run, phase 2"): the same join page in the app, whose screen
 * ④ asks before anything loads. The link carries the invite or team-link token, so it goes only where our own app
 * receives it:
 * - Android: an `intent://` link naming our package (`package=`): no other app can take it, as one could take a bare
 *   custom scheme.
 * - macOS and Windows: `<scheme>://open?url=…`, answered by the installed desktop app. Another program installed on
 *   the same computer could claim the scheme too (the residual risk, in DECISIONS).
 * - iPhone: none. iOS hands a custom scheme to whichever app claims it, and no package can be named; the verified
 *   universal link (the team link itself on `*.<team domain>`) opens the app there instead.
 * - Anything else (Linux, unknown): none.
 * The team link's token comes from memory (the page took it out of the address bar).
 */
export function openInAppHref(o: { scheme: string; origin: string; path: string; platform: 'ios' | 'android' | 'mac' | 'windows' | 'other'; androidPackage: string; androidFallback?: string | null }): string | null {
  const url = encodeURIComponent(o.origin + o.path)
  // without the app, Chrome opens the fallback page (getAppHref: the store listing or the download page, a fixed
  // https address with nothing of this page in it), never the token
  const fallback = o.androidFallback && /^https:\/\//.test(o.androidFallback) ? `S.browser_fallback_url=${encodeURIComponent(o.androidFallback)};` : ''
  if (o.platform === 'android') return `intent://open?url=${url}#Intent;scheme=${o.scheme};package=${o.androidPackage};${fallback}end`
  if (o.platform === 'mac' || o.platform === 'windows') return `${o.scheme}://open?url=${url}`
  return null
}
/** Shown only in a web browser (inside the apps the page already is the app) with a link for this system. */
export const openInAppShown = (client: 'web' | 'desktop' | 'mobile', href: string | null): href is string => client === 'web' && href !== null

/**
 * "Get the app" on the join pages (docs/DECISIONS.md "Get the app"): a phone's web browser without the app lands here
 * from a tapped invite or team link (with the app, the link itself opens it). The edition's store listing for this
 * phone, else its download page (APP_DOWNLOADS, shared/src/app-downloads.ts); nothing on a computer, inside our own
 * apps, or in a build that names neither. A fixed address: nothing of this page (no token) is ever added to it.
 * - iPhone: the App Store listing.
 * - Android: the Google Play listing once there is one, else the download page (the APK on the update feed, linked
 *   from that page; never the .apk itself).
 *   TODO(play): the Play listing is one value, APP_DOWNLOADS.android (see its TODO in shared/src/app-downloads.ts);
 *   this button and the intent's fallback follow it.
 */
export function getAppHref(platform: 'ios' | 'android' | 'mac' | 'windows' | 'other', client: 'web' | 'desktop' | 'mobile', links: { page: string; iphone: string; android: string }): string | null {
  if (client !== 'web') return null
  const href = platform === 'ios' ? links.iphone || links.page : platform === 'android' ? links.android || links.page : ''
  return /^https:\/\//.test(href) ? href : null
}
