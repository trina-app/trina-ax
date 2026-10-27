import type { Database } from 'bun:sqlite'

const DAYS = 30, CHAT_LIMIT = 200, MESSAGE_LIMIT = 10_000, QUESTION_LIMIT = 2000
export interface FrequentQuestion { question: string; count: number; lastUsedAt: string }

/** A bounded view of this person's current branches. No additional prompt storage or cross-person aggregation. */
export function frequentQuestions(db: Database, userId: string, now = new Date()): { items: FrequentQuestion[]; days: 30; sampled: boolean } {
  const from = new Date(now.getTime() - DAYS * 86400_000).toISOString(), to = now.toISOString()
  const chats = db.query(`SELECT c.id, c.active_leaf_id FROM chats c JOIN users u ON u.id=c.user_id
    WHERE c.user_id=? AND c.deleted_at IS NULL AND u.status='active' AND u.deleted_at IS NULL
      AND c.updated_at>=? AND c.active_leaf_id IS NOT NULL
    ORDER BY c.updated_at DESC,c.id DESC LIMIT ?`).all(userId, from, CHAT_LIMIT + 1) as { id: string; active_leaf_id: string }[]
  const row = db.query(`SELECT id,parent_id,role,author_id,created_at,
      CASE WHEN length(content)<=? THEN content ELSE '' END AS content,
      EXISTS(SELECT 1 FROM turns t WHERE t.user_message_id=m.id AND (t.schedule_id IS NOT NULL OR t.client_kind='schedule')) AS scheduled
    FROM messages m WHERE id=? AND chat_id=?`)
  type Row = { id: string; parent_id: string | null; role: string; author_id: string | null; created_at: string; content: string; scheduled: number }
  const counts = new Map<string, FrequentQuestion>()
  let visited = 0, sampled = chats.length > CHAT_LIMIT
  for (const chat of chats.slice(0, CHAT_LIMIT)) {
    const seen = new Set<string>()
    let id: string | null = chat.active_leaf_id
    while (id && visited < MESSAGE_LIMIT) {
      if (seen.has(id)) { sampled = true; break }
      seen.add(id); visited++
      const m = row.get(QUESTION_LIMIT, id, chat.id) as Row | null
      if (!m) break
      id = m.parent_id
      if (m.role !== 'user' || m.author_id !== userId || m.scheduled || m.created_at < from || m.created_at >= to) continue
      const question = m.content.normalize('NFC').trim().replace(/\s+/g, ' ')
      if (!question || question.length > QUESTION_LIMIT) continue
      const previous = counts.get(question)
      if (previous) {
        previous.count++
        if (m.created_at > previous.lastUsedAt) previous.lastUsedAt = m.created_at
      } else counts.set(question, { question, count: 1, lastUsedAt: m.created_at })
    }
    if (visited >= MESSAGE_LIMIT) { sampled = true; break }
  }
  const items = [...counts.values()].filter(x => x.count >= 2).sort((a, b) =>
    b.count - a.count || b.lastUsedAt.localeCompare(a.lastUsedAt) || (a.question < b.question ? -1 : a.question > b.question ? 1 : 0)).slice(0, 10)
  return { items, days: DAYS, sampled }
}
