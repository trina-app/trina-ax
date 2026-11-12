// The result of a scheduled run (docs/DECISIONS.md "Scheduled run outcome"). "The run ended" (turns.status) is not
// "the task worked": a run whose skill save was auto-refused (nobody can confirm in an unattended run) still ends
// 'done'. The turn stores one of three results in turns.run_outcome before its terminal status, so the inbox, the
// schedule list and the reconciler never see a terminal run without its result.
import { READ_ONLY_TOOLS, REMOVED_READ_ONLY_TOOLS } from '@mycel/shared'
import type { ScheduleRunOutcome } from '@mycel/shared/api'

export type { ScheduleRunOutcome }

/** Tools that only look something up (docs/DECISIONS.md "Scheduled run: only what needs the person is a problem"):
 * the web app's quiet-mark set (shared READ_ONLY_TOOLS, removed search tools), the engine's web search, the reads of
 * team chat rooms, project chats and the schedule list, and the in-app browser's reading tools. A refused or failed
 * call of one changed nothing; a connection's call that only reads is told by the turn from its arguments. */
const LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS, ...REMOVED_READ_ONLY_TOOLS, 'WebSearch', 'web_search',
  'rooms', 'room_read', 'room_file', 'room_thread', 'project_chats', 'project_chat', 'schedule_list', 'find_tools',
  'read_page', 'get_page_text', 'find', 'tabs_context', 'read_console_messages', 'read_network_requests',
])
export const isLookUpTool = (tool: string | undefined | null): boolean => !!tool && LOOKUP_TOOLS.has(tool)

/**
 * failed   = the turn did not end 'done' (error, stopped, interrupted) or it gave no answer text;
 * problems = the answer finished, but a call that would change something (a save, a send, a post, a delete, a memory,
 *            a sub-task) was refused or failed (`failedTools`: the turn leaves out look-ups, isLookUpTool), or it paused
 *            at a per-answer limit before the task was done (`limited`: someone should continue it);
 * succeeded otherwise. A page that could not be opened, a search with nothing found, a file read that failed: the AI
 * worked past them, and nobody needs to act on them.
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
