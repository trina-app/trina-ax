// Route module "memories" — owner: component B (docs/WORKPLAN.md).
// Implements: MEMORIES (own memories only: list, add, correct, forget; admins can't see other people's, tab 1). Contract: shared/src/api/memories.ts
// Also SKILLS (the team skills the caller can read, for the composer's "/" list; what the team prepared for Home's
// first screen; skill suggestions). Contract:
// shared/src/api/skills.ts (the admin side of it, skill managers and changes, is in routes/admin.ts)
// And SCHEDULES (the caller's own scheduled tasks, Settings: run now, edit, pause, delete). Contract: shared/src/api/schedules.ts
import { API, type Locale } from '@mycel/shared/api'
import type { RouteModule } from './module'
import { fail } from '../http/errors'
import { getChatRuntime } from '../chat/runtime'
import { cleanMemoryText, MEMORY_ITEM_MAX } from '../chat/prompt'
import { tr } from '../chat/i18n'
import { newId } from '../db'
import { audit } from '../admin/audit'
import { decodeCursor, encodeCursor } from '../chat/store'
import { scanSkillsWithShadowed, skillInfo, skillIssues } from '../chat/skills'
import { teamRuleFiles } from '../chat/prompt'
import { popularSkills } from '../skills/popular'
import { teamPrepared } from '../skills/examples'
import { createFromTemplate, SCHEDULE_TEMPLATES } from '../chat/schedule-templates'
import { installNotifications } from '../notifications/service'
import { registerNotifications } from './notifications'
import { registerPush } from './push'
import { installPush } from '../notifications/push-service'
import { needsReview, type ScheduleRow } from '../chat/schedules'
import { awaitingReview, confirmReview, reviewCard } from '../chat/schedule-review'
import { editCard, saveTask, saveTemplate } from '../chat/schedule-edit'
import { approveSuggestion, contributeSkills, createSuggestion, getSuggestion, listSuggestions, rejectSuggestion, skillsOverview, CONTRIBUTE_BODY_MAX } from '../skills/suggestions'
import { suggestersOf } from '../skills/author'

type Row = { id: string; text: string; source_chat_id: string | null; created_at: string }

export const memoriesRoutes: RouteModule = {
  name: 'memories',
  owner: 'B',
  init(ctx) { installNotifications(ctx); installPush(ctx) },
  register(kit, ctx) {
    const rt = getChatRuntime(ctx)
    registerNotifications(kit, ctx)
    registerPush(kit, ctx)
    kit.handle(API.popularSkills, ({ auth }) => popularSkills(ctx.db, ctx.files, ctx.files.principal(auth.user.id)))
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
    // the person's own memories, with the AI's limits (prompt.ts cleanMemoryText). Kept as the person's (source
    // 'user'); the audit line has the id and the length, never the text (admins can't see memories, tab 1). Memories
    // keep no earlier versions, the AI's or the person's: a correction replaces the text.
    const memoryText = (raw: string, L: Locale): string => {
      const c = cleanMemoryText(raw)
      if (c.ok) return c.text
      const m = c.problem === 'empty' ? tr('memoryEmpty', L) : tr('memoryTooLong', L, { max: String(MEMORY_ITEM_MAX), n: String(c.length) })
      return fail('validation', m, { fields: { 'body.text': m } })
    }
    const memoryRow = (id: string) => ctx.db.query('SELECT id, text, source_chat_id, created_at FROM memories WHERE id = ?').get(id) as Row
    kit.handle(API.createMemory, ({ c, body, auth }) => {
      const text = memoryText(body.text, c.get('locale'))
      const id = newId()
      ctx.db.transaction(() => {
        ctx.db.query("INSERT INTO memories (id, user_id, text, source_chat_id, source, created_turn_id, created_at) VALUES (?,?,?,NULL,'user',NULL,?)").run(id, auth.user.id, text, new Date().toISOString())
        audit(ctx.db, { actor: auth.user.id, action: 'memory.create', target: id, detail: { chars: text.length } })
      })()
      const memory = rt.store.toMemory(memoryRow(id))
      rt.hub.publish(auth.user.id, { type: 'memory.changed', data: { change: 'created', memory } })
      return memory
    })
    kit.handle(API.updateMemory, ({ c, params, body, auth }) => {
      const text = memoryText(body.text, c.get('locale'))
      const changed = ctx.db.transaction(() => {
        const before = ctx.db.query('SELECT text FROM memories WHERE id = ? AND user_id = ?').get(params.id, auth.user.id) as { text: string } | null
        if (!before) return fail('not_found')
        if (before.text === text) return false
        ctx.db.query("UPDATE memories SET text = ?, source = 'user' WHERE id = ? AND user_id = ?").run(text, params.id, auth.user.id)
        audit(ctx.db, { actor: auth.user.id, action: 'memory.update', target: params.id, detail: { chars: text.length } })
        return true
      })()
      const memory = rt.store.toMemory(memoryRow(params.id))
      if (changed) rt.hub.publish(auth.user.id, { type: 'memory.changed', data: { change: 'updated', memory } })
      return memory
    })
    kit.handle(API.deleteMemory, ({ params, auth }) => {
      const r = ctx.db.query('DELETE FROM memories WHERE id = ? AND user_id = ?').run(params.id, auth.user.id)
      if (!r.changes) fail('not_found')
      audit(ctx.db, { actor: auth.user.id, action: 'memory.delete', target: params.id })
      rt.hub.publish(auth.user.id, { type: 'memory.changed', data: { change: 'deleted', memory: null } })
    })
    kit.handle(API.clearMemories, ({ auth }) => {
      const r = ctx.db.query('DELETE FROM memories WHERE user_id = ?').run(auth.user.id)
      if (r.changes) audit(ctx.db, { actor: auth.user.id, action: 'memory.clear', target: null, detail: { count: r.changes } })
      rt.hub.publish(auth.user.id, { type: 'memory.changed', data: { change: 'cleared', memory: null } })
    })
    const scheduleOut = (s: ScheduleRow) => ({ id: s.id, title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.time, weekday: s.weekday, day: s.day, date: s.date,
      projectId: s.project_id, enabled: !!s.enabled, resumeBlockedReason: rt.schedules.resumeBlockedReason(s), nextRunAt: s.next_run_at, lastRunAt: s.last_run_at, lastChatId: s.last_chat_id,
      templateId: s.template_id, templateVersion: s.template_version, sourcePath: s.template_source_path, outputPath: s.template_output_path,
      pendingDueAt: s.pending_due_at, retryAt: s.retry_at, deferredCount: s.deferred_count, ...lastOf(s),
      needsReview: needsReview(s), reviewSince: s.review_since })
    /** the last run's result, and for a run that needed the owner's own key for a template, which one */
    function lastOf(s: ScheduleRow) {
      const lastOutcome = rt.schedules.lastOutcome(s.user_id, s.id)
      return { lastOutcome, lastNeed: lastOutcome === 'needs_key' ? rt.schedules.lastNeed(s.user_id, s.id) : null }
    }
    kit.handle(API.listScheduleTemplates, () => ({ items: [...SCHEDULE_TEMPLATES], timeZone: rt.timeZone }))
    kit.handle(API.createScheduleFromTemplate, ({ auth, body }) => scheduleOut(createFromTemplate(ctx, rt, auth.user.id, body)))
    kit.handle(API.listSchedules, ({ auth }) => ({ items: rt.schedules.list(auth.user.id).map(scheduleOut), timeZone: rt.timeZone }))
    kit.handle(API.updateSchedule, ({ c, params, body, auth }) => {
      const s = rt.schedules.setEnabled(auth.user.id, params.id, body.enabled, new Date(), c.get('locale'))
      if (!s) return fail('not_found')
      return scheduleOut(s)
    })
    // "지금 실행" and "수정" (chat/schedules.ts runNow, chat/schedule-edit.ts): the rules of a scheduled run, the card of
    // schedule_create
    kit.handle(API.runScheduleNow, ({ c, params, auth }) => {
      const r = rt.schedules.runNow(auth.user.id, params.id, new Date(), c.get('locale'))
      return { schedule: scheduleOut(r.row), chatId: r.chatId }
    })
    kit.handle(API.scheduleEditCard, ({ c, params, body, auth }) => editCard(ctx, rt, auth.user.id, params.id, body, c.get('locale')))
    kit.handle(API.editSchedule, ({ c, params, body, auth }) => scheduleOut(body.kind === 'task'
      ? saveTask(ctx, rt, auth.user.id, params.id, body, c.get('locale'))
      : saveTemplate(ctx, rt, auth.user.id, params.id, body, c.get('locale'))))
    kit.handle(API.deleteSchedule, ({ params, auth }) => {
      if (!rt.schedules.delete(auth.user.id, params.id)) fail('not_found')
    })
    // "다시 확인": a task nobody confirmed shows its schedule card again (chat/schedule-review.ts)
    kit.handle(API.getScheduleReview, ({ c, params, auth }) => reviewCard(ctx, rt, auth.user.id, params.id, c.get('locale')))
    kit.handle(API.confirmScheduleReview, ({ c, params, body, auth }) => scheduleOut(confirmReview(ctx, rt, auth.user.id, params.id, body, c.get('locale'))))
    kit.handle(API.listSchedulesAwaitingReview, () => awaitingReview(ctx))
    kit.handle(API.listSkills, ({ auth, query }) => {
      let p
      try { p = ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      const { skills: items, shadowed, replaces } = scanSkillsWithShadowed(ctx.files, p)
      const lost = query?.shadowed ? shadowed : []
      // a skill a member suggested keeps their name ("민준 님이 제안", docs/DECISIONS.md "MC")
      const by = suggestersOf(ctx.db, [...items, ...lost.map((l) => l.skill)].map((s) => s.path).filter((x) => !x.startsWith('users/')))
      const one = (s: (typeof items)[number], extra: object = {}) => { const i = skillInfo(s); const who = by.get(s.path); const r = replaces.get(s.path); return { ...i, ...(who ? { suggestedBy: who } : {}), ...(r ? { replaces: r } : {}), ...extra } }
      return { items: [...items.map((s) => one(s)), ...lost.map((l) => one(l.skill, { shadowedBy: l.by.tier === 'personal' ? { tier: 'personal' } : { tier: 'group', group: { id: l.by.group.id, name: l.by.group.name } } }))] }
    })
    // Home's "팀에 준비된 것" (docs/DECISIONS.md "W6.3"): what the team prepared, read as the caller (skills/examples.ts)
    kit.handle(API.skillExamples, ({ c, auth }) => {
      try { ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      return teamPrepared(ctx, auth.user.id, c.get('locale'))
    })
    // R2-SKILL-03: the entries that do not load, so the skills and files screens can warn (readable entries only)
    kit.handle(API.listSkillIssues, ({ auth }) => {
      let p
      try { p = ctx.files.principal(auth.user.id) } catch { return fail('forbidden') }
      return { items: skillIssues(ctx.files, p, { rules: teamRuleFiles(ctx.files, p) }) }
    })
    // "스킬로 제안" → [등록] / [거절] (skills/suggestions.ts): the suggester and the managers of the target folder only
    kit.handle(API.skillsOverview, ({ auth }) => skillsOverview(ctx, auth.user.id))
    kit.handle(API.listSkillSuggestions, ({ query, auth }) => listSuggestions(ctx, auth.user.id, query))
    kit.handle(API.getSkillSuggestion, ({ params, auth }) => getSuggestion(ctx, auth.user.id, params.id))
    kit.handle(API.createSkillSuggestion, ({ c, body, auth }) => createSuggestion(ctx, auth.user.id, body, c.get('locale')))
    // members contribute: skill folders from their own computer as one batch (docs/DECISIONS.md "MC")
    kit.handle(API.contributeSkills, ({ c, body, auth }) => contributeSkills(ctx, auth.user.id, body, c.get('locale')), { jsonLimit: CONTRIBUTE_BODY_MAX })
    kit.handle(API.approveSkillSuggestion, ({ c, params, body, auth }) => approveSuggestion(ctx, auth.user.id, params.id, body, c.get('locale')))
    kit.handle(API.rejectSkillSuggestion, ({ c, params, body, auth }) => rejectSuggestion(ctx, auth.user.id, params.id, body.note, c.get('locale')))
  },
}
