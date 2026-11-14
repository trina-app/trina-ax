// Error reports and cron check-ins to Sentry for our own services (the relay, the push gateway). Off unless the host
// sets a key (RELAY_SENTRY_DSN, PUSH_GATEWAY_SENTRY_DSN). Same approach as the team server's opt-in reports
// (server/src/system/error-report.ts, docs/DECISIONS.md "Error reports to Sentry"): no Sentry SDK, because this file is
// the allowlist. A value reaches Sentry only if buildEvent names it, so log fields, addresses, request paths, headers,
// device tokens and keys cannot get there by accident. docs/DECISIONS.md "Error reports from the relay and the push
// gateway".
//
// The relay runs this file under Node with type stripping (relay/README.md): erasable TypeScript only (no parameter
// properties, enums or namespaces) and no imports outside node:.
import { randomBytes } from 'node:crypto'

const MAX_SCRUB_INPUT = 1000
const MAX_MESSAGE = 300
const MAX_FRAMES = 40
/** a stack line longer than this is not a frame: the frame pattern is slow on a very long line */
const MAX_FRAME_LINE = 500
const MAX_PER_MINUTE = 30
const REPEAT_WINDOW_MS = 60_000
/** a repeat window for errors that repeat on every request until a person acts (a revoked key): one event an hour */
export const LONG_REPEAT_WINDOW_MS = 3_600_000
const SEND_TIMEOUT_MS = 5_000
export const CRASH_FLUSH_MS = 2_000
const DEFAULT_PAUSE_MS = 60_000
const MAX_PAUSE_MS = 3_600_000
const MAX_TAGS = 10

export interface SentryTarget { url: string; key: string; /** https://<host>[/<prefix>] (the check-in base) */ base: string; project: string }

/** The key Sentry shows for a project: https://<public key>@<host>[/<prefix>]/<project id>. */
export function parseDsn(dsn: string | undefined): SentryTarget | null {
  if (!dsn) return null
  let u: URL
  try { u = new URL(dsn.trim()) } catch { return null }
  const cut = u.pathname.lastIndexOf('/')
  const project = u.pathname.slice(cut + 1)
  if (u.protocol !== 'https:' || !/^[A-Za-z0-9]+$/.test(u.username) || u.password || !/^\d+$/.test(project)) return null
  const base = `https://${u.host}${u.pathname.slice(0, cut)}`
  return { url: `${base}/api/${project}/envelope/`, key: u.username, base, project }
}

/** A monitor slug: lowercase letters, digits and dashes (Sentry's slug rule). */
export const MONITOR_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,49}$/

/** Sentry's HTTP check-in endpoint for a monitor (docs.sentry.io "Crons > HTTP"); null without a usable key. The
 *  shell twin is relay/deploy/relay-checkin.sh: tests/unit/sentry-report.test.ts checks both build the same URL. */
export function checkInUrl(dsn: string | undefined, slug: string): string | null {
  const t = parseDsn(dsn)
  if (!t || !MONITOR_SLUG_RE.test(slug)) return null
  return `${t.base}/api/${t.project}/cron/${slug}/${t.key}/`
}

const SECRET_NAME = 'pass(?:word|phrase|wd)?|pwd|(?:access_|refresh_|id_)?token|(?:client_)?secret|api[_-]?key|authorization|cookie|session|sid'
/** In this order: quoted text first, because it is where a value usually sits ("password='a b'" would leave "b"), and
 *  "Bearer x" before "authorization: …", which would otherwise take the word Bearer as the value and leave the token.
 *  The same list as server/src/system/error-report.ts (PR #168). */
const SCRUB: readonly [RegExp, string][] = [
  [/(?<![A-Za-z0-9])'[^']*(?:'|$)|"[^"]*(?:"|$)|`[^`]*(?:`|$)/g, '[text]'],
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [new RegExp(`(?<![A-Za-z0-9])(${SECRET_NAME})(?![A-Za-z0-9])\\s*[:=]\\s*(?:Bearer \\[redacted\\]|\\S+)`, 'gi'), '$1=[redacted]'],
  // Korean labels (password, PIN, token, code): the value after them, with or without a colon, and after a particle
  [/(비밀번호|비번|암호|토큰|인증번호)[은는이가을를]?(?![가-힣])\s*[:=]?\s*(?:Bearer \[redacted\]|\S+)/g, '$1=[redacted]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]'],
  // the domain may be Korean (홍길동@회사.한국): keepText must not let it through
  [/[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z가-힣]{2,}/g, '[email]'],
  [/\S*[\\/]\S*/g, '[path]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
  [/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, '[ip]'],
  // a host or a file of any kind: whatever has a dot inside a word (acme.trina.app, registry.db, plan.key, 회사.한국);
  // letters of any script, so a Korean host is caught even when keepText keeps Hangul
  [/(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu, '[name]'],
  [/\b[A-Za-z0-9_-]{20,}\b/g, '[id]'],
  [/\+?\d[\d ().-]{5,}\d/g, '[number]'],
]
/** the code's own messages are English: other letters here came from a person (a team name, a file) */
const NON_ASCII: readonly [RegExp, string] = [/[^\x00-\x7F]+/g, '[text]']
/** keepText: Hangul (syllables, jamo, compatibility jamo; not the invisible fillers) stays; any other non-ASCII letter, mark or symbol still goes */
const NON_ASCII_BUT_HANGUL: readonly [RegExp, string] = [/[^\x00-\x7F\u1100-\u115E\u1161-\u11FF\u3131-\u3163\u3165-\u318E\uAC00-\uD7A3]+/g, '[text]']

export interface ScrubOptions {
  /** Keep Korean (Hangul) words. Only for a message written in code, such as a fixed alert title ("예약 작업 실패:
   *  backup"): never for text that holds a name, a file, a message or anything a person typed. Every other rule still
   *  runs (quoted text, tokens, secrets, URLs, emails, paths, IPs, hosts, long ids, numbers, other scripts). */
  keepText?: boolean
}

/** A message with addresses, paths, secrets and long ids taken out. It cannot recognise plain English words as a name. */
export function scrubText(s: string, o: ScrubOptions = {}): string {
  let out = s.split('\n', 1)[0]!.slice(0, MAX_SCRUB_INPUT)
  for (const [re, to] of SCRUB) out = out.replace(re, to)
  const [re, to] = o.keepText === true ? NON_ASCII_BUT_HANGUL : NON_ASCII
  return out.replace(re, to).slice(0, MAX_MESSAGE)
}

export interface Frame { filename: string; function: string; lineno: number; colno: number; in_app: boolean }

const FRAME_V8 = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/

/** A frame's file: the last two parts of the name only (the install folder is the operator's business). */
function frameFile(raw: string): { filename: string; in_app: boolean } {
  const clean = raw.replace(/^file:\/\//, '').split(/[?#]/, 1)[0]!
  if (clean.startsWith('native') || clean.startsWith('node:')) return { filename: clean.slice(0, 80), in_app: false }
  if (!CODE_FILE.test(clean)) return { filename: '[file]', in_app: false }
  return { filename: clean.split(/[\\/]/).slice(-2).join('/'), in_app: !clean.includes('node_modules') }
}

/** What comes after the message: a message can hold lines that look like frames. */
function afterMessage(stack: string, message: string): string {
  const at = message ? stack.indexOf(message) : -1
  return at >= 0 ? stack.slice(at + message.length) : stack
}

/** Sentry's order: the oldest call first. */
export function parseStack(stack: string, message: string): Frame[] {
  const frames: Frame[] = []
  for (const line of afterMessage(stack, message).split('\n')) {
    if (line.length > MAX_FRAME_LINE) continue
    const m = FRAME_V8.exec(line)
    if (!m) continue
    const fn = m[1] ?? ''
    frames.push({ ...frameFile(m[2]!), function: /^[\w$.<>]{1,80}$/.test(fn) ? fn : '?', lineno: Number(m[3]), colno: Number(m[4]) })
    if (frames.length === MAX_FRAMES) break
  }
  return frames.reverse()
}

export interface ErrorInput {
  type?: string
  message: string
  stack?: string
  /** the process is ending because of this error */
  fatal?: boolean
  /** extra tags, each checked against TAG_VALUE_RE (a fixed code, never free text) */
  tags?: Record<string, string>
  /** how long a repeat of this error stays out (default one minute; LONG_REPEAT_WINDOW_MS for a revoked key) */
  repeatWindowMs?: number
  /** 'warning' for something that did not fail a request or a job; `fatal` wins over it */
  level?: 'error' | 'warning'
  /** Sentry's grouping, instead of type, message and frames: at most MAX_FINGERPRINT parts, each a code
   *  (TAG_VALUE_RE) or a route pattern (ROUTE_VALUE_RE). One part that is neither, or too many parts, and the event
   *  goes without a fingerprint (Sentry's own grouping). */
  fingerprint?: string[]
  /** 'message': the scrubbed message as `message.formatted`, no exception and no frames (an alert, not a throw) */
  kind?: 'exception' | 'message'
  /** keep Korean words in the message: see ScrubOptions.keepText. Only for messages written in code. */
  keepText?: boolean
}

export interface EventOptions { release: string; environment: string; logger: string; tags: Record<string, string>; now: number }

const TAG_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/
/** a tag value is a code (instance a, provider apns, reason InvalidProviderToken, log event ops_keys_unusable) */
export const TAG_VALUE_RE = /^[A-Za-z0-9_.:@-]{1,64}$/
/** A route pattern as the router names it (Hono's c.req.routePath: /api/teams/:id, /t/:slug/api/*), never a real
 *  path. Literal parts are short lowercase words: no dots (hosts, files), no @ (emails), no capitals and at most two
 *  digits (ids, tokens, numbers); parameter names are short letters only (:id, :teamId). Not a proof: a real path
 *  whose parts look like words (/u/kimminsu/files, a token made only of letters) passes, so callers pass the router's
 *  pattern (c.req.routePath) only, never the request path. Allowed as the `route` tag and as a fingerprint part. */
export const ROUTE_VALUE_RE = /^(?:\/(?:(?!(?:[a-z_-]*\d){3})[a-z][a-z0-9_-]{0,23}|:[a-z][A-Za-z_]{0,23}\??|\*))+\/?$|^\/$/
const MAX_ROUTE = 128
const MAX_FINGERPRINT = 4

function routeValue(v: string): boolean {
  return v.length <= MAX_ROUTE && ROUTE_VALUE_RE.test(v)
}

function cleanTags(...all: (Record<string, string> | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const tags of all) {
    for (const [k, v] of Object.entries(tags ?? {})) {
      if (Object.keys(out).length >= MAX_TAGS) break
      if (TAG_KEY_RE.test(k) && typeof v === 'string' && (TAG_VALUE_RE.test(v) || (k === 'route' && routeValue(v)))) out[k] = v
    }
  }
  return out
}

/** A code part that looks like personal data or a key: an email (@), 7+ digits in a row (a phone, a resident or order
 *  number, a date), an IPv4 address, or a 20+ character run with a digit in it (a key, a UUID, a provider id).
 *  Codes and versions (job-failed, InvalidProviderToken, 0.4.0) pass. */
function looksLikeData(p: string): boolean {
  return p.includes('@') || /\d[\d-]{5,}\d/.test(p) || /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/.test(p)
    || (p.match(/[A-Za-z0-9_-]{20,}/g) ?? []).some((run) => /\d/.test(run))
}

/** The fingerprint as sent, or null: all parts pass, or none is sent. */
export function cleanFingerprint(parts: unknown): string[] | null {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_FINGERPRINT) return null
  for (const p of parts) if (typeof p !== 'string' || !((TAG_VALUE_RE.test(p) && !looksLikeData(p)) || routeValue(p))) return null
  return [...parts] as string[]
}

/** Everything Sentry receives. Adding a field here is a privacy decision: see docs/DECISIONS.md first. */
export function buildEvent(i: ErrorInput, o: EventOptions): Record<string, unknown> {
  const text = scrubText(i.message, { keepText: i.keepText === true })
  const fingerprint = i.fingerprint === undefined ? null : cleanFingerprint(i.fingerprint)
  const event: Record<string, unknown> = {
    event_id: randomBytes(16).toString('hex'),
    timestamp: o.now / 1000,
    platform: 'node',
    level: i.fatal ? 'fatal' : i.level === 'warning' ? 'warning' : 'error',
    logger: o.logger,
    release: o.release,
    environment: o.environment,
    sdk: { name: 'mycel.sentry-report', version: '1.0.0' },
    tags: cleanTags(o.tags, i.tags),
    ...(fingerprint ? { fingerprint } : {}),
  }
  if (i.kind === 'message') {
    event.message = { formatted: text }
    return event
  }
  const frames = i.stack ? parseStack(i.stack, i.message) : []
  event.exception = {
    values: [{
      type: i.type && /^[A-Za-z_$][\w$]{0,79}$/.test(i.type) ? i.type : 'Error',
      value: text,
      ...(frames.length ? { stacktrace: { frames } } : {}),
      mechanism: { type: o.logger, handled: !i.fatal },
    }],
  }
  return event
}

const ERROR_CATEGORIES: readonly string[] = ['error', 'default']
const MONITOR_CATEGORIES: readonly string[] = ['monitor']

/** Seconds to wait from Sentry's answer, or null. X-Sentry-Rate-Limits lists "seconds:categories:scope" entries; only
 *  those for `categories` (errors by default; ['monitor'] for check-ins) or for every category apply. A 429 without
 *  a header for these categories pauses whatever was sent. */
export function pauseSeconds(limits: string | null, status: number, retryAfter: string | null, categories: readonly string[] = ERROR_CATEGORIES): number | null {
  if (limits) {
    let wait = 0
    for (const entry of limits.split(',')) {
      const [secs = '', cats = ''] = entry.trim().split(':')
      const n = Number.parseInt(secs, 10)
      const list = cats.split(';').filter(Boolean)
      if (Number.isFinite(n) && (list.length === 0 || list.some((c) => categories.includes(c)))) wait = Math.max(wait, n)
    }
    if (wait > 0) return wait
  }
  if (status !== 429) return null
  const n = Number.parseInt(retryAfter ?? '', 10)
  return Number.isFinite(n) ? n : DEFAULT_PAUSE_MS / 1000
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface ReporterOptions {
  release: string
  environment: string
  /** the service: relay, push-gateway */
  logger: string
  /** tags on every event (instance) */
  tags?: Record<string, string>
  fetch?: FetchFn
  now?: () => number
}

/** Sends on its own time: capture never throws, never waits and never logs, so an error cannot report itself. */
export class ErrorReporter {
  private inflight = new Set<Promise<void>>()
  /** error key -> until when a repeat stays out */
  private recent = new Map<string, number>()
  private sentAt: number[] = []
  private pausedUntil = 0
  private target: SentryTarget
  private o: ReporterOptions
  private send: FetchFn
  private now: () => number

  constructor(target: SentryTarget, o: ReporterOptions) {
    this.target = target
    this.o = o
    this.send = o.fetch ?? ((url, init) => fetch(url, init))
    this.now = o.now ?? Date.now
  }

  capture(input: ErrorInput): void {
    try {
      const now = this.now()
      // a clock set back must not leave sending paused for its whole jump
      if (this.pausedUntil - now > MAX_PAUSE_MS) this.pausedUntil = 0
      if (now < this.pausedUntil || !this.admit(input, now)) return
      const event = buildEvent(input, { release: this.o.release, environment: this.o.environment, logger: this.o.logger, tags: this.o.tags ?? {}, now })
      const sending: Promise<void> = this.post(event, now).catch(() => {}).finally(() => { this.inflight.delete(sending) })
      this.inflight.add(sending)
    } catch { /* a report must never break the code that failed */ }
  }

  /** Waits for what is being sent, at most ms. */
  async flush(ms: number): Promise<void> {
    if (this.inflight.size === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>((done) => { timer = setTimeout(done, ms) })
    await Promise.race([Promise.allSettled([...this.inflight]), limit])
    clearTimeout(timer)
  }

  /** A repeat of one error in a minute, and more than MAX_PER_MINUTE in any minute, stay out: a storm must not use up
   *  the quota. A crash always goes: it is the one report that explains the restart. */
  private admit(i: ErrorInput, now: number): boolean {
    const frames = i.stack ? afterMessage(i.stack, i.message).split('\n').filter((l) => /^\s*at /.test(l)).slice(0, 2).join('|') : ''
    const tags = Object.entries(i.tags ?? {}).map(([k, v]) => `${k}=${v}`).join(',')
    const kind = `${i.kind ?? 'exception'}|${i.level ?? 'error'}|${Array.isArray(i.fingerprint) ? i.fingerprint.join('\u0000').slice(0, 300) : ''}`
    const key = `${i.type}|${tags}|${i.message.slice(0, 100)}|${frames.slice(0, 400)}|${kind}`
    this.sentAt = this.sentAt.filter((t) => t <= now && now - t < 60_000)
    // a clock set back must not hold an error out for the whole jump
    for (const [k, until] of this.recent) if (until <= now || until - now > MAX_PAUSE_MS) this.recent.delete(k)
    if (this.recent.has(key)) return false
    if (!i.fatal && this.sentAt.length >= MAX_PER_MINUTE) return false
    this.sentAt.push(now)
    this.recent.set(key, now + Math.min(Math.max(i.repeatWindowMs ?? REPEAT_WINDOW_MS, 0), MAX_PAUSE_MS))
    return true
  }

  private async post(event: Record<string, unknown>, now: number): Promise<void> {
    const header = { event_id: event.event_id, sent_at: new Date(now).toISOString() }
    const res = await this.send(this.target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.target.key}, sentry_client=mycel.sentry-report/1.0.0`,
      },
      body: `${JSON.stringify(header)}\n{"type":"event"}\n${JSON.stringify(event)}\n`,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const wait = pauseSeconds(res.headers.get('x-sentry-rate-limits'), res.status, res.headers.get('retry-after'))
    if (wait !== null) this.pausedUntil = this.now() + Math.min(wait * 1000, MAX_PAUSE_MS)
    await res.body?.cancel()
  }
}

export interface CheckInSchedule { type: 'crontab'; value: string }
export interface CheckInIntervalSchedule { type: 'interval'; value: number; unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' }

/** What a check-in may say. Anything else, and any field that fails its rule, is left out (the status is required). */
export interface CheckInBody {
  status: 'in_progress' | 'ok' | 'error'
  /** to close an in_progress check-in: a UUID or 32 hex characters */
  check_in_id?: string
  /** seconds the job ran */
  duration?: number
  environment?: string
  monitor_config?: {
    schedule: CheckInSchedule | CheckInIntervalSchedule
    /** minutes */
    checkin_margin?: number
    /** minutes */
    max_runtime?: number
    /** an IANA name: UTC, Asia/Seoul */
    timezone?: string
    failure_issue_threshold?: number
    recovery_threshold?: number
  }
}

export interface CheckInOptions {
  fetch?: FetchFn
  /** default 5 s, at most 30 s */
  timeoutMs?: number
  now?: () => number
}

/** sent: Sentry took it; off: no usable key or slug, or no valid status; paused: Sentry asked for a pause on check-ins;
 *  failed: a network error, a timeout or an error answer */
export type CheckInResult = 'sent' | 'off' | 'paused' | 'failed'

const CHECK_IN_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
/** the same rule as relay/deploy/relay-checkin.sh */
const CRONTAB_RE = /^[0-9A-Za-z*/,\- ]{9,60}$/
const TIMEZONE_RE = /^(?:UTC|[A-Z][A-Za-z_]{1,30}(?:\/[A-Z][A-Za-z0-9_+-]{1,30}){1,2})$/
const INTERVAL_UNITS: readonly string[] = ['minute', 'hour', 'day', 'week', 'month', 'year']
const MAX_CHECK_IN_TIMEOUT_MS = 30_000
/** a check-in pause per project: errors and check-ins are limited apart, so neither pauses the other */
const checkInPausedUntil = new Map<string, number>()

function count(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : undefined
}

/** The body as sent, or null without a valid status. Only the fields named here can leave. */
export function cleanCheckInBody(b: unknown): Record<string, unknown> | null {
  if (!b || typeof b !== 'object') return null
  const i = b as Record<string, unknown>
  if (i.status !== 'in_progress' && i.status !== 'ok' && i.status !== 'error') return null
  const out: Record<string, unknown> = { status: i.status }
  if (typeof i.check_in_id === 'string' && CHECK_IN_ID_RE.test(i.check_in_id)) out.check_in_id = i.check_in_id
  if (typeof i.duration === 'number' && Number.isFinite(i.duration) && i.duration >= 0 && i.duration <= 7 * 86_400) out.duration = i.duration
  if (typeof i.environment === 'string' && /^[a-z0-9._-]{1,32}$/.test(i.environment)) out.environment = i.environment
  const mc = i.monitor_config && typeof i.monitor_config === 'object' ? i.monitor_config as Record<string, unknown> : null
  const sc = mc?.schedule && typeof mc.schedule === 'object' ? mc.schedule as Record<string, unknown> : null
  let schedule: Record<string, unknown> | null = null
  if (sc?.type === 'crontab' && typeof sc.value === 'string' && CRONTAB_RE.test(sc.value)) schedule = { type: 'crontab', value: sc.value }
  else if (sc?.type === 'interval' && count(sc.value, 10_000) && typeof sc.unit === 'string' && INTERVAL_UNITS.includes(sc.unit)) schedule = { type: 'interval', value: sc.value, unit: sc.unit }
  // a monitor_config without a valid schedule is left out whole: Sentry refuses one
  if (mc && schedule) {
    const config: Record<string, unknown> = { schedule }
    const margin = count(mc.checkin_margin, 40_320)
    const runtime = count(mc.max_runtime, 40_320)
    const fails = count(mc.failure_issue_threshold, 720)
    const recovers = count(mc.recovery_threshold, 720)
    if (margin) config.checkin_margin = margin
    if (runtime) config.max_runtime = runtime
    if (typeof mc.timezone === 'string' && TIMEZONE_RE.test(mc.timezone)) config.timezone = mc.timezone
    if (fails) config.failure_issue_threshold = fails
    if (recovers) config.recovery_threshold = recovers
    out.monitor_config = config
  }
  return out
}

/** A cron check-in from code (docs.sentry.io "Crons > HTTP"). Never throws and never logs: a check-in is a side note to
 *  the job, so the job's result, timing and retries must not depend on it (await it, or not, as the caller likes).
 *  Only cleanCheckInBody's fields are sent; the first check-in with monitor_config creates the monitor. A rate limit
 *  for the monitor category (or for every category, or a 429) pauses check-ins to that project; a limit for errors only
 *  does not, and a check-in limit never pauses ErrorReporter. */
export async function checkIn(dsn: string | undefined, slug: string, body: CheckInBody, o: CheckInOptions = {}): Promise<CheckInResult> {
  try {
    const url = checkInUrl(dsn, slug)
    const clean = cleanCheckInBody(body)
    if (!url || !clean) return 'off'
    const t = parseDsn(dsn)!
    const project = `${t.base}/api/${t.project}`
    const now = o.now ?? Date.now
    const paused = checkInPausedUntil.get(project) ?? 0
    // a clock set back must not leave check-ins paused for its whole jump
    if (paused - now() > MAX_PAUSE_MS) checkInPausedUntil.delete(project)
    else if (now() < paused) return 'paused'
    const send = o.fetch ?? ((u: string, init: RequestInit) => fetch(u, init))
    const res = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(clean),
      signal: AbortSignal.timeout(Math.min(Math.max(Number.isFinite(o.timeoutMs) ? o.timeoutMs! : SEND_TIMEOUT_MS, 1), MAX_CHECK_IN_TIMEOUT_MS)),
    })
    const wait = pauseSeconds(res.headers.get('x-sentry-rate-limits'), res.status, res.headers.get('retry-after'), MONITOR_CATEGORIES)
    if (wait !== null) checkInPausedUntil.set(project, now() + Math.min(wait * 1000, MAX_PAUSE_MS))
    try { await res.body?.cancel() } catch { /* the answer is not needed */ }
    return res.ok ? 'sent' : 'failed'
  } catch {
    return 'failed'
  }
}

/** The environment name on reports: a short code, default production. */
export function environmentName(v: string | undefined): string {
  const named = v?.trim()
  return named && /^[a-z0-9._-]{1,32}$/.test(named) ? named : 'production'
}

export interface ReporterFromEnv {
  reporter: ErrorReporter | null
  /** a key was set but is not a Sentry key: the caller logs this once */
  invalid: boolean
}

/** A reporter from a DSN setting; none when it is unset (nothing is built, nothing is sent). */
export function reporterFromDsn(dsn: string | undefined, o: ReporterOptions): ReporterFromEnv {
  if (!dsn?.trim()) return { reporter: null, invalid: false }
  const target = parseDsn(dsn)
  return target ? { reporter: new ErrorReporter(target, o), invalid: false } : { reporter: null, invalid: true }
}

interface CrashTarget {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown
  exit(code: number): void
  /** where the full error goes, as the runtime prints it without a listener (default: stderr) */
  writeStderr?(text: string): void
}

/** The process still ends with code 1 as it does without these handlers, so systemd restarts it the same way. They
 * exist only while reports are on: a listener is what stops the default crash. Each step is guarded, because a step
 * that throws here would otherwise leave a broken process running. `logLine` writes the service's own log line. */
export function reportCrashes(reporter: ErrorReporter, logLine: (what: string, err: Error) => void, proc: CrashTarget = process): void {
  let dying = false
  const die = (what: string) => (e: unknown) => {
    if (dying) return
    dying = true
    const err = e instanceof Error ? e : new Error(what)
    // a listener stops the runtime's own print of the error: print it the same way, so the local log (journald) keeps
    // the whole stack and message; only the report is scrubbed
    try {
      const text = `${e instanceof Error ? (e.stack ?? String(e)) : `${what}: ${String(e)}`}\n`
      if (proc.writeStderr) proc.writeStderr(text)
      else process.stderr.write(text)
    } catch { /* exit anyway */ }
    try { reporter.capture({ type: err.name, message: err.message, stack: err.stack, fatal: true }) } catch { /* exit anyway */ }
    try { logLine(what, err) } catch { /* exit anyway */ }
    void reporter.flush(CRASH_FLUSH_MS).catch(() => {}).finally(() => proc.exit(1))
  }
  proc.on('uncaughtException', die('uncaught exception'))
  proc.on('unhandledRejection', die('unhandled rejection'))
}
