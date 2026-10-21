// Scheduled tasks of the signed-in person (server/src/chat/schedules.ts). The AI creates them (schedule_create tool);
// the person sees, pauses and deletes them in Settings. Owner: B (server/src/routes/memories.ts).
import { z } from 'zod'
import { endpoint, empty } from './endpoint'

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
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastChatId: z.string().nullable(),
})
export type Schedule = z.infer<typeof Schedule>

export const SCHEDULES = {
  listSchedules: endpoint({ method: 'GET', path: '/api/schedules', auth: 'user', owner: 'B', response: z.object({ items: z.array(Schedule), timeZone: z.string() }), summary: 'Own scheduled tasks and the team time zone they run in.' }),
  updateSchedule: endpoint({ method: 'PATCH', path: '/api/schedules/:id', auth: 'user', owner: 'B', body: z.object({ enabled: z.boolean() }), response: Schedule, summary: 'Pause or resume one of the own scheduled tasks.' }),
  deleteSchedule: endpoint({ method: 'DELETE', path: '/api/schedules/:id', auth: 'user', owner: 'B', response: empty, status: 204, summary: 'Delete one of the own scheduled tasks.' }),
} as const
