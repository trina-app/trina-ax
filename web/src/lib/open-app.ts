// "Continue in the Mac app" (docs/decisions/20261116-desktop-first-onboarding.md): right after making the team on /setup,
// a Mac or Windows browser goes to /open-app (pages/OpenApp.tsx), whose one button opens the desktop app on this team
// already signed in, with a one-time code (server/src/auth/app-signin.ts). Finding work files on the computer works only
// in the desktop app; people who stay in the browser see one quiet line in the files step and in My files
// (components/OpenAppLine.tsx). Pure rules here, unit-tested in web/test/unit/open-app.test.ts.
import { openInAppHref } from './team-link'
import type { Platform } from './pwa'

export const OPEN_APP_PATH = '/open-app'
export const APP_SIGNIN_PATH = '/app-signin'

export type AppComputer = 'mac' | 'windows'

/**
 * The computer whose desktop app this page can hand the person to: a web browser (not our desktop or phone app) on macOS
 * or Windows (the systems with the desktop app; an iPad that says "Mac" is a phone here, lib/pwa.ts), on a team the app
 * can open from a link: https (the app opens no plain-http link from outside; desktop/src/common/address.ts
 * readDesktopLink) or this machine (development and the tests). null everywhere else (phones, Linux, inside the apps).
 */
export function appComputer(o: { platform: Platform; client: 'web' | 'desktop' | 'mobile'; origin: string }): AppComputer | null {
  if (o.client !== 'web' || (o.platform !== 'mac' && o.platform !== 'windows')) return null
  let u: URL
  try { u = new URL(o.origin) } catch { return null }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
  return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? o.platform : null
}

/** This page's origin ('' where there is none: tests without a page address) */
export const pageOrigin = (): string => (typeof window !== 'undefined' && window.location ? window.location.origin : '')

/** Where /setup goes once the team is made: /open-app on a Mac or Windows browser, else the welcome steps. */
export const afterSetupPath = (o: Parameters<typeof appComputer>[0]): string => (appComputer(o) ? OPEN_APP_PATH : '/welcome')

/** The files step's and My files' line ("… works in the Mac and Windows app. Open the app"): a computer's browser, never a
 * guest (they have no My files and no files step). */
export const openAppLineShown = (o: Parameters<typeof appComputer>[0] & { guest: boolean }): boolean => !o.guest && appComputer(o) !== null

/** The desktop app's link for a fresh code: `<scheme>://open?url=<origin>/app-signin#c=<code>` (the code only in the
 * fragment, which no server or proxy log sees). null on another system. */
export function appSignInHref(o: { scheme: string; origin: string; code: string; computer: AppComputer }): string | null {
  return openInAppHref({ scheme: o.scheme, origin: o.origin, path: `${APP_SIGNIN_PATH}#c=${o.code}`, platform: o.computer, androidPackage: '' })
}

/** The code in /app-signin's address (`#c=<43 characters>`), or null. */
export function readAppSignInCode(hash: string): string | null {
  return /^#c=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? null
}
