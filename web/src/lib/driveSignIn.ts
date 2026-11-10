import { driveBrokerConnectUrl } from '@mycel/shared/cloud-protocol/drive-broker'

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
