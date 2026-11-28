// The AI's browser in the person's own Chrome (docs/decisions/20261128-trina-in-chrome.md). An extension the person
// links to this team (chrome-extension/) gets the browser tools' calls over its own WebSocket (CHROME_WS_PATH) instead
// of a desktop window, with the same BrowserCall / BrowserResult contract (shared/src/api/browser.ts). Owner: B
// (server/src/chrome/, routes/chrome.ts).
import { z } from 'zod'
import { BrowserResult, BrowserCall } from './browser'
import { Locale } from './common'
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

export const ChromeLinkLabel = z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f\u007f\u2028\u2029]+$/)
/** the Google account a browser profile is signed in to (chrome.identity), as the extension read it */
export const ChromeLinkEmail = z.string().trim().max(254).regex(/^[^\s@<>"]+@[^\s@<>"]+$/)
/** what the extension runs in: "Chrome on Mac", "Edge on Windows" */
export const ChromeBrowserName = z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f\u007f<>"]+$/)
export const ChromeLink = z.object({
  id: z.string(),
  /** the profile's name (the person's, else its account's email, else "Chrome on Mac") */
  label: z.string(),
  /** the Google account the profile is signed in to, when the extension could read it */
  email: z.string().nullable(),
  /** "Chrome on Mac" */
  browser: z.string().nullable(),
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
  email: ChromeLinkEmail.optional(),
  browser: ChromeBrowserName.optional(),
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
  z.object({ type: z.literal('hello'), linkId: z.string(), /** the profile's name as the team lists it (renamed in Settings) */ label: z.string().optional(), user: z.object({ name: z.string(), username: z.string() }), team: z.object({ name: z.string() }), teamHosts: z.array(z.string().max(260)).max(50), pingIntervalMs: z.number().int().positive(), /** the server's clock (epoch ms): a call's deadline is in it */ serverTime: z.number(),
    /** the person's language (their own, else the team's): the popup and pages speak it, not only the browser's */
    locale: Locale.optional(),
    /** this server handles run.stopped for every run (a chat's too: its answer stops and the AI asks what next); without
     * it the extension reports only `mcp:` runs (an older server closes the socket on a frame it does not know) */
    runStops: z.boolean().optional() }),
  z.object({ type: z.literal('browser.call'), call: BrowserCall }),
  z.object({ type: z.literal('browser.cancel'), callId: z.string() }),
  z.object({ type: z.literal('pong'), t: z.number() }),
  /** the person renamed this profile in Settings › Browser */
  z.object({ type: z.literal('label'), label: z.string() }),
])
export type ChromeServerFrame = z.infer<typeof ChromeServerFrame>
/** extension -> server */
export const ChromeClientFrame = z.discriminatedUnion('type', [
  /** the first frame, within CHROME_AUTH_WAIT_MS */
  z.object({ type: z.literal('auth'), token: ChromeSecret, version: z.string().max(40).optional()}),
  z.object({ type: z.literal('ping'), t: z.number() }),
  z.object({ type: z.literal('browser.ack'), callId: z.string().min(1).max(100) }),
  z.object({ type: z.literal('browser.result'), result: BrowserResult }),
  /** the person renamed this profile in the popup */
  z.object({ type: z.literal('label'), label: ChromeLinkLabel }),
  /** the person pressed Disconnect in the extension: the link ends */
  z.object({ type: z.literal('unlink') }),
  /** the person stopped a run (the popup's Stop, closing its window or the debugging bar): an MCP app's connection pauses
   * its browser calls (docs/decisions/20261128-mcp-browser-tools.md); a chat's running answer stops and asks what next.
   * Sent for `mcp:` runs (only a server that knows this frame makes them) and, when hello said `runStops`, for every run */
  z.object({ type: z.literal('run.stopped'), runId: z.string().min(1).max(100) }),
])
export type ChromeClientFrame = z.infer<typeof ChromeClientFrame>
/** close codes: the token is unknown or revoked (the extension forgets it), replaced by a newer connection of the same link */
export const ChromeWsClose = { revoked: 4401, replaced: 4409, badRequest: 4400 } as const

/** A question a person's own MCP app (Claude Code, Codex, Claude) needs them to answer for their browser profiles
 * (docs/decisions/20261128-mcp-browser-tools.md): the page /browser-ask/:id shows it; the app never decides. */
export const BROWSER_ASK_PATH = '/browser-ask'
export const BrowserAskView = z.object({
  id: z.string(),
  /** the app as Settings › <app> MCP shows it */
  client: z.object({ name: z.string(), connectedAt: z.string(), connectionId: z.string() }),
  profile: z.string(),
  host: z.string(),
  /** the full address */
  url: z.string(),
  /** site: a site nobody allowed in that profile; address: an address that is not plain (a long query, random-looking
   * parts, a user name); office: an office-network address */
  kind: z.enum(['site', 'address', 'office']),
  /** Always allow is offered (it keeps this site for that profile) */
  always: z.boolean(),
  site: z.string().nullable(),
  expiresAt: z.string(),
})
export type BrowserAskView = z.infer<typeof BrowserAskView>
export const BrowserAskDecision = z.enum(['once', 'always', 'no'])

export const CHROME = {
  chromeLinks: endpoint({ method: 'GET', path: '/api/chrome/links', auth: 'user', owner: 'B', response: z.object({ links: z.array(ChromeLink) }), summary: 'The browser profiles (Chrome, Edge, Brave) this person linked to the team, each with its name, state and site rules. Every turn of theirs may use them (in the desktop app next to its own browser): the AI picks one per step.' }),
  chromeUnlink: endpoint({ method: 'DELETE', path: '/api/chrome/links/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Disconnect one of this person\'s Chromes: its token stops working and its connection closes at once. 404: not theirs.' }),
  chromeUpdateLink: endpoint({ method: 'PATCH', path: '/api/chrome/links/:id', auth: 'user', owner: 'B', body: z.strictObject({ label: ChromeLinkLabel.optional(), onlyListed: z.boolean().optional(), addSite: ChromeSite.optional(), removeSite: ChromeSite.optional() }), response: ChromeLink, summary: 'Rename one of this person\'s browser profiles, limit it to its site list, or add or remove a site the AI may use there without asking. 404: not theirs.' }),
  chromePair: endpoint({ method: 'POST', path: '/api/chrome/pair', auth: 'user', owner: 'B', body: z.strictObject({ challenge: ChromeSecret }), response: z.object({ code: ChromeSecret, expiresAt: z.string() }), summary: 'The signed-in team page in Chrome (/connect-chrome) makes a one-time code for the extension that opened it (bound to its challenge, 5 minutes); the page puts it only in the fragment of /connect-chrome/done. Cookie sessions only; a guest: 403.' }),
  chromeRedeem: endpoint({ method: 'POST', path: '/api/chrome/redeem', auth: 'public', owner: 'B', body: ChromeRedeemBody, response: ChromeRedeemed, summary: 'The extension spends a code with its verifier for a link token (only its sha256 is kept): one more browser profile of the person (`previous`: the one this install held is replaced). Past CHROME_LINKS_MAX: 409 links_full, nothing removed. Wrong, used or expired: 410; failures are counted per address.' }),
  browserAsk: endpoint({ method: 'GET', path: '/api/chrome/asks/:id', auth: 'user', owner: 'B', response: BrowserAskView, summary: 'A question one of this person\'s own MCP apps needs answered in their browser profile (a site, an address, an office address). Only the person it is for; another person\'s, an answered or an expired one: 404.' }),
  browserAskDecide: endpoint({ method: 'POST', path: '/api/chrome/asks/:id', auth: 'user', owner: 'B', body: z.strictObject({ decision: BrowserAskDecision }), response: empty, status: 204, summary: 'Answer it: once (this app, 10 minutes), always (kept for that profile, as the site card\'s Always) or no. 404 as for GET.' }),
  chromeUpload: endpoint({ method: 'GET', path: '/api/chrome/uploads/:ticket', auth: 'public', owner: 'B', response: stream(false), summary: 'One file of a file_upload call for the person\'s linked Chrome (Authorization: Bearer <link token>; single use, the person\'s own ticket; every failure is 404).' }),
} as const

