// A connected AI's read scope (docs/DECISIONS.md "App connectors: a read scope per MCP session"): what it read (files,
// room messages) as read-scope sources (chat/read-scope.ts), so a save or a message that more people would see is
// refused (upload.ts checkUploadTarget, rooms.ts send). One per MCP session, as one per chat in the app: initialize
// gives the client an Mcp-Session-Id (transport.ts), the client sends it on every request, and a new session (a new
// Claude Code run, a new conversation) starts with nothing read. The id only names the scope: it is no credential (the
// bearer token is), never required and never refused; an id the server did not give is a new, empty scope, which a
// client gets anyway by initializing again. Calls without an id share one scope per connection, forgotten after
// SCOPE_IDLE_MS without a tool call. Rows live in remote_mcp_scopes (migration 118), keyed by the grant and the id's
// sha256 ('' without one), so they survive a restart and end with the grant. Only the scope is per session: the call
// queue and the files read before an edit stay the connection's (tools.ts).
import type { Database } from 'bun:sqlite'
import type { ReadSource } from '../../chat/read-scope'
import { hash } from './policy'

/** A scope without a session is forgotten after this long without a tool call. */
export const SCOPE_IDLE_MS = 60 * 60_000
/** At most this many session scopes per connection: the least recently used beyond it are dropped. Every run of an
 * app on one computer shares the connection, so it is far above what parallel work uses; rows are small (one source
 * per folder). */
export const SESSIONS_PER_GRANT = 256
/** At most this many sources in one scope: past it, a read is refused (a new session starts empty). */
export const SCOPE_SOURCES_MAX = 2000
/** An Mcp-Session-Id as MCP allows it (visible ASCII), bounded. */
export const SESSION_ID = /^[\x21-\x7E]{1,128}$/

/** The scope of the calls of one session of one connection. `session`: the call came with an Mcp-Session-Id. */
export interface ConnectorScope { grantId: string; key: string; session: boolean; sources: ReadSource[] }

/** The stored key of a session: its id's sha256, or '' for calls without one. */
export const scopeKey = (session: string | null) => (session === null ? '' : hash('mcp-session\0' + session))

type Row = { sources: string; used_at: number }
const row = (db: Database, grantId: string, key: string) =>
  db.query('SELECT sources, used_at FROM remote_mcp_scopes WHERE grant_id = ? AND session = ?').get(grantId, key) as Row | null
const idle = (key: string, r: Row, now: number) => key === '' && r.used_at <= now - SCOPE_IDLE_MS

/** The sources of a scope as they are now (an idle scope without a session: none), without marking it used. A row
 * that does not parse throws: the caller fails closed. */
export function scopeSources(db: Database, grantId: string, key: string, now: number): ReadSource[] {
  const r = row(db, grantId, key)
  if (!r || idle(key, r, now)) return []
  const v = JSON.parse(r.sources) as unknown
  if (!Array.isArray(v)) throw new Error('bad scope row')
  return v as ReadSource[]
}

/** A tool call on the scope: an idle scope without a session is dropped first (so a later save cannot bring its old
 * sources back), one in use is marked used now. Returns the scope as the call sees it. */
export function openScope(db: Database, grantId: string, session: string | null, now: number): ConnectorScope {
  const key = scopeKey(session)
  const r = row(db, grantId, key)
  if (r && idle(key, r, now)) db.query('DELETE FROM remote_mcp_scopes WHERE grant_id = ? AND session = ?').run(grantId, key)
  else if (r) db.query('UPDATE remote_mcp_scopes SET used_at = ? WHERE grant_id = ? AND session = ?').run(now, grantId, key)
  return { grantId, key, session: session !== null, sources: scopeSources(db, grantId, key, now) }
}

/** Store the scope's sources (the whole list) and mark it used now. A connection keeps at most SESSIONS_PER_GRANT
 * session scopes: the least recently used beyond them go (the one without a session is not counted). */
export function saveScope(db: Database, scope: Pick<ConnectorScope, 'grantId' | 'key'>, sources: ReadSource[], now: number): void {
  db.transaction(() => {
    db.query(`INSERT INTO remote_mcp_scopes (grant_id, session, sources, used_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (grant_id, session) DO UPDATE SET sources = excluded.sources, used_at = excluded.used_at`).run(scope.grantId, scope.key, JSON.stringify(sources), now)
    if (scope.key === '') return
    db.query(`DELETE FROM remote_mcp_scopes WHERE grant_id = ?1 AND session <> '' AND session NOT IN
      (SELECT session FROM remote_mcp_scopes WHERE grant_id = ?1 AND session <> '' ORDER BY used_at DESC, session LIMIT ?2)`).run(scope.grantId, SESSIONS_PER_GRANT)
  })()
}

/** Forget the idle scopes without a session (oauth.ts ingress, with the other expired rows). */
export function pruneScopes(db: Database, now: number): void {
  db.query("DELETE FROM remote_mcp_scopes WHERE session = '' AND used_at <= ?").run(now - SCOPE_IDLE_MS)
}

/** What a full scope answers. */
export const scopeFull = (s: Pick<ConnectorScope, 'session'>) =>
  s.session ? 'Read scope limit reached: start a new session to continue.' : 'Read scope limit reached; reconnect to continue.'
