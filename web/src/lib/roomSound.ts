// The room sound (docs/DECISIONS.md "대화방 알림 소리"): a short, soft chime when a room message that is meant for me
// arrives and I am not already looking at it. Nothing else in the app makes a sound.
//
// - What rings: shouldRing below (a pure function; test/unit/room-sound.test.ts): what the server notifies, by the same
//   rule (shared room-alerts.ts roomAlert, docs/DECISIONS.md "대화방 알림 설정") with the room's level the server sends
//   (Room.notify.level: my own for the room, else my default for its kind) and my thread-replies switch and quiet hours
//   (the rooms list's alerts). By default: every message in a DM or a group chat, a message that mentions me in a team
//   room or the everyone room (by name, or "@전체" from someone else), a reply in a thread I follow (RoomMessage.following) or that mentions me; plus an AI
//   answer to my own question (my private preview, or the answer that went to the room). Reactions never ring (they
//   are no room.message). Never: a room at 끄기 (or a default of 받지 않음), inside my quiet hours, my own messages, event
//   lines, deleted messages, a message seen before (a replay after a reconnect, the copy of a preview I posted), or a
//   message of the conversation this device shows in a window the person looks at (lib/attention.ts lookingAt: in the
//   desktop app its window's focus, as the app says): the room open, or for a reply the thread a panel shows
//   (conversationOnScreen; docs/DECISIONS.md "화면에 연 대화는 울리지 않는다").
// - One sound per device: every tab gets the same events, so a tab rings only when (a) its audio may play, (b) it takes
//   the device's slot: one sound every COALESCE_MS for all rooms and tabs. Where there is a Web Lock the tab that
//   rings holds it for COALESCE_MS (the browser's one lock manager decides, at once); without one (plain http, older
//   browsers) the time in localStorage alone, which two tabs can read at the same moment. Which room (and threads) a
//   focused tab shows is in localStorage too, so a tab in the background stays quiet about what another tab is showing.
// - Browsers start audio only after a gesture: the first tap, click or key on the page unlocks it; between sounds the
//   audio is suspended (no audio output held open); a sound that still cannot play is dropped without a word.
// - Phones (the phone app, and a touch-only browser): only while the page is on screen, and not in the first moments
//   after it comes back (messages that waited while it was away arrive then, and the phone's notification already
//   sounded for them). In the background the phone's own notification has the sound (mobile/src/push.ts keeps
//   notifications quiet while the app is open, so the sound comes from one place).
// - Web Push in a browser: the service worker asks the open pages before it shows a room notification and shows it
//   silently when one of them takes care of the sound (web/pwa/sw.js).
// - The switch (Settings › Notifications, "알림 소리") is this device's only, in localStorage; on by default.
import { inQuietHours, roomAlert, roomLevel, uuidv7Time, type Room, type RoomAlertSettings, type RoomMessage } from '@mycel/shared/api'
import { conversationOnScreen, type RoomsOnScreen } from './attention'
import { mentionsMe } from './rooms'

/** at most one sound this often, all rooms and tabs together */
export const COALESCE_MS = 3000
/** an AI answer posted from a private preview carries the preview's id: its id is older than its time by at least the
 * time it took the person to press 대화방에 올리기 */
export const REPOST_MS = 5000
/** a focused tab says again what it shows this often; a word older than VIEW_TTL_MS is ignored (a closed tab) */
export const VIEW_EVERY_MS = 10_000
export const VIEW_TTL_MS = 30_000
const SEEN_MAX = 500

export const SOUND_KEY = 'mycel.roomSound'
export const LAST_KEY = 'mycel.roomSound.last'
export const VIEW_KEY = 'mycel.roomSound.view'
const LOCK_NAME = 'mycel.roomSound'

export type RingMessage = Pick<RoomMessage, 'id' | 'seq' | 'authorKind' | 'author' | 'askedBy' | 'visibility' | 'mentions' | 'createdAt' | 'deletedAt'> & Partial<Pick<RoomMessage, 'threadRootId' | 'alsoInRoom' | 'following' | 'mentionsAll'>> & { event?: unknown }

export interface RingInput {
  roomId: string
  message: RingMessage
  /** the room as this window knows it (null: not in my list yet); `notify` from the server (absent: an older one) */
  room: { kind: string; muted: boolean; notify?: Room['notify']; hidden?: boolean } | null
  /** my thread-replies switch, quiet hours and the team's time zone (the rooms list's alerts; absent: an older server,
   * replies in threads I follow ring and there are no quiet hours) */
  alerts?: RoomAlertSettings | null
  /** the time it arrived (quiet hours) */
  now?: number
  meId: string | null
  /** sent again after a reconnect (lib/realtime.ts) */
  replay: boolean
  /** this window had this message already (a replay, or the posted copy of a preview it showed) */
  seen: boolean
  /** what this device shows in a window the person looks at (null: none): the room open and the threads on screen */
  viewing: RoomsOnScreen | null
}

/** Does this new message ring? */
export function shouldRing(i: RingInput): boolean {
  const { message: m, room, meId } = i
  if (!meId || !room || i.replay || i.seen) return false
  // a room I hid rings nothing: what is for me brings it back first (room.updated comes before its message)
  if (room.hidden) return false
  // an event line (someone joined, the room was renamed …): not a message anyone wrote
  if (m.event !== undefined && m.event !== null) return false
  const level = room.notify?.level ?? roomLevel(room.kind, room.muted ? 'off' : null, 'direct')
  if (m.deletedAt || level === 'off' || conversationOnScreen(i.viewing, i.roomId, m.threadRootId)) return false
  if (i.alerts && inQuietHours(i.alerts.quietHours, i.alerts.timeZone, i.now ?? Date.now())) return false
  if (m.authorKind === 'user' && m.author?.id === meId) return false
  if (m.authorKind === 'ai' && m.askedBy?.id === meId) {
    // the answer to my question; but not the copy that goes to the room when I post my preview: I did that myself
    if (m.visibility === 'private') return true
    const posted = Date.parse(m.createdAt) - uuidv7Time(m.id)
    return !(posted > REPOST_MS)
  }
  if (m.visibility !== 'room') return false
  // the server's rule for its notices: a mention, a reply in a thread I follow, and at 모든 메시지 any message of the room
  return roomAlert({
    level, mentioned: mentionsMe(m, meId), reply: !!m.threadRootId, alsoInRoom: !!m.alsoInRoom,
    following: !!m.following, threadReplies: i.alerts?.threadReplies ?? true,
  }) !== null
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const local = (): Store | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** The switch: on unless this device turned it off. */
export function roomSoundOn(s: Store | null = local()): boolean {
  try { return s?.getItem(SOUND_KEY) !== 'off' } catch { return true }
}
export function setRoomSoundOn(on: boolean, s: Store | null = local()) {
  try {
    if (on) s?.removeItem(SOUND_KEY)
    else s?.setItem(SOUND_KEY, 'off')
  } catch { /* storage blocked: the switch stays as it was */ }
}

/** What a focused tab wrote about what it shows: the room open and the threads on screen (absent from an older tab). */
export interface ViewWord { tab: string; room: string | null; threads?: string[]; at: number }
export function readView(s: Store | null, now: number): ViewWord | null {
  try {
    const v = JSON.parse(s?.getItem(VIEW_KEY) ?? 'null') as ViewWord | null
    if (!v || typeof v.tab !== 'string' || typeof v.at !== 'number' || Math.abs(now - v.at) > VIEW_TTL_MS) return null
    const threads = Array.isArray(v.threads) ? v.threads.filter((t): t is string => typeof t === 'string').slice(0, 20) : []
    return { tab: v.tab, room: typeof v.room === 'string' ? v.room : null, threads, at: v.at }
  } catch { return null }
}

/** The part of the Web Locks API used here (navigator.locks; absent on plain http and older browsers). */
export interface LocksLike {
  request<T>(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => T | Promise<T>): Promise<T>
}

export interface AudioLike {
  /** may it make a sound now (unlocked by a gesture, not paused by the phone) */
  ready(): boolean
  play(): void
}

export interface SoundDeps {
  tabId: string
  now: () => number
  storage: Store | null
  locks: LocksLike | null
  /** the person looks at this window (lib/attention.ts lookingAt: on screen and focused; the desktop app: its window
   * focused; the phone app: on screen) */
  focused: () => boolean
  /** quiet now: a phone's page in the background or just back from it (the phone's notification has the sound) */
  quiet: () => boolean
  /** hold the device's lock this long (tests: at once) */
  hold?: (ms: number) => Promise<void>
  /** what this window shows (store/rooms.ts openRoomId and threadViews) */
  onScreen: () => RoomsOnScreen
  audio: AudioLike
  /** wait this long before ringing, and then ring only if the message is still unread here: the same person may be
   * reading that room on another device or window, which marks it read within moments (room.read reaches this window
   * then). `read` also says yes when there is nothing to ring for any more (the room muted or gone meanwhile). Without
   * it (tests): at once */
  settle?: { ms: number; read: (roomId: string, message: RingMessage) => boolean; wait?: (ms: number) => Promise<void> }
}

/** One tab's part of the device's sound: what it saw, what its focused window shows, and taking the slot. */
export class RoomSound {
  private seen = new Set<string>()
  private lastHere = 0
  private stopped = false
  constructor(private d: SoundDeps) {}

  /** Signed out or stopped: a sound still waiting (settle) stays quiet. */
  stop() { this.stopped = true }

  /** What this device shows in a window the person looks at: this one's, or what another tab said it shows. */
  viewing(): RoomsOnScreen | null {
    if (this.d.focused()) return this.d.onScreen()
    const v = readView(this.d.storage, this.d.now())
    return v && v.tab !== this.d.tabId ? { room: v.room, threads: v.threads ?? [] } : null
  }

  /** Say (or stop saying) what this window shows, for the other tabs. */
  publishView() {
    if (!this.d.focused()) return this.forgetView()
    const on = this.d.onScreen()
    try { this.d.storage?.setItem(VIEW_KEY, JSON.stringify({ tab: this.d.tabId, room: on.room, threads: [...(on.threads ?? [])], at: this.d.now() } satisfies ViewWord)) }
    catch { /* storage blocked: each tab knows its own room only */ }
  }

  /** Not focused any more (or signed out): take back this window's word, never another tab's. */
  forgetView() {
    try { if (readView(this.d.storage, this.d.now())?.tab === this.d.tabId) this.d.storage?.removeItem(VIEW_KEY) }
    catch { /* storage blocked */ }
  }

  /** A room.message event: rings when it should and this tab takes the device's slot. Resolves whether it rang. */
  async message(roomId: string, message: RingMessage, room: RingInput['room'], meId: string | null, replay: boolean, alerts: RoomAlertSettings | null = null): Promise<boolean> {
    const seen = this.seen.has(message.id)
    this.remember(message.id)
    if (!roomSoundOn(this.d.storage) || this.d.quiet()) return false
    if (!shouldRing({ roomId, message, room, alerts, now: this.d.now(), meId, replay, seen, viewing: this.viewing() })) return false
    // a tab whose audio cannot play leaves the slot to one that can
    if (!this.d.audio.ready()) return false
    // read meanwhile on another device or window (or this window opened the room): no sound for what was read
    const settle = this.d.settle
    if (settle) {
      await (settle.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(settle.ms)
      if (this.stopped || settle.read(roomId, message) || conversationOnScreen(this.viewing(), roomId, message.threadRootId) || !roomSoundOn(this.d.storage) || this.d.quiet() || !this.d.audio.ready()) return false
    }
    if (!(await this.claim())) return false
    try { this.d.audio.play() } catch { /* no sound, no error */ }
    return true
  }

  /** Does this page take care of the sound of a room notice now, so the service worker shows it silently? Yes when
   * this device's sound is off (none is wanted), or when the page gets the room's events (connected) and may play. */
  handles(connected: boolean): boolean {
    return !roomSoundOn(this.d.storage) || (connected && this.d.audio.ready() && !this.d.quiet())
  }

  private remember(id: string) {
    this.seen.add(id)
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string)
  }

  /** The device's slot: free when the last sound of any tab was COALESCE_MS ago or more (or the clock moved back). */
  private take(): boolean {
    const now = this.d.now()
    let last = this.lastHere
    try { last = Math.max(last, Number(this.d.storage?.getItem(LAST_KEY)) || 0) } catch { /* this tab's own time only */ }
    if (Math.abs(now - last) < COALESCE_MS) return false
    this.lastHere = now
    try { this.d.storage?.setItem(LAST_KEY, String(now)) } catch { /* the other tabs may ring too */ }
    return true
  }

  /** With a Web Lock: the tab that rings keeps the lock for COALESCE_MS, so every other tab (and this one) finds it
   * taken until then, whatever localStorage has passed on yet. */
  private claim(): Promise<boolean> {
    const locks = this.d.locks
    if (!locks) return Promise.resolve(this.take())
    const hold = this.d.hold ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    return new Promise<boolean>((resolve) => {
      let answered = false
      const answer = (v: boolean) => { if (!answered) { answered = true; resolve(v) } }
      locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        const won = !!lock && this.take()
        answer(won)
        if (won) await hold(COALESCE_MS)
      }).catch(() => answer(this.take()))
    })
  }
}

// ---------------- the chime ----------------

/** Two soft notes up a fourth (G5, C6), each a sine with a quiet octave above it; about 0.7 s, made here at run time
 * (no sound file). */
export const CHIME_NOTES = [{ hz: 783.99, at: 0 }, { hz: 1046.5, at: 0.12 }] as const
/** Master gain. 0.12 was too quiet (owner, 2026-11-10); 0.36 is three times the amplitude (+9.5 dB). The mixed peak of
 * all four partials is about 0.43 at the output (a test renders it), under the clip limit, so no compressor is needed. */
export const CHIME_VOLUME = 0.36

type Ctx = Pick<AudioContext, 'state' | 'currentTime' | 'destination' | 'resume' | 'suspend' | 'createGain' | 'createOscillator' | 'createBuffer' | 'createBufferSource'>

export function playChime(ctx: Ctx) {
  const t0 = ctx.currentTime + 0.01
  const out = ctx.createGain()
  out.gain.value = CHIME_VOLUME
  out.connect(ctx.destination)
  for (const n of CHIME_NOTES) {
    for (const [mult, level, len] of [[1, 1, 0.6], [2, 0.2, 0.25]] as const) {
      const start = t0 + n.at
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = n.hz * mult
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(level, start + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, start + len)
      o.connect(g)
      g.connect(out)
      o.start(start)
      o.stop(start + len + 0.02)
    }
  }
}

type AudioWindow = { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext }
/** the chime's length and a little more: the context rests (suspends) after it, so the audio device is not kept open */
const REST_AFTER_MS = 1500

/** The page's one AudioContext. Made and started at the first gesture (browsers start audio only in one); once it has
 * run, it may start again without a gesture (Chrome and Firefox: the page was used; WebKit: this context was started in
 * a gesture), so between sounds it is suspended and the phone's or computer's audio output is not held open. */
export class Chime implements AudioLike {
  private ctx: Ctx | null = null
  private made = false
  private unlocked = false
  private waking = false
  private rest: ReturnType<typeof setTimeout> | null = null
  constructor(private make: () => Ctx | null = () => {
    const w = globalThis as unknown as AudioWindow
    const C = w.AudioContext ?? w.webkitAudioContext
    // the page's audio session is left as it is: WebKit plays Web Audio alone as ambient sound (it mixes with music and
    // keeps quiet on the silent switch), and changing it for the page would change voice input and file previews too
    return C ? new C() : null
  }) {}

  /** unlocked by a gesture once (and not closed) */
  ready() { return this.unlocked && !!this.ctx && this.ctx.state !== 'closed' }

  /** In a gesture: unlock (WebKit also wants a sound started in the gesture: one silent sample). Resolves whether the
   * context runs. Nothing to do once unlocked. */
  prime(): Promise<boolean> {
    if (this.unlocked) return Promise.resolve(true)
    try {
      if (!this.made) { this.made = true; this.ctx = this.make() }
      const ctx = this.ctx
      if (!ctx) return Promise.resolve(false)
      const src = ctx.createBufferSource()
      src.buffer = ctx.createBuffer(1, 1, 22050)
      src.connect(ctx.destination)
      src.start(0)
      return ctx.resume().then(() => {
        if (ctx.state !== 'running') return false
        this.unlocked = true
        this.later()
        return true
      }, () => false)
    } catch { return Promise.resolve(false) }
  }

  play() {
    const ctx = this.ctx
    if (!ctx || !this.ready()) return
    const go = () => { playChime(ctx); this.later() }
    if (ctx.state === 'running') return go()
    // starting again: one at a time, and only if it starts soon (a resume can wait until a phone gives the audio back;
    // a late chime, or several at once, would be worse than none)
    if (this.waking) return
    this.waking = true
    const asked = Date.now()
    void ctx.resume().then(() => {
      this.waking = false
      if (ctx.state === 'running' && Date.now() - asked < 1000) go()
    }, () => { this.waking = false })
  }

  /** The switch turned on (a click): unlock and let the person hear it once. */
  preview() {
    void this.prime().then((ok) => { if (ok) this.play() })
  }

  private later() {
    if (this.rest) clearTimeout(this.rest)
    this.rest = setTimeout(() => {
      this.rest = null
      const ctx = this.ctx
      if (ctx?.state === 'running') void ctx.suspend().catch(() => {})
    }, REST_AFTER_MS)
  }
}
