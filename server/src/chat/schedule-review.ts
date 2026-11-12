// "다시 확인" (check again) for a free-text scheduled task nobody confirmed on its card (docs/DECISIONS.md "Scheduled
// tasks nobody confirmed"). Such a task never runs (chat/schedules.ts needsReview); its owner sees the same server card
// the AI's schedule_create raises (tools/schedules.ts scheduleCard: title, schedule, the whole instruction, its
// addresses with long random-looking parts marked, the "allow" team connections its title or instruction names that a
// run could send to: tools/schedules.ts taskConnections) and resumes it from there. Resuming is the confirmation the
// task never had: only the addresses that card showed open without asking in its runs, and only the connections the
// person picked may be written to. The answer is bound to the card's content (requestId): when something it showed
// changed in between (a connection it names turned to "allow"), the answer is refused and the card is shown again.
// The same "다시 확인" answers a task whose save folder lapsed (chat/schedule-scope.ts: moved, renamed, deleted, its
// rules changed, the owner's write access gone): its card shows the folder as it is now, with how many can read it, and
// "다시 허용" keeps saving there; until then runs save in the owner's own folder.
import crypto from 'node:crypto'
import type { Locale, ScheduleReviewCard } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import type { AppContext } from '../context'
import { HttpError } from '../http/errors'
import { ToolError } from '../policy/errors'
import { tr } from './i18n'
import type { ChatRuntime } from './runtime'
import { needsReview, nextRun, type ScheduleRow } from './schedules'
import { scopeColumns, type SaveLapse } from './schedule-scope'
import { egressOf } from '../tools/egress'
import { cardScope, scheduleCard, scheduleOptions, scopeBinding, taskConnections, taskScope, writableConnections } from '../tools/schedules'

/** The task's save scope as its card shows it now; for a task nobody confirmed, a folder that cannot be one is left out
 * (it was never allowed), for a lapsed one it is refused (there is nothing to allow again). */
function scopeNow(ctx: AppContext, s: ScheduleRow, L: Locale, strict: boolean) {
  try { return taskScope(ctx, s) } catch (e) {
    if (!(e instanceof ToolError)) throw e
    if (strict) throw new HttpError('conflict', tr('scheduleSaveGone', L), { params: { reason: 'schedule_save_gone' } })
    return taskScope(ctx, s, { folder: null })
  }
}

/** Is this the check of a lapsed save folder (a confirmed task), not the review of an unconfirmed one? */
const recheck = (s: ScheduleRow) => !needsReview(s) && !!s.save_folder && !!s.save_lapsed_at

function build(ctx: AppContext, s: ScheduleRow, L: Locale) {
  const input = { title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.time, weekday: s.weekday ?? undefined, day: s.day ?? undefined, date: s.date ?? undefined }
  const again = recheck(s)
  // only the connections the task names (never every "allow" connection the person can use); nobody ever allowed it any
  // (a lapse's check keeps the connections as they are: it is about the save folder only)
  const writable = again ? [] : taskConnections(writableConnections(ctx, s.user_id), input)
  const scope = scopeNow(ctx, s, L, again)
  // what a run can open on this server now (tools/egress.ts): the card promises nothing it cannot keep
  const card = scheduleCard(input, writable.map((r) => r.name), L, again ? 'recheck' : 'review', { urlsOpen: egressOf(ctx).known, scope: cardScope(ctx.db, s.user_id, L, scope.save, scope.sources, again ? [] : scope.sends), why: (s.save_lapse_reason as SaveLapse | null) ?? 'folder' })
  const options = scheduleOptions(L, writable.length > 0 || (!again && scope.sends.length > 0), again ? 'recheck' : 'review')
  // what the answer approves: the task as it is, the connections offered and the save scope (not the wording, which
  // follows the language)
  const requestId = (again ? 'schedule-recheck-' : 'schedule-review-') + crypto.createHash('sha256').update(JSON.stringify({
    id: s.id, title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.time, weekday: s.weekday, day: s.day, date: s.date, project: s.project_id,
    urls: card.urls, connections: writable.map((r) => `${r.id}:${r.version}`).sort(), options: options.map((o) => o.value), scope: scopeBinding(scope),
  })).digest('hex').slice(0, 48)
  return { card, options, requestId, writable, scope, again }
}

function waiting(rt: ChatRuntime, userId: string, id: string): ScheduleRow {
  const s = rt.schedules.get(userId, id)
  if (!s) throw new HttpError('not_found')
  return s
}

/** GET /api/schedules/:id/review: the card, for an own task that needs it: nobody confirmed it, or its save folder
 * lapsed (409 schedule_not_waiting otherwise). */
export function reviewCard(ctx: AppContext, rt: ChatRuntime, userId: string, id: string, L: Locale): ScheduleReviewCard {
  const s = waiting(rt, userId, id)
  if (!needsReview(s) && !recheck(s)) throw new HttpError('conflict', undefined, { params: { reason: 'schedule_not_waiting' } })
  const { card, options, requestId } = build(ctx, s, L)
  return { request: { kind: 'ask_user', origin: 'server', requestId, question: card.question, options, multiple: false, allowText: false, ...(card.extra.details?.length ? { details: card.extra.details } : {}) } }
}

/** POST /api/schedules/:id/review: one of the card's own answers. "resume": confirmed now, on again from the next due
 * time with the addresses, connections and save scope the card showed; "keep": nothing changes. For a lapsed save
 * folder: "resave" allows it again as it is now; "keep" leaves runs saving in the own folder. */
export function confirmReview(ctx: AppContext, rt: ChatRuntime, userId: string, id: string, body: { requestId: string; answer: string }, L: Locale, now = new Date()): ScheduleRow {
  const s = waiting(rt, userId, id)
  // already confirmed (another window): nothing to do
  if (!needsReview(s) && !recheck(s)) return s
  const { card, options, requestId, writable, scope, again } = build(ctx, s, L)
  // a card that no longer matches first (its answers may have changed with it), then only its own answers
  if (body.requestId !== requestId) throw new HttpError('conflict', tr('scheduleCardChanged', L), { params: { reason: 'schedule_card_changed' } })
  if (!options.some((o) => o.value === body.answer)) throw new HttpError('validation', tr('answerNotOption', L))
  if (body.answer === 'keep') return s
  if (again) {
    const cols = scopeColumns(scope.save, scope.sources, [])
    ctx.db.transaction(() => {
      ctx.db.query(`UPDATE schedules SET save_folder=?, save_folder_id=?, save_rule=?, save_readers=?, save_sources=?, save_lapsed_at=NULL, save_lapse_reason=NULL
        WHERE id=? AND user_id=? AND save_lapsed_at IS NOT NULL`).run(cols.save_folder, cols.save_folder_id, cols.save_rule, cols.save_readers, cols.save_sources, s.id, userId)
      audit(ctx.db, { actor: userId, action: 'schedule.save_reconfirmed', target: s.id, detail: { reason: s.save_lapse_reason } })
    })()
    return rt.schedules.get(userId, id)!
  }
  const blocked = rt.schedules.resumeBlockedReason({ ...s, enabled: 0 }, now)
  if (blocked) throw new HttpError('conflict', tr(blocked === 'completed' ? 'scheduleCompleted' : 'scheduleExpired', L), { params: { reason: `schedule_${blocked}` } })
  const next = nextRun(s, now, rt.timeZone)
  const connections = body.answer === 'resume_write' ? writable.map((r) => r.id) : []
  const cols = scopeColumns(scope.save, scope.sources, body.answer === 'resume_write' ? scope.sends.map((x) => ({ connectionId: x.connectionId, pins: x.pins })) : [])
  ctx.db.transaction(() => {
    ctx.db.query(`UPDATE schedules SET confirmed_at=?, review_since=NULL, allowed_urls=?, write_connections=?, enabled=?, next_run_at=?, pending_due_at=NULL, retry_at=NULL,
      save_folder=?, save_folder_id=?, save_rule=?, save_readers=?, save_sources=?, personal_sends=?, save_lapsed_at=NULL, save_lapse_reason=NULL
      WHERE id=? AND user_id=? AND confirmed_at IS NULL`).run(now.toISOString(), card.urls.length ? JSON.stringify(card.urls) : null, connections.length ? JSON.stringify(connections) : null,
      next ? 1 : 0, next?.toISOString() ?? null, cols.save_folder, cols.save_folder_id, cols.save_rule, cols.save_readers, cols.save_sources, cols.personal_sends, s.id, userId)
    audit(ctx.db, { actor: userId, action: 'schedule.reconfirmed', target: s.id, detail: { urls: card.urls.length, connections: connections.length } })
  })()
  return rt.schedules.get(userId, id)!
}

/** GET /api/admin/schedule-reviews: tasks paused until their owners confirm them again. No title, no instruction. */
export function awaitingReview(ctx: AppContext) {
  const rows = ctx.db.query(`SELECT s.id, s.repeat, s.time, s.weekday, s.day, s.date, s.review_since, u.id AS user_id, u.name AS user_name
    FROM schedules s JOIN users u ON u.id = s.user_id
    WHERE s.template_id IS NULL AND s.confirmed_at IS NULL AND s.review_since IS NOT NULL AND u.deleted_at IS NULL
    ORDER BY s.review_since, u.name, s.id LIMIT 500`).all() as { id: string; repeat: ScheduleRow['repeat']; time: string; weekday: number | null; day: number | null; date: string | null; review_since: string | null; user_id: string; user_name: string }[]
  return { items: rows.map((r) => ({ id: r.id, user: { id: r.user_id, name: r.user_name }, repeat: r.repeat, time: r.time, weekday: r.weekday, day: r.day, date: r.date, reviewSince: r.review_since })) }
}
