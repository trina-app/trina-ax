// Who has messages waiting in a shared chat, and since when (docs/decisions/20261118-shared-chat-queued-sends.md).
// A person's messages typed while an answer runs wait in their browser (web/src/store/sendQueue.ts), as in a chat of
// one person; in a shared chat that browser also tells the server how many wait (PUT /api/chats/:id/waiting), so the
// server, not a race between browsers, decides whose go next when the answer ends: the one who has waited longest.
// A send clears the sender's place: someone with more waiting goes to the back of the line.
//
// Kept in memory only: a restart forgets it, and the browsers say it again on their next refresh (every
// WAITING_REFRESH_MS). A place nobody refreshed for WAITING_TTL_MS (a closed tab, a phone gone to sleep) no longer
// holds the others back. Only how many wait is kept, never what: the text stays in the sender's browser until it is sent.

/** a place nobody refreshed for this long stops counting (the browser refreshes every 15 s: web/src/lib/sendQueue.ts) */
export const WAITING_TTL_MS = 45_000
/** at most this many waiting messages are counted per person (the browser keeps at most 10; a stored queue 50) */
export const WAITING_COUNT_MAX = 50

interface Place { since: number; seen: number; count: number }

export class SharedWaiting {
  private chats = new Map<string, Map<string, Place>>()
  constructor(private now: () => number = Date.now) {}

  /** `userId` has `count` messages waiting in the chat (0: none any more). True when what others are told changed. */
  declare(chatId: string, userId: string, count: number): boolean {
    const t = this.now()
    const before = this.fresh(chatId, t).get(userId)?.count ?? 0
    const places = this.chats.get(chatId) ?? new Map<string, Place>()
    const n = Math.max(0, Math.min(WAITING_COUNT_MAX, Math.floor(count)))
    if (!n) places.delete(userId)
    else {
      const old = places.get(userId)
      // still waiting since the first time it was said (a refresh keeps the place in line)
      places.set(userId, { since: old && t - old.seen <= WAITING_TTL_MS ? old.since : t, seen: t, count: n })
    }
    if (places.size) this.chats.set(chatId, places)
    else this.chats.delete(chatId)
    return before !== n
  }

  /** `userId` sent a message there: their place in line is gone (more of theirs waiting go to the back). */
  sent(chatId: string, userId: string): boolean {
    return this.declare(chatId, userId, 0)
  }

  /** Someone else who has waited longer than `userId` (or who waits while `userId` does not): their id, else null. */
  ahead(chatId: string, userId: string): string | null {
    const places = this.fresh(chatId, this.now())
    const mine = places.get(userId)?.since ?? Infinity
    let first: { id: string; since: number } | null = null
    for (const [id, p] of places) {
      if (id === userId || p.since >= mine) continue
      if (!first || p.since < first.since) first = { id, since: p.since }
    }
    return first?.id ?? null
  }

  /** How many messages of the others wait there (what `viewer` is told: a number, never whose or what). */
  othersCount(chatId: string, viewer: string): number {
    let n = 0
    for (const [id, p] of this.fresh(chatId, this.now())) if (id !== viewer) n += p.count
    return n
  }

  /** the chat is gone for everyone (deleted, purged) */
  drop(chatId: string): void {
    this.chats.delete(chatId)
  }

  private fresh(chatId: string, t: number): Map<string, Place> {
    const places = this.chats.get(chatId)
    if (!places) return new Map()
    for (const [id, p] of places) if (t - p.seen > WAITING_TTL_MS) places.delete(id)
    if (!places.size) this.chats.delete(chatId)
    return places
  }
}
