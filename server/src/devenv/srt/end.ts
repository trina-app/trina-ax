// How a dev environment run ends: the end reasons, what each says, and the hook that ends a row. A leaf module (it
// imports only types), so runner.ts and jobs.ts both read it fully whatever order a test or the server loads them in:
// jobs.ts sets the hook while it loads, and runner.ts and jobs.ts import each other through a long chain.

import type { AppContext } from '../../context'

export type EndReason = 'exit' | 'timeout' | 'oom' | 'stopped' | 'idle' | 'disk' | 'setting' | 'expired' | 'lost'

/** what each end reason says to people and to the AI */
export const END_NOTE: Record<EndReason, string> = {
  exit: '',
  timeout: 'stopped at its time limit',
  oom: 'stopped: it ran out of memory',
  stopped: 'stopped by a person',
  idle: 'stopped: unused',
  disk: 'stopped: the server disk is nearly full',
  setting: 'stopped: the dev environment setting, the allowed sites or the folder access of the person changed',
  expired: 'did not start: it waited for 24 hours',
  lost: 'the run ended with no exit code',
}

/** the hook that ends a row (jobs.ts sets it, to keep one place for notices) */
export type Ender = (ctx: AppContext, rowId: string, end: { code: number | null; reason: EndReason; tail: string; lastLine: string }) => void
let ender: Ender = (ctx, rowId, end) => {
  ctx.db.query("UPDATE dev_env_runs SET ended_at = ?, state = 'ended', exit_code = ?, end_note = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
    .run(new Date().toISOString(), end.code, END_NOTE[end.reason], end.reason, rowId)
}
export function setEnder(e: Ender) { ender = e }
/** ends a row through the hook */
export const endRow: Ender = (ctx, rowId, end) => ender(ctx, rowId, end)
