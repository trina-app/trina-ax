// Structured logging: one JSON object per line to stdout (and, when logDir is set, to <logDir>/server-YYYY-MM-DD.log,
// kept 14 days; tab 6/7). Secrets are redacted by key name. Never log message content or file contents.
import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const SECRET_KEY = /pass(word)?|token|secret|cookie|authorization|api[-_]?key|sid$/i
/** usage counts are not secrets: a number under a plural "…tokens" key (tokens, input_tokens, subagentTokens) is shown.
 * A credential is never a number, and a key like "token" or "accessToken" stays redacted whatever it holds. */
const COUNT_KEY = /tokens$/i
const isCount = (k: string, x: unknown) => typeof x === 'number' && Number.isFinite(x) && COUNT_KEY.test(k)

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  level?: LogLevel
  /** write daily files here too */
  dir?: string | null
  /** file name prefix (server, relay, engine, update) */
  name?: string
  retentionDays?: number
  /** pretty single-line output for terminals (dev) */
  pretty?: boolean
  /** capture lines (tests) instead of stdout */
  sink?: (line: string) => void
}

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || typeof v !== 'object') return v
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split('\n').slice(0, 8).join('\n') }
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) && !isCount(k, x) ? '[redacted]' : redact(x, depth + 1)
  return out
}

class FileSink {
  private day = ''
  private fd: number | null = null
  constructor(private dir: string, private name: string, private retentionDays: number) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 })
  }
  write(line: string) {
    const day = new Date().toISOString().slice(0, 10)
    if (day !== this.day) {
      if (this.fd !== null) fs.closeSync(this.fd)
      this.fd = fs.openSync(path.join(this.dir, `${this.name}-${day}.log`), 'a', 0o640)
      this.day = day
      this.prune()
    }
    fs.writeSync(this.fd!, line + '\n')
  }
  private prune() {
    const cutoff = Date.now() - this.retentionDays * 86_400_000
    for (const f of fs.readdirSync(this.dir)) {
      const m = new RegExp(`^${this.name}-(\\d{4}-\\d{2}-\\d{2})\\.log$`).exec(f)
      if (m && Date.parse(m[1]!) < cutoff) try { fs.unlinkSync(path.join(this.dir, f)) } catch {}
    }
  }
}

export function createLogger(o: LoggerOptions = {}, bindings: Record<string, unknown> = {}, shared?: { file: FileSink | null }): Logger {
  const min = RANK[o.level ?? 'info']
  const s = shared ?? { file: o.dir ? new FileSink(o.dir, o.name ?? 'server', o.retentionDays ?? 14) : null }
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < min) return
    const rec = { t: new Date().toISOString(), level, msg, ...(redact(bindings) as object), ...(fields ? (redact(fields) as object) : {}) }
    const line = JSON.stringify(rec)
    if (o.sink) o.sink(line)
    else if (o.pretty) {
      const { t, level: l, msg: m, ...rest } = rec
      const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''
      ;(l === 'error' || l === 'warn' ? process.stderr : process.stdout).write(`${t.slice(11, 23)} ${l.padEnd(5)} ${m}${extra}\n`)
    } else process.stdout.write(line + '\n')
    s.file?.write(line)
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (b) => createLogger(o, { ...bindings, ...b }, s),
  }
}

/** A logger that drops everything (tests that don't care). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silentLogger }
