// Auto mode (docs/decisions/20261125-auto-mode.md, plan docs/AGENTS/plan/20261123-0420-auto-mode.md): Trina approves its
// own safe cards and asks the person only on the floor. This file keeps the settings and the audit rows; the decision
// for one card is chat/always-allow.ts autoHere.
//
// - The team value (Admin › Team AI settings autoMode): 'off' (default), 'allowed', 'default'. With the team's "Always
//   allow" switch off it is 'off' too: both mean "the admin wants the cards".
// - The person's own value (users.auto_mode): 1 on, 0 off, NULL = the team's default ('default' starts it on).
// - A guest never has auto mode. An account that is not active has none.
// - One audit row per card it approved (ai.auto_allow), per change of the person's value (ai.auto_mode) and per change
//   of the team value (admin.auto_mode, routes/admin.ts).
import type { Database } from 'bun:sqlite'
import type { AutoApproval, AutoModeTeam, AutoRule, CardAlwaysKind } from '@mycel/shared/api'
import { CARD_ALWAYS_KINDS } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import { getTeamSettings } from '../admin/settings'
import { isGuestUser } from '../credentials/guest-ai'

/** After this many cards auto mode approved in one chat in one day, the cards come back for that chat (plan section 7,
 * as Claude Code's fallback to manual approval). */
export const AUTO_DAY_LIMIT = 20

/** The team value as it works now: 'off' also while the team's "Always allow" switch is off. Fails closed. */
export function autoModeTeam(db: Database): AutoModeTeam {
  try {
    const s = getTeamSettings(db)
    if (s.roomAlwaysAllow === false) return 'off'
    return s.autoMode === 'allowed' || s.autoMode === 'default' ? s.autoMode : 'off'
  } catch { return 'off' }
}

/** May this person use auto mode at all (the team allows it, an active member, not a guest)? Fails closed. */
export function autoModeAvailable(db: Database, userId: string): boolean {
  try {
    if (autoModeTeam(db) === 'off') return false
    if (!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId)) return false
    return !isGuestUser(db, userId)
  } catch { return false }
}

/** Is auto mode on for this person now (their own choice, else the team's default)? Fails closed. */
export function autoModeOn(db: Database, userId: string): boolean {
  try {
    if (!autoModeAvailable(db, userId)) return false
    const r = db.query('SELECT auto_mode AS a FROM users WHERE id = ?').get(userId) as { a: number | null } | null
    if (!r) return false
    return r.a === null ? autoModeTeam(db) === 'default' : r.a === 1
  } catch { return false }
}

/** The person turns auto mode on or off (the composer's pill, Settings). On only while the team allows it. Returns the
 * value as it works afterwards. Audited when it changes. */
export function setAutoMode(db: Database, userId: string, on: boolean, via: 'pill' | 'settings'): boolean {
  return db.transaction(() => {
    const before = autoModeOn(db, userId)
    if (on && !autoModeAvailable(db, userId)) return before
    db.query('UPDATE users SET auto_mode = ? WHERE id = ?').run(on ? 1 : 0, userId)
    const after = autoModeOn(db, userId)
    if (after !== before) audit(db, { actor: userId, action: 'ai.auto_mode', target: userId, detail: { on: after, via } })
    return after
  })()
}

/** How many cards auto mode approved in this chat for this person in the last 24 hours (the audit rows). Fails closed:
 * an error counts as the limit. */
export function autoCountToday(db: Database, userId: string, chatId: string): number {
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    const r = db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ai.auto_allow' AND actor_id = ? AND at > ? AND json_extract(detail, '$.chatId') = ?").get(userId, since, chatId) as { n: number } | null
    return r?.n ?? 0
  } catch { return AUTO_DAY_LIMIT }
}

/** One card auto mode approved: the audit row (plan section 10). */
export function noteAutoAllow(db: Database, e: { userId: string; kind: CardAlwaysKind; chatId: string; turnId: string; rule: AutoRule }): void {
  audit(db, { actor: e.userId, action: 'ai.auto_allow', target: e.userId, detail: { kind: e.kind, chatId: e.chatId, turnId: e.turnId, rule: e.rule } })
}

const isKind = (k: unknown): k is CardAlwaysKind => typeof k === 'string' && (CARD_ALWAYS_KINDS as readonly string[]).includes(k)

/** The person's last cards auto mode approved, newest first (Settings › 트리나에게 허용한 것). A chat's title only when
 * the person may still see the chat (theirs, or one shared with them now); never another person's chat title. */
export function recentAutoApprovals(db: Database, userId: string, limit = 50): AutoApproval[] {
  const rows = db.query("SELECT detail, at FROM audit_log WHERE action = 'ai.auto_allow' AND actor_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit) as { detail: string | null; at: string }[]
  const out: AutoApproval[] = []
  for (const r of rows) {
    let d: Record<string, unknown> = {}
    try { d = JSON.parse(r.detail ?? '{}') as Record<string, unknown> } catch {}
    if (!isKind(d.kind)) continue
    const chatId = typeof d.chatId === 'string' ? d.chatId : null
    let chatTitle: string | null = null
    try {
      const c = chatId ? db.query('SELECT title FROM chats WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(chatId, userId) as { title: string | null } | null : null
      chatTitle = c?.title?.trim() || null
    } catch { chatTitle = null }
    out.push({ kind: d.kind, chatId, chatTitle, at: r.at })
  }
  return out
}
