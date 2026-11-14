// POST /in/<token>: where Sentry, GitHub, a Google Form's script or any other service posts to a room (docs/DECISIONS.md
// "Apps posting in rooms"). Outside /api: no session, no CSRF header; the token is the only auth. The token never
// reaches a log (http/middleware.ts loggablePath), an audit row or an error body.
//
// The order of work, so junk costs little and a real app is not crowded out:
//   1. the token first (its shape, then one indexed lookup by hash: the app, its room not archived); a live token is
//      not counted with anonymous traffic. Anything else is charged to the client address and its network: 404 (429
//      over the limit). Unknown, rotated, removed and archived-room tokens answer the same 404.
//   2. a browser's Origin header: 403 (vendors and curl send none; a web page that learned the address must not post
//      with its visitors' browsers).
//   3. the app's own limits before the body: a burst then 1 a second, and the day's received count (429 + Retry-After).
//   4. the content type (415), then the body: the raw bytes, at most 256 KiB (GitHub 1 MiB; 413), within 10 s (408).
//   5. the signature over the raw bytes when a secret is set (GitHub X-Hub-Signature-256 "sha256=<hex>", Sentry
//      Sentry-Hook-Signature "<hex>"; constant time; 401). Without a secret the token alone authenticates and the
//      card carries `unverified` when it names someone; the app's settings say "Not signed" once (owner decision 9:
//      optional for both; no "(unverified)" after each name since the 2026-11-14 review).
//   6. parse (400 unreadable), the app's switch (off: 200, skipped), the day's caps (pause: 429), then one transaction
//      posts it with its delivery row (a retry posts once). 200 "ok" (Slack-style senders look for it).
// No network I/O and no AI on this path. A refusal is written to the app's status line at most once a minute, never the
// body.
import crypto from 'node:crypto'
import { ROOM_APP_BODY_MAX, ROOM_APP_BODY_SECONDS, ROOM_APP_DAILY_RECEIVED, ROOM_APP_GITHUB_BODY_MAX, ROOM_APP_TOKEN_RE, type RoomAppKind } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { teamDefaultLocale } from '../../admin/settings'
import { parseArrival } from './parse'
import { roomAppsOf, sha256, teamDay, type AppRow } from './service'

const HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const answer = (status: number, body: string, extra: Record<string, string> = {}) => new Response(`${body}\n`, { status, headers: { ...HEADERS, ...extra } })
export const NOT_FOUND = () => answer(404, 'not_found')

/** The content types each kind takes. */
const TYPES: Record<RoomAppKind, readonly string[]> = {
  sentry: ['application/json'],
  github: ['application/json', 'application/x-www-form-urlencoded'],
  google_forms: ['application/json'],
  other: ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
}

class Timeout extends Error {}
class TooBig extends Error {}
/** The raw body, at most `max` bytes, within `seconds` (past either the stream is cancelled, never waited for). */
async function readBody(req: Request, max: number, seconds: number): Promise<Uint8Array> {
  const len = req.headers.get('content-length')
  if (len !== null && Number(len) > max) throw new TooBig()
  const chunks: Uint8Array[] = []
  let size = 0
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), seconds * 1000) })
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), deadline])
      if (r.done) break
      size += r.value.byteLength
      if (size > max) throw new TooBig()
      chunks.push(r.value)
    }
  } catch (e) {
    void reader.cancel().catch(() => { /* given up */ })
    throw e
  } finally { clearTimeout(timer) }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/** Constant-time comparison of a hex HMAC-SHA256 of the body with what the request says. */
function signatureOk(secret: string, raw: Uint8Array, given: string | null): boolean {
  if (!given) return false
  const want = crypto.createHmac('sha256', secret).update(raw).digest()
  const hex = given.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) return false
  return crypto.timingSafeEqual(want, Buffer.from(hex, 'hex'))
}

export interface InboundInfo { ip: string | null; /** came through the server's own public address with a country or network list (the /in/ exemption): the stricter unknown-token limit */ strict?: boolean }

export async function roomAppInbound(ctx: AppContext, req: Request, token: string, info: InboundInfo): Promise<Response> {
  const apps = roomAppsOf(ctx)
  const db = ctx.db
  // 1. the token first
  const row = ROOM_APP_TOKEN_RE.test(token)
    ? db.query('SELECT a.* FROM room_apps a JOIN rooms r ON r.id = a.room_id WHERE a.token_hash = ? AND r.archived_at IS NULL').get(sha256(token)) as AppRow | null
    : null
  if (!row) return apps.limits.unknownOk(info.ip, info.strict) ? NOT_FOUND() : answer(429, 'slow_down', { 'retry-after': '60' })
  // 2. never from a web page in a visitor's browser
  if (req.headers.get('origin') !== null) return answer(403, 'forbidden')
  const now = apps.clock()
  const { day, next } = teamDay(db, now)
  const untilMidnight = String(Math.max(1, Math.ceil((Date.parse(next) - now) / 1000)))
  // 3. the app's limits before the body
  const wait = apps.limits.appWait(row.id)
  if (wait !== null) { apps.dropped(row, day); return answer(429, 'slow_down', { 'retry-after': String(wait) }) }
  if (apps.count(row, 'received', day) > ROOM_APP_DAILY_RECEIVED) { apps.dropped(row, day); return answer(429, 'slow_down', { 'retry-after': untilMidnight }) }
  // 4. the content type, then the body
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (!TYPES[row.kind].includes(type)) { apps.refused(row.id, 'format'); return answer(415, 'unsupported_type') }
  let raw: Uint8Array
  try { raw = await readBody(req, row.kind === 'github' ? ROOM_APP_GITHUB_BODY_MAX : ROOM_APP_BODY_MAX, ROOM_APP_BODY_SECONDS) } catch (e) {
    if (e instanceof Timeout) return answer(408, 'timeout')
    if (e instanceof TooBig) { apps.refused(row.id, 'too_big'); return answer(413, 'too_large') }
    throw e
  }
  // removed or given a new address while the body came: as an unknown address
  const now_ = apps.row(row.id)
  if (!now_ || now_.token_hash !== row.token_hash) return NOT_FOUND()
  // 5. the signature, when a secret is set
  const secret = apps.secretOf(row)
  let signed = false
  if (secret) {
    const given = row.kind === 'github' ? (req.headers.get('x-hub-signature-256') ?? '').replace(/^sha256=/i, '') || null : req.headers.get('sentry-hook-signature')
    if (secret === 'broken' || !signatureOk(secret.secret, raw, given)) { apps.refused(row.id, 'signature'); return answer(401, 'bad_signature') }
    signed = true
  }
  // 6. what it says
  let locale
  try { locale = teamDefaultLocale(db) } catch { locale = 'en' as const }
  const parsed = parseArrival({ kind: row.kind, headers: req.headers, contentType: type, raw, signed, locale, events: apps.switches(row) })
  if ('refuse' in parsed) { apps.refused(row.id, 'format'); return answer(400, 'invalid_payload') }
  if ('skip' in parsed) {
    if (parsed.connected) apps.connected(row.id)
    else apps.count(row, 'skipped', day)
    return answer(200, 'ok')
  }
  let app = now_
  const ev = parsed.event
  if (ev.alert && !app.alert_seen) app = apps.alertSeen(app)
  if (!apps.switches(app)[ev.switch]) { apps.count(row, 'skipped', day); return answer(200, 'ok') }
  const paused = apps.capCheck(app)
  if (paused) { apps.count(row, 'skipped', day); return answer(429, 'slow_down', { 'retry-after': String(Math.max(1, Math.ceil((Date.parse(paused) - now) / 1000))) }) }
  if (!apps.post(app, ev, day)) apps.count(row, 'skipped', day)
  return answer(200, 'ok')
}
