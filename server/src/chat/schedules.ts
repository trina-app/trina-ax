// Scheduled tasks: a person's prompt that the server sends for them on a schedule ("every weekday at 9:00, summarize
// what changed in shared/회의록"). Each run is a new chat of theirs ("<title> · <date>", no emoji; title_source
// 'schedule' and the turn's client_kind mark it as a run, not the title) with their own access and the engine and model
// a chat they start then would get, as if they had typed it, so the folder rules, budgets and audit apply unchanged —
// except web addresses: the text is the AI's (tools/schedules.ts), so the message is marked auto_sent and only the
// addresses the person saw on the schedule's card open without asking (tools/url-gate.ts). A run is unattended: its turn has
// client_kind 'schedule', nothing in it waits for a person (ask_user and confirmation cards answer "no" at once,
// turn.ts waitForPerson), and the message tells the AI so. Times are the team's time zone (ChatRuntime.timeZone).
// A free-text task runs only after its owner confirmed it on the schedule card (confirmed_at; templates need no card):
// one nobody confirmed — made before the card, or by an older build after a rollback — is paused for review instead of
// run, cannot be resumed with the switch, and resumes when its owner confirms the same card again
// (chat/schedule-review.ts, docs/DECISIONS.md "Scheduled tasks nobody confirmed").
// The office Mac may be off at the time: a run that was missed happens once when the server is back, then the
// schedule continues from now. Its owner can also run it once now (runNow, "지금 실행") with the same rules, and edit
// it through the same card (chat/schedule-edit.ts). Runs of one task never overlap: "run now" is refused while one is
// queued or running, and a run at its time waits for one (runDue), then runs.
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { budgetBlock } from '../admin/budgets'
import { newChatEngine, turnEngine } from '../admin/engine-choice'
import type { AppContext } from '../context'
import { newId } from '../db'
import { ToolError } from '../policy/errors'
import { HttpError } from '../http/errors'
import { tr } from './i18n'
import type { Locale } from '@mycel/shared/api'
import { notificationsOf } from '../notifications/service'
import { storedRunOutcome } from './schedule-outcome'
import type { ChatRuntime } from './runtime'
import { zonedParts, zonedToUtc } from '../system/time-zone'
import { rememberUrls } from '../tools/url-gate'
import { audit } from '../admin/audit'
import { missingTemplateKey } from '../integrations/connections/schedule-needs'

type LastOutcome = 'done' | 'problems' | 'error' | 'stopped' | 'interrupted' | 'budget_exceeded' | 'user_unavailable' | 'needs_key' | 'project_gone'

export const SCHEDULES_PER_PERSON = 20
/** a run refused because the queue was full is tried again this much later */
export const QUEUE_FULL_RETRY_MS = 60_000
const TICK_MS = 30_000

export const ScheduleInput = z.object({
  title: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(3).max(4000),
  repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'monthly']),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM (24-hour)'),
  weekday: z.number().int().min(0).max(6).optional().describe('weekly: 0 = Sunday … 6 = Saturday'),
  day: z.number().int().min(1).max(28).optional().describe('monthly: day of the month, 1–28'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('once: YYYY-MM-DD'),
  projectId: z.string().optional(),
}).superRefine((s, c) => {
  if (s.repeat === 'weekly' && s.weekday === undefined) c.addIssue({ code: 'custom', path: ['weekday'], message: 'weekly needs a weekday' })
  if (s.repeat === 'monthly' && s.day === undefined) c.addIssue({ code: 'custom', path: ['day'], message: 'monthly needs a day' })
  if (s.repeat === 'once' && !s.date) c.addIssue({ code: 'custom', path: ['date'], message: 'once needs a date' })
})
export type ScheduleInput = z.infer<typeof ScheduleInput>

export interface ScheduleRow {
  id: string; user_id: string; title: string; prompt: string; repeat: ScheduleInput['repeat']; time: string
  weekday: number | null; day: number | null; date: string | null; project_id: string | null; enabled: number
  template_id: string | null; template_version: number | null; template_source_path: string | null; template_output_path: string | null
  pending_due_at: string | null; retry_at: string | null; deferred_count: number
  next_run_at: string | null; last_run_at: string | null; last_chat_id: string | null; created_at: string
  /** JSON: addresses the person saw on the schedule's card; each run's chat gets them as allowed (tools/url-gate.ts) */
  allowed_urls: string | null
  /** JSON: ids of "allow" team connections the person let this schedule write to without asking */
  write_connections: string | null
  /** when the person approved this task on its card; NULL: a template (needs none) or nobody confirmed it */
  confirmed_at: string | null
  /** when the server paused it because nobody confirmed it (the owner is told; cleared when they confirm it) */
  review_since: string | null
}

/** What the person approved on a scheduled task's card (tools/schedules.ts, chat/schedule-review.ts). Its presence is
 * the confirmation: a free-text task created without one never runs. */
export interface ScheduleApproval { allowedUrls: string[]; writeConnections: string[] }

/** A free-text task nobody confirmed on its card: it never runs and the switch cannot resume it (unknown = paused). */
export function needsReview(s: Pick<ScheduleRow, 'template_id' | 'confirmed_at'>): boolean {
  return !s.template_id && !s.confirmed_at
}

/** The JSON string list of a schedule column (a bad or missing value is an empty list). */
export function scheduleList(v: string | null | undefined): string[] {
  if (!v) return []
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}

// ---------------- time zone arithmetic (system/time-zone.ts; re-exported for the callers that import them here) ----------------
export { zonedParts, zonedToUtc } from '../system/time-zone'

/** The first run strictly after `after` (null: a once-schedule whose time has passed). */
export function nextRun(s: Pick<ScheduleRow, 'repeat' | 'time' | 'weekday' | 'day' | 'date'>, after: Date, tz: string): Date | null {
  const [hh, mm] = s.time.split(':').map(Number) as [number, number]
  if (s.repeat === 'once') {
    const [y, m, d] = s.date!.split('-').map(Number) as [number, number, number]
    const t = zonedToUtc(y, m, d, hh, mm, tz)
    return t > after ? t : null
  }
  const start = zonedParts(after, tz)
  for (let i = 0; i < 370; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i))
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate(), wd = day.getUTCDay()
    const ok = s.repeat === 'daily' || (s.repeat === 'weekdays' && wd >= 1 && wd <= 5) || (s.repeat === 'weekly' && wd === s.weekday) || (s.repeat === 'monthly' && d === s.day)
    if (!ok) continue
    const t = zonedToUtc(y, m, d, hh, mm, tz)
    if (t > after) return t
  }
  return null
}

/** "every weekday at 09:00" etc., for lists and the AI. */
export function describeSchedule(s: Pick<ScheduleRow, 'repeat' | 'time' | 'weekday' | 'day' | 'date'>): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  switch (s.repeat) {
    case 'once': return `once on ${s.date} at ${s.time}`
    case 'daily': return `every day at ${s.time}`
    case 'weekdays': return `every weekday (Mon–Fri) at ${s.time}`
    case 'weekly': return `every ${days[s.weekday ?? 0]} at ${s.time}`
    case 'monthly': return `every month on day ${s.day} at ${s.time}`
  }
}

/** The block in front of a scheduled run's message (the AI must not wait for anyone). */
export function scheduledRunBlock(title: string, when: string): string {
  return [
    `<scheduled_run title="${title.replace(/["<>]/g, "'")}">`,
    `This message was sent automatically by the user's scheduled task (${when}). Nobody is watching this chat now: do not ask questions or wait for answers; anything that needs the user's confirmation will be declined. Do the task with what you can find, save files in the user's personal folder unless the task names another folder, and end with a short summary of what you did and found.`,
    '</scheduled_run>',
  ].join('\n')
}

// ---------------- store + runner ----------------
export class Schedules {
  constructor(private db: Database, private rt: ChatRuntime) {}

  list(userId: string): ScheduleRow[] {
    return this.db.query('SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at').all(userId) as ScheduleRow[]
  }
  get(userId: string, id: string): ScheduleRow | null {
    return this.db.query('SELECT * FROM schedules WHERE id = ? AND user_id = ?').get(id, userId) as ScheduleRow | null
  }

  /** Why create() would refuse (too many, a time that has passed), checked before anyone is asked; else the first run. */
  check(userId: string, input: ScheduleInput, now = new Date()): Date {
    const n = (this.db.query('SELECT count(*) AS n FROM schedules WHERE user_id = ?').get(userId) as { n: number }).n
    if (n >= SCHEDULES_PER_PERSON) throw new ToolError(`at most ${SCHEDULES_PER_PERSON} scheduled tasks per person; delete one first`)
    const next = nextRun({ repeat: input.repeat, time: input.time, weekday: input.weekday ?? null, day: input.day ?? null, date: input.date ?? null }, now, this.rt.timeZone)
    if (!next) throw new ToolError('that time has already passed')
    return next
  }

  create(userId: string, input: ScheduleInput, now = new Date(), approval?: ScheduleApproval): ScheduleRow {
    const next = this.check(userId, input, now)
    const s = { repeat: input.repeat, time: input.time, weekday: input.weekday ?? null, day: input.day ?? null, date: input.date ?? null }
    const id = newId()
    this.db.query(`INSERT INTO schedules (id, user_id, title, prompt, repeat, time, weekday, day, date, project_id, next_run_at, allowed_urls, write_connections, confirmed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, input.title, input.prompt, s.repeat, s.time, s.weekday, s.day, s.date, input.projectId ?? null, next.toISOString(),
      approval?.allowedUrls.length ? JSON.stringify(approval.allowedUrls) : null, approval?.writeConnections.length ? JSON.stringify(approval.writeConnections) : null,
      approval ? now.toISOString() : null)
    return this.get(userId, id)!
  }

  /** Nobody confirmed this free-text task: off, its pending occurrence dropped, marked for its owner's review (told in
   * the inbox, notifications/service.ts). Audited. */
  pauseForReview(s: ScheduleRow, now = new Date(), reason: 'run' | 'upgrade' = 'run'): void {
    this.db.query('UPDATE schedules SET enabled=0,next_run_at=NULL,pending_due_at=NULL,retry_at=NULL,review_since=COALESCE(review_since,?) WHERE id=?').run(now.toISOString(), s.id)
    audit(this.db, { actor: null, action: 'schedule.review_paused', target: s.id, detail: { userId: s.user_id, wasEnabled: !!s.enabled, reason } })
    try { notificationsOf(this.rt.ctx).reconcile(s.user_id) } catch { this.rt.log.warn('schedule notification deferred') }
  }

  /** Disabled one-time tasks cannot replay a consumed occurrence or move a past due time. */
  resumeBlockedReason(s: ScheduleRow, now = new Date()): 'completed' | 'expired' | null {
    if (s.enabled || s.repeat !== 'once') return null
    if (s.last_run_at) return 'completed'
    return nextRun(s, now, this.rt.timeZone) ? null : 'expired'
  }

  setEnabled(userId: string, id: string, enabled: boolean, now = new Date(), locale: Locale = this.rt.userLocale(userId)): ScheduleRow | null {
    const s = this.get(userId, id)
    if (!s) return null
    if (!!s.enabled === enabled) return s
    // nobody confirmed it: only its card resumes it (chat/schedule-review.ts)
    if (enabled && needsReview(s)) throw new HttpError('conflict', tr('scheduleReview', locale), { params: { reason: 'schedule_review' } })
    const reason = enabled ? this.resumeBlockedReason(s, now) : null
    if (reason) throw new HttpError('conflict', tr(reason === 'completed' ? 'scheduleCompleted' : 'scheduleExpired', locale), { params: { reason: `schedule_${reason}` } })
    const next = enabled ? nextRun(s, now, this.rt.timeZone) : null
    this.db.transaction(() => {
      this.db.query('UPDATE schedules SET enabled = ?, next_run_at = ?, pending_due_at = NULL, retry_at = NULL WHERE id = ?').run(enabled && next ? 1 : 0, next?.toISOString() ?? null, id)
      audit(this.db, { actor: userId, action: enabled ? 'schedule.resumed' : 'schedule.paused', target: id, detail: { nextRunAt: next?.toISOString() ?? null } })
    })()
    return this.get(userId, id)
  }

  /** "지금 실행" (Settings): one run now with the rules of a scheduled run, as its person: unattended (nothing waits
   * for anyone), only the addresses and connections its card allowed, the budgets, the person's access and, for a
   * template, its folders. It is outside the schedule: the next run, on/off and a pending occurrence stay as they are;
   * a paused task runs too (the person asked). Refused: a task nobody confirmed (it never runs), one that is running
   * now, a used-up budget; a full queue is refused like a message (429). Audited. */
  runNow(userId: string, id: string, now = new Date(), locale: Locale = this.rt.userLocale(userId)): { row: ScheduleRow; chatId: string } {
    const s = this.get(userId, id)
    if (!s) throw new HttpError('not_found')
    if (needsReview(s)) throw new HttpError('conflict', tr('scheduleReview', locale), { params: { reason: 'schedule_review' } })
    if (this.db.query("SELECT 1 FROM turns WHERE schedule_id = ? AND user_id = ? AND status IN ('queued','running') LIMIT 1").get(s.id, userId))
      throw new HttpError('conflict', tr('scheduleRunning', locale), { params: { reason: 'schedule_running' } })
    // it needs the person's own key for an admin's template that they have not connected (or that stopped working):
    // said now, not run without the service (integrations/connections/schedule-needs.ts)
    const need = missingTemplateKey(this.db, s)
    if (need) throw new HttpError('conflict', tr('scheduleNeedsKey', locale, { name: need.name }), { params: { reason: 'schedule_needs_key', templateId: need.templateId } })
    // its project is gone for its owner: never run as a chat without it (docs/DECISIONS.md "Project skills")
    if (s.project_id && !this.rt.projectForChat(s.project_id, this.rt.ctx.files.principal(userId))) throw new HttpError('conflict', tr('scheduleProjectGone', locale), { params: { reason: 'schedule_project_gone' } })
    const blocked = budgetBlock(this.db, userId, locale, now)
    if (blocked) throw new HttpError('budget_exceeded', blocked.message)
    // its own occurrence key: never a whole minute, so never the key of a scheduled occurrence (turns_schedule_occurrence)
    const t = now.getTime()
    const dueAt = new Date(t % 60_000 === 0 ? t + 1 : t).toISOString()
    const chatId = this.start(s, now, dueAt, (chat) => { if (chat) this.db.query('UPDATE schedules SET last_chat_id = ? WHERE id = ?').run(chat, s.id) }, 'manual')
    if (!chatId) {
      const again = budgetBlock(this.db, userId, locale, now)
      throw again ? new HttpError('budget_exceeded', again.message) : new HttpError('forbidden')
    }
    audit(this.db, { actor: userId, action: 'schedule.run_now', target: s.id, detail: { scheduledFor: dueAt, template: s.template_id ?? undefined } })
    return { row: this.get(userId, id)!, chatId }
  }

  delete(userId: string, id: string): boolean {
    return this.db.query('DELETE FROM schedules WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
  }

  /** The last run's result: 'done' only for a clean success; a finished run with refused/failed tools is 'problems',
   *  a finished run without an answer is 'error' (chat/schedule-outcome.ts). */
  lastOutcome(userId: string, id: string): LastOutcome | null {
    const row = this.db.query(`SELECT code, run_outcome FROM (
      SELECT status code, run_outcome, ended_at at FROM turns WHERE schedule_id=? AND user_id=? AND status IN ('done','error','stopped','interrupted')
      UNION ALL SELECT code, NULL run_outcome, created_at at FROM schedule_outcomes WHERE schedule_id=? AND user_id=?
      UNION ALL SELECT 'needs_key' code, NULL run_outcome, created_at at FROM schedule_template_skips WHERE schedule_id=? AND user_id=?
      UNION ALL SELECT 'project_gone' code, NULL run_outcome, created_at at FROM schedule_project_skips WHERE schedule_id=? AND user_id=?
    ) ORDER BY at DESC LIMIT 1`).get(id, userId, id, userId, id, userId, id, userId) as { code: LastOutcome; run_outcome: string | null } | null
    if (!row) return null
    if (row.code !== 'done') return row.code
    const outcome = storedRunOutcome({ status: 'done', run_outcome: row.run_outcome })
    return outcome === 'succeeded' ? 'done' : outcome === 'problems' ? 'problems' : 'error'
  }

  /** lastOutcome 'needs_key': the template the last skipped run needed, by the name it had then. */
  lastNeed(userId: string, id: string): { templateId: string; name: string } | null {
    const r = this.db.query('SELECT template_id, template_name FROM schedule_template_skips WHERE schedule_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1').get(id, userId) as { template_id: string; template_name: string } | null
    return r ? { templateId: r.template_id, name: r.template_name } : null
  }

  /** One pending occurrence per schedule. A retry never changes its original due key. */
  runDue(now = new Date()): string[] {
    if (!this.rt.acceptingTurns) return []
    const due = this.db.query(`SELECT * FROM schedules WHERE enabled=1 AND
      ((pending_due_at IS NOT NULL AND (retry_at IS NULL OR retry_at <= ?)) OR
       (pending_due_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?))
      ORDER BY COALESCE(pending_due_at,next_run_at),id`).all(now.toISOString(), now.toISOString()) as ScheduleRow[]
    const started: string[] = []
    for (const s of due) {
      // a free-text task nobody confirmed never runs (made before the card, or by an older build): paused for review
      if (needsReview(s)) { this.pauseForReview(s, now); continue }
      const originalDue = s.pending_due_at ?? s.next_run_at!
      // a run of the same task is still queued or running ("지금 실행" just before its time, or a slow earlier run):
      // this occurrence waits for it and starts at a tick after it ends, never next to it (two runs would write the
      // same output). Nothing is written meanwhile: next_run_at / pending_due_at keep its key, so a restart still runs it.
      const running = this.runningChat(s)
      if (running) { this.noteWaiting(s, originalDue, running, now); continue }
      // Durable before admission: crash here leaves this exact occurrence pending for the next process.
      this.db.query('UPDATE schedules SET pending_due_at=COALESCE(pending_due_at,?) WHERE id=?').run(originalDue, s.id)
      const next = s.repeat === 'once' ? null : nextRun(s, now, this.rt.timeZone)
      const commit = (chatId: string | null) => {
        this.db.query('UPDATE schedules SET next_run_at=?,enabled=?,last_run_at=?,last_chat_id=COALESCE(?,last_chat_id),pending_due_at=NULL,retry_at=NULL WHERE id=?')
          .run(next?.toISOString() ?? null, next ? 1 : 0, now.toISOString(), chatId, s.id)
        if (Date.parse(originalDue) < now.getTime() - TICK_MS)
          this.db.query("INSERT INTO audit_log(actor_id,action,target,detail) VALUES(NULL,'schedule.coalesced',?,?)")
            .run(s.id, JSON.stringify({ originalDue, acceptedAt: now.toISOString() }))
      }
      try {
        // the owner's own key for a template the task needs is missing or stopped working: this occurrence does not
        // start, and its result and the owner's inbox say which template to connect (never anyone else's key)
        const ownerActive = !!this.db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(s.user_id)
        const need = ownerActive ? missingTemplateKey(this.db, s) : null
        // a task in a project its owner no longer sees (the folder's access was taken away, or it is in the trash): the
        // run does not start, rather than run as a chat without the project (docs/DECISIONS.md "Project skills")
        const gone = ownerActive && !need && s.project_id && !this.rt.projectForChat(s.project_id, this.rt.ctx.files.principal(s.user_id)) ? s.project_id : null
        const chatId = need || gone ? null : this.start(s, now, originalDue, commit)
        if (chatId) started.push(s.id)
        else this.db.transaction(() => {
          commit(null)
          const active = this.db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(s.user_id)
          if (!active) this.db.query('UPDATE schedules SET enabled=0,next_run_at=NULL WHERE id=?').run(s.id)
          if (gone) {
            this.db.query('INSERT INTO schedule_project_skips(id,user_id,schedule_id,scheduled_for,project_id,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(schedule_id,scheduled_for) DO NOTHING')
              .run(newId(), s.user_id, s.id, originalDue, gone, now.toISOString())
            this.db.query("INSERT INTO audit_log(actor_id,action,target,detail) VALUES(NULL,'schedule.project_gone',?,?)").run(s.id, JSON.stringify({ originalDue, project: gone }))
          } else if (need) {
            this.db.query('INSERT INTO schedule_template_skips(id,user_id,schedule_id,scheduled_for,template_id,template_name,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(schedule_id,scheduled_for) DO NOTHING')
              .run(newId(), s.user_id, s.id, originalDue, need.templateId, need.name, now.toISOString())
            this.db.query("INSERT INTO audit_log(actor_id,action,target,detail) VALUES(NULL,'schedule.needs_key',?,?)").run(s.id, JSON.stringify({ originalDue, template: need.templateId }))
          } else {
            this.db.query('INSERT INTO schedule_outcomes(id,user_id,schedule_id,scheduled_for,code,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(schedule_id,scheduled_for) DO NOTHING')
              .run(newId(), s.user_id, s.id, originalDue, active ? 'budget_exceeded' : 'user_unavailable', now.toISOString())
          }
        })()
        if (!chatId) { try { notificationsOf(this.rt.ctx).reconcile(s.user_id) } catch { this.rt.log.warn('schedule notification deferred') } }
      } catch (e) {
        const retry = new Date(now.getTime() + QUEUE_FULL_RETRY_MS).toISOString()
        this.db.query('UPDATE schedules SET retry_at=?,deferred_count=deferred_count+1 WHERE id=?').run(retry, s.id)
        const reason = e instanceof HttpError ? e.extra.params?.reason ?? e.code : 'admission_failed'
        this.db.query("INSERT INTO audit_log(actor_id,action,target,detail) VALUES(NULL,'schedule.deferred',?,?)")
          .run(s.id, JSON.stringify({ reason, originalDue, retryAt: retry }))
        if (!(e instanceof HttpError)) this.rt.log.warn('scheduled task admission failed; occurrence preserved', { schedule: s.id })
      }
    }
    return started
  }

  /** The chat of a run of this task that is queued or running now, or null. */
  private runningChat(s: ScheduleRow): string | null {
    return (this.db.query("SELECT chat_id FROM turns WHERE schedule_id = ? AND user_id = ? AND status IN ('queued','running') LIMIT 1").get(s.id, s.user_id) as { chat_id: string } | null)?.chat_id ?? null
  }

  /** An occurrence waits for the run before it: logged once (audit `schedule.waited`), not at every tick. */
  private noteWaiting(s: ScheduleRow, originalDue: string, runningChatId: string, now: Date) {
    const seen = this.db.query("SELECT 1 FROM audit_log WHERE action = 'schedule.waited' AND target = ? AND json_extract(detail, '$.originalDue') = ? LIMIT 1").get(s.id, originalDue)
    if (seen) return
    this.db.query("INSERT INTO audit_log(actor_id,action,target,detail) VALUES(NULL,'schedule.waited',?,?)")
      .run(s.id, JSON.stringify({ originalDue, runningChatId, at: now.toISOString() }))
    this.rt.log.info('scheduled run waits for the run of the same task before it', { schedule: s.id, originalDue })
  }

  private start(s: ScheduleRow, now: Date, originalDue: string, commit: (chatId: string | null) => void, how: 'scheduled' | 'manual' = 'scheduled'): string | null {
    const user = this.db.query("SELECT id, role FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(s.user_id) as { id: string; role: string } | null
    if (!user) return null
    const locale = this.rt.userLocale(s.user_id)
    if (budgetBlock(this.db, s.user_id, locale, now)) { this.rt.log.info('scheduled task skipped: budget used up', { schedule: s.id }); return null }
    const project = s.project_id ? this.rt.projectForChat(s.project_id, this.rt.ctx.files.principal(s.user_id)) : null
    // a project gone since the caller looked: no run outside it (runDue and runNow say why)
    if (s.project_id && !project) return null
    // the owner's AI, as for a chat they start now (admin/engine-choice.ts, the same as Slack and rooms): their own
    // default engine and model when they may pick and it is on, else the team default; decided at each run, so a later
    // change of either applies. Every run is a new chat, so there is no chat engine to keep.
    const person = { id: user.id, role: user.role }
    const fresh = newChatEngine(this.rt.ctx, person, {}, locale)
    const te = turnEngine(this.rt.ctx, person, fresh, {}, locale, (e) => this.rt.defaultModelFor(e))
    const p = zonedParts(now, this.rt.timeZone)
    const date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
    const id = newId(), ts = now.toISOString()
    const turn = this.rt.createTurn({
      chat: () => {
        this.db.query("INSERT INTO chats(id,user_id,project_id,title,title_source,engine,model,created_at,updated_at) VALUES(?,?,?,?,'schedule',?,?,?,?)")
          .run(id, s.user_id, project ? s.project_id : null, `${s.title} · ${date}`, fresh.engine, fresh.model, ts, ts)
        // the run's message is the AI's text (auto_sent): only the addresses the person saw on the schedule's card open
        // without asking (docs/DECISIONS.md "Outbound web channels")
        rememberUrls(this.db, id, scheduleList(s.allowed_urls), 'allowed')
        return this.rt.store.chatRow(id)!
      },
      userId: s.user_id, locale, windowId: null, clientKind: 'schedule', engine: te.engine, model: te.model, ...(te.substitutedFrom ? { substitutedFrom: te.substitutedFrom } : {}),
      scheduled: { id: s.id, dueAt: originalDue, commit: (chatId) => {
        commit(chatId)
        if (s.template_id) this.db.query('UPDATE turns SET template_source_path=?,template_output_path=? WHERE schedule_id=? AND scheduled_for=?')
          .run(s.template_source_path, s.template_output_path, s.id, originalDue)
      } },
      // Keep the client contract <=64 chars; uniqueness is the durable two-column occurrence key.
      user: { parentId: null, content: s.prompt, attachments: [], clientMessageId: `${how === 'manual' ? 'n' : 's'}-${s.id}-${Date.parse(originalDue)}` },
    })
    return turn.assistantMessage.chatId
  }

  /** The team's time zone changed (Admin > Settings): every enabled schedule's next run is computed again in it. */
  recomputeAll(now = new Date()): number {
    const rows = this.db.query('SELECT * FROM schedules WHERE enabled = 1 AND pending_due_at IS NULL').all() as ScheduleRow[]
    for (const s of rows) {
      const next = nextRun(s, now, this.rt.timeZone)
      this.db.query('UPDATE schedules SET next_run_at = ?, enabled = ? WHERE id = ?').run(next?.toISOString() ?? null, next ? 1 : 0, s.id)
    }
    return rows.length
  }

  /** The server's loop (not in tests): every 30 s, plus once right away for runs missed while the server was off. */
  startLoop(ctx: AppContext): void {
    const tick = () => { try { this.runDue() } catch (e) { ctx.log.warn('scheduled tasks tick failed', { err: String(e) }) } }
    const first = setTimeout(tick, 5000)
    const every = setInterval(tick, TICK_MS)
    first.unref?.(); every.unref?.()
    ctx.onClose(() => { clearTimeout(first); clearInterval(every) })
  }
}
