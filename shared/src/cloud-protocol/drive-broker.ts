// Google Drive sign-in broker (control plane `src/drive-broker/`): ONE Google OAuth client, registered once with ONE
// return address on the hosting service's console host, serves every hosted team address (https://<team>.<teamDomain>).
// Google accepts only exact return addresses, so per-team addresses would each need their own registration.
// MIT (see LICENSE in this folder).
//
// NO imports at all, erasable TypeScript only: the team server and the control plane (Bun) load this file as it is.
// The caller computes sha256 itself (node:crypto).
//
// Who holds what:
//   - The control plane holds the Google client secret and an AEAD key. It never keeps a Google token: it keeps a
//     sign-in's `state` (10 minutes) and a handoff (2 minutes), both single use, and nothing else.
//   - The team server keeps the access token and a SEALED refresh token: the control plane encrypts the refresh token
//     with associated data = the team's id, so a sealed token copied from one team is refused for every other team,
//     even through the broker. The team server cannot use it with Google directly (it has no client secret).
//
// Identity: every API call is signed with the team server's relay team key (<data>/relay/team-key.pem, Ed25519, the
// same key the relay and the push gateway know). The control plane accepts a key only when it is the key it recorded
// for a hosted team's primary tenant (enroll), or the key of an enabled REGISTERED server: a self-installed team server
// an operator of the hosting service added by hand with its public key and its exact https origin (the team server
// prints both with `admin.js google-broker-key`). One key is never both. Nothing else is trusted, no first use. No wire
// field differs between the two: only who is served. A registered server's sealed tokens are bound to its registration
// (not to any team), and disabling or removing it makes `status` answer no and every other call refuse at once.
//
// Flow:
//   1. POST {api}/start   (signed) { purpose, returnState, codeChallenge }  → { authorizationUrl, connectUrl?, expiresAt }
//      The team server made `returnState` (its own flow state) and `codeChallenge` = S256(its own verifier).
//      `connectUrl` (optional, newer control planes): the control plane's own page for this sign-in,
//      {console origin}DRIVE_BROKER_CONNECT_PATH?state=<the state sent to Google>. It names the team, explains Google's
//      consent screen and links on to `authorizationUrl`. A team server opens it only when it is exactly that shape on
//      its configured console origin (driveBrokerConnectUrl); otherwise, and on older team servers, the browser goes to
//      `authorizationUrl` directly, as before.
//   2. The browser signs in at Google, which returns to {console origin}DRIVE_BROKER_CALLBACK_PATH?state&code. The
//      control plane sends the browser ONLY to the address of the team that started (from its own records, never from
//      the request): https://<team>.<teamDomain>DRIVE_BROKER_TEAM_RETURN_PATH?state=<returnState>&handoff=<code>
//      (a registered server: its recorded origin + DRIVE_BROKER_TEAM_RETURN_PATH)
//      (or &error=consent_denied | provider_error). No Google token passes through the browser.
//   3. POST {api}/redeem  (signed) { handoff, codeVerifier }  → token answer (below). The handoff works once, only for
//      the team that started, only with the verifier of step 1, within DRIVE_BROKER_HANDOFF_TTL_MS. The control
//      plane exchanges Google's code only now.
//   4. POST {api}/refresh (signed) { refreshToken: <sealed> } → token answer without refresh_token (a new sealed one
//      only when Google rotated it).
//   5. POST {api}/revoke  (signed) { refreshToken: <sealed> } → { revocation: 'revoked' | 'unavailable' }
//   0. POST {api}/status  (signed) {}                        → { ok: true } when the broker serves this team now.
//
// Token answer: Google's own field names, so the team server reads it like Google's token response:
//   { access_token, expires_in, scope, token_type, refresh_token? } — refresh_token is the SEALED value.
//
// Request:  POST, body = JSON (at most DRIVE_BROKER_MAX_BODY_BYTES, strict: unknown keys are refused), header
//           Authorization: TrinaDriveBroker key=<base64 SPKI Ed25519 public key>, ts=<unix ms>, nonce=<22-64 base64url>,
//                          sig=<base64 signature>
//           sig = Ed25519 over driveBrokerSigningString(path, ts, nonce, sha256 hex of the exact body bytes), UTF-8.
//           (Ed25519 is deterministic: the nonce makes two equal requests in the same millisecond two signatures.)
// Replay:   ts within ±DRIVE_BROKER_MAX_SKEW_MS of the control plane clock; the same (key, nonce) is refused twice.
// Errors:   JSON { error: { code, message } } with the status in DRIVE_BROKER_ERRORS. The message never holds a token,
//           a code or a Google response body.

export const DRIVE_BROKER_API_PREFIX = '/api/drive-broker/v1'
export const DRIVE_BROKER_PATHS = {
  status: `${DRIVE_BROKER_API_PREFIX}/status`,
  start: `${DRIVE_BROKER_API_PREFIX}/start`,
  redeem: `${DRIVE_BROKER_API_PREFIX}/redeem`,
  refresh: `${DRIVE_BROKER_API_PREFIX}/refresh`,
  revoke: `${DRIVE_BROKER_API_PREFIX}/revoke`,
} as const
export type DriveBrokerOp = keyof typeof DRIVE_BROKER_PATHS
/** Google's return address on the console host: the ONE address registered at Google */
export const DRIVE_BROKER_CALLBACK_PATH = '/drive-broker/google/callback'
/** the control plane's page that starts a sign-in in the browser (then Google): `connectUrl` of the start answer */
export const DRIVE_BROKER_CONNECT_PATH = '/drive-broker/connect'
/** where the control plane sends the browser back on the team's own address (the team server's Drive callback) */
export const DRIVE_BROKER_TEAM_RETURN_PATH = '/api/integrations/google-drive/callback'
export const DRIVE_BROKER_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
/** where the control plane sends the browser back for a Google app other than Drive (the team server's callback) */
export const GOOGLE_APPS_BROKER_TEAM_RETURN_PATH = '/api/integrations/google-apps/callback'
/**
 * The Google apps the broker signs in to besides Drive, each with its ONE fixed set of scopes (the control plane asks
 * Google for exactly this set and requires all of it in Google's answer). `openid email profile` let the team
 * server's Google Workspace MCP server check whose token it is (Google's userinfo). A start or refresh without `app`
 * is Drive, as before: an older team server never sends it, and an older control plane refuses a request with it
 * (invalid_request), which the team server shows as "not available yet".
 */
const G = 'https://www.googleapis.com/auth/'
const IDENTITY = ['openid', `${G}userinfo.email`, `${G}userinfo.profile`]
export const GOOGLE_APP_BROKER_SCOPES = {
  gmail: [...IDENTITY, `${G}gmail.readonly`, `${G}gmail.send`, `${G}gmail.compose`, `${G}gmail.modify`, `${G}gmail.labels`, `${G}gmail.settings.basic`],
  calendar: [...IDENTITY, `${G}calendar`, `${G}calendar.readonly`, `${G}calendar.events`],
  docs: [...IDENTITY, `${G}documents`, `${G}documents.readonly`, `${G}drive.readonly`, `${G}drive.file`],
  sheets: [...IDENTITY, `${G}spreadsheets`, `${G}spreadsheets.readonly`, `${G}drive.readonly`, `${G}drive.file`],
} as const
export type GoogleBrokerApp = keyof typeof GOOGLE_APP_BROKER_SCOPES
export const GOOGLE_BROKER_APPS = Object.keys(GOOGLE_APP_BROKER_SCOPES) as GoogleBrokerApp[]
export const DRIVE_BROKER_MAX_BODY_BYTES = 16_384
export const DRIVE_BROKER_MAX_SKEW_MS = 60_000
export const DRIVE_BROKER_STATE_TTL_MS = 10 * 60_000
export const DRIVE_BROKER_HANDOFF_TTL_MS = 2 * 60_000

export const DRIVE_BROKER_PURPOSES = ['personal', 'share'] as const
export type DriveBrokerPurpose = (typeof DRIVE_BROKER_PURPOSES)[number]

/** `app`: a Google app other than Drive (only with purpose "personal"); left out: Drive. */
export interface DriveBrokerStart { v: 1; purpose: DriveBrokerPurpose; returnState: string; codeChallenge: string; app?: GoogleBrokerApp }
export interface DriveBrokerRedeem { v: 1; handoff: string; codeVerifier: string }
export interface DriveBrokerRefresh { v: 1; refreshToken: string; app?: GoogleBrokerApp }
export interface DriveBrokerStatus { v: 1 }
export interface DriveBrokerStartAnswer { authorizationUrl: string; connectUrl?: string; expiresAt: string }
export interface DriveBrokerTokenAnswer { access_token: string; expires_in: number; scope: string; token_type: string; refresh_token?: string }
export interface DriveBrokerRevokeAnswer { revocation: 'revoked' | 'unavailable' }

/** Error codes and their HTTP status. */
export const DRIVE_BROKER_ERRORS = {
  /** body is not JSON, too large, or not exactly the request of that path */
  invalid_request: 400,
  /** the handoff is unknown, used, expired, of another team, or the verifier does not match */
  invalid_handoff: 400,
  /** Google refuses the sealed refresh token (revoked, expired, another Google client): sign in again */
  invalid_grant: 400,
  /** Authorization header missing or malformed, the signature does not verify, ts too far off, or a replay */
  unauthorized: 401,
  /** the key is not the key of a hosted team that may use the broker now (unknown, suspended, deleted) */
  not_hosted: 403,
  /** too many calls of this team or this address; try again later */
  rate_limited: 429,
  /** Google failed or answered something unexpected */
  provider_error: 502,
  /** the control plane has no Google Drive client */
  not_configured: 503,
} as const
export type DriveBrokerErrorCode = keyof typeof DRIVE_BROKER_ERRORS

/** a base64url value of 43 characters: 32 random bytes, or an S256 challenge */
const B64URL43 = /^[A-Za-z0-9_-]{43}$/
/** a PKCE verifier (RFC 7636: 43-128 unreserved characters) */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
/** a handoff code: 32 random bytes, base64url */
const HANDOFF = /^[A-Za-z0-9_-]{43}$/
/** a sealed refresh token: "ev1.<key id>.<iv>.<ciphertext>" (base64url parts), opaque to the team server */
const SEALED = /^ev1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{24,8192}$/

const exactly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o)
const plain = (raw: unknown): Record<string, unknown> | null => typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null

/** the optional `app` field: null when absent (Drive), the app, or false when present but not one of the apps */
function parseApp(o: Record<string, unknown> | null): GoogleBrokerApp | null | false {
  if (!o || !('app' in o)) return null
  return typeof o.app === 'string' && (GOOGLE_BROKER_APPS as string[]).includes(o.app) ? o.app as GoogleBrokerApp : false
}

export function parseDriveBrokerStart(raw: unknown): DriveBrokerStart | null {
  const o = plain(raw)
  const app = parseApp(o)
  if (!o || app === false || !exactly(o, ['v', 'purpose', 'returnState', 'codeChallenge', ...(app ? ['app'] : [])]) || o.v !== 1) return null
  if (!(DRIVE_BROKER_PURPOSES as readonly unknown[]).includes(o.purpose)) return null
  if (app && o.purpose !== 'personal') return null
  if (typeof o.returnState !== 'string' || !B64URL43.test(o.returnState)) return null
  if (typeof o.codeChallenge !== 'string' || !B64URL43.test(o.codeChallenge)) return null
  return { v: 1, purpose: o.purpose as DriveBrokerPurpose, returnState: o.returnState, codeChallenge: o.codeChallenge, ...(app ? { app } : {}) }
}

export function parseDriveBrokerRedeem(raw: unknown): DriveBrokerRedeem | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'handoff', 'codeVerifier']) || o.v !== 1) return null
  if (typeof o.handoff !== 'string' || !HANDOFF.test(o.handoff)) return null
  if (typeof o.codeVerifier !== 'string' || !VERIFIER.test(o.codeVerifier)) return null
  return { v: 1, handoff: o.handoff, codeVerifier: o.codeVerifier }
}

export function parseDriveBrokerRefresh(raw: unknown): DriveBrokerRefresh | null {
  const o = plain(raw)
  const app = parseApp(o)
  if (!o || app === false || !exactly(o, ['v', 'refreshToken', ...(app ? ['app'] : [])]) || o.v !== 1) return null
  if (typeof o.refreshToken !== 'string' || !SEALED.test(o.refreshToken)) return null
  return { v: 1, refreshToken: o.refreshToken, ...(app ? { app } : {}) }
}

export function parseDriveBrokerStatus(raw: unknown): DriveBrokerStatus | null {
  const o = plain(raw)
  return o && exactly(o, ['v']) && o.v === 1 ? { v: 1 } : null
}

/** The UTF-8 string the team key signs. path: one of DRIVE_BROKER_PATHS; bodySha256Hex: lower-case hex sha256 of the
 * exact request body bytes. */
export function driveBrokerSigningString(path: string, ts: number, nonce: string, bodySha256Hex: string): string {
  return `trina-drive-broker-v1\nPOST\n${path}\n${ts}\n${nonce}\n${bodySha256Hex}`
}

/** key: base64 SPKI DER of the Ed25519 public key (the relay's team key format); ts: unix ms; nonce: 16+ random bytes,
 * base64url; sig: base64. */
export function driveBrokerAuthorization(key: string, ts: number, nonce: string, sig: string): string {
  return `TrinaDriveBroker key=${key}, ts=${ts}, nonce=${nonce}, sig=${sig}`
}

const AUTH_RE = /^TrinaDriveBroker key=([A-Za-z0-9+/]{1,200}={0,2}), ts=(\d{1,16}), nonce=([A-Za-z0-9_-]{22,64}), sig=([A-Za-z0-9+/]{1,200}={0,2})$/

export function parseDriveBrokerAuthorization(header: string | null | undefined): { key: string; ts: number; nonce: string; sig: string } | null {
  if (typeof header !== 'string' || header.length > 600) return null
  const m = AUTH_RE.exec(header.trim())
  if (!m) return null
  const ts = Number(m[2])
  return Number.isSafeInteger(ts) ? { key: m[1]!, ts, nonce: m[3]!, sig: m[4]! } : null
}

/** The control plane's start page for a sign-in: {origin}DRIVE_BROKER_CONNECT_PATH?state=<state>. */
export function driveBrokerConnectPage(origin: string, state: string): string {
  const u = new URL(origin.replace(/\/+$/, '') + DRIVE_BROKER_CONNECT_PATH)
  u.searchParams.set('state', state)
  return u.href
}

/** `url` when it is exactly the control plane's start page on `origin` (same origin, the path, only a 43-character
 * `state`, no credentials or fragment); otherwise null. A team server checks a start answer's `connectUrl` with it. */
export function driveBrokerConnectUrl(origin: string, url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 512) return null
  let u: URL, o: URL
  try { u = new URL(url); o = new URL(origin) } catch { return null }
  if (u.origin !== o.origin || u.username || u.password || u.hash || u.pathname !== DRIVE_BROKER_CONNECT_PATH) return null
  const keys = [...u.searchParams.keys()]
  if (keys.length !== 1 || keys[0] !== 'state' || !B64URL43.test(u.searchParams.get('state') ?? '')) return null
  return u.href
}

/** The team's return address for a sign-in: only ever built from the team's own address (the control plane's records:
 * https://<team>.<teamDomain>; a dev control plane's team address may have a path, which is kept). */
export function driveBrokerReturnUrl(teamAddress: string, returnState: string, result: { handoff: string } | { error: 'consent_denied' | 'provider_error' }): string {
  const u = new URL(teamAddress.replace(/\/+$/, '') + DRIVE_BROKER_TEAM_RETURN_PATH)
  u.searchParams.set('state', returnState)
  if ('handoff' in result) u.searchParams.set('handoff', result.handoff)
  else u.searchParams.set('error', result.error)
  return u.href
}
