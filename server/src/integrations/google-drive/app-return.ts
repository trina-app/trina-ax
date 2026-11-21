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
// Not the loopback listener of RFC 8252 7.3: the hosting service sends the browser only to the team's https address,
// and a team page cannot hand a fragment to http://127.0.0.1 (the listener never sees it) nor a query (it would put
// the code in a query string). The app's own link carries it instead.
//
// Gmail, Calendar, Docs and Sheets (google-apps/service.ts) do the same since 2026-11-21, redeemed at the same claim
// address (the desktop app posts every code there). A held page opened again gives a new code (the old one stops
// working), and a return to a sign-in already answered says so instead of "expired or already used"
// (docs/decisions/20261121-google-return-already-answered.md).
//
// Before Google, the desktop app opens GO_PATH: a page of this server that names the Trina person the Drive will
// belong to, then links on to the sign-in page. Its key is random, its hash sealed in the flow; it grants nothing.
import crypto from 'node:crypto'
import { PRODUCT } from '@mycel/shared'

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
