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
//   2b. the server refuses writes (the disk or the plan is full, system/storage.ts): 503 + Retry-After before the body,
//      so the vendor can send it again later instead of counting it delivered; the app's status line says why (QA TC-2285).
//   3. the app's own limits before the body: a burst then 1 a second, and the day's received count (429 + Retry-After).
//      An Other app set up as a preset this build does not know: 401 with a secret, 400 without (never read as Other).
//   4. the content type (415), then the body: the raw bytes, at most 256 KiB (GitHub 1 MiB; a preset its own; 413),
//      within 10 s (408).
//   5. the signature when a secret is set (signatures.ts: GitHub X-Hub-Signature-256 "sha256=<hex>", Sentry
//      Sentry-Hook-Signature "<hex>", a preset its service's scheme (Channel Talk: its ?token= on the URL); constant
//      time; 401; Tally's signed createdAt older
//      than 2 days: 401). Jotform's form post is read into fields here. Without a secret the token alone authenticates and the
//      card carries `unverified` when it names someone; the app's settings say "Not signed" once (owner decision 9:
//      optional for both; no "(unverified)" after each name since the 2026-11-14 review).
//   6. parse (400 unreadable), the app's switch (off: 200, skipped), the day's caps (pause: 429), then one transaction
//      posts it with its delivery row (a retry posts once). 200 "ok" (Slack-style senders look for it).
// No network I/O and no AI on this path. A refusal is written to the app's status line at most once a minute, never the
// body.
import { ROOM_APP_BODY_MAX, ROOM_APP_BODY_SECONDS, ROOM_APP_DAILY_RECEIVED, ROOM_APP_GITHUB_BODY_MAX, ROOM_APP_TOKEN_RE, type RoomAppKind } from '@mycel/shared/api'
import type { AppContext } from '../../context'
import { teamDefaultLocale, teamTimeZone } from '../../admin/settings'
import { storageRefusesWrites } from '../../system/storage'
import { parseArrival, type Parsed } from './parse'
import { presetOf, PRESETS } from './presets'
import { tallyTooOld, typeformTooOld } from './presets/forms'
import { verifySignature } from './signatures'
import { roomAppsOf, sha256, teamDay, type AppRow } from './service'

const HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
const answer = (status: number, body: string, extra: Record<string, string> = {}) => new Response(`${body}\n`, { status, headers: { ...HEADERS, ...extra } })
export const NOT_FOUND = () => answer(404, 'not_found')
/** How long a service is asked to wait when the storage is full (Retry-After): a person frees the space, not soon */
export const STORAGE_RETRY_AFTER_S = 600

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

/** A form post's fields (Jotform), read from the bounded raw body: at most FORM_FIELDS_MAX fields of at most
 * FORM_FIELD_MAX characters; file parts are left out (never stored). null: not readable. */
const FORM_FIELDS_MAX = 100
const FORM_FIELD_MAX = 64 * 1024
async function formFields(raw: Uint8Array, contentType: string, full: string): Promise<[string, string][] | null> {
  try {
    const entries: [string, string][] = []
    const take = (k: string, v: unknown) => { if (typeof v === 'string' && entries.length < FORM_FIELDS_MAX) entries.push([k.slice(0, 200), v.slice(0, FORM_FIELD_MAX)]) }
    if (contentType === 'application/x-www-form-urlencoded') {
      for (const [k, v] of new URLSearchParams(new TextDecoder().decode(raw))) take(k, v)
    } else {
      const fd = await new Response(raw as Uint8Array<ArrayBuffer>, { headers: { 'content-type': full } }).formData()
      for (const [k, v] of fd.entries()) take(k, v)
    }
    return entries
  } catch { return null }
}

/** The request's query (Channel Talk's ?token=); never logged (http/middleware.ts loggablePath). */
function queryOf(req: Request): URLSearchParams {
  try { return new URL(req.url).searchParams } catch { return new URLSearchParams() }
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
  // 2b. nothing can be saved now: try again later (the body is never read, no card is posted)
  if (storageRefusesWrites()) {
    // a full disk may refuse this small write too: the answer is the 503 all the same
    try { apps.refused(row.id, 'storage_full') } catch (e) { ctx.log.warn('room app refusal not saved', { err: e }) }
    return answer(503, 'storage_full', { 'retry-after': String(STORAGE_RETRY_AFTER_S) })
  }
  const now = apps.clock()
  const { day, next } = teamDay(db, now)
  const untilMidnight = String(Math.max(1, Math.ceil((Date.parse(next) - now) / 1000)))
  // 3. the app's limits before the body
  const wait = apps.limits.appWait(row.id)
  if (wait !== null) { apps.dropped(row, day); return answer(429, 'slow_down', { 'retry-after': String(wait) }) }
  if (apps.count(row, 'received', day) > ROOM_APP_DAILY_RECEIVED) { apps.dropped(row, day); return answer(429, 'slow_down', { 'retry-after': untilMidnight }) }
  // a preset this build does not know (written by a newer build, then rolled back): never read as plain Other with a
  // guessed scheme. With a secret it fails as a signature would (401), else as a body this build cannot read (400)
  const p = row.kind === 'other' ? presetOf(row.preset) : null
  if (p === 'unknown') {
    if (row.secret_enc) { apps.refused(row.id, 'signature'); return answer(401, 'bad_signature') }
    apps.refused(row.id, 'format'); return answer(400, 'invalid_payload')
  }
  const preset = p ? PRESETS[p] : null
  // 4. the content type, then the body
  const fullType = req.headers.get('content-type') ?? ''
  const type = fullType.split(';')[0]!.trim().toLowerCase()
  if (!(preset ? preset.types : TYPES[row.kind]).includes(type)) { apps.refused(row.id, 'format'); return answer(415, 'unsupported_type') }
  let raw: Uint8Array
  try { raw = await readBody(req, preset ? preset.bodyMax : row.kind === 'github' ? ROOM_APP_GITHUB_BODY_MAX : ROOM_APP_BODY_MAX, ROOM_APP_BODY_SECONDS) } catch (e) {
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
  let verified: unknown
  if (secret) {
    // the preset's scheme (fixed at create); a preset that cannot sign never has a secret (setSecret refuses), and one
    // that has it anyway is refused. Part 1's kinds as before: GitHub's header, else Sentry's
    const sig = preset ? preset.signature : row.kind === 'github' ? { scheme: 'hex-body' as const, header: 'x-hub-signature-256', prefix: 'sha256=' } : { scheme: 'hex-body' as const, header: 'sentry-hook-signature' }
    const r = secret !== 'broken' && sig ? verifySignature(sig.scheme, { secret: secret.secret, raw, headers: req.headers, now, header: sig.header, prefix: sig.prefix, query: queryOf(req) }) : { ok: false as const }
    if (!r.ok) { apps.refused(row.id, 'signature'); return answer(401, 'bad_signature') }
    // Tally signs no time: a signed body older than 2 days is a replay beyond what dedupe remembers
    if (p === 'tally' && tallyTooOld(r.json, now)) { apps.refused(row.id, 'signature'); return answer(401, 'bad_signature') }
    // Typeform's signature has no time either: a signed response submitted more than 2 days ago is a replay
    if (p === 'typeform' && typeformTooOld(raw, now)) { apps.refused(row.id, 'signature'); return answer(401, 'bad_signature') }
    verified = r.json
    signed = true
  }
  let form: [string, string][] | undefined
  if (p === 'jotform') {
    const f = await formFields(raw, type, fullType)
    if (!f) { apps.refused(row.id, 'format'); return answer(400, 'invalid_payload') }
    form = f
  }
  // 6. what it says
  let locale, timeZone: string | undefined
  try { locale = teamDefaultLocale(db) } catch { locale = 'en' as const }
  try { timeZone = teamTimeZone(db) } catch { timeZone = undefined }
  let parsed: Parsed
  try {
    parsed = parseArrival({ kind: row.kind, preset: p, headers: req.headers, contentType: type, raw, signed, locale, events: apps.switches(row), pin: now_.preset_pin, ...(verified !== undefined ? { json: verified } : {}), ...(form ? { form } : {}), timeZone, now })
  } catch (e) {
    // a reader that met a shape it did not expect: a body Trina cannot read, never a 500
    ctx.log.warn('room app body not read', { err: e, kind: row.kind, preset: p })
    parsed = { refuse: 'format' }
  }
  if ('refuse' in parsed) { apps.refused(row.id, 'format'); return answer(400, 'invalid_payload') }
  if ('skip' in parsed) {
    if (parsed.connected) apps.connected(row.id)
    else apps.count(row, 'skipped', day)
    return answer(200, 'ok')
  }
  let app = now_
  const ev = parsed.event
  // which events have arrived at all (also with the switch off): "Not set up in <service>" under the others
  apps.sawEvent(now_, ev.switch)
  if (ev.alert && !app.alert_seen) app = apps.alertSeen(app)
  if (!apps.switches(app)[ev.switch]) { apps.count(row, 'skipped', day); return answer(200, 'ok') }
  const paused = apps.capCheck(app)
  if (paused) { apps.count(row, 'skipped', day); return answer(429, 'slow_down', { 'retry-after': String(Math.max(1, Math.ceil((Date.parse(paused) - now) / 1000))) }) }
  // with a secret saved, only a signed request may pin the service account (unsigned ones are refused above anyway)
  if (ev.pin && app.secret_enc && !signed) delete ev.pin
  if (!apps.post(app, ev, day)) apps.count(row, 'skipped', day)
  return answer(200, 'ok')
}
