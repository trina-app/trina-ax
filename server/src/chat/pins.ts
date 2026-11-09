// Pinned chats (docs/DECISIONS.md "Pinned chats"): the chats a person keeps at the top of their chat list ("상단에
// 고정"). One row per person and chat (migration 277, chat_pins). A pin is its person's alone: a shared project chat
// someone else made can be pinned too, nobody else learns of it, and it never changes who sees the chat. A pin goes with
// the chat (the trash, a purge) and with the person, and the list drops the pins of chats its person can no longer see.
import type { Database } from 'bun:sqlite'
import type { Locale } from '@mycel/shared/api'
import { fail } from '../http/errors'
import { tr } from './i18n'
import type { ChatRuntime } from './runtime'
import { chatFor } from './shared'

/** The most pins a person keeps (the first page of their list carries all of them). */
export const CHAT_PINS_MAX = 50

/** The person's pins, chat id to when, the most recently pinned first. */
export function pinsOf(db: Database, userId: string): Map<string, string> {
  const rows = db.query('SELECT chat_id, pinned_at FROM chat_pins WHERE user_id = ? ORDER BY pinned_at DESC, chat_id DESC').all(userId) as { chat_id: string; pinned_at: string }[]
  return new Map(rows.map((r) => [r.chat_id, r.pinned_at]))
}

/** Drop the person's pins of chats they cannot see now (chatFor 'view': gone, in the trash, a room's, someone else's, a
 * shared chat whose project they no longer see). Returns how many went. */
export function dropUnseenPins(rt: ChatRuntime, userId: string): number {
  const gone: string[] = []
  for (const chatId of pinsOf(rt.db, userId).keys()) {
    try { chatFor(rt, userId, chatId, 'view') } catch { gone.push(chatId) }
  }
  for (const chatId of gone) unpin(rt.db, userId, chatId)
  return gone.length
}

/** Pin a chat the person may view (the route checked it). Pinned already: kept as it was (its place does not move).
 * Refused past CHAT_PINS_MAX, counting only pins of chats the person still sees. */
export function pin(rt: ChatRuntime, userId: string, chatId: string, locale: Locale): void {
  if (rt.store.pinnedAt(userId, chatId)) return
  if (pinsOf(rt.db, userId).size >= CHAT_PINS_MAX && (dropUnseenPins(rt, userId), pinsOf(rt.db, userId).size >= CHAT_PINS_MAX))
    fail('conflict', tr('chatPinsFull', locale, { n: String(CHAT_PINS_MAX) }), { params: { reason: 'chat_pins_full' } })
  // one pin a millisecond after the last at most: two pins in the same instant still keep their order
  const last = (rt.db.query('SELECT MAX(pinned_at) AS t FROM chat_pins WHERE user_id = ?').get(userId) as { t: string | null }).t
  let at = new Date().toISOString()
  if (last && at <= last) at = new Date(Date.parse(last) + 1).toISOString()
  rt.db.query('INSERT OR IGNORE INTO chat_pins (user_id, chat_id, pinned_at) VALUES (?, ?, ?)').run(userId, chatId, at)
}

export function unpin(db: Database, userId: string, chatId: string): boolean {
  return db.query('DELETE FROM chat_pins WHERE user_id = ? AND chat_id = ?').run(userId, chatId).changes > 0
}

/** Everyone's pins of these chats (they went to the trash). */
export function dropChatPins(db: Database, chatIds: readonly string[]): void {
  for (const id of chatIds) db.query('DELETE FROM chat_pins WHERE chat_id = ?').run(id)
}
