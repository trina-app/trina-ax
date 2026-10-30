// The result of a scheduled run (docs/DECISIONS.md "Scheduled run outcome"). "The run ended" (turns.status) is not
// "the task worked": a run whose skill save was auto-refused (nobody can confirm in an unattended run) still ends
// 'done'. The turn stores one of three results in turns.run_outcome before its terminal status, so the inbox, the
// schedule list and the reconciler never see a terminal run without its result.
import type { ScheduleRunOutcome } from '@mycel/shared/api'

export type { ScheduleRunOutcome }

/**
 * failed   = the turn did not end 'done' (error, stopped, interrupted) or it gave no answer text;
 * problems = the answer finished, but at least one tool call was refused or failed (tool_events ok=0 or a step error),
 *            or it paused at a per-answer limit before the task was done (`limited`: someone should continue it);
 * succeeded otherwise.
 */
export function scheduleRunOutcome(o: { status: string; content: string; failedTools: number; limited?: boolean }): ScheduleRunOutcome {
  if (o.status !== 'done' || !o.content.trim()) return 'failed'
  return o.failedTools > 0 || o.limited ? 'problems' : 'succeeded'
}

/** The stored result, or for rows without one (older builds, interrupted recovery) the result implied by the status. */
export function storedRunOutcome(row: { status: string; run_outcome?: string | null }): ScheduleRunOutcome {
  if (row.run_outcome === 'succeeded' || row.run_outcome === 'problems' || row.run_outcome === 'failed') return row.run_outcome
  return row.status === 'done' ? 'succeeded' : 'failed'
}

/** Inbox event for a result: only a clean success is "success"; problems and failures need the person's attention. */
export function outcomeEvent(outcome: ScheduleRunOutcome): 'schedule.success' | 'schedule.failure' {
  return outcome === 'succeeded' ? 'schedule.success' : 'schedule.failure'
}
