// "Alice is typing…" (docs/DECISIONS.md "입력 중 표시"): a page says its person is writing in a room's box or a thread's
// box (client frame `room.typing`), and the other members who can read that place are told (control frame
// `room.typing`, shared/src/api/ws.ts). In memory only, on the hub's sockets: no table, never in the replay buffer.
//
// - The same checks as a message: the sender is a member of the room (not archived); for a thread they see its root and
//   it is a message of the timeline (rooms/service.ts rootFor). Anything else is dropped without an answer (a room's
//   existence is not told).
// - Told to the room's other members; in a thread only to those who see its root. Never back to the sender.
// - At most TYPING_BUDGET frames per TYPING_WINDOW_MS per person (the page sends one every ROOM_TYPING_EVERY_MS), at most
//   TYPING_PLACES places at once per person; a "stopped" goes out only after a "typing" was told, and the places of a
//   person whose last window closed are stopped at once. The receivers expire a "typing" by themselves
//   (ROOM_TYPING_EXPIRES_MS), so a lost "stopped" leaves nothing behind.
import { ROOM_TYPING_EXPIRES_MS, type RoomTypingFrame } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { Hub } from '../realtime/hub'
import { canSee, memberRow, members, messageRow, roomRow, threadable } from './store'

export const TYPING_WINDOW_MS = 10_000
export const TYPING_BUDGET = 20
export const TYPING_PLACES = 5

export interface TypingOptions {
  /** a control frame to every open window of a person */
  send(userId: string, frame: RoomTypingFrame): void
  /** does this person have a window open (their places stop when the last one closes) */
  hasWindows(userId: string): boolean
  now?: () => number
}

interface Person {
  /** when their recent frames came (the budget) */
  sent: number[]
  /** the places they were told typing in, by key, with the time and who was told */
  places: Map<string, { roomId: string; threadRootId: string | null; at: number; to: string[] }>
}

const keyOf = (roomId: string, threadRootId: string | null) => `${roomId}:${threadRootId ?? ''}`

export class RoomTyping {
  private people = new Map<string, Person>()
  private readonly now: () => number
  constructor(private ctx: AppContext, private o: TypingOptions) {
    this.now = o.now ?? Date.now
  }

  /** A page's `room.typing`. Returns whether it was told to anyone (tests). */
  frame(userId: string, f: { roomId: string; threadRootId: string | null; typing: boolean }): boolean {
    const now = this.now()
    const p = this.people.get(userId) ?? { sent: [], places: new Map() }
    p.sent = p.sent.filter((t) => now - t < TYPING_WINDOW_MS)
    for (const [k, v] of p.places) if (now - v.at >= ROOM_TYPING_EXPIRES_MS) p.places.delete(k)
    if (p.sent.length >= TYPING_BUDGET) return false
    p.sent.push(now)
    this.people.set(userId, p)
    const key = keyOf(f.roomId, f.threadRootId)
    if (!f.typing) {
      // nothing to stop where nobody was told (and a stop needs no second look: it goes to those told the start)
      const was = p.places.get(key)
      if (!was) return false
      p.places.delete(key)
      this.tell(was.to, { ...f, userId })
      return true
    }
    if (!p.places.has(key) && p.places.size >= TYPING_PLACES) return false
    const to = this.readers(userId, f.roomId, f.threadRootId)
    if (!to) {
      p.places.delete(key)
      return false
    }
    p.places.set(key, { roomId: f.roomId, threadRootId: f.threadRootId, at: now, to })
    this.tell(to, { ...f, userId })
    return true
  }

  /** The person's last window closed: their places stop now (not after the receivers' expiry). */
  windowClosed(userId: string) {
    if (this.o.hasWindows(userId)) return
    const p = this.people.get(userId)
    this.people.delete(userId)
    if (!p) return
    const now = this.now()
    for (const v of p.places.values()) if (now - v.at < ROOM_TYPING_EXPIRES_MS) this.tell(v.to, { roomId: v.roomId, threadRootId: v.threadRootId, userId, typing: false })
  }

  /** Who may be told: the other members who can read the place, or null when the sender may not write there. */
  private readers(userId: string, roomId: string, threadRootId: string | null): string[] | null {
    const db = this.ctx.db
    const room = roomRow(db, roomId)
    if (!room || room.archived_at) return null
    const me = memberRow(db, roomId, userId)
    if (!me) return null
    const all = members(db, roomId)
    if (!threadRootId) return all.map((m) => m.user_id).filter((id) => id !== userId)
    const root = messageRow(db, roomId, threadRootId)
    if (!root || !threadable(root) || !canSee(db, root, me)) return null
    return all.filter((m) => m.user_id !== userId && canSee(db, root, m)).map((m) => m.user_id)
  }

  private tell(to: readonly string[], f: Omit<RoomTypingFrame, 'type'>) {
    const frame: RoomTypingFrame = { type: 'room.typing', roomId: f.roomId, threadRootId: f.threadRootId, userId: f.userId, typing: f.typing }
    for (const id of to) {
      try { this.o.send(id, frame) } catch (e) { this.ctx.log.warn('typing frame not sent', { err: e }) }
    }
  }

  /** People with state kept (tests: nothing grows without bound). */
  get size() { return this.people.size }
}

/** Typing on the hub's client frames (chat/runtime.ts starts it with presence). */
export function startRoomTyping(hub: Hub, ctx: AppContext, o: Partial<TypingOptions> = {}): RoomTyping {
  const t = new RoomTyping(ctx, {
    send: (userId, frame) => hub.sendControl(userId, frame),
    hasWindows: (userId) => hub.connectedWindows(userId).length > 0,
    ...o,
  })
  hub.onClientFrame((s, f) => {
    if (f.type !== 'room.typing') return
    try { t.frame(s.userId, f) } catch (e) { ctx.log.warn('typing frame failed', { err: e }) }
  })
  hub.onWindow((userId, _w, state) => { if (state === 'closed') t.windowClosed(userId) })
  return t
}
