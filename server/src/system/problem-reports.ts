// Problem reports (docs/decisions/20261126-problem-reports.md; wire format shared/src/cloud-protocol/problem-report.ts):
// a person writes what went wrong ("문제 신고" in Settings › About, or 👎 under an AI answer) and this server sends it,
// signed with its relay team key, to the hosting service's intake, which posts it into the operators' own room.
//
// What leaves is an allow-list, built here (buildProblemReport): the person's words; the client kind, version and OS
// family; this server's version and run kind; the engine and its pinned version; the locale; the kind of screen (a
// fixed word); from 👎 the turn id, the failure code (the codes error reports use) and the ids of the tools the answer
// used. Never a step label (labels name files and items), a name, a mail address, the team's name or a file name. The
// question and the answer go only when the person ticked it for this one report, and only from their own chat of one
// person (not a shared, project or side chat), each cut to the contract's cap.
// tests/unit/problem-reports.test.ts plants names and file names and checks no body holds them.
//
// Where: the edition's console host (SERVICE_HOSTS.accountHost), or MYCEL_PROBLEM_REPORT_URL (an origin; empty or "off"
// turns it off). MYCEL_PROBLEM_REPORTS=off removes the feature; an edition without a hosted service, a development
// server and a test app (NODE_ENV=test) have none unless the URL is set. The team switch (Admin › Team settings
// problemReports, on by default) hides the entry points and refuses here.
//
// Outbox: a report is stored (problem_reports) and answered at once; the sender posts it and tries again with backoff
// for up to 7 days. A 404 (an intake that takes no reports) and any other refusal (400, 403, 413) are final: the report
// is dropped. A 401 is tried once more at once with a new time and nonce. Once sent or dropped, the body is deleted;
// the row (id, person, times, state) goes after 30 days. Nothing of a report is logged.
import crypto, { type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { CHAT_ERROR_MESSAGES } from '@mycel/shared/api'
import { driveBrokerAuthorization } from '@mycel/shared/cloud-protocol/drive-broker'
import {
  parseProblemReport, PROBLEM_REPORT_ANSWER_MAX, PROBLEM_REPORT_MAX_BODY_BYTES, PROBLEM_REPORT_PATH, PROBLEM_REPORT_QUESTION_MAX,
  PROBLEM_REPORT_TOOLS_MAX, problemReportCut, problemReportSigningString,
  type ProblemReport, type ProblemReportClient, type ProblemReportOs, type ProblemReportScreen,
} from '@mycel/shared/cloud-protocol/problem-report'
import { SERVICE_HOSTS } from '@mycel/shared/service-hosts'
import { REPO_ROOT } from '../app-config'
import type { AppContext } from '../context'
import { newId } from '../db'
import { fail } from '../http/errors'
import { getTeamSettings } from '../admin/settings'
import { loadOrCreateKey } from '../relay-client/registration'
import { runKindOf } from './deployment'

export const PROBLEM_REPORTS_ENV = 'MYCEL_PROBLEM_REPORTS'
export const PROBLEM_REPORT_URL_ENV = 'MYCEL_PROBLEM_REPORT_URL'
/** per person and per team, in 24 hours */
export const PROBLEM_REPORTS_PER_PERSON = 5
export const PROBLEM_REPORTS_PER_TEAM = 30
/** waits before the 2nd, 3rd, ... try; the last one repeats until MAX_AGE_MS */
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000]
const MAX_AGE_MS = 7 * 24 * 3_600_000
const KEEP_MS = 30 * 24 * 3_600_000
const TICK_MS = 60_000
const DAY_MS = 24 * 3_600_000

export interface ProblemReportSink {
  origin: string
  identity: () => { key: KeyObject; publicKey: string }
  fetch?: typeof fetch
  now?: () => number
}

/** An operator's intake address as an origin: https, or http to this machine; never a path, query or credentials. */
export function intakeUrlOrigin(raw: string): string | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
  return u.origin
}

/** Where this server sends reports, or null: the feature is off here (see the header). */
export function problemReportIntake(ctx: Pick<AppContext, 'config'>, env: Record<string, string | undefined> = process.env): string | null {
  if ((env[PROBLEM_REPORTS_ENV] ?? '').trim().toLowerCase() === 'off') return null
  const set = env[PROBLEM_REPORT_URL_ENV]
  if (set !== undefined) { const v = set.trim(); return v && v !== 'off' ? intakeUrlOrigin(v) : null }
  if (env.NODE_ENV === 'test' || !SERVICE_HOSTS.accountHost || ctx.config.demo) return null
  if (runKindOf(ctx.config) === 'dev') return null
  return intakeUrlOrigin(`https://${SERVICE_HOSTS.accountHost}`)
}

interface State { sink?: ProblemReportSink | null; timer: ReturnType<typeof setTimeout> | null; running: Promise<void> | null; closed: boolean; again: boolean }
const states = new WeakMap<AppContext, State>()
function stateOf(ctx: AppContext): State {
  let s = states.get(ctx)
  if (!s) {
    const made: State = { timer: null, running: null, closed: false, again: false }
    ctx.onClose(() => { made.closed = true; if (made.timer) clearTimeout(made.timer) })
    states.set(ctx, s = made)
  }
  return s
}

/** tests: send through this sink (a fake intake) instead of the environment's; null = no intake */
export function setProblemReportSink(ctx: AppContext, sink: ProblemReportSink | null): void { stateOf(ctx).sink = sink }

function sinkOf(ctx: AppContext): ProblemReportSink | null {
  const s = stateOf(ctx)
  if (s.sink !== undefined) return s.sink
  const origin = problemReportIntake(ctx)
  return origin ? { origin, identity: () => { const { key, publicKey } = loadOrCreateKey(ctx.config.dataDir); return { key, publicKey } } } : null
}

/** Whether this server can send reports, and how the sheet words it: 'hosted' (a team the hosting service runs) or
 * 'self' (a self-installed server: the sheet says the report leaves it). null: no intake here. */
export function problemReportsWhere(ctx: AppContext): 'hosted' | 'self' | null {
  if (!sinkOf(ctx)) return null
  return runKindOf(ctx.config) === 'hosted' ? 'hosted' : 'self'
}

/** People may report now: the server can send and the team switch is on. */
export function problemReportsOn(ctx: AppContext): boolean {
  if (!problemReportsWhere(ctx)) return false
  try { return getTeamSettings(ctx.db).problemReports !== false } catch { return false }
}

/** What the web app sends: the words, where the person was, the app, and from 👎 the answer. */
export interface ProblemReportInput {
  text: string
  screen: ProblemReportScreen
  client: { kind: ProblemReportClient; version: string | null; os: ProblemReportOs }
  answer?: { messageId: string; withConversation: boolean }
}

const KNOWN_REASONS = new Set<string>([...Object.keys(CHAT_ERROR_MESSAGES), 'turn_memory_limit', 'turn_disk_limit'])
const ENGINE_RE = /^[a-z][a-z0-9-]{0,31}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/
const LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/

let pins: Record<string, unknown> | null | undefined
/** the engine version this build pins (versions.json), never a call to the CLI */
function engineVersion(engine: string): string | null {
  if (pins === undefined) { try { pins = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'versions.json'), 'utf8')) } catch { pins = null } }
  const v = pins?.[engine === 'codex' ? 'codex-cli' : engine]
  return typeof v === 'string' && VERSION_RE.test(v) ? v : null
}

interface MessageRow { id: string; chat_id: string; role: string; content: string; steps: string; error: string | null; turn_id: string | null; engine: string | null; parent_id: string | null }
interface ChatRowLite { user_id: string; project_id: string | null; room_id: string | null; shared_at: string | null; people_shared_at: string | null; side_room_id: string | null; deleted_at: string | null }

/** The tick "이 답변과 질문 함께 보내기" may be offered for this chat and answer: the person's own chat of one person
 * (not shared, not in a project, not a room's side chat) and their own question. */
export function conversationAllowed(chat: ChatRowLite, userId: string, turnUser: string | null): boolean {
  return chat.user_id === userId && !chat.project_id && !chat.room_id && !chat.shared_at && !chat.people_shared_at && !chat.side_room_id && !chat.deleted_at && (turnUser === null || turnUser === userId)
}

/** The report body from the allow-list (see the header). `canView` says whether the person may see the answer's chat
 * (the route checks it with the chat's own access rule); an answer they may not see is refused as not found. */
export function buildProblemReport(ctx: AppContext, userId: string, input: ProblemReportInput, locale: string, canView: (chatId: string) => boolean, id = newId()): ProblemReport {
  const run = runKindOf(ctx.config)
  const server = { version: VERSION_RE.test(ctx.version) ? ctx.version : '0.0.0', run }
  let engine: ProblemReport['engine'] = null
  let turnId: string | null = null, failure: string | null = null, tools: string[] = [], conversation: ProblemReport['conversation'] = null
  if (input.answer) {
    const m = ctx.db.query('SELECT id, chat_id, role, content, steps, error, turn_id, engine, parent_id FROM messages WHERE id = ?').get(input.answer.messageId) as MessageRow | null
    if (!m || m.role !== 'assistant' || !canView(m.chat_id)) fail('not_found')
    const msg = m!
    turnId = msg.turn_id
    if (msg.engine && ENGINE_RE.test(msg.engine)) engine = { kind: msg.engine, version: engineVersion(msg.engine) }
    try {
      const reason = msg.error ? (JSON.parse(msg.error) as { params?: { reason?: unknown } })?.params?.reason : null
      if (typeof reason === 'string') failure = KNOWN_REASONS.has(reason) ? reason : 'other'
      else if (msg.error) failure = 'other'
    } catch { failure = msg.error ? 'other' : null }
    try {
      const steps = JSON.parse(msg.steps) as { tool?: unknown }[]
      for (const s of Array.isArray(steps) ? steps : []) {
        if (typeof s?.tool === 'string' && TOOL_RE.test(s.tool) && !tools.includes(s.tool)) tools.push(s.tool)
        if (tools.length >= PROBLEM_REPORT_TOOLS_MAX) break
      }
    } catch { tools = [] }
    if (input.answer.withConversation) {
      const chat = ctx.db.query('SELECT user_id, project_id, room_id, shared_at, people_shared_at, side_room_id, deleted_at FROM chats WHERE id = ?').get(msg.chat_id) as ChatRowLite | null
      const turnUser = msg.turn_id ? (ctx.db.query('SELECT user_id FROM turns WHERE id = ?').get(msg.turn_id) as { user_id: string } | null)?.user_id ?? null : null
      if (!chat || !conversationAllowed(chat, userId, turnUser)) fail('forbidden', undefined, { params: { reason: 'conversation_not_allowed' } })
      const q = msg.parent_id ? ctx.db.query("SELECT content FROM messages WHERE id = ? AND chat_id = ? AND role = 'user'").get(msg.parent_id, msg.chat_id) as { content: string } | null : null
      const question = problemReportCut(q?.content ?? '', PROBLEM_REPORT_QUESTION_MAX)
      const answer = problemReportCut(msg.content, PROBLEM_REPORT_ANSWER_MAX)
      if (question.trim() || answer.trim()) conversation = { question: question.replace(/\u0000/g, ''), answer: answer.replace(/\u0000/g, '') }
    }
  }
  const report: ProblemReport = {
    v: 1, id, text: input.text.replace(/\u0000/g, '').trim(),
    client: { kind: input.client.kind, version: input.client.version && VERSION_RE.test(input.client.version) ? input.client.version : null, os: input.client.os },
    server, engine, screen: input.screen,
    locale: LOCALE_RE.test(locale) ? locale : 'en',
    turnId: turnId && /^[A-Za-z0-9_-]{1,64}$/.test(turnId) ? turnId : null,
    failure, tools, conversation,
  }
  // the contract's own check: what is stored is exactly what the intake takes
  if (!parseProblemReport(report)) fail('validation')
  return report
}

/** Keep a report and start sending it. Refuses while the feature or the team switch is off (404, so a client of an
 * older state sees it is gone) and past the limits (429). */
export function submitProblemReport(ctx: AppContext, userId: string, input: ProblemReportInput, locale: string, canView: (chatId: string) => boolean, now = Date.now()): { id: string } {
  if (!problemReportsOn(ctx)) fail('not_found')
  const since = new Date(now - DAY_MS).toISOString()
  const mine = (ctx.db.query('SELECT COUNT(*) AS n FROM problem_reports WHERE user_id = ? AND created_at > ?').get(userId, since) as { n: number }).n
  const all = (ctx.db.query('SELECT COUNT(*) AS n FROM problem_reports WHERE created_at > ?').get(since) as { n: number }).n
  if (mine >= PROBLEM_REPORTS_PER_PERSON || all >= PROBLEM_REPORTS_PER_TEAM) fail('rate_limited', undefined, { params: { reason: 'problem_reports_limit' } })
  const report = buildProblemReport(ctx, userId, input, locale, canView)
  const body = JSON.stringify(report)
  if (Buffer.byteLength(body) > PROBLEM_REPORT_MAX_BODY_BYTES) fail('payload_too_large')
  const at = new Date(now).toISOString()
  ctx.db.query("INSERT INTO problem_reports (id, user_id, created_at, body, status, attempts, next_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)").run(report.id, userId, at, body, at)
  kickProblemReports(ctx)
  return { id: report.id }
}

export type SendResult = { result: 'sent' } | { result: 'dropped' | 'retry'; status: number | null; code: string | null }

/** One signed post of a stored body. 'retry': no answer, 429 or a failure of the intake; 'dropped': a 404 (no intake
 * there) or another refusal. A 401 is tried once more at once. */
export async function sendProblemReport(sink: ProblemReportSink, body: string): Promise<SendResult> {
  let id: { key: KeyObject; publicKey: string }
  try { id = sink.identity() } catch { return { result: 'retry', status: null, code: 'no_key' } }
  const hash = crypto.createHash('sha256').update(body).digest('hex')
  for (let attempt = 0; ; attempt++) {
    const ts = (sink.now ?? Date.now)(), nonce = crypto.randomBytes(18).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(problemReportSigningString(ts, nonce, hash), 'utf8'), id.key).toString('base64')
    let r: Response
    try {
      r = await (sink.fetch ?? fetch)(sink.origin + PROBLEM_REPORT_PATH, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', authorization: driveBrokerAuthorization(id.publicKey, ts, nonce, sig) }, body,
      })
    } catch { return { result: 'retry', status: null, code: 'unreachable' } }
    let json: any = null
    try { const raw = await r.text(); json = raw.length <= 65_536 ? JSON.parse(raw) : null } catch { json = null }
    if (r.ok && json?.ok === true) return { result: 'sent' }
    const raw = json?.error?.code
    const code = typeof raw === 'string' && /^[a-z0-9_]{1,40}$/.test(raw) ? raw : null
    if (r.status === 401 && attempt === 0) continue
    if (r.status === 429 || r.status >= 500 || r.status === 401 || (r.ok && json?.ok !== true) || (r.status >= 300 && r.status < 400)) return { result: 'retry', status: r.status, code }
    return { result: 'dropped', status: r.status, code }
  }
}

interface OutRow { id: string; created_at: string; body: string | null; attempts: number }

/** Send every due report once (tests await it). Sweeps rows past 30 days. */
export async function drainProblemReports(ctx: AppContext, now = Date.now()): Promise<void> {
  ctx.db.query('DELETE FROM problem_reports WHERE created_at < ?').run(new Date(now - KEEP_MS).toISOString())
  const sink = sinkOf(ctx)
  const due = ctx.db.query("SELECT id, created_at, body, attempts FROM problem_reports WHERE status = 'pending' AND (next_at IS NULL OR next_at <= ?) ORDER BY created_at LIMIT 20").all(new Date(now).toISOString()) as OutRow[]
  for (const row of due) {
    if (stateOf(ctx).closed) return
    const drop = (status: number | null, code: string | null) => ctx.db.query("UPDATE problem_reports SET status = 'dropped', body = NULL, next_at = NULL, done_at = ?, last_status = ?, last_code = ? WHERE id = ?").run(new Date(now).toISOString(), status, code, row.id)
    if (!row.body || now - Date.parse(row.created_at) > MAX_AGE_MS) { drop(null, 'expired'); continue }
    if (!sink) continue // the intake went away (switched off): the report waits, and expires
    const r = await sendProblemReport(sink, row.body)
    const attempts = row.attempts + 1
    if (r.result === 'sent') {
      ctx.db.query("UPDATE problem_reports SET status = 'sent', body = NULL, next_at = NULL, attempts = ?, done_at = ?, last_status = 200, last_code = NULL WHERE id = ?").run(attempts, new Date(now).toISOString(), row.id)
    } else if (r.result === 'dropped') {
      drop(r.status, r.code)
      ctx.log.warn('problem report refused by the intake', { status: r.status, code: r.code })
    } else {
      const wait = BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)]!
      ctx.db.query('UPDATE problem_reports SET attempts = ?, next_at = ?, last_status = ?, last_code = ? WHERE id = ?').run(attempts, new Date(now + wait).toISOString(), r.status, r.code, row.id)
    }
  }
}

/** Send what is due now, in the background; one run at a time (a call during a run runs again after it). */
export function kickProblemReports(ctx: AppContext): Promise<void> {
  const s = stateOf(ctx)
  if (s.closed) return Promise.resolve()
  if (s.running) { s.again = true; return s.running }
  s.running = (async () => {
    try {
      do { s.again = false; await drainProblemReports(ctx) } while (s.again && !s.closed)
    } catch (e) { ctx.log.warn('problem reports: send failed', { err: e instanceof Error ? e.name : 'error' }) }
    finally { s.running = null }
  })()
  return s.running
}

/** At start: a timer that sends due reports once a minute (only where an outbox can have rows). */
export function startProblemReports(ctx: AppContext): void {
  const s = stateOf(ctx)
  const tick = () => {
    s.timer = null
    if (s.closed) return
    const pending = (ctx.db.query("SELECT COUNT(*) AS n FROM problem_reports WHERE status = 'pending'").get() as { n: number }).n
    const old = (ctx.db.query('SELECT COUNT(*) AS n FROM problem_reports WHERE created_at < ?').get(new Date(Date.now() - KEEP_MS).toISOString()) as { n: number }).n
    const next = () => { if (!s.closed) { s.timer = setTimeout(tick, TICK_MS); (s.timer as { unref?: () => void }).unref?.() } }
    if (pending || old) void kickProblemReports(ctx).finally(next)
    else next()
  }
  s.timer = setTimeout(tick, 5_000)
  ;(s.timer as { unref?: () => void }).unref?.()
}

/** tests: a row's state */
export function problemReportRow(db: Database, id: string): { status: string; body: string | null; attempts: number; next_at: string | null; last_status: number | null } | null {
  return db.query('SELECT status, body, attempts, next_at, last_status FROM problem_reports WHERE id = ?').get(id) as never
}
