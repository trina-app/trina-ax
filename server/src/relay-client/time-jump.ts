// F2 sleep: notice that this process was frozen (the hosted VM was suspended to disk and resumed, or a laptop slept).
// A timer that fires every `everyMs` sees a much larger gap on the wall clock after a resume; then `onJump` runs once.
// The relay client uses it to drop its half-open control connections and reconnect at once, instead of waiting for
// its silence limit (deadMs) and the reconnect backoff: the resume-to-first-request time is what a visitor waits for.
export const JUMP_EVERY_MS = 2_000
export const JUMP_MIN_GAP_MS = 15_000

export class TimeJumpWatch {
  private timer: ReturnType<typeof setInterval> | null = null
  private last = 0
  constructor(private o: { onJump(gapMs: number): void; everyMs?: number; minGapMs?: number; now?: () => number }) {}

  private now(): number { return (this.o.now ?? Date.now)() }

  start(): void {
    if (this.timer) return
    this.last = this.now()
    this.timer = setInterval(() => this.tick(), this.o.everyMs ?? JUMP_EVERY_MS)
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  /** one timer tick (tests call it with a fake clock) */
  tick(): void {
    const now = this.now()
    const gap = now - this.last
    this.last = now
    // a clock set back (NTP after a resume) is a jump too: the gap since the last tick is not what the timer expected
    if (gap > (this.o.minGapMs ?? JUMP_MIN_GAP_MS) || gap < 0) this.o.onJump(gap)
  }
}
