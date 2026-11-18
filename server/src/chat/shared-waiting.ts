// Who has messages waiting in a shared chat, and since when (docs/decisions/20261118-shared-chat-queued-sends.md).
// A person's messages typed while an answer runs wait in their browser (web/src/store/sendQueue.ts), as in a chat of
// one person; in a shared chat that browser also tells the server how many wait (PUT /api/chats/:id/waiting), so the
// server, not a race between browsers, decides whose go next when the answer ends: the one who has waited longest.
// A send clears the sender's place: someone with more waiting goes to the back of the line.
//
// Kept in memory only: a restart forgets it, and the browsers say it again on their next refresh (every
// WAITING_REFRESH_MS). A place nobody refreshed for WAITING_TTL_MS (a closed tab, a phone gone to sleep) no longer
// holds the others back. Only how many wait is kept, never what: the text stays in the sender's browser until it is sent.
//
// A first place nobody uses never holds the chat: once someone else was refused because of it (no answer running), its
// holder has WAITING_GRACE_MS to send; after that the place goes to the back of the line and holds nobody back until
// they send or stop waiting (a browser that is not looking at the chat, or a script that only says it waits). A say that comes within WAITING_AFTER_SEND_MS of the person's own
// send is ignored (a refresh sent just before the send must not give them a new place).

/** a place nobody refreshed for this long stops counting (the browser refreshes every 15 s: web/src/lib/sendQueue.ts) */
export const WAITING_TTL_MS = 45_000
/** the first in line has this long to send once someone else was held back by them, then goes to the back */
export const WAITING_GRACE_MS = 12_000
/** a say of "waiting" this soon after the person's own send is ignored */
export const WAITING_AFTER_SEND_MS = 3_000
/** at most this many waiting messages are counted per person (the browser keeps at most 10; a stored queue 50) */
export const WAITING_COUNT_MAX = 50

/** `passed`: had the first place and did not send within the grace period: at the back, and holds nobody back until
 * they send (or stop waiting) */
interface Place { since: number; seen: number; count: number; passed?: boolean }

export class SharedWaiting {
  private chats = new Map<string, Map<string, Place>>()
  /** per chat: whose first place held someone else back, and since when (the grace period) */
  private holding = new Map<string, { userId: string; since: number }>()
  /** per chat and person: when their last send went through */
  private sentAt = new Map<string, number>()
  /** WAITING_GRACE_MS (a test may shorten it) */
  graceMs = WAITING_GRACE_MS
  /** WAITING_AFTER_SEND_MS (a test may shorten it) */
  afterSendMs = WAITING_AFTER_SEND_MS
  constructor(private now: () => number = Date.now) {}

  /** `userId` has `count` messages waiting in the chat (0: none any more). True when the people waiting changed (one
   * came or went): what the others are told (Chat.shared.waiting, how many other people wait). */
  declare(chatId: string, userId: string, count: number): boolean {
    const t = this.now()
    const n = Math.max(0, Math.min(WAITING_COUNT_MAX, Math.floor(count)))
    if (n && this.tooSoon(chatId, userId)) return false
    const places = this.fresh(chatId, t)
    const had = places.has(userId)
    if (!n) places.delete(userId)
    else {
      const old = places.get(userId)
      // still waiting since the first time it was said (a refresh keeps the place in line)
      places.set(userId, { since: old ? old.since : t, seen: t, count: n, ...(old?.passed ? { passed: true } : {}) })
    }
    if (places.size) this.chats.set(chatId, places)
    else this.chats.delete(chatId)
    return had !== !!n
  }

  /** `userId` sent there less than WAITING_AFTER_SEND_MS ago: a say of "waiting" now is not taken (it may be a refresh
   * that left before the send); the browser says it again a moment later */
  tooSoon(chatId: string, userId: string): boolean {
    return this.now() - (this.sentAt.get(`${chatId}\u0000${userId}`) ?? -Infinity) < this.afterSendMs
  }

  /** `userId` sent a message there: their place in line is gone (more of theirs waiting go to the back). */
  sent(chatId: string, userId: string): boolean {
    const changed = this.declare(chatId, userId, 0)
    this.sentAt.set(`${chatId}\u0000${userId}`, this.now())
    if (this.sentAt.size > 10_000) for (const [k, at] of this.sentAt) if (this.now() - at > this.afterSendMs) this.sentAt.delete(k)
    return changed
  }

  /** A turn started in the chat: the next quiet moment gives the first in line a fresh grace period. */
  turnStarted(chatId: string): void {
    this.holding.delete(chatId)
  }

  /** Someone else who has waited longer than `userId` (or who waits while `userId` does not): their id, else null.
   * Asked only while no answer runs (a send there): it starts the grace period of the one ahead, and a holder past it
   * goes to the back of the line. */
  ahead(chatId: string, userId: string): string | null {
    const t = this.now()
    const places = this.fresh(chatId, t)
    for (let i = 0; i <= places.size; i++) {
      const mine = places.get(userId)?.since ?? Infinity
      let first: { id: string; since: number } | null = null
      for (const [id, p] of places) {
        if (id === userId || p.passed || p.since >= mine) continue
        if (!first || p.since < first.since) first = { id, since: p.since }
      }
      if (!first) return null
      const held = this.holding.get(chatId)
      if (!held || held.userId !== first.id) {
        this.holding.set(chatId, { userId: first.id, since: t })
        return first.id
      }
      if (t - held.since <= this.graceMs) return first.id
      // they had their chance: to the back of the line, and the next one ahead (if any) gets its own grace period
      const p = places.get(first.id)!
      let last = t
      for (const q of places.values()) last = Math.max(last, q.since + 1)
      places.set(first.id, { ...p, since: last, passed: true })
      this.holding.delete(chatId)
    }
    return null
  }

  /** How many other people have messages waiting there (what `viewer` is told: a number, never who or what). */
  othersCount(chatId: string, viewer: string): number {
    let n = 0
    for (const id of this.fresh(chatId, this.now()).keys()) if (id !== viewer) n++
    return n
  }

  /** the chat is gone for everyone, or no longer shared (deleted, purged, unshared) */
  drop(chatId: string): void {
    this.chats.delete(chatId)
    this.holding.delete(chatId)
  }

  /** `userId` no longer sees these chats (taken out of the project or the people it is shared with) */
  dropUser(userId: string, chatIds: Iterable<string>): void {
    for (const id of chatIds) {
      const places = this.chats.get(id)
      if (!places?.delete(userId)) continue
      if (!places.size) this.chats.delete(id)
      if (this.holding.get(id)?.userId === userId) this.holding.delete(id)
    }
  }

  private fresh(chatId: string, t: number): Map<string, Place> {
    const places = this.chats.get(chatId)
    if (!places) return new Map()
    for (const [id, p] of places) if (t - p.seen > WAITING_TTL_MS) places.delete(id)
    if (!places.size) this.chats.delete(chatId)
    return places
  }
}
