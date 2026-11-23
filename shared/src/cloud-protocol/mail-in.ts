// Mail in (email into rooms, plan docs/AGENTS/plan/20261123-0421-room-email.md): the contract between a team server
// and the hosting service's mailbox. Mail forwarded to a room's address (`<random>@<mail domain>`) arrives at the mail
// gateway (an Email Worker, reference code in mailbox/), is sealed to the team's own key and waits in the team's queue;
// the team server pulls it with a signed long poll (no public address needed) and posts it as a card in the room.
// MIT (see LICENSE in this folder).
//
// NO imports at all, erasable TypeScript only: the team server, the mailbox and the control plane load this file as it
// is. The caller does the cryptography itself (node:crypto or WebCrypto): sha256, Ed25519, X25519, HKDF and AES-GCM,
// exactly as written below; the test vectors are in vectors/mail-in.json.
//
// Who holds what:
//   - The team server makes each address: 26 random lowercase base32 characters (MAIL_IN_LOCAL_RE) @ the mail domain.
//     It sends the mailbox only the address's hash (mailInHash), never the address. The mailbox keeps, per team: the
//     team's seal key (X25519 public key), the hashes it accepts mail for, and the sealed items not taken yet.
//   - The gateway reads each mail in clear in memory (SMTP has no end-to-end encryption), removes every
//     Authentication-Results and ARC-* header, seals the raw message to the team's seal key and stores only the
//     sealed item. An item waits at most MAIL_IN_ITEM_TTL_MS; an acknowledged item is deleted at once.
//   - The team server opens items with its private key (in its credentials vault) and drops an item whose hash is not
//     one of its current addresses (an address given a new one, or removed, posts nothing from then on).
//
// Identity: every API call is signed with the team server's relay team key, as for the Slack and Drive brokers, with
// its own signing string (a signature of one never verifies at another).
//
// Flows (all POST {api}/…, signed, JSON, strict):
//   0. status   {}                       → { ok, domain, sealKey | null, addresses }
//   1. key      { sealKey }              → { ok }   the team's X25519 public key (raw 32 bytes, base64url)
//   2. sync     { hashes }               → { ok, addresses }
//      The complete set of addresses the team takes mail for now (at most MAIL_IN_MAX_ADDRESSES). The mailbox replaces
//      its set with it at once: a hash left out is refused at SMTP from that moment (550), new mail only; items already
//      queued stay. An empty set stops all mail for the team (the admin switch off).
//   3. poll     { ack, waitMs }          → { items, expired }
//      Long poll: answered at once when an item waits, else after `waitMs` (at most MAIL_IN_POLL_MAX_WAIT_MS) with none.
//      `ack`: ids this server has taken (deleted at once). An item handed out and not acknowledged comes again after
//      MAIL_IN_LEASE_MS (at least once; the team server handles an item id once). One answer holds at most
//      MAIL_IN_POLL_MAX_ITEMS items and MAIL_IN_POLL_MAX_BYTES of `ct` (always at least one item when one waits).
//      `expired`: items dropped unread since the last poll (too old), for the status line.
//
// Request:  POST, body = JSON (at most MAIL_IN_MAX_BODY_BYTES), header
//           Authorization: TrinaMailIn key=<base64 SPKI Ed25519 public key>, ts=<unix ms>, nonce=<22-64 base64url>,
//                          sig=<base64 signature>
//           sig = Ed25519 over mailInSigningString(path, ts, nonce, sha256 hex of the exact body bytes), UTF-8.
// Replay:   ts within ±MAIL_IN_MAX_SKEW_MS of the mailbox clock; the same (key, nonce) is refused twice.
// Errors:   JSON { error: { code, message } } with the status in MAIL_IN_ERRORS; never a mail, an address or a key.
//
// Sealed item (MailInSealed), `alg` MAIL_IN_SEAL_ALG, to the team's seal key:
//     the gateway makes a fresh X25519 pair per item (raw public key = `epk`)
//     shared = X25519(its private key, team seal key)
//     key    = HKDF-SHA256(ikm = shared, salt = epk raw bytes ‖ seal key raw bytes, info = MAIL_IN_SEAL_INFO, 32 bytes)
//     ct     = AES-256-GCM(key, iv = 12 random bytes, plaintext, additional data = mailInSealAad(id, hash, receivedAt))
//              ‖ the 16-byte tag
//     plaintext = UTF-8 JSON of MailInMeta, one 0x0A byte, then the raw RFC 822 message bytes (auth headers removed)
//   so an item cannot be moved to another id, address or time.

export const MAIL_IN_API_PREFIX = '/api/mail-in/v1'
export const MAIL_IN_PATHS = {
  status: `${MAIL_IN_API_PREFIX}/status`,
  key: `${MAIL_IN_API_PREFIX}/key`,
  sync: `${MAIL_IN_API_PREFIX}/sync`,
  poll: `${MAIL_IN_API_PREFIX}/poll`,
} as const
export type MailInOp = keyof typeof MAIL_IN_PATHS

/** The random part of an address: 26 characters of lowercase base32 (130 bits). Mail addresses are case-insensitive in
 * practice, so lowercase only. */
export const MAIL_IN_LOCAL_RE = /^[a-z2-7]{26}$/
export const MAIL_IN_LOCAL_LENGTH = 26
/** A hash of an address: lowercase hex sha256 of the local part (lowercase, no "@"). */
export const MAIL_IN_HASH_RE = /^[0-9a-f]{64}$/
export const MAIL_IN_ITEM_ID_RE = /^[A-Za-z0-9_-]{16,64}$/

export const MAIL_IN_MAX_BODY_BYTES = 131_072
export const MAIL_IN_MAX_SKEW_MS = 60_000
export const MAIL_IN_MAX_ADDRESSES = 1000
export const MAIL_IN_POLL_MAX_WAIT_MS = 25_000
export const MAIL_IN_POLL_MAX_ITEMS = 20
/** the sum of `ct` lengths (base64url characters) in one poll answer; one bigger item still goes alone */
export const MAIL_IN_POLL_MAX_BYTES = 16 * 1024 * 1024
/** what a team server reads of one poll answer, at most (one item of MAIL_IN_RAW_MAX sealed and base64url, and JSON) */
export const MAIL_IN_ANSWER_MAX_BYTES = 40 * 1024 * 1024
export const MAIL_IN_ACK_MAX = 100
export const MAIL_IN_LEASE_MS = 60_000
export const MAIL_IN_ITEM_TTL_MS = 24 * 3_600_000

/** One mail at the gateway, at most (larger: SMTP 552). Cloudflare Email Routing takes up to 25 MiB. */
export const MAIL_IN_RAW_MAX = 10 * 1024 * 1024
/** Limits at the gateway (over them: SMTP 451, the sender tries again later). */
export const MAIL_IN_PER_ADDRESS_HOUR = 60
export const MAIL_IN_PER_ADDRESS_DAY = 300
export const MAIL_IN_PER_TEAM_DAY = 2000
export const MAIL_IN_PER_TEAM_DAY_BYTES = 200 * 1024 * 1024
/** Items held per team, at most (over them: SMTP 452, the sender tries again later). */
export const MAIL_IN_QUEUE_MAX_ITEMS = 2000
export const MAIL_IN_QUEUE_MAX_BYTES = 200 * 1024 * 1024

/** What the gateway answers at SMTP, by case (the text is the same for every refusal of one kind). */
export const MAIL_IN_SMTP = {
  unknown: '550 5.1.1 No such address',
  too_big: '552 5.3.4 Message too big for this address',
  limited: '451 4.7.1 Too many messages, try again later',
  full: '452 4.2.2 Mailbox full, try again later',
} as const

export const MAIL_IN_SEAL_ALG = 'X25519-HKDF-SHA256-A256GCM'
export const MAIL_IN_SEAL_INFO = 'trina-mail-in-item-v1'
export const mailInSealAad = (id: string, hash: string, receivedAt: string) => `${MAIL_IN_SEAL_INFO}|${id}|${hash}|${receivedAt}`

export interface MailInStatus { v: 1 }
export interface MailInKey { v: 1; sealKey: string }
export interface MailInSync { v: 1; hashes: string[] }
export interface MailInPoll { v: 1; ack: string[]; waitMs: number }

export interface MailInSealed { alg: typeof MAIL_IN_SEAL_ALG; epk: string; iv: string; ct: string }
/** One mail in a poll answer. `size`: the raw message's bytes. */
export interface MailInItem { id: string; hash: string; receivedAt: string; size: number; sealed: MailInSealed }
/** The sealed plaintext's head. `envelopeFrom`: the SMTP MAIL FROM (forwarders rewrite it: never shown as the sender);
 * `auth`: what the gateway's own checks said, when it could read them (null: unknown). */
export interface MailInMeta { v: 1; envelopeFrom: string; to: string; size: number; auth: { spf?: string; dkim?: string; dmarc?: string } | null }

export interface MailInStatusAnswer { ok: true; domain: string; sealKey: string | null; addresses: number }
export interface MailInSyncAnswer { ok: true; addresses: number }
export interface MailInPollAnswer { items: MailInItem[]; expired: number }

export const MAIL_IN_ERRORS = {
  /** body is not JSON, too large, or not exactly the request of that path */
  invalid_request: 400,
  /** Authorization header missing or malformed, the signature does not verify, ts too far off, or a replay */
  unauthorized: 401,
  /** the key is not the key of a team the mailbox serves now */
  not_hosted: 403,
  /** poll before key: the team has no seal key at the mailbox yet */
  no_key: 409,
  /** too many calls of this team; try again later */
  rate_limited: 429,
  /** the mailbox has no mail domain configured */
  not_configured: 503,
} as const
export type MailInErrorCode = keyof typeof MAIL_IN_ERRORS

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exactly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o)
const b43 = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s)

export function parseMailInStatus(raw: unknown): MailInStatus | null {
  return isObj(raw) && exactly(raw, ['v']) && raw.v === 1 ? { v: 1 } : null
}
export function parseMailInKey(raw: unknown): MailInKey | null {
  return isObj(raw) && exactly(raw, ['v', 'sealKey']) && raw.v === 1 && b43(raw.sealKey) ? { v: 1, sealKey: raw.sealKey } : null
}
export function parseMailInSync(raw: unknown): MailInSync | null {
  if (!isObj(raw) || !exactly(raw, ['v', 'hashes']) || raw.v !== 1 || !Array.isArray(raw.hashes) || raw.hashes.length > MAIL_IN_MAX_ADDRESSES) return null
  if (!raw.hashes.every((h) => typeof h === 'string' && MAIL_IN_HASH_RE.test(h))) return null
  return { v: 1, hashes: [...new Set(raw.hashes as string[])] }
}
export function parseMailInPoll(raw: unknown): MailInPoll | null {
  if (!isObj(raw) || !exactly(raw, ['v', 'ack', 'waitMs']) || raw.v !== 1 || !Array.isArray(raw.ack) || raw.ack.length > MAIL_IN_ACK_MAX) return null
  if (!raw.ack.every((a) => typeof a === 'string' && MAIL_IN_ITEM_ID_RE.test(a))) return null
  if (typeof raw.waitMs !== 'number' || !Number.isInteger(raw.waitMs) || raw.waitMs < 0 || raw.waitMs > MAIL_IN_POLL_MAX_WAIT_MS) return null
  return { v: 1, ack: raw.ack as string[], waitMs: raw.waitMs }
}

export function parseMailInSealed(raw: unknown): MailInSealed | null {
  if (!isObj(raw) || !exactly(raw, ['alg', 'epk', 'iv', 'ct']) || raw.alg !== MAIL_IN_SEAL_ALG) return null
  if (!b43(raw.epk) || typeof raw.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(raw.iv)) return null
  // the raw message (≤ MAIL_IN_RAW_MAX), its head and the tag, in base64url
  if (typeof raw.ct !== 'string' || raw.ct.length < 24 || raw.ct.length > Math.ceil((MAIL_IN_RAW_MAX + 4096) * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(raw.ct)) return null
  return { alg: MAIL_IN_SEAL_ALG, epk: raw.epk, iv: raw.iv, ct: raw.ct }
}
export function parseMailInItem(raw: unknown): MailInItem | null {
  if (!isObj(raw) || !exactly(raw, ['id', 'hash', 'receivedAt', 'size', 'sealed'])) return null
  if (typeof raw.id !== 'string' || !MAIL_IN_ITEM_ID_RE.test(raw.id) || typeof raw.hash !== 'string' || !MAIL_IN_HASH_RE.test(raw.hash)) return null
  if (typeof raw.receivedAt !== 'string' || raw.receivedAt.length > 40 || !Number.isFinite(Date.parse(raw.receivedAt))) return null
  if (typeof raw.size !== 'number' || !Number.isInteger(raw.size) || raw.size < 0 || raw.size > MAIL_IN_RAW_MAX) return null
  const sealed = parseMailInSealed(raw.sealed)
  return sealed ? { id: raw.id, hash: raw.hash, receivedAt: raw.receivedAt, size: raw.size, sealed } : null
}
export function parseMailInMeta(raw: unknown): MailInMeta | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.envelopeFrom !== 'string' || raw.envelopeFrom.length > 512 || typeof raw.to !== 'string' || raw.to.length > 512) return null
  if (typeof raw.size !== 'number' || !Number.isInteger(raw.size) || raw.size < 0) return null
  let auth: MailInMeta['auth'] = null
  if (isObj(raw.auth)) {
    const pick = (k: string) => typeof (raw.auth as Record<string, unknown>)[k] === 'string' && /^[a-z]{1,20}$/.test((raw.auth as Record<string, string>)[k]!) ? (raw.auth as Record<string, string>)[k] : undefined
    auth = { ...(pick('spf') ? { spf: pick('spf') } : {}), ...(pick('dkim') ? { dkim: pick('dkim') } : {}), ...(pick('dmarc') ? { dmarc: pick('dmarc') } : {}) }
  }
  return { v: 1, envelopeFrom: raw.envelopeFrom, to: raw.to, size: raw.size, auth }
}

/** The UTF-8 string the team key signs. path: one of MAIL_IN_PATHS; bodySha256Hex: lower-case hex sha256 of the exact
 * request body bytes. */
export function mailInSigningString(path: string, ts: number, nonce: string, bodySha256Hex: string): string {
  return `trina-mail-in-v1\nPOST\n${path}\n${ts}\n${nonce}\n${bodySha256Hex}`
}
export function mailInAuthorization(key: string, ts: number, nonce: string, sig: string): string {
  return `TrinaMailIn key=${key}, ts=${ts}, nonce=${nonce}, sig=${sig}`
}
const AUTH_RE = /^TrinaMailIn key=([A-Za-z0-9+/]{1,200}={0,2}), ts=(\d{1,16}), nonce=([A-Za-z0-9_-]{22,64}), sig=([A-Za-z0-9+/]{1,200}={0,2})$/
export function parseMailInAuthorization(header: string | null | undefined): { key: string; ts: number; nonce: string; sig: string } | null {
  if (typeof header !== 'string' || header.length > 600) return null
  const m = AUTH_RE.exec(header.trim())
  if (!m) return null
  const ts = Number(m[2])
  return Number.isSafeInteger(ts) ? { key: m[1]!, ts, nonce: m[3]!, sig: m[4]! } : null
}

/** The local part of a recipient address when it has the shape of one of ours (lowercased; a "+tag" is not taken),
 * else null. The domain is the caller's check. */
export function mailInLocalOf(address: string): string | null {
  if (typeof address !== 'string' || address.length > 320) return null
  const at = address.lastIndexOf('@')
  if (at <= 0) return null
  const local = address.slice(0, at).toLowerCase()
  return MAIL_IN_LOCAL_RE.test(local) ? local : null
}
