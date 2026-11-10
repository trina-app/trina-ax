// "수정" (edit) in Settings › Scheduled tasks (docs/DECISIONS.md "Scheduled tasks: run now, edit, pause"). A free-text
// task changes only through the same checks and the same server card as when the AI makes one (tools/schedules.ts
// schedule_create): the fields as ScheduleInput takes them, a time still to come, a project the person can open, then
// the schedule card for the task as it will run (title, schedule, project, the whole instruction, its addresses with
// long random-looking parts marked, an address with a long query listed apart as one runs never open, the "allow"
// team connections the edited task names or may already send to: tools/schedules.ts taskConnections). Saving is the
// answer to that card, bound to exactly what it showed (requestId): what the card showed becomes the task's record
// (allowed_urls, write_connections, confirmed_at), as at creation. An edit keeps the task on or paused as it was. A
// template changes its time and folders only, checked like at creation (no card: its instruction is the template's).
// Audited with what changed, never the title or the instruction.
import crypto from 'node:crypto'
import type { Locale, ScheduleReviewCard, ScheduleTaskEdit, ScheduleTemplateEdit } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import type { AppContext } from '../context'
import { HttpError } from '../http/errors'
import { tr } from './i18n'
import type { ChatRuntime } from './runtime'
import { needsReview, nextRun, ScheduleInput, scheduleList, type ScheduleRow } from './schedules'
import { templatePrompt, templateTitle, validateTemplateFolders } from './schedule-templates'
import { egressOf } from '../tools/egress'
import { scheduleCard, scheduleOptions, taskConnections, writableConnections } from '../tools/schedules'

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function own(rt: ChatRuntime, userId: string, id: string): ScheduleRow {
  const s = rt.schedules.get(userId, id)
  if (!s) throw new HttpError('not_found')
  return s
}

/** The edit as schedule_create would take it, or a refusal with the fields to look at (in the person's language). */
function checked(ctx: AppContext, rt: ChatRuntime, userId: string, s: ScheduleRow, e: ScheduleTaskEdit, L: Locale, now: Date) {
  if (s.template_id) throw new HttpError('conflict', tr('scheduleKind', L), { params: { reason: 'schedule_template' } })
  // only the field the repeat uses is kept (a weekly task carries no day of the month)
  const parsed = ScheduleInput.safeParse({
    title: e.title, prompt: e.prompt, repeat: e.repeat, time: e.time,
    weekday: e.repeat === 'weekly' ? e.weekday ?? undefined : undefined,
    day: e.repeat === 'monthly' ? e.day ?? undefined : undefined,
    date: e.repeat === 'once' ? e.date ?? undefined : undefined,
  })
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((i) => [`body.${String(i.path[0] ?? '')}`, tr('scheduleField', L)]))
    throw new HttpError('validation', tr('scheduleInvalid', L), { fields })
  }
  const input = parsed.data
  let project: { id: string; name: string } | null = null
  if (e.projectId) {
    const p = rt.projectForChat(e.projectId, ctx.files.principal(userId))
    if (!p) throw new HttpError('validation', tr('scheduleProject', L), { fields: { 'body.projectId': tr('scheduleProject', L) } })
    project = { id: e.projectId, name: p.name }
  }
  const next = nextRun({ repeat: input.repeat, time: input.time, weekday: input.weekday ?? null, day: input.day ?? null, date: input.date ?? null }, now, rt.timeZone)
  if (!next) throw new HttpError('validation', tr('schedulePast', L), { fields: { 'body.date': tr('schedulePast', L), 'body.time': tr('schedulePast', L) } })
  // the connections the edited task names, and the ones it may send to now (an edit of the time keeps them on offer);
  // never every "allow" connection the person can use
  const writable = taskConnections(writableConnections(ctx, userId), input, new Set(scheduleList(s.write_connections)))
  // what a run can open on this server now (tools/egress.ts): the card promises nothing it cannot keep
  const card = scheduleCard(input, writable.map((r) => r.name), L, 'edit', { urlsOpen: egressOf(ctx).known, project: project?.name ?? null })
  const options = scheduleOptions(L, writable.length > 0, 'edit')
  // what the answer approves: the task as it will be and the connections offered (not the wording)
  const requestId = 'schedule-edit-' + crypto.createHash('sha256').update(JSON.stringify({
    id: s.id, title: input.title, prompt: input.prompt, repeat: input.repeat, time: input.time, weekday: input.weekday ?? null, day: input.day ?? null, date: input.date ?? null,
    project: project?.id ?? null, urls: card.urls, connections: writable.map((r) => `${r.id}:${r.version}`).sort(), options: options.map((o) => o.value),
  })).digest('hex').slice(0, 48)
  return { input, project, next, writable, card, options, requestId }
}

/** POST /api/schedules/:id/edit: the card for the edited task. Nothing changes yet. */
export function editCard(ctx: AppContext, rt: ChatRuntime, userId: string, id: string, e: ScheduleTaskEdit, L: Locale, now = new Date()): ScheduleReviewCard {
  const { card, options, requestId } = checked(ctx, rt, userId, own(rt, userId, id), e, L, now)
  return { request: { kind: 'ask_user', origin: 'server', requestId, question: card.question, options, multiple: false, allowText: false, ...(card.extra.details?.length ? { details: card.extra.details } : {}) } }
}

/** PUT /api/schedules/:id with a free-text task: the card's answer. "save" / "save_write": changed and confirmed now
 * with what the card showed; "cancel": nothing changes. */
export function saveTask(ctx: AppContext, rt: ChatRuntime, userId: string, id: string, e: ScheduleTaskEdit & { requestId: string; answer: string }, L: Locale, now = new Date()): ScheduleRow {
  const s = own(rt, userId, id)
  const { input, project, next, writable, card, options, requestId } = checked(ctx, rt, userId, s, e, L, now)
  // a card that no longer matches first (its answers may have changed with it), then only its own answers
  if (e.requestId !== requestId) throw new HttpError('conflict', tr('scheduleCardChanged', L), { params: { reason: 'schedule_card_changed' } })
  if (!options.some((o) => o.value === e.answer)) throw new HttpError('validation', tr('answerNotOption', L))
  if (e.answer === 'cancel') return s
  const connections = e.answer === 'save_write' ? writable.map((r) => r.id) : []
  const after = { title: input.title, prompt: input.prompt, repeat: input.repeat, time: input.time, weekday: input.weekday ?? null, day: input.day ?? null, date: input.date ?? null }
  const changed = [
    ...(after.title !== s.title ? ['title'] : []), ...(after.prompt !== s.prompt ? ['prompt'] : []),
    ...(after.repeat !== s.repeat || after.time !== s.time || after.weekday !== s.weekday || after.day !== s.day || after.date !== s.date ? ['schedule'] : []),
    ...((project?.id ?? null) !== s.project_id ? ['project'] : []),
  ]
  // a one-time task given a new time is a new occurrence: it can be turned on again (resumeBlockedReason)
  const rearm = after.repeat === 'once' && changed.includes('schedule')
  const on = !!s.enabled
  ctx.db.transaction(() => {
    ctx.db.query(`UPDATE schedules SET title=?, prompt=?, repeat=?, time=?, weekday=?, day=?, date=?, project_id=?, allowed_urls=?, write_connections=?, confirmed_at=?,
      review_since=NULL, enabled=?, next_run_at=?, pending_due_at=NULL, retry_at=NULL, last_run_at=CASE WHEN ? THEN NULL ELSE last_run_at END WHERE id=? AND user_id=?`)
      .run(after.title, after.prompt, after.repeat, after.time, after.weekday, after.day, after.date, project?.id ?? null,
        card.urls.length ? JSON.stringify(card.urls) : null, connections.length ? JSON.stringify(connections) : null, now.toISOString(),
        on ? 1 : 0, on ? next!.toISOString() : null, rearm ? 1 : 0, s.id, userId)
    audit(ctx.db, { actor: userId, action: 'schedule.edited', target: s.id, detail: { changed, urls: card.urls.length, connections: connections.length, enabled: on, ...(needsReview(s) ? { wasUnconfirmed: true } : {}) } })
  })()
  return rt.schedules.get(userId, id)!
}

/** PUT /api/schedules/:id with a template: a new time (and weekday) and folders, checked like at creation. */
export function saveTemplate(ctx: AppContext, rt: ChatRuntime, userId: string, id: string, e: ScheduleTemplateEdit, L: Locale, now = new Date()): ScheduleRow {
  const s = own(rt, userId, id)
  if (!s.template_id) throw new HttpError('conflict', tr('scheduleKind', L), { params: { reason: 'schedule_not_template' } })
  const weekly = s.repeat === 'weekly'
  const bad: Record<string, string> = {}
  if (!TIME.test(e.time)) bad['body.time'] = tr('scheduleField', L)
  if (weekly && (e.weekday === null || e.weekday === undefined)) bad['body.weekday'] = tr('scheduleField', L)
  if (Object.keys(bad).length) throw new HttpError('validation', tr('scheduleInvalid', L), { fields: bad })
  // the source the person can read, the output inside their own folder (else not_found, as at creation)
  const scope = validateTemplateFolders(ctx, userId, e.sourcePath, e.outputPath)
  const weekday = weekly ? e.weekday! : null
  const next = s.enabled ? nextRun({ repeat: s.repeat, time: e.time, weekday, day: null, date: null }, now, rt.timeZone) : null
  const changed = [
    ...(e.time !== s.time || weekday !== s.weekday ? ['schedule'] : []),
    ...(scope.sourcePath !== s.template_source_path ? ['source'] : []), ...(scope.outputPath !== s.template_output_path ? ['output'] : []),
  ]
  // name and instruction again in the person's language (a template made before it followed the language, or since changed)
  const lang = rt.userLocale(userId)
  ctx.db.transaction(() => {
    ctx.db.query(`UPDATE schedules SET title=?, time=?, weekday=?, prompt=?, template_source_path=?, template_output_path=?, next_run_at=?, enabled=?, pending_due_at=NULL, retry_at=NULL
      WHERE id=? AND user_id=?`).run(templateTitle(s.template_id!, lang), e.time, weekday, templatePrompt(s.template_id!, { sourcePath: scope.sourcePath, outputPath: scope.outputPath }, lang), scope.sourcePath, scope.outputPath,
      next?.toISOString() ?? null, s.enabled && next ? 1 : 0, s.id, userId)
    audit(ctx.db, { actor: userId, action: 'schedule.edited', target: s.id, detail: { changed, template: s.template_id, enabled: !!s.enabled } })
  })()
  return rt.schedules.get(userId, id)!
}
