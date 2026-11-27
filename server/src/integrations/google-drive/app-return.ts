// A Google Drive sign-in started in the desktop app finishes in the system browser, which has no session of the app
// (QA 2026-11-20: the browser ended on "This browser is not signed in to <app>" and the app waited forever). The
// browser is not trusted to finish it (security review of trina-ax #98: anything a browser can be handed, an attacker can
// hand a victim). Instead (RFC 8252's idea: the answer goes to the app on the computer that signed in):
//
//  1. Google's return in a browser WITHOUT a session, for a flow a desktop session started: the server takes the
//     hosting service's handoff (it lives 2 minutes) and keeps the result sealed in the flow, still "waiting"
//     (state 'exchanging', no account shown to anyone), with a one-time completion code (32 random bytes, its hash in
//     the sealed secret, CLAIM_MS).
//  2. The page gives the code only to the app on THIS computer: the "Back to the app" link
//     `<linkScheme>://open?url=<team>/#code=<code>` (in the fragment, never in a query string, so no server or log sees
//     it). The desktop app sends it to its team with its own session (POST CLAIM_PATH).
//  3. The code completes the flow only for the session that started it: the flow turns "ready" and the person confirms
//     the account in the app as before.
//
// A phished victim's browser hands the code to the victim's own computer, whose app has the victim's session, not the
// attacker's: nothing connects. A browser signed in as someone else is refused, as before. A browser signed in as the
// same person finishes at once, as before.
//
// Since 2026-11-27 the page sends the browser on to the app's own return address on 127.0.0.1 when the app said it
// has one (RFC 8252 7.3; docs/decisions/20261127-desktop-sign-in-code-loopback.md): the desktop page tells its server
// the port on every API call (APP_RETURN_HEADER, noteAppReturn), and the held page's meta refresh and button go to
// `http://127.0.0.1:<port>/sign-in-code?code=<code>` (heldLink). The code is in that query only on the way to this
// computer; it is one-time, 5 minutes, and redeemable only by the starter's session. The app link stays for an app
// from before (no port known): a browser that opens no apps (ego lite: ERR_UNKNOWN_URL_SCHEME) lost the code there,
// and the app waited until its 5-minute limit (owner 2026-11-27).
//
// Gmail, Calendar, Docs and Sheets (google-apps/service.ts) do the same since 2026-11-21, redeemed at the same claim
// address (the desktop app posts every code there). A held page opened again NEVER gives a new code and finishes
// nothing: it says to go back to the app (the starter has the state too: it is in the Google address the app was
// given). The first return's page holds the only code. A return to a sign-in already answered otherwise says how it
// went instead of "expired or already used" (docs/decisions/20261121-google-return-already-answered.md).
//
// Before Google, the desktop app opens GO_PATH: a page of this server that names the Trina person the Drive will
// belong to, then links on to the sign-in page. Its key is random, its hash sealed in the flow; it grants nothing.
import crypto from 'node:crypto'
import { APP_CODE_RETURN_PATH, PRODUCT, appReturnPortOf } from '@mycel/shared'

/** the page the desktop app opens first in the system browser: whose Trina gets the Drive (routes/drive.ts) */
export const GO_PATH = '/api/integrations/google-drive/go'
/** how long the one-time completion code works */
export const CLAIM_MS = 5 * 60_000
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export const newToken = () => crypto.randomBytes(32).toString('base64url')
export const tokenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex')
/** the value has the shape of a token and hashes to `hash` (constant time) */
export function tokenMatches(t: unknown, hash: string | undefined): boolean {
  if (typeof t !== 'string' || !TOKEN.test(t) || !hash) return false
  const a = Buffer.from(tokenHash(t), 'hex'), b = Buffer.from(hash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** The desktop app's link to this team (desktop/src/common/address.ts readDesktopLink): it brings the app forward;
 * with `code`, the app also completes the waiting sign-in with it (the code in the fragment, never the query). */
export function appLink(origin: string, code?: string): string {
  return `${PRODUCT.linkScheme}://open?${new URLSearchParams({ url: `${origin}/` })}${code ? `#code=${code}` : ''}`
}

/** The return address port each session last said (APP_RETURN_HEADER, http/middleware.ts): memory only (a restart
 * forgets it until the app's next call, then the app link is used), bounded, newest last. Not only a session recorded
 * as 'desktop': the desktop app's session can be recorded as 'web' (a team created in the app), and its Google start
 * then says `client: 'desktop'` (routes/drive.ts startedFrom). The port is used only for a result held for the desktop
 * app's one-time code, which only the starting session redeems; a phone app's session never keeps one. */
const RETURN_PORTS_MAX = 5000
const returnPorts = new Map<string, number>()

/** A session's request named its app's return port (a phone app's, or no valid port: nothing kept). */
export function noteAppReturn(session: { id: string; client: string }, header: string | undefined) {
  if (session.client === 'mobile' || header === undefined) return
  const port = appReturnPortOf(header)
  if (port === null) return
  // newest last on every call: an app in use is never the one dropped when the map is full
  returnPorts.delete(session.id)
  returnPorts.set(session.id, port)
  if (returnPorts.size > RETURN_PORTS_MAX) returnPorts.delete(returnPorts.keys().next().value!)
}

/** The port the app of this session said, or null (an app from before, or none said since the server started). */
export function appReturnPort(sessionId: string): number | null {
  return returnPorts.get(sessionId) ?? null
}

/** Where a held page sends the browser with its one-time code: the app's return address on 127.0.0.1 when its session
 * said one, with this team's address (the app hands the code on only while that team is on screen), else the app link
 * (the code in its fragment). The page offers the app link too, for an app that quit meanwhile (callback-page.ts). */
export function heldLink(origin: string, code: string, port?: number | null): string {
  return port ? `http://127.0.0.1:${port}${APP_CODE_RETURN_PATH}?${new URLSearchParams({ code, team: origin })}` : appLink(origin, code)
}
