// This window's part in the team's online status (docs/DECISIONS.md "접속 상태"): is the person at it ('active') or
// not ('idle')? The server adds up the windows of each person (server/src/realtime/presence.ts); the team sees a dot.
//
// - In use until 10 minutes pass without input (a pointer, a key, a touch, the wheel, the window's focus), as Slack
//   counts a computer. A hidden page gets no input, so on a computer it goes idle 10 minutes after the last; coming
//   back to it counts as input.
// - A phone (the phone app, or a browser whose only pointer is a finger): visible is in use and hidden is idle at once,
//   whatever the input, as Slack's "away when you leave the app" (a phone locks its screen by itself). The phone app's
//   page is told it is hidden when the app goes to the background, before the system stops it, so the frame still
//   goes out.
// - Only a change is sent (input only notes the time, at most once a second), and the current state again after each
//   hello (the server takes a window that has just connected as in use). Nothing is sent while disconnected.
import type { WindowActivity } from '@mycel/shared/api'
import { mobileApp } from './mobile'

export const IDLE_AFTER_MS = 10 * 60_000
/** input closer together than this is not noted again while in use (pointer moves come many a second) */
const INPUT_EVERY_MS = 1000

export interface ActivityEnv {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  visible(): boolean
  /** a phone: a hidden page is idle at once */
  phone: boolean
}

export class ActivityTracker {
  private last: number
  private state: WindowActivity
  private timer: unknown = null
  private stopped = false

  constructor(private send: (s: WindowActivity) => void, private env: ActivityEnv, private idleMs = IDLE_AFTER_MS) {
    this.last = env.now()
    this.state = this.compute()
    this.arm()
  }

  get current(): WindowActivity { return this.state }

  /** a pointer, a key, a touch, the wheel, the window's focus */
  input() {
    if (this.stopped) return
    const now = this.env.now()
    if (this.state === 'active' && now - this.last < INPUT_EVERY_MS) return
    this.last = now
    this.update()
  }

  /** the page was hidden or shown */
  visibility() {
    if (this.stopped) return
    if (this.env.visible()) this.last = this.env.now()
    this.update()
  }

  /** the socket said hello: the server knows this window afresh */
  connected() {
    if (!this.stopped) this.send(this.state)
  }

  stop() {
    this.stopped = true
    if (this.timer) this.env.clearTimeout(this.timer)
    this.timer = null
  }

  private compute(): WindowActivity {
    if (this.env.phone) return this.env.visible() ? 'active' : 'idle'
    return this.env.now() - this.last >= this.idleMs ? 'idle' : 'active'
  }

  private update() {
    const s = this.compute()
    if (s !== this.state) {
      this.state = s
      this.send(s)
    }
    this.arm()
  }

  /** one timer while in use, for when the last input will be 10 minutes old (input does not move it: it checks again) */
  private arm() {
    if (this.stopped || this.timer || this.state !== 'active' || this.env.phone) return
    const wait = Math.max(0, this.last + this.idleMs - this.env.now())
    this.timer = this.env.setTimeout(() => {
      this.timer = null
      this.update()
    }, wait + 50)
  }
}

/** a phone or tablet whose only pointer is a finger, or the phone app */
const phone = () => !!mobileApp() || (typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches && !window.matchMedia?.('(any-pointer: fine)')?.matches)

const INPUTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const

/** The tracker on this page's own input and visibility; `send` gets each change. */
export function startActivity(send: (s: WindowActivity) => void): ActivityTracker & { detach(): void } {
  const t = new ActivityTracker(send, {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
    visible: () => document.visibilityState === 'visible',
    phone: phone(),
  })
  const onInput = () => t.input()
  const onVisible = () => t.visibility()
  for (const e of INPUTS) window.addEventListener(e, onInput, { capture: true, passive: true })
  document.addEventListener('visibilitychange', onVisible)
  return Object.assign(t, {
    detach() {
      t.stop()
      for (const e of INPUTS) window.removeEventListener(e, onInput, { capture: true })
      document.removeEventListener('visibilitychange', onVisible)
    },
  })
}
