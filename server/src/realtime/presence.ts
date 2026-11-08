// Online status (docs/DECISIONS.md "접속 상태"): who on the team has the app open and is at it, as a dot on their
// picture. In memory only, from the live WebSocket windows the hub already keeps (no table, no second channel):
//
// - Each open window is `active` or `idle`, as the page says (client frame `presence`); a window that has just connected
//   counts as active until it says otherwise (it sends its state right after `hello`).
// - A person is online when a window of theirs is active, away when windows are open but none is active or they set
//   themselves away (users.prefs.away, PUT /api/me/away), offline when none is open. Several devices: the most online.
// - The team is told a change only once it has held SETTLE_MS (a reconnect of an idle tab says "idle" within
//   milliseconds: nobody sees it flick to online), and offline only after GRACE_MS without any window (a reload or a
//   relay reconnect is not "offline"). Changes close together go out as one frame.
// - Told with the `presence` control frame (shared/src/api/ws.ts): the whole list to each window as it connects, then
//   changes to every open window of the team. Only ids and states: never a device, a window count or a time. Only
//   active accounts are listed (the AI is no account; disabled and deleted accounts are left out), and "offline" is told
//   about anyone, so nobody stays on screen as online after their account was turned off.
import type { PresenceFrame, PresenceState, WindowActivity } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { parsePrefs } from '../auth/users'
import type { Hub } from './hub'

/** a change is told once it has held this long */
export const PRESENCE_SETTLE_MS = 1500
/** no window open for this long: offline (a reload, a relay reconnect within it change nothing) */
export const PRESENCE_GRACE_MS = 30_000
/** changes within this long of the first go out together */
export const PRESENCE_FLUSH_MS = 250

export interface PresenceClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

const realClock: PresenceClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void }).unref?.()
    return t
  },
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

export interface PresenceOptions {
  /** a frame to a person's open windows, or to one of them */
  send(userId: string, frame: PresenceFrame, windowId?: string): void
  /** the people with a window open: who is told */
  recipients(): string[]
  /** an active account of this team (not disabled, not deleted): only they are listed as online or away */
  isPerson(userId: string): boolean
  /** they set themselves away (kept in their account) */
  awayOf(userId: string): boolean
  clock?: PresenceClock
  settleMs?: number
  graceMs?: number
  flushMs?: number
}

interface Person {
  windows: Map<string, WindowActivity>
  away: boolean
  /** what the team was last told */
  told: PresenceState
  timer: unknown
}

export class Presence {
  private people = new Map<string, Person>()
  private outgoing = new Map<string, PresenceState>()
  private flushTimer: unknown = null
  private stopped = false
  private readonly clock: PresenceClock
  private readonly settleMs: number
  private readonly graceMs: number
  private readonly flushMs: number

  constructor(private o: PresenceOptions) {
    this.clock = o.clock ?? realClock
    this.settleMs = o.settleMs ?? PRESENCE_SETTLE_MS
    this.graceMs = o.graceMs ?? PRESENCE_GRACE_MS
    this.flushMs = o.flushMs ?? PRESENCE_FLUSH_MS
  }

  /** A window connected (after its hello and replay): it counts as active, and gets the whole list. */
  open(userId: string, windowId: string): void {
    if (this.stopped) return
    if (this.o.isPerson(userId)) {
      const p = this.person(userId)
      p.windows.set(windowId, 'active')
      this.schedule(userId, p)
    }
    this.o.send(userId, { type: 'presence', full: true, people: this.list() }, windowId)
  }

  close(userId: string, windowId: string): void {
    const p = this.people.get(userId)
    if (!p || !p.windows.delete(windowId)) return
    this.schedule(userId, p)
  }

  /** A window says it is in use or idle. Ignored for a window this does not know (closed meanwhile). */
  activity(userId: string, windowId: string, state: WindowActivity): void {
    const p = this.people.get(userId)
    if (!p || !p.windows.has(windowId) || p.windows.get(windowId) === state) return
    p.windows.set(windowId, state)
    this.schedule(userId, p)
  }

  /** They set themselves away, or back to automatic (already saved in their account). */
  setAway(userId: string, away: boolean): void {
    const p = this.people.get(userId)
    if (!p || p.away === away) return
    p.away = away
    this.schedule(userId, p)
  }

  /** What a person's windows and setting add up to now (not yet told, maybe). */
  current(userId: string): PresenceState {
    const p = this.people.get(userId)
    return p ? stateOf(p) : 'offline'
  }

  /** What the team was last told about a person. */
  told(userId: string): PresenceState {
    return this.people.get(userId)?.told ?? 'offline'
  }

  /** Everyone the team was told is online or away, active accounts only. */
  list(): PresenceFrame['people'] {
    const out: PresenceFrame['people'] = []
    for (const [id, p] of this.people) if (p.told !== 'offline' && this.o.isPerson(id)) out.push({ id, state: p.told })
    return out
  }

  stop(): void {
    this.stopped = true
    for (const p of this.people.values()) if (p.timer) this.clock.clearTimeout(p.timer)
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer)
    this.people.clear()
    this.outgoing.clear()
    this.flushTimer = null
  }

  private person(userId: string): Person {
    let p = this.people.get(userId)
    if (!p) {
      let away = false
      try { away = this.o.awayOf(userId) } catch { /* automatic */ }
      p = { windows: new Map(), away, told: 'offline', timer: null }
      this.people.set(userId, p)
    }
    return p
  }

  /** Tell the team once the person's state has held (offline: after the grace); a change back in time tells nobody. */
  private schedule(userId: string, p: Person) {
    if (p.timer) this.clock.clearTimeout(p.timer)
    p.timer = null
    const now = stateOf(p)
    if (now === p.told) return this.forget(userId, p)
    p.timer = this.clock.setTimeout(() => {
      p.timer = null
      if (this.stopped || this.people.get(userId) !== p) return
      const state = stateOf(p)
      if (state !== p.told) {
        p.told = state
        this.queue(userId, state)
      }
      this.forget(userId, p)
    }, now === 'offline' ? this.graceMs : this.settleMs)
  }

  /** Nothing left to remember: offline, told so, no window (their away setting is read again when they come back). */
  private forget(userId: string, p: Person) {
    if (!p.windows.size && p.told === 'offline' && !p.timer) this.people.delete(userId)
  }

  private queue(userId: string, state: PresenceState) {
    this.outgoing.set(userId, state)
    if (!this.flushTimer) this.flushTimer = this.clock.setTimeout(() => this.flush(), this.flushMs)
  }

  private flush() {
    this.flushTimer = null
    if (this.stopped) return
    // online or away only for an active account; offline for anyone (an account turned off must not stay online)
    const people = [...this.outgoing].filter(([id, state]) => state === 'offline' || this.o.isPerson(id)).map(([id, state]) => ({ id, state }))
    this.outgoing.clear()
    if (!people.length) return
    const frame: PresenceFrame = { type: 'presence', full: false, people }
    for (const to of this.o.recipients()) this.o.send(to, frame)
  }
}

const stateOf = (p: Person): PresenceState => {
  if (!p.windows.size) return 'offline'
  if (p.away) return 'away'
  for (const w of p.windows.values()) if (w === 'active') return 'online'
  return 'away'
}

const started = new WeakMap<AppContext, Presence>()

/** The team's presence, on the hub's windows and client frames (chat/runtime.ts starts it with the hub). */
export function startPresence(hub: Hub, ctx: AppContext, o: Partial<PresenceOptions> = {}): Presence {
  const p = new Presence({
    send: (userId, frame, windowId) => hub.sendControl(userId, frame, windowId),
    recipients: () => hub.connectedUsers(),
    isPerson: (id) => !!ctx.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(id),
    awayOf: (id) => parsePrefs((ctx.db.query('SELECT prefs FROM users WHERE id = ?').get(id) as { prefs: string } | null)?.prefs).away === true,
    ...o,
  })
  hub.onWindow((userId, windowId, state) => (state === 'open' ? p.open(userId, windowId) : p.close(userId, windowId)))
  hub.onClientFrame((s, f) => { if (f.type === 'presence') p.activity(s.userId, s.windowId, f.state) })
  ctx.onClose(() => p.stop())
  started.set(ctx, p)
  return p
}

/** The running presence of this server (null before the chat runtime started it). */
export function presenceFor(ctx: AppContext): Presence | null {
  return started.get(ctx) ?? null
}
