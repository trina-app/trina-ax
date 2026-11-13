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
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]'],
  [/[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\S*[\\/]\S*/g, '[path]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
  [/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, '[ip]'],
  // a host or a file of any kind: whatever has a dot inside a word (acme.trina.app, registry.db, plan.key)
  [/\b[\w-]+(?:\.[\w-]+)+\b/g, '[name]'],
  [/\b[A-Za-z0-9_-]{20,}\b/g, '[id]'],
  [/\+?\d[\d ().-]{5,}\d/g, '[number]'],
  // the code's own messages are English: other letters here came from a person (a team name, a file)
  [/[^\x00-\x7F]+/g, '[text]'],
]

/** A message with addresses, paths, secrets and long ids taken out. It cannot recognise plain English words as a name. */
export function scrubText(s: string): string {
  let out = s.split('\n', 1)[0]!.slice(0, MAX_SCRUB_INPUT)
  for (const [re, to] of SCRUB) out = out.replace(re, to)
  return out.slice(0, MAX_MESSAGE)
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
}

export interface EventOptions { release: string; environment: string; logger: string; tags: Record<string, string>; now: number }

const TAG_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/
/** a tag value is a code (instance a, provider apns, reason InvalidProviderToken, log event ops_keys_unusable) */
export const TAG_VALUE_RE = /^[A-Za-z0-9_.:@-]{1,64}$/

function cleanTags(...all: (Record<string, string> | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const tags of all) {
    for (const [k, v] of Object.entries(tags ?? {})) {
      if (Object.keys(out).length >= MAX_TAGS) break
      if (TAG_KEY_RE.test(k) && typeof v === 'string' && TAG_VALUE_RE.test(v)) out[k] = v
    }
  }
  return out
}

/** Everything Sentry receives. Adding a field here is a privacy decision: see docs/DECISIONS.md first. */
export function buildEvent(i: ErrorInput, o: EventOptions): Record<string, unknown> {
  const frames = i.stack ? parseStack(i.stack, i.message) : []
  return {
    event_id: randomBytes(16).toString('hex'),
    timestamp: o.now / 1000,
    platform: 'node',
    level: i.fatal ? 'fatal' : 'error',
    logger: o.logger,
    release: o.release,
    environment: o.environment,
    sdk: { name: 'mycel.sentry-report', version: '1.0.0' },
    tags: cleanTags(o.tags, i.tags),
    exception: {
      values: [{
        type: i.type && /^[A-Za-z_$][\w$]{0,79}$/.test(i.type) ? i.type : 'Error',
        value: scrubText(i.message),
        ...(frames.length ? { stacktrace: { frames } } : {}),
        mechanism: { type: o.logger, handled: !i.fatal },
      }],
    },
  }
}

/** Seconds to wait from Sentry's answer, or null. X-Sentry-Rate-Limits lists "seconds:categories:scope" entries; only
 *  those for errors (or for every category) apply here. */
export function pauseSeconds(limits: string | null, status: number, retryAfter: string | null): number | null {
  if (limits) {
    let wait = 0
    for (const entry of limits.split(',')) {
      const [secs = '', cats = ''] = entry.trim().split(':')
      const n = Number.parseInt(secs, 10)
      const list = cats.split(';').filter(Boolean)
      if (Number.isFinite(n) && (list.length === 0 || list.includes('error') || list.includes('default'))) wait = Math.max(wait, n)
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
    const key = `${i.type}|${tags}|${i.message.slice(0, 100)}|${frames.slice(0, 400)}`
    this.sentAt = this.sentAt.filter((t) => t <= now && now - t < 60_000)
    for (const [k, at] of this.recent) if (at > now || now - at >= REPEAT_WINDOW_MS) this.recent.delete(k)
    if (this.recent.has(key)) return false
    if (!i.fatal && this.sentAt.length >= MAX_PER_MINUTE) return false
    this.sentAt.push(now)
    this.recent.set(key, now)
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
    try { reporter.capture({ type: err.name, message: err.message, stack: err.stack, fatal: true }) } catch { /* exit anyway */ }
    try { logLine(what, err) } catch { /* exit anyway */ }
    void reporter.flush(CRASH_FLUSH_MS).catch(() => {}).finally(() => proc.exit(1))
  }
  proc.on('uncaughtException', die('uncaught exception'))
  proc.on('unhandledRejection', die('unhandled rejection'))
}
