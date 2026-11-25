// The join pages open the desktop app first on a computer (docs/decisions/20261125-invite-open-app-first.md; owner
// 2026-11-25: "앱으로 우선 열도록 … 없으면 다운받게 … 정 안되면 브라우저"). Like Zoom and Slack: a member invite link or a
// team link opened in a Mac, Windows or Linux web browser tries the desktop app once on load, with the existing
// "앱에서 열기" link (lib/team-link.ts openInAppHref, unchanged: the token reaches the app as before). The page then
// says the app is opening, with Open the app (again), Download the app and a quiet Continue in the browser. Pure rules
// here, unit-tested in web/test/unit/join-open-app.test.ts.
import { appComputer } from './open-app'
import type { Platform } from './pwa'

/** this browser chose the browser for invites once: later invites go straight to the form */
export const JOIN_IN_BROWSER_KEY = 'mycel.joinInBrowser'

/** How long the page waits for a sign that the app took the link (the page lost focus or was hidden). */
export const APP_OPEN_WAIT_MS = 2000

/**
 * Whether the join page leads with the desktop app: a web browser on a computer with the desktop app, on a team the
 * app opens from a link (lib/open-app.ts appComputer: https, or this machine for development), for a member (a guest,
 * someone from outside the team who usually joins once, keeps the browser first), unless this browser chose the browser
 * before or the person is back from Google (they chose the browser already), and only with a link to open.
 */
export function appFirst(o: { platform: Platform; client: 'web' | 'desktop' | 'mobile'; origin: string; guest: boolean; browserChosen: boolean; googleBack: boolean; href: string | null }): boolean {
  return !o.guest && !o.browserChosen && !o.googleBack && !!o.href && appComputer(o) !== null
}

/** opening: the try is on its way; opened: the page lost focus or was hidden (the app, or the browser's own "Open the
 * app?" prompt, took over); notOpened: nothing happened within APP_OPEN_WAIT_MS */
export type AppOpenPhase = 'opening' | 'opened' | 'notOpened'

/** What the wait says once it is over: any sign of the app means it opened. A later sign still counts (the caller
 * moves to 'opened' on it): Chrome asks "Open Trina AX?" first, and a slow press on it comes after the wait. */
export const phaseAfterWait = (o: { blurred: boolean; hidden: boolean }): AppOpenPhase => (o.blurred || o.hidden ? 'opened' : 'notOpened')

/** The one primary button: Download once the app did not open and there is a download link; otherwise Open the app.
 * The other actions stay as quiet links whatever the guess. */
export const primaryAction = (phase: AppOpenPhase, download: string | null): 'open' | 'download' => (phase === 'notOpened' && download ? 'download' : 'open')

/** Where Download the app leads on this computer: the edition's store listing for this system, else its download page
 * (shared/src/app-downloads.ts; the page has the signed Mac dmg, the Windows installer and the Linux packages). An https
 * address with nothing of this page in it, or null (a build without one: no Download line). */
export function desktopDownloadHref(platform: Platform, links: { page: string; mac: string; windows: string }): string | null {
  const href = (platform === 'mac' ? links.mac : platform === 'windows' ? links.windows : '') || links.page
  return /^https:\/\//.test(href) ? href : null
}

/** How the try is made. Firefox shows an error page in place of this one for a link no app answers, so there the
 * link goes to a hidden frame; everywhere else the page's own navigation, as "앱에서 열기" always did (the browser
 * stays on this page whether an app answers or not). */
export const launchWay = (userAgent: string): 'frame' | 'page' => (/\bFirefox\//.test(userAgent) ? 'frame' : 'page')

/** this browser's remembered choice (storage blocked: never remembered, the app is tried) */
export function browserChosen(storage: Pick<Storage, 'getItem'> | null): boolean {
  try { return storage?.getItem(JOIN_IN_BROWSER_KEY) === '1' } catch { return false }
}
export function rememberBrowser(storage: Pick<Storage, 'setItem'> | null) {
  try { storage?.setItem(JOIN_IN_BROWSER_KEY, '1') } catch { /* storage blocked: asked again next time */ }
}

/** The automatic try happens once per page load, whatever re-renders or remounts (the page switches between its
 * loading and loaded states; React's development mode runs effects twice). */
let tried = false
export function takeAutoTry(): boolean {
  if (tried) return false
  tried = true
  return true
}
/** tests only */
export const resetAutoTry = () => { tried = false }
