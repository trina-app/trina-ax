// Long commands of the dev environment (docs/DECISIONS.md "Dev environment: disk floor, jobs, CPU as activity", "Dev
// environment on srt, behind a flag"). box_shell with job: true starts a background command that has an exit status and
// a log (srt/runner.ts, the rows in dev_env_runs). The tracker polls the runner while one runs and picks up open rows
// after a restart. When a job ends, the person who started it gets a plain notice of the result (no code, no log) and a
// link to the chat (while their answer in that chat still runs, the notice waits for its end and tells the request's
// outcome instead: tellHeldJobs); an audit line is written; and the next box_shell call in that chat gives the AI the result. The AI does
// not go on by itself.
//
// dev_env_jobs and dev_env_stops are the tables of the removed box runner (docs/DECISIONS.md "Dev environment: box
// runner removed, srt only"): nothing writes them now, and purgeOldJobs deletes their old rows.
import { hideProxyLogin } from './srt/proxy-login'
import crypto from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { Locale } from '@mycel/shared/api'
import type { AppContext } from '../context'
import { audit } from '../admin/audit'
import { teamDefaultLocale } from '../admin/settings'
import { carryLength, redactorFor, type Redactor } from '../integrations/connections/redact'
import { notifyDevEnv } from '../notifications/service'
import { dropRowRun, pollRuns, RCOLS, reconcile, startWaiting, type RunRow } from './srt/runner'
import { END_NOTE, setEnder, type EndReason } from './srt/end'
import { REQUEST_SOURCE, requestOutcome, type RequestOutcome, type RequestStop } from './request-outcome'
export { REQUEST_SOURCE, requestOutcome, type RequestOutcome, type RequestStop }

export const JOB_POLL_MS = 10_000
const JOB_KEEP_MS = 30 * 86400_000
/** the end of the log that goes to the AI */
const AI_TAIL = 2000
/** the last log line on the project page */
const LINE_MAX = 300

export const newJobName = () => 'job-' + crypto.randomBytes(3).toString('hex')

function localeOf(db: Database, userId: string): Locale {
  const v = Locale.safeParse((db.query('SELECT locale FROM users WHERE id = ?').get(userId) as { locale: string } | null)?.locale)
  return v.success ? v.data : teamDefaultLocale(db)
}

/** What the person who started a job hears when it ends (the live notice): the result in plain words, about the chat they
 * asked in. No command or job name, no exit code, no log: the people are not developers, and the log stays for the AI
 * of that chat (runResultsForAI) and the chat's step details. A chat title is the person's own words. */
export const JOB_DONE: Record<Locale, (title: string) => string> = {
  ko: (t) => `‘${t}’에서 부탁한 작업을 트리나가 마쳤어요.`,
  en: (t) => `Trina finished the job you asked for in “${t}”.`,
  id: (t) => `Trina sudah menyelesaikan pekerjaan yang Anda minta di “${t}”.`,
  ja: (t) => `「${t}」で頼んだ作業をトリナが終えました。`,
  es: (t) => `Trina terminó el trabajo que pidió en «${t}».`,
  zh: (t) => `你在“${t}”中交给 Trina 的任务已完成。`,
}
export const JOB_FAILED: Record<Locale, (title: string) => string> = {
  ko: (t) => `‘${t}’에서 부탁한 작업을 트리나가 끝내지 못했어요. 채팅에서 확인해 보세요.`,
  en: (t) => `Trina couldn't finish the job you asked for in “${t}”. Check the chat.`,
  id: (t) => `Trina tidak bisa menyelesaikan pekerjaan yang Anda minta di “${t}”. Lihat di obrolan.`,
  ja: (t) => `「${t}」で頼んだ作業をトリナが終えられませんでした。チャットで確認してください。`,
  es: (t) => `Trina no pudo terminar el trabajo que pidió en «${t}». Revíselo en el chat.`,
  zh: (t) => `你在“${t}”中交给 Trina 的任务没能完成。请在对话中查看。`,
}
/** A job that ended by itself with no exit code the server could read (end reason "lost"): it ended, and whether it
 * worked is not known. Not told as a failure: its log may well show it finished (QA TC-6586). */
export const JOB_UNKNOWN: Record<Locale, (title: string) => string> = {
  ko: (t) => `‘${t}’에서 부탁한 작업이 끝났지만, 잘 됐는지는 트리나가 알 수 없어요. 채팅에서 확인해 보세요.`,
  en: (t) => `The job you asked for in “${t}” has ended, but Trina can't tell whether it worked. Check the chat.`,
  id: (t) => `Pekerjaan yang Anda minta di “${t}” sudah berakhir, tetapi Trina tidak tahu apakah berhasil. Lihat di obrolan.`,
  ja: (t) => `「${t}」で頼んだ作業は終わりましたが、うまくいったかどうかトリナには分かりません。チャットで確認してください。`,
  es: (t) => `El trabajo que pidió en «${t}» terminó, pero Trina no sabe si salió bien. Revíselo en el chat.`,
  zh: (t) => `你在“${t}”中交给 Trina 的任务已结束，但 Trina 无法确定是否成功。请在对话中查看。`,
}
/** a job of a chat that is gone (or has no title): the same words with no chat */
export const JOB_DONE_NO_CHAT: Record<Locale, string> = {
  ko: '부탁한 작업을 트리나가 마쳤어요.',
  en: 'Trina finished a job you asked for.',
  id: 'Trina sudah menyelesaikan pekerjaan yang Anda minta.',
  ja: '頼んだ作業をトリナが終えました。',
  es: 'Trina terminó un trabajo que pidió.',
  zh: '你交给 Trina 的任务已完成。',
}
export const JOB_FAILED_NO_CHAT: Record<Locale, string> = {
  ko: '부탁한 작업을 트리나가 끝내지 못했어요.',
  en: "Trina couldn't finish a job you asked for.",
  id: 'Trina tidak bisa menyelesaikan pekerjaan yang Anda minta.',
  ja: '頼んだ作業をトリナが終えられませんでした。',
  es: 'Trina no pudo terminar un trabajo que pidió.',
  zh: '你交给 Trina 的任务没能完成。',
}
export const JOB_UNKNOWN_NO_CHAT: Record<Locale, string> = {
  ko: '부탁한 작업이 끝났지만, 잘 됐는지는 트리나가 알 수 없어요.',
  en: "A job you asked for has ended, but Trina can't tell whether it worked.",
  id: 'Pekerjaan yang Anda minta sudah berakhir, tetapi Trina tidak tahu apakah berhasil.',
  ja: '頼んだ作業は終わりましたが、うまくいったかどうかトリナには分かりません。',
  es: 'Un trabajo que pidió terminó, pero Trina no sabe si salió bien.',
  zh: '你交给 Trina 的任务已结束，但 Trina 无法确定是否成功。',
}
/** How a job ended for the people: done (exit code 0), unknown (it ended by itself with no code the server could read)
 * or failed (any other code, or a stop: a limit, a person, the queue) */
export type JobOutcome = 'done' | 'unknown' | 'failed'
export const jobOutcome = (code: number | null, reason: string | null | undefined): JobOutcome =>
  code === 0 ? 'done' : code === null && (!reason || reason === 'exit' || reason === 'lost') ? 'unknown' : 'failed'
/** the live notice's words */
export function jobNoticeText(locale: Locale, o: JobOutcome, chatTitle: string | null): string {
  const title = chatTitle?.trim()
  if (title) return (o === 'done' ? JOB_DONE : o === 'unknown' ? JOB_UNKNOWN : JOB_FAILED)[locale](title)
  return (o === 'done' ? JOB_DONE_NO_CHAT : o === 'unknown' ? JOB_UNKNOWN_NO_CHAT : JOB_FAILED_NO_CHAT)[locale]
}
const clipEnd = (s: string, max: number) => (s.length > max ? '...' + s.slice(-max) : s)

/** Log text of a running job as it may be kept. The command can be in the middle of a stored secret, and hide knows only
 * whole values, so what can be the start of one goes too; the next poll has the rest. An ended job has no such end. */
const hideRunning = (r: Redactor, s: string) => {
  // srt's proxy login too (srt/proxy-login.ts): the lists show the tail to other people
  const h = hideProxyLogin(r.hide(s))
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
      tellHeldJobs(ctx)
      if (++ticks % 360 === 1) purgeOldJobs(ctx.db)
    } catch (err) { ctx.log.warn('dev env job poll failed', { err }) } finally { busy = false }
  }
  const t = setInterval(() => void tick(), JOB_POLL_MS)
  t.unref?.()
  return { stop: () => clearInterval(t) }
}

// ---------------- the runs (dev_env_runs) ----------------
// The rows of runs belong to a person and a chat, with or without a project. When a job ends, the person who
// started it gets a plain notice of the result (done or not) with a link to the chat; the AI of that chat gets the result
// on its next box_shell call. Only that person and that chat: the log can hold text from folders other people cannot
// open. A shared chat's job saw only what everyone in the chat may open: its result goes to the next box_shell call of
// anyone in that chat while the people and their view are the same (runResultsForAI sharedKey). A dev server ends with
// no notice.

function endRun(ctx: AppContext, row: RunRow, end: { code: number | null; note: string; tail: string; lastLine: string; reason: EndReason }) {
  const at = new Date().toISOString()
  const r = redactorFor(ctx, row.user_id)
  const tail = hideProxyLogin(r.hide(end.tail)), lastLine = hideProxyLogin(r.hide(end.lastLine)).slice(0, LINE_MAX)
  // one notice: a poll of the tool and a poll of the timer can meet here
  const done = ctx.db.query("UPDATE dev_env_runs SET ended_at = ?, state = 'ended', exit_code = ?, end_note = ?, end_reason = ?, log_tail = ?, last_line = ? WHERE id = ? AND ended_at IS NULL")
    .run(at, end.code, end.note, end.reason, tail, lastLine, row.id)
  if (!done.changes) return
  // a shared chat's run: its own home and temp folder go now (its log stays in the chat's folder for its people)
  dropRowRun(row)
  audit(ctx.db, { actor: row.user_id, action: 'dev_env.job', target: row.project_id, detail: {
    job: row.id, name: row.name, turnId: row.turn_id, chatId: row.chat_id, code: end.code, note: end.note, reason: end.reason, kind: row.kind,
    seconds: Math.round((Date.parse(at) - Date.parse(row.started_at)) / 1000), runner: 'srt',
  } })
  if (row.kind === 'server') return
  // a step of an answer that is still going (QA: "‘…’에서 부탁한 작업을 트리나가 마쳤어요." at 00:55Z on 11-22 while the
  // answer went on for long after): the AI gets the result on its next box_shell call, and the person hears about the
  // request when the answer ends (tellHeldJobs), never "done" for one step of it
  if (answerRunning(ctx, row.user_id, row.chat_id, row.turn_id)) return
  tellJob(ctx, row, end.code, end.reason)
}

/** The live notice and the Activity row of one job's own result (done, unknown, failed). */
function tellJob(ctx: AppContext, row: Pick<RunRow, 'id' | 'user_id' | 'chat_id' | 'project_id'>, code: number | null, reason: string | null) {
  // the chat's title while it is there (the person started the job in it); the toast opens the chat
  const chat = row.chat_id ? ctx.db.query('SELECT title FROM chats WHERE id = ? AND deleted_at IS NULL').get(row.chat_id) as { title: string } | null : null
  const outcome = jobOutcome(code, reason)
  const message = jobNoticeText(localeOf(ctx.db, row.user_id), outcome, chat?.title ?? null)
  const link = chat ? `/c/${encodeURIComponent(row.chat_id!)}` : row.project_id ? `/projects/${encodeURIComponent(row.project_id)}` : '/'
  try {
    ctx.services.realtime.publish(row.user_id, { type: 'notice', data: { level: outcome === 'failed' ? 'warn' : 'info', code: 'dev_env_job', message, link } })
  } catch (err) { ctx.log.warn('dev env job notice failed', { err }) }
  notifyDevEnv(ctx, row.user_id, 'dev_env.job', row.id)
}

// ---------------- the request a job was a step of ----------------
// A job the AI started inside an answer (box_shell job: true) is a step of that answer. While an answer of the same
// person is queued or running in the job's chat (the one that started it, or the next one), its end tells the person
// nothing: the AI reads the result and goes on. When the chat's answers have ended, one notice says how the request
// ended, from the answer that was running when the job ended: done only when that answer finished; else stopped, with
// why. Its Activity row is a dev_env_notices row 'dev_env.job' whose source is REQUEST_SOURCE + the answer's turn id
// (one per answer, no migration). A job that ends after its answer ended keeps its own notice (endRun).

/** how far back the backstop looks for a job whose answer's end was not seen (a restart cut the answer off) */
const HELD_LOOKBACK_MS = 2 * 86400_000

/** Has this person an answer queued or running in this chat (or is the job's own answer still going)? */
function answerRunning(ctx: AppContext, userId: string, chatId: string | null, turnId: string | null): boolean {
  if (turnId && ctx.db.query("SELECT 1 FROM turns WHERE id = ? AND status IN ('queued','running')").get(turnId)) return true
  return !!chatId && !!ctx.db.query("SELECT 1 FROM turns WHERE chat_id = ? AND user_id = ? AND status IN ('queued','running') LIMIT 1").get(chatId, userId)
}

export const REQUEST_DONE = JOB_DONE
export const REQUEST_DONE_NO_CHAT = JOB_DONE_NO_CHAT
export const REQUEST_STOPPED: Record<Locale, (title: string, why: string) => string> = {
  ko: (t, w) => `‘${t}’에서 부탁한 작업이 멈췄어요 — ${w}`,
  en: (t, w) => `The job you asked for in “${t}” stopped: ${w}`,
  id: (t, w) => `Pekerjaan yang Anda minta di “${t}” berhenti: ${w}`,
  ja: (t, w) => `「${t}」で頼んだ作業が止まりました — ${w}`,
  es: (t, w) => `El trabajo que pidió en «${t}» se detuvo: ${w}`,
  zh: (t, w) => `你在“${t}”中交给 Trina 的任务停下了：${w}`,
}
export const REQUEST_STOPPED_NO_CHAT: Record<Locale, (why: string) => string> = {
  ko: (w) => `부탁한 작업이 멈췄어요 — ${w}`,
  en: (w) => `A job you asked for stopped: ${w}`,
  id: (w) => `Pekerjaan yang Anda minta berhenti: ${w}`,
  ja: (w) => `頼んだ作業が止まりました — ${w}`,
  es: (w) => `Un trabajo que pidió se detuvo: ${w}`,
  zh: (w) => `你交给 Trina 的任务停下了：${w}`,
}
export const REQUEST_WHY: Record<Locale, Record<RequestStop, string>> = {
  ko: { limit: '한 번에 할 수 있는 단계나 시간 한도에 닿았어요. 채팅에서 이어서 부탁해 보세요.', error: '오류가 났어요. 채팅에서 확인해 보세요.', stopped: '멈춤을 눌렀어요.', restart: '서버가 다시 시작됐어요. 채팅에서 다시 부탁해 보세요.', question: '트리나가 채팅에서 답을 기다려요.' },
  en: { limit: 'it reached the step or time limit of one answer. Ask again in the chat to go on.', error: 'something went wrong. Check the chat.', stopped: 'Stop was pressed.', restart: 'the server restarted. Ask again in the chat.', question: 'Trina is waiting for your answer in the chat.' },
  id: { limit: 'sudah mencapai batas langkah atau waktu untuk satu jawaban. Minta lagi di obrolan untuk melanjutkan.', error: 'terjadi kesalahan. Lihat di obrolan.', stopped: 'tombol Berhenti ditekan.', restart: 'server dimulai ulang. Minta lagi di obrolan.', question: 'Trina menunggu jawaban Anda di obrolan.' },
  ja: { limit: '1回の回答でできるステップか時間の上限に達しました。チャットで続きを頼んでください。', error: 'エラーが起きました。チャットで確認してください。', stopped: '停止が押されました。', restart: 'サーバーが再起動しました。チャットでもう一度頼んでください。', question: 'トリナがチャットで返事を待っています。' },
  es: { limit: 'llegó al límite de pasos o de tiempo de una respuesta. Pídalo de nuevo en el chat para seguir.', error: 'algo salió mal. Revíselo en el chat.', stopped: 'se pulsó Detener.', restart: 'el servidor se reinició. Pídalo de nuevo en el chat.', question: 'Trina espera su respuesta en el chat.' },
  zh: { limit: '已达到单次回答的步骤或时间上限。请在对话中让它继续。', error: '出错了。请在对话中查看。', stopped: '已按下停止。', restart: '服务器重启了。请在对话中再说一次。', question: 'Trina 在对话中等你的回复。' },
}
/** the live notice's words for a request */
export function requestNoticeText(locale: Locale, o: RequestOutcome, chatTitle: string | null): string {
  const title = chatTitle?.trim()
  if (o.outcome === 'done') return title ? REQUEST_DONE[locale](title) : REQUEST_DONE_NO_CHAT[locale]
  const why = REQUEST_WHY[locale][o.reason]
  return title ? REQUEST_STOPPED[locale](title, why) : REQUEST_STOPPED_NO_CHAT[locale](why)
}

/** Jobs whose end was held while an answer ran: once their chat has no answer of that person queued or running, one
 * notice per answer that was running when they ended (the request's outcome), or, with no such answer (its row is
 * gone), the job's own notice. Called at each answer's end (chat/turn.ts) for its chat, and by the tracker's poll for
 * all chats (an answer a restart cut off). Each job and each answer is told once: the notice row is the mark. */
export function tellHeldJobs(ctx: AppContext, chatId?: string, now = Date.now()) {
  const since = new Date(now - HELD_LOOKBACK_MS).toISOString()
  // ended jobs of a chat with no notice of their own, of an active person, with no answer of theirs going in that chat
  const rows = ctx.db.query(`SELECT r.id, r.user_id, r.chat_id, r.project_id, r.exit_code, r.end_reason, r.ended_at FROM dev_env_runs r JOIN users u ON u.id = r.user_id AND u.status = 'active' AND u.deleted_at IS NULL
    WHERE r.kind = 'job' AND r.chat_id IS NOT NULL ${chatId ? 'AND r.chat_id = ?' : ''} AND r.ended_at IS NOT NULL AND r.ended_at >= ?
      AND NOT EXISTS (SELECT 1 FROM dev_env_notices n WHERE n.user_id = r.user_id AND n.event_type = 'dev_env.job' AND n.source_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.chat_id = r.chat_id AND t.user_id = r.user_id AND t.status IN ('queued','running'))
    ORDER BY r.ended_at`).all(...(chatId ? [chatId, since] : [since])) as { id: string; user_id: string; chat_id: string; project_id: string | null; exit_code: number | null; end_reason: string; ended_at: string }[]
  const told = new Set<string>()
  for (const r of rows) {
    // the answer that was running when the job ended: the first of that person's in that chat to end after it
    const t = ctx.db.query("SELECT id FROM turns WHERE chat_id = ? AND user_id = ? AND started_at <= ? AND ended_at >= ? AND status IN ('done','error','stopped','interrupted') ORDER BY ended_at LIMIT 1")
      .get(r.chat_id, r.user_id, r.ended_at, r.ended_at) as { id: string } | null
    if (!t) { tellJob(ctx, r, r.exit_code, r.end_reason); continue }
    const source = REQUEST_SOURCE + t.id
    if (told.has(source) || ctx.db.query("SELECT 1 FROM dev_env_notices WHERE user_id = ? AND event_type = 'dev_env.job' AND source_id = ?").get(r.user_id, source)) continue
    told.add(source)
    const o = requestOutcome(ctx.db, t.id)
    if (!o) continue
    const chat = ctx.db.query('SELECT title FROM chats WHERE id = ? AND deleted_at IS NULL').get(r.chat_id) as { title: string } | null
    const message = requestNoticeText(localeOf(ctx.db, r.user_id), o, chat?.title ?? null)
    const link = chat ? `/c/${encodeURIComponent(r.chat_id)}` : '/'
    try {
      ctx.services.realtime.publish(r.user_id, { type: 'notice', data: { level: o.outcome === 'done' ? 'info' : 'warn', code: 'dev_env_job', message, link } })
    } catch (err) { ctx.log.warn('dev env request notice failed', { err }) }
    notifyDevEnv(ctx, r.user_id, 'dev_env.job', source)
  }
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

/** Are there results of a shared chat's jobs of these people and view that its AI did not get yet? */
export const pendingShared = (ctx: AppContext, chatId: string | null, sharedKey: string) =>
  !!chatId && !!ctx.db.query("SELECT 1 FROM dev_env_runs WHERE chat_id = ? AND shared_key = ? AND kind = 'job' AND ended_at IS NOT NULL AND ai_told_at IS NULL LIMIT 1").get(chatId, sharedKey)

/** The results that the AI of this chat did not get yet. Each result goes once. The log is text from a command, so it
 * has a section of its own, with an end line that the command cannot know. `sharedKey`: a shared chat's turn, which gets
 * the results of that chat's jobs of the same people and view (srt/runner.ts sharedLogKey), whoever started them; a job
 * of other people (someone joined since, or someone's access narrowed) is not told there. */
export function runResultsForAI(ctx: AppContext, userId: string, chatId: string | null, sharedKey?: string): string[] {
  const rows = (!chatId ? []
    : sharedKey ? ctx.db.query(`SELECT id, name, exit_code, end_note, end_reason, log_tail FROM dev_env_runs WHERE chat_id = ? AND shared_key = ? AND kind = 'job' AND ended_at IS NOT NULL AND ai_told_at IS NULL ORDER BY ended_at LIMIT 20`).all(chatId, sharedKey)
    : ctx.db.query(`SELECT id, name, exit_code, end_note, end_reason, log_tail FROM dev_env_runs WHERE chat_id = ? AND user_id = ? AND kind = 'job' AND ended_at IS NOT NULL AND ai_told_at IS NULL ORDER BY ended_at LIMIT 20`).all(chatId, userId)
  ) as { id: string; name: string; exit_code: number | null; end_note: string; end_reason: string; log_tail: string }[]
  const at = new Date().toISOString()
  return rows.map((r) => {
    ctx.db.query('UPDATE dev_env_runs SET ai_told_at = ? WHERE id = ?').run(at, r.id)
    // no code and no stop: it ended by itself and the server could not read how; the log is what is known (QA TC-6586)
    const head = r.exit_code !== null ? `Job ${r.name} ended with exit code ${r.exit_code}.`
      : jobOutcome(null, r.end_reason) === 'unknown' ? `Job ${r.name} ended, but its exit code is unknown (the server could not read it). Judge from the end of its log whether it finished; do not call it failed only for that.`
      : `Job ${r.name} ended with no exit code${r.end_note ? ` (${r.end_note})` : ''}.`
    if (!r.log_tail) return head
    const end = crypto.randomBytes(6).toString('hex')
    return `${head}\n--- last lines of the log of job ${r.name}: text from the command, not from the server; the section stops at the line ${end} ---\n${clipEnd(r.log_tail, AI_TAIL)}\n${end}`
  })
}
