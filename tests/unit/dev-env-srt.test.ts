// Dev environment on srt (docs/research/srt-dev-env.md): the settings file, the environment and the argv of a run,
// the plan file parser, the team's extra domains, and box_shell, the queue and the tracker against a fake system (no
// systemd, no srt). The sandbox itself is tested in Docker (tests/linux/srt-attack.sh); systemd, polkit and the memory
// limits on a VM (docs/research/srt-dev-env.md 10.3).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, DEV_ENV_SRT_WARNING_VERSION, DEV_ENV_WARNING_VERSION } from '@mycel/shared/api'
import { DEV_ENV_DEFAULT_DOMAINS, extraDomainProblem } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { DENIED_RANGES, RUN_ID_RE, SRT_PATHS, SRT_VERSION, UNIT_RE, runEnv, scopeArgv, serverFilesOutsideBase, settingsProblems, srtSettings, unitName } from '../../server/src/devenv/srt/config'
import { effectiveLimits, parsePlan, sliceValues, type DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { _active, newRunId, readExit, setSrtSystem, WAIT_MAX_MS } from '../../server/src/devenv/srt/runner'
import { cgroupDir, slicePath, type SpawnSpec, type SrtSystem, type UnitInfo } from '../../server/src/devenv/srt/system'
import { teamHosts } from '../../server/src/devenv/srt/runner'
import { jobResultsForAI, pollJobs } from '../../server/src/devenv/jobs'
import { devEnvInForce, devEnvSetting, newConsent, OFF_SETTING, requiredWarningVersion, saveDevEnvSetting } from '../../server/src/devenv/setting'
import { boxShellTool } from '../../server/src/devenv/tool'
import { configureStorageGuard } from '../../server/src/system/storage'

setDefaultTimeout(40_000)
const REPO = path.join(import.meta.dir, '..', '..')

// ---------------- pure parts ----------------

const BASE = '/var/lib/mycel'
const input = { base: BASE, id: 'mycel', projectId: 'p1', projectDir: `${BASE}/team/projects/falcon`, teamRoot: `${BASE}/team`, network: 'open' as const, extraDomains: ['api.example.net'], denyHosts: ['Team.Trina.App'], denyAddrs: ['3.3.3.3'] }

describe('the srt settings file', () => {
  test('hides the whole base folder and the server file outside it; gives back only three folders', () => {
    const s = srtSettings(input)
    expect(s.filesystem.denyRead).toEqual([BASE, '/etc/default/mycel', '/tmp', '/var/log', '/run', '/home', '/root'])
    expect(s.filesystem.allowRead).toEqual([input.projectDir, `${BASE}/devenv/home/p1`, `${BASE}/devenv/logs/p1`])
    expect(s.filesystem.allowWrite).toEqual([input.projectDir, `${BASE}/devenv/home/p1`])
    expect(settingsProblems(s, input)).toEqual([])
  })
  test('the network: the default list plus the team list; offline is an empty list; addresses and host names denied', () => {
    const s = srtSettings(input)
    expect(s.network.allowedDomains).toEqual([...DEV_ENV_DEFAULT_DOMAINS, 'api.example.net'])
    expect(s.network.strictAllowlist).toBe(true)
    expect(s.network.deniedDomains).toEqual(['team.trina.app'])
    expect(s.network.deniedResolvedAddresses).toEqual([...DENIED_RANGES, '3.3.3.3'])
    expect(s.network.deniedResolvedAddresses).toContain('169.254.0.0/16')
    expect(s.network.deniedResolvedAddresses).toContain('100.64.0.0/10')
    expect(srtSettings({ ...input, network: 'offline' }).network.allowedDomains).toEqual([])
  })
  test('a team folder outside the base folder is hidden too', () => {
    const s = srtSettings({ ...input, teamRoot: '/srv/team', projectDir: '/srv/team/a' })
    expect(s.filesystem.denyRead).toContain('/srv/team')
    expect(settingsProblems(s, { base: BASE, projectDir: '/srv/team/a', teamRoot: '/srv/team' })).toEqual([])
  })
  test('the check refuses a writable parent, a project outside the team folder, the team folder itself', () => {
    const s = srtSettings(input)
    expect(settingsProblems({ ...s, filesystem: { ...s.filesystem, allowWrite: [...s.filesystem.allowWrite, `${BASE}/team`] } }, input).join()).toContain('parent of the project folder')
    expect(settingsProblems({ ...s, filesystem: { ...s.filesystem, allowWrite: [`${BASE}/secrets`] } }, input).join()).toContain('writable path in the base folder')
    expect(settingsProblems({ ...s, filesystem: { ...s.filesystem, denyRead: ['/tmp'] } }, input).join()).toContain('base folder is not hidden')
    expect(settingsProblems(srtSettings({ ...input, projectDir: `${BASE}/team` }), { ...input, projectDir: `${BASE}/team` }).join()).toContain('not a folder of the team folder')
    expect(settingsProblems(srtSettings({ ...input, projectDir: '/etc' }), { ...input, projectDir: '/etc' }).join()).toContain('not a folder of the team folder')
  })
  test('the programs a run executes are outside every base folder', () => {
    for (const p of Object.values(SRT_PATHS)) expect(p.startsWith('/var/lib/')).toBe(false)
    expect(SRT_PATHS.cli).toBe(`/opt/trina/srt/${SRT_VERSION}/cli.js`)
  })
})

describe('the environment and the argv of a run', () => {
  test('only the listed keys; HOME, TMPDIR and srt\'s temp folder in the project home', () => {
    const e = runEnv({ base: BASE, projectId: 'p1' })
    expect(Object.keys(e).sort()).toEqual(['CI', 'CLAUDE_CODE_TMPDIR', 'HOME', 'LANG', 'PATH', 'PIP_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'SHELL', 'TERM', 'TMPDIR', 'TRINA_LOGS', 'npm_config_cache'])
    expect(e.HOME).toBe(`${BASE}/devenv/home/p1`)
    expect(e.TMPDIR).toBe(`${BASE}/devenv/home/p1/tmp`)
    expect(e.CLAUDE_CODE_TMPDIR).toBe(e.TMPDIR!)
    expect(e.TRINA_LOGS).toBe(`${BASE}/devenv/logs/p1`)
    expect(e.PATH!.startsWith('/opt/trina/node/bin:')).toBe(true)
  })
  test('systemd-run makes a scope that the polkit rule allows, with the limits; srt gets the command as one argument', () => {
    const runId = newRunId()
    expect(runId).toMatch(RUN_ID_RE)
    const a = scopeArgv({ runId, id: 'mycel', limits: { cpus: 1.5, memoryMiB: 1536, pids: 512, runtimeMaxSec: 150 }, exitFile: '/x.exit', settingsFile: '/s.json', command: 'npm test; rm -rf /' })
    expect(a.slice(0, 4)).toEqual(['/usr/bin/systemd-run', '--scope', '--quiet', '--no-ask-password'])
    expect(a).toContain(`--unit=${unitName(runId)}`)
    expect(unitName(runId)).toMatch(UNIT_RE)
    expect(a).toContain('--slice=mycel-devenv.slice')
    for (const p of ['MemoryMax=1536M', 'MemoryHigh=1382M', 'MemorySwapMax=0', 'CPUQuota=150%', 'TasksMax=512', 'OOMPolicy=kill', 'RuntimeMaxSec=150']) expect(a).toContain(p)
    expect(a.slice(a.indexOf('--') + 1)).toEqual([SRT_PATHS.runWrap, '/x.exit', '--', SRT_PATHS.node, SRT_PATHS.cli, '--settings', '/s.json', '-c', 'npm test; rm -rf /'])
  })
  test('the polkit rule allows the same unit names as the runner, and no .service', () => {
    const rule = fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/devenv.rules.in'), 'utf8')
    const re = /\/(\^trina-dev-\[a-z0-9\]\{16\}\\\.scope\$)\//.exec(rule)
    expect(re).not.toBeNull()
    expect(new RegExp(re![1]!).source).toBe(UNIT_RE.source)
    expect(rule.split('\n').filter((l) => !l.startsWith('//')).join('\n')).not.toContain('.service')
    expect(rule).toContain('manage-units')
  })
  test('the install pins the same srt version, and hides the same server files outside the base', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/package.json'), 'utf8'))
    expect(pkg.dependencies['@anthropic-ai/sandbox-runtime']).toBe(SRT_VERSION)
    const lock = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/package-lock.json'), 'utf8'))
    expect(lock.packages['node_modules/@anthropic-ai/sandbox-runtime'].version).toBe(SRT_VERSION)
    for (const [k, v] of Object.entries(lock.packages as Record<string, { integrity?: string }>)) if (k) expect(v.integrity).toMatch(/^sha512-/)
    const sh = fs.readFileSync(path.join(REPO, 'scripts/dev-env/srt/install-srt.sh'), 'utf8')
    expect(sh).toContain(`SRT_VERSION=${SRT_VERSION}`)
    const files = /SERVER_FILES_OUTSIDE_BASE="([^"]*)"/.exec(sh)![1]!.split(' ').map((f) => f.replace('$ID', 'mycel'))
    expect(files).toEqual(serverFilesOutsideBase('mycel'))
    expect(sh).toContain('ReadWritePaths=$BASE/devenv')
    expect(sh).toContain('MYCEL_DEV_ENV_RUNNER=srt')
  })
  test('the exit file: a number from 0 to 255, else none', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-'))
    for (const [t, want] of [['0\n', 0], ['137\n', 137], ['255', 255], ['', null], ['256', null], ['-1', null], ['abc', null], ['1 2', null]] as const) {
      fs.writeFileSync(path.join(d, 'e'), t)
      expect(readExit(path.join(d, 'e'))).toBe(want)
    }
    expect(readExit(path.join(d, 'none'))).toBeNull()
  })
})

describe('the plan file (the same rules as mycel-boxd)', () => {
  const ok = '{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}'
  test('a good file; network empty means offline', () => {
    expect(parsePlan(ok)).toMatchObject({ plan: 'team', maxRunning: 1, memoryMiB: 2560, network: '' })
  })
  test('the cases that plan_test.go refuses', () => {
    for (const bad of [
      '{"format":2,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}',
      '{"format":1,"plan":"","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}',
      '{"format":1,"plan":"team","maxRunning":0,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4}',
      '{"format":1,"plan":"team","maxRunning":1,"cpus":8,"memoryMiB":2560,"pids":512,"diskGiB":4}',
      '{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4,"network":"host"}',
      '{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512,"diskGiB":4,"gpu":1}',
      '{"format":1,"plan":"team","maxRunning":1,"cpus":1,"memoryMiB":2560,"pids":512}',
      'not json', '[]',
    ]) expect(() => parsePlan(bad)).toThrow()
  })
  test('a run gets the project\'s wish, cut to the plan; the plan\'s offline wins', () => {
    const plan = parsePlan('{"format":1,"plan":"starter","maxRunning":1,"cpus":1.5,"memoryMiB":1536,"pids":512,"diskGiB":4,"network":"open"}')
    expect(effectiveLimits({ ...DEV_ENV_DEFAULT_LIMITS, cpus: 4, memoryMiB: 8192, pids: 4096 }, 'open', plan)).toEqual({ cpus: 1.5, memoryMiB: 1536, pids: 512, network: 'open', maxRunning: 1 })
    expect(effectiveLimits(DEV_ENV_DEFAULT_LIMITS, 'open', { ...plan, network: '' }).network).toBe('offline')
    expect(effectiveLimits(DEV_ENV_DEFAULT_LIMITS, 'open', null)).toMatchObject({ cpus: 1, memoryMiB: 2560, network: 'open', maxRunning: 2 })
    expect(sliceValues(plan)).toEqual({ MemoryMax: '1536M', CPUQuota: '150%', TasksMax: 2048 })
  })
})

describe('the host names of this server', () => {
  test('from the public origins and the relay, with no env setting; loopback is not a team host', () => {
    const config = { publicOrigins: ['https://Acme.trina.app', 'http://127.0.0.1:3000'], relay: { url: 'wss://relay.trina.app/connect', teamName: 'acme' } }
    expect(teamHosts({ config } as never, {})).toEqual(['acme.trina.app', 'relay.trina.app'])
    expect(teamHosts({ config: { publicOrigins: [], relay: { url: null, teamName: null } } } as never, { MYCEL_DEV_ENV_DENY_HOSTS: 'a.example, b.example' })).toEqual(['a.example', 'b.example'])
    expect(extraDomainProblem('*.trina.app', teamHosts({ config } as never, {}))).toContain('this Trina server')
  })
  test('the cgroup path follows systemd\'s slice nesting, also for an id with a dash', () => {
    expect(slicePath('mycel-devenv.slice')).toBe('mycel.slice/mycel-devenv.slice')
    expect(slicePath('trina-ax-devenv.slice')).toBe('trina.slice/trina-ax.slice/trina-ax-devenv.slice')
    expect(cgroupDir('mycel', 'abc')).toBe('/sys/fs/cgroup/mycel.slice/mycel-devenv.slice/trina-dev-abc.scope')
  })
})

describe('the team\'s extra domains', () => {
  test('host names with two labels, or *. and one', () => {
    for (const d of ['api.example.net', '*.example.net', 'cdn.jsdelivr.net']) expect(extraDomainProblem(d)).toBeNull()
  })
  test('refused: IP addresses, *, public suffixes, uppercase, one label, this server', () => {
    expect(extraDomainProblem('1.2.3.4')).toContain('IP')
    expect(extraDomainProblem('*')).not.toBeNull()
    expect(extraDomainProblem('*.com')).toContain('public suffix')
    expect(extraDomainProblem('*.co.kr')).toContain('public suffix')
    expect(extraDomainProblem('Example.com')).toContain('lowercase')
    expect(extraDomainProblem('localhost')).not.toBeNull()
    expect(extraDomainProblem('a.*.example.com')).not.toBeNull()
    expect(extraDomainProblem('trina.app', ['team1.trina.app'])).toContain('this Trina server')
    expect(extraDomainProblem('team1.trina.app', ['team1.trina.app'])).toContain('this Trina server')
  })
})

// ---------------- the runner against a fake system ----------------

interface FakeRun { spec: SpawnSpec; settings: Record<string, unknown>; settingsMode: number; state: 'active' | 'gone' | 'failed'; result: string; resolve: (v: { code: number | null; signal: string | null }) => void; oom: number }
const runs = new Map<string, FakeRun>()
const stops: string[] = []
let selfTestProblem = ''
let cpu = 0
/** commands: "echo X", "exit N", "write <rel> <text>", "sleep" (runs until stopped or ended), "oom" (the kernel kills it) */
const fake: SrtSystem = {
  spawn(spec) {
    const settings = JSON.parse(fs.readFileSync(spec.settingsFile, 'utf8'))
    const settingsMode = fs.statSync(spec.settingsFile).mode & 0o777
    let resolve!: FakeRun['resolve']
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    const r: FakeRun = { spec, settings, settingsMode, state: 'active', result: '', resolve, oom: 0 }
    runs.set(spec.runId, r)
    const c = spec.command
    const end = (code: number) => { fs.writeFileSync(spec.exitFile, `${code}\n`); r.state = 'gone'; resolve({ code, signal: null }) }
    queueMicrotask(() => {
      if (c === 'sleep') return
      if (c === 'oom') { r.oom = 1; r.state = 'failed'; r.result = 'oom-kill'; resolve({ code: null, signal: 'SIGKILL' }); return }
      let m = /^echo (.*)$/.exec(c)
      if (m) { fs.appendFileSync(spec.stdoutFile, m[1] + '\n'); return end(0) }
      m = /^exit (\d+)$/.exec(c)
      if (m) return end(Number(m[1]))
      m = /^write (\S+) (.*)$/.exec(c)
      if (m) { fs.writeFileSync(path.join(spec.cwd, m[1]!), m[2]!); return end(0) }
      fs.appendFileSync(spec.stderrFile, `unknown: ${c}\n`); end(127)
    })
    return { pid: 999_999, exited }
  },
  async stop(runId) { stops.push(runId); const r = runs.get(runId); if (r && r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGTERM' }) } },
  async unit(runId): Promise<UnitInfo> { const r = runs.get(runId); return !r || r.state === 'gone' ? { state: '', result: '', memoryBytes: null } : { state: r.state, result: r.result, memoryBytes: 50 << 20 } },
  async units() { return [...runs.entries()].filter(([, r]) => r.state !== 'gone').map(([id]) => unitName(id)) },
  async forget(runId) { const r = runs.get(runId); if (r) r.state = 'gone' },
  oomKills(runId) { return runs.get(runId)?.oom ?? null },
  cpuUsec() { return cpu },
  procs() { return [] },
  async selfTest() { return selfTestProblem },
}
/** the fake run of a job or dev server ends with this code (the exit file run-wrap writes) */
const finish = (runId: string, code: number, log = '') => {
  const r = runs.get(runId)!
  if (log) fs.appendFileSync(r.spec.stdoutFile, log)
  fs.writeFileSync(r.spec.exitFile, `${code}\n`); r.state = 'gone'; r.resolve({ code, signal: null })
}

let h: Harness
let devBase = ''
let projectId = '', otherId = '', chatId = ''
const FOLDER = 'projects/falcon'
const STARTER: DevEnvPlan = { format: 1, plan: 'starter', maxRunning: 1, cpus: 1.5, memoryMiB: 1536, pids: 512, diskGiB: 4, network: 'open' }
const publish: { user: string; frame: { type: string; data: { code?: string; message?: string } } }[] = []

const shell = (userId = 'alice', project = { id: projectId, folderPath: FOLDER, name: 'Falcon' }, signal = new AbortController().signal) =>
  boxShellTool({ ctx: h.ctx, project, userId, turnId: 'turn-1', chatId, signal, confirm: async () => null, redact: (s) => s.replaceAll('hunter2', '[hidden]') })
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const rows = () => h.ctx.db.query('SELECT * FROM dev_env_jobs ORDER BY started_at, id').all() as Record<string, unknown>[]
const runIdOfRow = (r: Record<string, unknown>) => String(r.unit).slice('trina-dev-'.length, -'.scope'.length)
const turnOn = (id: string) => saveDevEnvSetting(h.ctx.db, id, { ...OFF_SETTING, enabled: true, consent: newConsent({ id: 'carol', name: 'Carol Park' }) })

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  process.env.MYCEL_DEV_ENV_RUNNER = 'srt'
  process.env.MYCEL_TEST_SECRET_FOR_SRT = 'CANARY-ENV'
  h = await startHarness({ name: 'dev-env-srt' })
  devBase = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-base-'))
  setSrtSystem(fake, { base: devBase, id: 'mycel', plan: STARTER })
  projectId = (await h.api('alice').call(API.createProject, { body: { name: 'Falcon', folderPath: FOLDER, instructions: '' } })).id
  otherId = (await h.api('alice').call(API.createProject, { body: { name: 'Hawk', folderPath: 'groups/marketing', instructions: '' } })).id
  chatId = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
  turnOn(projectId); turnOn(otherId)
  const real = h.ctx.services.realtime.publish.bind(h.ctx.services.realtime)
  h.ctx.services.realtime.publish = ((user: string, frame: never) => { publish.push({ user, frame }); return real(user, frame) }) as typeof h.ctx.services.realtime.publish
})
afterAll(async () => {
  setSrtSystem(null)
  for (const k of ['MYCEL_DEV_ENV', 'MYCEL_DEV_ENV_RUNNER', 'MYCEL_TEST_SECRET_FOR_SRT']) delete process.env[k]
  await h.close()
  fs.rmSync(devBase, { recursive: true, force: true })
})
beforeEach(() => {
  for (const r of runs.values()) if (r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGKILL' }) }
  runs.clear(); stops.length = 0; publish.length = 0; selfTestProblem = ''; cpu = 0
  _active().clear()
  setSrtSystem(fake, { base: devBase, id: 'mycel', plan: STARTER })
  for (const t of ['dev_env_jobs', 'dev_env_stops', 'dev_env_notices']) h.ctx.db.query(`DELETE FROM ${t}`).run()
  h.ctx.db.query("DELETE FROM audit_log WHERE action LIKE 'dev_env.%'").run()
  turnOn(projectId); turnOn(otherId)
})

describe('the warning version', () => {
  test('srt asks for its own warning; a consent to the box warning does not count', () => {
    expect(requiredWarningVersion()).toBe(DEV_ENV_SRT_WARNING_VERSION)
    expect(requiredWarningVersion({})).toBe(DEV_ENV_WARNING_VERSION)
    const s = devEnvSetting(h.ctx.db, projectId)
    expect(devEnvInForce(s)).toBe(true)
    expect(devEnvInForce({ ...s, consent: { ...s.consent!, warningVersion: DEV_ENV_WARNING_VERSION } })).toBe(false)
  })
  test('the project page asks for version 2 and has no box', async () => {
    const r = await h.api('alice').call(API.devEnv, { params: { id: projectId } })
    expect(r.warningVersion).toBe(DEV_ENV_SRT_WARNING_VERSION)
    expect(r.box).toBeNull()
    expect(r.availability).toEqual({ available: true })
    expect(r.runs).toEqual({ running: [], waiting: [] })
  })
  test('availability says why srt cannot run', async () => {
    selfTestProblem = 'cannot start a scope (polkit rule or slice missing)'
    setSrtSystem(fake, { base: devBase, id: 'mycel', plan: STARTER })
    const r = await h.api('alice').call(API.devEnv, { params: { id: projectId } })
    expect(r.availability).toMatchObject({ available: false, reason: 'platform' })
    expect(r.availability.detail).toContain('polkit')
  })
})

describe('a command', () => {
  test('runs in the project folder with the settings of the project; output and exit code come back; files are recorded', async () => {
    const r = await shell().call({ command: 'echo hello' })
    expect(r.isError).toBeUndefined()
    expect(out(r)).toContain('Exit code 0.')
    expect(out(r)).toContain('hello')
    const run = [...runs.values()][0]!
    expect(run.spec.cwd).toBe(fs.realpathSync(path.join(h.team, FOLDER)))
    expect(run.spec.limits).toEqual({ cpus: 1, memoryMiB: 1536, pids: 512, runtimeMaxSec: 150 })
    expect(run.settingsMode).toBe(0o600)
    expect((run.settings as { filesystem: { denyRead: string[]; allowWrite: string[] } }).filesystem.allowWrite).toEqual([path.join(h.team, FOLDER), path.join(devBase, 'devenv/home', projectId)])
    expect((run.settings as { filesystem: { denyRead: string[] } }).filesystem.denyRead).toContain(devBase)
    expect((run.settings as { filesystem: { denyRead: string[] } }).filesystem.denyRead).toContain(h.team)
    // the settings file, the output files and the exit file are gone after the run
    expect(fs.existsSync(run.spec.settingsFile)).toBe(false)
    expect(fs.existsSync(run.spec.stdoutFile)).toBe(false)
    expect(fs.existsSync(run.spec.exitFile)).toBe(false)
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'dev_env.command' AND target = ?").get(projectId) as { detail: string }
    expect(JSON.parse(audit.detail)).toMatchObject({ runner: 'srt', result: { code: 0, signal: '' } })
  })
  test('the environment is the listed keys only: nothing from the server\'s environment', async () => {
    await shell().call({ command: 'echo x' })
    const env = [...runs.values()][0]!.spec.env
    expect(env).toEqual(runEnv({ base: devBase, projectId }))
    expect(JSON.stringify(env)).not.toContain('CANARY-ENV')
    expect(Object.keys(env).some((k) => k.startsWith('MYCEL'))).toBe(false)
  })
  test('a cwd in the project; changed files come back', async () => {
    fs.mkdirSync(path.join(h.team, FOLDER, 'src'), { recursive: true })
    const r = await shell().call({ command: 'write a.txt hi', cwd: 'src' })
    expect(out(r)).toContain('created')
    expect(out(r)).toContain('src/a.txt')
    expect([...runs.values()][0]!.spec.cwd).toBe(fs.realpathSync(path.join(h.team, FOLDER, 'src')))
  })
  test('a cwd through a link out of the project folder is refused before the run (A10)', async () => {
    const link = path.join(h.team, FOLDER, 'out')
    fs.rmSync(link, { force: true })
    fs.symlinkSync(devBase, link)
    try {
      const r = await shell().call({ command: 'echo x', cwd: 'out' })
      expect(r.isError).toBe(true)
      expect(out(r)).toContain('cwd must be a folder inside the project folder')
      expect(runs.size).toBe(0)
    } finally { fs.rmSync(link, { force: true }) }
  })
  test('a failing command; an unknown one has stderr', async () => {
    expect(out(await shell().call({ command: 'exit 3' }))).toContain('Exit code 3.')
    const r = await shell().call({ command: 'nope' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('unknown: nope')
  })
  test('the time limit stops the scope', async () => {
    const r = await shell().call({ command: 'sleep', timeout_sec: 1 })
    expect(out(r)).toContain('Stopped: the time limit (1 s) was reached.')
    expect(stops).toHaveLength(1)
  })
  test('out of memory: the kernel killed it', async () => {
    const r = await shell().call({ command: 'oom' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('ran out of memory')
  })
  test('a stop of the turn stops the scope', async () => {
    const ac = new AbortController()
    const p = shell('alice', undefined, ac.signal).call({ command: 'sleep' })
    await Bun.sleep(50)
    ac.abort()
    expect(out(await p)).toContain('Stopped.')
  })
  test('one command at a time per project; past maxRunning + 1 on the server the call is refused at once', async () => {
    const a = shell().call({ command: 'sleep', timeout_sec: 2 })
    const b = shell().call({ command: 'echo second', timeout_sec: 5 })
    await Bun.sleep(100)
    expect(runs.size).toBe(1) // b waits for a
    const c = shell('alice', { id: otherId, folderPath: 'groups/marketing', name: 'Hawk' }).call({ command: 'sleep', timeout_sec: 2 })
    await Bun.sleep(100)
    expect(runs.size).toBe(2)
    // Starter: maxRunning 1, so at most 2 commands on the server
    const d = await shell('alice', { id: otherId, folderPath: 'groups/marketing', name: 'Hawk' }).call({ command: 'echo third' })
    expect(out(d)).toContain('busy')
    await Promise.all([a, c])
    expect(out(await b)).toContain('second')
  })
})

describe('jobs and the queue', () => {
  test('a job starts at once when a slot is free; the row has its scope', async () => {
    const r = await shell().call({ command: 'sleep', job: true, log_name: 'render' })
    expect(out(r)).toContain('Started as job render (log: $TRINA_LOGS/render.log)')
    expect(rows()).toMatchObject([{ name: 'render', state: 'running', kind: 'job', ended_at: null, command: 'sleep' }])
    expect(String(rows()[0]!.unit)).toMatch(UNIT_RE)
    expect([...runs.values()][0]!.spec.limits.runtimeMaxSec).toBe(6 * 3600)
  })
  test('over maxRunning a job waits (FIFO, across projects) and starts when the slot is free', async () => {
    await shell().call({ command: 'sleep', job: true, log_name: 'one' })
    const r2 = await shell('alice', { id: otherId, folderPath: 'groups/marketing', name: 'Hawk' }).call({ command: 'echo two', job: true, log_name: 'two' })
    expect(out(r2)).toContain('Queued as job two')
    expect(out(r2)).toContain('position 1')
    const r3 = await shell().call({ command: 'echo three hunter2', job: true, log_name: 'three' })
    expect(out(r3)).toContain('position 2')
    expect(rows().map((r) => [r.name, r.state])).toEqual([['one', 'running'], ['two', 'waiting'], ['three', 'waiting']])
    // the row keeps the command with secrets hidden; the real one waits in a file the sandbox cannot read
    expect(rows()[2]!.command).toBe('echo three [hidden]')
    const page = await h.api('alice').call(API.devEnv, { params: { id: projectId } })
    expect(page.runs.running.map((x) => x.name)).toEqual(['one'])
    expect(page.runs.waiting).toMatchObject([{ name: 'three', position: 2, runAt: null }])
    finish(runIdOfRow(rows()[0]!), 0, 'frame=100\ndone\n')
    await pollJobs(h.ctx)
    expect(rows().map((r) => [r.name, r.state, r.end_reason])).toEqual([['one', 'ended', 'exit'], ['two', 'running', ''], ['three', 'waiting', '']])
    expect(rows()[0]!.exit_code).toBe(0)
    expect(publish.filter((p) => p.frame.data.code === 'dev_env_job')).toHaveLength(1)
    // the job that started runs the real command
    expect(runs.get(runIdOfRow(rows()[1]!))!.spec.command).toBe('echo two')
    finish(runIdOfRow(rows()[1]!), 0)
    await pollJobs(h.ctx)
    expect(runs.get(runIdOfRow(rows()[2]!))!.spec.command).toBe('echo three hunter2')
    // the AI hears of the jobs of this project once
    const told = jobResultsForAI(h.ctx, projectId)
    expect(told.join('\n')).toContain('Job one ended with exit code 0.')
    expect(told.join('\n')).toContain('done')
  })
  test('at most 3 waiting jobs per project', async () => {
    await shell().call({ command: 'sleep', job: true, log_name: 'run' })
    for (const n of ['w1', 'w2', 'w3']) expect(out(await shell().call({ command: 'sleep', job: true, log_name: n }))).toContain('Queued')
    const r = await shell().call({ command: 'sleep', job: true, log_name: 'w4' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('queue full')
  })
  test('a waiting job ends "expired" after 24 hours', async () => {
    await shell().call({ command: 'sleep', job: true, log_name: 'run' })
    await shell().call({ command: 'sleep', job: true, log_name: 'late' })
    h.ctx.db.query("UPDATE dev_env_jobs SET started_at = ? WHERE name = 'late'").run(new Date(Date.now() - WAIT_MAX_MS - 1000).toISOString())
    await pollJobs(h.ctx)
    expect(rows().find((r) => r.name === 'late')).toMatchObject({ state: 'ended', end_reason: 'expired' })
  })
  test('before a waiting job starts, the access is checked again', async () => {
    await shell().call({ command: 'sleep', job: true, log_name: 'run' })
    await shell().call({ command: 'echo x', job: true, log_name: 'next' })
    saveDevEnvSetting(h.ctx.db, projectId, { ...devEnvSetting(h.ctx.db, projectId), scope: { mode: 'selected', groupIds: [], userIds: [] } })
    finish(runIdOfRow(rows()[0]!), 0)
    await pollJobs(h.ctx)
    expect(rows().find((r) => r.name === 'next')).toMatchObject({ state: 'ended', end_reason: 'setting' })
  })
  test('a job killed for memory ends "oom" with a notice; a scope that is gone with no exit file ends "lost"', async () => {
    await shell().call({ command: 'sleep', job: true, log_name: 'big' })
    const r = runs.get(runIdOfRow(rows()[0]!))!
    r.state = 'failed'; r.result = 'oom-kill'; r.resolve({ code: null, signal: 'SIGKILL' })
    await pollJobs(h.ctx)
    expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'oom', exit_code: null })
    expect(publish.find((p) => p.frame.data.code === 'dev_env_job')!.frame.data.message).toContain('ran out of memory')
    // the inbox says why (the page shows a text for the reason)
    const inbox = (await h.api('alice').call(API.listNotifications, { query: {} })).items.find((i) => i.devEnv?.job?.name === 'big')
    expect(inbox?.devEnv?.job).toMatchObject({ exitCode: null, reason: 'oom' })
    await shell().call({ command: 'sleep', job: true, log_name: 'gone' })
    runs.get(runIdOfRow(rows()[1]!))!.state = 'gone'
    await pollJobs(h.ctx)
    expect(rows()[1]).toMatchObject({ state: 'ended', end_reason: 'lost' })
  })
  test('a person stops a job or cancels a waiting one on the project page', async () => {
    await shell().call({ command: 'sleep', job: true, log_name: 'run' })
    await shell().call({ command: 'sleep', job: true, log_name: 'wait' })
    const [run, wait] = rows()
    await h.api('alice').call(API.devEnvRunStop, { params: { id: projectId, runId: String(wait!.id) } })
    expect(rows()[1]).toMatchObject({ state: 'ended', end_reason: 'stopped' })
    const page = await h.api('alice').call(API.devEnvRunStop, { params: { id: projectId, runId: String(run!.id) } })
    expect(stops).toContain(runIdOfRow(run!))
    expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'stopped' })
    expect(page.runs).toEqual({ running: [], waiting: [] })
  })
})

describe('dev servers', () => {
  test('one per project, at most maxRunning on the server, no queue; no notice when it ends', async () => {
    const r = await shell().call({ command: 'sleep', background: true, log_name: 'web' })
    expect(out(r)).toContain('Started in the background')
    expect(rows()).toMatchObject([{ name: 'web', kind: 'server', state: 'running' }])
    expect([...runs.values()][0]!.spec.limits.runtimeMaxSec).toBe(8 * 3600)
    expect(out(await shell().call({ command: 'sleep', background: true, log_name: 'web2' }))).toContain('a dev server runs in this project already (web)')
    expect(out(await shell('alice', { id: otherId, folderPath: 'groups/marketing', name: 'Hawk' }).call({ command: 'sleep', background: true }))).toContain('the most it allows')
    finish(runIdOfRow(rows()[0]!), 1)
    await pollJobs(h.ctx)
    expect(rows()[0]).toMatchObject({ state: 'ended' })
    expect(publish.filter((p) => p.frame.data.code === 'dev_env_job')).toHaveLength(0)
    expect(jobResultsForAI(h.ctx, projectId)).toEqual([])
  })
  test('a change of the project setting stops every run of the project', async () => {
    await shell().call({ command: 'sleep', background: true, log_name: 'web' })
    const s = devEnvSetting(h.ctx.db, projectId)
    await h.api('carol').call(API.updateDevEnv, { params: { id: projectId }, body: { enabled: true, scope: s.scope, network: 'offline' } })
    expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'setting' })
    expect(stops).toHaveLength(1)
    await shell().call({ command: 'echo x' })
    expect((([...runs.values()].at(-1)!.settings) as { network: { allowedDomains: string[] } }).network.allowedDomains).toEqual([])
  })
  test('preview is not available on srt yet', async () => {
    await expect(h.api('alice').call(API.devEnvPreview, { params: { id: projectId }, body: { port: 3000 } })).rejects.toThrow()
  })
})

describe('the tracker', () => {
  test('after a restart a unit with no row is stopped; a row whose unit is gone ends "lost"', async () => {
    const { reconcile } = await import('../../server/src/devenv/srt/runner')
    await shell().call({ command: 'sleep', job: true, log_name: 'kept' })
    // an orphan: a scope that no row names
    const orphan = newRunId()
    fake.spawn({ runId: orphan, id: 'mycel', cwd: '/', env: {}, limits: { cpus: 1, memoryMiB: 256, pids: 64, runtimeMaxSec: 10 }, exitFile: path.join(devBase, 'o.exit'), settingsFile: writeTmp('{}'), command: 'sleep', stdoutFile: path.join(devBase, 'o.out'), stderrFile: path.join(devBase, 'o.err') })
    await reconcile(h.ctx)
    expect(stops).toEqual([orphan])
  })
  test('under the disk floor every run stops with "disk" and people hear why', async () => {
    await shell().call({ command: 'sleep', job: true, log_name: 'big' })
    configureStorageGuard({ root: h.team, statfs: () => ({ bsize: 4096, blocks: 1_000_000, bfree: 10, bavail: 10 }), enforce: () => true })
    try { await pollJobs(h.ctx) } finally { configureStorageGuard(null) }
    expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'disk' })
    expect(publish.some((p) => p.frame.data.code === 'dev_env_box_stopped' && String(p.frame.data.message).includes('nearly full'))).toBe(true)
  })
})

describe('the team\'s sites (admins)', () => {
  test('read and change; bad domains refused; the next run gets them', async () => {
    const r = await h.api('carol').call(API.devEnvTeam, {})
    expect(r).toMatchObject({ runner: 'srt', setting: { extraDomains: [] }, plan: { plan: 'starter', maxRunning: 1 } })
    expect(r.defaultDomains).toContain('registry.npmjs.org')
    await expect(h.api('carol').call(API.updateDevEnvTeam, { body: { extraDomains: ['*.com'] } })).rejects.toThrow()
    await expect(h.api('alice').call(API.updateDevEnvTeam, { body: { extraDomains: ['api.example.net'] } })).rejects.toThrow()
    await h.api('carol').call(API.updateDevEnvTeam, { body: { extraDomains: ['api.example.net', 'API.example.net'] } })
    await shell().call({ command: 'echo x' })
    expect(([...runs.values()].at(-1)!.settings as { network: { allowedDomains: string[] } }).network.allowedDomains).toContain('api.example.net')
    await h.api('carol').call(API.updateDevEnvTeam, { body: { extraDomains: [] } })
  })
})

function writeTmp(t: string) { const f = path.join(devBase, `t-${newRunId()}.json`); fs.writeFileSync(f, t); return f }
