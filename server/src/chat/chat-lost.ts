// When a chat shared with people goes away for someone, or its creator's account does (docs/decisions/
// 20261122-shared-chat-leave-and-lost-notices.md): the date a deleted creator's chats go for good, and the state of the
// creator's account as the people in the chat read it under the box (Chat.shared.byGone).
import type { Database } from 'bun:sqlite'
import type { AppContext } from '../context'
import { getTeamSettings } from '../admin/settings'

/** When the chats of this deleted account go for good (auth/sweeper.ts: the deletion plus the chat trash days); null
 * while the account is there. */
export function chatGoneAt(ctx: Pick<AppContext, 'db'>, userId: string): string | null {
  const u = ctx.db.query('SELECT deleted_at FROM users WHERE id = ?').get(userId) as { deleted_at: string | null } | null
  if (!u?.deleted_at) return null
  const t = Date.parse(u.deleted_at)
  if (!Number.isFinite(t)) return null
  return new Date(t + getTeamSettings(ctx.db).chatTrashRetentionDays * 86_400_000).toISOString()
}

/** The creator's account as the others in their chat see it: deleted (with the day the chat goes), switched off, or
 * there (null). */
export function creatorGone(db: Database, userId: string): { state: 'deleted'; until: string } | { state: 'disabled' } | null {
  const u = db.query('SELECT status, deleted_at FROM users WHERE id = ?').get(userId) as { status: string; deleted_at: string | null } | null
  if (!u) return null
  if (u.deleted_at) { const until = chatGoneAt({ db }, userId); return until ? { state: 'deleted', until } : null }
  return u.status === 'active' ? null : { state: 'disabled' }
}
