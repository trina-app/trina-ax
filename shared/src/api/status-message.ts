// A person's status message (docs/DECISIONS.md "상태 메시지"): an emoji, a short text and when it clears, modelled on
// the common pattern of team chat apps. Owner: A (server/src/routes/people.ts). Apart from people.ts so that auth.ts (Me) can use it without
// a cycle (people.ts reads auth.ts).
import { z } from 'zod'
import { isCalendarDay, isStatusEmoji, STATUS_TEXT_MAX, statusTextOk } from '../status-message'
import { IsoTime } from './common'

// The rules are shared/src/status-message.ts (the web's dialog checks the same).
/** When a status clears: never, after 30 minutes, 1 hour or 2 hours, at the end of today or of this week (Sunday), or
 * on chosen days (a start and a last day). The ends of days are the team's (its time zone), never the server's. */
export const StatusClear = z.enum(['never', '30m', '1h', '2h', 'today', 'week', 'dates'])
export type StatusClear = z.infer<typeof StatusClear>
/** "YYYY-MM-DD", a real calendar day */
export const StatusDay = z.string().refine(isCalendarDay, 'not a calendar day (YYYY-MM-DD)')
/** A status as the team sees it: only one that has started and not cleared yet. */
export const StatusMessage = z.object({
  emoji: z.string(),
  /** may be empty (an emoji alone) */
  text: z.string(),
  /** when it clears; absent: when its person clears it */
  until: IsoTime.optional(),
  /** it clears at the end of a day: that last day ("YYYY-MM-DD", the team's time zone), for "11/14까지" */
  untilDay: StatusDay.optional(),
})
export type StatusMessage = z.infer<typeof StatusMessage>
/** My own status (GET /api/me, PUT /api/me/status): also one whose first day is still to come. */
export const MyStatus = StatusMessage.extend({
  clear: StatusClear,
  /** it shows from a later day (a vacation that starts later): that first day; the team does not see it before */
  fromDay: StatusDay.optional(),
})
export type MyStatus = z.infer<typeof MyStatus>
/** PUT /api/me/status. `emoji` left out with a text: 💬 (STATUS_DEFAULT_EMOJI). `clear` 'keep': the end the status has now (editing only its
 * words); 'dates': `to` is the last day (required), `from` the first (default today). */
export const SetStatusBody = z.object({
  emoji: z.string().refine(isStatusEmoji, 'one emoji').optional(),
  text: z.string().trim().max(STATUS_TEXT_MAX).refine(statusTextOk, 'no control or invisible characters'),
  clear: z.union([StatusClear, z.literal('keep')]),
  from: StatusDay.optional(),
  to: StatusDay.optional(),
}).strict()
export type SetStatusBody = z.infer<typeof SetStatusBody>
