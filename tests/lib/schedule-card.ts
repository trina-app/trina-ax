// A scheduled task the person approved on its card (server/src/chat/schedules.ts ScheduleApproval): a free-text task
// created without one never runs (docs/DECISIONS.md "Scheduled tasks nobody confirmed"). Tests that need a task to
// run create it with this, as the card would.
import type { ScheduleApproval } from '../../server/src/chat/schedules'

export const CONFIRMED: ScheduleApproval = { allowedUrls: [], writeConnections: [] }
