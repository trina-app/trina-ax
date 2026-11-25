// The join pages open the desktop app first on a computer (docs/decisions/20261125-invite-open-app-first.md; owner
// 2026-11-25: "앱으로 우선 열도록 … 없으면 다운받게 … 정 안되면 브라우저"). Like Zoom and Slack: a member invite link or a
// team link opened in a Mac, Windows or Linux web browser leads with Open the app (the existing "앱에서 열기" link,
// lib/team-link.ts openInAppHref, unchanged: the token reaches the app as before), Download the app as the second
// choice, and a quiet Continue in the browser. Where a browser allows it the page also tries the app once by itself.
// The page never says whether the app opened: a browser does not tell, and focus and visibility are taken by the
// browser's own prompts and bubbles as often as by the app (Edge and Chrome on Windows, 2026-11-25). Pure rules here,
// unit-tested in web/test/unit/join-open-app.test.ts.
import { appComputer } from './open-app'
import type { Platform } from './pwa'

/** this browser chose the browser for invites once: later invites go straight to the form */
export const JOIN_IN_BROWSER_KEY = 'mycel.joinInBrowser'

/**
 * Whether the join page leads with the desktop app: a web browser on a computer with the desktop app, on a team the
 * app opens from a link (lib/open-app.ts appComputer: https, or this machine for development), for a member (a guest,
 * someone from outside the team who usually joins once, keeps the browser first), unless this browser chose the browser
 * before or the person is back from Google (they chose the browser already), and only with a link to open.
 */
export function appFirst(o: { platform: Platform; client: 'web' | 'desktop' | 'mobile'; origin: string; guest: boolean; browserChosen: boolean; googleBack: boolean; href: string | null }): boolean {
  return !o.guest && !o.browserChosen && !o.googleBack && !!o.href && appComputer(o) !== null
}

/** The automatic try waits until the person sees the tab: a link opened in a background tab (cmd-click from a mail)
 * tries the app when that tab is first shown, never while hidden. */
export const canAutoTry = (visibility: DocumentVisibilityState | string): boolean => visibility === 'visible'

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
 * How a try is made, by browser (real browsers, 2026-11-25):
 * - page: Chrome, Edge and the rest navigate the page to the link. Edge shows its "This site is trying to open …"
 *   prompt; Chrome on Windows blocks a try that no press started ("a user gesture is required"), which is harmless:
 *   the page stays and the person presses Open the app. Without an app nothing shows (Chrome on a Mac).
 * - frame: Firefox. A top-level try of a link no app answers replaces the page with an error page, so the link goes to
 *   a hidden frame.
 * - press: Safari. A top-level try of a link no app answers keeps the page but covers it with a modal "Safari cannot
 *   open the page because the address is invalid", so Safari tries only on a press of Open the app (as "앱에서 열기"
 *   always did), never by itself.
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

/** The page's one line: before any try, what the page is for; after one, the same neutral line whatever happened (the
 * page cannot know whether the app opened). */
export const appFirstLine = (tried: boolean): 'auth.appTried' | 'auth.appReady' => (tried ? 'auth.appTried' : 'auth.appReady')
