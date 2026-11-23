// The mail gateway (shared/src/cloud-protocol/mail-in.ts, plan docs/AGENTS/plan/20261123-0421-room-email.md section 2):
// what the Email Worker does with each mail. Checks, in this order, each with its fixed SMTP answer (MAIL_IN_SMTP):
//   1. the recipient is one of ours: the mail domain and a local part of the address shape whose hash a team holds now
//      (550; the same answer for an unknown, a removed and a replaced address)
//   2. the size (552)
//   3. the team's queue has room (452: the sender tries again later)
//   4. the limits per address and per team (451: the sender tries again later)
// Then: every Authentication-Results and ARC-* header of the top-level header block is removed (a sender can write
// them; only the receiving service's own verdict, the topmost header with its authserv-id, goes into the sealed meta),
// the message is sealed to the team's key and queued; a held poll of that team wakes.
// Logs carry a hash prefix and a reason only: never the address (its local part is the secret) or the mail.
import {
  MAIL_IN_ITEM_TTL_MS, MAIL_IN_PER_ADDRESS_DAY, MAIL_IN_PER_ADDRESS_HOUR, MAIL_IN_PER_TEAM_DAY, MAIL_IN_PER_TEAM_DAY_BYTES,
  MAIL_IN_QUEUE_MAX_BYTES, MAIL_IN_QUEUE_MAX_ITEMS, MAIL_IN_RAW_MAX, MAIL_IN_SMTP, mailInLocalOf, mailInSealAad,
  type MailInItem, type MailInMeta,
} from '../../shared/src/cloud-protocol/mail-in.ts'
import type { MailboxDeps } from './deps.ts'

export const DEFAULT_AUTHSERV_ID = 'mx.cloudflare.net'
const HOUR = 3_600_000
const DAY = 86_400_000

export interface IncomingMail {
  /** the SMTP RCPT TO (one recipient: Email Routing calls the Worker once per recipient) */
  to: string
  /** the SMTP MAIL FROM */
  from: string
  raw: Uint8Array
  /** the size the receiving service reports (checked before the bytes are read) */
  rawSize?: number
}
export type ReceiveResult =
  | { accepted: true; id: string; teamId: string }
  | { accepted: false; reason: keyof typeof MAIL_IN_SMTP; smtp: string }

const refuse = (reason: keyof typeof MAIL_IN_SMTP): ReceiveResult => ({ accepted: false, reason, smtp: MAIL_IN_SMTP[reason] })

// ---------------- headers ----------------
/** bytes ↔ a string of one char per byte (keeps every byte as it is) */
const binStr = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s }
const strBin = (s: string) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u }

/** Where the top-level header block ends: the index of the blank line that ends it (the body starts there), or the
 * message's length when it has no body. The block includes the line ending of its last field. */
export function headerEnd(raw: Uint8Array): number {
  if (raw[0] === 0x0a) return 0
  if (raw[0] === 0x0d && raw[1] === 0x0a) return 0
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] !== 0x0a) continue
    if (raw[i + 1] === 0x0a) return i + 1
    if (raw[i + 1] === 0x0d && raw[i + 2] === 0x0a) return i + 1
  }
  return raw.length
}

/** Remove every Authentication-Results and ARC-* field (with its folded lines) from the top-level header block.
 * `removedAuth`: the unfolded values of the Authentication-Results fields, top first. The body is not touched. */
export function stripAuthHeaders(raw: Uint8Array): { raw: Uint8Array; removedAuth: string[]; removed: number } {
  const end = headerEnd(raw)
  const head = binStr(raw.subarray(0, end))
  const lines = head.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const fields: string[][] = []
  for (const l of lines) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && fields.length) fields[fields.length - 1]!.push(l)
    else fields.push([l])
  }
  const kept: string[] = []
  const removedAuth: string[] = []
  let removed = 0
  for (const f of fields) {
    const first = f[0]!
    const colon = first.indexOf(':')
    const name = colon > 0 ? first.slice(0, colon).trim().toLowerCase() : ''
    if (name === 'authentication-results' || name.startsWith('arc-')) {
      removed++
      if (name === 'authentication-results') removedAuth.push(f.join('').slice(colon + 1).replace(/\r?\n[ \t]+/g, ' ').trim())
      continue
    }
    kept.push(f.join(''))
  }
  if (!removed) return { raw, removedAuth, removed }
  const nextHead = strBin(kept.join(''))
  const out = new Uint8Array(nextHead.length + raw.length - end)
  out.set(nextHead, 0)
  out.set(raw.subarray(end), nextHead.length)
  return { raw: out, removedAuth, removed }
}

/** The receiving service's verdict: only the TOPMOST Authentication-Results field (the receiving service prepends its
 * own) and only when its authserv-id is `authServId`; else null (unknown). */
export function authVerdict(removedAuth: string[], authServId: string): MailInMeta['auth'] {
  const top = removedAuth[0]
  if (!top) return null
  const id = top.split(';')[0]!.trim().split(/\s+/)[0]!.toLowerCase()
  if (id !== authServId.toLowerCase()) return null
  const out: { spf?: string; dkim?: string; dmarc?: string } = {}
  for (const m of top.matchAll(/(?:^|[;\s])(spf|dkim|dmarc)=([a-z]{1,20})\b/gi)) {
    const k = m[1]!.toLowerCase() as 'spf' | 'dkim' | 'dmarc'
    if (!(k in out)) out[k] = m[2]!.toLowerCase()
  }
  return out
}

// ---------------- limits ----------------
const keys = (hash: string, teamId: string, now: number) => {
  const h = Math.floor(now / HOUR), d = Math.floor(now / DAY)
  return { addrHour: `a:${hash}:h:${h}`, addrDay: `a:${hash}:d:${d}`, teamDay: `t:${teamId}:d:${d}`, teamBytes: `t:${teamId}:b:${d}` }
}
/** A counter key is old when its window is before the previous one (the current window and the one before stay). */
export function counterIsOld(key: string, now: number): boolean {
  const m = /:(h|d|b):(\d+)$/.exec(key)
  if (!m) return true
  const n = Number(m[2])
  return m[1] === 'h' ? n < Math.floor(now / HOUR) - 1 : n < Math.floor(now / DAY) - 1
}

// ---------------- the path ----------------
export async function receiveMail(deps: MailboxDeps, mail: IncomingMail): Promise<ReceiveResult> {
  const { store, crypto } = deps
  const now = deps.now()
  const log = (event: string, f: Record<string, string | number>) => { try { deps.log?.(event, f) } catch { /* logging only */ } }
  // 1. ours
  const domain = deps.domain?.toLowerCase() ?? null
  const at = mail.to.lastIndexOf('@')
  const local = mailInLocalOf(mail.to)
  if (!domain || at < 0 || mail.to.slice(at + 1).toLowerCase() !== domain || !local) { log('mail_refused', { reason: 'unknown' }); return refuse('unknown') }
  const hash = await crypto.sha256Hex(local)
  const teamId = await store.teamOfHash(hash)
  const team = teamId ? await store.team(teamId) : null
  if (!teamId || !team?.sealKey || !team.hashes.includes(hash)) { log('mail_refused', { reason: 'unknown', hash: hash.slice(0, 8) }); return refuse('unknown') }
  // 2. size (the reported size first: the bytes need not be read)
  if ((mail.rawSize ?? 0) > MAIL_IN_RAW_MAX || mail.raw.length > MAIL_IN_RAW_MAX) { log('mail_refused', { reason: 'too_big', hash: hash.slice(0, 8) }); return refuse('too_big') }
  // 3. room in the queue (old items go first)
  await store.expire(teamId, now, MAIL_IN_ITEM_TTL_MS)
  const q = await store.queueStats(teamId)
  const estimate = Math.ceil((mail.raw.length + 1024) * 4 / 3)
  if (q.items + 1 > MAIL_IN_QUEUE_MAX_ITEMS || q.bytes + estimate > MAIL_IN_QUEUE_MAX_BYTES) { log('mail_refused', { reason: 'full', hash: hash.slice(0, 8) }); return refuse('full') }
  // 4. limits
  const k = keys(hash, teamId, now)
  const over = (await store.bump(k.addrHour, 0)) + 1 > MAIL_IN_PER_ADDRESS_HOUR
    || (await store.bump(k.addrDay, 0)) + 1 > MAIL_IN_PER_ADDRESS_DAY
    || (await store.bump(k.teamDay, 0)) + 1 > MAIL_IN_PER_TEAM_DAY
    || (await store.bump(k.teamBytes, 0)) + mail.raw.length > MAIL_IN_PER_TEAM_DAY_BYTES
  if (over) { log('mail_refused', { reason: 'limited', hash: hash.slice(0, 8) }); return refuse('limited') }
  // the message as sealed: without authentication headers anyone could have written
  const stripped = stripAuthHeaders(mail.raw)
  const meta: MailInMeta = {
    v: 1, envelopeFrom: mail.from.slice(0, 512), to: mail.to.slice(0, 512), size: stripped.raw.length,
    auth: authVerdict(stripped.removedAuth, deps.authServId ?? DEFAULT_AUTHSERV_ID),
  }
  const headBytes = new TextEncoder().encode(JSON.stringify(meta) + '\n')
  const plaintext = new Uint8Array(headBytes.length + stripped.raw.length)
  plaintext.set(headBytes, 0)
  plaintext.set(stripped.raw, headBytes.length)
  const id = crypto.randomId()
  const receivedAt = new Date(now).toISOString()
  const sealed = await crypto.seal(team.sealKey, plaintext, mailInSealAad(id, hash, receivedAt))
  const item: MailInItem = { id, hash, receivedAt, size: stripped.raw.length, sealed }
  await store.putItem(teamId, item, now)
  await store.bump(k.addrHour, 1); await store.bump(k.addrDay, 1); await store.bump(k.teamDay, 1); await store.bump(k.teamBytes, mail.raw.length)
  log('mail_queued', { hash: hash.slice(0, 8), size: stripped.raw.length })
  deps.waiters.wake(teamId)
  return { accepted: true, id, teamId }
}

// ---------------- the Email Worker's message ----------------
/** The part of Cloudflare's ForwardableEmailMessage this uses. */
export interface EmailMessageLike {
  readonly from: string
  readonly to: string
  readonly raw: ReadableStream<Uint8Array>
  readonly rawSize: number
  setReject(reason: string): void
}

/** Read at most `max` bytes of a stream (null when it is longer). */
export async function readAtMost(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) { try { await reader.cancel() } catch { /* nothing to free */ } return null }
    parts.push(value)
  }
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** One mail through the gateway: `receive` runs receiveMail where the store lives (in the Worker: the Durable Object). */
export async function handleEmail(message: EmailMessageLike, receive: (m: IncomingMail) => Promise<ReceiveResult>): Promise<void> {
  if (message.rawSize > MAIL_IN_RAW_MAX) { message.setReject(MAIL_IN_SMTP.too_big); return }
  const raw = await readAtMost(message.raw, MAIL_IN_RAW_MAX)
  if (!raw) { message.setReject(MAIL_IN_SMTP.too_big); return }
  const r = await receive({ to: message.to, from: message.from, raw, rawSize: message.rawSize })
  if (!r.accepted) message.setReject(r.smtp)
}

/** Old counters and nonces go (an alarm in the Worker, a timer in the dev server). */
export async function upkeep(deps: MailboxDeps) {
  const now = deps.now()
  await deps.store.pruneCounters((k) => counterIsOld(k, now))
  await deps.store.pruneNonces(now)
}
