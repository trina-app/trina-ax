// Route module "memories" — owner: component B (docs/WORKPLAN.md).
// Implements: MEMORIES (own memories only; admins can't see other people's, tab 1). Contract: shared/src/api/memories.ts
// Also SKILLS (the team skills the caller can read, for the composer's "/" list). Contract: shared/src/api/skills.ts
// And SCHEDULES (the caller's own scheduled tasks, Settings). Contract: shared/src/api/schedules.ts
import { API } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { getChatRuntime } from '../chat/runtime'
import { decodeCursor, encodeCursor } from '../chat/store'
import { listSkills } from '../chat/skills'
import type { ScheduleRow } from '../chat/schedules'

type Row = { id: string; text: string; source_chat_id: string | null; created_at: string }

export const memoriesRoutes: RouteModule = {
  name: 'memories',
  owner: 'B',
  register(kit, ctx) {
    const rt = getChatRuntime(ctx)
    kit.handle(API.listMemories, ({ query, auth }) => {
      const limit = query.limit ?? 50
      const cur = decodeCursor(query.cursor, ['t', 'id'])
      if (query.cursor && !cur) fail('validation', undefined, { fields: { 'query.cursor': 'bad cursor' } })
      const rows = (cur
        ? ctx.db.query('SELECT id, text, source_chat_id, created_at FROM memories WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?').all(auth.user.id, cur.t, cur.t, cur.id, limit + 1)
        : ctx.db.query('SELECT id, text, source_chat_id, created_at FROM memories WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(auth.user.id, limit + 1)) as Row[]
      const items = rows.slice(0, limit)
      const last = items[items.length - 1]
      return { items: items.map((r) => rt.store.toMemory(r)), nextCursor: rows.length > limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null }
    })
    kit.handle(API.deleteMemory, ({ params, auth }) => {
      const r = ctx.db.query('DELETE FROM memories WHERE id = ? AND user_id = ?').run(params.id, auth.user.id)
      if (!r.changes) fail('not_found')
      rt.hub.publish(auth.user.id, { type: 'memory.changed', data: { change: 'deleted', memory: null } })
    })
    kit.handle(API.clearMemories, ({ auth }) => {
      ctx.db.query('DELETE FROM memories WHERE user_id = ?').run(auth.user.id)
      rt.hub.publish(auth.user.id, { type: 'memory.changed', data: { change: 'cleared', memory: null } })
    })
    const scheduleOut = (s: ScheduleRow) => ({ id: s.id, title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.time, weekday: s.weekday, day: s.day, date: s.date,
      projectId: s.project_id, enabled: !!s.enabled, nextRunAt: s.next_run_at, lastRunAt: s.last_run_at, lastChatId: s.last_chat_id })
    kit.handle(API.listSchedules, ({ auth }) => ({ items: rt.schedules.list(auth.user.id).map(scheduleOut), timeZone: rt.timeZone }))
    kit.handle(API.updateSchedule, ({ params, body, auth }) => {
      const s = rt.schedules.setEnabled(auth.user.id, params.id, body.enabled)
      if (!s) return fail('not_found')
      return scheduleOut(s)
    })
    kit.handle(API.deleteSchedule, ({ params, auth }) => {
      if (!rt.schedules.delete(auth.user.id, params.id)) fail('not_found')
    })
    kit.handle(API.listSkills, ({ auth }) => {
      let p
      try { p = ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      return { items: listSkills(ctx.files, p).map(({ path, name, description }) => ({ path, name, description })) }
    })
  },
}
