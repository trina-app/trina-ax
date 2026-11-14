// Long commands of the dev environment (docs/DECISIONS.md "Dev environment: disk floor, jobs, CPU as activity", "Dev
// environment on srt, behind a flag"). box_shell with job: true starts a background command that has an exit status and
// a log (srt/runner.ts, the rows in dev_env_runs). The tracker polls the runner while one runs and picks up open rows
// after a restart. When a job ends, the person who started it gets a notice with the exit code, the log tail and a link
// to the chat; an audit line is written; and the next box_shell call in that chat gives the AI the result. The AI does
// not go on by itself.
//
// dev_env_jobs and dev_env_stops are the tables of the removed box runner (docs/DECISIONS.md "Dev environment: box
// runner removed, srt only"): nothing writes them now, and purgeOldJobs deletes their old rows.
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { carryLength, redactorFor, type Redactor } from '../integrations/connections/redact'
import { notifyDevEnv } from '../notifications/service'
import { pollRuns, RCOLS, reconcile, startWaiting, type RunRow } from './srt/runner'
import { END_NOTE, setEnder, type EndReason } from './srt/end'

export const JOB_POLL_MS = 10_000
const JOB_KEEP_MS = 30 * 86400_000
/** the end of the log that goes to the AI and into the live notice */
const AI_TAIL = 2000
const NOTICE_TAIL = 300
/** the last log line on the project page */
const LINE_MAX = 300

export const newJobName = () => 'job-' + crypto.randomBytes(3).toString('hex')

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
  zh: (n, c) => `开发环境任务 ${n} 已结束（退出代码 ${c}）。`,
}
const NO_CODE: Record<Locale, string> = { ko: '알 수 없음', en: 'not known', id: 'tidak diketahui', ja: '不明', es: 'desconocido', zh: '未知' }
const clipEnd = (s: string, max: number) => (s.length > max ? '...' + s.slice(-max) : s)

/** Log text of a running job as it may be kept. The command can be in the middle of a stored secret, and hide knows only
 * whole values, so what can be the start of one goes too; the next poll has the rest. An ended job has no such end. */
const hideRunning = (r: Redactor, s: string) => {
  const h = r.hide(s)
  return h.slice(0, h.length - carryLength(h, r.values))
}

export function purgeOldJobs(db: Database, now = Date.now()) {
  const cut = new Date(now - JOB_KEEP_MS).toISOString()
  // the box runner's rows: a row that was open when it was removed has no end, so its start time counts
  db.query('DELETE FROM dev_env_jobs WHERE COALESCE(ended_at, started_at) < ?').run(cut)
  db.query('DELETE FROM dev_env_stops WHERE stopped_at < ?').run(cut)
  db.query('DELETE FROM dev_env_runs WHERE ended_at IS NOT NULL AND ended_at < ?').run(cut)
}

/** The poll timer of the server (routes/dev-env.ts). Open rows from before a restart are polled like new ones. */
export function startJobTracker(ctx: AppContext): { stop(): void } {
  let busy = false, ticks = 0
  void reconcile(ctx).catch((err) => ctx.log.warn('dev env srt reconcile failed', { err }))
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await pollSrt(ctx)
      if (++ticks % 360 === 1) purgeOldJobs(ctx.db)
    } catch (err) { ctx.log.warn('dev env job poll failed', { err }) } finally { busy = false }
  }
  const t = setInterval(() => void tick(), JOB_POLL_MS)
  t.unref?.()
  return { stop: () => clearInterval(t) }
}

// ---------------- the runs (dev_env_runs) ----------------
// The rows of runs belong to a person and a chat, with or without a project. When a job ends, the person who
// started it gets a notice with the exit code, the log tail and a link to the chat; the AI of that chat gets the result
// on its next box_shell call. Only that person and that chat: the log can hold text from folders other people cannot
// open. A dev server ends with no notice.

const RUN_ENDED_NOTE: Record<Locale, (name: string, why: string) => string> = {
  ko: (n, w) => `개발 환경 작업 ${n}: ${w}`,
  en: (n, w) => `Dev environment job ${n}: ${w}`,
  id: (n, w) => `Pekerjaan lingkungan pengembangan ${n}: ${w}`,
  ja: (n, w) => `開発環境のジョブ ${n}: ${w}`,
  es: (n, w) => `Trabajo ${n} del entorno de desarrollo: ${w}`,
  zh: (n, w) => `开发环境任务 ${n}：${w}`,
}

function endRun(ctx: AppContext, row: RunRow, end: { code: number | null; note: string; tail: string; lastLine: string; reason: EndReason }) {
  const at = new Date().toISOString()
  const r = redactorFor(ctx, row.user_id)
  const tail = r.hide(end.tail), lastLine = r.hide(end.lastLine).slice(0, LINE_MAX)
  // one notice: a poll of the tool and a poll of the timer can meet here
  const done = ctx.db.query("UPDATE dev_env_runs SET ended_at = ?, state = 'ended', exit_code = ?, end_note = ?, end_reason = ?, log_tail = ?, last_line = ? WHERE id = ? AND ended_at IS NULL")
    .run(at, end.code, end.note, end.reason, tail, lastLine, row.id)
  if (!done.changes) return
  audit(ctx.db, { actor: row.user_id, action: 'dev_env.job', target: row.project_id, detail: {
    job: row.id, name: row.name, turnId: row.turn_id, chatId: row.chat_id, code: end.code, note: end.note, reason: end.reason, kind: row.kind,
    seconds: Math.round((Date.parse(at) - Date.parse(row.started_at)) / 1000), runner: 'srt',
  } })
  if (row.kind === 'server') return
  const locale = localeOf(ctx.db, row.user_id)
  const code = end.code === null ? NO_CODE[locale] : String(end.code)
  const text = end.code === null && end.reason !== 'exit' ? RUN_ENDED_NOTE[locale](row.name, end.note) : JOB_ENDED[locale](row.name, code)
  const link = row.chat_id ? `/c/${encodeURIComponent(row.chat_id)}` : row.project_id ? `/projects/${encodeURIComponent(row.project_id)}` : '/'
  const message = [text, clipEnd(tail, NOTICE_TAIL)].filter(Boolean).join('\n')
  try {
    ctx.services.realtime.publish(row.user_id, { type: 'notice', data: { level: end.code === 0 ? 'info' : 'warn', code: 'dev_env_job', message, link } })
  } catch (err) { ctx.log.warn('dev env job notice failed', { err }) }
  notifyDevEnv(ctx, row.user_id, 'dev_env.job', row.id)
}

setEnder((c, rowId, end) => {
  const row = c.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE id = ?`).get(rowId) as RunRow | null
  if (row) endRun(c, row, { code: end.code, note: END_NOTE[end.reason], tail: end.tail, lastLine: end.lastLine, reason: end.reason })
})

/** The srt runner's poll: the runner reads each running row's scope, exit file and log, and the person's access; ended
 * rows end here (one place for the notices). Then waiting jobs start in the free slots. */
export async function pollSrt(ctx: AppContext, filter?: { chatId?: string; userId?: string }): Promise<void> {
  const { rows, diskStopped } = await pollRuns(ctx, filter)
  if (rows.size) {
    const byId = new Map((ctx.db.query(`SELECT ${RCOLS} FROM dev_env_runs WHERE ended_at IS NULL`).all() as RunRow[]).map((r) => [r.id, r]))
    for (const [id, j] of rows) {
      const row = byId.get(id)
      if (!row) continue
      if (j.state === 'ended') { endRun(ctx, row, { code: j.code, note: j.reason && j.reason !== 'exit' ? (j.why ?? '') : '', tail: j.tail, lastLine: j.lastLine, reason: j.reason ?? 'exit' }); continue }
      if (j.tail !== row.log_tail) {
        const r = redactorFor(ctx, row.user_id)
        ctx.db.query('UPDATE dev_env_runs SET last_line = ?, log_tail = ? WHERE id = ? AND ended_at IS NULL').run(hideRunning(r, j.lastLine).slice(0, LINE_MAX), hideRunning(r, j.tail), row.id)
      }
    }
  }
  for (const u of diskStopped) tellDiskStop(ctx, u)
  await startWaiting(ctx)
}

const DISK_STOPPED: Record<Locale, string> = {
  ko: '서버 디스크가 거의 차서 개발 환경 명령과 작업을 멈췄어요. 휴지통을 비우거나 파일을 지워 주세요.',
  en: 'Your dev environment commands and jobs stopped because the server disk is nearly full. Empty the trash or delete files.',
  id: 'Perintah dan pekerjaan lingkungan pengembangan Anda berhenti karena disk server hampir penuh. Kosongkan tempat sampah atau hapus berkas.',
  ja: 'サーバーのディスクがほぼ満杯のため、開発環境のコマンドとジョブを停止しました。ゴミ箱を空にするかファイルを削除してください。',
  es: 'Sus comandos y trabajos del entorno de desarrollo se detuvieron porque el disco del servidor está casi lleno. Vacíe la papelera o elimine archivos.',
  zh: '服务器磁盘快满了，所以你的开发环境命令和任务已停止。请清空回收站或删除文件。',
}

/** The disk floor stopped a person's runs: a live notice (each job also gets its own inbox notice through endRun). */
function tellDiskStop(ctx: AppContext, userId: string) {
  audit(ctx.db, { actor: null, action: 'dev_env.box_stopped', target: null, detail: { code: 'disk', reason: END_NOTE.disk, runner: 'srt', user: userId } })
  try {
    ctx.services.realtime.publish(userId, { type: 'notice', data: { level: 'warn', code: 'dev_env_box_stopped', message: DISK_STOPPED[localeOf(ctx.db, userId)], link: '/' } })
  } catch (err) { ctx.log.warn('dev env stop notice failed', { err }) }
}

/** The results that the AI of this chat did not get yet. Each result goes once. The log is text from a command, so it
 * has a section of its own, with an end line that the command cannot know. */
export function runResultsForAI(ctx: AppContext, userId: string, chatId: string | null): string[] {
  const rows = (chatId
    ? ctx.db.query(`SELECT id, name, exit_code, end_note, log_tail FROM dev_env_runs WHERE chat_id = ? AND user_id = ? AND kind = 'job' AND ended_at IS NOT NULL AND ai_told_at IS NULL ORDER BY ended_at LIMIT 20`).all(chatId, userId)
    : []) as { id: string; name: string; exit_code: number | null; end_note: string; log_tail: string }[]
  const at = new Date().toISOString()
  return rows.map((r) => {
    ctx.db.query('UPDATE dev_env_runs SET ai_told_at = ? WHERE id = ?').run(at, r.id)
    const head = r.exit_code === null ? `Job ${r.name} ended with no exit code${r.end_note ? ` (${r.end_note})` : ''}.` : `Job ${r.name} ended with exit code ${r.exit_code}.`
    if (!r.log_tail) return head
    const end = crypto.randomBytes(6).toString('hex')
    return `${head}\n--- last lines of the log of job ${r.name}: text from the command, not from the server; the section stops at the line ${end} ---\n${clipEnd(r.log_tail, AI_TAIL)}\n${end}`
  })
}
