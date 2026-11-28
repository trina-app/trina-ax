// The AI's browser in the person's own Chrome (docs/decisions/20261128-trina-in-chrome.md). An extension the person
// links to this team (chrome-extension/) gets the browser tools' calls over its own WebSocket (CHROME_WS_PATH) instead
// of a desktop window, with the same BrowserCall / BrowserResult contract (shared/src/api/browser.ts). Owner: B
// (server/src/chrome/, routes/chrome.ts).
import { z } from 'zod'
import { BrowserResult, BrowserCall } from './browser'
import { endpoint, empty, stream } from './endpoint'

/** the extension's live connection: subprotocols CHROME_WS_PROTOCOL and CHROME_TOKEN_PREFIX + token */
export const CHROME_WS_PATH = '/api/chrome/ws'
export const CHROME_WS_PROTOCOL = 'mycel.chrome.v1'
/** the first frame must come this soon (it carries the token) */
export const CHROME_AUTH_WAIT_MS = 5000
/** the team page that links a Chrome signed in to the team (`?challenge=`) and the page it moves to with the code in its fragment */
export const CHROME_CONNECT_PATH = '/connect-chrome'
export const CHROME_CONNECT_DONE_PATH = '/connect-chrome/done'
/** a link token, a code, the extension's verifier and its challenge (base64url sha256 of the verifier): 32 bytes, base64url */
export const ChromeSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
/** an unused link ends after this long */
export const CHROME_LINK_IDLE_DAYS = 30
/** a code lives this long */
export const CHROME_CODE_TTL_MS = 5 * 60_000

/** Where a desktop-app turn's browser runs: the app's own pane (default) or the person's Chrome. The web always uses an
 * online Chrome. */
export const BrowserTarget = z.enum(['app', 'chrome'])
export type BrowserTarget = z.infer<typeof BrowserTarget>

export const ChromeLinkLabel = z.string().trim().min(1).max(60)
export const ChromeLink = z.object({
  id: z.string(),
  /** what the extension calls itself ("Chrome on Mac") */
  label: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  /** connected now */
  online: z.boolean(),
  version: z.string().nullable(),
  /** the sites the AI may use in this profile without asking (its Always answers and the ones the person added) */
  sites: z.array(z.string()),
  /** the person limited this profile to `sites`: anything else is refused there, never asked */
  onlyListed: z.boolean(),
})
export type ChromeLink = z.infer<typeof ChromeLink>
/** a person links at most this many browser profiles */
export const CHROME_LINKS_MAX = 20
export const ChromeSite = z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/)

export const ChromeRedeemBody = z.strictObject({
  code: ChromeSecret,
  /** the secret whose sha256 (base64url) was the challenge the team page made the code for (PKCE) */
  verifier: ChromeSecret,
  label: ChromeLinkLabel,
  version: z.string().max(40).regex(/^[0-9A-Za-z.+-]+$/),
  /** the link token this install already holds, if any: that one link is replaced (not a second row for one profile) */
  previous: ChromeSecret.optional(),
})
export const ChromeRedeemed = z.object({
  token: ChromeSecret,
  linkId: z.string(),
  /** whose AI drives this Chrome from now on, and in which team (the popup shows it) */
  user: z.object({ name: z.string(), username: z.string() }),
  team: z.object({ name: z.string() }),
  /** every host name of this team (its address, office and relay names): the extension never opens or sends to them */
  teamHosts: z.array(z.string().max(260)).max(50),
})
export type ChromeRedeemed = z.infer<typeof ChromeRedeemed>

// ---------------- the extension's WebSocket ----------------
/** server -> extension */
export const ChromeServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), linkId: z.string(), user: z.object({ name: z.string(), username: z.string() }), team: z.object({ name: z.string() }), teamHosts: z.array(z.string().max(260)).max(50), pingIntervalMs: z.number().int().positive(), /** the server's clock (epoch ms): a call's deadline is in it */ serverTime: z.number() }),
  z.object({ type: z.literal('browser.call'), call: BrowserCall }),
  z.object({ type: z.literal('browser.cancel'), callId: z.string() }),
  z.object({ type: z.literal('pong'), t: z.number() }),
])
export type ChromeServerFrame = z.infer<typeof ChromeServerFrame>
/** extension -> server */
export const ChromeClientFrame = z.discriminatedUnion('type', [
  /** the first frame, within CHROME_AUTH_WAIT_MS */
  z.object({ type: z.literal('auth'), token: ChromeSecret, version: z.string().max(40).optional() }),
  z.object({ type: z.literal('ping'), t: z.number() }),
  z.object({ type: z.literal('browser.ack'), callId: z.string().min(1).max(100) }),
  z.object({ type: z.literal('browser.result'), result: BrowserResult }),
  /** the person pressed Disconnect in the extension: the link ends */
  z.object({ type: z.literal('unlink') }),
])
export type ChromeClientFrame = z.infer<typeof ChromeClientFrame>
/** close codes: the token is unknown or revoked (the extension forgets it), replaced by a newer connection of the same link */
export const ChromeWsClose = { revoked: 4401, replaced: 4409, badRequest: 4400 } as const

export const CHROME = {
  chromeLinks: endpoint({ method: 'GET', path: '/api/chrome/links', auth: 'user', owner: 'B', response: z.object({ links: z.array(ChromeLink), target: BrowserTarget }), summary: 'The browser profiles (Chrome, Edge, Brave) this person linked to the team, each with its name, state and site rules, and where a desktop-app turn\'s browser runs.' }),
  chromeUnlink: endpoint({ method: 'DELETE', path: '/api/chrome/links/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Disconnect one of this person\'s Chromes: its token stops working and its connection closes at once. 404: not theirs.' }),
  chromeUpdateLink: endpoint({ method: 'PATCH', path: '/api/chrome/links/:id', auth: 'user', owner: 'B', body: z.strictObject({ label: ChromeLinkLabel.optional(), onlyListed: z.boolean().optional(), addSite: ChromeSite.optional(), removeSite: ChromeSite.optional() }), response: ChromeLink, summary: 'Rename one of this person\'s browser profiles, limit it to its site list, or add or remove a site the AI may use there without asking. 404: not theirs.' }),
  chromeTarget: endpoint({ method: 'PUT', path: '/api/chrome/target', auth: 'user', owner: 'B', body: z.strictObject({ target: BrowserTarget }), response: empty, status: 204, summary: 'Where a desktop-app turn\'s browser runs: the app\'s own browser (app) or the person\'s Chrome (chrome).' }),
  chromePair: endpoint({ method: 'POST', path: '/api/chrome/pair', auth: 'user', owner: 'B', body: z.strictObject({ challenge: ChromeSecret }), response: z.object({ code: ChromeSecret, expiresAt: z.string() }), summary: 'The signed-in team page in Chrome (/connect-chrome) makes a one-time code for the extension that opened it (bound to its challenge, 5 minutes); the page puts it only in the fragment of /connect-chrome/done. Cookie sessions only; a guest: 403.' }),
  chromeRedeem: endpoint({ method: 'POST', path: '/api/chrome/redeem', auth: 'public', owner: 'B', body: ChromeRedeemBody, response: ChromeRedeemed, summary: 'The extension spends a code with its verifier for a link token (only its sha256 is kept): one more browser profile of the person (`previous`: the one this install held is replaced). Past CHROME_LINKS_MAX: 409 links_full, nothing removed. Wrong, used or expired: 410; failures are counted per address.' }),
  chromeUpload: endpoint({ method: 'GET', path: '/api/chrome/uploads/:ticket', auth: 'public', owner: 'B', response: stream(false), summary: 'One file of a file_upload call for the person\'s linked Chrome (Authorization: Bearer <link token>; single use, the person\'s own ticket; every failure is 404).' }),
} as const

