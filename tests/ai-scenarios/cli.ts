// AI scenario runs: the catalog (cases.yaml) through the real team AI on a local server seeded with the fixture
// company. README.md says what each step does.
//
//   bun run ai:scenarios up [--reset] [--devenv] [--no-relay]   start this run's own dev server (port 19871, its local
//                                                   relay on 19872, data ~/.trina-aiscen) and seed it
//   bun run ai:scenarios run [--case A-01,B-02] [--feature files] [--first-pass] [--jobs 3] [--run <id>] [--skip-fix-in-progress]
//   bun run ai:scenarios judge [--run <id>] [--case …] [--jobs 4]
//   bun run ai:scenarios report [--run <id>]
//   bun run ai:scenarios all [--jobs 3]               up --reset, run, judge, report
//   bun run ai:scenarios down                         stop the server this tool started (by its pid, nothing else)
//   bun run ai:scenarios list [--feature …] [--first-pass]   the cases, one line each
//   bun run ai:scenarios flows run [--flow FL-01,…] [--group sharing] [--always] [--jobs 2] [--no-judge] [--keep-state]
//                                                   the multi-step flows (flows.yaml); --always: people choose "Always allow"
//   bun run ai:scenarios flows judge|report|list   judge a flow run; the report (default run + the latest --always run)
//   bun run ai:scenarios mocks [down]               the MOCK services behind a quick tunnel, connected for the people
//   bun run ai:scenarios coverage [--out <file>]      coverage per feature of docs/features.ts (feature-scope.ts)
//
// Environment: AISCEN_HOME (default ~/.trina-aiscen), AISCEN_PORT (default 19871). Results: tests/.work/ai-scenarios/<run>/.
// The engine is this machine's own Claude Code sign-in (dev mode, local-login): no new account, no API key.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, ApiClient } from '../../shared/src/api'
import { DEV_ENV_SRT_WARNING_VERSION } from '../../shared/src/api/dev-env'
import { COMPANY, GUEST, PASSWORD, seedFixture, fixtureFile, type FixtureState } from './fixture/seed'
import { askerLine, judge } from './lib/judge'
import { FlowCatalog, flowChanged, runFlow, type Flow, type FlowResult } from './lib/flow'
import { judgeFlow, writeFlowReport } from './lib/flow-report'
import { mocksDown, mocksReset, mocksUp, readMocks } from './mock-services/up'
import { writeReport } from './lib/report'
import { roomPostsOf, runCase, type Env } from './lib/run-case'
import { driftOf, ensureFolder, resetTo, stateOf, type State } from './lib/state-guard'
import { coverageMarkdown, firstPass, loadCatalog } from './lib/catalog'
import type { Case, CaseResult } from './lib/types'

const ROOT = path.resolve(import.meta.dir, '../..')
const HOME = path.resolve(process.env.AISCEN_HOME ?? path.join(os.homedir(), '.trina-aiscen'))
const PORT = Number(process.env.AISCEN_PORT ?? 19871)
/** the server's own local relay: how a dev server learns its public exit address (server/src/main.ts). Without it
 * every web address the AI opens gets the "device inside your network" card, which no real install shows. */
const RELAY_PORT = Number(process.env.AISCEN_RELAY_PORT ?? 19872)
const BASE = `http://127.0.0.1:${PORT}`
const DATA = path.join(HOME, 'data')
const TEAM = path.join(HOME, 'team')
const STATE = path.join(HOME, 'fixture.json')
const PID = path.join(HOME, 'server.pid')
const LOG = path.join(HOME, 'server.log')
const RUNS = path.join(ROOT, 'tests', '.work', 'ai-scenarios')

const args = process.argv.slice(2)
const cmd = args[0] ?? 'help'
const flag = (f: string) => args.includes(f)
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const say = (s: string) => console.log(`[ai-scenarios] ${s}`)


const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const serverPid = () => { try { const p = Number(fs.readFileSync(PID, 'utf8')); return p && alive(p) ? p : null } catch { return null } }
async function healthy(): Promise<boolean> { try { return (await fetch(`${BASE}/api/setup`)).ok } catch { return false } }
const devEnvOn = () => { try { return fs.readFileSync(path.join(HOME, 'devenv'), 'utf8').trim() === '1' } catch { return false } }

async function down() {
  const p = serverPid()
  if (!p) { say('no server of this tool is running'); return }
  process.kill(p, 'SIGTERM')
  for (let i = 0; i < 30 && alive(p); i++) await Bun.sleep(500)
  say(alive(p) ? `server ${p} did not stop` : `server ${p} stopped`)
}

/** start this tool's server and seed it; `reset` first deletes this tool's own folder (AISCEN_HOME). The flags come from
 * the command line unless given (a flow run's reset keeps the server's dev environment and relay mode). */
async function up(o: { reset?: boolean; devenv?: boolean; relay?: boolean } = {}) {
  const devenv = o.devenv ?? flag('--devenv'), relay = o.relay ?? !flag('--no-relay')
  if (o.reset ?? flag('--reset')) {
    await down()
    // only this tool's own folder (AISCEN_HOME), never anything else
    if (fs.existsSync(HOME) && fs.existsSync(path.join(HOME, 'data'))) fs.rmSync(HOME, { recursive: true, force: true })
  }
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
  if (!serverPid()) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TEAM_AX_DEV_DIR: HOME, TEAM_AX_DEV_PORT: String(PORT), TEAM_AX_DEV_RELAY_PORT: String(RELAY_PORT), NO_COLOR: '1' }
    if (devenv) env.MYCEL_DEV_ENV = '1'
    else delete env.MYCEL_DEV_ENV
    fs.writeFileSync(path.join(HOME, 'devenv'), devenv ? '1' : '0')
    const out = fs.openSync(LOG, 'a')
    fs.writeFileSync(path.join(HOME, 'relay-mode'), relay ? '1' : '0')
    const child = Bun.spawn(['bun', 'run', 'scripts/dev.ts', ...(relay ? [] : ['--no-relay'])], { cwd: ROOT, env, stdout: out, stderr: out, stdin: 'ignore' })
    child.unref()
    fs.writeFileSync(PID, String(child.pid))
    say(`server starting (pid ${child.pid}, log ${LOG})`)
  }
  for (let i = 0; i < 240 && !(await healthy()); i++) await Bun.sleep(1000)
  if (!(await healthy())) throw new Error(`the server did not answer on ${BASE}; see ${LOG}`)
  let setupToken: string | null = null
  try { setupToken = fs.readFileSync(path.join(DATA, 'setup-token'), 'utf8').trim() || null } catch {}
  const state = await seedFixture({ base: BASE, setupToken, log: (s) => say(s), dataDir: DATA })
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1))
  let relayOn = false
  try { relayOn = fs.readFileSync(path.join(HOME, 'relay-mode'), 'utf8').trim() === '1' } catch {}
  say(`ready: ${BASE} (dev environment ${devEnvOn() ? 'on' : 'off'}, relay ${relayOn ? `on (port ${RELAY_PORT}): the exit address is known` : 'OFF: every web address gets the in-network card'}); people ${Object.keys(state.people).join(', ')}; password in tests/ai-scenarios/fixture/seed.ts`)
}

const runDir = (id: string) => path.join(RUNS, id)
function latestRun(): string {
  const l = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((d) => fs.statSync(path.join(RUNS, d)).isDirectory()).sort() : []
  if (!l.length) throw new Error('no run yet')
  return l[l.length - 1]!
}
function selected(all: Case[]): Case[] {
  const ids = opt('--case')?.split(',').map((s) => s.trim())
  const feature = opt('--feature')
  const pass1 = firstPass(all)
  return all.filter((c) => (!ids || ids.some((i) => c.id === i || (!process.env.AISCEN_EXACT && c.id.startsWith(`${i}.`)))) && (!feature || c.features.some((f) => f === feature || f.startsWith(`${feature}.`)))
    && !(flag('--first-pass') && !pass1.has(c.id)) && !(flag('--skip-fix-in-progress') && c.fixInProgress))
}
const commit = () => Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()

async function owner(): Promise<ApiClient> {
  const r = await new ApiClient({ baseUrl: BASE }).call(API.login, { body: { username: 'jiwoo', password: PASSWORD, client: 'web', tokenMode: 'bearer' } })
  return new ApiClient({ baseUrl: BASE, token: r.token! })
}

/** put a fixture file back as it was (a case that renames, moves or edits it) */
async function restore(api: ApiClient, rel: string) {
  const folder = path.posix.dirname(rel), name = path.posix.basename(rel)
  await ensureFolder(api, folder)
  await api.call(API.upload, { body: { fields: { folder, name, onExists: 'replace' }, file: new Blob([fs.readFileSync(fixtureFile(rel))]), filename: name } })
}

const clients = new Map<string, Promise<ApiClient>>()
const as = (u: string) => {
  if (!clients.has(u)) clients.set(u, new ApiClient({ baseUrl: BASE }).call(API.login, { body: { username: u, password: PASSWORD, client: 'web', tokenMode: 'bearer' } }).then((r) => new ApiClient({ baseUrl: BASE, token: r.token! })))
  return clients.get(u)!
}
const isFixture = (rel: string) => { try { fixtureFile(rel); return true } catch { return false } }
const personalFixture = (rel: string) => { const m = /^users\/([^/]+)\/(.+)$/.exec(rel); return m && fs.existsSync(path.join(import.meta.dir, 'fixture', 'personal', m[1]!, m[2]!)) ? path.join(import.meta.dir, 'fixture', 'personal', m[1]!, m[2]!) : null }

/** After a case: what it made goes to the trash and the fixture files it changed or removed come back, so the next
 * case sees the team as seeded (a stamped copy left by one case once made the next answer "it is done already").
 * Files in someone's own folder are handled as that person. */
async function cleanUp(r: CaseResult, actor?: string) {
  // the AI's room posts are deleted by their sender (the case's person): a later case, or the same case run again on
  // this server, read "the quote was posted 3 times tonight" and answered from that (CHT-02, dev f394c9258,
  // 2026-11-17). A deleted message is left out of what the AI reads (server/src/rooms/reader.ts).
  // a post whose result the transcript did not keep cannot be found here: said, so a leftover is known
  // a flow's clean-up passes only the changed paths (runFlows): no turns
  const unread = (r.turns ?? []).flatMap((t) => t.tools).filter((x) => x.name === 'post_to_room' && x.ok && !x.result).length
  if (unread) say(`clean-up ${r.id}: ${unread} room post(s) without a result in the transcript: not deleted, check the room`)
  if (actor) for (const p of roomPostsOf(r)) {
    try { await (await as(actor)).call(API.deleteRoomMessage, { params: { id: p.roomId, messageId: p.messageId } }) } catch (e) { say(`clean-up room post ${p.messageId}: ${e instanceof Error ? e.message : e}`) }
  }
  for (const rel of r.changed) {
    const owner = /^users\/([^/]+)\//.exec(rel)?.[1] ?? 'jiwoo'
    try {
      const api = await as(owner)
      const personal = personalFixture(rel)
      if (isFixture(rel)) await restore(api, rel)
      else if (personal) {
        const folder = path.posix.dirname(rel), name = path.posix.basename(rel)
        await api.call(API.upload, { body: { fields: { folder, name, onExists: 'replace' }, file: new Blob([fs.readFileSync(personal)]), filename: name } })
      } else if (fs.existsSync(path.join(TEAM, rel))) await api.call(API.remove, { query: { path: rel } })
    } catch (e) { say(`clean-up ${rel}: ${e instanceof Error ? e.message : e}`) }
  }
}

async function run() {
  if (!(await healthy())) throw new Error(`no server on ${BASE}: run \`bun run ai:scenarios up\` first`)
  const fixture = JSON.parse(fs.readFileSync(STATE, 'utf8')) as FixtureState
  const id = opt('--run') ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = runDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const cases = selected(loadCatalog())
  const env: Env = { base: BASE, dataDir: DATA, teamRoot: TEAM, fixture, runId: id, commit: commit(), log: say }
  const own = await owner()
  const devenv = devEnvOn()
  say(`run ${id}: ${cases.length} cases, results in ${dir}`)
  // who can open what as the run starts (the seeded team): after every case it is compared and put back
  const base: State = stateOf(DATA, TEAM)
  const userName = new Map((await own.call(API.listUsers)).items.map((u) => [u.id, u.username]))
  let guarding = Promise.resolve()
  const guard = (r: CaseResult) => (guarding = guarding.then(async () => {
    const now = stateOf(DATA, TEAM)
    const drift = driftOf(base, now)
    if (!drift.length) return
    r.drift = drift
    say(`${r.id}: changed who can open what (${drift.length}): ${drift.slice(0, 4).join('; ')}${drift.length > 4 ? ' ...' : ''}; putting it back`)
    const left = await resetTo(base, now, { owner: own, as, username: (id) => userName.get(id) ?? null, fixtureDir, log: say }, () => stateOf(DATA, TEAM))
    if (left.length) { r.driftLeft = left; say(`${r.id}: not put back: ${left.join('; ')}`) }
  }))
  // grouped by install: the team's dev environment setting is switched between groups (one server)
  for (const install of ['linux-nodevenv', 'office-mac', 'linux-devenv', 'managed'] as const) {
    const group = cases.filter((c) => c.install === install)
    if (!group.length) continue
    if (install === 'managed') {
      for (const c of group) writeResult(dir, { id: c.id, runId: id, commit: env.commit, startedAt: new Date().toISOString(), chatId: null, turns: [], changed: [], checks: [], jargon: [], error: 'blocked: needs a managed install (AI on team connections; a guest with team AI); this server runs on its own sign-in' })
      say(`${group.length} managed cases blocked (this server is local-login)`)
      continue
    }
    if (install === 'linux-devenv' && !devenv) {
      for (const c of group) writeResult(dir, { id: c.id, runId: id, commit: env.commit, startedAt: new Date().toISOString(), chatId: null, turns: [], changed: [], checks: [], jargon: [], error: 'blocked: needs a server with a working dev environment (Linux with srt, `up --devenv`); this one has none' })
      say(`${group.length} linux-devenv cases blocked (no dev environment on this server)`)
      continue
    }
    if (devenv) await own.call(API.updateDevEnvTeam, { body: install === 'linux-devenv' ? { enabled: true, acceptWarning: DEV_ENV_SRT_WARNING_VERSION } : { enabled: false } })
    // cases that change shared files or who can open what run alone after the others, so a rename or a new grant never
    // changes what another case sees
    const alone = (c: Case) => !!c.restores.length || c.changesState || c.features.some((f) => STATE_FEATURES.has(f))
    const parallel = group.filter((c) => !alone(c)), serial = group.filter(alone)
    const jobs = Math.max(1, Number(opt('--jobs') ?? 3))
    // a case and its variants work on the same files: one worker runs them one after another
    const byBase = new Map<string, Case[]>()
    for (const c of parallel) { const b = c.id.split('.')[0]!; byBase.set(b, [...(byBase.get(b) ?? []), c]) }
    const queue = [...byBase.values()]
    await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let g = queue.shift(); g; g = queue.shift()) for (const c of g) { const r = await runCase(c, env); await guard(r); writeResult(dir, r); await cleanUp(r, c.as) }
    }))
    for (const c of serial) {
      const r = await runCase(c, env)
      await guard(r)
      writeResult(dir, r)
      await cleanUp(r, c.as)
      for (const rel of c.restores) await restore(own, rel).catch((e) => say(`restore ${rel}: ${e instanceof Error ? e.message : e}`))
    }
  }
  say(`done: ${id}`)
  return id
}

/** features whose cases may change who can open what: their cases run alone (Case.changesState) */
const STATE_FEATURES = new Set(['admin.folders', 'admin.groups', 'admin.members', 'admin.guests', 'projects.members', 'skills.move', 'skills.share', 'skills.managers', 'files.share-links', 'chat.share', 'chat.allowances', 'rooms.members'])
/** the fixture copy of a team folder (a seeded skill), or null */
const fixtureDir = (rel: string) => { const p = path.join(import.meta.dir, 'fixture', 'files', rel); return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null }

function writeResult(dir: string, r: CaseResult) { fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(r, null, 1)) }
function readResults(id: string): CaseResult[] {
  const dir = runDir(id)
  return fs.readdirSync(dir).filter((f) => /^[A-Z]+-\d+(\.[a-z0-9-]+)?\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as CaseResult)
}

async function judgeRun(id: string) {
  const cases = new Map(loadCatalog().map((c) => [c.id, c]))
  const fixture = JSON.parse(fs.readFileSync(STATE, 'utf8')) as FixtureState
  const only = opt('--case')?.split(',')
  const results = readResults(id).filter((r) => (!only || only.includes(r.id)) && cases.has(r.id) && !r.error?.startsWith('blocked:') && !r.error?.startsWith('setup:') && (flag('--again') || !r.judge))
  const queue = [...results]
  const jobs = Math.max(1, Number(opt('--jobs') ?? 4))
  say(`judging ${queue.length} results of ${id} with Sonnet`)
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const c = cases.get(r.id)!
      const role = fixture.people[c.as]?.role ?? 'unknown'
      try { r.judge = await judge(c, r, askerLine(c.as === GUEST.username ? { name: GUEST.name, role: 'guest' } : ((p) => p && { ...p, role })(COMPANY.people.find((p) => p.username === c.as)), role)); writeResult(runDir(id), r); say(`${r.id}: ${r.judge.pass ? 'pass' : 'FAIL'} (${r.judge.root_cause})`) } catch (e) { say(`${r.id}: judge failed: ${e instanceof Error ? e.message : e}`) }
    }
  }))
}

// ---------------- flows ----------------
export const FLOWS_FILE = path.join(import.meta.dir, 'flows.yaml')
export function loadFlows(): Flow[] {
  const fl = FlowCatalog.parse(Bun.YAML.parse(fs.readFileSync(FLOWS_FILE, 'utf8'))).flows
  const ids = new Set<string>()
  for (const f of fl) { if (ids.has(f.id)) throw new Error(`duplicate flow id ${f.id}`); ids.add(f.id) }
  return fl
}
function selectedFlows(all: Flow[]): Flow[] {
  const ids = opt('--flow')?.split(',').map((s) => s.trim())
  const group = opt('--group')
  return all.filter((f) => (!ids || ids.includes(f.id)) && (!group || f.group === group))
}

async function runFlows(): Promise<string> {
  if (!(await healthy())) throw new Error(`no server on ${BASE}: run \`bun run ai:scenarios up\` first`)
  // every run starts from the seeded company, on a fresh data folder: shares, grants and "Always allow" choices of an
  // earlier run (the default run before the --always one) would otherwise carry over and change what the flows see.
  // --keep-state runs on the server as it is.
  if (!flag('--keep-state')) {
    let relay = true
    try { relay = fs.readFileSync(path.join(HOME, 'relay-mode'), 'utf8').trim() === '1' } catch {}
    const devenv = devEnvOn()
    say('fresh data for this run (the company as seeded; --keep-state to skip)')
    mocksDown(HOME, say)
    await up({ reset: true, devenv, relay })
  }
  const fixture = JSON.parse(fs.readFileSync(STATE, 'utf8')) as FixtureState
  const always = flag('--always')
  const id = opt('--run') ?? `flows-${always ? 'always-' : ''}${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  const dir = runDir(id)
  fs.mkdirSync(dir, { recursive: true })
  const flows = selectedFlows(loadFlows())
  // the mock services are needed by the mocked flows; their data starts fresh for each run
  const mocks = flows.some((f) => f.mocked || JSON.stringify(f.steps).includes('{{mock:')) ? await mocksUp({ home: HOME, base: BASE, log: say }) : readMocks(HOME)
  if (mocks) mocksReset(HOME)
  const env = { base: BASE, dataDir: DATA, teamRoot: TEAM, fixture, runId: id, commit: commit(), log: say, mockState: mocks?.state, mockUrl: mocks?.url, mockKey: mocks?.key, mockPort: mocks?.port, cardMode: always ? 'always' as const : 'once' as const }
  say(`flows ${id}: ${flows.length} flows (cards: ${env.cardMode}), results in ${dir}`)
  // The mock services keep ONE state file (a mailbox, Notion pages, ...), so the flows that use them run one after another
  // in a single lane, each starting from the mock data as made (FL-08's judge once saw a mail that FL-12 drafted in the
  // same run). The other flows never touch it and run in the remaining lanes.
  const usesMock = (f: Flow) => f.mocked || JSON.stringify(f.steps).includes('{{mock:')
  const mockQueue = flows.filter(usesMock), plainQueue = flows.filter((f) => !usesMock(f))
  const jobs = Math.max(1, Number(opt('--jobs') ?? 2))
  const lane = async (queue: Flow[], fresh: boolean) => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      if (fresh) mocksReset(HOME)
      const r = await runFlow(f, env)
      fs.writeFileSync(path.join(dir, `${f.id}.json`), JSON.stringify(r, null, 1))
      await cleanUp({ changed: flowChanged(r) } as CaseResult)
      say(`${f.id}: ${r.firstBroken ? `first failed check at step ${r.firstBroken}` : 'every check passed'}`)
    }
  }
  await Promise.all([
    ...(mockQueue.length ? [lane(mockQueue, true)] : []),
    ...Array.from({ length: Math.min(Math.max(1, jobs - (mockQueue.length ? 1 : 0)), plainQueue.length) }, () => lane(plainQueue, false)),
  ])
  return id
}
const readFlowResults = (id: string): FlowResult[] => fs.readdirSync(runDir(id)).filter((f) => /^FL-\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(runDir(id), f), 'utf8')))
async function judgeFlows(id: string) {
  const flows = new Map(loadFlows().map((f) => [f.id, f]))
  const todo = readFlowResults(id).filter((r) => flows.has(r.id) && (flag('--again') || !r.judge))
  say(`judging ${todo.length} flows of ${id} with Sonnet`)
  const queue = [...todo]
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try { r.judge = await judgeFlow(flows.get(r.id)!, r); fs.writeFileSync(path.join(runDir(id), `${r.id}.json`), JSON.stringify(r, null, 1)); const v = r.judge as { pass: boolean; first_broken_step: number | null }; say(`${r.id}: ${v.pass ? 'pass' : `broke at step ${v.first_broken_step}`}`) } catch (e) { say(`${r.id}: judge failed: ${e instanceof Error ? e.message : e}`) }
    }
  }))
}
const latestFlowRun = (always: boolean) => { const l = fs.readdirSync(RUNS).filter((d) => d.startsWith(always ? 'flows-always-' : 'flows-') && (always || !d.startsWith('flows-always-'))).sort(); return l[l.length - 1] }

async function main() {
  switch (cmd) {
    case 'up': await up(); break
    case 'down': await down(); break
    case 'run': await run(); break
    case 'judge': await judgeRun(opt('--run') ?? latestRun()); break
    case 'report': { const all = loadCatalog(); const f = writeReport(all, readResults(opt('--run') ?? latestRun()), runDir(opt('--run') ?? latestRun()), all); say(`report: ${f}`); break }
    case 'all': { await up(); const id = await run(); await judgeRun(id); say(`report: ${writeReport(loadCatalog(), readResults(id), runDir(id))}`); break }
    case 'list': for (const c of selected(loadCatalog())) console.log(`${c.id}\t${c.features[0]}\t${c.kind}\t${c.context}\t${c.as}\t${c.install}\t${c.expect.outcome}${c.fixInProgress ? '\t(fix in progress)' : ''}\t${c.title}`); break
    case 'mocks': if (args[1] === 'down') mocksDown(HOME, say); else await mocksUp({ home: HOME, base: BASE, log: say }); break
    case 'flows': {
      const sub = args[1] ?? 'run'
      if (sub === 'run') { const id = await runFlows(); if (!flag('--no-judge')) await judgeFlows(id); break }
      if (sub === 'judge') { await judgeFlows(opt('--run') ?? latestFlowRun(flag('--always'))!); break }
      if (sub === 'report') {
        const main = opt('--run') ?? latestFlowRun(false)!, al = opt('--always-run') ?? latestFlowRun(true)
        const runs = [{ label: main, results: readFlowResults(main) }, ...(al ? [{ label: al, results: readFlowResults(al) }] : [])]
        say(`report: ${writeFlowReport(loadFlows(), runs, path.join(runDir(main), 'flows-report.md'))}`)
        break
      }
      if (sub === 'list') { for (const f of selectedFlows(loadFlows())) console.log(`${f.id}\t${f.group}\t${f.steps.length} steps${f.mocked ? '\tmocked' : ''}${f.fixInProgress ? '\t(fix in progress)' : ''}\t${f.title}`); break }
      throw new Error(`flows ${sub}?`)
    }
    case 'coverage': { const md = coverageMarkdown(loadCatalog()); if (opt('--out')) fs.writeFileSync(opt('--out')!, md); console.log(md); break }
    default: console.log(fs.readFileSync(import.meta.path, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'))
  }
}

if (import.meta.main) await main().catch((e) => { console.error(`[ai-scenarios] ${e instanceof Error ? e.message : String(e)}`); process.exit(1) })
