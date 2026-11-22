// Google's id_token, checked by this server itself (Sign in with Google through the hosting service, part B of
// docs/AGENTS/plan/20261122-0454-google-login.md). The hosting service only relays Google's raw id_token, so its
// signature is checked here against Google's own keys: the hosting service can pass a sign-in on, never make one up.
//
// Keys: Google's JWKS (GOOGLE_CERTS), fetched through the allow-listed Google transport (google-drive/client.ts: that
// one address, no redirects, a size cap, no body or address in an error), kept by `kid` for KEYS_TTL_MS. A `kid` not in
// the list fetches it again (Google adds a new key before it signs with it), at most once per REFETCH_MIN_MS, so a
// flood of made-up kids never turns into a flood of requests to Google. When Google cannot be reached, a list fetched
// in the last STALE_MAX_MS still counts.
import crypto, { type KeyObject } from 'node:crypto'
import { GOOGLE_CERTS, type GoogleTransport } from '../integrations/google-drive/client'
import { googleClaims, type GoogleClaims } from './google-login'

export const KEYS_TTL_MS = 60 * 60_000
export const REFETCH_MIN_MS = 60_000
export const STALE_MAX_MS = 24 * 60 * 60_000
const KEYS_MAX = 20
const B64URL = /^[A-Za-z0-9_-]+$/

/** Google's id_token signing keys, by kid. */
export class GoogleKeys {
  private keys = new Map<string, KeyObject>()
  private fetchedAt = 0
  private triedAt = 0
  private loading: Promise<void> | null = null
  constructor(private readonly transport: GoogleTransport, private readonly now: () => number = Date.now) {}

  /** The RSA key Google signs with under this kid, or null (unknown, Google not reachable, or asked again too soon). */
  async get(kid: string): Promise<KeyObject | null> {
    const now = this.now()
    const fresh = this.fetchedAt > 0 && now - this.fetchedAt < KEYS_TTL_MS
    if (fresh && this.keys.has(kid)) return this.keys.get(kid)!
    if (now - this.triedAt >= REFETCH_MIN_MS) await this.load()
    if (this.fetchedAt > 0 && this.now() - this.fetchedAt < STALE_MAX_MS) return this.keys.get(kid) ?? null
    return null
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      this.triedAt = this.now()
      try {
        const json = await this.transport.json(GOOGLE_CERTS, { method: 'GET', headers: { accept: 'application/json' } }, 65_536)
        const keys = parseJwks(json)
        if (keys.size) { this.keys = keys; this.fetchedAt = this.now() }
      } catch { /* the earlier list stays (STALE_MAX_MS) */ }
    })().finally(() => { this.loading = null })
    return this.loading
  }
}

/** The RS256 keys of a JWKS answer, by kid (at most KEYS_MAX, each at least 2048 bits). */
export function parseJwks(json: unknown): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>()
  const list = json && typeof json === 'object' && Array.isArray((json as { keys?: unknown }).keys) ? (json as { keys: unknown[] }).keys : []
  for (const k of list.slice(0, KEYS_MAX)) {
    if (!k || typeof k !== 'object') continue
    const j = k as Record<string, unknown>
    if (j.kty !== 'RSA' || typeof j.kid !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(j.kid)) continue
    if ((j.alg !== undefined && j.alg !== 'RS256') || (j.use !== undefined && j.use !== 'sig')) continue
    if (typeof j.n !== 'string' || typeof j.e !== 'string' || !B64URL.test(j.n) || !B64URL.test(j.e)) continue
    try {
      const key = crypto.createPublicKey({ key: { kty: 'RSA', n: j.n, e: j.e }, format: 'jwk' })
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) out.set(j.kid, key)
    } catch { /* not a key */ }
  }
  return out
}

/** The claims of an id_token when Google signed it (RS256, a key of Google's list) AND it is for this client, live,
 * for this flow's nonce and its address verified (googleClaims: iss, aud, azp, exp, nonce, email_verified); else null. */
export async function verifyGoogleIdToken(keys: GoogleKeys, idToken: unknown, o: { clientId: string; nonce: string; now: number }): Promise<GoogleClaims | null> {
  if (typeof idToken !== 'string' || idToken.length > 8192) return null
  const parts = idToken.split('.')
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null
  let header: Record<string, unknown>
  try { header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) } catch { return null }
  if (!header || typeof header !== 'object' || header.alg !== 'RS256' || typeof header.kid !== 'string') return null
  // nothing the verifier would have to understand first (RFC 7515 crit), no key carried in the token itself
  if ('crit' in header || 'jwk' in header || 'jku' in header || 'x5u' in header || 'x5c' in header) return null
  const key = await keys.get(header.kid)
  if (!key) return null
  let ok = false
  try { ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url')) } catch { ok = false }
  if (!ok) return null
  return googleClaims(idToken, o.clientId, o.nonce, o.now)
}
