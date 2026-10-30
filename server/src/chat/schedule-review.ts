// "다시 확인" (check again) for a free-text scheduled task nobody confirmed on its card (docs/DECISIONS.md "Scheduled
// tasks nobody confirmed"). Such a task never runs (chat/schedules.ts needsReview); its owner sees the same server card
// the AI's schedule_create raises (tools/schedules.ts scheduleCard: title, schedule, the whole instruction, its
// addresses with long random-looking parts marked, the "allow" team connections a run could send to) and resumes it
// from there. Resuming is the confirmation the task never had: only the addresses that card showed open without asking
// in its runs, and only the connections the person picked may be written to. The answer is bound to the card's
// content (requestId): when something it showed changed in between (a connection turned to "allow"), the answer is
// refused and the card is shown again.
import crypto from 'node:crypto'
import type { Locale, ScheduleReviewCard } from '@mycel/shared/api'
import { audit } from '../admin/audit'
import type { AppContext } from '../context'
import { HttpError } from '../http/errors'
import { tr } from './i18n'
import type { ChatRuntime } from './runtime'
import { needsReview, nextRun, type ScheduleRow } from './schedules'
import { scheduleCard, scheduleOptions, writableConnections } from '../tools/schedules'

function build(ctx: AppContext, s: ScheduleRow, L: Locale) {
  const writable = writableConnections(ctx, s.user_id)
  const input = { title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.time, weekday: s.weekday ?? undefined, day: s.day ?? undefined, date: s.date ?? undefined }
  const card = scheduleCard(input, writable.map((r) => r.name), L, 'review')
  const options = scheduleOptions(L, writable.length > 0, 'review')
  // what the answer approves: the task as it is and the connections offered (not the wording, which follows the language)
  const requestId = 'schedule-review-' + crypto.createHash('sha256').update(JSON.stringify({
    id: s.id, title: s.title, prompt: s.prompt, repeat: s.repeat, time: s.time, weekday: s.weekday, day: s.day, date: s.date, project: s.project_id,
    urls: card.urls, connections: writable.map((r) => `${r.id}:${r.version}`).sort(), options: options.map((o) => o.value),
  })).digest('hex').slice(0, 48)
  return { card, options, requestId, writable }
}

function waiting(rt: ChatRuntime, userId: string, id: string): ScheduleRow {
  const s = rt.schedules.get(userId, id)
  if (!s) throw new HttpError('not_found')
  return s
}

/** GET /api/schedules/:id/review: the card, for an own task that needs it (409 schedule_not_waiting otherwise). */
export function reviewCard(ctx: AppContext, rt: ChatRuntime, userId: string, id: string, L: Locale): ScheduleReviewCard {
  const s = waiting(rt, userId, id)
  if (!needsReview(s)) throw new HttpError('conflict', undefined, { params: { reason: 'schedule_not_waiting' } })
  const { card, options, requestId } = build(ctx, s, L)
  return { request: { kind: 'ask_user', origin: 'server', requestId, question: card.question, options, multiple: false, allowText: false, ...(card.extra.details?.length ? { details: card.extra.details } : {}) } }
}

/** POST /api/schedules/:id/review: one of the card's own answers. "resume": confirmed now, on again from the next due
 * time with the addresses and connections the card showed; "keep": nothing changes. */
export function confirmReview(ctx: AppContext, rt: ChatRuntime, userId: string, id: string, body: { requestId: string; answer: string }, L: Locale, now = new Date()): ScheduleRow {
  const s = waiting(rt, userId, id)
  // already confirmed (another window): nothing to do
  if (!needsReview(s)) return s
  const { card, options, requestId, writable } = build(ctx, s, L)
  // a card that no longer matches first (its answers may have changed with it), then only its own answers
  if (body.requestId !== requestId) throw new HttpError('conflict', tr('scheduleCardChanged', L), { params: { reason: 'schedule_card_changed' } })
  if (!options.some((o) => o.value === body.answer)) throw new HttpError('validation', tr('answerNotOption', L))
  if (body.answer === 'keep') return s
  const blocked = rt.schedules.resumeBlockedReason({ ...s, enabled: 0 }, now)
  if (blocked) throw new HttpError('conflict', tr(blocked === 'completed' ? 'scheduleCompleted' : 'scheduleExpired', L), { params: { reason: `schedule_${blocked}` } })
  const next = nextRun(s, now, rt.timeZone)
  const connections = body.answer === 'resume_write' ? writable.map((r) => r.id) : []
  ctx.db.transaction(() => {
    ctx.db.query(`UPDATE schedules SET confirmed_at=?, review_since=NULL, allowed_urls=?, write_connections=?, enabled=?, next_run_at=?, pending_due_at=NULL, retry_at=NULL
      WHERE id=? AND user_id=? AND confirmed_at IS NULL`).run(now.toISOString(), card.urls.length ? JSON.stringify(card.urls) : null, connections.length ? JSON.stringify(connections) : null,
      next ? 1 : 0, next?.toISOString() ?? null, s.id, userId)
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
