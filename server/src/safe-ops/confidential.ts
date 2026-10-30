import type { Database } from 'bun:sqlite'
import { safeOpsEnabled } from './runner'
const LOCAL_TOOLS = new Set([
  'list',
  'glob',
  'grep',
  'read',
  'write',
  'edit',
  'make_file',
  'share_file',
  'remember',
  'forget',
  'ask_user',
  'set_title',
])
/** Is this conversation confidential (local tools only: no browser, connectors, web fetch or provider web search)?
 * While 1A is on, every conversation is: a turn may start a 1A workflow at any moment, and egress must already be off
 * when it does (the provider's web search is fixed when the engine starts). With 1A off, only the conversations in
 * which a 1A workflow was admitted (safe_ops_chats.material, set before the workflow reads anything) stay
 * confidential, for good; the others get their tools back (DECISIONS 2026-10-30 "1A lock only where 1A worked").
 * Rows written by a build before migration 323 default to material=1 (fail-closed). */
export function confidentialChat(db: Database, chatId: string): boolean {
  if (safeOpsEnabled()) return true
  return !!db.query('SELECT 1 FROM safe_ops_chats WHERE chat_id=? AND material!=0').get(chatId)
}
/** Mark the conversation of this turn confidential for good: called inside the workflow admission transaction, before
 * the workflow reads a source or runs a converter. A turn-less call (no conversation) has nothing to mark. */
export function markConfidentialTurn(db: Database, turnId: string | null) {
  if (!turnId) return
  db.query('INSERT INTO safe_ops_chats(chat_id, material) SELECT t.chat_id, 1 FROM turns t JOIN chats c ON c.id = t.chat_id WHERE t.id=? ON CONFLICT(chat_id) DO UPDATE SET material=1').run(turnId)
}
/** The same answer as confidentialChat without marking anything: for showing the flag (Chat.confidential). */
export function isConfidentialChat(db: Database, chatId: string): boolean {
  return safeOpsEnabled() || !!db.query('SELECT 1 FROM safe_ops_chats WHERE chat_id=?').get(chatId)
}
export function confidentialTurn(db: Database, turnId: string | null): boolean {
  const t = turnId ? (db.query('SELECT chat_id FROM turns WHERE id=?').get(turnId) as { chat_id: string } | null) : null
  return t ? confidentialChat(db, t.chat_id) : safeOpsEnabled()
}
export function localTool(name: string) {
  return LOCAL_TOOLS.has(name)
}
/** Provider-side server search is an egress channel as well as a CLI built-in. */
export function externalSearch(body: unknown): boolean {
  const todo = [body]
  let n = 0
  while (todo.length) {
    const v = todo.pop()
    if (++n > 100_000) return true
    if (!v || typeof v !== 'object') continue
    if (Array.isArray(v)) {
      if (todo.length + v.length > 100_000) return true
      for (const item of v) todo.push(item)
      continue
    }
    const o = v as Record<string, unknown>
    if (typeof o.type === 'string' && /^web_(search|fetch)/.test(o.type)) return true
    for (const x of Object.values(o)) if (x && typeof x === 'object') todo.push(x)
    if (todo.length > 100_000) return true
  }
  return false
}
