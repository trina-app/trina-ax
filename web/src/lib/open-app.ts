// "Continue in the Mac app" (docs/decisions/20261116-desktop-first-onboarding.md): right after making the team on /setup,
// a Mac, Windows or Linux browser goes to /open-app (pages/OpenApp.tsx), whose one button opens the desktop app on this
// team already signed in, with a one-time code (server/src/auth/app-signin.ts). Finding work files on the computer works
// only in the Mac and Windows app; people who stay in the browser see one quiet line in the files step and in My files
// (components/OpenAppLine.tsx). Pure rules here, unit-tested in web/test/unit/open-app.test.ts.
import { OWNER_CLAIM_SETUP_PATH, readOwnerClaimFragment } from '@mycel/shared/cloud-protocol/owner-claim'
import { openInAppHref } from './team-link'
import { desktopPlatform, type DesktopPlatform, type Platform } from './pwa'

export const OPEN_APP_PATH = '/open-app'
export const APP_SIGNIN_PATH = '/app-signin'

export type AppComputer = DesktopPlatform

/**
 * The computer whose desktop app this page can hand the person to: a web browser (not our desktop or phone app) on macOS,
 * Windows or Linux (the systems with the desktop app; an iPad that says "Mac" is a phone here, an Android tablet or a
 * Chromebook is not Linux, lib/pwa.ts), on a team the app can open from a link: https (the app opens no plain-http link
 * from outside; desktop/src/common/address.ts readDesktopLink) or this machine (development and the tests). null
 * everywhere else (phones, inside the apps).
 */
export function appComputer(o: { platform: Platform; client: 'web' | 'desktop' | 'mobile'; origin: string }): AppComputer | null {
  if (o.client !== 'web' || !desktopPlatform(o.platform)) return null
  let u: URL
  try { u = new URL(o.origin) } catch { return null }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)
  return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? o.platform : null
}

/** This page's origin ('' where there is none: tests without a page address) */
export const pageOrigin = (): string => (typeof window !== 'undefined' && window.location ? window.location.origin : '')

/** Where /setup goes once the team is made: /open-app on a Mac, Windows or Linux browser, else the welcome steps. */
export const afterSetupPath = (o: Parameters<typeof appComputer>[0]): string => (appComputer(o) ? OPEN_APP_PATH : '/welcome')

/** The files step's and My files' line ("… works in the Mac and Windows app. Open the app"): a Mac or Windows browser,
 * never a guest (they have no My files and no files step). Not Linux: the Linux app has no Find work files
 * (docs/decisions/20261119-linux-desktop-app.md "Off on Linux"), so the line would promise what it cannot do. */
export const openAppLineShown = (o: Parameters<typeof appComputer>[0] & { guest: boolean }): boolean => {
  const c = appComputer(o)
  return !o.guest && (c === 'mac' || c === 'windows')
}

/** The desktop app's link for a fresh code: `<scheme>://open?url=<origin>/app-signin#c=<code>` (the code only in the
 * fragment, which no server or proxy log sees). null on another system. */
export function appSignInHref(o: { scheme: string; origin: string; code: string; computer: AppComputer }): string | null {
  return openInAppHref({ scheme: o.scheme, origin: o.origin, path: `${APP_SIGNIN_PATH}#c=${o.code}`, platform: o.computer, androidPackage: '' })
}

/** The code in /app-signin's address (`#c=<43 characters>`), or null. */
export function readAppSignInCode(hash: string): string | null {
  return /^#c=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? null
}

/** A hosted team made from the desktop app (docs/decisions/20261126-desktop-create-team.md): the app opens
 * `/app-setup#c=<claim>` from the hosting console; the page makes the owner (pages/OpenApp.tsx AppSetup). */
export const APP_SETUP_PATH = OWNER_CLAIM_SETUP_PATH
/** The console's claim in /app-setup's address (`#c=<43 characters>`, nothing else), or null. */
export const readAppSetupClaim = (hash: string): string | null => readOwnerClaimFragment(hash)

/** Where /app-setup keeps its claim for a reload of this tab (sessionStorage: this tab only, never the address, the
 * history or another tab). Removed once the claim is used or refused. */
export const APP_SETUP_CLAIM_KEY = 'mycel.appSetupClaim'
export interface AppSetupClaimStore { get(): string | null; set(claim: string): void; remove(): void }
/** This tab's sessionStorage (blocked storage: nothing kept, a reload then shows "expired" as before). */
export const sessionClaimStore = (): AppSetupClaimStore => ({
  get: () => { try { return sessionStorage.getItem(APP_SETUP_CLAIM_KEY) } catch { return null } },
  set: (claim) => { try { sessionStorage.setItem(APP_SETUP_CLAIM_KEY, claim) } catch { /* blocked: this load only */ } },
  remove: () => { try { sessionStorage.removeItem(APP_SETUP_CLAIM_KEY) } catch { /* blocked */ } },
})
/** /app-setup's claim: the one in the address (a new one replaces the kept one: the app asked the console again, which
 * revoked the older), else the one this tab kept (a reload; the page took it out of the address). */
export function takeAppSetupClaim(hash: string, kept: AppSetupClaimStore): string | null {
  const fresh = readAppSetupClaim(hash)
  if (fresh) {
    kept.set(fresh)
    return fresh
  }
  const old = kept.get()
  return old && readAppSetupClaim(`#c=${old}`) ? old : null
}
