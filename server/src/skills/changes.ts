// Change tracking of skills/ (docs/DECISIONS.md "팀 스킬 관리"): every create / edit / move / delete / restore under
// skills/, by a person on the file screen or by the AI in a chat turn, is written to the audit log (who, which file,
// AI or not) and announced to the owner and admins (an in-app banner with a link to the file's version history,
// where the previous version can be restored). Hooked on files/store.ts fileEvent: every team-file change records
// one, so none is missed.
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { Locale, type Page, type SkillChange } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit, redactPersonal } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { onFileEvent, readRegular, type FileEventInput } from '../files/store'
import { parseSkill } from '../chat/skills'
import { inSkills } from './guard'
import { st } from './text'

export const SKILL_CHANGE_ACTION = 'skills.change'

interface ChangeDetail { change: SkillChange['change']; from: string | null; byAi: boolean; turnId: string | null; kind: SkillChange['kind']; tool: string | null }

const parse = (d: unknown): Record<string, unknown> => (d && typeof d === 'object' ? d as Record<string, unknown> : {})

/** What a file event means for skills/, or null when it is not a change there. */
export function skillChangeOf(e: FileEventInput): (ChangeDetail & { path: string }) | null {
  const d = parse(e.detail)
  const movedFrom = typeof d.movedFrom === 'string' ? d.movedFrom : null
  const movedTo = typeof d.movedTo === 'string' ? d.movedTo : null
  const folder = d.folder === true
  const tool = typeof d.tool === 'string' ? d.tool : null
  const base = { byAi: e.turnId !== null, turnId: e.turnId, tool }
  if (e.action === 'delete' && movedTo) {
    // a move: the 'create' at the new place records it, unless the new place is outside skills/
    if (!inSkills(e.path) || inSkills(movedTo)) return null
    return { ...base, path: e.path, change: 'move', from: e.path, kind: folder ? 'folder' : null }
  }
  if (!inSkills(e.path)) return null
  switch (e.action) {
    case 'create': case 'upload':
      if (movedFrom) return { ...base, path: e.path, change: 'move', from: movedFrom, kind: folder ? 'folder' : null }
      return { ...base, path: e.path, change: 'create', from: null, kind: folder ? 'folder' : null }
    case 'update': return { ...base, path: e.path, change: 'update', from: null, kind: null }
    case 'delete': return { ...base, path: e.path, change: 'delete', from: null, kind: folder ? 'folder' : null }
    case 'restore': return { ...base, path: e.path, change: 'restore', from: null, kind: folder ? 'folder' : null }
    default: return null // conflict (the copy gets its own 'create'), rejected (nothing changed)
  }
}

/** skill (a name header), rule (a .md without one), folder or other, read from the file as it is now. */
function kindOf(ctx: AppContext, rel: string): SkillChange['kind'] {
  if (!rel.toLowerCase().endsWith('.md')) return 'other'
  try {
    const { bytes } = readRegular(path.join(ctx.files.fx.root, ...rel.split('/')), 1024 * 1024)
    return parseSkill(bytes.subarray(0, 8000).toString('utf8')) ? 'skill' : 'rule'
  } catch { return null }
}

/** History link for a changed file (the file screen opens its version history), the trash for a deleted one. */
export function historyLink(rel: string, change: SkillChange['change'], kind: SkillChange['kind']): string {
  if (change === 'delete') return '/trash'
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (kind === 'folder') return `/files?path=${encodeURIComponent(rel)}`
  return `/files?path=${encodeURIComponent(dir)}&select=${encodeURIComponent(rel)}&history=${encodeURIComponent(rel)}`
}

/** Owners and admins who should hear about it (active, not the person who made the change). */
function watchers(db: Database, except: string): { id: string; locale: Locale }[] {
  const def = teamDefaultLocale(db)
  return (db.query("SELECT id, locale FROM users WHERE role IN ('owner', 'admin') AND status = 'active' AND deleted_at IS NULL AND id <> ?").all(except) as { id: string; locale: string }[])
    .map((u) => ({ id: u.id, locale: Locale.safeParse(u.locale).success ? (u.locale as Locale) : def }))
}

export function recordSkillChange(ctx: AppContext, e: FileEventInput): void {
  const c = skillChangeOf(e)
  if (!c) return
  const kind = c.kind ?? (c.change === 'delete' ? null : kindOf(ctx, c.path))
  const detail: ChangeDetail = { change: c.change, from: c.from, byAi: c.byAi, turnId: c.turnId, kind, tool: c.tool }
  audit(ctx.db, { actor: e.userId, action: SKILL_CHANGE_ACTION, target: c.path, detail: detail as unknown as Record<string, unknown> })
  const who = (ctx.db.query('SELECT name FROM users WHERE id = ?').get(e.userId) as { name: string } | null)?.name ?? e.userId
  const link = historyLink(c.path, c.change, kind)
  const people = watchers(ctx.db, e.userId)
  // after the change is committed (fileEvent can run inside a transaction)
  queueMicrotask(() => {
    for (const u of people) {
      const p = redactPersonal(c.path, u.id)
      try {
        ctx.services.realtime.publish(u.id, { type: 'notice', data: { level: 'info', code: 'skill_changed', message: st('changed', u.locale, { path: p, who, ai: c.byAi ? st('viaAi', u.locale) : '' }), link } })
      } catch (err) { ctx.log.warn('skill change notice failed', { err }) }
    }
  })
}

/** Start tracking skills/ changes for this server instance (called once from createContext). */
export function trackSkillChanges(ctx: AppContext): void {
  onFileEvent(ctx.db, (e) => {
    try { recordSkillChange(ctx, e) } catch (err) { ctx.log.error('recording a team skill change failed', { err, path: e.path }) }
  })
}

/** Admin > 팀 스킬: the changes, newest first. Paths inside someone else's personal folder (a file moved in from
 * there) show only as users/<id>/…, like the audit list. */
export function listSkillChanges(db: Database, viewer: string, o: { cursor?: string; limit?: number }): Page<SkillChange> {
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 200)
  const before = o.cursor && /^\d+$/.test(o.cursor) ? Number(o.cursor) : null
  const rows = db.query(`SELECT a.id, a.at, a.actor_id, u.name AS actor_name, a.target, a.detail FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.action = ? ${before !== null ? 'AND a.id < ?' : ''} ORDER BY a.id DESC LIMIT ?`)
    .all(...(before !== null ? [SKILL_CHANGE_ACTION, before, limit + 1] : [SKILL_CHANGE_ACTION, limit + 1])) as { id: number; at: string; actor_id: string | null; actor_name: string | null; target: string; detail: string | null }[]
  const page = rows.slice(0, limit)
  return {
    items: page.map((r) => {
      let d: Partial<ChangeDetail> = {}
      try { d = JSON.parse(r.detail ?? '{}') } catch {}
      return {
        id: String(r.id), at: r.at,
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name ?? r.actor_id } : null,
        path: r.target, change: d.change ?? 'update', from: d.from ? redactPersonal(d.from, viewer) : null,
        byAi: !!d.byAi, kind: d.kind ?? null,
      }
    }),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
  }
}
