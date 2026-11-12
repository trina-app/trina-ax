import { driveBrokerConnectUrl } from '@mycel/shared/cloud-protocol/drive-broker'
import { isDesktop } from './desktop'
import { mobileApp } from './mobile'

/** Google's own sign-in page, or an error: the only address a Drive sign-in may open directly (and the only one the
 * phone app's browser hand-off accepts). */
export function googleAuthorization(value: string): string {
  const u = new URL(value)
  if (u.origin !== 'https://accounts.google.com' || u.pathname !== '/o/oauth2/v2/auth' || u.username || u.password) throw new Error('invalid authorization URL')
  return u.href
}

/** Where a Drive sign-in starts in this browser. A hosted team that signs in through the hosting service may get the
 * service's own start page (`connectUrl`: it names the team, explains Google's screen, then links to Google); it is
 * used only in its exact shape (https, or http on this machine; the contract's path; one `state`). Otherwise, and in
 * the phone app (its browser hand-off takes Google only), Google's page. Throws when Google's address is not valid. */
export function driveSignInUrl(answer: { authorizationUrl: string; connectUrl?: string }, phoneApp: boolean): string {
  const google = googleAuthorization(answer.authorizationUrl)
  if (phoneApp || !answer.connectUrl) return google
  let u: URL
  try { u = new URL(answer.connectUrl) } catch { return google }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return google
  return driveBrokerConnectUrl(u.origin, answer.connectUrl) ?? google
}

/** Where a Google sign-in opens: the phone app hands the address to its browser (lib/mobile.ts openExternal), the
 * desktop app to the system browser, a browser opens a window of its own. */
export type SignInPlace = 'phone' | 'desktop' | 'browser'
export const signInPlace = (): SignInPlace => (mobileApp() ? 'phone' : isDesktop() ? 'desktop' : 'browser')
type Open = (url: string, target: string) => Window | null
const browserOpen: Open = (url, target) => window.open(url, target)

/** During the click: a browser reserves a blank window (one opened after the server answers is blocked as a popup).
 * The phone app opens nothing here. Neither does the desktop app: its window handler (desktop/src/main/security.ts)
 * sends only http(s) addresses to the system browser and refuses a blank window, so the reserved window was always
 * null and the person saw only "Continue with Google". */
export function reserveSignInWindow(place: SignInPlace, open: Open = browserOpen): Window | null {
  if (place !== 'browser') return null
  const w = open('about:blank', '_blank')
  if (w) w.opener = null
  return w
}

/** Once the checked address is known (driveSignInUrl), outside the phone app: the browser sends the reserved window
 * there; the desktop app opens it now, in the system browser (its handler answers every window.open with none). */
export function openSignInWindow(place: SignInPlace, reserved: Window | null, url: string, open: Open = browserOpen) {
  if (place === 'desktop') open(url, '_blank')
  else if (place === 'browser' && reserved) reserved.location.replace(url)
}
