// Periodic clean-up of component A's data: expired sessions, old sign-in attempts, spent reset links, audit rows past
// retention, and the chats / memories of deleted accounts after the chat retention period (tab 5 "삭제").
import type { AppContext } from '../context'
import { forgetPurgedChats } from '../chat/forget'
import { purgeAudit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { authOf } from './service'
import { cleanUpDeletedAccounts } from './account-removal'
import { deleteDueAccounts } from './deletion-requests'

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
  // a shared project chat they made stays for the project's people, under the tombstone name (chat/shared.ts)
  const gone = db.query("SELECT id FROM users WHERE deleted_at IS NOT NULL AND deleted_at < ? AND (EXISTS (SELECT 1 FROM chats c WHERE c.user_id = users.id AND c.shared_at IS NULL) OR EXISTS (SELECT 1 FROM memories m WHERE m.user_id = users.id))").all(cutoff) as { id: string }[]
  const forgetting: Promise<void>[] = []
  for (const u of gone) forgetting.push(purgeChats(ctx, u.id))
  lastSweepForget = Promise.all(forgetting).then(() => {})
  return { sessions, attempts, resets, audit, purgedUsers: gone.length }
}

/** A deleted person's private chats (messages and artifacts cascade), memories and what the chats left outside the
 * database. A shared project chat they made stays for the project's people, under the tombstone name (chat/shared.ts).
 * Returns the launcher's answer (never rejects). */
function purgeChats(ctx: AppContext, userId: string): Promise<void> {
  const db = ctx.db
  const chats = db.query('SELECT id FROM chats WHERE user_id = ? AND shared_at IS NULL').all(userId) as { id: string }[]
  db.transaction(() => {
    db.query('DELETE FROM memories WHERE user_id = ?').run(userId)
    db.query('UPDATE projects SET created_by = NULL WHERE created_by = ?').run(userId)
    // the person who wrote every version of a project's instructions is gone too: nobody wrote them alone now, so
    // they stay outside content for everyone's turns (chat/runtime.ts projectTaints treats NULL that way)
    db.query('UPDATE projects SET instructions_author = NULL, instructions_authored = NULL WHERE instructions_author = ?').run(userId)
    db.query('DELETE FROM chats WHERE user_id = ? AND shared_at IS NULL').run(userId)
  })()
  // what the chat left outside the DB: the engine session stash and the engine's working folder of the chat
  // (the same as purging one chat from the trash; in production the launcher removes the folder, chat/forget.ts)
  return forgetPurgedChats(ctx, chats.map((c) => c.id)).catch(() => {})
}

/** At the deletion of an account whose person asked for it (admin/users.ts removeAccount): their private chats and
 * memories go now, not after the chat retention days. Returns how many chats went. */
export function purgePrivateChatsOf(ctx: AppContext, userId: string): number {
  const { n } = ctx.db.query('SELECT COUNT(*) AS n FROM chats WHERE user_id = ? AND shared_at IS NULL').get(userId) as { n: number }
  lastSweepForget = Promise.all([lastSweepForget, purgeChats(ctx, userId)]).then(() => {})
  return n
}

/** The launcher's answers for the last sweep's purged chats (tests wait on it; never rejects). */
export let lastSweepForget: Promise<void> = Promise.resolve()

/** Run now and then every `everyMs` (default hourly) until the context closes. */
export function startSweeper(ctx: AppContext, everyMs = 3600_000): void {
  const run = () => {
    try { sweep(ctx) } catch (e) { ctx.log.error('auth sweep failed', { err: e }) }
    // accounts whose deletion date passed (auth/deletion-requests.ts): each on its own, retried at the next run
    void deleteDueAccounts(ctx).catch((e) => ctx.log.error('account deletion sweep failed', { err: e }))
  }
  const first = setTimeout(() => {
    // once after a start: accounts deleted earlier lose what the cleanup hooks remove now (auth/account-removal.ts)
    void cleanUpDeletedAccounts(ctx).catch((e) => ctx.log.error('deleted accounts cleanup failed', { err: e }))
    run()
  }, 5_000)
  const t = setInterval(run, everyMs)
  first.unref?.(); t.unref?.()
  ctx.onClose(() => { clearTimeout(first); clearInterval(t) })
}
