// The result shapes of srt runs (srt/runner.ts) that tool.ts and jobs.ts read.

/** The end of a foreground command. signal: timeout | oom | setting | stopped | "" (ended by itself). */
export interface RunExit {
  ev: 'exit'
  code: number
  signal: string
  stdout: string
  stderr: string
  truncated: boolean
  ms: number
}

/** A job or dev server as one poll of the runner sees it. code: null while it runs, and when no exit code is known.
 * tail: the end of the log, at most 4 KiB. why: what ended a run with no exit code. */
export interface RunJob {
  name: string
  state: 'running' | 'ended'
  code: number | null
  seconds: number
  tail: string
  lastLine: string
  why?: string
}
