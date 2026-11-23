// What the person allowed on a server card in a chat (chat_card_approvals, migration 413), so the same card does not
// come back for the same kind of action to the same target in that chat (docs/decisions/
// 20261117-card-approved-once-per-chat.md). Only the person's own [이번만 허용] / [보내기] on a card counts, never a text
// match of their message and never "Always allow" (chat/always-allow.ts keeps that). The target is built by the server
// from the call itself (a file's path, a connection with its tool and every value that may say where the call goes, a
// room), so the AI cannot widen it by reusing an approval: a new recipient, another room or another file is another
// target and asks. Each approval covers the person's own turns in that chat for APPROVAL_HOURS at most, and goes with
// the chat's session (chat/turn.ts newSession), as chats.others_words does.

import type { Database } from 'bun:sqlite'

export type ApprovalKind =
  /** a change to one team file after a room read (chat/turn.ts confirmRoomChange): target = the file's path */
  | 'file_change'
  /** a write to one connection with one tool (integrations/connections/tools.ts gate): target = connection, its version
   * and the tool; detail.pins = every value of the call that may say where it goes (pinTargets) */
  | 'connector'
  /** an id (a draft's) that a connection write the person allowed on its card returned: target = connection and
   * version; detail.id. Dropped once any later write names it (it may have changed) */
  | 'connector_made'
  /** a post to one room or thread (chat/post-to-room.ts): target = the room and the thread */
  | 'room_post'
  /** a save where more people can see than can see what the chat read (chat/turn.ts widenNeed): target = the folder and
   * who may see it (folderAudience); detail.sources = the narrower sources the card named (sourceKey) */
  | 'save_wider'
  /** content from sources some recipients could not see that the person sent on a post card in this chat (chat/post-to-
   * room.ts; docs/decisions/20261123-do-then-undo.md "one card per source"): target ''; detail.keys = the sources
   * (sourceKey). A later post to a place their own words name, of content from those sources only, needs no card */
  | 'post_sources'
  // (no "Always in this chat" kinds: shared_connection, shared_unsure_tool, shared_own_act and card_always went with
  // docs/decisions/20261123-one-always-allow.md; migration 445 removed their rows)

/** An approval covers the same action for at most this long (then the card asks once more). */
export const APPROVAL_HOURS = 12

const since = (now: number) => new Date(now - APPROVAL_HOURS * 3600_000).toISOString()

/** Keep the person's yes on a card. Never throws: a yes that could not be kept only means the next card asks. */
export function noteApproval(db: Database, a: { chatId: string; userId: string; kind: ApprovalKind; target: string; detail?: Record<string, unknown> }, now = Date.now()): void {
  try {
    db.query('INSERT INTO chat_card_approvals (chat_id, user_id, kind, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.chatId, a.userId, a.kind, a.target, JSON.stringify(a.detail ?? {}), new Date(now).toISOString())
  } catch { /* the card asks again next time */ }
}

/** The person's approvals of this kind and target in this chat that still cover (their details, newest first). Fails
 * closed: none when they cannot be read. */
export function approvalsFor(db: Database, q: { chatId: string; userId: string; kind: ApprovalKind; target: string }, now = Date.now()): Record<string, unknown>[] {
  try {
    const rows = db.query('SELECT detail FROM chat_card_approvals WHERE chat_id = ? AND user_id = ? AND kind = ? AND target = ? AND created_at >= ? ORDER BY id DESC LIMIT 50')
      .all(q.chatId, q.userId, q.kind, q.target, since(now)) as { detail: string }[]
    return rows.flatMap((r) => { try { const d = JSON.parse(r.detail); return d && typeof d === 'object' && !Array.isArray(d) ? [d as Record<string, unknown>] : [] } catch { return [] } })
  } catch { return [] }
}

/** Is there such an approval at all? */
export const approved = (db: Database, q: { chatId: string; userId: string; kind: ApprovalKind; target: string }, now = Date.now()): boolean => approvalsFor(db, q, now).length > 0

/** Drop the approvals of this kind and target whose detail matches (all of them without `match`), for every person,
 * in this chat or (no `chatId`) in every chat: what they covered may have changed. Fails closed: when the rows cannot be
 * read one by one, every approval of that kind and target goes. */
export function dropApprovals(db: Database, q: { chatId?: string; kind: ApprovalKind; target: string }, match?: (detail: Record<string, unknown>) => boolean): void {
  try {
    const rows = (q.chatId
      ? db.query('SELECT id, detail FROM chat_card_approvals WHERE chat_id = ? AND kind = ? AND target = ?').all(q.chatId, q.kind, q.target)
      : db.query('SELECT id, detail FROM chat_card_approvals WHERE kind = ? AND target = ?').all(q.kind, q.target)) as { id: number; detail: string }[]
    for (const r of rows) {
      let d: Record<string, unknown> | null = null
      try { d = JSON.parse(r.detail) } catch { /* unreadable: dropped */ }
      if (!match || !d || match(d)) db.query('DELETE FROM chat_card_approvals WHERE id = ?').run(r.id)
    }
  } catch {
    try { db.query('DELETE FROM chat_card_approvals WHERE kind = ? AND target = ?').run(q.kind, q.target) } catch { /* nothing kept to drop */ }
  }
}

/** A new session (an edited first message, a new chat): nothing allowed before it covers anything. */
export function clearApprovals(db: Database, chatId: string): void {
  try { db.query('DELETE FROM chat_card_approvals WHERE chat_id = ?').run(chatId) } catch { /* the table may not exist yet */ }
}
