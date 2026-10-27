// Spike S1 (docs/DECISIONS.md "AI 연결" CR-00, docs/OWNER-TODO.md): does the REAL Codex CLI work against the real
// ChatGPT / OpenAI backends with the managed setup — a placeholder auth.json holding only a turn token, the custom
// provider "teamax" pointing at our model proxy, which puts the real credential on each request and refreshes the
// ChatGPT sign-in itself? Uses the real server pieces (credentials/*, proxy/model-proxy.ts + codex-path.ts) with a
// recording relay between Codex and the proxy. Spends a few requests of the plan / key. Never prints a token.
//
//   mkdir -p /tmp/spike-codex && CODEX_HOME=/tmp/spike-codex codex login --device-auth   # a SEPARATE sign-in
//   bun tests/engine/codex-managed-spike.ts --auth /tmp/spike-codex/auth.json [--codex <path>] [--model <slug>] [--only a,b,...]
//     --auth     a ChatGPT login made only for the spike: the proxy may refresh it (refresh tokens rotate), after which
//                the copy in that file is stale. Never point it at the login you use day to day (~/.codex/auth.json).
//     env SPIKE_OPENAI_KEY=sk-…   also the API key scenario (S1-e)
//     scenario g (a forced refresh) runs only when asked for: --only g
//
// Scenarios (pass criteria of the spec table 3.5.6):
//   a  ChatGPT: one turn with a web search completes; Codex called only /responses and /wham/* (team tools are not
//      wired here: no launcher / bridge; the managed-real run, tests/engine/managed-real.ts, covers them)
//   b  the same with and without the `version` header (which one works is fixed in engine/codex.ts)
//   c  background /wham/* calls answered 404 / {} by the proxy do not break the turn
//   d  Codex never calls auth.openai.com or its refresh address and never rewrites auth.json
//   e  OpenAI API key connection: the same turn (needs SPIKE_OPENAI_KEY)
//   f  three turns at once on the same connection: all complete, no refresh by Codex
//   g  the proxy refreshes the sign-in (rotated refresh token stored) and the next turn works with it
//   h  a 429 body / x-codex-* headers, if one is seen (recorded, not forced)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../../server/src/db'
import { codexArgs, writeLockedCatalog, CODEX_VERSION, type CodexConf } from '../../server/src/engine/codex'
import { issueProxyToken, startModelProxy } from '../../server/src/proxy/model-proxy'
import { createBroker } from '../../server/src/credentials/broker'
import { makeCredCtx, getRow, secretOf, type Secrets } from '../../server/src/credentials/store'
import { insertRow } from '../../server/src/credentials/service'
import { dummyAuthJson } from '../../server/src/credentials/codex-home'
import { ensureFresh } from '../../server/src/credentials/chatgpt-tokens'
import { accountRef, idClaims } from '../../server/src/credentials/openai-oauth'

const argv = process.argv.slice(2)
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const codexBin = fs.realpathSync(opt('--codex') ?? Bun.which('codex') ?? 'codex')
const authFile = opt('--auth') ?? path.join(os.homedir(), '.codex', 'auth.json')
const only = new Set((opt('--only') ?? 'a,b,c,d,e,f,h').split(','))
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-spike-'))
const report: Record<string, unknown> = { codexVersion: CODEX_VERSION, at: new Date().toISOString() }

// ---------------- the team server's pieces ----------------
const db = openDb(path.join(W, 'app.db'))
db.query("INSERT INTO users (id, username, name, role) VALUES ('owner', 'owner', 'Owner', 'owner')").run()
const cc = makeCredCtx({ db, secretsDir: path.join(W, 'secrets'), config: { mode: 'dev', dataDir: W, engine: { authMode: 'managed' } }, log: { info() {}, warn: (m) => console.error('warn:', m), error: (m) => console.error('error:', m) } })
const real = JSON.parse(fs.readFileSync(authFile, 'utf8'))
if (!real?.tokens?.refresh_token) { console.error(`${authFile}: not a ChatGPT login (run \`codex login\` first)`); process.exit(2) }
const claims = idClaims(real.tokens.id_token)
const secret: Secrets['chatgpt'] = { idToken: real.tokens.id_token, accessToken: real.tokens.access_token, refreshToken: real.tokens.refresh_token, accountId: real.tokens.account_id, lastRefresh: real.last_refresh ?? new Date().toISOString() }
const G = insertRow(cc, { kind: 'chatgpt', label: 'spike', secret, ownerUserId: null, priority: 100, assignments: [], createdBy: null, meta: { planType: claims?.planType ?? null, accountRef: accountRef(secret.accountId), fedramp: claims?.fedramp ?? false } })
const K = process.env.SPIKE_OPENAI_KEY ? insertRow(cc, { kind: 'openai-api-key', label: 'spike key', secret: { key: process.env.SPIKE_OPENAI_KEY }, ownerUserId: null, priority: 100, assignments: [], createdBy: null }) : null
report.plan = claims?.planType ?? null

// the locked catalog, built from the owner's models cache (like dev mode)
const catalog = path.join(W, 'catalog.json')
const models = writeLockedCatalog(path.join(os.homedir(), '.codex', 'models_cache.json'), catalog)
const model = opt('--model') ?? models[0]!
const proxy = await startModelProxy({ db, broker: createBroker(cc), codexModels: () => models })

// ---------------- the recording relay (Codex -> relay -> our proxy) ----------------
interface Rec { scenario: string; method: string; path: string; status: number; headers: string[]; version: boolean; error?: unknown; codexHeaders?: Record<string, string> }
const recs: Rec[] = []
let scenario = ''
const relay = Bun.serve({
  port: 0, hostname: '127.0.0.1', idleTimeout: 0,
  async fetch(req) {
    const u = new URL(req.url)
    const body = req.method === 'GET' ? undefined : await req.arrayBuffer()
    const up = await fetch(`${proxy.url}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body, redirect: 'manual' })
    const rec: Rec = { scenario, method: req.method, path: u.pathname, status: up.status, headers: [...req.headers.keys()].sort(), version: req.headers.has('version') }
    const xc = Object.fromEntries([...up.headers].filter(([k]) => k.startsWith('x-codex-')))
    if (Object.keys(xc).length) rec.codexHeaders = xc
    if (up.status === 429 || up.status >= 400) { const t = await up.clone().text(); try { rec.error = JSON.parse(t).error } catch { rec.error = t.slice(0, 300) } }
    recs.push(rec)
    return new Response(up.body, { status: up.status, headers: up.headers })
  },
})

/** one Codex turn with the managed setup; returns its exit, final text and whether auth.json changed */
async function turn(name: string, o: { mode: 'chatgpt' | 'openai'; cred: string; prompt: string; version?: boolean }) {
  scenario = name
  const turnId = `spike-${name}-${Math.random().toString(36).slice(2, 8)}`
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, 'c', 'owner', 'codex', 'running')").run(turnId)
  const token = issueProxyToken(db, turnId, 'owner', { credentialId: o.cred, family: 'openai', ttlMs: 30 * 60_000 })
  const dir = fs.mkdtempSync(path.join(W, 'turn-'))
  const home = path.join(dir, '.codex'); fs.mkdirSync(home); fs.mkdirSync(path.join(dir, '.home'))
  const row = getRow(db, o.cred)!
  const auth = dummyAuthJson({ credentialId: o.cred, kind: o.mode === 'chatgpt' ? 'chatgpt' : 'openai-api-key', planType: JSON.parse(row.meta).planType ?? null, fedramp: false }, token)
  fs.writeFileSync(path.join(home, 'auth.json'), auth, { mode: 0o600 })
  const conf: CodexConf = { bin: codexBin, codexHome: home, agentHome: path.join(dir, '.home'), catalog, model, auth: 'managed' }
  let args = codexArgs(conf, { model, managed: { port: relay.port!, mode: o.mode, codexVersion: CODEX_VERSION } })
  // no bridge / gate here: the team MCP server is left out (managed-real covers it)
  args = args.filter((a, i) => !a.startsWith('mcp_servers.') && !(a === '-c' && args[i + 1]?.startsWith('mcp_servers.')))
  if (o.version === false) args = args.filter((a, i) => !a.includes('http_headers') && !(a === '-c' && args[i + 1]?.includes('http_headers')))
  const p = Bun.spawn([codexBin, ...args], {
    cwd: dir, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: '/usr/bin:/bin', HOME: path.join(dir, '.home'), CODEX_HOME: home, LANG: 'en_US.UTF-8', CODEX_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${relay.port}/codex/oauth/token` },
  })
  p.stdin.write(o.prompt); p.stdin.end()
  const t = setTimeout(() => p.kill(), 5 * 60_000)
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(t)
  db.query("UPDATE turns SET status = 'done' WHERE id = ?").run(turnId)
  const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const text = events.filter((e: any) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e: any) => e.item.text).join(' ')
  const searched = events.some((e: any) => e.item?.type === 'web_search')
  const failed = events.find((e: any) => e.type === 'turn.failed' || e.type === 'error')
  const changed = fs.readFileSync(path.join(home, 'auth.json'), 'utf8') !== auth
  return { code, completed: events.some((e: any) => e.type === 'turn.completed'), answered: text.length > 0, searched, failed: failed ? JSON.stringify(failed).slice(0, 300) : null, authChanged: changed, stderrTail: err.split('\n').slice(-3).join(' | ').slice(0, 300) }
}
const paths = (s: string) => [...new Set(recs.filter((r) => r.scenario === s).map((r) => `${r.method} ${r.path} ${r.status}`))]
const refreshCalls = (s: string) => recs.filter((r) => r.scenario === s && r.path === '/codex/oauth/token').length

try {
  if (only.has('a') || only.has('c') || only.has('d')) {
    const r = await turn('a', { mode: 'chatgpt', cred: G, prompt: 'Search the web for the current version of the Bun JavaScript runtime and answer in one short sentence.' })
    const p = paths('a')
    report['S1-a'] = { pass: r.completed && r.answered && p.every((x) => /\/codex\/(chatgpt\/responses|backend\/)/.test(x)), ...r, paths: p }
    report['S1-c'] = { pass: r.completed, backgroundCalls: p.filter((x) => x.includes('/codex/backend/')) }
    report['S1-d'] = { pass: refreshCalls('a') === 0 && !r.authChanged, refreshCalls: refreshCalls('a'), authChanged: r.authChanged }
  }
  if (only.has('b')) {
    const without = await turn('b-noversion', { mode: 'chatgpt', cred: G, prompt: 'Say OK.', version: false })
    const withV = await turn('b-version', { mode: 'chatgpt', cred: G, prompt: 'Say OK.' })
    report['S1-b'] = { withoutVersionHeader: { completed: without.completed, failed: without.failed }, withVersionHeader: { completed: withV.completed, failed: withV.failed } }
  }
  if (only.has('e')) {
    report['S1-e'] = K ? await turn('e', { mode: 'openai', cred: K, prompt: 'Say OK.' }).then((r) => ({ pass: r.completed && r.answered, ...r, paths: paths('e') })) : { skipped: 'SPIKE_OPENAI_KEY not set' }
  }
  if (only.has('f')) {
    const rs = await Promise.all([1, 2, 3].map((n) => turn(`f${n}`, { mode: 'chatgpt', cred: G, prompt: `Say the number ${n}.` })))
    report['S1-f'] = { pass: rs.every((r) => r.completed) && ['f1', 'f2', 'f3'].every((s) => refreshCalls(s) === 0), turns: rs.map((r) => ({ completed: r.completed, failed: r.failed })) }
  }
  if (only.has('g')) {
    const before = (secretOf(cc, getRow(db, G)! as never) as Secrets['chatgpt']).refreshToken
    const f = await ensureFresh(cc, G, { force: true })
    cc.cache.clear()
    const after = (secretOf(cc, getRow(db, G)! as never) as Secrets['chatgpt']).refreshToken
    const r = f.ok ? await turn('g', { mode: 'chatgpt', cred: G, prompt: 'Say OK.' }) : null
    report['S1-g'] = { pass: f.ok && !!r?.completed, refreshed: f.ok, rotated: before !== after, turn: r && { completed: r.completed, failed: r.failed } }
    if (f.ok) console.error('NOTE: the spike refreshed this sign-in; the file given with --auth now holds a stale refresh token (sign in again before reusing it).')
  }
  const r429 = recs.filter((r) => r.status === 429)
  report['S1-h'] = r429.length ? { seen: r429.map((r) => ({ error: r.error, codexHeaders: r.codexHeaders })) } : { seen: [], rateHeaders: recs.find((r) => r.codexHeaders)?.codexHeaders ?? null }
} finally {
  await proxy.stop(); relay.stop(true); db.close()
}
// no tokens in the report: only paths, statuses, header names, booleans
console.log(JSON.stringify(report, null, 2))
fs.rmSync(W, { recursive: true, force: true })
