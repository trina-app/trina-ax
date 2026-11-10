// The room sound (lib/roomSound.ts, store/roomSound.ts; docs/DECISIONS.md "대화방 알림 소리"): which new messages ring,
// that one tab of a device plays it and at most once every 3 s, which room a focused tab shows, the switch, and the
// chime itself.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { uuidv7, uuidv7Time, type Me, type ServerEvent } from '@mycel/shared/api'
import { Chime, COALESCE_MS, LAST_KEY, playChime, REPOST_MS, RoomSound, roomSoundOn, setRoomSoundOn, shouldRing, SOUND_KEY, VIEW_KEY, VIEW_TTL_MS, type AudioLike, type LocksLike, type RingInput, type SoundDeps } from '../../src/lib/roomSound'
import { dispatch } from '../../src/store/live'
import { useRooms } from '../../src/store/rooms'
import { changeRoomSound, startRoomSound, stopRoomSound } from '../../src/store/roomSound'
import { useSession } from '../../src/store/session'
import { useUi } from '../../src/store/ui'
import { installDom, removeDom } from './dom-host'
import { BEN, ME, message, room } from './rooms-fixtures'

const ROOM = uuidv7()
const AI = { authorKind: 'ai' as const, author: null }
const base = (o: Omit<Partial<RingInput>, 'message'> & { message?: Partial<RingInput['message']> } = {}): RingInput => ({
  roomId: ROOM,
  room: { kind: 'dm', muted: false },
  meId: ME.id,
  replay: false,
  seen: false,
  viewing: null,
  ...o,
  message: { ...message({ roomId: ROOM, seq: 1 }), ...o.message },
})

describe('shouldRing', () => {
  test('a DM, a group chat and any kind added later: every message from someone else', () => {
    for (const kind of ['dm', 'group', 'some-new-kind']) expect({ kind, ring: shouldRing(base({ room: { kind, muted: false } })) }).toEqual({ kind, ring: true })
  })

  test('a team room and the everyone room: only a message that mentions me', () => {
    for (const kind of ['team', 'all']) {
      expect(shouldRing(base({ room: { kind, muted: false } }))).toBe(false)
      expect(shouldRing(base({ room: { kind, muted: false }, message: { mentions: [BEN.id] } }))).toBe(false)
      expect(shouldRing(base({ room: { kind, muted: false }, message: { mentions: [BEN.id, ME.id] } }))).toBe(true)
    }
  })

  test('never: my own message, a muted room, a deleted message, an event line, a replay, a message seen before', () => {
    expect(shouldRing(base({ message: { author: ME } }))).toBe(false)
    expect(shouldRing(base({ room: { kind: 'dm', muted: true } }))).toBe(false)
    expect(shouldRing(base({ room: { kind: 'team', muted: true }, message: { mentions: [ME.id] } }))).toBe(false)
    expect(shouldRing(base({ message: { deletedAt: new Date().toISOString() } }))).toBe(false)
    // the room event lines of a later branch (someone joined, the room renamed): any `event` at all
    expect(shouldRing(base({ message: { event: { kind: 'joined' } } }))).toBe(false)
    expect(shouldRing(base({ message: { event: 'renamed' } }))).toBe(false)
    expect(shouldRing(base({ message: { event: null } }))).toBe(true)
    expect(shouldRing(base({ replay: true }))).toBe(false)
    expect(shouldRing(base({ seen: true }))).toBe(false)
  })

  test('not for the room this device shows in a visible, focused window; any other room still rings', () => {
    expect(shouldRing(base({ viewing: ROOM }))).toBe(false)
    expect(shouldRing(base({ viewing: uuidv7() }))).toBe(true)
  })

  test('nothing before the room or the person is known (rooms not loaded yet, signed out)', () => {
    expect(shouldRing(base({ room: null }))).toBe(false)
    expect(shouldRing(base({ meId: null }))).toBe(false)
  })

  test("an AI answer to my question: my private preview and the answer that went to the room, in any room", () => {
    for (const kind of ['team', 'all', 'dm']) {
      expect(shouldRing(base({ room: { kind, muted: false }, message: { ...AI, askedBy: ME, visibility: 'private' } }))).toBe(true)
      expect(shouldRing(base({ room: { kind, muted: false }, message: { ...AI, askedBy: ME, visibility: 'room' } }))).toBe(true)
      // not while I look at that room, not in a muted room
      expect(shouldRing(base({ room: { kind, muted: false }, viewing: ROOM, message: { ...AI, askedBy: ME, visibility: 'private' } }))).toBe(false)
      expect(shouldRing(base({ room: { kind, muted: true }, message: { ...AI, askedBy: ME, visibility: 'room' } }))).toBe(false)
    }
  })

  test('my preview posted to the room (the same id, a later time) does not ring for me; for the others it is a new message', () => {
    // ids count up from the latest one made (uuidv7 is monotonic): read the time back from the id
    const id = uuidv7()
    const answered = uuidv7Time(id)
    const posted = new Date(answered + REPOST_MS + 1000).toISOString()
    expect(shouldRing(base({ room: { kind: 'team', muted: false }, message: { ...AI, id, askedBy: ME, visibility: 'room', createdAt: posted } }))).toBe(false)
    // the direct answer: its id and its time are the same moment
    expect(shouldRing(base({ room: { kind: 'team', muted: false }, message: { ...AI, id, askedBy: ME, visibility: 'room', createdAt: new Date(answered + 30).toISOString() } }))).toBe(true)
    // someone else's answer posted in our DM: a DM message for me
    expect(shouldRing(base({ room: { kind: 'dm', muted: false }, message: { ...AI, id, askedBy: BEN, visibility: 'room', createdAt: posted } }))).toBe(true)
    // someone else's answer in a team room: no mention of me
    expect(shouldRing(base({ room: { kind: 'team', muted: false }, message: { ...AI, askedBy: BEN, visibility: 'room' } }))).toBe(false)
    // someone else's private preview never reaches me; if it did, it would not ring
    expect(shouldRing(base({ message: { ...AI, askedBy: BEN, visibility: 'private' } }))).toBe(false)
  })
  test('a reply in a thread rings when the thread is mine to follow or it mentions me, in any room; else only when sent to the room too', () => {
    const root = uuidv7()
    for (const kind of ['dm', 'group', 'team', 'all']) {
      const room = { kind, muted: false }
      // I follow it (I wrote the root, replied, or was mentioned there): like a DM message
      expect({ kind, ring: shouldRing(base({ room, message: { threadRootId: root, following: true } })) }).toEqual({ kind, ring: true })
      // it mentions me: a mention, wherever it is
      expect({ kind, ring: shouldRing(base({ room, message: { threadRootId: root, mentions: [ME.id] } })) }).toEqual({ kind, ring: true })
      // not mine to follow: quiet, even in a DM or a group chat
      expect({ kind, ring: shouldRing(base({ room, message: { threadRootId: root } })) }).toEqual({ kind, ring: false })
      // sent to the room too: the room's own rule (every message in a DM or group chat, mentions in the others)
      expect({ kind, ring: shouldRing(base({ room, message: { threadRootId: root, alsoInRoom: true } })) }).toEqual({ kind, ring: kind === 'dm' || kind === 'group' })
      // a muted room, my own reply, the room on screen: never
      expect(shouldRing(base({ room: { kind, muted: true }, message: { threadRootId: root, following: true } }))).toBe(false)
      expect(shouldRing(base({ room, message: { threadRootId: root, following: true, author: ME } }))).toBe(false)
      expect(shouldRing(base({ room, viewing: ROOM, message: { threadRootId: root, following: true } }))).toBe(false)
      // the AI's answer to my question in a thread: mine, as anywhere
      expect(shouldRing(base({ room, message: { ...AI, threadRootId: root, askedBy: ME, visibility: 'room' } }))).toBe(true)
    }
  })
})

// ---------------- one device: tabs, the slot, the view ----------------

function memoryStorage() {
  const m = new Map<string, string>()
  return { map: m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) }
}

/** navigator.locks for one device: `ifAvailable` gets null while another tab holds the lock */
function memoryLocks(): LocksLike & { hold: (p: Promise<void>) => void } {
  let held: Promise<void> | null = null
  return {
    async request(_name, _o, cb) {
      if (held) return cb(null)
      let release!: () => void
      held = new Promise((r) => (release = r))
      try { return await cb({}) } finally { held = null; release() }
    },
    hold(p) { held = p; void p.then(() => { held = null }) },
  }
}

class FakeAudio implements AudioLike {
  played = 0
  constructor(public isReady = true) {}
  ready() { return this.isReady }
  play() { this.played++ }
}

interface Device { clock: { t: number }; storage: ReturnType<typeof memoryStorage>; locks: ReturnType<typeof memoryLocks> | null }
const device = (locks = true): Device => ({ clock: { t: 1_000_000 }, storage: memoryStorage(), locks: locks ? memoryLocks() : null })
function tab(dev: Device, o: Partial<SoundDeps> & { audio?: FakeAudio; focus?: { on: boolean; room: string | null } } = {}) {
  const audio = o.audio ?? new FakeAudio()
  const focus = o.focus ?? { on: false, room: null }
  const s = new RoomSound({
    tabId: uuidv7(), now: () => dev.clock.t, storage: dev.storage, locks: dev.locks,
    focused: () => focus.on, quiet: () => false, openRoom: () => focus.room, audio, hold: async () => {}, ...o,
  })
  return { s, audio, focus }
}
const dm = { kind: 'dm', muted: false }
const msg = (o: Partial<ReturnType<typeof message>> = {}) => message({ roomId: ROOM, seq: 1, ...o })

describe('one sound per device', () => {
  test('three tabs get the same message: one of them plays it', async () => {
    for (const locks of [true, false]) {
      const dev = device(locks)
      const tabs = [tab(dev), tab(dev), tab(dev)]
      const m = msg()
      const rang = await Promise.all(tabs.map((t) => t.s.message(ROOM, m, dm, ME.id, false)))
      expect({ locks, rang: rang.filter(Boolean).length, played: tabs.reduce((n, t) => n + t.audio.played, 0) }).toEqual({ locks, rang: 1, played: 1 })
    }
  })

  test('a tab whose audio cannot play (no gesture yet) leaves the sound to one that can', async () => {
    const dev = device()
    const locked = tab(dev, { audio: new FakeAudio(false) }), open = tab(dev)
    const m = msg()
    expect(await locked.s.message(ROOM, m, dm, ME.id, false)).toBe(false)
    expect(await open.s.message(ROOM, m, dm, ME.id, false)).toBe(true)
    expect([locked.audio.played, open.audio.played]).toEqual([0, 1])
  })

  test("the tab that rings keeps the lock for 3 s: a tab whose localStorage has not got the time yet stays quiet too", async () => {
    const dev = device()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const holds: number[] = []
    // each tab its own storage: what one wrote has not reached the other (browsers pass it on later)
    const a = tab(dev, { storage: memoryStorage(), hold: (ms) => { holds.push(ms); return held } })
    const b = tab(dev, { storage: memoryStorage() })
    const m = msg()
    expect(await a.s.message(ROOM, m, dm, ME.id, false)).toBe(true)
    expect(holds).toEqual([COALESCE_MS])
    expect(await b.s.message(ROOM, m, dm, ME.id, false)).toBe(false)
    expect(await b.s.message(ROOM, msg({ seq: 2 }), dm, ME.id, false)).toBe(false)
    release()
    await held
    await Promise.resolve()
    dev.clock.t += COALESCE_MS
    expect(await b.s.message(ROOM, msg({ seq: 3 }), dm, ME.id, false)).toBe(true)
    expect(a.audio.played + b.audio.played).toBe(2)
  })

  test('while another tab holds the lock, this one stays quiet', async () => {
    const dev = device()
    let release!: () => void
    dev.locks!.hold(new Promise((r) => (release = r)))
    const t = tab(dev)
    expect(await t.s.message(ROOM, msg(), dm, ME.id, false)).toBe(false)
    release()
  })

  test('at most one sound every 3 s, all rooms and tabs together; the clock going back does not block it', async () => {
    const dev = device()
    const a = tab(dev), b = tab(dev)
    const other = uuidv7()
    expect(await a.s.message(ROOM, msg(), dm, ME.id, false)).toBe(true)
    dev.clock.t += 1000
    expect(await b.s.message(other, message({ roomId: other, seq: 1 }), dm, ME.id, false)).toBe(false)
    dev.clock.t += COALESCE_MS - 1001
    expect(await a.s.message(ROOM, msg({ seq: 2 }), dm, ME.id, false)).toBe(false)
    dev.clock.t += 1
    expect(await b.s.message(ROOM, msg({ seq: 3 }), dm, ME.id, false)).toBe(true)
    expect(Number(dev.storage.getItem(LAST_KEY))).toBe(dev.clock.t)
    dev.clock.t -= 60 * 60_000
    expect(await a.s.message(ROOM, msg({ seq: 4 }), dm, ME.id, false)).toBe(true)
    expect(a.audio.played + b.audio.played).toBe(3)
  })

  test('storage blocked: each tab still keeps its own 3 s', async () => {
    const dev = device(false)
    const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
    const t = tab(dev, { storage: blocked })
    expect(await t.s.message(ROOM, msg(), dm, ME.id, false)).toBe(true)
    dev.clock.t += 1000
    expect(await t.s.message(ROOM, msg({ seq: 2 }), dm, ME.id, false)).toBe(false)
  })

  test('the same message twice (the posted copy of a preview, a second event) rings once; a replay rings never but counts as seen', async () => {
    const dev = device()
    const t = tab(dev)
    const preview = msg({ ...AI, askedBy: ME, visibility: 'private' })
    expect(await t.s.message(ROOM, preview, { kind: 'team', muted: false }, ME.id, false)).toBe(true)
    dev.clock.t += 10_000
    expect(await t.s.message(ROOM, { ...preview, visibility: 'room' as const }, { kind: 'team', muted: false }, ME.id, false)).toBe(false)
    const missed = msg({ seq: 3 })
    expect(await t.s.message(ROOM, missed, dm, ME.id, true)).toBe(false)
    expect(await t.s.message(ROOM, missed, dm, ME.id, false)).toBe(false)
    expect(t.audio.played).toBe(1)
  })

  test('a phone in the background or just back: quiet, and the worker keeps the notice\'s own sound', async () => {
    const dev = device()
    const t = tab(dev, { quiet: () => true })
    expect(await t.s.message(ROOM, msg(), dm, ME.id, false)).toBe(false)
    expect(t.s.handles(true)).toBe(false)
  })

  test('it waits a moment first: read meanwhile on another device or window, it stays quiet and leaves the slot free', async () => {
    const dev = device()
    const read = new Set<string>()
    const waits: number[] = []
    const t = tab(dev, { settle: { ms: 1500, read: (_r, m) => read.has(m.id), wait: async (ms) => { waits.push(ms); read.add(first.id) } } })
    const first = msg({ seq: 1 })
    expect(await t.s.message(ROOM, first, dm, ME.id, false)).toBe(false)
    expect(waits).toEqual([1500])
    // still unread after the wait: it rings, at once (the slot was not taken by the one read elsewhere)
    expect(await t.s.message(ROOM, msg({ seq: 2 }), dm, ME.id, false)).toBe(true)
    expect(t.audio.played).toBe(1)
  })

  test('meanwhile this window opened the room, the switch went off, the audio stopped being able to play or the person signed out: quiet', async () => {
    const dev = device()
    const focus = { on: false, room: null as string | null }
    const opens = tab(dev, { focus, settle: { ms: 1, read: () => false, wait: async () => { focus.on = true; focus.room = ROOM } } })
    expect(await opens.s.message(ROOM, msg(), dm, ME.id, false)).toBe(false)
    const audio = new FakeAudio()
    const lost = tab(dev, { audio, settle: { ms: 1, read: () => false, wait: async () => { audio.isReady = false } } })
    expect(await lost.s.message(ROOM, msg({ seq: 2 }), dm, ME.id, false)).toBe(false)
    const out = tab(dev, { settle: { ms: 1, read: () => false, wait: async () => out.s.stop() } })
    expect(await out.s.message(ROOM, msg({ seq: 3 }), dm, ME.id, false)).toBe(false)
    const off = tab(dev, { settle: { ms: 1, read: () => false, wait: async () => { setRoomSoundOn(false, dev.storage) } } })
    expect(await off.s.message(ROOM, msg({ seq: 4 }), dm, ME.id, false)).toBe(false)
    expect(opens.audio.played + audio.played + out.audio.played + off.audio.played).toBe(0)
    // (the slot stayed free: with the switch on again, a tab whose sound can play still rings)
    setRoomSoundOn(true, dev.storage)
    expect(await tab(dev).s.message(ROOM, msg({ seq: 5 }), dm, ME.id, false)).toBe(true)
  })
})

describe('the room a focused tab shows', () => {
  test('a tab in the background stays quiet about the room the focused tab shows, and rings for the others', async () => {
    const dev = device()
    const front = tab(dev, { focus: { on: true, room: ROOM } }), back = tab(dev)
    front.s.publishView()
    expect(JSON.parse(dev.storage.getItem(VIEW_KEY)!)).toMatchObject({ room: ROOM })
    expect(back.s.viewing()).toBe(ROOM)
    expect(await back.s.message(ROOM, msg(), dm, ME.id, false)).toBe(false)
    expect(await front.s.message(ROOM, msg({ seq: 2 }), dm, ME.id, false)).toBe(false)
    const other = uuidv7()
    expect(await back.s.message(other, message({ roomId: other, seq: 1 }), dm, ME.id, false)).toBe(true)
  })

  test('the focused tab leaves the room or loses focus: its word goes, and the room rings again', async () => {
    const dev = device()
    const front = tab(dev, { focus: { on: true, room: ROOM } }), back = tab(dev)
    front.s.publishView()
    front.focus.room = null
    front.s.publishView()
    expect(back.s.viewing()).toBeNull()
    front.focus.room = ROOM
    front.s.publishView()
    front.focus.on = false
    front.s.publishView()
    expect(dev.storage.getItem(VIEW_KEY)).toBeNull()
    expect(await back.s.message(ROOM, msg(), dm, ME.id, false)).toBe(true)
  })

  test("a tab never takes back another tab's word; a word too old (a closed tab) counts for nothing", () => {
    const dev = device()
    const front = tab(dev, { focus: { on: true, room: ROOM } }), back = tab(dev)
    front.s.publishView()
    back.s.publishView()
    back.s.forgetView()
    expect(back.s.viewing()).toBe(ROOM)
    dev.clock.t += VIEW_TTL_MS + 1
    expect(back.s.viewing()).toBeNull()
  })
})

describe('the switch', () => {
  test('on unless this device turned it off; off: nothing rings, and the page tells the worker it takes care of it', async () => {
    const dev = device()
    const t = tab(dev)
    expect(roomSoundOn(dev.storage)).toBe(true)
    expect(t.s.handles(true)).toBe(true)
    expect(t.s.handles(false)).toBe(false)
    setRoomSoundOn(false, dev.storage)
    expect(dev.storage.getItem(SOUND_KEY)).toBe('off')
    expect(roomSoundOn(dev.storage)).toBe(false)
    expect(await t.s.message(ROOM, msg(), dm, ME.id, false)).toBe(false)
    expect(t.s.handles(false)).toBe(true)
    setRoomSoundOn(true, dev.storage)
    expect(dev.storage.map.has(SOUND_KEY)).toBe(false)
    // a tab that cannot play does not take care of it
    expect(tab(dev, { audio: new FakeAudio(false) }).s.handles(true)).toBe(false)
  })
})

// ---------------- the chime ----------------

class FakeParam {
  value = 0
  events: [string, number, number][] = []
  setValueAtTime(v: number, t: number) { this.events.push(['set', v, t]) }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push(['ramp', v, t]) }
}
class FakeCtx {
  state: AudioContextState = 'suspended'
  currentTime = 5
  destination = { name: 'out' }
  oscillators: { type: string; frequency: FakeParam; start: number; stop: number }[] = []
  gains: FakeParam[] = []
  buffers = 0
  resumes = 0
  suspends = 0
  async resume() { this.resumes++; this.state = 'running' }
  async suspend() { this.suspends++; this.state = 'suspended' }
  createGain() { const gain = new FakeParam(); this.gains.push(gain); return { gain, connect() {} } }
  createOscillator() {
    const o = { type: '', frequency: new FakeParam(), start: 0, stop: 0 }
    this.oscillators.push(o)
    return { get type() { return o.type }, set type(v: string) { o.type = v }, frequency: o.frequency, connect() {}, start(t: number) { o.start = t }, stop(t: number) { o.stop = t } }
  }
  createBuffer() { return {} }
  createBufferSource() { this.buffers++; return { buffer: null, connect() {}, start() {} } }
}

describe('the chime', () => {
  test('two soft notes, under a second, at a modest volume', () => {
    const ctx = new FakeCtx()
    ctx.state = 'running'
    playChime(ctx as never)
    expect(ctx.oscillators.map((o) => Math.round(o.frequency.value))).toEqual([784, 1568, 1047, 2093])
    expect(ctx.oscillators.every((o) => o.type === 'sine')).toBe(true)
    expect(Math.max(...ctx.oscillators.map((o) => o.stop)) - ctx.currentTime).toBeLessThan(1)
    expect(ctx.gains[0]!.value).toBe(0.36)
  })

  test('the mixed peak of both notes and their octaves stays under the clip limit', () => {
    const ctx = new FakeCtx()
    ctx.state = 'running'
    playChime(ctx as never)
    const master = ctx.gains[0]!.value
    // gains[1..] are the per-partial envelopes, in the same order as the oscillators; the ramps are exponential
    const env = (g: FakeParam, t: number) => {
      let prev = g.events[0]!
      if (t < prev[2]) return 0
      for (const e of g.events.slice(1)) {
        if (t <= e[2]) return prev[1] * Math.pow(e[1] / prev[1], (t - prev[2]) / (e[2] - prev[2]))
        prev = e
      }
      return 0
    }
    const rate = 48000
    let peak = 0
    for (let i = 0; i < rate; i++) {
      const t = ctx.currentTime + i / rate
      let sum = 0
      ctx.oscillators.forEach((o, k) => {
        if (t >= o.start && t <= o.stop) sum += Math.sin(2 * Math.PI * o.frequency.value * (t - o.start)) * env(ctx.gains[k + 1]!, t)
      })
      peak = Math.max(peak, Math.abs(sum * master))
    }
    expect(peak).toBeGreaterThan(0.1) // clearly audible
    expect(peak).toBeLessThan(0.9)
    // and with every partial at its top at once (the worst case) the sum is still under it
    expect(master * 2 * (1 + 0.2)).toBeLessThan(0.9)
  })

  test('made and unlocked at the first gesture, once; plays only once unlocked, starting the context again if it rests', async () => {
    let made = 0
    const ctx = new FakeCtx()
    const c = new Chime(() => { made++; return ctx as never })
    expect(c.ready()).toBe(false)
    c.play()
    expect(ctx.oscillators).toHaveLength(0)
    expect(await c.prime()).toBe(true)
    expect([made, ctx.resumes, ctx.buffers, c.ready()]).toEqual([1, 1, 1, true])
    expect(await c.prime()).toBe(true)
    expect([made, ctx.resumes]).toEqual([1, 1])
    c.play()
    expect(ctx.oscillators).toHaveLength(4)
    // resting between sounds (suspended): the next sound starts it again without a gesture
    ctx.state = 'suspended'
    c.play()
    await Promise.resolve()
    await Promise.resolve()
    expect([ctx.resumes, ctx.oscillators.length]).toEqual([2, 8])
  })

  test('sounds asked for while it starts again make one chime, and none when it starts late', async () => {
    const ctx = new FakeCtx()
    const c = new Chime(() => ctx as never)
    await c.prime()
    ctx.state = 'suspended'
    let started!: () => void
    ctx.resume = () => new Promise<void>((r) => (started = () => { ctx.state = 'running'; r() }))
    c.play()
    c.play()
    c.play()
    started()
    await Promise.resolve()
    await Promise.resolve()
    expect(ctx.oscillators).toHaveLength(4)
    // a phone gives the audio back only after a while: that chime is dropped; one back within the second still sounds.
    // The clock is the test's own (Chime measures with Date.now): a wall clock that a container steps back made a 1.1 s
    // wait read as under a second now and then
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      for (const [after, chimes] of [[1100, 4], [900, 8]] as const) {
        ctx.state = 'suspended'
        let back!: () => void
        ctx.resume = () => new Promise<void>((r) => (back = () => { ctx.state = 'running'; r() }))
        c.play()
        now += after
        back()
        await Promise.resolve()
        await Promise.resolve()
        expect(ctx.oscillators).toHaveLength(chimes)
      }
    } finally {
      Date.now = realNow
    }
  })

  test('it rests after a sound, so the audio output is not held open', async () => {
    const ctx = new FakeCtx()
    const c = new Chime(() => ctx as never)
    await c.prime()
    c.play()
    expect(ctx.state).toBe('running')
    await new Promise((r) => setTimeout(r, 1600))
    expect(ctx.suspends).toBe(1)
    expect(ctx.state).toBe('suspended')
    expect(c.ready()).toBe(true)
  })

  test('no Web Audio here, or a context that cannot start: quiet, no error', async () => {
    const none = new Chime(() => null)
    expect(await none.prime()).toBe(false)
    none.preview()
    expect(none.ready()).toBe(false)
    const ctx = new FakeCtx()
    ctx.resume = async () => { throw new Error('not allowed') }
    const blocked = new Chime(() => ctx as never)
    expect(await blocked.prime()).toBe(false)
    blocked.preview()
    blocked.play()
    await Promise.resolve()
    expect(blocked.ready()).toBe(false)
    expect(ctx.oscillators).toHaveLength(0)
  })
})

// ---------------- in the app: dispatch → the sound ----------------

describe('in the app', () => {
  const rooms0 = useRooms.getState(), session0 = useSession.getState(), conn0 = useUi.getState().conn
  let audio: FakeAudio
  beforeEach(() => {
    installDom()
    ;(document as unknown as { visibilityState: string }).visibilityState = 'visible'
    ;(document as unknown as { hasFocus: () => boolean }).hasFocus = () => false
    audio = new FakeAudio()
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id } } as Me } })
    useRooms.setState({ rooms: [room({ id: ROOM, kind: 'dm', name: null, groupId: null })], loaded: true })
    // (the wait for a read elsewhere: one turn here; its own tests below)
    startRoomSound({ audio, settleMs: 0 })
  })
  afterEach(() => {
    stopRoomSound()
    removeDom()
    useRooms.setState(rooms0, true)
    useSession.setState(session0, true)
    useUi.setState({ conn: conn0 })
  })
  const ev = (seq: number, m = msg({ seq })): ServerEvent => ({ type: 'room.message', seq, at: Date.now(), data: { roomId: ROOM, message: m } })
  const settle = () => new Promise((r) => setTimeout(r, 0))
  const threadNews = (threadsUnread: number, seq = 9): ServerEvent => ({ type: 'room.updated', seq, at: Date.now(), data: { roomId: ROOM, change: 'updated', room: { ...useRooms.getState().rooms[0]!, threadsUnread, mentioned: false } } })

  test('a replay and an edit do not ring; a new DM message does', async () => {
    dispatch(ev(1), { replay: true })
    dispatch({ type: 'room.message.updated', seq: 2, at: Date.now(), data: { roomId: ROOM, message: msg({ seq: 1, body: 'edited' }) } })
    await settle()
    expect(audio.played).toBe(0)
    dispatch(ev(3, msg({ seq: 2 })))
    await settle()
    expect(audio.played).toBe(1)
    // the store took it as usual
    expect(useRooms.getState().rooms[0]!.lastSeq).toBe(2)
  })

  test('a reaction never rings; a reply in a thread I follow does, one I do not follow does not', async () => {
    const root = msg({ seq: 1 })
    dispatch({ type: 'room.reactions', seq: 1, at: Date.now(), data: { roomId: ROOM, messageId: root.id, reactions: [{ emoji: '👍', count: 1, mine: false, users: [BEN] }] } })
    await settle()
    expect(audio.played).toBe(0)
    dispatch(ev(2, msg({ seq: 2, threadRootId: root.id })))
    await settle()
    expect(audio.played).toBe(0)
    dispatch(ev(3, msg({ seq: 3, threadRootId: root.id, following: true })))
    // (the server tells a follower their room right after: the thread's news counts in its badge)
    dispatch(threadNews(1))
    await settle()
    expect(audio.played).toBe(1)
  })

  test('the room open in this focused window does not ring; the switch turned off rings nothing', async () => {
    ;(document as unknown as { hasFocus: () => boolean }).hasFocus = () => true
    useRooms.setState({ openRoomId: ROOM })
    dispatch(ev(1))
    await settle()
    expect(audio.played).toBe(0)
    useRooms.setState({ openRoomId: null })
    changeRoomSound(false)
    dispatch(ev(2, msg({ seq: 2 })))
    await settle()
    expect(audio.played).toBe(0)
    expect(localStorage.getItem(SOUND_KEY)).toBe('off')
  })
})

// ---------------- in the app: read elsewhere before it rings ----------------

describe('read on another device or window before it rings', () => {
  const rooms0 = useRooms.getState(), session0 = useSession.getState()
  let audio: FakeAudio
  const team = room({ id: ROOM, kind: 'team' })
  beforeEach(() => {
    installDom()
    ;(document as unknown as { visibilityState: string }).visibilityState = 'visible'
    ;(document as unknown as { hasFocus: () => boolean }).hasFocus = () => false
    audio = new FakeAudio()
    useSession.setState({ status: { kind: 'signed-in', me: { user: { id: ME.id } } as Me } })
    useRooms.setState({ rooms: [team], loaded: true })
    startRoomSound({ audio, settleMs: 30 })
  })
  afterEach(() => {
    stopRoomSound()
    removeDom()
    useRooms.setState(rooms0, true)
    useSession.setState(session0, true)
  })
  const later = () => new Promise((r) => setTimeout(r, 80))
  const ev = (seq: number, m: ReturnType<typeof msg>): ServerEvent => ({ type: 'room.message', seq, at: Date.now(), data: { roomId: ROOM, message: m } })
  const roomNow = (o: Partial<ReturnType<typeof room>>, seq: number): ServerEvent => ({ type: 'room.updated', seq, at: Date.now(), data: { roomId: ROOM, change: 'updated', room: { ...useRooms.getState().rooms[0]!, ...o } } })

  test('a mention I read on my phone a moment later does not ring here; one I did not read does', async () => {
    dispatch(ev(1, msg({ seq: 1, mentions: [ME.id] })))
    expect(useRooms.getState().rooms[0]).toMatchObject({ unreadCount: 1, mentioned: true })
    // the phone shows the room: the server tells all my windows (room.read)
    dispatch({ type: 'room.read', seq: 2, at: Date.now(), data: { roomId: ROOM, lastReadSeq: 1, unreadCount: 0, mentioned: false } })
    await later()
    expect(audio.played).toBe(0)
    expect(useRooms.getState().rooms[0]).toMatchObject({ unreadCount: 0, mentioned: false, lastReadSeq: 1 })
    dispatch(ev(3, msg({ seq: 2, mentions: [ME.id] })))
    await later()
    expect(audio.played).toBe(1)
  })

  test('a reply in a thread I follow, read in that thread elsewhere: quiet; a read of the room only does not cover it', async () => {
    const root = msg({ seq: 1, author: ME })
    dispatch(ev(1, msg({ seq: 2, threadRootId: root.id, following: true })))
    dispatch(roomNow({ threadsUnread: 1, nextThreadId: root.id }, 2))
    // read in the thread on another device: the room comes again with no thread news
    dispatch(roomNow({ threadsUnread: 0, nextThreadId: null }, 3))
    await later()
    expect(audio.played).toBe(0)
    dispatch(ev(4, msg({ seq: 3, threadRootId: root.id, following: true })))
    dispatch(roomNow({ threadsUnread: 1, nextThreadId: root.id }, 5))
    // reading the room elsewhere moves the room's position, not the thread's
    dispatch({ type: 'room.read', seq: 6, at: Date.now(), data: { roomId: ROOM, lastReadSeq: 3, unreadCount: 0, mentioned: false } })
    await later()
    expect(audio.played).toBe(1)
  })

  test('the room muted on another device meanwhile, or signed out here: quiet', async () => {
    dispatch(ev(1, msg({ seq: 1, mentions: [ME.id] })))
    dispatch(roomNow({ muted: true }, 2))
    await later()
    dispatch(ev(3, msg({ seq: 2, mentions: [ME.id] })))
    stopRoomSound()
    await later()
    expect(audio.played).toBe(0)
  })
})
