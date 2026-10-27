// Relay registry HTTP API (design tab 6 "팀 등록·인증"): register a team address with the team server's Ed25519
// public key and a small proof of work, daily heartbeat, rename / key rotation, release. No personal data.
// Requests that act on an existing team are signed with the team key (header Authorization: MycelRelay ...).
import { createHash } from 'node:crypto'

/** Default proof-of-work difficulty in leading zero bits (the relay may ask for more or less: GET /teams/pow). */
export const DEFAULT_POW_BITS = 20
export const POW_MAX_AGE_MS = 10 * 60_000
/** A request signature is valid this long around its timestamp. */
export const API_SIG_MAX_SKEW_MS = 60_000
/** Released / renamed-away names are not given to another team for this long. */
export const NAME_HOLD_MS = 366 * 24 * 3600_000

export interface PowInfo {
  bits: number
  maxAgeMs: number
  /** false: public registration is closed (production relay); POST /teams needs a claim code. Absent = open (older relays). */
  open?: boolean
}

export interface RegisterRequest {
  name: string
  region?: string
  /** base64 SPKI DER of the Ed25519 public key */
  publicKey: string
  ts: number
  /** proof of work: sha256(registerSigningString(...) + "\n" + nonce) starts with `bits` zero bits (not needed with
   * a claim code) */
  nonce?: string
  /** base64 Ed25519 signature of registerSigningString(name, publicKey, ts) by that key */
  sig: string
  /**
   * claim code from the official relay add-on (control-plane 3.13): replaces the proof of work. A relay with closed
   * registration (RELAY_OPEN_REGISTRATION=0, the production relay) accepts only registrations that carry one.
   */
  claimCode?: string
}
export interface RegisterResponse {
  teamId: string
  name: string
  /** shown once; lets the owner rotate the key if the server's key is lost */
  recoveryCode: string
  /** https://<name>.<domain> */
  address: string
}
export interface HeartbeatRequest { version: string; members: number }
export interface UpdateTeamRequest {
  name?: string
  /** new base64 SPKI public key (key rotation) */
  publicKey?: string
  /** proof that the new key is held: signature of keyRotationString(teamId, publicKey) by the NEW key */
  newKeySig?: string
  /** instead of a signature by the current key (lost key) */
  recoveryCode?: string
}
export interface TeamInfo {
  teamId: string
  name: string
  status: 'active' | 'suspended' | 'released'
  address: string
  lastHeartbeatAt: string | null
}
export interface RegistryError { error: { code: RegistryErrorCode; message: string } }
export type RegistryErrorCode =
  | 'invalid_request' | 'invalid_name' | 'name_reserved' | 'name_taken' | 'key_in_use' | 'bad_pow' | 'bad_signature'
  | 'unauthorized' | 'not_found' | 'rate_limited' | 'suspended' | 'internal'
  /** closed registration (production relay) without a claim code / a claim code that is unknown, used, expired or
   * for another name / an operator API signature seen before / a request that clashes with the registry's state */
  | 'registration_closed' | 'bad_claim' | 'replayed' | 'conflict' | 'forbidden'

export function registerSigningString(name: string, publicKey: string, ts: number): string {
  return `mycel-relay-register\n${name}\n${publicKey}\n${ts}`
}
export function keyRotationString(teamId: string, publicKey: string): string {
  return `mycel-relay-rotate\n${teamId}\n${publicKey}`
}
/** What a signed API request signs: method, path, timestamp and the body hash. */
export function apiSigningString(method: string, path: string, ts: number, body: string): string {
  return `mycel-relay-api-v1\n${method.toUpperCase()}\n${path}\n${ts}\n${createHash('sha256').update(body).digest('hex')}`
}
export function authorizationHeader(teamId: string, ts: number, sig: string): string {
  return `MycelRelay team=${teamId}, ts=${ts}, sig=${sig}`
}
export function parseAuthorizationHeader(h: string | null | undefined): { team: string; ts: number; sig: string } | null {
  if (!h) return null
  const m = /^MycelRelay team=([A-Za-z0-9-]{1,64}), ts=(\d{1,16}), sig=([A-Za-z0-9+/=]{1,200})$/.exec(h.trim())
  return m ? { team: m[1], ts: Number(m[2]), sig: m[3] } : null
}

function leadingZeroBits(d: Uint8Array): number {
  let n = 0
  for (const byte of d) {
    if (byte === 0) { n += 8; continue }
    return n + Math.clz32(byte) - 24
  }
  return n
}
export function powInput(r: Pick<RegisterRequest, 'name' | 'publicKey' | 'ts'>, nonce: string): string {
  return `${registerSigningString(r.name, r.publicKey, r.ts)}\n${nonce}`
}
export function powOk(r: Pick<RegisterRequest, 'name' | 'publicKey' | 'ts'> & { nonce: string }, bits: number): boolean {
  if (!/^[A-Za-z0-9]{1,32}$/.test(r.nonce)) return false
  return leadingZeroBits(createHash('sha256').update(powInput(r, r.nonce)).digest()) >= bits
}
/** Find a nonce (about 2^bits hashes; 20 bits is well under a second). */
export function powSolve(r: Pick<RegisterRequest, 'name' | 'publicKey' | 'ts'>, bits: number): string {
  for (let i = 0; ; i++) {
    const nonce = i.toString(36)
    if (leadingZeroBits(createHash('sha256').update(powInput(r, nonce)).digest()) >= bits) return nonce
  }
}
