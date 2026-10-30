// Scheduled tasks: a person's prompt that the server sends for them on a schedule ("every weekday at 9:00, summarize
// what changed in shared/회의록"). Each run is a new chat of theirs ("⏰ <title> · <date>") with their own access, as if
// they had typed it, so the folder rules, budgets and audit apply unchanged — except web addresses: the text is the
// AI's (tools/schedules.ts), so the message is marked auto_sent and only the addresses the person saw on the schedule's
// card open without asking (tools/url-gate.ts). A run is unattended: its turn has
// client_kind 'schedule', nothing in it waits for a person (ask_user and confirmation cards answer "no" at once,
// turn.ts waitForPerson), and the message tells the AI so. Times are the team's time zone (ChatRuntime.timeZone).
// A free-text task runs only after its owner confirmed it on the schedule card (confirmed_at; templates need no card):
// one nobody confirmed — made before the card, or by an older build after a rollback — is paused for review instead of
// run, cannot be resumed with the switch, and resumes when its owner confirms the same card again
// (chat/schedule-review.ts, docs/DECISIONS.md "Scheduled tasks nobody confirmed").
// The office Mac may be off at the time: a run that was missed happens once when the server is back, then the
// schedule continues from now.
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { budgetBlock } from '../admin/budgets'
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

type LastOutcome = 'done' | 'problems' | 'error' | 'stopped' | 'interrupted' | 'budget_exceeded' | 'user_unavailable'

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
    this.db.query('UPDATE schedules SET enabled = ?, next_run_at = ?, pending_due_at = NULL, retry_at = NULL WHERE id = ?').run(enabled && next ? 1 : 0, next?.toISOString() ?? null, id)
    return this.get(userId, id)
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
    ) ORDER BY at DESC LIMIT 1`).get(id, userId, id, userId) as { code: LastOutcome; run_outcome: string | null } | null
    if (!row) return null
    if (row.code !== 'done') return row.code
    const outcome = storedRunOutcome({ status: 'done', run_outcome: row.run_outcome })
    return outcome === 'succeeded' ? 'done' : outcome === 'problems' ? 'problems' : 'error'
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
        const chatId = this.start(s, now, originalDue, commit)
        if (chatId) started.push(s.id)
        else this.db.transaction(() => {
          commit(null)
          const active = this.db.query("SELECT 1 FROM users WHERE id=? AND status='active' AND deleted_at IS NULL").get(s.user_id)
          if (!active) this.db.query('UPDATE schedules SET enabled=0,next_run_at=NULL WHERE id=?').run(s.id)
          this.db.query('INSERT INTO schedule_outcomes(id,user_id,schedule_id,scheduled_for,code,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(schedule_id,scheduled_for) DO NOTHING')
            .run(newId(), s.user_id, s.id, originalDue, active ? 'budget_exceeded' : 'user_unavailable', now.toISOString())
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

  private start(s: ScheduleRow, now: Date, originalDue: string, commit: (chatId: string | null) => void): string | null {
    const user = this.db.query("SELECT id FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(s.user_id)
    if (!user) return null
    const locale = this.rt.userLocale(s.user_id)
    if (budgetBlock(this.db, s.user_id, locale, now)) { this.rt.log.info('scheduled task skipped: budget used up', { schedule: s.id }); return null }
    const project = s.project_id ? this.rt.projectForChat(s.project_id, this.rt.ctx.files.principal(s.user_id)) : null
    const engine = this.rt.defaultEngine(), model = this.rt.defaultModel()
    const p = zonedParts(now, this.rt.timeZone)
    const date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
    const id = newId(), ts = now.toISOString()
    const turn = this.rt.createTurn({
      chat: () => {
        this.db.query("INSERT INTO chats(id,user_id,project_id,title,title_source,engine,model,created_at,updated_at) VALUES(?,?,?,?,'schedule',?,?,?,?)")
          .run(id, s.user_id, project ? s.project_id : null, `⏰ ${s.title} · ${date}`, engine, model, ts, ts)
        // the run's message is the AI's text (auto_sent): only the addresses the person saw on the schedule's card open
        // without asking (docs/DECISIONS.md "Outbound web channels")
        rememberUrls(this.db, id, scheduleList(s.allowed_urls), 'allowed')
        return this.rt.store.chatRow(id)!
      },
      userId: s.user_id, locale, windowId: null, clientKind: 'schedule', engine, model,
      scheduled: { id: s.id, dueAt: originalDue, commit: (chatId) => {
        commit(chatId)
        if (s.template_id) this.db.query('UPDATE turns SET template_source_path=?,template_output_path=? WHERE schedule_id=? AND scheduled_for=?')
          .run(s.template_source_path, s.template_output_path, s.id, originalDue)
      } },
      // Keep the client contract <=64 chars; uniqueness is the durable two-column occurrence key.
      user: { parentId: null, content: s.prompt, attachments: [], clientMessageId: `s-${s.id}-${Date.parse(originalDue)}` },
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
