// Long commands in a dev environment box (docs/DECISIONS.md "Dev environment: disk floor, jobs, CPU as activity").
// box_shell with job: true starts a background command that has an exit status and a log. boxd reports them (op jobs);
// the server keeps them in dev_env_jobs, polls boxd while one runs and picks up open rows after a restart. When a job
// ends, the person who started it gets a notice with the exit code, the log tail and a link to the chat; an audit line
// is written; and the next box_shell call in that project gives the AI the result. The AI does not go on by itself.
//
// The tracker also reads boxd's status: when boxd stopped a box for a reason that people must hear of (the disk floor, the
// CPU maximum), the people who may use the box and the admins get a notice. Idle stops stay quiet.
//
// An older boxd answers "unknown op": a job row stays open, the poll waits longer, and the age limit ends the row.
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { Locale, type DevEnvJob } from '@mycel/shared/api'
import type { BoxdJob } from '@mycel/shared'
import type { AppContext } from '../context'
import { newId } from '../db'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { canRead } from '../chat/projects'
import { admins } from '../credentials/store'
import { carryLength, redactorFor, type Redactor } from '../integrations/connections/redact'
import { notifyDevEnv } from '../notifications/service'
import { boxd } from './boxd'
import { mayUseBox } from './setting'

export const JOB_POLL_MS = 10_000
/** an open row older than this ends: a job cannot outlive this with no answer from boxd (the row must not poll for ever) */
export const JOB_MAX_AGE_MS = 7 * 86400_000
const JOB_KEEP_MS = 30 * 86400_000
const UNKNOWN_OP_WAIT_MS = 10 * 60_000
/** the end of the log that goes to the AI and into the live notice */
const AI_TAIL = 2000
const NOTICE_TAIL = 300
/** the last log line on the project page */
const LINE_MAX = 300
/** stops that people must hear of: the others are normal (idle), or the AI hears of them in its own command */
const TOLD_STOPS: ReadonlySet<string> = new Set(['disk', 'busy_max'])

const STALE_NOTE = 'boxd did not report this job'

interface JobRow { id: string; project_id: string; name: string; user_id: string; chat_id: string | null; turn_id: string | null; started_at: string; last_line: string; log_tail: string }
const COLS = 'id, project_id, name, user_id, chat_id, turn_id, started_at, last_line, log_tail'

export const newJobName = () => 'job-' + crypto.randomBytes(3).toString('hex')

export function startJob(ctx: AppContext, j: { projectId: string; name: string; userId: string; chatId?: string | null; turnId: string; command: string }): string {
  const id = newId()
  ctx.db.query('INSERT INTO dev_env_jobs (id, project_id, name, user_id, chat_id, turn_id, command, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, j.projectId, j.name, j.userId, j.chatId ?? null, j.turnId, j.command.slice(0, 500), new Date().toISOString())
  return id
}

export const jobRuns = (db: Database, projectId: string, name: string) =>
  !!db.query('SELECT 1 FROM dev_env_jobs WHERE project_id = ? AND name = ? AND ended_at IS NULL').get(projectId, name)

/** what the project page shows: the jobs that run now */
export function runningJobs(db: Database, projectId: string): DevEnvJob[] {
  const rows = db.query(`SELECT j.id, j.name, j.user_id, u.name AS who, j.started_at, j.last_line FROM dev_env_jobs j LEFT JOIN users u ON u.id = j.user_id
    WHERE j.project_id = ? AND j.ended_at IS NULL ORDER BY j.started_at LIMIT 32`).all(projectId) as { id: string; name: string; user_id: string; who: string | null; started_at: string; last_line: string }[]
  return rows.map((r) => ({ id: r.id, name: r.name, by: { id: r.user_id, name: r.who ?? r.user_id }, startedAt: r.started_at, lastLine: r.last_line }))
}

function localeOf(db: Database, userId: string): Locale {
  const v = Locale.safeParse((db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale: string } | null)?.locale)
  return v.success ? v.data : teamDefaultLocale(db)
}

const JOB_ENDED: Record<Locale, (name: string, code: string) => string> = {
  ko: (n, c) => `개발 환경 작업 ${n}이(가) 끝났어요 (종료 코드 ${c}).`,
  en: (n, c) => `Dev environment job ${n} ended (exit code ${c}).`,
  id: (n, c) => `Pekerjaan lingkungan pengembangan ${n} selesai (kode keluar ${c}).`,
  ja: (n, c) => `開発環境のジョブ ${n} が終了しました（終了コード ${c}）。`,
  es: (n, c) => `El trabajo ${n} del entorno de desarrollo terminó (código de salida ${c}).`,
}
const NO_CODE: Record<Locale, string> = { ko: '알 수 없음', en: 'not known', id: 'tidak diketahui', ja: '不明', es: 'desconocido' }
const BOX_STOPPED: Record<string, Record<Locale, (project: string) => string>> = {
  disk: {
    ko: (p) => `서버 디스크가 거의 차서 ${p}의 개발 환경 상자를 멈췄어요. 휴지통을 비우거나 파일을 지워 주세요. 그다음 명령에서 상자가 다시 시작돼요.`,
    en: (p) => `The dev environment box of ${p} stopped because the server disk is nearly full. Empty the trash or delete files. The next command then starts it again.`,
    id: (p) => `Kotak lingkungan pengembangan ${p} berhenti karena disk server hampir penuh. Kosongkan tempat sampah atau hapus berkas. Perintah berikutnya akan memulainya lagi.`,
    ja: (p) => `サーバーのディスクがほぼ満杯のため、${p} の開発環境ボックスを停止しました。ゴミ箱を空にするかファイルを削除してください。次のコマンドでボックスが再び開始します。`,
    es: (p) => `La caja del entorno de desarrollo de ${p} se detuvo porque el disco del servidor está casi lleno. Vacíe la papelera o elimine archivos. El siguiente comando la volverá a iniciar.`,
  },
  busy_max: {
    ko: (p) => `${p}의 개발 환경 상자가 명령 없이 CPU를 너무 오래 써서 멈췄어요.`,
    en: (p) => `The dev environment box of ${p} stopped because it used CPU for too long with no command.`,
    id: (p) => `Kotak lingkungan pengembangan ${p} berhenti karena memakai CPU terlalu lama tanpa perintah.`,
    ja: (p) => `${p} の開発環境ボックスは、コマンドなしで CPU を長時間使い続けたため停止しました。`,
    es: (p) => `La caja del entorno de desarrollo de ${p} se detuvo porque usó la CPU demasiado tiempo sin ningún comando.`,
  },
}

function readableBy(ctx: AppContext, userId: string, folderPath: string): boolean {
  try { return canRead(ctx.files, ctx.files.principal(userId), folderPath) } catch { return false }
}

const clipEnd = (s: string, max: number) => (s.length > max ? '...' + s.slice(-max) : s)

/** Log text of a running job as it may be kept. The command can be in the middle of a stored secret, and hide knows only
 * whole values, so what can be the start of one goes too; the next poll has the rest. An ended job has no such end. */
const hideRunning = (r: Redactor, s: string) => {
  const h = r.hide(s)
  return h.slice(0, h.length - carryLength(h, r.values))
}

function endJob(ctx: AppContext, row: JobRow, end: { code: number | null; note: string; tail: string; lastLine: string }) {
  const at = new Date().toISOString()
  const r = redactorFor(ctx, row.user_id)
  // boxd cuts the tail at whole lines; the last line is cut here, after hide
  const tail = r.hide(end.tail), lastLine = r.hide(end.lastLine).slice(0, LINE_MAX)
  // one notice: a poll of the tool and a poll of the timer can meet here
  const done = ctx.db.query('UPDATE dev_env_jobs SET ended_at = ?, exit_code = ?, end_note = ?, log_tail = ?, last_line = ? WHERE id = ? AND ended_at IS NULL')
    .run(at, end.code, end.note, tail, lastLine, row.id)
  if (!done.changes) return
  audit(ctx.db, { actor: row.user_id, action: 'dev_env.job', target: row.project_id, detail: {
    job: row.id, name: row.name, turnId: row.turn_id, code: end.code, note: end.note, seconds: Math.round((Date.parse(at) - Date.parse(row.started_at)) / 1000),
  } })
  const p = ctx.db.query('SELECT folder_path FROM projects WHERE id = ?').get(row.project_id) as { folder_path: string } | null
  if (!p || !readableBy(ctx, row.user_id, p.folder_path)) return // no access now: the log stays out of the notice
  const code = end.code === null ? NO_CODE[localeOf(ctx.db, row.user_id)] : String(end.code)
  const text = JOB_ENDED[localeOf(ctx.db, row.user_id)](row.name, code)
  const link = row.chat_id ? `/c/${encodeURIComponent(row.chat_id)}` : `/projects/${encodeURIComponent(row.project_id)}`
  // with no exit code the note says why: the box stopped at its idle time, at the disk floor ...
  const message = [text, end.code === null ? end.note : '', clipEnd(tail, NOTICE_TAIL)].filter(Boolean).join('\n')
  try {
    ctx.services.realtime.publish(row.user_id, { type: 'notice', data: { level: end.code === 0 ? 'info' : 'warn', code: 'dev_env_job', message, link } })
  } catch (err) { ctx.log.warn('dev env job notice failed', { err }) }
  notifyDevEnv(ctx, row.user_id, 'dev_env.job', row.id)
}

const openRows = (db: Database, projectId?: string) => (projectId
  ? db.query(`SELECT ${COLS} FROM dev_env_jobs WHERE ended_at IS NULL AND project_id = ?`).all(projectId)
  : db.query(`SELECT ${COLS} FROM dev_env_jobs WHERE ended_at IS NULL`).all()) as JobRow[]

/** a box whose boxd said "unknown op": no poll before this time */
const waitUntil = new Map<string, number>()

function apply(ctx: AppContext, row: JobRow, j: BoxdJob | undefined) {
  if (!j) return endJob(ctx, row, { code: null, note: STALE_NOTE, tail: row.log_tail, lastLine: row.last_line })
  if (j.state === 'ended') return endJob(ctx, row, { code: j.code, note: j.code === null ? (j.why ?? '') : '', tail: j.tail, lastLine: j.lastLine })
  if (j.tail !== row.log_tail) {
    const r = redactorFor(ctx, row.user_id)
    ctx.db.query('UPDATE dev_env_jobs SET last_line = ?, log_tail = ? WHERE id = ? AND ended_at IS NULL').run(hideRunning(r, j.lastLine).slice(0, LINE_MAX), hideRunning(r, j.tail), row.id)
  }
}

/** Ask boxd about the open jobs of one project, or of every project. A failed poll changes nothing: the next one reads
 * again. An answer that does not name an open job ends that job (boxd restarted, so its box stopped too). */
export async function pollJobs(ctx: AppContext, projectId?: string): Promise<void> {
  const rows = openRows(ctx.db, projectId)
  if (!rows.length) return
  const client = boxd()
  const now = Date.now()
  for (const r of rows) {
    if (now - Date.parse(r.started_at) > JOB_MAX_AGE_MS) endJob(ctx, r, { code: null, note: STALE_NOTE, tail: r.log_tail, lastLine: r.last_line })
  }
  if (!client?.jobs) return
  for (const box of new Set(rows.map((r) => r.project_id))) {
    if ((waitUntil.get(box) ?? 0) > now) continue
    const a = await client.jobs(box).catch(() => null)
    if (!a) continue
    if (!a.ok) {
      if (/unknown op/.test(a.message)) waitUntil.set(box, now + UNKNOWN_OP_WAIT_MS)
      continue
    }
    waitUntil.delete(box)
    const byName = new Map(a.value.jobs.map((j) => [j.name, j]))
    // the rows from before the question: a job that box_shell added since then is not in this answer
    for (const r of rows) if (r.project_id === box) apply(ctx, r, byName.get(r.name))
  }
}

/** The results that the AI did not get yet, in text for box_shell. Each result goes once. The log is text from the box and
 * can come from another person's job, so it has a section of its own, with an end line that the box cannot know. */
export function jobResultsForAI(ctx: AppContext, projectId: string): string[] {
  const rows = ctx.db.query(`SELECT id, name, exit_code, end_note, log_tail FROM dev_env_jobs WHERE project_id = ? AND ended_at IS NOT NULL AND ai_told_at IS NULL ORDER BY ended_at LIMIT 20`)
    .all(projectId) as { id: string; name: string; exit_code: number | null; end_note: string; log_tail: string }[]
  const at = new Date().toISOString()
  return rows.map((r) => {
    ctx.db.query('UPDATE dev_env_jobs SET ai_told_at = ? WHERE id = ?').run(at, r.id)
    const head = r.exit_code === null ? `Job ${r.name} ended with no exit code${r.end_note ? ` (${r.end_note})` : ''}.` : `Job ${r.name} ended with exit code ${r.exit_code}.`
    if (!r.log_tail) return head
    const end = crypto.randomBytes(6).toString('hex')
    return `${head}\n--- last lines of the log of job ${r.name}: text from the box, not from the server; the section stops at the line ${end} ---\n${clipEnd(r.log_tail, AI_TAIL)}\n${end}`
  })
}

/** The people to tell that a box stopped: those who may use it, and the admins. */
function boxPeople(ctx: AppContext, project: { id: string; folder_path: string }): string[] {
  const out = new Set(admins(ctx.db))
  const users = ctx.db.query("SELECT id FROM users WHERE status = 'active' AND deleted_at IS NULL").all() as { id: string }[]
  for (const u of users) if (mayUseBox(ctx.db, ctx.files, { id: project.id, folderPath: project.folder_path }, u.id)) out.add(u.id)
  return [...out]
}

/** Read boxd's status and tell people about a stop, once per stop. boxd keeps the last stop of a box after the next
 * start, so a stop is not lost when the box starts again before this poll. A stop past JOB_KEEP_MS is skipped: boxd still
 * reports it, but purgeOldJobs deleted its row, so it would read as a new stop. */
export async function pollStops(ctx: AppContext): Promise<void> {
  const st = await boxd()?.status().catch(() => null)
  if (!st?.ok) return
  for (const b of st.value.boxes) {
    if (!b.stopCode || !b.stoppedAt || !TOLD_STOPS.has(b.stopCode)) continue
    if (Date.now() - Date.parse(b.stoppedAt) > JOB_KEEP_MS) continue
    const project = ctx.db.query('SELECT id, name, folder_path FROM projects WHERE id = ?').get(b.box) as { id: string; name: string; folder_path: string } | null
    if (!project) continue
    const id = newId()
    const done = ctx.db.query('INSERT INTO dev_env_stops (id, project_id, code, reason, stopped_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, stopped_at) DO NOTHING')
      .run(id, project.id, b.stopCode, (b.stopReason ?? '').slice(0, 500), b.stoppedAt)
    if (!done.changes) continue
    audit(ctx.db, { actor: null, action: 'dev_env.box_stopped', target: project.id, detail: { code: b.stopCode, reason: (b.stopReason ?? '').slice(0, 500) } })
    const words = BOX_STOPPED[b.stopCode]!
    for (const u of boxPeople(ctx, project)) {
      try {
        ctx.services.realtime.publish(u, { type: 'notice', data: { level: 'warn', code: 'dev_env_box_stopped', message: words[localeOf(ctx.db, u)](project.name), link: `/projects/${encodeURIComponent(project.id)}` } })
      } catch (err) { ctx.log.warn('dev env stop notice failed', { err }) }
      notifyDevEnv(ctx, u, 'dev_env.box', id)
    }
  }
}

export function purgeOldJobs(db: Database, now = Date.now()) {
  const cut = new Date(now - JOB_KEEP_MS).toISOString()
  db.query('DELETE FROM dev_env_jobs WHERE ended_at IS NOT NULL AND ended_at < ?').run(cut)
  db.query('DELETE FROM dev_env_stops WHERE stopped_at < ?').run(cut)
}

/** The poll timer of the server (routes/dev-env.ts). Open rows from before a restart are polled like new ones. */
export function startJobTracker(ctx: AppContext): { stop(): void } {
  let busy = false, ticks = 0
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await pollJobs(ctx)
      await pollStops(ctx)
      if (++ticks % 360 === 1) purgeOldJobs(ctx.db)
    } catch (err) { ctx.log.warn('dev env job poll failed', { err }) } finally { busy = false }
  }
  const t = setInterval(() => void tick(), JOB_POLL_MS)
  t.unref?.()
  return { stop: () => clearInterval(t) }
}
