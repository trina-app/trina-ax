// The team invite link on the web side (contract: shared/src/api/team-links.ts). Pure helpers, so they are tested
// without a browser: reading the token from the address's #fragment, the ready-made message a leader copies into a
// chat app, and where a new member may be sent after joining.
import { TEAM_LINK_FRAGMENT_KEY } from '@mycel/shared/api'
import { appLinkOpens, isLoopbackHost } from '@mycel/shared/team-link'
import type { MessageKey, Params } from '../i18n'
import { namedProduct } from './tabs'
import { desktopPlatform, type Platform } from './pwa'

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

/** also the phone's owed sign-out keeps it (mobile/src/leave.ts) */
export const JOIN_TOKEN_KEY = 'mycel.joinToken'

/**
 * The team link of this tab: the address's #t= (which the page then takes out of the address bar), else the token this
 * tab kept from it. The tab keeps it until the person joined or the server said the link does not work, so a refresh
 * on a weak phone connection (the details never loaded, or the form was open) still finds the link.
 */
export function tabJoinToken(loc: { pathname: string; search: string; hash: string }): { token: string | null; cleanUrl: string | null } {
  const link = readJoinToken(loc)
  try {
    if (link.cleanUrl === null) return { token: sessionStorage.getItem(JOIN_TOKEN_KEY), cleanUrl: null }
    if (link.token) sessionStorage.setItem(JOIN_TOKEN_KEY, link.token)
    else sessionStorage.removeItem(JOIN_TOKEN_KEY)
  } catch { /* storage blocked: only the address has it, as before */ }
  return link
}
/** Joined, or the link does not work: the tab forgets the token. */
export function forgetJoinToken() {
  try { sessionStorage.removeItem(JOIN_TOKEN_KEY) } catch { /* storage blocked: nothing kept */ }
}

/** The text a leader pastes into KakaoTalk, Slack or an email, a few short lines in their voice (owner 2026-11-14: the
 * colleague should see who invites them, what the team is and what to do first): a hello from the person copying it
 * (`name`) inviting to the team (`team`: the team's name, so the message says where the link leads; docs/DECISIONS.md
 * "W3") on the product as the app names it beside its AI ("트리나에서", tabs.ts namedProduct); `about`: one line about
 * the team from the welcome steps' company profile (its `oneLine`; nothing when empty, never a blank "About us:");
 * one honest line on what the product is for (never a claim about files or tools the team may not have added); the ONE
 * skill the link names, as set up for the team ("I set up '{skill}' for us": no "first", no "together", the member lands
 * on Home; several shared skills are never listed, docs/DECISIONS.md "W5"), no line without one; `ownAi`: people
 * who join sign in to their own AI (the link's `memberAi` is `connect_own`), so it says "본인 AI 계정이 필요해요" before
 * they hit it; `until`: the link's end, written as `teamLink.until` writes it (formatDateTime in the message's
 * language), in one line saying several teammates can join with this one link and until when (owner 2026-11-25: people
 * took it for a personal link; it never asks them to pass it on); the link alone on the last line. A skill the lead just made from their own work reads the same ("I set
 * up '{skill}' for us"): people who join land on Home, so there is no "open the link to use it" any more. The person
 * can edit it before copying (TeamLinkPanel; an edit without the link gets it back on copy); nothing is ever sent by
 * itself. */
export function teamLinkMessage(t: (key: MessageKey, params?: Params) => string, o: { name: string; team: string; url: string; until: string; skill?: string | null; ownAi?: boolean; about?: string | null }): string {
  const product = namedProduct(t)
  const name = o.name.trim()
  // one line: a profile line is short (PROFILE_LIMITS.oneLine), but its line breaks would split the message
  const about = (o.about ?? '').replace(/\s+/g, ' ').trim()
  return [
    name ? t('teamLink.msg.hello', { ...product, name, team: o.team }) : t('teamLink.msg.helloNoName', { ...product, team: o.team }),
    about && t('teamLink.msg.about', { about }),
    t('teamLink.msg.what', product),
    o.skill && t('teamLink.msg.skill', { skill: o.skill }),
    o.ownAi && t('teamLink.msg.ownAi'),
    o.until && t('teamLink.msg.shared', { date: o.until }),
    t('teamLink.msg.join', { url: o.url }),
  ].filter(Boolean).join('\n')
}

/**
 * Where the person who just joined goes, kept for the signed-in app's /join route (App.tsx AfterJoin). The join page
 * sets it right before the session switches to signed in: that switch re-renders /join as a signed-in page at once,
 * while the router's own navigation is a transition and would arrive after it.
 */
let afterJoin: string | null = null
export const setAfterJoin = (next: string) => { afterJoin = next }
export const afterJoinTarget = (): string => afterJoin ?? '/'
/** The join page set where to go: someone just joined (not a team link opened while already signed in). */
export const afterJoinSet = (): boolean => afterJoin !== null
export const clearAfterJoin = () => { afterJoin = null }

/** The web e2e suite runs its mock team at http://127.0.0.1 (web/playwright.config.ts), where no offer is made; it
 * sets this key so its specs keep testing the offers. Nothing else sets it, and it counts on a loopback page only. */
export const E2E_APP_LINKS_KEY = 'mycel.e2eAppLinks'

/** Whether this page may offer to continue in the desktop app: only where the app opens the link (shared appLinkOpens:
 * https, never this computer's own address; docs/decisions/20261128-loopback-no-open-in-app.md). A page at
 * 127.0.0.1, localhost or ::1 offers none: the app refuses such a link, so the button could never work there; the app
 * connects when the address is pasted on its first screen instead. */
export function appLinkOffered(origin: string): boolean {
  if (appLinkOpens(origin)) return true
  try {
    return isLoopbackHost(new URL(origin).hostname) && localStorage.getItem(E2E_APP_LINKS_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * "앱에서 열기" on the join pages (docs/DECISIONS.md "First run, phase 2"): the same join page in the app, whose screen
 * ④ asks before anything loads. The link carries the invite or team-link token, so it goes only where our own app
 * receives it:
 * - Android: an `intent://` link naming our package (`package=`): no other app can take it, as one could take a bare
 *   custom scheme.
 * - macOS, Windows and Linux: `<scheme>://open?url=…`, answered by the installed desktop app (on Linux the .deb's menu
 *   entry registers the scheme; docs/decisions/20261119-linux-desktop-app.md "Links"), on a team the app opens from
 *   a link (appLinkOffered: none at this computer's own address). Another program installed on
 *   the same computer could claim the scheme too (the residual risk, in DECISIONS).
 * - iPhone: none. iOS hands a custom scheme to whichever app claims it, and no package can be named; the verified
 *   universal link (the team link itself on `*.<team domain>`) opens the app there instead.
 * - Anything else (ChromeOS, unknown): none.
 * The team link's token comes from memory (the page took it out of the address bar).
 */
export function openInAppHref(o: { scheme: string; origin: string; path: string; platform: Platform; androidPackage: string; androidFallback?: string | null }): string | null {
  const url = encodeURIComponent(o.origin + o.path)
  // without the app, Chrome opens the fallback page (getAppHref: the store listing or the download page, a fixed
  // https address with nothing of this page in it), never the token
  const fallback = o.androidFallback && /^https:\/\//.test(o.androidFallback) ? `S.browser_fallback_url=${encodeURIComponent(o.androidFallback)};` : ''
  if (o.platform === 'android') return `intent://open?url=${url}#Intent;scheme=${o.scheme};package=${o.androidPackage};${fallback}end`
  if (desktopPlatform(o.platform)) return appLinkOffered(o.origin) ? `${o.scheme}://open?url=${url}` : null
  return null
}
/** Shown only in a web browser (inside the apps the page already is the app) with a link for this system. */
export const openInAppShown = (client: 'web' | 'desktop' | 'mobile', href: string | null): href is string => client === 'web' && href !== null

/**
 * "Open in the app" in a chat's title menu (docs/DECISIONS.md "A chat link opens the desktop app on that chat"): the
 * same chat in the desktop app, which opens it at once on a team it already has and else asks on its screen ④. Only in
 * a computer's web browser on macOS, Windows or Linux (the systems the desktop app answers the link on), never at phone width,
 * never inside our apps, and only on an https team (the desktop app opens no other link). Without the app the browser
 * does nothing more (the page stays as it is).
 */
export function chatOpenInAppHref(o: { scheme: string; origin: string; chatId: string; platform: Platform; client: 'web' | 'desktop' | 'mobile'; phone: boolean }): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(o.chatId) ? pageOpenInAppHref({ ...o, path: `/c/${o.chatId}` }) : null
}

/** The same for a chat's, a room's or a project's page (`/c/<id>`, `/rooms/<id>`, `/projects/<id>`: the pages the desktop
 * app opens at once on a team it has, desktop common/address.ts desktopPagePath), by the same rules
 * (docs/decisions/20261126-shared-menus.md: every title menu has it). */
export function pageOpenInAppHref(o: { scheme: string; origin: string; path: string; platform: Platform; client: 'web' | 'desktop' | 'mobile'; phone: boolean }): string | null {
  if (o.client !== 'web' || o.phone || !/^https:\/\/[^/]+$/.test(o.origin) || !desktopPlatform(o.platform) || !/^\/(c|rooms|projects)\/[A-Za-z0-9_-]{1,64}$/.test(o.path)) return null
  return openInAppHref({ scheme: o.scheme, origin: o.origin, path: o.path, platform: o.platform, androidPackage: '' })
}

/**
 * "Get the app" on the join pages (docs/DECISIONS.md "Get the app"): a phone's web browser without the app lands here
 * from a tapped invite or team link (with the app, the link itself opens it). The edition's store listing for this
 * phone, else its download page (APP_DOWNLOADS, shared/src/app-downloads.ts); nothing on a computer, inside our own
 * apps, or in a build that names neither. A fixed address: nothing of this page (no token) is ever added to it.
 * - iPhone: the App Store listing.
 * - Android: the Google Play listing (APP_DOWNLOADS.android), else the download page (never an .apk itself); the
 *   intent's fallback follows it.
 */
export function getAppHref(platform: Platform, client: 'web' | 'desktop' | 'mobile', links: { page: string; iphone: string; android: string }): string | null {
  if (client !== 'web') return null
  const href = platform === 'ios' ? links.iphone || links.page : platform === 'android' ? links.android || links.page : ''
  return /^https:\/\//.test(href) ? href : null
}

/** What Copy message / Send message sends: the person's text, with the link put back on its own last line when their
 * edit took it out (the message is only an invite with the link in it). */
export function withInviteLink(text: string, url: string): string {
  return text.includes(url) ? text : `${text.trimEnd()}\n${url}`
}
