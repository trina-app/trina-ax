// Online status (docs/DECISIONS.md "접속 상태"): who on the team has the app open and is at it, as a dot on their
// picture. In memory only, from the live WebSocket windows the hub already keeps (no table, no second channel):
//
// - Each open window is `active` or `idle`, as the page says (client frame `presence`); a window that has just connected
//   counts as active until it says otherwise (it sends its state right after `hello`).
// - A person is online when a window of theirs is active, away when windows are open but none is active or they set
//   themselves away (users.prefs.away, PUT /api/me/away), offline when none is open. Several devices: the most online.
// - The team is told a change only once it has held SETTLE_MS (a reconnect of an idle tab says "idle" within
//   milliseconds: nobody sees it flick to online), and offline only after GRACE_MS without any window (a reload or a
//   relay reconnect is not "offline"; an account turned off is offline at once). One person's changes are told at most
//   once per MIN_GAP_MS (the newest wins), so a page flipping its state cannot keep the whole team busy. Changes close
//   together go out as one frame.
// - For WARMUP_MS after the server starts, a window gets its whole list only at the end of it: everyone is reconnecting
//   then, and an early list would take every dot off the screen of someone who had them (a deploy would blink them all).
// - Told with the `presence` control frame (shared/src/api/ws.ts): the whole list to each window as it connects, then
//   changes to every open window of the team. Only ids and states: never a device, a window count or a time. Only
//   active accounts are listed (the AI is no account; disabled and deleted accounts are left out), and "offline" is told
//   about anyone, so nobody stays on screen as online after their account was turned off.
import type { PresenceFrame, PresenceState, WindowActivity } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { parsePrefs } from '../auth/users'
import { placePeople } from '../auth/guests'
import type { Hub } from './hub'

/** a change is told once it has held this long */
export const PRESENCE_SETTLE_MS = 1500
/** no window open for this long: offline (a reload, a relay reconnect within it change nothing) */
export const PRESENCE_GRACE_MS = 30_000
/** changes within this long of the first go out together */
export const PRESENCE_FLUSH_MS = 250
/** one person's changes are told at most this often */
export const PRESENCE_MIN_GAP_MS = 5000
/** after a start, windows get the whole list only this long after it (the reconnect backoff is at most ~10 s) */
export const PRESENCE_WARMUP_MS = 15_000
/** a window that sent nothing (not even its ping, every 20 s) for this long is not in use for the phone rule
 * (inUse): a computer that slept or lost its network, whose socket the server has not closed yet (the relay sends no
 * pings of its own; Bun closes an idle socket only after 120 s) */
export const PRESENCE_SILENT_MS = 60_000

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
  /** every active account, read once for a whole list or a batch of changes (not one query per person) */
  activeIds(): ReadonlySet<string>
  /** they set themselves away (kept in their account) */
  awayOf(userId: string): boolean
  clock?: PresenceClock
  settleMs?: number
  graceMs?: number
  flushMs?: number
  minGapMs?: number
  warmupMs?: number
}

interface Person {
  windows: Map<string, WindowActivity>
  /** when each open window last sent anything (clock ms): inUse leaves out a window silent for PRESENCE_SILENT_MS */
  seen: Map<string, number>
  /** a window closed while in use counts for inUse until then (clock ms): a reload, a Wi-Fi switch or a relay
   * reconnect is not "away from the computer" */
  closedInUse: Map<string, number>
  away: boolean
  /** what the team was last told, and when (clock ms; 0: never) */
  told: PresenceState
  toldAt: number
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
  private readonly minGapMs: number
  /** until when (clock ms) windows wait for their whole list, and the windows waiting */
  private readonly warmUntil: number
  private warming: { userId: string; windowId: string }[] = []
  private warmTimer: unknown = null

  constructor(private o: PresenceOptions) {
    this.clock = o.clock ?? realClock
    this.settleMs = o.settleMs ?? PRESENCE_SETTLE_MS
    this.graceMs = o.graceMs ?? PRESENCE_GRACE_MS
    this.flushMs = o.flushMs ?? PRESENCE_FLUSH_MS
    this.minGapMs = o.minGapMs ?? PRESENCE_MIN_GAP_MS
    this.warmUntil = this.clock.now() + (o.warmupMs ?? PRESENCE_WARMUP_MS)
  }

  /** A window connected (after its hello and replay): it counts as active, and gets the whole list (right after a
   * start: once the warm-up is over). */
  open(userId: string, windowId: string): void {
    if (this.stopped) return
    if (this.o.isPerson(userId)) {
      const p = this.person(userId)
      p.windows.set(windowId, 'active')
      p.seen.set(windowId, this.clock.now())
      // a window back (a reload comes back with a new id): it says its own state now, the grace has done its part
      p.closedInUse.clear()
      this.schedule(userId, p)
    }
    const wait = this.warmUntil - this.clock.now()
    if (wait <= 0) return this.o.send(userId, { type: 'presence', full: true, people: this.list() }, windowId)
    this.warming.push({ userId, windowId })
    if (!this.warmTimer) this.warmTimer = this.clock.setTimeout(() => this.warmedUp(), wait)
  }

  close(userId: string, windowId: string): void {
    const p = this.people.get(userId)
    if (!p) return
    const was = p.windows.get(windowId)
    if (!p.windows.delete(windowId)) return
    const now = this.clock.now()
    // closed while in use (it did not say idle or locked first): still in use for the grace (inUse)
    if (was === 'active' && now - (p.seen.get(windowId) ?? 0) <= PRESENCE_SILENT_MS) p.closedInUse.set(windowId, now + this.graceMs)
    p.seen.delete(windowId)
    this.schedule(userId, p)
  }

  /** The window sent a frame (any: its ping too): it is still there (inUse's silence cut-off). */
  seenNow(userId: string, windowId: string): void {
    const p = this.people.get(userId)
    if (p && p.windows.has(windowId)) p.seen.set(windowId, this.clock.now())
  }

  /** Is the person at Trina now, for their phone's pushes (notifications/away.ts)? A window of theirs in use (active,
   * and heard from within PRESENCE_SILENT_MS), or one closed while in use within the grace. Not when they set
   * themselves away. Only this server's memory; nothing of it is shown to anyone. Right after a start windows are still
   * reconnecting: ask warmingUntil first. */
  inUse(userId: string): boolean {
    if (this.stopped) return false
    const now = this.clock.now()
    const p = this.people.get(userId)
    if (!p || p.away) return false
    for (const [w, state] of p.windows) if (state === 'active' && now - (p.seen.get(w) ?? 0) <= PRESENCE_SILENT_MS) return true
    for (const [w, until] of p.closedInUse) {
      if (until > now) return true
      p.closedInUse.delete(w)
    }
    return false
  }

  /** Until when (clock ms) windows are still reconnecting after a start (the warm-up); null once it is over. inUse
   * cannot tell before that: someone at their computer has no window back yet. */
  warmingUntil(): number | null {
    return this.clock.now() < this.warmUntil ? this.warmUntil : null
  }

  /** A window says it is in use or idle. Ignored for a window this does not know (closed meanwhile). */
  activity(userId: string, windowId: string, state: WindowActivity): void {
    const p = this.people.get(userId)
    if (!p || !p.windows.has(windowId)) return
    p.seen.set(windowId, this.clock.now())
    if (p.windows.get(windowId) === state) return
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
    let active: ReadonlySet<string> | null = null
    for (const [id, p] of this.people) {
      if (p.told === 'offline') continue
      active ??= this.o.activeIds()
      if (active.has(id)) out.push({ id, state: p.told })
    }
    return out
  }

  /** The person's account may have been turned off with no window left to close (hub: every session ended): told at
   * once instead of after the grace. Nothing changes for an active account. */
  recheck(userId: string): void {
    const p = this.people.get(userId)
    if (!p || this.stopped || this.o.isPerson(userId)) return
    this.schedule(userId, p)
  }

  stop(): void {
    this.stopped = true
    for (const p of this.people.values()) if (p.timer) this.clock.clearTimeout(p.timer)
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer)
    if (this.warmTimer) this.clock.clearTimeout(this.warmTimer)
    this.people.clear()
    this.outgoing.clear()
    this.warming = []
    this.flushTimer = this.warmTimer = null
  }

  /** The warm-up is over: the windows that connected during it get the whole list (one that has gone gets nothing). */
  private warmedUp() {
    this.warmTimer = null
    if (this.stopped) return
    const list = this.list()
    for (const w of this.warming.splice(0)) this.o.send(w.userId, { type: 'presence', full: true, people: list }, w.windowId)
  }

  private person(userId: string): Person {
    let p = this.people.get(userId)
    if (!p) {
      let away = false
      try { away = this.o.awayOf(userId) } catch { /* automatic */ }
      p = { windows: new Map(), seen: new Map(), closedInUse: new Map(), away, told: 'offline', toldAt: 0, timer: null }
      this.people.set(userId, p)
    }
    return p
  }

  /** Tell the team once the person's state has held (offline: after the grace; an account turned off at once), at most
   * once per min gap; a change back in time tells nobody. */
  private schedule(userId: string, p: Person) {
    if (p.timer) this.clock.clearTimeout(p.timer)
    p.timer = null
    const now = stateOf(p)
    if (now === p.told) return this.forget(userId, p)
    // disabled or deleted (the account is changed before its sockets close): nobody waits for it to come back
    const gone = now === 'offline' && !this.o.isPerson(userId)
    const hold = gone ? 0 : now === 'offline' ? this.graceMs : this.settleMs
    const gap = gone || !p.toldAt ? 0 : p.toldAt + this.minGapMs - this.clock.now()
    p.timer = this.clock.setTimeout(() => {
      p.timer = null
      if (this.stopped || this.people.get(userId) !== p) return
      const state = stateOf(p)
      if (state !== p.told) {
        p.told = state
        p.toldAt = this.clock.now()
        this.queue(userId, state)
      }
      this.forget(userId, p)
    }, Math.max(hold, gap))
  }

  /** Nothing left to remember: offline, told so, no window (their away setting is read again when they come back). */
  private forget(userId: string, p: Person) {
    const now = this.clock.now()
    for (const [w, until] of p.closedInUse) if (until <= now) p.closedInUse.delete(w)
    if (!p.windows.size && p.told === 'offline' && !p.timer && !p.closedInUse.size) this.people.delete(userId)
  }

  private queue(userId: string, state: PresenceState) {
    this.outgoing.set(userId, state)
    if (!this.flushTimer) this.flushTimer = this.clock.setTimeout(() => this.flush(), this.flushMs)
  }

  private flush() {
    this.flushTimer = null
    if (this.stopped) return
    // online or away only for an active account; offline for anyone (an account turned off must not stay online)
    const active = [...this.outgoing.values()].some((state) => state !== 'offline') ? this.o.activeIds() : null
    const people = [...this.outgoing].filter(([id, state]) => state === 'offline' || active!.has(id)).map(([id, state]) => ({ id, state }))
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

/**
 * Presence frames cut to what each window's person may know (docs/DECISIONS.md "Guests: only what they were invited
 * to"): a guest is told only about the people of their one place, and a member is not told about a guest who shares no
 * place with them. Who is a guest and each guest's place people are worked out once per frame (the same frame object
 * goes to every window of a change), never once per window; with no guest on the team the frame goes as it is.
 */
export function guestPresenceSend(ctx: AppContext, send: PresenceOptions['send']): PresenceOptions['send'] {
  const seen = new WeakMap<PresenceFrame, { guests: Set<string>; places: Map<string, Set<string>> }>()
  const viewOf = (frame: PresenceFrame) => {
    let v = seen.get(frame)
    if (!v) {
      const guests = new Set((ctx.db.query('SELECT id FROM users WHERE guest = 1').all() as { id: string }[]).map((r) => r.id))
      const places = new Map<string, Set<string>>()
      for (const g of guests) places.set(g, placePeople(ctx.db, g))
      v = { guests, places }
      seen.set(frame, v)
    }
    return v
  }
  return (to, frame, windowId) => {
    const v = viewOf(frame)
    if (!v.guests.size) return send(to, frame, windowId)
    const mine = v.places.get(to)
    const keep = mine
      ? (id: string) => id === to || mine.has(id)
      : (id: string) => !v.guests.has(id) || !!v.places.get(id)?.has(to)
    const people = frame.people.filter((x) => keep(x.id))
    if (!frame.full && !people.length) return
    send(to, people.length === frame.people.length ? frame : { ...frame, people }, windowId)
  }
}

/** The team's presence, on the hub's windows and client frames (chat/runtime.ts starts it with the hub). */
export function startPresence(hub: Hub, ctx: AppContext, o: Partial<PresenceOptions> = {}): Presence {
  const send = guestPresenceSend(ctx, o.send ?? ((userId, frame, windowId) => hub.sendControl(userId, frame, windowId)))
  const p = new Presence({
    recipients: () => hub.connectedUsers(),
    isPerson: (id) => !!ctx.db.query("SELECT 1 FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(id),
    activeIds: () => new Set((ctx.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]).map((r) => r.id)),
    awayOf: (id) => parsePrefs((ctx.db.query('SELECT prefs FROM users WHERE id = ?').get(id) as { prefs: string } | null)?.prefs).away === true,
    ...o,
    send,
  })
  hub.onWindow((userId, windowId, state) => (state === 'open' ? p.open(userId, windowId) : p.close(userId, windowId)))
  hub.onClientFrame((s, f) => { if (f.type === 'presence') p.activity(s.userId, s.windowId, f.state) })
  // any frame, the ping included: the window is still there (inUse)
  hub.onFrameSeen((userId, windowId) => p.seenNow(userId, windowId))
  // disabled or deleted while the last window's grace runs: no window is left to close, so look again now
  hub.onUserEnded((userId) => p.recheck(userId))
  ctx.onClose(() => p.stop())
  started.set(ctx, p)
  return p
}

/** The running presence of this server (null before the chat runtime started it). */
export function presenceFor(ctx: AppContext): Presence | null {
  return started.get(ctx) ?? null
}
