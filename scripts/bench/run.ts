// Benchmark: document questions against a Trina server, on one engine (first written for
// docs/AGENTS/plan/20261107-0819-knowledge-graph-fast-answers.md, steps 1 and 8). Uploads the made-up Acme documents
// (scripts/bench/docs/), sends every question of scripts/bench/questions.json in its own new chat, and measures time,
// tokens, tool calls and correctness. The AI finds the documents with its file tools (list, glob, grep, read); there is
// no index to wait for. Test data only; real AI calls are made by the server.
//
//   bun scripts/bench/run.ts --server http://127.0.0.1:19251 --engine claude-code --password-file /path/pw \
//        [--username bench-owner] [--label baseline-local] [--out baseline-2026-11-07-claude-code] \
//        [--db /path/to/data/<db file>] [--only en-01,ko-02] [--skip-upload] [--keep-docs] [--timeout 300]
//
// The user must be an owner or admin who may pick the engine.
// Time: wall clock from "send" to the finished answer (polled every 300 ms). With --db (a local server's SQLite file,
// opened read-only) the turn's own started/ended times and token counts from `turns` are used instead; without it the
// token counts are Message.usage from the API.
import fs from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'

const argv = process.argv.slice(2)
const opt = (n: string, d?: string) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const flag = (n: string) => argv.includes('--' + n)

const server = (opt('server') ?? '').replace(/\/+$/, '')
const engine = opt('engine') ?? ''
const pwFile = opt('password-file')
const username = opt('username', 'bench-owner')!
const label = opt('label', 'run')!
const timeoutS = Number(opt('timeout', '300'))
const only = opt('only')?.split(',')
if (!server || !['claude-code', 'codex', 'api'].includes(engine) || !pwFile) {
  console.error('usage: bun scripts/bench/run.ts --server <url> --engine claude-code|codex --password-file <file> [--username U] [--label L] [--out NAME] [--db FILE] [--only ids] [--skip-upload] [--keep-docs] [--timeout S]')
  process.exit(2)
}

const HERE = import.meta.dir
const password = fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '')
const qfile = JSON.parse(fs.readFileSync(path.join(HERE, 'questions.json'), 'utf8')) as { folder: string; questions: Q[] }
interface Q { id: string; lang: 'en' | 'ko'; kind: 'find' | 'answer' | 'multi'; q: string; expectFiles: string[]; expectFacts: string[] }
const folder = qfile.folder
const docNames = fs.readdirSync(path.join(HERE, 'docs')).filter((f) => !f.startsWith('.')).sort()

let token = ''
async function api(method: string, p: string, body?: unknown | FormData): Promise<any> {
  const headers: Record<string, string> = { 'x-mycel-csrf': '1' } // the public sign-in is not bearer yet
  if (token) headers.authorization = 'Bearer ' + token
  let b: BodyInit | undefined
  if (body instanceof FormData) b = body
  else if (body !== undefined) { headers['content-type'] = 'application/json'; b = JSON.stringify(body) }
  const r = await fetch(server + p, { method, headers, body: b })
  const text = await r.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { /* not json */ }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`)
  return j
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- sign in, documents ----------
const login = await api('POST', '/api/auth/login', { username, password, tokenMode: 'bearer' })
token = login.token
if (!token) throw new Error('login gave no token')

async function ensureFolder(p: string) {
  const parts = p.split('/')
  for (let i = 1; i <= parts.length; i++) {
    try { await api('POST', '/api/files/mkdir', { path: parts.slice(0, i).join('/') }) } catch (e) { if (!/409|exists/i.test(String(e))) { /* folder may exist already */ } }
  }
}

async function upload() {
  await ensureFolder(folder)
  for (const name of docNames) {
    const buf = fs.readFileSync(path.join(HERE, 'docs', name))
    const f = new FormData()
    f.set('folder', folder); f.set('name', name); f.set('onExists', 'replace'); f.set('size', String(buf.length))
    f.set('file', new File([buf], name))
    await api('POST', '/api/files/upload', f)
  }
}

if (!flag('skip-upload')) await upload()
console.error(`documents ready (${docNames.length} files)`)

// ---------- questions ----------
const db = opt('db') ? new Database(opt('db')!, { readonly: true }) : null
const norm = (s: string) => s.toLowerCase().replace(/[\s,]/g, '')
const factOk = (answer: string, fact: string) => fact.split('|').some((alt) => norm(answer).includes(norm(alt)))

interface R {
  id: string; lang: string; kind: string; q: string; status: string; error: string | null
  wallMs: number; answerMs: number; timeSource: 'turn' | 'wall'
  inputTokens: number; outputTokens: number; tokenSource: 'turns' | 'api'
  toolCalls: number; tools: string[]; firstToolMs: number | null
  factsOk: boolean; missingFacts: string[]; fileOk: boolean; sources: string[]; correct: boolean
  answer: string
}

async function ask(q: Q): Promise<R> {
  const chat = await api('POST', '/api/chats', { engine })
  const t0 = Date.now()
  const started = await api('POST', `/api/chats/${chat.id}/messages`, {
    content: q.q, engine, clientMessageId: `bench-${q.id}-${Date.now().toString(36)}`,
  })
  const mid: string = started.assistantMessage.id
  let msg: any = null
  while (Date.now() - t0 < timeoutS * 1000) {
    await sleep(300)
    const page = await api('GET', `/api/chats/${chat.id}/messages?limit=10`)
    msg = (page.items as any[]).find((m) => m.id === mid)
    if (msg && msg.status !== 'streaming') break
  }
  const wallMs = Date.now() - t0
  if (!msg || msg.status === 'streaming') {
    try { await api('POST', `/api/chats/${chat.id}/stop`, {}) } catch { /* ignore */ }
    msg = { ...(msg ?? {}), status: 'timeout', content: msg?.content ?? '', steps: msg?.steps ?? [], usage: msg?.usage ?? null }
  }
  let sources: string[] = []
  try { sources = (await api('GET', `/api/chats/${chat.id}/messages/${mid}/sources`)).files.map((f: any) => f.path) } catch { /* none */ }

  let answerMs = wallMs, timeSource: R['timeSource'] = 'wall'
  let inputTokens = msg.usage?.inputTokens ?? 0, outputTokens = msg.usage?.outputTokens ?? 0, tokenSource: R['tokenSource'] = 'api'
  if (db) {
    const t = db.query('SELECT started_at, dispatched_at, queued_at, ended_at, input_tokens, output_tokens FROM turns WHERE id = ?').get(started.turnId) as any
    if (t?.ended_at) {
      const begin = Date.parse(t.dispatched_at ?? t.started_at)
      answerMs = Date.parse(t.ended_at) - begin; timeSource = 'turn'
      inputTokens = t.input_tokens; outputTokens = t.output_tokens; tokenSource = 'turns'
    }
  }
  const tools = (msg.steps as any[]).filter((s) => s.kind !== 'thinking').map((s) => String(s.tool ?? s.kind))
  const first = (msg.steps as any[]).find((s) => s.kind !== 'thinking')
  const answer: string = msg.content ?? ''
  const missingFacts = q.expectFacts.filter((f) => !factOk(answer, f))
  const factsOk = missingFacts.length === 0
  const fileOk = q.expectFiles.some((f) => sources.includes(f) || answer.includes(path.basename(f)))
  return {
    id: q.id, lang: q.lang, kind: q.kind, q: q.q, status: msg.status, error: msg.error?.message ?? msg.error?.code ?? null,
    wallMs, answerMs, timeSource, inputTokens, outputTokens, tokenSource,
    toolCalls: tools.length, tools, firstToolMs: first ? Date.parse(first.startedAt) - Date.parse(started.assistantMessage.createdAt) : null,
    factsOk, missingFacts, fileOk, sources, correct: msg.status === 'done' && factsOk, answer: answer.slice(0, 1500),
  }
}

const todo = qfile.questions.filter((q) => !only || only.includes(q.id))
const results: R[] = []
for (const q of todo) {
  let r: R
  try { r = await ask(q) } catch (e) {
    r = { id: q.id, lang: q.lang, kind: q.kind, q: q.q, status: 'failed', error: String(e).slice(0, 200), wallMs: 0, answerMs: 0, timeSource: 'wall', inputTokens: 0, outputTokens: 0, tokenSource: 'api', toolCalls: 0, tools: [], firstToolMs: null, factsOk: false, missingFacts: q.expectFacts, fileOk: false, sources: [], correct: false, answer: '' }
  }
  results.push(r)
  console.error(`${r.id} ${r.status} ${(r.answerMs / 1000).toFixed(1)}s in=${r.inputTokens} tools=${r.toolCalls} ${r.correct ? 'OK' : 'WRONG ' + r.missingFacts.join(',')}`)
}

if (!flag('keep-docs') && !flag('skip-upload')) { try { await api('DELETE', `/api/files?path=${encodeURIComponent(folder)}`) } catch { /* ignore */ } }

// ---------- summary ----------
const sorted = (a: number[]) => [...a].sort((x, y) => x - y)
const median = (a: number[]) => { const s = sorted(a); if (!s.length) return NaN; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p90 = (a: number[]) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)] : NaN }
function stats(rs: R[]) {
  const ok = rs.filter((r) => r.status === 'done')
  return {
    n: rs.length, answered: ok.length,
    medianSec: median(ok.map((r) => r.answerMs / 1000)), p90Sec: p90(ok.map((r) => r.answerMs / 1000)),
    medianInputTokens: median(ok.map((r) => r.inputTokens)), p90InputTokens: p90(ok.map((r) => r.inputTokens)),
    medianOutputTokens: median(ok.map((r) => r.outputTokens)),
    medianToolCalls: median(ok.map((r) => r.toolCalls)),
    correctPct: rs.length ? Math.round((100 * rs.filter((r) => r.correct).length) / rs.length) : NaN,
    filePct: rs.length ? Math.round((100 * rs.filter((r) => r.fileOk).length) / rs.length) : NaN,
  }
}
const groups: Record<string, R[]> = {
  all: results,
  find: results.filter((r) => r.kind === 'find'),
  answer: results.filter((r) => r.kind === 'answer'),
  multi: results.filter((r) => r.kind === 'multi'),
  'answer+multi': results.filter((r) => r.kind !== 'find'),
  korean: results.filter((r) => r.lang === 'ko'),
  english: results.filter((r) => r.lang === 'en'),
}
const summary = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, stats(v)]))

const meta = {
  label, engine, date: new Date().toISOString().slice(0, 10), documents: docNames.length, questions: results.length,
  timeSource: results[0]?.timeSource ?? 'wall', tokenSource: results[0]?.tokenSource ?? 'api',
  commit: Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: HERE }).stdout.toString().trim(),
}
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-')
const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '-')
let md = `# Benchmark: ${label} on ${engine}\n\n`
md += `- Date ${meta.date}, source commit ${meta.commit}, ${meta.documents} made-up documents, ${meta.questions} questions, one pass.\n`
md += `- Time is ${meta.timeSource === 'turn' ? "the turn's own start to end (turns table)" : 'wall clock from send to finished answer'}; tokens come from ${meta.tokenSource === 'turns' ? 'the turns table (cache reads and writes included)' : 'Message.usage of the API'}.\n`
md += `- Correct = the answer finished and contains every expected fact. Target: median time <= 7 s, median input <= 25,000 tokens.\n\n`
md += '| Group | n | answered | median s | p90 s | median input tok | p90 input tok | median output tok | median tool calls | correct % | expected file cited % |\n|---|---|---|---|---|---|---|---|---|---|---|\n'
for (const [k, s] of Object.entries(summary)) md += `| ${k} | ${s.n} | ${s.answered} | ${f1(s.medianSec)} | ${f1(s.p90Sec)} | ${f0(s.medianInputTokens)} | ${f0(s.p90InputTokens)} | ${f0(s.medianOutputTokens)} | ${f1(s.medianToolCalls)} | ${s.correctPct} | ${s.filePct} |\n`
md += '\n## Per question\n\n| id | kind | status | s | input tok | tools | facts | file |\n|---|---|---|---|---|---|---|---|\n'
for (const r of results) md += `| ${r.id} | ${r.kind} | ${r.status} | ${f1(r.answerMs / 1000)} | ${f0(r.inputTokens)} | ${r.toolCalls} | ${r.factsOk ? 'ok' : 'missing ' + r.missingFacts.join(', ')} | ${r.fileOk ? 'ok' : 'no'} |\n`

const outDir = path.join(HERE, 'results')
fs.mkdirSync(outDir, { recursive: true })
const out = opt('out') ?? `${label}-${engine}`
fs.writeFileSync(path.join(outDir, out + '.json'), JSON.stringify({ meta, summary, results }, null, 2) + '\n')
fs.writeFileSync(path.join(outDir, out + '.md'), md)
console.log(md)
process.exit(0)
