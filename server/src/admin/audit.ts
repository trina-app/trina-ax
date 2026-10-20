// Audit log: admin actions and sign-in events (audit_log), plus the read side that merges audit_log, file_events and
// tool_events into one time-ordered list for the admin screen. Chat contents are never written here.
import type { Database } from 'bun:sqlite'
import type { AuditEntry, Page } from '@mycel/shared/api'
import { fail } from '../http/errors'

/** Actions starting with "auth." are shown with source 'auth', the rest with source 'admin'. */
export function audit(db: Database, e: { actor: string | null; action: string; target?: string | null; detail?: Record<string, unknown> | null }): void {
  db.query('INSERT INTO audit_log (actor_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(e.actor, e.action, e.target ?? null, e.detail ? JSON.stringify(e.detail) : null, new Date().toISOString())
}

export interface AuditFilter {
  source?: AuditEntry['source']
  actor?: string
  path?: string
  from?: string
  to?: string
  cursor?: string
  limit?: number
}

interface Row { sid: string; source: AuditEntry['source']; at: string; actor_id: string | null; actor_name: string | null; action: string; target: string | null; turn_id: string | null; detail: string | null }

const encodeCursor = (r: Row) => Buffer.from(JSON.stringify([r.at, r.sid])).toString('base64url')
function decodeCursor(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]]
  } catch {}
  return fail('validation', undefined, { fields: { 'query.cursor': 'invalid cursor' } })
}

/** Newest first, keyset-paginated over (at, sid). `path` limits the list to file events at or under that path. */
export function listAudit(db: Database, f: AuditFilter): Page<AuditEntry> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200)
  const parts: string[] = []
  const args: (string | number)[] = []
  const want = (s: AuditEntry['source']) => (!f.source || f.source === s) && (f.path === undefined || s === 'file')
  if (want('admin') || want('auth')) {
    let cond = '1=1'
    if (f.source === 'auth') cond = "a.action LIKE 'auth.%'"
    else if (f.source === 'admin') cond = "a.action NOT LIKE 'auth.%'"
    parts.push(`SELECT 'a' || substr('0000000000000000' || a.id, -16) AS sid, CASE WHEN a.action LIKE 'auth.%' THEN 'auth' ELSE 'admin' END AS source,
      a.at AS at, a.actor_id AS actor_id, NULL AS turn_id, a.action AS action, a.target AS target, a.detail AS detail FROM audit_log a WHERE ${cond}`)
  }
  if (want('file')) {
    let cond = '1=1'
    if (f.path !== undefined && f.path !== '') { cond = "(e.path = ? OR substr(e.path, 1, ?) = ?)"; args.push(f.path, f.path.length + 1, f.path + '/') }
    parts.push(`SELECT 'f' || substr('0000000000000000' || e.id, -16) AS sid, 'file' AS source, e.at AS at, e.user_id AS actor_id,
      e.turn_id AS turn_id, e.action AS action, e.path AS target,
      json_object('size', e.size, 'sha256', e.sha256, 'detail', e.detail) AS detail FROM file_events e WHERE ${cond}`)
  }
  if (want('tool')) {
    parts.push(`SELECT 't' || substr('0000000000000000' || t.id, -16) AS sid, 'tool' AS source, t.at AS at, t.user_id AS actor_id,
      t.turn_id AS turn_id, t.tool AS action, NULL AS target, json_object('summary', t.summary, 'ok', t.ok) AS detail FROM tool_events t`)
  }
  if (!parts.length) return { items: [], nextCursor: null }
  const where: string[] = []
  const wargs: (string | number)[] = []
  if (f.actor) { where.push('x.actor_id = ?'); wargs.push(f.actor) }
  if (f.from) { where.push('x.at >= ?'); wargs.push(new Date(f.from).toISOString()) }
  if (f.to) { where.push('x.at < ?'); wargs.push(new Date(f.to).toISOString()) }
  if (f.cursor) {
    const [at, sid] = decodeCursor(f.cursor)
    where.push('(x.at < ? OR (x.at = ? AND x.sid < ?))'); wargs.push(at, at, sid)
  }
  const sql = `SELECT x.sid, x.source, x.at, x.actor_id, u.name AS actor_name, x.action, x.target, x.turn_id, x.detail
    FROM (${parts.join(' UNION ALL ')}) AS x
    LEFT JOIN users u ON u.id = x.actor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY x.at DESC, x.sid DESC LIMIT ?`
  const rows = db.query(sql).all(...args, ...wargs, limit + 1) as Row[]
  const more = rows.length > limit
  const page = rows.slice(0, limit)
  return {
    items: page.map((r) => ({
      id: r.sid,
      source: r.source,
      at: r.at,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? r.actor_id } : null,
      action: r.action,
      target: r.target,
      turnId: r.turn_id && /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(r.turn_id) ? r.turn_id : null,
      detail: parseDetail(r.detail),
    })),
    nextCursor: more ? encodeCursor(page[page.length - 1]!) : null,
  }
}

function parseDetail(s: string | null): Record<string, unknown> | null {
  if (!s) return null
  try {
    const v = JSON.parse(s)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.detail === 'string') { try { v.detail = JSON.parse(v.detail) } catch {} }
      return v as Record<string, unknown>
    }
  } catch {}
  return { value: s }
}

/** Remove audit_log rows older than the retention period (file/tool events are kept by their owners' rules). */
export function purgeAudit(db: Database, retentionDays: number, now = Date.now()): number {
  return db.query('DELETE FROM audit_log WHERE at < ?').run(new Date(now - retentionDays * 86_400_000).toISOString()).changes
}
