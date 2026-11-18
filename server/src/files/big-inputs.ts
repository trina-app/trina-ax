// Large files that a tool reads whole into this process before a helper gets them (the PDF tools, stamp_pdf,
// resize_images; docs/decisions/20261118-audit2-file-caps.md):
// - the limit per call follows the memory the helper really has: the converter cgroup's memory.max on production Linux
//   (system/cgroups.ts convBudgetMiB, 512-1536 MiB by the machine or the plan), else the helper's own memory limit;
//   the measured ceilings (100 MB of PDFs, 150 MB per photo) stay the most;
// - a byte gate: the bytes are reserved before they are read, so the calls at once hold at most "slots x limit" in this
//   process; a few more wait in line, the rest get a plain "busy" answer (no unbounded queue of 100 MB reads).
import { cgroupState } from '../system/cgroups'
import { ToolError } from '../policy/errors'
import { OFFICE_WORKER_RSS_MIB, officeWorkersMax } from './extract'
import { PDF_PAGES_INPUT_MAX } from './pdf-pages'
import type { Database } from 'bun:sqlite'
import { guestUploadMax, sizeWords } from '../uploads/guest-limit'

const MIB = 1024 * 1024

/** the memory a helper process has here: the converter cgroup's where it applies, else `own` (its rlimit) */
export function helperBudgetMiB(own: number): number {
  const s = cgroupState()
  return s.state === 'delegated' ? Math.min(own, s.conv.memoryMiB) : own
}

/** pdf-lib in the office worker: about 10 MiB of memory per MB of PDF (measured: 1.05 GB for 100 MB, 2.0 GB for
 * 200 MB), with room to spare for a PDF of many small objects */
export const PDF_MIB_PER_MB = 12
/** the Go image helper: the decoded pixels and the file (measured: 840 MiB for a 102 MB 16-bit 49 MP PNG) */
export const PHOTO_MIB_PER_MB = 8

/** The largest input (bytes) for a helper with `budgetMiB` of memory: `ceiling` at most, whole MB. */
export function inputMaxFor(budgetMiB: number, mibPerMb: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(1, Math.floor(budgetMiB / mibPerMb)) * MIB)
}

/** "is larger than N MB": the server's own limit when memory sets it lower than the tool's, said so */
export function tooLargeText(name: string, max: number, ceiling: number, what: string): string {
  const mb = Math.floor(max / MIB)
  return max < ceiling
    ? `'${name}' is larger than ${mb} MB, the most this server's memory allows for ${what} (larger servers take up to ${Math.floor(ceiling / MIB)} MB); nothing was read. Tell the user the file is too big for this server; a smaller file, or the file split on their computer, works`
    : `'${name}' is larger than ${mb} MB, too large to work on here`
}

export const BUSY_TEXT = 'the server is working on other large files right now, so nothing was done; try the same call again in a minute'

/** Bytes held in this process by calls at once: at most budget(); queueMax calls wait in line, the next is refused. */
export class ByteGate {
  private used = 0
  private waiting: { n: number; go: () => void }[] = []
  constructor(private budget: () => number, private queueMax: number) {}

  /** Reserve `bytes` (at most the whole budget) before reading them; call the release once they are dropped. */
  async enter(bytes: number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    const n = Math.max(0, Math.min(bytes, this.budget()))
    if (this.waiting.length || this.used + n > this.budget()) {
      if (this.waiting.length >= this.queueMax) throw new ToolError(BUSY_TEXT, 'busy')
      await new Promise<void>((resolve, reject) => {
        const w = { n, go: () => { signal?.removeEventListener('abort', onAbort); resolve() } }
        const onAbort = () => { const i = this.waiting.indexOf(w); if (i >= 0) this.waiting.splice(i, 1); this.wake(); reject(signal!.reason) }
        signal?.addEventListener('abort', onAbort, { once: true })
        this.waiting.push(w)
      })
    } else this.used += n
    let done = false
    return () => {
      if (done) return
      done = true
      this.used -= n
      this.wake()
    }
  }

  /** the first in line goes whenever its bytes fit (in order: a large one is not passed by small ones forever) */
  private wake() {
    while (this.waiting.length && this.used + this.waiting[0]!.n <= this.budget()) {
      const w = this.waiting.shift()!
      this.used += w.n
      w.go()
    }
  }

  stats() { return { used: this.used, waiting: this.waiting.length } }
}

/** the most PDFs (and images) of one call together on this server: PDF_PAGES_INPUT_MAX, lower where the office worker
 * has less memory (a 1 GB converter budget: 85 MB, 512 MB: 42 MB) */
export const pdfInputMax = (budgetMiB = helperBudgetMiB(OFFICE_WORKER_RSS_MIB)) => inputMaxFor(budgetMiB, PDF_MIB_PER_MB, PDF_PAGES_INPUT_MAX)
/** the PDF tools' input bytes in this process at once (edit, merge, split and stamp_pdf): what the office workers
 * running at once can take; four more calls wait, the next is told the server is busy */
export const PDF_GATE = new ByteGate(() => officeWorkersMax() * pdfInputMax(), 4)

/** A guest keeps no file larger than they may upload (uploads/guest-limit.ts, the team's choice, 100 MB or 1 GB): a
 * new PDF the tools made for them is held to it too (second limits audit review). */
export function assertGuestOutput(db: Database, userId: string, bytes: number, name: string): void {
  const max = guestUploadMax(db, userId)
  if (max === null || bytes <= max) return
  throw new ToolError(`the new file '${name}' would be ${Math.ceil(bytes / MIB)} MB, and as a guest the user can keep files of at most ${sizeWords(max)}; nothing was saved. Work on fewer pages or smaller files at a time`, 'guest_file_too_large')
}
