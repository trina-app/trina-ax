// Chats the server makes for a piece of its own work, not a conversation of the person: the company profile drafted from
// the website (onboarding/draft.ts, "회사 소개 초안 · <site>"), a team skill drafted from an answer
// (onboarding/skill-draft.ts, "팀 스킬 초안 · …"), the AI's judgement of a skill share (skills/share-judge.ts, deleted
// once read) and the AI's picks among a folder's files for 팀 파일 (onboarding/file-rank.ts, deleted once read). Each is
// already marked by its own table (migrations 227, 232, 249, 272), so no column is added: those marks
// are read here. Such a chat stays out of the chat list and its search (GET /api/chats),
// and the chat list's realtime events (chat.updated); its flow reads it by id as before
// (GET /api/onboarding/profile/draft/:chatId, …/skill-draft/:chatId), its answers still send their message events (the
// profile step watches its steps), and the chat itself still opens by its address.
import type { Database } from 'bun:sqlite'

/** The tables that mark a chat as the server's own work, each keyed by `chat_id`. */
const MARKS = ['onboarding_profile_drafts', 'onboarding_skill_drafts', 'skill_share_judges', 'onboarding_file_ranks'] as const

/** marks known to exist per database (a table is never dropped; one missing is looked for again next time) */
const present = new WeakMap<Database, Set<string>>()
function marksIn(db: Database): string[] {
  let have = present.get(db)
  if (!have) present.set(db, (have = new Set()))
  for (const t of MARKS) {
    if (have.has(t)) continue
    if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) have.add(t)
  }
  return MARKS.filter((t) => have!.has(t))
}

/**
 * A WHERE condition that leaves the server's own chats out: `chatId` is the column holding the chat's id ("chats.id",
 * or "c.id" with an alias). Only marks the database has are named (a test database of another component
 * may lack them); none: always true.
 */
export function notInternalChat(db: Database, chatId = 'chats.id'): string {
  const marks = marksIn(db)
  return marks.length ? marks.map((t) => `NOT EXISTS (SELECT 1 FROM ${t} WHERE chat_id = ${chatId})`).join(' AND ') : '1 = 1'
}

/** Whether a chat is one of the server's own (a draft). A read that fails counts as "no": the chat then shows like any
 * other, which hides nothing the person may not see (these are their own chats). */
export function isInternalChat(db: Database, chatId: string): boolean {
  try {
    return marksIn(db).some((t) => !!db.query(`SELECT 1 FROM ${t} WHERE chat_id = ?`).get(chatId))
  } catch {
    return false
  }
}
