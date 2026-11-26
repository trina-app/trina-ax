// Problem reports (shared/src/cloud-protocol/problem-report.ts, server/src/system/problem-reports.ts,
// server/src/routes/problem-reports.ts). Covers: the strict wire body; the signature (the Drive broker's string with this
// path, never valid for another path); the allow-list canary (names, mail, team, file names, room names, step labels and
// the conversation never leave unless ticked; tool ids only); the tick only in a person's own chat of one person; the
// outbox (sent → body deleted, 5xx/429/offline → backoff, 404 and other refusals → dropped, 401 → once more at once,
// 7 days → dropped); the limits; the admin switch, MYCEL_PROBLEM_REPORTS=off and the intake address; Me's fields.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { SERVICE_HOSTS } from '../../shared/src/service-hosts'
import { addMember, harness, withOwner } from './a-lib'
import { makeCApp, jsonBody, type CApp } from '../lib/c-app'
import { DRIVE_BROKER_PATHS, driveBrokerSigningString, parseDriveBrokerAuthorization } from '../../shared/src/cloud-protocol/drive-broker'
import { TEAM_NAME_PATH } from '../../shared/src/cloud-protocol/team-name'
import {
  parseProblemReport, PROBLEM_REPORT_ANSWER_MAX, PROBLEM_REPORT_PATH, problemReportCut, problemReportSigningString, type ProblemReport,
} from '../../shared/src/cloud-protocol/problem-report'
import {
  drainProblemReports, problemReportIntake, problemReportRow, PROBLEM_REPORTS_PER_PERSON, sendProblemReport, setProblemReportSink, type ProblemReportSink,
} from '../../server/src/system/problem-reports'

const ORIGIN = 'https://account.cp.test'

class FakeIntake {
  readonly key = crypto.generateKeyPairSync('ed25519').privateKey
  readonly publicKey = crypto.createPublicKey(this.key).export({ format: 'der', type: 'spki' }).toString('base64')
  bodies: string[] = []
  answers: Array<number | 'throw'> = []
  readonly fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(ORIGIN + PROBLEM_REPORT_PATH)
    const next = this.answers.shift() ?? 200
    if (next === 'throw') throw new Error('offline')
    const body = String(init!.body)
    const auth = parseDriveBrokerAuthorization(new Headers(init!.headers).get('authorization'))!
    expect(auth.key).toBe(this.publicKey)
    const signed = problemReportSigningString(auth.ts, auth.nonce, crypto.createHash('sha256').update(body).digest('hex'))
    expect(crypto.verify(null, Buffer.from(signed, 'utf8'), crypto.createPublicKey({ key: Buffer.from(auth.key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(auth.sig, 'base64'))).toBe(true)
    expect(parseProblemReport(JSON.parse(body))).not.toBeNull()
    this.bodies.push(body)
    if (next !== 200) return new Response(JSON.stringify({ error: { code: next === 404 ? 'not_found' : 'x', message: 'x' } }), { status: next })
    return Response.json({ ok: true })
  }) as typeof fetch
  sink(): ProblemReportSink { return { origin: ORIGIN, identity: () => ({ key: this.key, publicKey: this.publicKey }), fetch: this.fetch } }
}

let a: CApp, cp: FakeIntake, i = 0
beforeEach(async () => {
  a = await makeCApp('problem-reports-' + ++i)
  cp = new FakeIntake()
  setProblemReportSink(a.ctx, cp.sink())
})
afterEach(async () => { await a?.close() })

const CLIENT = { kind: 'web', version: null, os: 'macos' } as const
const send = (body: Record<string, unknown>, as: 'alice' | 'bob' | 'carol' | 'dana' = 'alice') => a.json('/api/problem-reports', { ...jsonBody({ screen: 'chat', client: CLIENT, ...body }), as })
const settle = async () => { for (let k = 0; k < 50; k++) { await Bun.sleep(5); if (!(a.ctx.db.query("SELECT COUNT(*) AS n FROM problem_reports WHERE status = 'pending' AND attempts = 0").get() as { n: number }).n) return } }

/** an answer in alice's chat: a question naming a file and a person, steps whose labels name files */
function answer(chatId: string, o: { error?: unknown; user?: string } = {}) {
  const db = a.ctx.db
  const turn = crypto.randomUUID()
  const q = Bun.randomUUIDv7(), m = Bun.randomUUIDv7()
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, ?, ?, 'claude-code', 'done')").run(turn, chatId, o.user ?? 'alice')
  db.query("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, 'user', ?)").run(q, chatId, 'Summarise CANARY-FILE-급여메모.md for Bob Kim (bob@acme.test)')
  const steps = [
    { id: 's1', kind: 'tool', tool: 'Read', label: 'Read CANARY-STEP-users/bob/notes.md', status: 'ok', startedAt: new Date().toISOString(), endedAt: null },
    { id: 's2', kind: 'tool', tool: 'mcp__acme-crm__search', label: 'Search "CANARY-STEP-Customer Ltd"', status: 'ok', startedAt: new Date().toISOString(), endedAt: null },
    { id: 's3', kind: 'tool', tool: 'Read', label: 'Read CANARY-STEP-2', status: 'ok', startedAt: new Date().toISOString(), endedAt: null },
    { id: 's4', kind: 'tool', tool: 'bad tool name with spaces', label: 'x', status: 'ok', startedAt: new Date().toISOString(), endedAt: null },
  ]
  db.query("INSERT INTO messages (id, chat_id, role, content, steps, status, error, turn_id, engine, parent_id) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, 'claude-code', ?)")
    .run(m, chatId, 'CANARY-ANSWER: the salary memo says …', JSON.stringify(steps), o.error ? 'error' : 'done', o.error ? JSON.stringify(o.error) : null, turn, q)
  return { turn, message: m }
}

test('the wire body is strict, the signature is the Drive broker string with this path, the cut keeps the cap', () => {
  const ok: ProblemReport = {
    v: 1, id: crypto.randomUUID(), text: 'It broke', client: { kind: 'desktop', version: '0.19.0', os: 'macos' }, server: { version: '0.19.0', run: 'hosted' },
    engine: { kind: 'claude-code', version: '2.1.3' }, screen: 'chat', locale: 'ko', turnId: 'abc', failure: 'stalled', tools: ['Read'], conversation: null,
  }
  expect(parseProblemReport(ok)).toEqual(ok)
  for (const bad of [
    { ...ok, extra: 1 }, { ...ok, v: 2 }, { ...ok, text: '   ' }, { ...ok, text: 'x'.repeat(4001) }, { ...ok, id: 'not-a-uuid' },
    { ...ok, screen: 'chat/0190' }, { ...ok, tools: ['Read', 'Read'] }, { ...ok, tools: ['has space'] }, { ...ok, client: { ...ok.client, ua: 'Mozilla' } },
    { ...ok, conversation: { question: '', answer: '' } }, { ...ok, conversation: { question: 'q', answer: 'a'.repeat(PROBLEM_REPORT_ANSWER_MAX + 1) } },
    (({ failure: _, ...rest }) => rest)(ok),
  ]) expect(parseProblemReport(bad)).toBeNull()
  expect([...problemReportCut('가'.repeat(10), 5)].length).toBe(5)
  expect(problemReportSigningString(1, 'n', 'h')).toBe(driveBrokerSigningString(PROBLEM_REPORT_PATH, 1, 'n', 'h'))
  for (const p of [...Object.values(DRIVE_BROKER_PATHS), TEAM_NAME_PATH]) expect(driveBrokerSigningString(p, 1, 'n', 'h')).not.toBe(problemReportSigningString(1, 'n', 'h'))
})

test('allow-list canary: from 👎 only the turn id, failure code and tool ids leave; no names, files, labels or conversation', async () => {
  const chat = a.chat('alice')
  const { turn, message } = answer(chat, { error: { code: 'engine_error', message: 'CANARY-ERR Bob', params: { reason: 'stalled' } } })
  const r = await send({ text: 'The answer stopped', answer: { messageId: message, withConversation: false } })
  expect(r.status).toBe(202)
  await settle()
  expect(cp.bodies).toHaveLength(1)
  const body = cp.bodies[0]!
  for (const canary of ['CANARY', 'Bob', 'bob@', '급여', 'notes.md', 'Customer', 'salary', 'alice', 'Alice', 'test chat', 'marketing', 'finance'])
    expect([canary, body.includes(canary)]).toEqual([canary, false])
  const sent = JSON.parse(body) as ProblemReport
  expect(sent).toMatchObject({ text: 'The answer stopped', turnId: turn, failure: 'stalled', tools: ['Read', 'mcp__acme-crm__search'], conversation: null, screen: 'chat', engine: { kind: 'claude-code' } })
  expect(Object.keys(sent).sort()).toEqual(['client', 'conversation', 'engine', 'failure', 'id', 'locale', 'screen', 'server', 'text', 'tools', 'turnId', 'v'])
  // once sent, only the id, person, times and state stay
  expect(problemReportRow(a.ctx.db, sent.id)).toMatchObject({ status: 'sent', body: null })
})

test('the tick sends my own question and answer, only from my own chat of one person', async () => {
  const chat = a.chat('alice')
  const { message } = answer(chat)
  expect((await send({ text: 'Wrong', answer: { messageId: message, withConversation: true } })).status).toBe(202)
  await settle()
  const sent = JSON.parse(cp.bodies[0]!) as ProblemReport
  expect(sent.conversation?.question).toContain('Summarise')
  expect(sent.conversation?.answer).toContain('CANARY-ANSWER')
  // a project, shared or side chat: no tick
  for (const col of ["project_id = 'p1'", "side_room_id = 'r1'", "people_shared_at = '2026-01-01'"]) {
    const c = a.chat('alice')
    a.ctx.db.exec('PRAGMA foreign_keys = OFF')
    a.ctx.db.query(`UPDATE chats SET ${col} WHERE id = ?`).run(c)
    a.ctx.db.exec('PRAGMA foreign_keys = ON')
    const m = answer(c).message
    const r = await send({ text: 'x', answer: { messageId: m, withConversation: true } })
    expect([col, r.status]).not.toEqual([col, 202])
  }
  // someone else's answer: not found (alice cannot open bob's chat)
  const bobs = answer(a.chat('bob'), { user: 'bob' }).message
  expect((await send({ text: 'x', answer: { messageId: bobs, withConversation: false } })).status).toBe(404)
})

test('outbox: 5xx, 429 and offline back off; 404 and other refusals drop; a 401 is tried once more at once; 7 days drop', async () => {
  const s = cp.sink()
  const body = JSON.stringify({ v: 1, id: crypto.randomUUID(), text: 'x', client: CLIENT, server: { version: '0.19.0', run: 'selfhost' }, engine: null, screen: 'home', locale: 'en', turnId: null, failure: null, tools: [], conversation: null })
  cp.answers = [503]; expect((await sendProblemReport(s, body)).result).toBe('retry')
  cp.answers = [429]; expect((await sendProblemReport(s, body)).result).toBe('retry')
  cp.answers = ['throw']; expect((await sendProblemReport(s, body)).result).toBe('retry')
  cp.answers = [404]; expect((await sendProblemReport(s, body)).result).toBe('dropped')
  cp.answers = [400]; expect((await sendProblemReport(s, body)).result).toBe('dropped')
  cp.answers = [401, 200]; expect((await sendProblemReport(s, body)).result).toBe('sent')
}, 20_000)

test('outbox rows: a failure waits and is tried again; a 404 deletes the body; an old report expires', async () => {
  cp.answers = [503]
  const r = await send({ text: 'one' })
  await settle()
  const row = problemReportRow(a.ctx.db, r.body.id)!
  expect(row).toMatchObject({ status: 'pending', attempts: 1, last_status: 503 })
  expect(row.body).not.toBeNull()
  // not due yet: nothing sent
  await drainProblemReports(a.ctx)
  expect(cp.bodies).toHaveLength(1)
  // due: sent, body gone
  await drainProblemReports(a.ctx, Date.parse(row.next_at!) + 1)
  expect(problemReportRow(a.ctx.db, r.body.id)).toMatchObject({ status: 'sent', body: null })
  cp.answers = [404]
  const r2 = await send({ text: 'two' })
  await settle()
  expect(problemReportRow(a.ctx.db, r2.body.id)).toMatchObject({ status: 'dropped', body: null, last_status: 404 })
  cp.answers = ['throw']
  const r3 = await send({ text: 'three' })
  await settle()
  await drainProblemReports(a.ctx, Date.now() + 8 * 24 * 3_600_000)
  expect(problemReportRow(a.ctx.db, r3.body.id)).toMatchObject({ status: 'dropped', body: null })
})

test('limits: 5 a person a day', async () => {
  for (let k = 0; k < PROBLEM_REPORTS_PER_PERSON; k++) expect((await send({ text: 'r' + k })).status).toBe(202)
  const over = await send({ text: 'one more' })
  expect(over.status).toBe(429)
  expect(over.body.error.params.reason).toBe('problem_reports_limit')
  expect((await send({ text: 'bob is fine' }, 'bob')).status).toBe(202)
})

test('the admin switch, the env and the intake address; Me says it', async () => {
  const h = await harness('problem-reports-me')
  try {
    setProblemReportSink(h.ctx, cp.sink())
    const owner = await withOwner(h)
    const member = (await addMember(h, owner, { username: 'mina' })).client
    let me = await member.call('GET', '/api/me')
    expect(me.team.problemReports).toBe(true)
    expect(me.server.problemReports).toBe('self')
    await owner.call('PATCH', '/api/admin/settings', { problemReports: false })
    me = await member.call('GET', '/api/me')
    expect(me.team.problemReports).toBeUndefined()
    expect(me.server.problemReports).toBe('self') // the admin still sees the switch
    expect((await member.raw('POST', '/api/problem-reports', { text: 'off', screen: 'home', client: CLIENT })).status).toBe(404)
    expect(cp.bodies).toHaveLength(0)
    // no intake: no entry points at all
    setProblemReportSink(h.ctx, null)
    expect((await owner.call('GET', '/api/me')).server.problemReports).toBeUndefined()
  } finally { await h.close() }
  // where: the env decides; a test app or a dev server never calls the real hosting service
  const cfg = a.ctx
  expect(problemReportIntake(cfg, { MYCEL_PROBLEM_REPORT_URL: ORIGIN })).toBe(ORIGIN)
  expect(problemReportIntake(cfg, { MYCEL_PROBLEM_REPORT_URL: ORIGIN, MYCEL_PROBLEM_REPORTS: 'off' })).toBeNull()
  expect(problemReportIntake(cfg, { MYCEL_PROBLEM_REPORT_URL: 'off' })).toBeNull()
  expect(problemReportIntake(cfg, { MYCEL_PROBLEM_REPORT_URL: 'http://evil.test' })).toBeNull()
  expect(problemReportIntake(cfg, { MYCEL_PROBLEM_REPORT_URL: ORIGIN + '/path' })).toBeNull()
  expect(problemReportIntake(cfg, { NODE_ENV: 'test' })).toBeNull()
  expect(problemReportIntake(cfg, {})).toBeNull() // a dev server
  ;(a.ctx.config as any).mode = 'prod'
  expect(problemReportIntake(cfg, {})).toBe(SERVICE_HOSTS.accountHost ? `https://${SERVICE_HOSTS.accountHost}` : null)
  expect(problemReportIntake(cfg, { MYCEL_PROBLEM_REPORTS: 'off' })).toBeNull()
  ;(a.ctx.config as any).mode = 'dev'
})
