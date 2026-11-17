// What each open window shows now, for the AI's looking_at tool (chat/looking-at.ts; docs/decisions/
// 20261116-ai-screen-and-shared-tools.md). A window says it in a `looking` client frame when its route or side panel
// changes (web lib/lookingAt.ts): the screen's name and ids only. Kept here, in memory, per person and window:
//
// - never written to the database, a log or the audit; gone with the server;
// - a window's state goes when its socket closes, when its person's sessions end, and when nothing was heard from it
//   for LOOKING_TTL_MS (a window pings every 20 s, so an idle open window stays without asking anything more);
// - a window keeps its newest LOOKING_PER_WINDOW places (what it shows now, and what it showed just before); a place
//   left longer than LOOKING_PAST_MS ago is dropped;
// - a frame with no screen (a confidential chat is open) clears the window: it then tells nothing;
// - more than LOOKING_FRAMES_PER_MIN frames a minute from one window are ignored.
//
// A turn's snapshot (what its window showed when the message was sent) is taken by ChatRuntime.createTurn and kept
// until the turn reads it or LOOKING_SNAPSHOT_MS pass. Nothing here is checked against the person's access: these are
// the person's own claims about their own screen, and the tool checks each id before it names anything.
import type { LookingFrame, LookingScreen } from '@mycel/shared/api'
import type { AppContext } from '../context'
import type { Hub } from './hub'

/** nothing heard from a window for this long: its state is dropped (its socket's close may have been missed) */
export const LOOKING_TTL_MS = 5 * 60_000
/** a place the window left this long ago is no longer "just before" */
export const LOOKING_PAST_MS = 30 * 60_000
/** places kept per window: the one shown now and the ones before it */
export const LOOKING_PER_WINDOW = 5
/** frames taken from one window in a minute (the web sends at most two a second, and only on a change) */
export const LOOKING_FRAMES_PER_MIN = 60
/** a turn's snapshot waits this long for its turn to start (a queued turn) */
export const LOOKING_SNAPSHOT_MS = 30 * 60_000
/** snapshots kept at once (the oldest goes first) */
export const LOOKING_SNAPSHOTS_MAX = 2000

/** One place a window showed: the frame's ids, and when the window opened it. */
export interface Looked {
  screen: LookingScreen
  chatId?: string; projectId?: string; roomId?: string; threadRootId?: string; filePath?: string; linkId?: string
  at: number
}
/** What a window showed, newest first (`items[0]` with `current`: it is on the screen now). */
export interface WindowLook { windowId: string; current: boolean; items: Looked[] }

interface WindowState { items: Looked[]; current: boolean; heard: number; frames: number; minute: number }

const sameIds = (a: Looked, b: Omit<Looked, 'at'>) => a.screen === b.screen && a.chatId === b.chatId && a.projectId === b.projectId && a.roomId === b.roomId
  && a.threadRootId === b.threadRootId && a.filePath === b.filePath && a.linkId === b.linkId

export class Looking {
  private people = new Map<string, Map<string, WindowState>>()
  private turns = new Map<string, { userId: string; look: WindowLook | null; at: number }>()
  private swept = 0
  constructor(private now: () => number = Date.now) {}

  /** A window's `looking` frame. */
  frame(userId: string, windowId: string, f: LookingFrame): void {
    const now = this.now()
    // (no timer of its own: what is too old goes with the first frame of each minute, and is never given out before)
    if (now - this.swept >= 60_000) this.sweep()
    let wins = this.people.get(userId)
    if (!wins) { wins = new Map(); this.people.set(userId, wins) }
    let w = wins.get(windowId)
    if (!w) { w = { items: [], current: false, heard: now, frames: 0, minute: now }; wins.set(windowId, w) }
    w.heard = now
    if (now - w.minute >= 60_000) { w.minute = now; w.frames = 0 }
    if (++w.frames > LOOKING_FRAMES_PER_MIN) return
    // nothing to tell (a confidential chat is open): the window tells nothing, what it showed before included
    if (f.screen === null) { w.items = []; w.current = false; return }
    const next: Omit<Looked, 'at'> = {
      screen: f.screen,
      ...(f.chatId ? { chatId: f.chatId } : {}), ...(f.projectId ? { projectId: f.projectId } : {}), ...(f.roomId ? { roomId: f.roomId } : {}),
      ...(f.threadRootId ? { threadRootId: f.threadRootId } : {}), ...(f.filePath ? { filePath: f.filePath } : {}), ...(f.linkId ? { linkId: f.linkId } : {}),
    }
    // the same place again (sent again after a reconnect): it stays where it is, with its first time
    if (w.current && w.items[0] && sameIds(w.items[0], next)) return
    // a place it went back to is listed once, as the newest
    w.items = [{ ...next, at: now }, ...w.items.filter((x) => !sameIds(x, next))].slice(0, LOOKING_PER_WINDOW)
    w.current = true
  }

  /** Any frame of a window (its ping too): it is still there. */
  heard(userId: string, windowId: string): void {
    const w = this.people.get(userId)?.get(windowId)
    if (w) w.heard = this.now()
  }

  /** The window's socket closed. */
  closed(userId: string, windowId: string): void {
    const wins = this.people.get(userId)
    if (!wins) return
    wins.delete(windowId)
    if (!wins.size) this.people.delete(userId)
  }

  /** Every session of the person ended (signed out everywhere, disabled, deleted). */
  ended(userId: string): void {
    this.people.delete(userId)
    for (const [id, t] of this.turns) if (t.userId === userId) this.turns.delete(id)
  }

  private live(w: WindowState, now: number): Looked[] {
    return w.items.filter((x, i) => (i === 0 && w.current) || now - x.at < LOOKING_PAST_MS)
  }

  /** What a window shows and showed, or null (unknown window, nothing told, too long silent). */
  window(userId: string, windowId: string): WindowLook | null {
    const now = this.now()
    const w = this.people.get(userId)?.get(windowId)
    if (!w || now - w.heard >= LOOKING_TTL_MS) return null
    const items = this.live(w, now)
    return items.length ? { windowId, current: w.current, items: items.map((x) => ({ ...x })) } : null
  }

  /** The person's other windows that told something, the most recently changed first. */
  others(userId: string, notWindow: string | null): WindowLook[] {
    const out: WindowLook[] = []
    for (const id of this.people.get(userId)?.keys() ?? []) {
      if (id === notWindow) continue
      const w = this.window(userId, id)
      if (w) out.push(w)
    }
    return out.sort((a, b) => b.items[0]!.at - a.items[0]!.at)
  }

  /** Keep what `windowId` shows now for this turn (taken when its message is sent: the person may move on before the
   * answer asks). */
  snapshot(turnId: string, userId: string, windowId: string | null): void {
    const now = this.now()
    this.turns.set(turnId, { userId, look: windowId ? this.window(userId, windowId) : null, at: now })
    while (this.turns.size > LOOKING_SNAPSHOTS_MAX) this.turns.delete(this.turns.keys().next().value!)
  }

  /** The turn's snapshot: its window's places, null when the window told nothing, undefined when there is no snapshot
   * (the server restarted since, or it waited too long). */
  snapshotOf(turnId: string, userId: string): WindowLook | null | undefined {
    const t = this.turns.get(turnId)
    if (!t || t.userId !== userId || this.now() - t.at >= LOOKING_SNAPSHOT_MS) return undefined
    return t.look
  }

  /** The turn ended: its snapshot goes. */
  forgetTurn(turnId: string): void { this.turns.delete(turnId) }

  /** Drop what is too old. */
  sweep(): void {
    const now = this.now()
    this.swept = now
    for (const [userId, wins] of this.people) {
      for (const [id, w] of wins) {
        if (now - w.heard >= LOOKING_TTL_MS) { wins.delete(id); continue }
        w.items = this.live(w, now)
      }
      if (!wins.size) this.people.delete(userId)
    }
    for (const [id, t] of this.turns) if (now - t.at >= LOOKING_SNAPSHOT_MS) this.turns.delete(id)
  }

  /** People and snapshots kept (tests: nothing grows without bound). */
  get size() { return { people: this.people.size, windows: [...this.people.values()].reduce((n, w) => n + w.size, 0), turns: this.turns.size } }
}

/** Looking on the hub's client frames (chat/runtime.ts starts it beside presence and typing). */
export function startLooking(hub: Hub, ctx: AppContext, now?: () => number): Looking {
  const l = new Looking(now)
  hub.onClientFrame((s, f) => {
    if (f.type !== 'looking') return
    try { l.frame(s.userId, s.windowId, f) } catch (e) { ctx.log.warn('looking frame failed', { err: e }) }
  })
  hub.onFrameSeen((userId, windowId) => l.heard(userId, windowId))
  hub.onWindow((userId, windowId, state) => { if (state === 'closed') l.closed(userId, windowId) })
  hub.onUserEnded((userId) => l.ended(userId))
  return l
}
