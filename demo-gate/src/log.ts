// Gate log: JSON lines on stdout. It records instance ids, statuses, counts and times. Never a prompt, a body, a
// header, a cookie, a credential or a path secret; a visitor's address only as a short keyed hash (ipTag).
import crypto from 'node:crypto'

export type LogFields = Record<string, string | number | boolean | null | undefined>
export interface GateLog {
  info(ev: string, f?: LogFields): void
  warn(ev: string, f?: LogFields): void
  error(ev: string, f?: LogFields): void
}

/** Field names that never reach a line, whatever a caller passes (checked by a test). */
export const FORBIDDEN_LOG_FIELDS = new Set([
  'ip', 'clientIp', 'headers', 'cookie', 'cookies', 'authorization', 'token', 'secret', 'credential', 'body', 'prompt',
  'messages', 'url', 'query', 'userAgent', 'setCookie',
])

export function createLog(write: (line: string) => void = (l) => process.stdout.write(l + '\n'), quiet = false): GateLog {
  const emit = (level: string, ev: string, f: LogFields = {}) => {
    if (quiet && level === 'info') return
    const o: Record<string, unknown> = { t: new Date().toISOString(), level, ev }
    for (const [k, v] of Object.entries(f)) if (v !== undefined && !FORBIDDEN_LOG_FIELDS.has(k)) o[k] = v
    write(JSON.stringify(o))
  }
  return { info: (ev, f) => emit('info', ev, f), warn: (ev, f) => emit('warn', ev, f), error: (ev, f) => emit('error', ev, f) }
}

/** A visitor address in a log line: 8 hex characters of an HMAC with a key made at start (not reversible later). */
const IP_KEY = crypto.randomBytes(16)
export const ipTag = (ip: string): string => crypto.createHmac('sha256', IP_KEY).update(ip).digest('hex').slice(0, 8)
