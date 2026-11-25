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

/** ready: no try yet, and the page makes none by itself (Safari, see launchWay: it waits for a press); opening: the
 * try is on its way, or waits for the tab to be seen; opened: after a try the page lost focus or became hidden (the
 * app, or the browser's own "Open <app>?" prompt, took over); notOpened: nothing happened within APP_OPEN_WAIT_MS of
 * the try */
export type AppOpenPhase = 'ready' | 'opening' | 'opened' | 'notOpened'
/** `signs`: whether a blur or a hidden page counts at all in this browser (launchWay) */
export interface AppTryState { phase: AppOpenPhase; tried: boolean; signs: boolean }
export const appTryStart = (way: LaunchWay): AppTryState => ({ phase: autoTries(way) ? 'opening' : 'ready', tried: false, signs: way !== 'press' })
/**
 * try: a try was just made (on load once the tab is seen, or a press of Open the app); sign: a blur event or a change
 * of the page to hidden, as it happens (never a state read later: a tab opened in the background starts hidden and
 * would read as "opened"); timeout: APP_OPEN_WAIT_MS after the try. A sign before any try means nothing; a sign after
 * the wait still counts (Chrome asks "Open <app>?" first, and a slow press on it comes after the wait).
 */
export function appTryStep(s: AppTryState, e: 'try' | 'sign' | 'timeout'): AppTryState {
  if (e === 'try') return { ...s, phase: 'opening', tried: true }
  if (!s.tried) return s
  if (e === 'sign') return !s.signs || s.phase === 'opened' ? s : { ...s, phase: 'opened' }
  return s.phase === 'opening' ? { ...s, phase: 'notOpened' } : s
}

/** The automatic try waits until the person sees the tab: a link opened in a background tab (cmd-click from a mail)
 * tries the app when that tab is first shown, never while hidden. */
export const canAutoTry = (visibility: DocumentVisibilityState | string): boolean => visibility === 'visible'

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

/** How long a hidden frame used for a try stays (removed earlier when the page goes away): long enough for a slow
 * "Open <app>?" answer. */
export const LAUNCH_FRAME_MS = 60_000

/**
 * How a try is made, by browser (checked in real Chrome and Safari on a Mac, 2026-11-25):
 * - frame: Firefox. A top-level try of a link no app answers replaces the page with an error page, so the link goes to
 *   a hidden frame.
 * - press: Safari. A top-level try of a link no app answers keeps the page but covers it with a modal "Safari cannot
 *   open the page because the address is invalid", so nothing is tried on load: the page leads with Open the app, and
 *   its press is the try (as "앱에서 열기" always was). Safari's own "Allow this page to open …?" sheet may take focus
 *   before the person answers, so no blur counts as opened there.
 * - page: Chrome, Edge and the rest. The page's own navigation, as "앱에서 열기" always did; without an app the browser
 *   stays on the page and says nothing (checked in Chrome).
 */
export type LaunchWay = 'frame' | 'press' | 'page'
export function launchWay(userAgent: string): LaunchWay {
  if (/\bFirefox\//.test(userAgent)) return 'frame'
  const safari = /\bVersion\/[\d.]+.*\bSafari\//.test(userAgent) && !/\b(Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS)\//.test(userAgent)
  return safari ? 'press' : 'page'
}
/** whether the page tries the app by itself on load (once, when first seen) */
export const autoTries = (way: LaunchWay): boolean => way !== 'press'

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
