// Canonical strings and canonical JSON shared by the team server side (mycel-enroll, mycel-ctl, admin.js), the relay
// and the control plane. MIT (see LICENSE in this folder). Self-contained: node:crypto only, erasable TypeScript, so
// Node (the relay) can load it with type stripping and the control plane can copy the folder as is.
//
// Every string here is UTF-8 encoded before it is signed; signatures are Ed25519, base64 (standard alphabet, padded).
import { createHash } from 'node:crypto'

/** sha256 of a UTF-8 string (or bytes), lower-case hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The relay's registration string (identical to relay-protocol registerSigningString; a test keeps the two equal).
 * The team key signs it to prove it holds the key: public registration (POST /teams) and the operator API
 * (POST /ops/v1/teams) both check it. mycel-enroll sends it as relayProof { kind: 'register' }.
 */
export function registerSigningString(name: string, publicKey: string, ts: number): string {
  return `mycel-relay-register\n${name}\n${publicKey}\n${ts}`
}

/** The relay's key rotation string, signed by the NEW key (identical to relay-protocol keyRotationString). */
export function keyRotationString(teamId: string, publicKey: string): string {
  return `mycel-relay-rotate\n${teamId}\n${publicKey}`
}

/**
 * enroll mode 'reattach' (isolation §6.2 reimageTenant: new OS disk, same data disk): no enroll token, the tenant
 * proves itself with the relay key it already has. The control plane checks the signature against the public key it
 * recorded for the tenant (tenants.relay_public_key) and that ts is within ±5 minutes.
 */
export function reattachSigningString(tenantId: string, relayTeamId: string, ts: number): string {
  return `mycel-cloud-reattach-v1\n${tenantId}\n${relayTeamId}\n${ts}`
}
export const REATTACH_MAX_SKEW_MS = 5 * 60_000

/**
 * Canonical JSON (RFC 8785 subset that is enough for our documents): object keys sorted by UTF-16 code units, no
 * whitespace, strings and numbers as JSON.stringify writes them. Throws on values JSON cannot hold exactly
 * (undefined, functions, NaN / Infinity, bigint, non-plain objects). Use it whenever a JSON document is signed
 * (ax-hostd jobs' cpSig, isolation §6.1).
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null'
  switch (typeof v) {
    case 'boolean': return v ? 'true' : 'false'
    case 'string': return JSON.stringify(v)
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalJson: number must be finite')
      return JSON.stringify(v)
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects')
      const o = v as Record<string, unknown>
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
    }
    default:
      throw new TypeError(`canonicalJson: cannot encode ${typeof v}`)
  }
}
