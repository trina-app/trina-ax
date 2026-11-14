// Who sees a chat outside projects that its creator shared with chosen people and groups (docs/DECISIONS.md "Chats
// shared with people and groups"; migration 298). The low-level reads only, with no import from the rest of the chat
// code, so every place that decides who sees a chat (chat/shared.ts chatFor, the lists, search, the realtime fan-out,
// attachments, artifacts, export, notifications) can use the same predicate.
//
//   chats.people_shared_at   set while it is shared that way (project_id NULL, shared_at NULL: an older build sees an
//                            ordinary private chat of its creator)
//   chat_audience            the people (by name) and the groups it is shared with
//   chat_list_hidden         "Hide from my list", per person
//
// The people who see it now are its creator and the active people listed or in a listed group, read per request: a
// group's new member sees it at once, someone who leaves the group or whose account is disabled loses it at once.
import type { Database } from 'bun:sqlite'

/** A chat row that is shared with chosen people and groups: marked, and in no project (a move into a project by an
 * older build makes it its creator's private project chat; chat/people-share.ts undoes the mark at start). */
export const isPeopleRow = (r: { people_shared_at: string | null; project_id: string | null }): boolean => !!r.people_shared_at && !r.project_id

/** One entry of a chat's audience. */
export interface AudienceSubject { type: 'user' | 'group'; id: string }

/** A chat's audience entries as stored (people first, then groups; by id). */
export function subjectsOf(db: Database, chatId: string): AudienceSubject[] {
  return (db.query("SELECT subject_type AS type, subject_id AS id FROM chat_audience WHERE chat_id = ? ORDER BY subject_type DESC, subject_id").all(chatId) as AudienceSubject[])
}

/** The active people the entries name (by name or as members of a listed group), sorted, without duplicates. */
export function resolveSubjects(db: Database, subjects: readonly AudienceSubject[]): string[] {
  const users = subjects.filter((s) => s.type === 'user').map((s) => s.id)
  const groups = subjects.filter((s) => s.type === 'group').map((s) => s.id)
  if (!users.length && !groups.length) return []
  return (db.query(`SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL AND (id IN (SELECT value FROM json_each(?1))
    OR id IN (SELECT user_id FROM group_members WHERE group_id IN (SELECT value FROM json_each(?2)))) ORDER BY id`).all(JSON.stringify(users), JSON.stringify(groups)) as { id: string }[]).map((r) => r.id)
}

/** The people who see this people-shared chat now: its creator (while active) and the active people it names or who are
 * in a group it names. Sorted. */
export function peopleAudience(db: Database, chat: { id: string; user_id: string }): string[] {
  return (db.query(`SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL AND (id = ?1
    OR id IN (SELECT subject_id FROM chat_audience WHERE chat_id = ?2 AND subject_type = 'user')
    OR id IN (SELECT g.user_id FROM group_members g JOIN chat_audience a ON a.subject_type = 'group' AND a.subject_id = g.group_id WHERE a.chat_id = ?2))
    ORDER BY id`).all(chat.user_id, chat.id) as { id: string }[]).map((r) => r.id)
}

/** Is `userId` in this people-shared chat now (its creator, or an active person it names or who is in a group it
 * names)? */
export function inPeopleAudience(db: Database, chat: { id: string; user_id: string }, userId: string): boolean {
  if (!db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(userId)) return false
  if (chat.user_id === userId) return true
  return !!db.query(`SELECT 1 FROM chat_audience a WHERE a.chat_id = ?1 AND ((a.subject_type = 'user' AND a.subject_id = ?2)
    OR (a.subject_type = 'group' AND a.subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?2))) LIMIT 1`).get(chat.id, userId)
}

/**
 * SQL for a list's WHERE (table alias-free, on `chats`): the people-shared chats the person bound at `p` ('?' or '?1')
 * is in through chat_audience (by name or a group; not as their creator). With '?' it binds the person's id twice.
 */
export const inPeopleAudienceSql = (p: string): string => `(people_shared_at IS NOT NULL AND project_id IS NULL AND id IN (SELECT a.chat_id FROM chat_audience a
  WHERE (a.subject_type = 'user' AND a.subject_id = ${p}) OR (a.subject_type = 'group' AND a.subject_id IN (SELECT g.group_id FROM group_members g WHERE g.user_id = ${p}))))`
export const IN_PEOPLE_AUDIENCE_SQL = inPeopleAudienceSql('?')

/** SQL for a list's WHERE: not hidden from the bound person's own lists ("Hide from my list"). With '?' it binds the id
 * once. */
export const notHiddenSql = (p: string): string => `id NOT IN (SELECT chat_id FROM chat_list_hidden WHERE user_id = ${p})`
export const NOT_HIDDEN_SQL = notHiddenSql('?')

/** Did this person hide the chat from their own lists? */
export const hiddenByMe = (db: Database, userId: string, chatId: string): boolean =>
  !!db.query('SELECT 1 FROM chat_list_hidden WHERE user_id = ? AND chat_id = ?').get(userId, chatId)

/** The people-shared chats each of these people stopped seeing in an access change (groups, accounts): who saw one before
 * (by name or through a group, an active account) and does not now. `before`/`after`: each person's groups (absent:
 * not active then). Only for the chats' recipients (a creator never loses their own chat this way). */
export function peopleChatsLost(db: Database, before: ReadonlyMap<string, readonly string[]>, after: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const rows = db.query(`SELECT a.chat_id, a.subject_type, a.subject_id, c.user_id FROM chat_audience a JOIN chats c ON c.id = a.chat_id
    WHERE c.people_shared_at IS NOT NULL AND c.project_id IS NULL AND c.deleted_at IS NULL`).all() as { chat_id: string; subject_type: string; subject_id: string; user_id: string }[]
  if (!rows.length) return out
  const byChat = new Map<string, { creator: string; users: Set<string>; groups: Set<string> }>()
  for (const r of rows) {
    let c = byChat.get(r.chat_id)
    if (!c) byChat.set(r.chat_id, (c = { creator: r.user_id, users: new Set(), groups: new Set() }))
    if (r.subject_type === 'user') c.users.add(r.subject_id)
    else c.groups.add(r.subject_id)
  }
  const sees = (groupsOf: ReadonlyMap<string, readonly string[]>, id: string, c: { users: Set<string>; groups: Set<string> }) => {
    const g = groupsOf.get(id)
    return !!g && (c.users.has(id) || g.some((x) => c.groups.has(x)))
  }
  for (const [chatId, c] of byChat) {
    for (const id of before.keys()) {
      if (id === c.creator || !sees(before, id, c) || sees(after, id, c)) continue
      let list = out.get(id)
      if (!list) out.set(id, (list = []))
      list.push(chatId)
    }
  }
  return out
}
