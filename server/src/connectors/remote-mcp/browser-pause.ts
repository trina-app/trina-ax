// A connection's browser pause (migration 135, docs/decisions/20261128-mcp-browser-tools.md): the person pressed Stop
// in their browser on one of the app's tasks, so every browser call of that connection waits until `until` or until
// Resume in Settings › <app> MCP. Per connection, not per session: a client can start a new session at any time.
import type { Database } from 'bun:sqlite'

/** how long a Stop pauses a connection's browser calls */
export const BROWSER_PAUSE_MS = 30 * 60_000

/** the end of a connection's pause as an ISO time, or null (none, or over) */
export function browserPausedUntil(db: Database, grantId: string, now: number): string | null {
  const r = db.query('SELECT until FROM remote_mcp_browser_pauses WHERE grant_id = ?').get(grantId) as { until: number } | null
  return r && r.until > now ? new Date(r.until).toISOString() : null
}

export function pauseBrowser(db: Database, grantId: string, now: number): void {
  db.query('INSERT INTO remote_mcp_browser_pauses (grant_id, until) VALUES (?, ?) ON CONFLICT(grant_id) DO UPDATE SET until = excluded.until').run(grantId, now + BROWSER_PAUSE_MS)
}
