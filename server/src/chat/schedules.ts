// Scheduled tasks: a person's prompt that the server sends for them on a schedule ("every weekday at 9:00, summarize
// what changed in shared/회의록"). Each run is a new chat of theirs ("⏰ <title> · <date>") with their own access, as if
// they had typed it, so the folder rules, budgets and audit apply unchanged. A run is unattended: its turn has
// client_kind 'schedule', nothing in it waits for a person (ask_user and confirmation cards answer "no" at once,
// turn.ts waitForPerson), and the message tells the AI so. Times are the team's time zone (ChatRuntime.timeZone).
// The office Mac may be off at the time: a run that was missed happens once when the server is back, then the
// schedule continues from now.
import type { Database } from 'bun:sqlite'
import { z } from 'zod'
import { budgetBlock } from '../admin/budgets'
import type { AppContext } from '../context'
import { newId } from '../db'
import { ToolError } from '../policy/errors'
import type { ChatRuntime } from './runtime'

export const SCHEDULES_PER_PERSON = 20
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
  next_run_at: string | null; last_run_at: string | null; last_chat_id: string | null; created_at: string
}

// ---------------- time zone arithmetic ----------------
/** Calendar parts of an instant in a time zone. */
export function zonedParts(t: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    .formatToParts(t).map((x) => [x.type, x.value]))
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, s: +p.second!, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!) }
}

/** The instant of a wall-clock time in a time zone (DST-safe: corrected by the zone's offset at that moment). */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  let t = Date.UTC(y, m - 1, d, h, min)
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(t), tz)
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min)
    t += Date.UTC(y, m - 1, d, h, min) - shown
  }
  return new Date(t)
}

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

  create(userId: string, input: ScheduleInput, now = new Date()): ScheduleRow {
    const n = (this.db.query('SELECT count(*) AS n FROM schedules WHERE user_id = ?').get(userId) as { n: number }).n
    if (n >= SCHEDULES_PER_PERSON) throw new ToolError(`at most ${SCHEDULES_PER_PERSON} scheduled tasks per person; delete one first`)
    const s = { repeat: input.repeat, time: input.time, weekday: input.weekday ?? null, day: input.day ?? null, date: input.date ?? null }
    const next = nextRun(s, now, this.rt.timeZone)
    if (!next) throw new ToolError('that time has already passed')
    const id = newId()
    this.db.query(`INSERT INTO schedules (id, user_id, title, prompt, repeat, time, weekday, day, date, project_id, next_run_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, input.title, input.prompt, s.repeat, s.time, s.weekday, s.day, s.date, input.projectId ?? null, next.toISOString())
    return this.get(userId, id)!
  }

  setEnabled(userId: string, id: string, enabled: boolean, now = new Date()): ScheduleRow | null {
    const s = this.get(userId, id)
    if (!s) return null
    const next = enabled ? nextRun(s, now, this.rt.timeZone) : null
    this.db.query('UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled && next ? 1 : 0, next?.toISOString() ?? null, id)
    return this.get(userId, id)
  }

  delete(userId: string, id: string): boolean {
    return this.db.query('DELETE FROM schedules WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
  }

  /** Start every schedule that is due (each at most once per call), and move it to its next time first. */
  runDue(now = new Date()): string[] {
    const due = this.db.query('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at')
      .all(now.toISOString()) as ScheduleRow[]
    const started: string[] = []
    for (const s of due) {
      // moved on before the run, so a crash or a slow turn never starts the same run twice
      const next = s.repeat === 'once' ? null : nextRun(s, now, this.rt.timeZone)
      this.db.query('UPDATE schedules SET next_run_at = ?, enabled = ?, last_run_at = ? WHERE id = ?')
        .run(next?.toISOString() ?? null, next ? 1 : 0, now.toISOString(), s.id)
      try {
        const chatId = this.start(s, now)
        if (chatId) { this.db.query('UPDATE schedules SET last_chat_id = ? WHERE id = ?').run(chatId, s.id); started.push(s.id) }
      } catch (e) {
        this.rt.log.warn('scheduled task could not start', { schedule: s.id, err: String(e).slice(0, 300) })
      }
    }
    return started
  }

  /** One run: a new chat of the person with the prompt; null when the person can't run turns now. */
  private start(s: ScheduleRow, now: Date): string | null {
    const user = this.db.query("SELECT id FROM users WHERE id = ? AND status = 'active' AND deleted_at IS NULL").get(s.user_id)
    if (!user) return null
    const locale = this.rt.userLocale(s.user_id)
    if (budgetBlock(this.db, s.user_id, locale, now)) { this.rt.log.info('scheduled task skipped: budget used up', { schedule: s.id }); return null }
    // a project the person can no longer see is dropped (the run goes on without it)
    const project = s.project_id ? this.rt.projectForChat(s.project_id, this.rt.ctx.files.principal(s.user_id)) : null
    const engine = this.rt.defaultEngine()
    const model = this.rt.defaultModel()
    const p = zonedParts(now, this.rt.timeZone)
    const date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
    const id = newId()
    const ts = now.toISOString()
    this.db.query('INSERT INTO chats (id, user_id, project_id, title, engine, model, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, s.user_id, project ? s.project_id : null, `⏰ ${s.title} · ${date}`, engine, model, ts, ts)
    this.rt.publishChat(s.user_id, id, 'created')
    const chat = this.rt.store.chatRow(id)!
    this.rt.createTurn({ chat, userId: s.user_id, locale, windowId: null, clientKind: 'schedule', engine, model,
      user: { parentId: null, content: s.prompt, attachments: [], clientMessageId: `schedule-${s.id}-${ts}` } })
    return id
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
