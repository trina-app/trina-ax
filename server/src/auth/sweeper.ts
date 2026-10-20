// Periodic clean-up of component A's data: expired sessions, old sign-in attempts, spent reset links, audit rows past
// retention, and the chats / memories of deleted accounts after the chat retention period (tab 5 "삭제").
import fs from 'node:fs'
import path from 'node:path'
import type { AppContext } from '../context'
import { purgeAudit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { authOf } from './service'

export interface SweepResult { sessions: number; attempts: number; resets: number; audit: number; purgedUsers: number }

export function sweep(ctx: AppContext): SweepResult {
  const a = authOf(ctx)
  const now = a.now()
  const db = ctx.db
  const s = getTeamSettings(db)
  const sessions = a.sweepSessions()
  const attempts = a.limiter.sweep()
  const resets = db.query('DELETE FROM password_resets WHERE expires_at < ?').run(new Date(now - 7 * 86_400_000).toISOString()).changes
  const audit = purgeAudit(db, s.auditRetentionDays, now)
  // deleted accounts: chats (messages / artifacts cascade), memories and engine session stashes go after the chat
  // retention period; the users row stays as a tombstone so usage and audit keep their names
  const cutoff = new Date(now - s.chatTrashRetentionDays * 86_400_000).toISOString()
  const gone = db.query("SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at < ? AND (EXISTS (SELECT 1 FROM chats c WHERE c.user_id = users.id) OR EXISTS (SELECT 1 FROM memories m WHERE m.user_id = users.id))").all(cutoff) as { id: string }[]
  for (const u of gone) {
    const chats = db.query('SELECT id FROM chats WHERE user_id = ?').all(u.id) as { id: string }[]
    db.transaction(() => {
      db.query('DELETE FROM memories WHERE user_id = ?').run(u.id)
      db.query('UPDATE projects SET created_by = NULL WHERE created_by = ?').run(u.id)
      db.query('DELETE FROM chats WHERE user_id = ?').run(u.id)
    })()
    for (const c of chats) if (/^[A-Za-z0-9_-]+$/.test(c.id)) fs.rmSync(path.join(ctx.config.dataDir, 'sessions', c.id), { recursive: true, force: true })
  }
  return { sessions, attempts, resets, audit, purgedUsers: gone.length }
}

/** Run now and then every `everyMs` (default hourly) until the context closes. */
export function startSweeper(ctx: AppContext, everyMs = 3600_000): void {
  const run = () => { try { sweep(ctx) } catch (e) { ctx.log.error('auth sweep failed', { err: e }) } }
  const first = setTimeout(run, 5_000)
  const t = setInterval(run, everyMs)
  first.unref?.(); t.unref?.()
  ctx.onClose(() => { clearTimeout(first); clearInterval(t) })
}
