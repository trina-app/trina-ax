// The one shared notice (docs/decisions/20261123-shared-connector-warning-once.md) marked as seen, for tests whose
// subject is another card in a shared chat: each person given (default: every person) has gone on from the notice for
// every connection there is now, in `place` (`p:<project id>` or `c:<chat id>`).
import type { Database } from 'bun:sqlite'
import { WARNED_PREFIX, sharedBind } from '../../server/src/integrations/connections/tool-allow'

export function warnedIn(db: Database, place: string, users?: string[]): void {
  const people = users ?? (db.query('SELECT id FROM users').all() as { id: string }[]).map((u) => u.id)
  const rows = db.query('SELECT id, url, account FROM integrations').all() as { id: string; url: string; account: string | null }[]
  const at = new Date().toISOString()
  for (const u of people) for (const r of rows) {
    db.query('INSERT OR REPLACE INTO connector_tool_allow (user_id, integration_id, tool, url, created_at) VALUES (?, ?, ?, ?, ?)').run(u, r.id, WARNED_PREFIX + place, sharedBind(r), at)
  }
}
