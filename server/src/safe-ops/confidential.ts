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
export function confidentialChat(db: Database, chatId: string): boolean {
  if (safeOpsEnabled()) {
    db.query('INSERT OR IGNORE INTO safe_ops_chats(chat_id) SELECT id FROM chats WHERE id=?').run(chatId)
    return true
  }
  return !!db.query('SELECT 1 FROM safe_ops_chats WHERE chat_id=?').get(chatId)
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
