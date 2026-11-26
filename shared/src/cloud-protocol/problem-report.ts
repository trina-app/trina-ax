// Problem reports (control plane intake `src/problem-reports/`): a person writes what went wrong in the app ("문제
// 신고" in Settings › About, or 👎 under an AI answer), their team server keeps it in an outbox and sends it, signed,
// to the hosting service, which posts it as one card into the operators' own room. MIT (see LICENSE in this folder).
//
// Erasable TypeScript, imports only ./drive-broker.ts (no imports itself): the team server and the control plane
// (Bun) load this file as it is. The caller computes sha256 and the signature itself (node:crypto).
//
// Channel: the Drive broker's signed API, reused as it is (drive-broker.ts): POST, JSON body, header
//   Authorization: TrinaDriveBroker key=<base64 SPKI Ed25519 public key>, ts=<unix ms>, nonce=<22-64 base64url>, sig=<base64>
//   sig = Ed25519 over driveBrokerSigningString(PROBLEM_REPORT_PATH, ts, nonce, sha256 hex of the exact body bytes),
//   i.e. method, path, ts, nonce and the body hash. The path is part of the signed string, so no Drive, Slack or team
//   name signature verifies here. Skew DRIVE_BROKER_MAX_SKEW_MS; a (key, nonce) is refused the second time.
//
// Who: any relay team key. A hosted team's enrolled key and a registered server's key get the normal budget; an
// unknown key (a self-installed server nobody registered) shares one small budget with every other unknown key. Past a
// budget the control plane still answers 200 but folds the report into a count (it is not posted one by one), so a
// team server never retries it. The operators can block a key (`blocked`).
//
// Body:   ProblemReport (strict: every key present, unknown keys refused; nullable fields are null, not left out)
// Answer: 200 { ok: true }   also for a report id the control plane already took (the id is the idempotency key)
// Errors: JSON { error: { code, message } } with the status in PROBLEM_REPORT_ERRORS. A 404 means this control plane
//         takes no problem reports (an older one, or the feature is off there): the team server drops the report.
//
// What a report holds, and what it never holds: the person's own words; the app, server and engine versions; the
// platform; the kind of screen (a fixed word, never an id, path or file name); from 👎 the turn id, the failure code and
// the ids of the tools the answer used (never a step label: labels name files and items). The question and the answer
// travel only when the person ticked "send this answer and question" for this one report, each capped. Never a
// person's name, mail address, team name, file name, room name or anything the team stored.
import { driveBrokerSigningString } from './drive-broker.ts'

export const PROBLEM_REPORT_PATH = '/api/problem-reports/v1/report'
export const PROBLEM_REPORT_MAX_BODY_BYTES = 32_768
/** the person's words, in code points */
export const PROBLEM_REPORT_TEXT_MAX = 4000
/** a ticked question and answer, each in code points (the team server cuts them to this before it sends) */
export const PROBLEM_REPORT_QUESTION_MAX = 2000
export const PROBLEM_REPORT_ANSWER_MAX = 6000
export const PROBLEM_REPORT_TOOLS_MAX = 40

export const PROBLEM_REPORT_CLIENTS = ['web', 'desktop', 'phone'] as const
export type ProblemReportClient = (typeof PROBLEM_REPORT_CLIENTS)[number]
export const PROBLEM_REPORT_OS = ['macos', 'windows', 'linux', 'ios', 'android', 'other'] as const
export type ProblemReportOs = (typeof PROBLEM_REPORT_OS)[number]
export const PROBLEM_REPORT_RUNS = ['hosted', 'selfhost', 'office', 'dev'] as const
export type ProblemReportRun = (typeof PROBLEM_REPORT_RUNS)[number]
/** the kinds of screen a report may name (a route name, never an id): anything else is sent as 'other' */
export const PROBLEM_REPORT_SCREENS = ['chat', 'room', 'home', 'files', 'settings', 'admin', 'connectors', 'skills', 'inbox', 'search', 'other'] as const
export type ProblemReportScreen = (typeof PROBLEM_REPORT_SCREENS)[number]

export interface ProblemReport {
  v: 1
  /** a UUID the team server made; the idempotency key */
  id: string
  text: string
  client: { kind: ProblemReportClient; version: string | null; os: ProblemReportOs }
  server: { version: string; run: ProblemReportRun }
  engine: { kind: string; version: string | null } | null
  screen: ProblemReportScreen
  /** the app language, e.g. "ko", "en", "zh-CN" */
  locale: string
  /** from 👎: the answer's turn id */
  turnId: string | null
  /** from 👎: the answer's failure code when it failed or stalled (the codes error reports use) */
  failure: string | null
  /** from 👎: the ids of the tools the answer used, in order, no repeats (never step labels) */
  tools: string[]
  /** only when the person ticked it for this report */
  conversation: { question: string; answer: string } | null
}
export interface ProblemReportAnswer { ok: true }

export const PROBLEM_REPORT_ERRORS = {
  /** body is not JSON, too large, or not exactly a ProblemReport */
  invalid_request: 400,
  /** Authorization header missing or malformed, the signature does not verify, ts too far off, or a replay */
  unauthorized: 401,
  /** the operators blocked this key */
  blocked: 403,
  /** the body is larger than PROBLEM_REPORT_MAX_BODY_BYTES */
  too_large: 413,
  /** too many calls from this key or address in a short time; try again later */
  rate_limited: 429,
} as const
export type ProblemReportErrorCode = keyof typeof PROBLEM_REPORT_ERRORS

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/
const ENGINE = /^[a-z][a-z0-9-]{0,31}$/
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/
const TURN = /^[A-Za-z0-9_-]{1,64}$/
const FAILURE = /^[a-z][a-z0-9_.-]{0,63}$/
/** a tool id: a built-in name (Read, WebSearch) or an MCP id (mcp__server__tool) */
const TOOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/

const plain = (raw: unknown): Record<string, unknown> | null => typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : null
const exactly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).length === keys.length && keys.every((k) => k in o)
const cps = (s: string) => [...s].length
const nullable = <T>(v: unknown, ok: (x: unknown) => x is T): v is T | null => v === null || ok(v)
const str = (re: RegExp) => (x: unknown): x is string => typeof x === 'string' && re.test(x)
const oneOf = <T extends string>(list: readonly T[]) => (x: unknown): x is T => typeof x === 'string' && (list as readonly string[]).includes(x)
/** words a person typed: 1-max code points, not only white space, no NUL */
const words = (x: unknown, max: number, allowEmpty = false): x is string => typeof x === 'string' && !x.includes('\u0000') && cps(x) <= max && (allowEmpty || x.trim() !== '')

/** The strict check of a report body: the report, or null. The control plane parses every body with it. */
export function parseProblemReport(raw: unknown): ProblemReport | null {
  const o = plain(raw)
  if (!o || !exactly(o, ['v', 'id', 'text', 'client', 'server', 'engine', 'screen', 'locale', 'turnId', 'failure', 'tools', 'conversation']) || o.v !== 1) return null
  if (!str(UUID)(o.id) || !words(o.text, PROBLEM_REPORT_TEXT_MAX)) return null
  const c = plain(o.client)
  if (!c || !exactly(c, ['kind', 'version', 'os']) || !oneOf(PROBLEM_REPORT_CLIENTS)(c.kind) || !nullable(c.version, str(VERSION)) || !oneOf(PROBLEM_REPORT_OS)(c.os)) return null
  const s = plain(o.server)
  if (!s || !exactly(s, ['version', 'run']) || !str(VERSION)(s.version) || !oneOf(PROBLEM_REPORT_RUNS)(s.run)) return null
  let engine: ProblemReport['engine'] = null
  if (o.engine !== null) {
    const e = plain(o.engine)
    if (!e || !exactly(e, ['kind', 'version']) || !str(ENGINE)(e.kind) || !nullable(e.version, str(VERSION))) return null
    engine = { kind: e.kind, version: e.version }
  }
  if (!oneOf(PROBLEM_REPORT_SCREENS)(o.screen) || !str(LOCALE)(o.locale)) return null
  if (!nullable(o.turnId, str(TURN)) || !nullable(o.failure, str(FAILURE))) return null
  if (!Array.isArray(o.tools) || o.tools.length > PROBLEM_REPORT_TOOLS_MAX || !o.tools.every(str(TOOL)) || new Set(o.tools).size !== o.tools.length) return null
  let conversation: ProblemReport['conversation'] = null
  if (o.conversation !== null) {
    const v = plain(o.conversation)
    if (!v || !exactly(v, ['question', 'answer']) || !words(v.question, PROBLEM_REPORT_QUESTION_MAX, true) || !words(v.answer, PROBLEM_REPORT_ANSWER_MAX, true)) return null
    if (v.question.trim() === '' && v.answer.trim() === '') return null
    conversation = { question: v.question, answer: v.answer }
  }
  return {
    v: 1, id: o.id, text: o.text,
    client: { kind: c.kind, version: c.version, os: c.os },
    server: { version: s.version, run: s.run },
    engine, screen: o.screen, locale: o.locale, turnId: o.turnId, failure: o.failure, tools: [...o.tools as string[]], conversation,
  }
}

/** `s` cut to at most `max` code points, with "…" at the end when it was cut (the team server cuts a ticked question
 * and answer with it, so the parser never refuses a long answer) */
export function problemReportCut(s: string, max: number): string {
  const a = [...s]
  return a.length <= max ? s : a.slice(0, max - 1).join('') + '…'
}

/** The UTF-8 string the team key signs: the Drive broker's (method, path, ts, nonce, body sha256), with this path. */
export function problemReportSigningString(ts: number, nonce: string, bodySha256Hex: string): string {
  return driveBrokerSigningString(PROBLEM_REPORT_PATH, ts, nonce, bodySha256Hex)
}
