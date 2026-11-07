// Error reports to Sentry: off unless an admin sets MYCEL_SENTRY_DSN or MYCEL_SENTRY_WEB_DSN (docs/CONFIGURATION.md).
// There is no Sentry SDK here on purpose: this file is the allowlist. A value reaches Sentry only if buildEvent names it,
// so log fields, request paths and bodies, engine output and hostnames cannot get there by accident. A hosted server
// refuses a key: the terms and the privacy policy name who receives customer content, and Sentry is not on that list.
// docs/DECISIONS.md "Error reports to Sentry".
import { randomBytes } from 'node:crypto'
import type { AppConfig } from '../app-config'
import type { Logger } from '../log'
import { isHosted } from './deployment'

const MAX_SCRUB_INPUT = 1000
const MAX_MESSAGE = 300
const MAX_FRAMES = 40
/** a stack line longer than this is not a frame: the frame pattern is slow on a very long line */
const MAX_FRAME_LINE = 500
const MAX_PER_MINUTE = 30
const REPEAT_WINDOW_MS = 60_000
const SEND_TIMEOUT_MS = 5_000
const CRASH_FLUSH_MS = 2_000
const DEFAULT_PAUSE_MS = 60_000
const MAX_PAUSE_MS = 3_600_000
/** browser reports per signed-in person: one person must not use up the project's quota */
const CLIENT_REPORTS = 10
const CLIENT_WINDOW_MS = 10 * 60_000

export interface SentryTarget { url: string; key: string }

/** The key Sentry shows for a project: https://<public key>@<host>/<project id>. */
export function parseDsn(dsn: string): SentryTarget | null {
  let u: URL
  try { u = new URL(dsn) } catch { return null }
  const cut = u.pathname.lastIndexOf('/')
  const project = u.pathname.slice(cut + 1)
  if (u.protocol !== 'https:' || !u.username || !/^\d+$/.test(project)) return null
  return { url: `https://${u.host}${u.pathname.slice(0, cut)}/api/${project}/envelope/`, key: u.username }
}

const SECRET_NAME = 'pass(?:word|phrase|wd)?|pwd|(?:access_|refresh_|id_)?token|(?:client_)?secret|api[_-]?key|authorization|cookie|session|sid'
/** In this order: quoted text first, because it is where a value usually sits ("password='a b'" would leave "b"), and
 *  "Bearer x" before "authorization: …", which would otherwise take the word Bearer as the value and leave the token. */
const SCRUB: readonly [RegExp, string][] = [
  [/(?<![A-Za-z0-9])'[^']*(?:'|$)|"[^"]*(?:"|$)|`[^`]*(?:`|$)/g, '[text]'],
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [new RegExp(`(?<![A-Za-z0-9])(${SECRET_NAME})(?![A-Za-z0-9])\\s*[:=]\\s*(?:Bearer \\[redacted\\]|\\S+)`, 'gi'), '$1=[redacted]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]'],
  [/[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\S*[\\/]\S*/g, '[path]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]'],
  [/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, '[ip]'],
  // a host or a file of any kind: whatever has a dot inside a word (acme.trina.app, alice-macbook.local, plan.key)
  [/\b[\w-]+(?:\.[\w-]+)+\b/g, '[name]'],
  [/\b[A-Za-z0-9_-]{20,}\b/g, '[id]'],
  [/\+?\d[\d ().-]{5,}\d/g, '[number]'],
  // the code's own messages are English: other letters here came from a person (a name, a file, a chat)
  [/[^\x00-\x7F]+/g, '[text]'],
]

/** A message with what a person typed or owns taken out. It cannot recognise plain English words as a name: a file
 *  called "Q3 Sales Report.pdf" leaves "Q3 Sales [name]". */
export function scrubText(s: string): string {
  let out = s.split('\n', 1)[0]!.slice(0, MAX_SCRUB_INPUT)
  for (const [re, to] of SCRUB) out = out.replace(re, to)
  return out.slice(0, MAX_MESSAGE)
}

export interface Frame { filename: string; function: string; lineno: number; colno: number; in_app: boolean }

const FRAME_V8 = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/
const FRAME_GECKO = /^(.*?)@(.+?):(\d+):(\d+)$/
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/
const EXTENSION = /^(?:chrome|moz|safari|safari-web|ms-browser)-extension:|^webkit-masked-url:/
const EXTERNAL = { filename: '[external]', in_app: false }

/** A browser frame: only the app's own build files, by their build name, without the team's address. */
function browserFile(raw: string): { filename: string; in_app: boolean } {
  if (EXTENSION.test(raw)) return EXTERNAL
  const at = raw.indexOf('/assets/')
  if (at < 0) return EXTERNAL
  const name = raw.slice(at + 1).split(/[?#]/, 1)[0]!
  return /^assets\/[\w.-]{1,120}\.m?js$/.test(name) ? { filename: name, in_app: true } : EXTERNAL
}

/** A server frame: the last two parts of the name, because the install folder can hold a person's name. */
function serverFile(raw: string): { filename: string; in_app: boolean } {
  const clean = raw.split(/[?#]/, 1)[0]!
  if (clean.startsWith('native') || clean.startsWith('node:')) return { filename: clean, in_app: false }
  if (!CODE_FILE.test(clean)) return { filename: '[file]', in_app: false }
  return { filename: clean.split(/[\\/]/).slice(-2).join('/'), in_app: !clean.includes('node_modules') }
}

/** What comes after the message: a message can hold lines that look like frames (a tool's output). */
function afterMessage(stack: string, message: string): string {
  const at = message ? stack.indexOf(message) : -1
  return at >= 0 ? stack.slice(at + message.length) : stack
}

/** Sentry's order: the oldest call first. */
export function parseStack(stack: string, message: string, browser: boolean): Frame[] {
  const frames: Frame[] = []
  for (const line of afterMessage(stack, message).split('\n')) {
    if (line.length > MAX_FRAME_LINE) continue
    const m = FRAME_V8.exec(line) ?? (browser ? FRAME_GECKO.exec(line) : null)
    if (!m) continue
    const fn = m[1] ?? ''
    frames.push({
      ...(browser ? browserFile(m[2]!) : serverFile(m[2]!)),
      function: /^[\w$.<>]{1,80}$/.test(fn) ? fn : '?',
      lineno: Number(m[3]),
      colno: Number(m[4]),
    })
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
  /** the log line's own text, written by a developer */
  logLine?: string
  method?: string
  /** the route pattern (/api/files/:id), never the path */
  route?: string
  /** the first part of the web page's path */
  page?: string
}

interface EventOptions { release: string; environment: string; logger: string; browser: boolean; now: number }

function tagsOf(i: ErrorInput): Record<string, string> {
  const tags: Record<string, string> = {}
  if (i.logLine) tags.log_line = scrubText(i.logLine)
  if (i.method && /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(i.method)) tags.method = i.method
  if (i.route && /^[\w\-/:*.]{1,120}$/.test(i.route)) tags.route = i.route
  if (i.page && /^\/[a-z0-9-]{0,32}$/.test(i.page)) tags.page = i.page
  return tags
}

/** Everything Sentry receives. Adding a field here is a privacy decision: see docs/DECISIONS.md first. */
export function buildEvent(i: ErrorInput, o: EventOptions): Record<string, unknown> {
  const frames = i.stack ? parseStack(i.stack, i.message, o.browser) : []
  return {
    event_id: randomBytes(16).toString('hex'),
    timestamp: o.now / 1000,
    platform: o.browser ? 'javascript' : 'node',
    level: i.fatal ? 'fatal' : 'error',
    logger: o.logger,
    release: o.release,
    environment: o.environment,
    sdk: { name: 'mycel.error-report', version: '1.0.0' },
    tags: tagsOf(i),
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

export interface ReporterOptions {
  release: string
  environment: string
  logger: 'server' | 'web'
  fetch?: typeof fetch
  now?: () => number
}

/** Sends on its own time: capture never throws, never waits and never logs, so an error cannot report itself. */
export class ErrorReporter {
  private inflight = new Set<Promise<void>>()
  private recent = new Map<string, number>()
  private sentAt: number[] = []
  private pausedUntil = 0
  private send: typeof fetch
  private now: () => number

  constructor(private target: SentryTarget, private o: ReporterOptions) {
    this.send = o.fetch ?? fetch
    this.now = o.now ?? Date.now
  }

  capture(input: ErrorInput): void {
    try {
      const now = this.now()
      // a clock set back must not leave sending paused for its whole jump
      if (this.pausedUntil - now > MAX_PAUSE_MS) this.pausedUntil = 0
      if (now < this.pausedUntil || !this.admit(input, now)) return
      const event = buildEvent(input, { release: this.o.release, environment: this.o.environment, logger: this.o.logger, browser: this.o.logger === 'web', now })
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
    const key = `${i.type}|${i.logLine}|${i.message.slice(0, 100)}|${frames.slice(0, 400)}`
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
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.target.key}, sentry_client=mycel.error-report/1.0.0`,
      },
      body: `${JSON.stringify(header)}\n{"type":"event"}\n${JSON.stringify(event)}\n`,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    const wait = pauseSeconds(res.headers.get('x-sentry-rate-limits'), res.status, res.headers.get('retry-after'))
    if (wait !== null) this.pausedUntil = this.now() + Math.min(wait * 1000, MAX_PAUSE_MS)
    await res.body?.cancel()
  }
}

/** A log line as a report. Only the error object and the three named fields are read: other log fields can hold paths,
 * addresses and engine output. */
export function logLineInput(msg: string, fields?: Record<string, unknown>): ErrorInput {
  const err = [fields?.err, fields?.error, fields?.cause].find((x) => x instanceof Error) as Error | undefined
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    ...(err ? { type: err.name, message: err.message, stack: err.stack, logLine: msg } : { type: 'LogError', message: msg }),
    method: text(fields?.method),
    route: text(fields?.route),
  }
}

const clientSent = new Map<string, number[]>()

/** Browser reports from one person in the last CLIENT_WINDOW_MS. Over the limit they are dropped quietly. */
export function clientReportAllowed(userId: string, now: number = Date.now()): boolean {
  const recent = (clientSent.get(userId) ?? []).filter((t) => t <= now && now - t < CLIENT_WINDOW_MS)
  const ok = recent.length < CLIENT_REPORTS
  if (ok) recent.push(now)
  if (clientSent.size >= 10_000 && !clientSent.has(userId)) clientSent.clear()
  clientSent.set(userId, recent)
  return ok
}

export function _resetClientReportsForTest(): void { clientSent.clear() }

export interface ErrorReports {
  server: ErrorReporter | null
  web: ErrorReporter | null
  /** a key was set on a hosted server and ignored */
  refused: boolean
  /** settings whose value is not a Sentry key */
  invalid: string[]
}

const NONE: ErrorReports = { server: null, web: null, refused: false, invalid: [] }

export function errorReportsFrom(env: Record<string, string | undefined>, cfg: AppConfig, version: string): ErrorReports {
  const serverDsn = env.MYCEL_SENTRY_DSN?.trim(), webDsn = env.MYCEL_SENTRY_WEB_DSN?.trim()
  if (!serverDsn && !webDsn) return NONE
  if (isHosted(cfg)) return { ...NONE, refused: true }
  const named = env.MYCEL_SENTRY_ENV?.trim()
  const environment = named && /^[a-z0-9._-]{1,32}$/.test(named) ? named : cfg.mode === 'dev' ? 'dev' : 'production'
  const invalid: string[] = []
  const reporter = (setting: string, dsn: string | undefined, logger: 'server' | 'web') => {
    if (!dsn) return null
    const target = parseDsn(dsn)
    if (!target) { invalid.push(setting); return null }
    return new ErrorReporter(target, { release: `mycel@${version}`, environment, logger })
  }
  return { server: reporter('MYCEL_SENTRY_DSN', serverDsn, 'server'), web: reporter('MYCEL_SENTRY_WEB_DSN', webDsn, 'web'), refused: false, invalid }
}

let active = NONE
export function setErrorReports(r: ErrorReports): void { active = r }
/** Takes browser reports (POST /api/client-errors), and GET /api/me tells the web app to send them. */
export const webErrorReporter = (): ErrorReporter | null => active.web

interface CrashTarget {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (e: unknown) => void): unknown
  exit(code: number): void
}

/** The process still ends with code 1 as it does without these handlers, so its supervisor restarts it the same way.
 * They exist only while reports are on: a listener is what stops the default crash. Each step is guarded, because a
 * step that throws here (the log on a full disk) would otherwise leave a broken server running. */
export function reportCrashes(reporter: ErrorReporter, log: Logger, proc: CrashTarget = process): void {
  let dying = false
  const die = (what: string) => (e: unknown) => {
    if (dying) return
    dying = true
    const err = e instanceof Error ? e : new Error(what)
    try { reporter.capture({ type: err.name, message: err.message, stack: err.stack, fatal: true, logLine: what }) } catch { /* exit anyway */ }
    try { log.error(what, { err }) } catch { /* exit anyway */ }
    void reporter.flush(CRASH_FLUSH_MS).catch(() => {}).finally(() => proc.exit(1))
  }
  proc.on('uncaughtException', die('uncaught exception'))
  proc.on('unhandledRejection', die('unhandled rejection'))
}
