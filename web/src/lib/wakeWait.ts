// How long the app waits for a team that is starting (QA wake gap 2). A free trial's server turns off when nobody uses
// it; the relay then answers every request with a retryable 503 team_waking while it starts (about a minute, #861), and
// the app shows "Starting your team…" and asks again by itself. If the start fails, the relay keeps answering
// team_waking and the spinner would turn for ever: after 3 minutes of nothing but "starting" the app says the team did
// not start, with [Try again], which starts the wait over (the app keeps asking meanwhile, so a late start still opens).
import { useEffect, useRef, useState } from 'react'

/** a start takes about a minute; three is a failed one */
export const WAKE_GIVE_UP_MS = 180_000

export interface WakeClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
}

const browserClock: WakeClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/** what the place's latest answer was: the relay's team_waking, another connection error, or anything else */
export type WakeState = 'waking' | 'connection' | 'other'

export class WakeWait {
  private timer: unknown = null
  /** the 3 minutes passed with the team still starting */
  gaveUp = false

  constructor(private readonly onChange: () => void, private readonly clock: WakeClock = browserClock) {}

  /** the latest answer: still "starting" (the wait goes on, it is not started over); a connection error in between (a
   * 502 or a dropped request while the server boots: the wait goes on too, so a failing start that alternates the two
   * still ends in "didn't start"); anything else, an answer or another error (the wait ends) */
  update(state: WakeState): void {
    if (state === 'connection') return
    if (state === 'other') {
      const was = this.gaveUp
      this.stop()
      if (was) this.onChange()
      return
    }
    if (this.timer === null && !this.gaveUp) this.arm()
  }

  /** [Try again]: three more minutes */
  restart(): void {
    this.stop()
    this.arm()
    this.onChange()
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.gaveUp = false
  }

  private arm(): void {
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.gaveUp = true
      this.onChange()
    }, WAKE_GIVE_UP_MS)
  }
}

/** `state`: the place's latest answer (lib/api.ts isTeamWaking, isConnectionError); gaveUp only while it is waking. */
export function useWakeWait(state: WakeState): { gaveUp: boolean; restart: () => void } {
  const [, redraw] = useState(0)
  const wait = useRef<WakeWait | null>(null)
  wait.current ??= new WakeWait(() => redraw((n) => n + 1))
  const waking = state === 'waking'
  useEffect(() => {
    wait.current!.update(state)
  }, [state])
  useEffect(() => () => wait.current?.stop(), [])
  return { gaveUp: waking && wait.current.gaveUp, restart: () => wait.current!.restart() }
}
