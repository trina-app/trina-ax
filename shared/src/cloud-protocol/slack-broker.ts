// Slack broker (control plane `src/slack-broker/`): ONE official Slack app ("Trina AX", public distribution) serves every
// hosted team and every self-installed server the hosting service registered, so no team makes its own Slack app or
// copies a token by hand. A team server without a connection to the hosting service keeps its own app (docs/SLACK.md).
// MIT (see LICENSE in this folder).
//
// NO imports at all, erasable TypeScript only: the team server and the control plane (Bun) load this file as it is.
// The caller does the cryptography itself (node:crypto): sha256, Ed25519 signatures, X25519, HKDF and AES-GCM, exactly
// as written below; the test vectors are in tests on both sides.
//
// Who holds what:
//   - The control plane holds the app's client secret and the app-level token (Socket Mode, connections:write). The
//     app-level token is APP-WIDE: its connection receives the events of EVERY workspace the app is installed in. It
//     never leaves the control plane, and neither does the client secret.
//   - The control plane holds ONE Socket Mode connection, acknowledges each envelope to Slack at once, and queues it
//     for the one owner (a hosted team or a registered server) that installed the app in the envelope's workspace
//     (`team_id`). An envelope of a workspace nobody here installed, of another app, or one whose routing fields do not
//     agree, goes nowhere. Per-workspace isolation is the core property: an owner only ever receives the envelopes of
//     the workspace it installed.
//   - Each workspace's bot token (xoxb) is kept SEALED at rest by the control plane (bound to the install and its
//     owner) and handed only to that owner, sealed in transit to a one-time X25519 key the owner made for that very
//     request (so it is not readable by a TLS-terminating proxy either). The owner keeps it sealed at rest, and posts
//     its answers to Slack itself with it (chat.postMessage, response_url), never through the control plane.
//
// Identity: every API call is signed with the team server's relay team key, exactly as for the Drive broker
// (drive-broker.ts): the key of a hosted team's primary tenant, or of an ENABLED registered server. The signing string
// differs (domain separation): a Drive broker signature never verifies here, nor the other way round.
//
// Flows (all POST {api}/…, signed, JSON):
//   0. status          {}                                   → { ok, appId, install | null }
//   1. install         { returnState, codeChallenge }       → { authorizationUrl, expiresAt }
//      `authorizationUrl` is Slack's "Add to Slack" page (https://slack.com/oauth/v2/authorize) with the app's client id,
//      the bot scopes and the ONE redirect URL (SLACK_BROKER_REDIRECT_PATH on the console host). Slack returns the
//      browser there; the control plane sends it ONLY to the address of the owner that started (its own records, never
//      the request): {owner}SLACK_BROKER_TEAM_INSTALL_RETURN_PATH?state=<returnState>&handoff=<one-time>
//      (or &error=consent_denied | provider_error). Slack's code is exchanged only at redeem.
//   2. redeem          { handoff, codeVerifier, sealKey }   → { install, token }
//      The handoff works once, only for the owner that started, only with the verifier of step 1, within
//      SLACK_BROKER_HANDOFF_TTL_MS. Refused (and nothing is stored or handed out) when the workspace is installed for
//      another owner that is still served (`workspace_taken`), an organization-wide install (`enterprise_install`), a
//      grant without every bot scope (`missing_scope`).
//   3. token           { sealKey }                          → { install, token }    the same bot token again (a restore)
//   4. poll            { ack, waitMs }                      → { install | null, events }
//      Long poll: answered at once when an envelope is queued for this owner, else after `waitMs` (at most
//      SLACK_BROKER_POLL_MAX_WAIT_MS) with no events. `ack`: the ids of events this owner has taken (they are deleted).
//      An event handed out and not acknowledged comes again after SLACK_BROKER_LEASE_MS (at least once; the team server
//      handles an event id once). Events wait at most SLACK_BROKER_EVENT_TTL_MS, and only while the owner polled in the
//      last SLACK_BROKER_OFFLINE_MS (a server that stopped polling gets nothing queued).
//   5. uninstall       {}                                   → { slack: 'removed' | 'unavailable' }
//      The control plane removes the app from the workspace (apps.uninstall) and forgets the install and its token.
//   6. signin/start    { returnState, codeChallenge }       → { authorizationUrl, expiresAt }
//      "Sign in with Slack" (OpenID Connect) with the official app, to link a person's own Slack account: only for the
//      owner's installed workspace (`team` in Slack's URL), the same one redirect URL, and back on the owner's address
//      SLACK_BROKER_TEAM_SIGNIN_RETURN_PATH?state=<returnState>&handoff=<one-time> (or &error=…).
//   7. signin/redeem   { handoff, codeVerifier }            → { slackUserId, slackTeamId, enterpriseId }
//      The control plane exchanges the code (openid.connect.token), checks the id_token (issuer, audience, time, nonce,
//      and that it names the owner's installed workspace), revokes the person's user token at once and answers only
//      who signed in. No user token ever leaves the control plane.
//
// Request:  POST, body = JSON (at most SLACK_BROKER_MAX_BODY_BYTES, strict: unknown keys are refused), header
//           Authorization: TrinaSlackBroker key=<base64 SPKI Ed25519 public key>, ts=<unix ms>, nonce=<22-64 base64url>,
//                          sig=<base64 signature>
//           sig = Ed25519 over slackBrokerSigningString(path, ts, nonce, sha256 hex of the exact body bytes), UTF-8.
// Replay:   ts within ±SLACK_BROKER_MAX_SKEW_MS of the control plane clock; the same (key, nonce) is refused twice.
// Errors:   JSON { error: { code, message } } with the status in SLACK_BROKER_ERRORS. The message never holds a token,
//           a code, an event or a Slack response body.
//
// Sealed bot token (SlackBrokerSealedToken), `alg` SLACK_BROKER_SEAL_ALG:
//   The team server makes a fresh X25519 key pair for each redeem or token request and sends its raw public key
//   (32 bytes, base64url) as `sealKey`; the request is signed, so the key is bound to this owner. The control plane
//   makes its own fresh X25519 pair (raw public key = `epk`) and computes
//     shared = X25519(its private key, sealKey)
//     key    = HKDF-SHA256(ikm = shared, salt = epk raw bytes ‖ sealKey raw bytes, info = SLACK_BROKER_SEAL_INFO, 32 bytes)
//     ct     = AES-256-GCM(key, iv = 12 random bytes, plaintext = the bot token (UTF-8),
//                          additional data = slackBrokerSealAad(install.installId, install.teamId)) ‖ the 16-byte tag
//   and answers { alg, epk, iv, ct } (base64url). The team server opens it with its private key and forgets that key.

export const SLACK_BROKER_API_PREFIX = '/api/slack-broker/v1'
export const SLACK_BROKER_PATHS = {
  status: `${SLACK_BROKER_API_PREFIX}/status`,
  install: `${SLACK_BROKER_API_PREFIX}/install`,
  redeem: `${SLACK_BROKER_API_PREFIX}/redeem`,
  token: `${SLACK_BROKER_API_PREFIX}/token`,
  poll: `${SLACK_BROKER_API_PREFIX}/poll`,
  uninstall: `${SLACK_BROKER_API_PREFIX}/uninstall`,
  signinStart: `${SLACK_BROKER_API_PREFIX}/signin/start`,
  signinRedeem: `${SLACK_BROKER_API_PREFIX}/signin/redeem`,
} as const
export type SlackBrokerOp = keyof typeof SLACK_BROKER_PATHS

/** The ONE redirect URL registered in the Slack app, on the console host, for both "Add to Slack" and "Sign in with
 * Slack" (the control plane tells them apart by the state). Slack also takes paths below it; the control plane uses it
 * exactly, so the app's registration never has to change. */
export const SLACK_BROKER_REDIRECT_PATH = '/slack-broker/'
/** where the control plane sends the browser back after "Add to Slack", on the owner's own address */
export const SLACK_BROKER_TEAM_INSTALL_RETURN_PATH = '/api/integrations/slack/official/callback'
/** where it sends the browser back after "Sign in with Slack": the team server's own sign-in callback */
export const SLACK_BROKER_TEAM_SIGNIN_RETURN_PATH = '/api/integrations/slack/oauth/callback'
/** Slack's pages the browser is sent to (the team server checks `authorizationUrl` against these) */
export const SLACK_INSTALL_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'
export const SLACK_SIGNIN_AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize'

/** The bot scopes of the official app (its manifest); an install must grant every one. */
export const SLACK_BROKER_BOT_SCOPES = ['app_mentions:read', 'channels:read', 'chat:write', 'groups:read', 'im:history', 'im:write', 'users:read', 'users:read.email'] as const

export const SLACK_BROKER_MAX_BODY_BYTES = 16_384
export const SLACK_BROKER_MAX_SKEW_MS = 60_000
export const SLACK_BROKER_STATE_TTL_MS = 10 * 60_000
export const SLACK_BROKER_HANDOFF_TTL_MS = 2 * 60_000
/** the longest a poll is held */
export const SLACK_BROKER_POLL_MAX_WAIT_MS = 25_000
/** events in one poll answer */
export const SLACK_BROKER_POLL_MAX_EVENTS = 50
/** ids acknowledged in one poll */
export const SLACK_BROKER_ACK_MAX = 100
/** an event handed out and not acknowledged is handed out again after this */
export const SLACK_BROKER_LEASE_MS = 60_000
/** the longest an event waits for its owner */
export const SLACK_BROKER_EVENT_TTL_MS = 30 * 60_000
/** an owner that has not polled for this long gets nothing queued (its server is off or turned Slack off) */
export const SLACK_BROKER_OFFLINE_MS = 10 * 60_000

export const SLACK_BROKER_SEAL_ALG = 'X25519-HKDF-SHA256-A256GCM'
export const SLACK_BROKER_SEAL_INFO = 'trina-slack-broker-token-v1'
/** the AES-GCM additional data of a sealed bot token: the install and its workspace */
export const slackBrokerSealAad = (installId: string, slackTeamId: string) => `${SLACK_BROKER_SEAL_INFO}|${installId}|${slackTeamId}`

export interface SlackBrokerStatus { v: 1 }
export interface SlackBrokerInstall { v: 1; returnState: string; codeChallenge: string }
export interface SlackBrokerRedeem { v: 1; handoff: string; codeVerifier: string; sealKey: string }
export interface SlackBrokerToken { v: 1; sealKey: string }
export interface SlackBrokerPoll { v: 1; ack: string[]; waitMs: number }
export interface SlackBrokerUninstall { v: 1 }
export interface SlackBrokerSigninStart { v: 1; returnState: string; codeChallenge: string }
export interface SlackBrokerSigninRedeem { v: 1; handoff: string; codeVerifier: string }

/** One workspace's install, as the owner sees it. Never a token. */
export interface SlackBrokerInstallInfo {
  installId: string
  /** the Slack workspace (T…) and its name */
  teamId: string
  teamName: string
  /** the Enterprise Grid organization (E…) of the workspace, or null */
  enterpriseId: string | null
  botUserId: string
  /** the official app's id (A…): envelopes must carry it */
  appId: string
  scopes: string[]
  installedAt: string
}
export interface SlackBrokerSealedToken { alg: typeof SLACK_BROKER_SEAL_ALG; epk: string; iv: string; ct: string }

export interface SlackBrokerStatusAnswer { ok: true; appId: string; install: SlackBrokerInstallInfo | null }
export interface SlackBrokerStartAnswer { authorizationUrl: string; expiresAt: string }
export interface SlackBrokerTokenAnswer { install: SlackBrokerInstallInfo; token: SlackBrokerSealedToken }
/**
 * One envelope for the owner. `kind`:
 *   events_api   `payload` = Slack's event_callback (app_mention, message in the app's DM), its `token` field removed
 *   interactive  `payload` = Slack's block_actions, its `token` field removed (its response_url is the owner's to use)
 *   lifecycle    `payload` = { event: 'uninstalled' | 'tokens_revoked' | 'removed' }: the app was removed from the
 *                workspace in Slack, Slack revoked the bot token, or the hosting service's operator removed the install.
 *                The install is gone (status and poll answer install: null); "Add to Slack" again to go on.
 */
export interface SlackBrokerEvent { id: string; kind: 'events_api' | 'interactive' | 'lifecycle'; payload: unknown; receivedAt: string }
export interface SlackBrokerPollAnswer { install: SlackBrokerInstallInfo | null; events: SlackBrokerEvent[] }
export interface SlackBrokerUninstallAnswer { slack: 'removed' | 'unavailable' }
export interface SlackBrokerSigninAnswer { slackUserId: string; slackTeamId: string; enterpriseId: string | null }

/** Error codes and their HTTP status. */
export const SLACK_BROKER_ERRORS = {
  /** body is not JSON, too large, or not exactly the request of that path */
  invalid_request: 400,
  /** the handoff is unknown, used, expired, of another owner, or the verifier does not match */
  invalid_handoff: 400,
  /** Authorization header missing or malformed, the signature does not verify, ts too far off, or a replay */
  unauthorized: 401,
  /** the key is not the key of an owner the broker serves now (unknown, suspended, deleted, disabled) */
  not_hosted: 403,
  /** this owner has no install now (token, uninstall, sign-in): "Add to Slack" first */
  not_installed: 404,
  /** the workspace is installed for another team or server that is still served */
  workspace_taken: 409,
  /** an organization-wide (Enterprise Grid) install: not supported */
  enterprise_install: 409,
  /** Slack's grant lacks a bot scope of SLACK_BROKER_BOT_SCOPES */
  missing_scope: 409,
  /** the person signed in to another workspace than the owner's install */
  outsider: 409,
  /** too many calls of this owner or this address; try again later */
  rate_limited: 429,
  /** Slack failed or answered something unexpected */
  provider_error: 502,
  /** the control plane has no Slack app configured */
  not_configured: 503,
} as const
export type SlackBrokerErrorCode = keyof typeof SLACK_BROKER_ERRORS

/** a base64url value of 43 characters: 32 random bytes (a state, a handoff, an X25519 public key), or an S256 challenge */
const B64URL43 = /^[A-Za-z0-9_-]{43}$/
/** a PKCE verifier (RFC 7636: 43-128 unreserved characters) */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
/** an event id the control plane made */
export const SLACK_BROKER_EVENT_ID = /^[A-Za-z0-9-]{10,64}$/

const exactly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o)
const plain = (raw: unknown): Record<string, unknown> | null => typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null
const b43 = (v: unknown): v is string => typeof v === 'string' && B64URL43.test(v)

export function parseSlackBrokerStatus(raw: unknown): SlackBrokerStatus | null {
  const o = plain(raw)
  return o && exactly(o, ['v']) && o.v === 1 ? { v: 1 } : null
}
export const parseSlackBrokerUninstall = parseSlackBrokerStatus as (raw: unknown) => SlackBrokerUninstall | null

function parseStart(raw: unknown): { v: 1; returnState: string; codeChallenge: string } | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'returnState', 'codeChallenge']) || o.v !== 1) return null
  if (!b43(o.returnState) || !b43(o.codeChallenge)) return null
  return { v: 1, returnState: o.returnState, codeChallenge: o.codeChallenge }
}
export const parseSlackBrokerInstall = (raw: unknown): SlackBrokerInstall | null => parseStart(raw)
export const parseSlackBrokerSigninStart = (raw: unknown): SlackBrokerSigninStart | null => parseStart(raw)

export function parseSlackBrokerRedeem(raw: unknown): SlackBrokerRedeem | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'handoff', 'codeVerifier', 'sealKey']) || o.v !== 1) return null
  if (!b43(o.handoff) || !b43(o.sealKey) || typeof o.codeVerifier !== 'string' || !VERIFIER.test(o.codeVerifier)) return null
  return { v: 1, handoff: o.handoff, codeVerifier: o.codeVerifier, sealKey: o.sealKey }
}

export function parseSlackBrokerToken(raw: unknown): SlackBrokerToken | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'sealKey']) || o.v !== 1 || !b43(o.sealKey)) return null
  return { v: 1, sealKey: o.sealKey }
}

export function parseSlackBrokerPoll(raw: unknown): SlackBrokerPoll | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'ack', 'waitMs']) || o.v !== 1) return null
  if (!Array.isArray(o.ack) || o.ack.length > SLACK_BROKER_ACK_MAX || !o.ack.every((a) => typeof a === 'string' && SLACK_BROKER_EVENT_ID.test(a))) return null
  if (typeof o.waitMs !== 'number' || !Number.isSafeInteger(o.waitMs) || o.waitMs < 0 || o.waitMs > SLACK_BROKER_POLL_MAX_WAIT_MS) return null
  return { v: 1, ack: [...new Set(o.ack as string[])], waitMs: o.waitMs }
}

export function parseSlackBrokerSigninRedeem(raw: unknown): SlackBrokerSigninRedeem | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'handoff', 'codeVerifier']) || o.v !== 1) return null
  if (!b43(o.handoff) || typeof o.codeVerifier !== 'string' || !VERIFIER.test(o.codeVerifier)) return null
  return { v: 1, handoff: o.handoff, codeVerifier: o.codeVerifier }
}

const SLACK_ID = /^[A-Z0-9]{2,40}$/
/** An install as the owner reads it from an answer (status, poll, redeem, token); null when it is not one. */
export function parseSlackBrokerInstallInfo(raw: unknown): SlackBrokerInstallInfo | null {
  const o = plain(raw)
  if (!o) return null
  const s = (k: string, max = 200) => typeof o[k] === 'string' && (o[k] as string).length > 0 && (o[k] as string).length <= max
  if (!s('installId', 64) || !SLACK_BROKER_EVENT_ID.test(o.installId as string)) return null
  if (!s('teamId', 40) || !SLACK_ID.test(o.teamId as string) || !s('botUserId', 40) || !SLACK_ID.test(o.botUserId as string) || !s('appId', 40) || !SLACK_ID.test(o.appId as string)) return null
  if (!s('teamName') || !s('installedAt', 40)) return null
  if (o.enterpriseId !== null && !(typeof o.enterpriseId === 'string' && SLACK_ID.test(o.enterpriseId))) return null
  if (!Array.isArray(o.scopes) || o.scopes.length > 100 || !o.scopes.every((x) => typeof x === 'string' && x.length <= 100)) return null
  return {
    installId: o.installId as string, teamId: o.teamId as string, teamName: o.teamName as string, enterpriseId: o.enterpriseId as string | null,
    botUserId: o.botUserId as string, appId: o.appId as string, scopes: o.scopes as string[], installedAt: o.installedAt as string,
  }
}

/** A sealed bot token as the owner reads it from an answer; null when it is not one. */
export function parseSlackBrokerSealedToken(raw: unknown): SlackBrokerSealedToken | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['alg', 'epk', 'iv', 'ct']) || o.alg !== SLACK_BROKER_SEAL_ALG) return null
  if (!b43(o.epk) || typeof o.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(o.iv) || typeof o.ct !== 'string' || !/^[A-Za-z0-9_-]{24,1024}$/.test(o.ct)) return null
  return { alg: SLACK_BROKER_SEAL_ALG, epk: o.epk, iv: o.iv, ct: o.ct }
}

/** The UTF-8 string the team key signs. path: one of SLACK_BROKER_PATHS; bodySha256Hex: lower-case hex sha256 of the
 * exact request body bytes. */
export function slackBrokerSigningString(path: string, ts: number, nonce: string, bodySha256Hex: string): string {
  return `trina-slack-broker-v1\nPOST\n${path}\n${ts}\n${nonce}\n${bodySha256Hex}`
}

/** key: base64 SPKI DER of the Ed25519 public key (the relay's team key format); ts: unix ms; nonce: 16+ random bytes,
 * base64url; sig: base64. */
export function slackBrokerAuthorization(key: string, ts: number, nonce: string, sig: string): string {
  return `TrinaSlackBroker key=${key}, ts=${ts}, nonce=${nonce}, sig=${sig}`
}

const AUTH_RE = /^TrinaSlackBroker key=([A-Za-z0-9+/]{1,200}={0,2}), ts=(\d{1,16}), nonce=([A-Za-z0-9_-]{22,64}), sig=([A-Za-z0-9+/]{1,200}={0,2})$/

export function parseSlackBrokerAuthorization(header: string | null | undefined): { key: string; ts: number; nonce: string; sig: string } | null {
  if (typeof header !== 'string' || header.length > 600) return null
  const m = AUTH_RE.exec(header.trim())
  if (!m) return null
  const ts = Number(m[2])
  return Number.isSafeInteger(ts) ? { key: m[1]!, ts, nonce: m[3]!, sig: m[4]! } : null
}

/** The owner's return address after "Add to Slack" or "Sign in with Slack": only ever built from the owner's own
 * address (the control plane's records). */
export function slackBrokerReturnUrl(ownerAddress: string, path: typeof SLACK_BROKER_TEAM_INSTALL_RETURN_PATH | typeof SLACK_BROKER_TEAM_SIGNIN_RETURN_PATH, returnState: string, result: { handoff: string } | { error: 'consent_denied' | 'provider_error' }): string {
  const u = new URL(ownerAddress.replace(/\/+$/, '') + path)
  u.searchParams.set('state', returnState)
  if ('handoff' in result) u.searchParams.set('handoff', result.handoff)
  else u.searchParams.set('error', result.error)
  return u.href
}

/** `url` when it is Slack's own authorize page of that kind (https, slack.com, the exact path, a `state` and a
 * `client_id`, no credentials or fragment); otherwise null. A team server checks a start answer with it before it sends
 * a person's browser anywhere. */
export function slackBrokerAuthorizeUrl(kind: 'install' | 'signin', url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 4096) return null
  let u: URL
  try { u = new URL(url) } catch { return null }
  const want = new URL(kind === 'install' ? SLACK_INSTALL_AUTHORIZE_URL : SLACK_SIGNIN_AUTHORIZE_URL)
  if (u.origin !== want.origin || u.pathname !== want.pathname || u.username || u.password || u.hash) return null
  if (!b43(u.searchParams.get('state')) || !/^\d{3,20}\.\d{3,20}$/.test(u.searchParams.get('client_id') ?? '')) return null
  return u.href
}
