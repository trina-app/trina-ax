// The signatures a room app's service puts on what it sends (docs/DECISIONS.md "Apps posting in rooms" and "Apps in
// rooms: presets and JANDI"; plan docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md "Signature schemes").
// Signatures are optional (owner decision 4); once a secret is saved, a request without the right signature is refused
// (inbound.ts, 401). Every comparison is constant time over equal-length digests; every scheme is over the raw bytes
// except Tally's, which signs the re-serialised JSON.
//
// | scheme   | header                                                    | computed                                         |
// | hex-body | X-Hub-Signature-256 "sha256=<hex>" / Sentry-Hook-Signature | HMAC-SHA256(secret, raw) hex                     |
// | b64-body | Typeform-Signature "sha256=<b64>" / X-Shopify-Hmac-SHA256  | HMAC-SHA256(secret, raw) base64                  |
// | b64-json | Tally-Signature "<b64>"                                   | HMAC-SHA256(secret, raw), then over              |
// |          |                                                           | JSON.stringify(JSON.parse(raw)); base64          |
// | stripe   | Stripe-Signature "t=…,v1=…[,v1=…]"                        | HMAC-SHA256(secret, t + "." + raw) hex, any v1,  |
// |          |                                                           | |now − t| ≤ 5 min; the secret is the literal      |
// |          |                                                           | "whsec_…" string                                 |
// | zendesk  | X-Zendesk-Webhook-Signature "<b64>" +                     | HMAC-SHA256(secret, timestamp + raw) base64; the |
// |          | X-Zendesk-Webhook-Signature-Timestamp                     | timestamp ISO-8601 or Unix seconds, ≤ 5 min off  |
// | standard | webhook-id, webhook-timestamp, webhook-signature          | Standard Webhooks: HMAC-SHA256(base64-decoded    |
// |          | "v1,<b64> v1,<b64>"                                       | secret after whsec_, id + "." + ts + "." + raw), |
// |          |                                                           | any v1, |now − ts| ≤ 5 min (PortOne V2)          |
// | toss     | tosspayments-webhook-signature "v1:<b64>[,v1:<b64>]" +    | HMAC-SHA256(secret, raw + ":" + time) base64,    |
// |          | tosspayments-webhook-transmission-time                    | any v1, ≤ 5 min off; the key as text or its hex  |
// |          |                                                           | bytes (undocumented) (Toss Payments)             |
// | url-token| ?token=<the service's token> on the Webhook URL           | the saved token equals the query value (Channel  |
// |          |                                                           | Talk; no HMAC). Compared as SHA-256 digests      |
import crypto from 'node:crypto'

export type SignatureScheme = 'hex-body' | 'b64-body' | 'b64-json' | 'stripe' | 'zendesk' | 'standard' | 'toss' | 'url-token'
/** How far a signed timestamp (Stripe, Zendesk) may be from now. */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000

export interface SignatureInput {
  secret: string
  raw: Uint8Array
  headers: Headers
  /** the clock (ms) */
  now: number
  /** hex-body / b64-body: the header that carries it, and the prefix it starts with ("sha256=") */
  header?: string
  prefix?: string
  /** url-token: the request's query (never logged: http/middleware.ts loggablePath drops it on /in/) */
  query?: URLSearchParams
}
/** ok: the signature matched. `json`: for b64-json, the parsed body that was verified (the card must be built from
 * it, never from a second parse of the raw bytes). */
export type SignatureResult = { ok: true; json?: unknown } | { ok: false }

const hmac = (secret: string | Buffer, ...parts: (string | Uint8Array)[]) => {
  const h = crypto.createHmac('sha256', secret)
  for (const p of parts) h.update(p)
  return h.digest()
}
/** Constant-time comparison of a digest with what was given (decoded; a wrong length is a mismatch). */
function same(want: Buffer, given: Buffer | null): boolean {
  if (!given || given.length !== want.length) return false
  return crypto.timingSafeEqual(want, given)
}
const fromHex = (s: string) => (/^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : null)
/** Base64 (standard or url-safe, padded or not) of a 32-byte digest, else null. */
const fromB64 = (s: string) => {
  if (!/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(s)) return null
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return b.length === 32 ? b : null
}
const headerOf = (h: Headers, name: string, prefix = '') => {
  const v = (h.get(name) ?? '').trim()
  if (!v) return null
  if (!prefix) return v
  return v.toLowerCase().startsWith(prefix.toLowerCase()) ? v.slice(prefix.length).trim() : null
}

/** A Zendesk timestamp: ISO-8601 with a zone, or Unix seconds; anything else null. */
export function parseSignedTime(s: string): number | null {
  if (/^\d{9,11}$/.test(s)) return Number(s) * 1000
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : null
  }
  return null
}

export function verifySignature(scheme: SignatureScheme, i: SignatureInput): SignatureResult {
  switch (scheme) {
    case 'hex-body': {
      const given = headerOf(i.headers, i.header!, i.prefix)
      return { ok: same(hmac(i.secret, i.raw), given ? fromHex(given) : null) }
    }
    case 'b64-body': {
      const given = headerOf(i.headers, i.header!, i.prefix)
      return { ok: same(hmac(i.secret, i.raw), given ? fromB64(given) : null) }
    }
    case 'b64-json': {
      const given = headerOf(i.headers, 'tally-signature')
      const g = given ? fromB64(given) : null
      if (!g) return { ok: false }
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(i.raw)) } catch { return { ok: false } }
      // the raw bytes first; then Tally's own way, JSON.stringify of the parsed body. Either way the card is built from
      // this one parse (duplicate keys can't make the shown content differ from what was signed)
      if (same(hmac(i.secret, i.raw), g)) return { ok: true, json: parsed }
      return same(hmac(i.secret, JSON.stringify(parsed)), g) ? { ok: true, json: parsed } : { ok: false }
    }
    case 'stripe': {
      const v = headerOf(i.headers, 'stripe-signature')
      if (!v) return { ok: false }
      let t: string | null = null
      const v1: Buffer[] = []
      for (const part of v.split(',').slice(0, 20)) {
        const eq = part.indexOf('=')
        if (eq < 0) continue
        const k = part.slice(0, eq).trim(), val = part.slice(eq + 1).trim()
        if (k === 't' && t === null) t = val
        else if (k === 'v1') { const b = fromHex(val); if (b) v1.push(b) }
        // v0 and anything newer: ignored
      }
      if (!t || !/^\d{1,12}$/.test(t) || !v1.length) return { ok: false }
      if (Math.abs(i.now - Number(t) * 1000) > SIGNATURE_TOLERANCE_MS) return { ok: false }
      const want = hmac(i.secret, `${t}.`, i.raw)
      // every v1 is compared (no early exit on the first match)
      let ok = false
      for (const b of v1) ok = same(want, b) || ok
      return { ok }
    }
    case 'zendesk': {
      const given = headerOf(i.headers, 'x-zendesk-webhook-signature')
      const ts = headerOf(i.headers, 'x-zendesk-webhook-signature-timestamp')
      if (!given || !ts || ts.length > 40) return { ok: false }
      const at = parseSignedTime(ts)
      if (at === null || Math.abs(i.now - at) > SIGNATURE_TOLERANCE_MS) return { ok: false }
      return { ok: same(hmac(i.secret, ts, i.raw), fromB64(given)) }
    }
    case 'standard': {
      // https://www.standardwebhooks.com/ (PortOne V2): the secret is "whsec_" + base64 of the key
      const id = headerOf(i.headers, 'webhook-id')
      const ts = headerOf(i.headers, 'webhook-timestamp')
      const sigs = headerOf(i.headers, 'webhook-signature')
      if (!id || id.length > 200 || !ts || !/^\d{1,12}$/.test(ts) || !sigs) return { ok: false }
      if (Math.abs(i.now - Number(ts) * 1000) > SIGNATURE_TOLERANCE_MS) return { ok: false }
      const key = standardKey(i.secret)
      if (!key) return { ok: false }
      const want = hmac(key, `${id}.${ts}.`, i.raw)
      let ok = false
      for (const part of sigs.split(' ').slice(0, 20)) {
        const [v, sig] = part.split(',', 2)
        if (v === 'v1' && sig) ok = same(want, fromB64(sig)) || ok
      }
      return { ok }
    }
    case 'toss': {
      const sigs = headerOf(i.headers, 'tosspayments-webhook-signature')
      const time = headerOf(i.headers, 'tosspayments-webhook-transmission-time')
      if (!sigs || !time || time.length > 40) return { ok: false }
      const at = parseSignedTime(time) ?? Date.parse(time)
      if (!Number.isFinite(at) || Math.abs(i.now - at) > SIGNATURE_TOLERANCE_MS) return { ok: false }
      // the security key is 64 hex characters; whether Toss keys the HMAC with the text or its bytes is not documented
      // (live check): both are tried, each from the same saved secret
      const keys: (string | Buffer)[] = [i.secret]
      if (/^[0-9a-fA-F]{64}$/.test(i.secret)) keys.push(Buffer.from(i.secret, 'hex'))
      const wants = keys.map((k) => hmac(k, i.raw, `:${time}`))
      let ok = false
      for (const part of sigs.split(',').slice(0, 20)) {
        const p = part.trim()
        if (!p.startsWith('v1:')) continue
        const given = fromB64(p.slice(3))
        for (const w of wants) ok = same(w, given) || ok
      }
      return { ok }
    }
    case 'url-token': {
      const given = i.query?.getAll('token') ?? []
      // exactly one token; compared as digests (equal length, constant time)
      if (given.length !== 1 || !given[0]) return { ok: false }
      const d = (s: string) => crypto.createHash('sha256').update(s).digest()
      return { ok: crypto.timingSafeEqual(d(i.secret), d(given[0])) }
    }
  }
}

/** Standard Webhooks' key: the base64 after "whsec_" (PortOne's SDK takes it with or without the prefix; at least 16
 * bytes), else null. */
export function standardKey(secret: string): Buffer | null {
  const m = /^(?:whsec_)?([A-Za-z0-9+/]+={0,2})$/.exec(secret.trim())
  if (!m) return null
  const b = Buffer.from(m[1]!, 'base64')
  return b.length >= 16 ? b : null
}
