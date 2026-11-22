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
 *
 * `on`: the same rule for a query that reaches the chats by id (a section's rows, one chat), with every column of
 * `chats` under that name and each lookup correlated to the row (an indexed EXISTS per chat), so it never reads every
 * message I wrote or every chat shared with me first. Without it the list's form, alias-free, for a scan of my chats.
 */
export function historyWhere(db: Database, me: string, o: { hidden?: boolean; on?: string } = {}): { sql: string; args: string[] } {
  const t = o.on
  const sql = !t
    ? `(room_id IS NULL AND ${notInternalChat(db)} AND deleted_at IS NULL AND (user_id = ?
    OR (shared_at IS NOT NULL AND id IN (SELECT chat_id FROM messages WHERE role = 'user' AND author_id = ?))
    OR (${inPeopleAudienceSql('?')}${o.hidden ? '' : ` AND ${notHiddenSql('?')}`})))`
    // the same five conditions, per row (chat-audience.ts inPeopleAudienceSql / notHiddenSql, correlated)
    : `(${t}.room_id IS NULL AND ${notInternalChat(db, `${t}.id`)} AND ${t}.deleted_at IS NULL AND (${t}.user_id = ?
    OR (${t}.shared_at IS NOT NULL AND EXISTS (SELECT 1 FROM messages hm WHERE hm.author_id = ? AND hm.chat_id = ${t}.id AND hm.role = 'user'))
    OR (${t}.people_shared_at IS NOT NULL AND ${t}.project_id IS NULL AND EXISTS (SELECT 1 FROM chat_audience ha WHERE ha.chat_id = ${t}.id
        AND ((ha.subject_type = 'user' AND ha.subject_id = ?) OR (ha.subject_type = 'group' AND ha.subject_id IN (SELECT hg.group_id FROM group_members hg WHERE hg.user_id = ?))))
      ${o.hidden ? '' : `AND NOT EXISTS (SELECT 1 FROM chat_list_hidden hh WHERE hh.chat_id = ${t}.id AND hh.user_id = ?)`})))`
  // user_id, the messages' author, the audience's two, the hidden list's one
  return { sql, args: Array<string>(o.hidden ? 4 : 5).fill(me) }
}

/** The per-row part of the rule (after historyWhere): a shared chat only while `me` sees it now. */
export const inHistory = (
  aud: { seesChat(userId: string, r: { id: string; user_id: string; shared_at: string | null; project_id: string | null; people_shared_at: string | null }): boolean },
  me: string,
  r: { id: string; user_id: string; shared_at: string | null; project_id: string | null; people_shared_at: string | null },
): boolean => !isSharedRow(r) || aud.seesChat(me, r)
