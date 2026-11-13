// Relay log: JSON lines on stdout. By design (tab 6, tab 8 "중계 서버 기록") it records only team ids, byte counts,
// stream counts and timestamps. Never client IPs, paths, headers, team names in request context, or content.

export type LogFields = Record<string, string | number | boolean | null | undefined>
export interface RelayLog {
  info(ev: string, f?: LogFields): void
  warn(ev: string, f?: LogFields): void
  error(ev: string, f?: LogFields): void
}

/** Field names that must never appear in relay logs (enforced, also checked by a unit test). */
export const FORBIDDEN_LOG_FIELDS = new Set(['ip', 'clientIp', 'client_ip', 'path', 'url', 'host', 'headers', 'cookie', 'userAgent', 'query'])

/** Called for error lines with the event name and the fields left after FORBIDDEN_LOG_FIELDS (relay/src/report.ts reads
 *  only the event name and `error`). */
export type ErrorLineHook = (ev: string, fields: LogFields) => void

export function createRelayLog(write: (line: string) => void = (l) => process.stdout.write(l + '\n'), quiet = false, report?: ErrorLineHook): RelayLog {
  const emit = (level: string, ev: string, f: LogFields = {}) => {
    if (quiet && level === 'info') return
    const o: Record<string, unknown> = { t: new Date().toISOString(), level, ev }
    const kept: LogFields = {}
    for (const [k, v] of Object.entries(f)) if (v !== undefined && !FORBIDDEN_LOG_FIELDS.has(k)) { o[k] = v; kept[k] = v }
    write(JSON.stringify(o))
    if (level === 'error' && report) try { report(ev, kept) } catch { /* a report never breaks the log */ }
  }
  return {
    info: (ev, f) => emit('info', ev, f),
    warn: (ev, f) => emit('warn', ev, f),
    error: (ev, f) => emit('error', ev, f),
  }
}
