// The one rule for which chats are in a person's Trina history (트리나 기록): GET /api/chats without filters
// (routes/chats.ts), the history's groups (chat/chat-groups.ts myList) and the person's history sections (list
// folders of kind 'chats', chat/nav-folders.ts) all read it from here, so a section never shows or counts a chat the
// history itself does not show (owner decision 2026-11-22, docs/decisions/20261122-trina-history-sections.md "Who
// can go in").
//
// Two parts, both needed:
//   historyWhere   SQL on `chats` (alias-free): not a room's AI session, not one of the server's own drafts, not in the
//                  trash, and one of: my own chat (also one in a project, also a side chat), a shared project chat I
//                  wrote in, a chat shared with me by name or through a group that I did not hide from my list;
//   inHistory      per row, after the SQL: a shared chat only while I see it now (a shared project chat only while I
//                  see its project, never another person's for a guest; a people-shared chat while I am in it:
//                  chat/shared.ts Audiences.seesChat).
import type { Database } from 'bun:sqlite'
import { inPeopleAudienceSql, isSharedRow, notHiddenSql } from './chat-audience'
import { notInternalChat } from './internal-chats'

/**
 * The SQL part of the rule, every parameter a plain `?` bound to the person's id (`args`). `hidden: true` keeps the
 * chats I hid from my list (a search still finds them); never for a section.
 */
export function historyWhere(db: Database, me: string, o: { hidden?: boolean } = {}): { sql: string; args: string[] } {
  const sql = `(room_id IS NULL AND ${notInternalChat(db)} AND deleted_at IS NULL AND (user_id = ?
    OR (shared_at IS NOT NULL AND id IN (SELECT chat_id FROM messages WHERE role = 'user' AND author_id = ?))
    OR (${inPeopleAudienceSql('?')}${o.hidden ? '' : ` AND ${notHiddenSql('?')}`})))`
  // user_id, the messages' author, the audience's two, the hidden list's one
  return { sql, args: Array<string>(o.hidden ? 4 : 5).fill(me) }
}

/** The per-row part of the rule (after historyWhere): a shared chat only while `me` sees it now. */
export const inHistory = (
  aud: { seesChat(userId: string, r: { id: string; user_id: string; shared_at: string | null; project_id: string | null; people_shared_at: string | null }): boolean },
  me: string,
  r: { id: string; user_id: string; shared_at: string | null; project_id: string | null; people_shared_at: string | null },
): boolean => !isSharedRow(r) || aud.seesChat(me, r)
