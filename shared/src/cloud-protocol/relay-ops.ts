// Relay operator API (control-plane spec 3.6.2): served ONLY on the relay's private listener (Tailscale address,
// RELAY_PRIVATE_LISTEN); the public listener answers 404 for /ops. Callers: the control plane (key "cp") and the
// operators' break-glass key. MIT (see LICENSE in this folder).
//
// The relay loads this file directly with Node type stripping: erasable TypeScript only, no zod, node:crypto only.
// zod mirrors of the bodies for the control plane: relay-ops-schema.ts (a contract test keeps them in step).
//
// Authentication: Authorization: MycelRelayOps key=<keyId>, ts=<ms>, sig=<base64>
//   sig = Ed25519 over opsSigningString(method, path?query, ts, body) by the key registered under keyId in the relay's
//   operator-keys.json. ts within ±60 s of the relay clock; the same signature is refused for 120 s (replay); the key
//   needs the endpoint's scope (opsScopeFor). Every write is recorded in the relay's ops_audit (key id, action, team id).
//   Ed25519 is deterministic: the same request with the same ts is the same signature, so a client keeps ts strictly
//   increasing (max(now, last + 1)) and signs a retry again rather than resending it.
import { createHash } from 'node:crypto'

export const OPS_API_PREFIX = '/ops/v1'
export const OPS_SIG_MAX_SKEW_MS = 60_000
/** a signature seen within this window is refused (replay); the relay remembers at most OPS_REPLAY_MAX of them */
export const OPS_REPLAY_WINDOW_MS = 120_000
export const OPS_REPLAY_MAX = 10_000
export const OPS_MAX_BODY = 16 * 1024

export const OPS_SCOPES = ['teams:read', 'teams:write', 'claims:write', 'notice:write'] as const
export type OpsScope = (typeof OPS_SCOPES)[number]

/** why a team is suspended (relay teams.suspend_reason). billing / canceled show the "check your payment" page. */
export const SUSPEND_REASONS = ['billing', 'canceled', 'abuse', 'security', 'operator'] as const
export type SuspendReason = (typeof SUSPEND_REASONS)[number]
/** who made the registration: self = public registration (proof of work), cloud = control plane, addon = claim code */
export const TEAM_ORIGINS = ['self', 'cloud', 'addon'] as const
export type TeamOrigin = (typeof TEAM_ORIGINS)[number]

/** temporary name holds (signup in progress) last at most this long */
export const MAX_HOLD_TTL_SEC = 3600
/** claim codes (self-hosted official relay add-on) live at most 7 days */
export const MAX_CLAIM_TTL_SEC = 7 * 24 * 3600
/** a renamed-away address answers 308 to the new one for this long (control-plane D40) */
export const RENAME_REDIRECT_MS = 90 * 24 * 3600_000

/** one entry of the relay's operator-keys.json */
export interface OperatorKey {
  keyId: string
  /** base64 SPKI DER of the Ed25519 public key (same format as team keys) */
  publicKey: string
  label: string
  scopes: OpsScope[]
}

export function opsSigningString(method: string, pathWithQuery: string, ts: number, body: string): string {
  return `mycel-relay-ops-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`
}

export function opsAuthorizationHeader(keyId: string, ts: number, sig: string): string {
  return `MycelRelayOps key=${keyId}, ts=${ts}, sig=${sig}`
}

export const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

export function parseOpsAuthorizationHeader(h: string | null | undefined): { keyId: string; ts: number; sig: string } | null {
  if (!h) return null
  const m = /^MycelRelayOps key=([A-Za-z0-9._-]{1,64}), ts=(\d{1,16}), sig=([A-Za-z0-9+/=]{1,200})$/.exec(h.trim())
  return m ? { keyId: m[1]!, ts: Number(m[2]), sig: m[3]! } : null
}

/** The scope an endpoint needs, or null when there is no such endpoint. `path` without the query. */
export function opsScopeFor(method: string, path: string): OpsScope | null {
  const M = method.toUpperCase()
  const p = path.startsWith(OPS_API_PREFIX) ? path.slice(OPS_API_PREFIX.length) : null
  if (p === null) return null
  if (M === 'GET' && /^\/names\/[^/]+$/.test(p)) return 'teams:read'
  if (M === 'GET' && (p === '/teams' || p === '/stats' || /^\/teams\/[^/]+$/.test(p))) return 'teams:read'
  if ((M === 'POST' && p === '/holds') || (M === 'DELETE' && /^\/holds\/[^/]+$/.test(p))) return 'teams:write'
  if (M === 'POST' && p === '/teams') return 'teams:write'
  if (M === 'POST' && /^\/teams\/[^/]+\/(suspend|unsuspend|maintenance|sleep)$/.test(p)) return 'teams:write'
  if ((M === 'PUT' && /^\/teams\/[^/]+\/key$/.test(p)) || ((M === 'PATCH' || M === 'DELETE') && /^\/teams\/[^/]+$/.test(p))) return 'teams:write'
  if (M === 'POST' && /^\/teams\/[^/]+\/notice$/.test(p)) return 'notice:write'
  if ((M === 'POST' && p === '/claims') || (M === 'DELETE' && /^\/claims\/[^/]+$/.test(p))) return 'claims:write'
  return null
}

// ------------------------------------------------------------------ bodies

export type NameProblem = 'too_short' | 'too_long' | 'invalid' | 'reserved' | 'taken'
export interface OpsNameCheck { name: string; available: boolean; problem: NameProblem | null }
export interface OpsHoldRequest { name: string; ttlSec: number }
export interface OpsHoldResponse { name: string; holdUntil: string }
export interface OpsCreateTeamRequest {
  name: string
  /** base64 SPKI Ed25519 public key generated inside the tenant (mycel-enroll) */
  publicKey: string
  /** registerSigningString(name, publicKey, ts) signed by that key: the tenant holds it */
  ts: number
  sig: string
  region: string
  origin: 'cloud' | 'addon'
  /** the control plane's team id; same externalRef + same key again = the same team back (idempotent) */
  externalRef: string
}
export interface OperatorTeamInfo {
  teamId: string
  name: string
  status: 'active' | 'suspended' | 'released'
  /** https://<name>.<default domain> */
  address: string
  lastHeartbeatAt: string | null
  origin: TeamOrigin
  externalRef: string | null
  region: string
  suspendReason: SuspendReason | null
  maintenanceUntil: string | null
  /** F2: the control plane put the team's VM to sleep at this time (cleared when the team server connects). Absent
   * from older relays. */
  sleepingSince?: string | null
  /** the team server holds at least one live control connection to THIS relay process */
  online: boolean
  conns: number
  lastConnectedAt: string | null
  lastVersion: string | null
  memberCount: number | null
  createdAt: string
}
export interface OpsTeamList { teams: OperatorTeamInfo[]; next: string | null }
export interface OpsSuspendRequest { reason: SuspendReason }
export interface OpsMaintenanceRequest { untilMs: number | null }
/** F2 sleep: true = the VM is asleep (the relay drops the team's connections and wakes it on the next request) */
export interface OpsSleepRequest { sleeping: boolean }
export interface OpsKeyRequest { publicKey: string; newKeySig: string }
export interface OpsRenameRequest { name: string }
export interface OpsNoticeRequest { level: 'info' | 'warn'; code: string; message: string }
export interface OpsClaimRequest { name: string; ttlSec: number; externalRef: string }
/** `code` is shown once: the relay keeps only its hash */
export interface OpsClaimResponse { name: string; code: string; expiresAt: string }
export interface OpsStats { teams: { active: number; suspended: number }; online: number; conns: number; clientSockets: number; uptimeS: number }

export type OpsErrorCode =
  | 'unauthorized' | 'forbidden' | 'replayed' | 'not_found' | 'invalid_request' | 'invalid_name' | 'name_taken'
  | 'name_reserved' | 'key_in_use' | 'bad_signature' | 'conflict' | 'internal'
export interface OpsError { error: { code: OpsErrorCode; message: string } }

// ------------------------------------------------------------------ validators (no zod: the relay uses these)

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

export const EXTERNAL_REF_RE = /^[A-Za-z0-9._:-]{1,128}$/
export const REGION_RE = /^[a-z0-9-]{1,32}$/
const NOTICE_CODE_RE = /^[a-z0-9_.-]{1,64}$/
const B64_RE = /^[A-Za-z0-9+/]+=*$/

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (o: Obj, k: string, max: number): string | null => (typeof o[k] === 'string' && (o[k] as string).length >= 1 && (o[k] as string).length <= max ? (o[k] as string) : null)
const int = (o: Obj, k: string, min: number, max: number): number | null => (Number.isInteger(o[k]) && (o[k] as number) >= min && (o[k] as number) <= max ? (o[k] as number) : null)
const bad = <T>(message: string): Parsed<T> => ({ ok: false, message })
/** fields that are not part of the body: a typo must not be silently ignored on an operator API */
function onlyKeys(o: Obj, allowed: string[]): string | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `unknown field ${k}`
  return null
}

export function parseHoldRequest(x: unknown): Parsed<OpsHoldRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['name', 'ttlSec'])
  if (extra) return bad(extra)
  const name = str(x, 'name', 64), ttlSec = int(x, 'ttlSec', 1, MAX_HOLD_TTL_SEC)
  if (!name) return bad('name required')
  if (ttlSec === null) return bad(`ttlSec must be 1-${MAX_HOLD_TTL_SEC}`)
  return { ok: true, value: { name, ttlSec } }
}

export function parseCreateTeamRequest(x: unknown): Parsed<OpsCreateTeamRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['name', 'publicKey', 'ts', 'sig', 'region', 'origin', 'externalRef'])
  if (extra) return bad(extra)
  const name = str(x, 'name', 64), publicKey = str(x, 'publicKey', 200), sig = str(x, 'sig', 200), region = str(x, 'region', 32), externalRef = str(x, 'externalRef', 128)
  const ts = int(x, 'ts', 0, Number.MAX_SAFE_INTEGER)
  if (!name) return bad('name required')
  if (!publicKey || !B64_RE.test(publicKey)) return bad('publicKey must be base64')
  if (!sig || !B64_RE.test(sig)) return bad('sig must be base64')
  if (ts === null) return bad('ts must be a millisecond timestamp')
  if (!region || !REGION_RE.test(region)) return bad('region: 1-32 lowercase letters, digits, hyphens')
  if (x.origin !== 'cloud' && x.origin !== 'addon') return bad("origin must be 'cloud' or 'addon'")
  if (!externalRef || !EXTERNAL_REF_RE.test(externalRef)) return bad('externalRef: 1-128 of A-Z a-z 0-9 . _ : -')
  return { ok: true, value: { name, publicKey, ts, sig, region, origin: x.origin as 'cloud' | 'addon', externalRef } }
}

export function parseSuspendRequest(x: unknown): Parsed<OpsSuspendRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['reason'])
  if (extra) return bad(extra)
  if (!(SUSPEND_REASONS as readonly unknown[]).includes(x.reason)) return bad(`reason must be one of ${SUSPEND_REASONS.join(', ')}`)
  return { ok: true, value: { reason: x.reason as SuspendReason } }
}

/** at most 24 h of maintenance at a time (the control plane sets 15 minutes per update) */
export const MAX_MAINTENANCE_MS = 24 * 3600_000

export function parseMaintenanceRequest(x: unknown, now: number = Date.now()): Parsed<OpsMaintenanceRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['untilMs'])
  if (extra) return bad(extra)
  if (x.untilMs === null) return { ok: true, value: { untilMs: null } }
  if (!Number.isInteger(x.untilMs) || (x.untilMs as number) > now + MAX_MAINTENANCE_MS) return bad('untilMs: a millisecond timestamp at most 24 h ahead, or null')
  return { ok: true, value: { untilMs: x.untilMs as number } }
}

export function parseSleepRequest(x: unknown): Parsed<OpsSleepRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['sleeping'])
  if (extra) return bad(extra)
  if (typeof x.sleeping !== 'boolean') return bad('sleeping must be true or false')
  return { ok: true, value: { sleeping: x.sleeping } }
}

// ------------------------------------------------------------------ wake requests (relay -> control plane, F2)
//
// When a request arrives for a team whose VM sleeps, the relay asks the control plane to wake it:
//   POST {cp}/relay/v1/wake   body OpsWakeRequest   -> OpsWakeResponse
//   Authorization: MycelRelayWake key=<keyId>, ts=<ms>, sig=<base64>
//   sig = Ed25519 over wakeSigningString(path, ts, body) by the relay's wake key; the control plane pins the public
//   key (base64 SPKI). ts within ±60 s; the control plane refuses a signature again for 120 s (replay). Another domain
//   string than opsSigningString, so a signature of one API is never valid on the other.

export const WAKE_API_PATH = '/relay/v1/wake'
export interface OpsWakeRequest { teamId: string; reason: 'http' | 'ws' }
export interface OpsWakeResponse {
  /** waking: a wake runs now; awake: the VM does not sleep (the team server should connect soon); unknown: no such
   * hosted team or it cannot be woken (suspended, being deleted) */
  state: 'waking' | 'awake' | 'unknown'
  /** the client may ask again after this many seconds */
  retryAfterSec: number
}

export function wakeSigningString(pathWithQuery: string, ts: number, body: string): string {
  return `mycel-relay-wake-v1\nPOST\n${pathWithQuery}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`
}
export function wakeAuthorizationHeader(keyId: string, ts: number, sig: string): string {
  return `MycelRelayWake key=${keyId}, ts=${ts}, sig=${sig}`
}
export function parseWakeAuthorizationHeader(h: string | null | undefined): { keyId: string; ts: number; sig: string } | null {
  if (!h) return null
  const m = /^MycelRelayWake key=([A-Za-z0-9._-]{1,64}), ts=(\d{1,16}), sig=([A-Za-z0-9+/=]{1,200})$/.exec(h.trim())
  return m ? { keyId: m[1]!, ts: Number(m[2]), sig: m[3]! } : null
}
export function parseWakeRequest(x: unknown): Parsed<OpsWakeRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['teamId', 'reason'])
  if (extra) return bad(extra)
  const teamId = str(x, 'teamId', 64)
  if (!teamId || !/^[A-Za-z0-9_-]{1,64}$/.test(teamId)) return bad('teamId: 1-64 of A-Z a-z 0-9 _ -')
  if (x.reason !== 'http' && x.reason !== 'ws') return bad("reason must be 'http' or 'ws'")
  return { ok: true, value: { teamId, reason: x.reason } }
}

export function parseKeyRequest(x: unknown): Parsed<OpsKeyRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['publicKey', 'newKeySig'])
  if (extra) return bad(extra)
  const publicKey = str(x, 'publicKey', 200), newKeySig = str(x, 'newKeySig', 200)
  if (!publicKey || !B64_RE.test(publicKey)) return bad('publicKey must be base64')
  if (!newKeySig || !B64_RE.test(newKeySig)) return bad('newKeySig must be base64')
  return { ok: true, value: { publicKey, newKeySig } }
}

export function parseRenameRequest(x: unknown): Parsed<OpsRenameRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['name'])
  if (extra) return bad(extra)
  const name = str(x, 'name', 64)
  if (!name) return bad('name required')
  return { ok: true, value: { name } }
}

export function parseNoticeRequest(x: unknown): Parsed<OpsNoticeRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['level', 'code', 'message'])
  if (extra) return bad(extra)
  if (x.level !== 'info' && x.level !== 'warn') return bad("level must be 'info' or 'warn'")
  const code = str(x, 'code', 64), message = str(x, 'message', 500)
  if (!code || !NOTICE_CODE_RE.test(code)) return bad('code: 1-64 of a-z 0-9 _ . -')
  if (!message) return bad('message: 1-500 characters')
  return { ok: true, value: { level: x.level as 'info' | 'warn', code, message } }
}

export function parseClaimRequest(x: unknown): Parsed<OpsClaimRequest> {
  if (!isObj(x)) return bad('body must be a JSON object')
  const extra = onlyKeys(x, ['name', 'ttlSec', 'externalRef'])
  if (extra) return bad(extra)
  const name = str(x, 'name', 64), ttlSec = int(x, 'ttlSec', 60, MAX_CLAIM_TTL_SEC), externalRef = str(x, 'externalRef', 128)
  if (!name) return bad('name required')
  if (ttlSec === null) return bad(`ttlSec must be 60-${MAX_CLAIM_TTL_SEC}`)
  if (!externalRef || !EXTERNAL_REF_RE.test(externalRef)) return bad('externalRef: 1-128 of A-Z a-z 0-9 . _ : -')
  return { ok: true, value: { name, ttlSec, externalRef } }
}

/** Claim codes as people type them: groups of 4, case and separators ignored. */
export function normalizeClaimCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '')
}
