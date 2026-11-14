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

export class WakeWait {
  private timer: unknown = null
  /** the 3 minutes passed with the team still starting */
  gaveUp = false

  constructor(private readonly onChange: () => void, private readonly clock: WakeClock = browserClock) {}

  /** the latest answer: still "starting" (the wait goes on, it is not started over), or anything else (the wait ends) */
  update(waking: boolean): void {
    if (!waking) {
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

/** `waking`: the place's latest answer was the relay's team_waking (lib/api.ts isTeamWaking). */
export function useWakeWait(waking: boolean): { gaveUp: boolean; restart: () => void } {
  const [, redraw] = useState(0)
  const wait = useRef<WakeWait | null>(null)
  wait.current ??= new WakeWait(() => redraw((n) => n + 1))
  useEffect(() => {
    wait.current!.update(waking)
  }, [waking])
  useEffect(() => () => wait.current?.stop(), [])
  return { gaveUp: waking && wait.current.gaveUp, restart: () => wait.current!.restart() }
}
