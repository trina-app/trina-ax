// Scheduled tasks of the signed-in person (server/src/chat/schedules.ts). The AI creates them (schedule_create tool);
// the person sees, pauses and deletes them in Settings. Owner: B (server/src/routes/memories.ts).
import { z } from 'zod'
import { endpoint, empty } from './endpoint'
import { UserRef } from './entities'
import { AskUserRequest } from './ws'

/** Result of a scheduled run, separate from "the run ended" (server/src/chat/schedule-outcome.ts). */
export const ScheduleRunOutcome = z.enum(['succeeded', 'problems', 'failed'])
export type ScheduleRunOutcome = z.infer<typeof ScheduleRunOutcome>

export const Schedule = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'monthly']),
  time: z.string(),
  weekday: z.number().nullable(),
  day: z.number().nullable(),
  date: z.string().nullable(),
  projectId: z.string().nullable(),
  enabled: z.boolean(),
  resumeBlockedReason: z.enum(['completed', 'expired']).nullable().optional(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastChatId: z.string().nullable(),
  templateId: z.string().nullable().optional(), templateVersion: z.number().nullable().optional(),
  sourcePath: z.string().nullable().optional(), outputPath: z.string().nullable().optional(),
  pendingDueAt: z.string().nullable().optional(), retryAt: z.string().nullable().optional(), deferredCount: z.number().optional(),
  lastOutcome: z.enum(['done', 'problems', 'error', 'stopped', 'interrupted', 'budget_exceeded', 'user_unavailable']).nullable().optional(),
  /** a free-text task nobody confirmed on its card: paused, resumed only by confirming its card again ("다시 확인",
   * getScheduleReview / confirmScheduleReview); older servers omit it */
  needsReview: z.boolean().optional(),
  /** when the server paused it for that reason (null: off since before, or never paused for it) */
  reviewSince: z.string().nullable().optional(),
})
export type Schedule = z.infer<typeof Schedule>

/** The schedule card shown again for "다시 확인": the same server card as when the AI creates a task (title, schedule,
 * the whole instruction, its addresses with long random-looking parts marked, the "allow" connections). Its requestId
 * binds the answer to exactly this content: a change in between (connections) is refused and the card is shown anew. */
export const ScheduleReviewCard = z.object({ request: AskUserRequest })
export type ScheduleReviewCard = z.infer<typeof ScheduleReviewCard>
export const ConfirmScheduleReview = z.object({ requestId: z.string().min(1).max(200), answer: z.string().min(1).max(40) }).strict()

/** Admin view: a task waiting for its owner to confirm it again. Metadata only: never its title or instruction (the
 * person's own words, like their chats). */
export const ScheduleAwaitingReview = z.object({
  id: z.string(), user: UserRef, repeat: Schedule.shape.repeat, time: z.string(), weekday: z.number().nullable(), day: z.number().nullable(),
  date: z.string().nullable(), reviewSince: z.string().nullable(),
})
export type ScheduleAwaitingReview = z.infer<typeof ScheduleAwaitingReview>

export const ScheduleTemplateId = z.enum(['daily-file-index', 'weekly-summary'])
export const CreateScheduleFromTemplate = z.object({
  requestId: z.uuid(), templateId: ScheduleTemplateId, version: z.literal(1),
  sourcePath: z.string().min(1).max(1000), outputPath: z.string().min(1).max(1000),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), weekday: z.number().int().min(0).max(6).optional(),
}).strict().superRefine((s, c) => {
  if (s.templateId === 'weekly-summary' && s.weekday === undefined) c.addIssue({ code: 'custom', path: ['weekday'], message: 'weekly needs a weekday' })
})
export type CreateScheduleFromTemplate = z.infer<typeof CreateScheduleFromTemplate>
export const SCHEDULES = {
  listScheduleTemplates: endpoint({ method: 'GET', path: '/api/schedule-templates', auth: 'user', owner: 'B', response: z.object({ items: z.array(z.object({ id: ScheduleTemplateId, version: z.literal(1), repeat: z.enum(['daily', 'weekly']) })), timeZone: z.string() }), summary: 'Dormant templates; listing creates no scheduled work.' }),
  createScheduleFromTemplate: endpoint({ method: 'POST', path: '/api/schedule-templates', auth: 'user', owner: 'B', body: CreateScheduleFromTemplate, response: Schedule, summary: 'Explicitly create a private-output scheduled template, idempotent per user/request.' }),
  listSchedules: endpoint({ method: 'GET', path: '/api/schedules', auth: 'user', owner: 'B', response: z.object({ items: z.array(Schedule), timeZone: z.string() }), summary: 'Own scheduled tasks and the team time zone they run in.' }),
  updateSchedule: endpoint({ method: 'PATCH', path: '/api/schedules/:id', auth: 'user', owner: 'B', body: z.object({ enabled: z.boolean() }), response: Schedule, summary: 'Pause or resume one of the own scheduled tasks.' }),
  deleteSchedule: endpoint({ method: 'DELETE', path: '/api/schedules/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Delete one of the own scheduled tasks.' }),
  getScheduleReview: endpoint({ method: 'GET', path: '/api/schedules/:id/review', auth: 'user', owner: 'B', response: ScheduleReviewCard, summary: 'The schedule card of an own task nobody confirmed (needsReview), to check it again.' }),
  confirmScheduleReview: endpoint({ method: 'POST', path: '/api/schedules/:id/review', auth: 'user', owner: 'B', body: ConfirmScheduleReview, response: Schedule, summary: 'Answer that card with one of its options: resume (confirmed, runs again with the addresses and connections it showed) or keep it paused.' }),
  listSchedulesAwaitingReview: endpoint({ method: 'GET', path: '/api/admin/schedule-reviews', auth: 'admin', owner: 'B', response: z.object({ items: z.array(ScheduleAwaitingReview) }), summary: 'Scheduled tasks paused until their owners confirm them again (metadata only).' }),
} as const
