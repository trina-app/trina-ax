// A team made from the desktop app (docs/decisions/20261126-desktop-create-team.md). MIT (see LICENSE in this folder).
//
// Erasable TypeScript, imports only ./drive-broker.ts and ./team-name.ts: the team server, the desktop app and the control plane (Bun)
// load this file as it is. Callers compute sha256 and signatures themselves (node:crypto, WebCrypto).
//
// Two contracts, one flow:
//
// A. The app and the console (`APP_API_PREFIX`, control plane `src/http/console/app.ts`).
//    1. The app opens `<console>/app/connect?state&challenge&port&locale[&store=1]` in the browser (RFC 8252: a loopback
//       redirect, PKCE S256). The person signs in on the console and confirms; the console sends the browser to
//       `http://127.0.0.1:<port>/console-callback?code&state` (or `?error=<AppConnectError>&state`).
//       This is the Google way (Google allows no embedded web view). The e-mail way stays in the app, no browser:
//       `POST /api/app/v1/email/start {email, locale, challenge[, store: true]}` → `{ok: true}` (a 6-digit code is
//       mailed), then `POST /api/app/v1/email/verify {email, code, verifier}` → the same answer as step 2.
//    2. `POST /api/app/v1/token {v:1, code, verifier}` → `{token, expiresAt, store}`: an opaque bearer token, 2 hours,
//       good only for `/api/app/v1/*`. A token made with `store=1` (the Mac App Store build) reads and opens only: it
//       cannot create, resume or retry a team, nor join the waiting list.
//    3. `GET /me`, `POST /teams`, `GET /teams/:id`, `POST /teams/:id/{retry,resume,owner-claim}`, `POST /waitlist`, all
//       with `Authorization: Bearer <token>` and no cookie. Errors are `{error: {code, message, fields?}}` with the
//       codes in `APP_ERRORS`; the app reads the code and, for `capacity_full` and `unsupported`, `fields`.
//
// B. The owner claim, team server → control plane, two-phase. When the team is ready, `POST /teams/:id/owner-claim`
//    answers `https://<team>/app-setup#c=<claim>` (`ownerClaimSetupUrl`). The claim is 32 random bytes in base64url
//    (43 characters); the control plane keeps only the sha256 (hex) of its UTF-8 bytes, bound to the team,
//    OWNER_CLAIM_TTL_MS, and a new claim revokes the older unconfirmed ones. The app's window loads the address; the
//    page takes the claim out of the fragment and sends it to its own team server
//    (`POST /api/setup/console[/preview]`), which asks the control plane:
//    - `POST OWNER_CLAIM_RESERVE_PATH {v:1, claim}` → `OwnerClaimOwner` (the team's name and who the owner is).
//      Repeatable until confirmed.
//    - after the owner account is made: `POST OWNER_CLAIM_CONFIRM_PATH {v:1, claim}` → `{ok: true, spent}`. Spends the
//      claim (one UPDATE). Repeatable by the same team: a second confirm answers `spent: false`, so a retry after a
//      lost answer is harmless.
//    Signed exactly like the Drive broker (`TrinaDriveBroker` header, `driveBrokerSigningString` with the path), only
//    the relay team key the control plane recorded at enroll for the PRIMARY tenant of a hosted team. Nothing in the
//    body names the team: a claim of another team is `invalid_claim`, the same answer as an unknown one.
//
// A control plane without these paths answers 404: the team server turns that into `unsupported` for the page, and
// the app falls back to the old setup link (`AppOwnerClaimAnswer.setupUrl`).
import { DRIVE_BROKER_MAX_BODY_BYTES, driveBrokerSigningString } from './drive-broker.ts'
import { teamNameProblem } from './team-name.ts'

// ---------------------------------------------------------------- A. app ↔ console

export const APP_API_PREFIX = '/api/app/v1'
/** the console page the app opens in the browser */
export const APP_CONNECT_PATH = '/app/connect'
/** the path on the app's loopback listener the console returns to */
export const APP_CALLBACK_PATH = '/console-callback'
/** how long a connect may take, from the app's open to the callback (the console's state lives as long) */
export const APP_CONNECT_TTL_MS = 10 * 60_000
/** how long a bearer token lives */
export const APP_TOKEN_TTL_MS = 2 * 60 * 60_000
export const APP_PATHS = {
  token: `${APP_API_PREFIX}/token`,
  me: `${APP_API_PREFIX}/me`,
  teams: `${APP_API_PREFIX}/teams`,
  waitlist: `${APP_API_PREFIX}/waitlist`,
  emailStart: `${APP_API_PREFIX}/email/start`,
  emailVerify: `${APP_API_PREFIX}/email/verify`,
} as const
/** the console's terms and privacy pages (on the console origin), linked under the app's own e-mail sign-in */
export const APP_TERMS_PATH = '/legal/terms'
export const APP_PRIVACY_PATH = '/legal/privacy'
export const appTeamPath = (teamId: string, op?: 'retry' | 'resume' | 'owner-claim') =>
  `${APP_API_PREFIX}/teams/${encodeURIComponent(teamId)}${op ? `/${op}` : ''}`

/** the errors the console's page may send back to the app's callback instead of a code */
export const APP_CONNECT_ERRORS = ['cancelled', 'expired', 'denied'] as const
export type AppConnectError = (typeof APP_CONNECT_ERRORS)[number]

/** state, PKCE challenge, one-time code: 43 base64url characters (32 random bytes, or a sha256) */
const B64URL43 = /^[A-Za-z0-9_-]{43}$/
/** a PKCE verifier (RFC 7636: 43-128 unreserved characters) */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
/** a bearer token: opaque, base64url, 43-128 characters */
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/
const TEAM_ID = /^[A-Za-z0-9_-]{1,64}$/
const LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/

export interface AppConnectParams { state: string; challenge: string; port: number; locale: string; store: boolean }

/** `<console>/app/connect?...` the app opens in the browser */
export function appConnectUrl(consoleOrigin: string, p: AppConnectParams): string {
  const u = new URL(APP_CONNECT_PATH, consoleOrigin)
  u.searchParams.set('state', p.state)
  u.searchParams.set('challenge', p.challenge)
  u.searchParams.set('port', String(p.port))
  u.searchParams.set('locale', p.locale)
  if (p.store) u.searchParams.set('store', '1')
  return u.toString()
}

/** the console's side of the same address: null when anything is off (it then shows an error and returns nowhere) */
export function parseAppConnectParams(q: URLSearchParams): AppConnectParams | null {
  const keys = [...new Set(q.keys())]
  if (keys.some((k) => !['state', 'challenge', 'port', 'locale', 'store'].includes(k)) || keys.some((k) => q.getAll(k).length !== 1)) return null
  const state = q.get('state') ?? '', challenge = q.get('challenge') ?? '', portText = q.get('port') ?? '', locale = q.get('locale') ?? ''
  const store = q.get('store')
  if (!B64URL43.test(state) || !B64URL43.test(challenge) || !/^[1-9][0-9]{3,4}$/.test(portText) || !LOCALE.test(locale)) return null
  const port = Number(portText)
  if (port < 1024 || port > 65535 || (store !== null && store !== '1')) return null
  return { state, challenge, port, locale, store: store === '1' }
}

/** where the console sends the browser back: the app's loopback listener (always 127.0.0.1, never "localhost") */
export function appCallbackUrl(port: number, answer: { code: string; state: string } | { error: AppConnectError; state: string }): string {
  const u = new URL(`http://127.0.0.1:${port}${APP_CALLBACK_PATH}`)
  if ('code' in answer) u.searchParams.set('code', answer.code)
  else u.searchParams.set('error', answer.error)
  u.searchParams.set('state', answer.state)
  return u.toString()
}

/** Sign-in with an e-mail code inside the app (no browser; owner change 2026-11-26). The app sends a PKCE challenge
 * with the address; the console mails a 6-digit code (its own mail-code limits) and records the terms consent the app
 * showed ("By continuing you agree to the Terms and Privacy"). The verify answers the same token as `/token`; the
 * verifier binds it to the app that started it. `store: true` (the Mac App Store build): a sign-in-only token, never a
 * new account. */
export interface AppEmailStart { email: string; locale: string; challenge: string; store?: true }
export interface AppEmailVerify { email: string; code: string; verifier: string }
export const APP_EMAIL_CODE_RE = /^[0-9]{6}$/
/** an e-mail address the app sends: trimmed, one @, no spaces or controls, at most 254 characters */
export const isAppEmail = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 254 && s === s.trim() && /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(s)

export function parseAppEmailStart(raw: unknown): AppEmailStart | null {
  const o = plain(raw)
  if (!o) return null
  const keys = Object.keys(o)
  if (!keys.every((k) => ['email', 'locale', 'challenge', 'store'].includes(k)) || !['email', 'locale', 'challenge'].every((k) => k in o)) return null
  if (!isAppEmail(o.email) || typeof o.locale !== 'string' || !LOCALE.test(o.locale) || typeof o.challenge !== 'string' || !B64URL43.test(o.challenge)) return null
  if ('store' in o && o.store !== true) return null
  return { email: o.email, locale: o.locale, challenge: o.challenge, ...(o.store === true ? { store: true as const } : {}) }
}
export function parseAppEmailVerify(raw: unknown): AppEmailVerify | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['email', 'code', 'verifier'])) return null
  if (!isAppEmail(o.email) || typeof o.code !== 'string' || !APP_EMAIL_CODE_RE.test(o.code) || typeof o.verifier !== 'string' || !VERIFIER.test(o.verifier)) return null
  return { email: o.email, code: o.code, verifier: o.verifier }
}

export interface AppTokenRequest { v: 1; code: string; verifier: string }
export interface AppTokenAnswer { token: string; expiresAt: string; store: boolean }

export function parseAppTokenRequest(raw: unknown): AppTokenRequest | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'code', 'verifier']) || o.v !== 1) return null
  return typeof o.code === 'string' && B64URL43.test(o.code) && typeof o.verifier === 'string' && VERIFIER.test(o.verifier)
    ? { v: 1, code: o.code, verifier: o.verifier } : null
}
export function parseAppTokenAnswer(raw: unknown): AppTokenAnswer | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['token', 'expiresAt', 'store']) || typeof o.token !== 'string' || !TOKEN.test(o.token) || typeof o.expiresAt !== 'string' || !isIso(o.expiresAt) || typeof o.store !== 'boolean') return null
  return { token: o.token, expiresAt: o.expiresAt, store: o.store }
}

/** a team's state as the app shows it */
export const APP_TEAM_STATES = [
  /** being made (`provisioning` has the step) */
  'provisioning',
  /** made and running (or asleep for a moment: the relay wakes it) */
  'active',
  /** a free team stopped after no use: `POST /teams/:id/resume` starts it again */
  'paused',
  /** on hold by the hosting service, or a payment is late: the console */
  'suspended', 'past_due',
  /** canceled; `comeback` says whether a checkout to bring it back is open */
  'canceled',
  /** making it failed: `POST /teams/:id/retry` */
  'provision_failed',
] as const
export type AppTeamState = (typeof APP_TEAM_STATES)[number]

export interface AppTeamProvisioning {
  /** 0 queued, 1 creating the server, 2 starting it, 3 checking, 4 done */
  step: 0 | 1 | 2 | 3 | 4
  /** a failed setup: `slug_conflict` (choose another address) or `setup_failed` */
  error: 'slug_conflict' | 'setup_failed' | null
  /** waiting for room on a free host */
  waitingCapacity: boolean
}

export interface AppTeam {
  id: string
  name: string
  slug: string
  /** https://<slug>.<team domain> */
  url: string
  state: AppTeamState
  /** the owner account exists on the team server (the owner claim is spent, or the team was set up another way) */
  setUp: boolean
  /** the plan id (`free`, `basic`, ...) */
  planId: string
  /** canceled with an open checkout to bring it back */
  comeback: boolean
  provisioning: AppTeamProvisioning | null
}

/** the Free plan as the app shows it under the name field (numbers only, the app words them) */
export interface AppFreePlan {
  maxActiveMembers: number | null
  maxConcurrency: number
  diskGB: number
  /** the Free plan terms and the privacy policy the agree box names */
  termsUrl: string
  privacyUrl: string
  /** the version of the terms the consent records */
  termsVersion: string
}

export interface AppMe {
  accountId: string
  email: string
  /** the account's one live team (one team per account), or null */
  team: AppTeam | null
  /** this account may still make its free team (no free team or trial ever, including canceled ones) */
  freeLeft: boolean
  /** the hosting service lets people in slowly now: a new team goes on the waiting list instead */
  waitlist: boolean
  /** null when the Free plan is not offered */
  freePlan: AppFreePlan | null
  /** the token was made with `store=1` */
  store: boolean
}

export interface AppCreateTeam {
  v: 1
  planId: 'free'
  displayName: string
  slug: string
  /** IANA zone and the app's language, from the computer; the console picks the region from the zone */
  timeZone: string
  locale: string
  /** what the person agreed to on the screen: the terms version shown and when they ticked the box */
  consent: { termsVersion: string; shownAt: string }
}
export interface AppTeamAnswer { team: AppTeam }

/** `POST /teams/:id/retry` (and `/resume`, `/owner-claim`, `/waitlist`, which take `{v: 1}` only): a failed setup made
 * again. `slug`: a new address, after the setup failed because its address went to another team (`slug_conflict`);
 * absent: the same address. Answers `{team}` (`AppTeamAnswer`). */
export interface AppRetryTeam { v: 1; slug?: string }
export function parseAppRetryTeam(raw: unknown): AppRetryTeam | null {
  const o = plain(raw)
  if (!o || o.v !== 1 || !Object.keys(o).every((k) => k === 'v' || k === 'slug')) return null
  if (!('slug' in o)) return { v: 1 }
  return typeof o.slug === 'string' && teamSlugOk(o.slug) ? { v: 1, slug: o.slug } : null
}

/** `POST /teams/:id/owner-claim`: the address the app opens (`ownerClaimSetupUrl`). A team server older than the
 * console setup gets error `unsupported` with `fields.setupUrl`, the old one-time setup link the app opens instead. */
export interface AppOwnerClaimAnswer { url: string }
/** the console's error body (`{error: {code, message, fields?}}`); the app reads `code` and, for some, `fields` */
export interface AppErrorBody { error: { code: string; message: string; fields?: Record<string, string> } }

export function parseAppError(raw: unknown): { code: string; fields: Record<string, string> } | null {
  const e = plain(plain(raw)?.error)
  if (!e || typeof e.code !== 'string' || !/^[a-z0-9_]{1,40}$/.test(e.code)) return null
  const f = plain(e.fields)
  const fields: Record<string, string> = {}
  if (f) for (const [k, v] of Object.entries(f)) if (typeof v === 'string' && v.length <= 2048) fields[k] = v
  return { code: e.code, fields }
}

export function parseAppCreateTeam(raw: unknown): AppCreateTeam | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'planId', 'displayName', 'slug', 'timeZone', 'locale', 'consent']) || o.v !== 1 || o.planId !== 'free') return null
  const c = plain(o.consent)
  if (!c || !exactly(c, ['termsVersion', 'shownAt']) || typeof c.termsVersion !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(c.termsVersion) || typeof c.shownAt !== 'string' || !isIso(c.shownAt)) return null
  if (typeof o.displayName !== 'string' || o.displayName.trim() === '' || [...o.displayName].length > 60) return null
  if (typeof o.slug !== 'string' || !teamSlugOk(o.slug)) return null
  if (typeof o.timeZone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(o.timeZone) || typeof o.locale !== 'string' || !LOCALE.test(o.locale)) return null
  return { v: 1, planId: 'free', displayName: o.displayName, slug: o.slug, timeZone: o.timeZone, locale: o.locale, consent: { termsVersion: c.termsVersion, shownAt: c.shownAt } }
}

export function parseAppTeam(raw: unknown): AppTeam | null {
  const o = plain(raw)
  if (!o || typeof o.id !== 'string' || !TEAM_ID.test(o.id) || teamNameProblem(o.name) !== null || typeof o.slug !== 'string' || !teamSlugOk(o.slug)) return null
  if (typeof o.url !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(o.url) && !/^http:\/\/(?:127\.0\.0\.1|[a-z0-9-]+\.localhost)(?::[0-9]{1,5})?$/.test(o.url)) return null
  if (typeof o.state !== 'string' || !(APP_TEAM_STATES as readonly string[]).includes(o.state) || typeof o.setUp !== 'boolean' || typeof o.planId !== 'string' || typeof o.comeback !== 'boolean') return null
  let provisioning: AppTeamProvisioning | null = null
  if (o.provisioning !== null && o.provisioning !== undefined) {
    const p = plain(o.provisioning)
    if (!p || ![0, 1, 2, 3, 4].includes(p.step as number) || typeof p.waitingCapacity !== 'boolean') return null
    if (p.error !== null && p.error !== 'slug_conflict' && p.error !== 'setup_failed') return null
    provisioning = { step: p.step as AppTeamProvisioning['step'], error: p.error as AppTeamProvisioning['error'], waitingCapacity: p.waitingCapacity }
  }
  return { id: o.id, name: o.name as string, slug: o.slug, url: o.url, state: o.state as AppTeamState, setUp: o.setUp, planId: o.planId, comeback: o.comeback, provisioning }
}

export function parseAppMe(raw: unknown): AppMe | null {
  const o = plain(raw)
  if (!o || typeof o.accountId !== 'string' || !isAppEmail(o.email) || typeof o.freeLeft !== 'boolean' || typeof o.waitlist !== 'boolean' || typeof o.store !== 'boolean') return null
  let team: AppTeam | null = null
  if (o.team !== null && o.team !== undefined) { team = parseAppTeam(o.team); if (!team) return null }
  let freePlan: AppFreePlan | null = null
  if (o.freePlan !== null && o.freePlan !== undefined) {
    const f = plain(o.freePlan)
    if (!f || (f.maxActiveMembers !== null && !Number.isInteger(f.maxActiveMembers)) || !Number.isInteger(f.maxConcurrency) || typeof f.diskGB !== 'number'
      || typeof f.termsUrl !== 'string' || !f.termsUrl.startsWith('https://') || typeof f.privacyUrl !== 'string' || !f.privacyUrl.startsWith('https://') || typeof f.termsVersion !== 'string') return null
    freePlan = { maxActiveMembers: f.maxActiveMembers as number | null, maxConcurrency: f.maxConcurrency as number, diskGB: f.diskGB, termsUrl: f.termsUrl, privacyUrl: f.privacyUrl, termsVersion: f.termsVersion }
  }
  return { accountId: o.accountId, email: o.email, team, freeLeft: o.freeLeft, waitlist: o.waitlist, freePlan, store: o.store }
}

/** The error codes of `/api/app/v1/*` the app tells apart (any other code: a generic "something went wrong"). */
export const APP_ERRORS = {
  invalid_request: 400,
  /** the token is missing, unknown or expired (2 h): sign in again */
  unauthorized: 401,
  /** a store token tried to create, resume or retry; or a team of another account */
  forbidden: 403,
  not_found: 404,
  /** the account already has a live team (one team per account) */
  team_exists: 409,
  /** the account already used its free team or a trial (also a canceled one: the claim is kept) */
  free_not_allowed: 409,
  /** no room on the free hosts now (`fields.pool: 'free'`); nothing is saved and no mail is sent */
  capacity_full: 409,
  /** a free team may not wake now: too many free teams awake on its host */
  free_awake_limit: 409,
  /** the hosting service lets people in slowly: join the waiting list */
  waitlist: 409,
  /** too many new teams from this network today, or another limit of the network */
  network_limit: 429,
  /** the account's e-mail is not confirmed yet */
  email_unverified: 409,
  /** no free host serves the computer's region */
  no_free_region: 409,
  /** the address is taken or not allowed: choose another one */
  slug_unavailable: 409,
  /** `owner-claim`: the team is set up already (sign in on it instead) */
  already_set_up: 409,
  /** `owner-claim`: the team is not ready yet */
  not_ready: 409,
  /** `email/verify`: the code is wrong (try again) */
  code_invalid: 400,
  /** `email/verify`: the code is too old or was replaced: send a new one */
  code_expired: 400,
  /** `email/start` or `email/verify`: too many codes or tries for this address; later */
  /** (`email/start` always answers `{ok: true}`, also with `store: true` for an address with no account, so nobody can
   * test which addresses have one; such a store sign-in then fails at verify with `code_invalid`) */
  code_exhausted: 429,
  /** `owner-claim`: the team server is older than the console setup; `setupUrl` is the old one-time setup link */
  unsupported: 409,
  rate_limited: 429,
} as const
export type AppErrorCode = keyof typeof APP_ERRORS

// ---------------------------------------------------------------- B. owner claim

export const OWNER_CLAIM_RESERVE_PATH = '/api/hosted-team/v1/owner/reserve'
export const OWNER_CLAIM_CONFIRM_PATH = '/api/hosted-team/v1/owner/confirm'
export const OWNER_CLAIM_PATHS = [OWNER_CLAIM_RESERVE_PATH, OWNER_CLAIM_CONFIRM_PATH] as const
export type OwnerClaimPath = (typeof OWNER_CLAIM_PATHS)[number]
/** the team server page that takes the claim */
export const OWNER_CLAIM_SETUP_PATH = '/app-setup'
export const OWNER_CLAIM_TTL_MS = 10 * 60_000
export const OWNER_CLAIM_MAX_BODY_BYTES = DRIVE_BROKER_MAX_BODY_BYTES

/** a claim: 32 random bytes, base64url, no padding */
export const OWNER_CLAIM_RE = B64URL43
export const isOwnerClaim = (v: unknown): v is string => typeof v === 'string' && OWNER_CLAIM_RE.test(v)

/** `https://<team>/app-setup#c=<claim>` */
export function ownerClaimSetupUrl(teamOrigin: string, claim: string): string {
  if (!isOwnerClaim(claim)) throw new Error('not a claim')
  return `${new URL(teamOrigin).origin}${OWNER_CLAIM_SETUP_PATH}#c=${claim}`
}

/** the claim in a page's fragment (`#c=<claim>`, nothing else), or null */
export function readOwnerClaimFragment(hash: string): string | null {
  const m = /^#c=([A-Za-z0-9_-]{43})$/.exec(hash)
  return m ? m[1]! : null
}

export interface OwnerClaimRequest { v: 1; claim: string }
/** who the owner is, as the console knows them. `google` is set when they signed in to the console with Google: the
 * team server then makes the owner with that Google account (the `sub` of the hosting service's Google client, the
 * same one its Google sign-in broker uses) and no password. */
export interface OwnerClaimOwner {
  /** the team's name as the person typed it in the app (`teams.display_name`, team-name.ts's rule) */
  teamName: string
  email: string
  /** the account's name, or, without one, the e-mail's part before @ (the owner changes it later) */
  name: string
  /** the app's language at create (`ko`, `en`, ...) */
  locale: string
  /** the IANA zone the team was made with, or null */
  timeZone: string | null
  google: { sub: string; email: string; hd: string | null } | null
}
export interface OwnerClaimConfirmAnswer { ok: true; spent: boolean }

export const OWNER_CLAIM_ERRORS = {
  /** body is not JSON, too large, or not exactly `{v:1, claim}` */
  invalid_request: 400,
  /** Authorization header missing or malformed, the signature does not verify, ts too far off, or a replay */
  unauthorized: 401,
  /** the key is not the primary tenant key of a hosted team */
  not_hosted: 403,
  /** unknown, expired, revoked, spent, or of another team: all the same answer */
  invalid_claim: 410,
  /** the control plane already knows this team as set up */
  already_set_up: 409,
  rate_limited: 429,
} as const
export type OwnerClaimErrorCode = keyof typeof OWNER_CLAIM_ERRORS

/** reserve and confirm take the same body */
export function parseOwnerClaimRequest(raw: unknown): OwnerClaimRequest | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'claim']) || o.v !== 1 || !isOwnerClaim(o.claim)) return null
  return { v: 1, claim: o.claim }
}

const EMAIL = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,255}$/u
/** the reserve answer, strictly: the team server makes an account from it */
export function parseOwnerClaimOwner(raw: unknown): OwnerClaimOwner | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['teamName', 'email', 'name', 'locale', 'timeZone', 'google'])) return null
  if (teamNameProblem(o.teamName) !== null) return null
  if (typeof o.email !== 'string' || o.email.length > 254 || !EMAIL.test(o.email)) return null
  if (typeof o.name !== 'string' || o.name.trim() === '' || [...o.name].length > 100 || /\p{Cc}/u.test(o.name)) return null
  if (typeof o.locale !== 'string' || !LOCALE.test(o.locale)) return null
  if (o.timeZone !== null && (typeof o.timeZone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(o.timeZone))) return null
  let google: OwnerClaimOwner['google'] = null
  if (o.google !== null) {
    const g = plain(o.google)
    if (!g || !exactly(g, ['sub', 'email', 'hd']) || typeof g.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(g.sub)) return null
    if (typeof g.email !== 'string' || !EMAIL.test(g.email) || (g.hd !== null && (typeof g.hd !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(g.hd)))) return null
    google = { sub: g.sub, email: g.email, hd: g.hd as string | null }
  }
  return { teamName: o.teamName as string, email: o.email, name: o.name, locale: o.locale, timeZone: o.timeZone as string | null, google }
}

export function parseOwnerClaimConfirmAnswer(raw: unknown): OwnerClaimConfirmAnswer | null {
  const o = plain(raw)
  return o && exactly(o, ['ok', 'spent']) && o.ok === true && typeof o.spent === 'boolean' ? { ok: true, spent: o.spent } : null
}

/** The UTF-8 string the team key signs: the Drive broker's, with this path. */
export function ownerClaimSigningString(path: OwnerClaimPath, ts: number, nonce: string, bodySha256Hex: string): string {
  if (!(OWNER_CLAIM_PATHS as readonly string[]).includes(path)) throw new Error('not an owner claim path')
  return driveBrokerSigningString(path, ts, nonce, bodySha256Hex)
}

// ---------------------------------------------------------------- team address

/** the relay's label rule (common.ts TeamSlug, without zod): 3-40 of a-z 0-9 -, no - at either end, no -- at 3-4 */
export function teamSlugOk(s: string): boolean {
  return s.length >= 3 && s.length <= 40 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(s) && s.slice(2, 4) !== '--'
}

/** An address label from a team name: Latin letters without accents, digits and single "-", cut at 30. A name with
 * too few such letters (한글, 日本語) gives `team-<suffix>`, `suffix` being 4-6 random a-z0-9 the caller picks. The
 * console may still refuse it (taken, reserved): the person changes it. */
export function suggestTeamSlug(name: string, suffix: string): string {
  const base = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '')
  const s = base.slice(2, 4) === '--' ? base.replace(/-+/g, '-') : base
  return teamSlugOk(s) ? s : `team-${suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'new'}`
}

// ---------------------------------------------------------------- helpers

const exactly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => k in o)
const plain = (raw: unknown): Record<string, unknown> | null => typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null
const isIso = (s: string) => s.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s))
