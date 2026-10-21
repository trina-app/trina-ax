// The AI's tools for the person's scheduled tasks (server/src/chat/schedules.ts): schedule_create, schedule_list,
// schedule_delete. Only the person's own schedules; a schedule made inside a project chat runs in that project; a
// scheduled run itself can't make new schedules (no task that multiplies itself).
import { z } from 'zod'
import type { AppContext } from '../context'
import type { ToolCtx } from '../files/service'
import { ToolError } from '../policy/errors'
import { getChatRuntime } from '../chat/runtime'
import { describeSchedule, ScheduleInput, zonedParts, type ScheduleRow } from '../chat/schedules'
import type { ToolRegistry } from './registry'

export const SCHEDULE_TOOL_NAMES = ['schedule_create', 'schedule_list', 'schedule_delete'] as const

const CreateInput = z.object({
  title: z.string().max(80).describe('Short name, e.g. "Weekly meeting digest"'),
  prompt: z.string().max(4000).describe('The full instruction to run each time, written so it works without this conversation (name the folders and the output)'),
  repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'monthly']),
  time: z.string().describe('HH:MM, 24-hour, in the team\'s time zone'),
  weekday: z.number().int().min(0).max(6).optional().describe('weekly: 0 = Sunday … 6 = Saturday'),
  day: z.number().int().min(1).max(28).optional().describe('monthly: 1–28'),
  date: z.string().optional().describe('once: YYYY-MM-DD'),
})

function turnInfo(ctx: AppContext, t: ToolCtx): { projectId: string | null; scheduled: boolean } {
  if (!t.turnId) return { projectId: null, scheduled: false }
  const r = ctx.db.query('SELECT c.project_id, t.client_kind FROM turns t JOIN chats c ON c.id = t.chat_id WHERE t.id = ?').get(t.turnId) as { project_id: string | null; client_kind: string | null } | null
  return { projectId: r?.project_id ?? null, scheduled: r?.client_kind === 'schedule' }
}

export function registerScheduleTools(ctx: AppContext, reg: ToolRegistry) {
  const rt = getChatRuntime(ctx)
  const local = (iso: string | null) => {
    if (!iso) return 'not scheduled'
    const p = zonedParts(new Date(iso), rt.timeZone)
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')} (${rt.timeZone})`
  }
  const line = (s: ScheduleRow) => `- ${s.id}: "${s.title}", ${describeSchedule(s)}${s.enabled ? `, next ${local(s.next_run_at)}` : ', off'}${s.last_run_at ? `, last ran ${local(s.last_run_at)}` : ''}\n  prompt: ${s.prompt.replace(/\s+/g, ' ').slice(0, 200)}`

  reg.register({
    name: 'schedule_create',
    description: 'Create a scheduled task for the user: the server sends `prompt` for them on the schedule, each run in a new chat with their access (they see it in their chat list). ' +
      'Use it when the user asks for something recurring or later ("every Monday at 9…", "tomorrow at 8…"). Confirm the schedule back in plain words. ' +
      'Runs are unattended (no questions, nothing that needs a confirmation), so write the prompt to work on its own.',
    input: CreateInput,
    describe: (a) => `schedule_create ${a.repeat} ${a.time}`,
    run(a, t) {
      const info = turnInfo(ctx, t)
      if (info.scheduled) throw new ToolError('a scheduled run cannot create scheduled tasks')
      const parsed = ScheduleInput.safeParse({ ...a, projectId: info.projectId ?? undefined })
      if (!parsed.success) throw new ToolError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
      const s = rt.schedules.create(t.user.id, parsed.data)
      return { text: `Scheduled "${s.title}": ${describeSchedule(s)}. First run: ${local(s.next_run_at)}. Id ${s.id}. The user can turn it off in Settings › Scheduled tasks.`, summary: `schedule_create ${s.id} ${s.repeat} ${s.time}`, structured: { id: s.id, nextRunAt: s.next_run_at } }
    },
  })
  reg.register({
    name: 'schedule_list',
    description: 'List the user\'s scheduled tasks (id, schedule, next run, prompt).',
    input: z.object({}),
    run(_a, t) {
      const all = rt.schedules.list(t.user.id)
      return { text: all.length ? all.map(line).join('\n') : 'The user has no scheduled tasks.', summary: `schedule_list -> ${all.length}` }
    },
  })
  reg.register({
    name: 'schedule_delete',
    description: 'Delete one of the user\'s scheduled tasks by id (from schedule_list). Ask first unless the user clearly asked to delete it.',
    input: z.object({ id: z.string().min(1).max(64) }),
    describe: (a) => `schedule_delete ${a.id}`,
    run(a, t) {
      if (!rt.schedules.delete(t.user.id, a.id)) throw new ToolError(`no scheduled task ${a.id} of this user`)
      return { text: `Deleted scheduled task ${a.id}.`, summary: `schedule_delete ${a.id}` }
    },
  })
}
