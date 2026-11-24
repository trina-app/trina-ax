// One memory budget for the server's heavy jobs (docs/decisions/20261124-heavy-job-budget.md): the promo video's MP4
// (promo-video/render.ts, S/video), LibreOffice conversions (files/office-view.ts, S/conv) and the browser's prints and
// page views (files/html-pdf.ts renderSlot / tryRenderSlot, S/print). Each runs in a cgroup with its own cap, but the
// caps are sized one at a time: on a 4 GiB box a render (1280 MiB leaf) and a LibreOffice conversion (S/conv, a quarter
// of the box) each stayed inside its cap and together took the box's last free memory, and the kernel's global OOM
// killed the render (real-render check of #526, arm64 2 CPU 4 GiB, 1 of 4 overlapped runs).
// Every heavy job takes this budget before it starts and gives it back when it ends:
// - under HEAVY_SHARED_FROM_MIB of memory (the plan's or the machine's) one heavy job runs at a time;
// - above, jobs run together while the caps of the running ones fit the box minus HEAVY_RESERVE_MIB (the server, the
//   turns and the system); a job alone always runs, whatever its cap;
// - first come, first served: a job that waits is never passed by a later one, so no kind starves another (a video is
//   not kept waiting by a stream of conversions, nor the other way round); tryAcquire never goes before a waiting job.
// Lock order: a print or a conversion takes its print slot (html-pdf.ts renderSlot) first and then this budget; the
// render takes only this budget (after its own one-at-a-time queue). Nothing takes this budget and then waits for a
// print slot, so the two queues cannot wait on each other.
// In-process: every heavy job runs from the server's main process (no worker starts one).
import { converterCgroup, convBudgetMiB, planMemoryMiB, PRINT_ONE_MIB, videoCgroup, videoLeafMiB, VIDEO_STREAM_FROM_MIB } from './cgroups'

export type HeavyKind = 'video' | 'office' | 'print'

/** Memory below which heavy jobs run one at a time (the 4 GiB team VM; a hosted 6 GiB plan shares). */
export const HEAVY_SHARED_FROM_MIB = VIDEO_STREAM_FROM_MIB
/** What the box keeps for everything else (the server, the turns' engines and the system) when jobs share. */
export const HEAVY_RESERVE_MIB = 3584

/** The plan's memory (plan.json memoryMiB) or the machine's, in MiB (system/cgroups.ts planMemoryMiB). */
export const machineMemoryMiB = planMemoryMiB

/** The memory heavy jobs may hold together, in MiB; 0: one at a time. */
export function heavyBudgetMiB(memoryMiB: number): number {
  return memoryMiB < HEAVY_SHARED_FROM_MIB ? 0 : memoryMiB - HEAVY_RESERVE_MIB
}

export class HeavyJobError extends Error {
  constructor(public code: 'busy' | 'aborted', message: string) { super(message) }
}

interface Waiter { kind: HeavyKind; mib: number; grant: () => void; fail: (e: HeavyJobError) => void }

export interface AcquireOptions {
  signal?: AbortSignal
  /** give up after this long with HeavyJobError('busy') (none: wait until granted or aborted) */
  maxWaitMs?: number
  /** called once when the job has to wait (not when it starts at once) */
  onWait?: () => void
}

/** The budget: `budget()` and `weight()` are read at every decision (a plan change applies to the next job). */
export class HeavyJobs {
  private readonly running = new Map<symbol, { kind: HeavyKind; mib: number }>()
  private readonly waiting: Waiter[] = []
  constructor(private readonly budget: () => number, private readonly weight: (kind: HeavyKind) => number) {}

  private used(): number { let n = 0; for (const r of this.running.values()) n += r.mib; return n }
  private fits(mib: number): boolean {
    if (this.running.size === 0) return true
    const b = this.budget()
    return b > 0 && this.used() + mib <= b
  }
  private start(kind: HeavyKind, mib: number): () => void {
    const id = Symbol(kind)
    this.running.set(id, { kind, mib })
    let done = false
    return () => { if (done) return; done = true; this.running.delete(id); this.pump() }
  }
  /** Grant waiting jobs in order while the first one fits (never one behind a job that does not fit yet). */
  private pump(): void {
    while (this.waiting.length && this.fits(this.waiting[0]!.mib)) this.waiting.shift()!.grant()
  }

  /** Wait for room, then run; call the returned release exactly when the job's processes have ended. */
  acquire(kind: HeavyKind, o: AcquireOptions = {}): Promise<() => void> {
    const mib = this.weight(kind)
    if (o.signal?.aborted) return Promise.reject(new HeavyJobError('aborted', 'stopped'))
    if (!this.waiting.length && this.fits(mib)) return Promise.resolve(this.start(kind, mib))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => { if (timer) clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort) }
      const w: Waiter = {
        kind, mib,
        grant: () => { cleanup(); resolve(this.start(kind, mib)) },
        fail: (e) => {
          cleanup()
          const i = this.waiting.indexOf(w)
          if (i < 0) return
          this.waiting.splice(i, 1)
          // the one that left may have held back smaller ones behind it
          this.pump()
          reject(e)
        },
      }
      const onAbort = () => w.fail(new HeavyJobError('aborted', 'stopped'))
      o.signal?.addEventListener('abort', onAbort, { once: true })
      if (o.maxWaitMs !== undefined) timer = setTimeout(() => w.fail(new HeavyJobError('busy', 'the server is busy with another large job (a video file or a document); try again in a few minutes')), o.maxWaitMs)
      // told before it joins the line: a callback that throws never leaves a waiter nobody releases
      try { o.onWait?.() } catch { /* the caller's own */ }
      this.waiting.push(w)
    })
  }

  /** Room now, or null (never waits, never goes before a job that waits). */
  tryAcquire(kind: HeavyKind): (() => void) | null {
    const mib = this.weight(kind)
    return !this.waiting.length && this.fits(mib) ? this.start(kind, mib) : null
  }

  /** what runs and how many wait (logs, tests) */
  state(): { running: HeavyKind[]; waiting: HeavyKind[]; usedMiB: number; budgetMiB: number } {
    return { running: [...this.running.values()].map((r) => r.kind), waiting: this.waiting.map((w) => w.kind), usedMiB: this.used(), budgetMiB: this.budget() }
  }
}

/** The memory cap a job of this kind runs under (its cgroup's limit), in MiB. */
export function heavyWeightMiB(kind: HeavyKind): number {
  if (kind === 'video') return videoCgroup()?.memoryMiB ?? videoLeafMiB()
  if (kind === 'print') return PRINT_ONE_MIB
  // a conversion may grow to the whole of S/conv
  return converterCgroup()?.memoryMiB ?? convBudgetMiB(process.env.MYCEL_PLAN_FILE)
}

let memoryForTests: number | null = null
/** Tests size the server's budget as a box of this much memory (null: the plan's or the machine's again). */
export function setHeavyMemoryForTests(mib: number | null) { memoryForTests = mib }

/** The server's one budget. */
export const heavyJobs = new HeavyJobs(() => heavyBudgetMiB(memoryForTests ?? machineMemoryMiB()), heavyWeightMiB)
