// Sign in with Google through the hosting service (control plane `src/google-signin/`): ONE Google OAuth client,
// registered once with ONE return address on the hosting service's console host, signs people in to every hosted team
// address (https://<team>.<teamDomain>) that has no Google client of its own. Google accepts only exact return
// addresses, so per-team addresses would each need their own registration.
// MIT (see LICENSE in this folder).
//
// NO imports at all, erasable TypeScript only: the team server and the control plane (Bun) load this file as it is.
// The caller does the cryptography itself (node:crypto): sha256, Ed25519.
//
// Who decides who signed in: the TEAM SERVER, never the control plane. The control plane hands back Google's raw
// id_token, unchanged, and the team server checks it itself: Google's RS256 signature (GOOGLE_SIGNIN_CERTS_URL),
// `iss` (GOOGLE_SIGNIN_ISSUERS), `aud` = the client id the start answered, `azp`, `exp`, `nonce` = the nonce the team
// server chose for this flow, `email_verified`. So the control plane can relay a sign-in but cannot invent one.
//
// Who holds what:
//   - The control plane holds the Google client secret. It keeps a sign-in's `state` (10 minutes) and a handoff
//     (2 minutes), both single use, and nothing after the redeem: no id_token, no access token, no refresh token (it
//     never asks offline access). The access token in Google's answer is dropped at once.
//   - The team server keeps nothing from Google but the identity it matched (Google's `sub`).
//
// Identity: every API call is signed with the team server's relay team key (<data>/relay/team-key.pem, Ed25519), the
// same key the Drive and Slack brokers know. The control plane accepts only the key it recorded for a HOSTED team's
// primary tenant (enroll); a self-installed server is not served in this version. The signing string has its own
// prefix (domain separation): a Drive or Slack broker signature never verifies here, nor the other way round.
//
// Flow (all POST {api}/…, signed, JSON):
//   0. status  { v }                                   → { ok: true, clientId } when the control plane serves this team
//   1. start   { v, returnState, codeChallenge, nonce } → { authorizationUrl, clientId, expiresAt }
//      The team server made `returnState` (its own flow state), `codeChallenge` = S256(its own verifier) and `nonce`
//      (its own, 32 random bytes). `authorizationUrl` is Google's page (GOOGLE_SIGNIN_AUTHORIZE_URL) with `clientId`,
//      scopes GOOGLE_SIGNIN_SCOPES, prompt=select_account, no offline access, the ONE return address
//      ({console origin}GOOGLE_SIGNIN_CALLBACK_PATH), the control plane's own state and its own PKCE challenge, and the
//      team server's `nonce`. The team server checks it with googleSigninAuthorizeUrl before it sends a browser there.
//   2. The browser signs in at Google, which returns to {console origin}GOOGLE_SIGNIN_CALLBACK_PATH?state&code. The
//      control plane sends the browser ONLY to the address of the team that started (its own records, never the
//      request): https://<team>.<teamDomain>GOOGLE_SIGNIN_TEAM_RETURN_PATH?state=<returnState>&handoff=<one-time>
//      (or &error=consent_denied | provider_error). No Google token passes through the browser.
//   3. redeem  { v, handoff, codeVerifier }            → { idToken }
//      The handoff works once, only for the team that started, only with the verifier of step 1, within
//      GOOGLE_SIGNIN_HANDOFF_TTL_MS. The control plane exchanges Google's code only now and answers Google's id_token
//      exactly as Google sent it.
//
// Request:  POST, body = JSON (at most GOOGLE_SIGNIN_MAX_BODY_BYTES, strict: unknown keys are refused), header
//           Authorization: TrinaGoogleSignin key=<base64 SPKI Ed25519 public key>, ts=<unix ms>, nonce=<22-64 base64url>,
//                          sig=<base64 signature>
//           sig = Ed25519 over googleSigninSigningString(path, ts, nonce, sha256 hex of the exact body bytes), UTF-8.
//           (The header's nonce is the request's replay guard, not the OpenID Connect nonce of the body.)
// Replay:   ts within ±GOOGLE_SIGNIN_MAX_SKEW_MS of the control plane clock; the same (key, nonce) is refused twice.
// Errors:   JSON { error: { code, message } } with the status in GOOGLE_SIGNIN_ERRORS. The message never holds a token,
//           a code, a nonce, a handoff or a Google response body.

export const GOOGLE_SIGNIN_API_PREFIX = '/api/google-signin/v1'
export const GOOGLE_SIGNIN_PATHS = {
  status: `${GOOGLE_SIGNIN_API_PREFIX}/status`,
  start: `${GOOGLE_SIGNIN_API_PREFIX}/start`,
  redeem: `${GOOGLE_SIGNIN_API_PREFIX}/redeem`,
} as const
export type GoogleSigninOp = keyof typeof GOOGLE_SIGNIN_PATHS
/** Google's return address on the console host: the ONE address registered at Google for this client */
export const GOOGLE_SIGNIN_CALLBACK_PATH = '/google-signin/callback'
/** where the control plane sends the browser back on the team's own address (the team server's raw route) */
export const GOOGLE_SIGNIN_TEAM_RETURN_PATH = '/api/auth/google/return'
/** Google's sign-in page (the team server checks `authorizationUrl` against it) */
export const GOOGLE_SIGNIN_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
/** Google's signing keys for id_tokens (JWKS) */
export const GOOGLE_SIGNIN_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
/** the id_token's `iss`, as Google documents it (both forms occur) */
export const GOOGLE_SIGNIN_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const
/** identity only: no sensitive or restricted scope, no offline access */
export const GOOGLE_SIGNIN_SCOPES = 'openid email profile'
export const GOOGLE_SIGNIN_MAX_BODY_BYTES = 16_384
export const GOOGLE_SIGNIN_MAX_SKEW_MS = 60_000
export const GOOGLE_SIGNIN_STATE_TTL_MS = 10 * 60_000
export const GOOGLE_SIGNIN_HANDOFF_TTL_MS = 2 * 60_000
/** an id_token longer than this is refused on both sides */
export const GOOGLE_SIGNIN_ID_TOKEN_MAX = 8192

export interface GoogleSigninStatus { v: 1 }
export interface GoogleSigninStart { v: 1; returnState: string; codeChallenge: string; nonce: string }
export interface GoogleSigninRedeem { v: 1; handoff: string; codeVerifier: string }
export interface GoogleSigninStatusAnswer { ok: true; clientId: string }
export interface GoogleSigninStartAnswer { authorizationUrl: string; clientId: string; expiresAt: string }
export interface GoogleSigninRedeemAnswer { idToken: string }

/** Error codes and their HTTP status. */
export const GOOGLE_SIGNIN_ERRORS = {
  /** body is not JSON, too large, or not exactly the request of that path */
  invalid_request: 400,
  /** the handoff is unknown, used, expired, of another team, or the verifier does not match */
  invalid_handoff: 400,
  /** Authorization header missing or malformed, the signature does not verify, ts too far off, or a replay */
  unauthorized: 401,
  /** the key is not the key of a hosted team served now (unknown, suspended, deleted, a self-installed server) */
  not_hosted: 403,
  /** too many calls of this team or this address; try again later */
  rate_limited: 429,
  /** Google failed or answered something unexpected (no id_token). 503, not 502: Cloudflare, in front of the console
   * host, replaces an origin's 502 and 504 with its own page, and the team server could not read the code. */
  provider_error: 503,
  /** the control plane has no Google sign-in client */
  not_configured: 503,
} as const
export type GoogleSigninErrorCode = keyof typeof GOOGLE_SIGNIN_ERRORS

/** a base64url value of 43 characters: 32 random bytes (a state, a handoff, a nonce), or an S256 challenge */
const B64URL43 = /^[A-Za-z0-9_-]{43}$/
/** a PKCE verifier (RFC 7636: 43-128 unreserved characters) */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
/** a Google OAuth client id ("<number>-<letters>.apps.googleusercontent.com") */
export const GOOGLE_SIGNIN_CLIENT_ID = /^[A-Za-z0-9-]{1,128}\.apps\.googleusercontent\.com$/
/** a JWT: three base64url parts */
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

const exactly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o)
const plain = (raw: unknown): Record<string, unknown> | null => typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null
const b43 = (v: unknown): v is string => typeof v === 'string' && B64URL43.test(v)

export function parseGoogleSigninStatus(raw: unknown): GoogleSigninStatus | null {
  const o = plain(raw)
  return o && exactly(o, ['v']) && o.v === 1 ? { v: 1 } : null
}

export function parseGoogleSigninStart(raw: unknown): GoogleSigninStart | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'returnState', 'codeChallenge', 'nonce']) || o.v !== 1) return null
  if (!b43(o.returnState) || !b43(o.codeChallenge) || !b43(o.nonce)) return null
  return { v: 1, returnState: o.returnState, codeChallenge: o.codeChallenge, nonce: o.nonce }
}

export function parseGoogleSigninRedeem(raw: unknown): GoogleSigninRedeem | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'handoff', 'codeVerifier']) || o.v !== 1) return null
  if (!b43(o.handoff) || typeof o.codeVerifier !== 'string' || !VERIFIER.test(o.codeVerifier)) return null
  return { v: 1, handoff: o.handoff, codeVerifier: o.codeVerifier }
}

/** A status answer as the team server reads it; null when it is not one (then the broker does not serve it). */
export function parseGoogleSigninStatusAnswer(raw: unknown): GoogleSigninStatusAnswer | null {
  const o = plain(raw)
  if (!o || o.ok !== true || typeof o.clientId !== 'string' || !GOOGLE_SIGNIN_CLIENT_ID.test(o.clientId)) return null
  return { ok: true, clientId: o.clientId }
}

/** A redeem answer as the team server reads it: an id_token shaped like a JWT, else null. Its content is checked by
 * the team server (signature and claims), never trusted from here. */
export function parseGoogleSigninRedeemAnswer(raw: unknown): GoogleSigninRedeemAnswer | null {
  const o = plain(raw)
  if (!o || typeof o.idToken !== 'string' || o.idToken.length > GOOGLE_SIGNIN_ID_TOKEN_MAX || !JWT.test(o.idToken)) return null
  return { idToken: o.idToken }
}

/** The UTF-8 string the team key signs. path: one of GOOGLE_SIGNIN_PATHS; bodySha256Hex: lower-case hex sha256 of
 * the exact request body bytes. */
export function googleSigninSigningString(path: string, ts: number, nonce: string, bodySha256Hex: string): string {
  return `trina-google-signin-v1\nPOST\n${path}\n${ts}\n${nonce}\n${bodySha256Hex}`
}

/** key: base64 SPKI DER of the Ed25519 public key (the relay's team key format); ts: unix ms; nonce: 16+ random bytes,
 * base64url; sig: base64. */
export function googleSigninAuthorization(key: string, ts: number, nonce: string, sig: string): string {
  return `TrinaGoogleSignin key=${key}, ts=${ts}, nonce=${nonce}, sig=${sig}`
}

const AUTH_RE = /^TrinaGoogleSignin key=([A-Za-z0-9+/]{1,200}={0,2}), ts=(\d{1,16}), nonce=([A-Za-z0-9_-]{22,64}), sig=([A-Za-z0-9+/]{1,200}={0,2})$/

export function parseGoogleSigninAuthorization(header: string | null | undefined): { key: string; ts: number; nonce: string; sig: string } | null {
  if (typeof header !== 'string' || header.length > 600) return null
  const m = AUTH_RE.exec(header.trim())
  if (!m) return null
  const ts = Number(m[2])
  return Number.isSafeInteger(ts) ? { key: m[1]!, ts, nonce: m[3]!, sig: m[4]! } : null
}

/** The team's return address: only ever built from the team's own address (the control plane's records:
 * https://<team>.<teamDomain>; a dev control plane's team address may have a path, which is kept). */
export function googleSigninReturnUrl(teamAddress: string, returnState: string, result: { handoff: string } | { error: 'consent_denied' | 'provider_error' }): string {
  const u = new URL(teamAddress.replace(/\/+$/, '') + GOOGLE_SIGNIN_TEAM_RETURN_PATH)
  u.searchParams.set('state', returnState)
  if ('handoff' in result) u.searchParams.set('handoff', result.handoff)
  else u.searchParams.set('error', result.error)
  return u.href
}

/** `url` when it is Google's sign-in page for exactly this flow: https://accounts.google.com/o/oauth2/v2/auth, no
 * credentials or fragment, `client_id` = clientId, `nonce` = the team server's nonce, `scope` = GOOGLE_SIGNIN_SCOPES,
 * `response_type=code`, `redirect_uri` = {origin}GOOGLE_SIGNIN_CALLBACK_PATH (Google returns to the console that
 * answered), a 43-character `state`, an S256 `code_challenge`, and no offline access; otherwise null. A team server checks
 * a start answer with it before it sends a person's browser anywhere. */
export function googleSigninAuthorizeUrl(url: unknown, o: { origin: string; clientId: string; nonce: string }): string | null {
  if (typeof url !== 'string' || url.length > 4096) return null
  let u: URL, want: URL
  try { u = new URL(url); want = new URL(GOOGLE_SIGNIN_AUTHORIZE_URL) } catch { return null }
  if (u.origin !== want.origin || u.pathname !== want.pathname || u.username || u.password || u.hash) return null
  const q = u.searchParams
  let callback: string
  try { callback = new URL(o.origin.replace(/\/+$/, '') + GOOGLE_SIGNIN_CALLBACK_PATH).href } catch { return null }
  if (q.get('client_id') !== o.clientId || !GOOGLE_SIGNIN_CLIENT_ID.test(o.clientId) || q.get('nonce') !== o.nonce || !b43(o.nonce)) return null
  if (q.get('scope') !== GOOGLE_SIGNIN_SCOPES || q.get('response_type') !== 'code' || q.get('redirect_uri') !== callback) return null
  if (!b43(q.get('state')) || !b43(q.get('code_challenge')) || q.get('code_challenge_method') !== 'S256') return null
  if (q.has('access_type') && q.get('access_type') !== 'online') return null
  return u.href
}
