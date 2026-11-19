// A foreground command stops like a job when its person loses the folder (taken out of the project) or the dev
// environment is turned off while it runs (QA TC-1143, TC-1144): the tracker checks the commands of this process too.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import { personHome, projectHome, unitName } from '../../server/src/devenv/srt/config'
import type { SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { pollSrt } from '../../server/src/devenv/jobs'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool } from '../../server/src/devenv/tool'
setDefaultTimeout(40_000)
const PLAN2: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
interface FakeRun { spec: SpawnSpec; state: 'active' | 'gone'; resolve: (v: { code: number | null; signal: string | null }) => void }
const runs = new Map<string, FakeRun>()
let onSpawn: ((spec: SpawnSpec) => void) | null = null
const stops: string[] = []
const fake: SrtSystem = {
  spawn(spec) {
    let resolve!: FakeRun['resolve']
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    runs.set(spec.runId, { spec, state: 'active', resolve })
    onSpawn?.(spec)
    const m = /^echo (.*)$/.exec(spec.command.split('\n').pop()!)
    if (m) queueMicrotask(() => { fs.appendFileSync(spec.stdoutFile, m[1] + '\n'); fs.writeFileSync(spec.exitFile, '0\n'); runs.get(spec.runId)!.state = 'gone'; resolve({ code: 0, signal: null }) })
    return { pid: 999_999, exited }
  },
  async stop(runId) { stops.push(runId); const r = runs.get(runId); if (r && r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGTERM' }) } },
  async unit(runId): Promise<UnitInfo> { const r = runs.get(runId); return !r || r.state === 'gone' ? { state: '', result: '', memoryBytes: null } : { state: 'active', result: '', memoryBytes: 50 << 20 } },
  async units() { return [...runs.entries()].filter(([, r]) => r.state !== 'gone').map(([id]) => unitName(id)) },
  async forget(runId) { const r = runs.get(runId); if (r) r.state = 'gone' },
  oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}
let h: Harness, base = '', P: { id: string; folderPath: string; name: string }
let chatA = '', chatB = ''
const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
const shell = (userId: string, chatId: string, signal = new AbortController().signal) =>
  boxShellTool({ ctx: h.ctx, project: P, userId, turnId: 't-' + userId, chatId, signal, confirm: async () => null, redact: (s) => s })
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const rows = () => h.ctx.db.query('SELECT * FROM dev_env_runs ORDER BY started_at, id').all() as any[]
const turnOn = (patch: Partial<ReturnType<typeof teamSetting>> = {}) =>
  saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }), ...patch })
const setParts = async (ids: string[]) => {
  const a = await h.api('dana').call(API.getProjectAccess, { params: { id: P.id } })
  await h.api('dana').call(API.putProjectParticipants, { params: { id: P.id }, body: { participants: ids.map(user), expectedHash: a.rulesHash } })
}
beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'gapA-proj' })
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'))
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN2 })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Proj P', participants: [user('alice'), user('bob')], instructions: '' } })
  P = { id: p.id, folderPath: p.folderPath, name: p.name }
  chatA = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
  chatB = (await h.api('bob').call(API.createChat, { body: { projectId: P.id } })).id
})
afterAll(async () => { setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(async () => {
  for (const r of runs.values()) if (r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGKILL' }) }
  runs.clear(); stops.length = 0; _active().clear()
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN2 })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  turnOn()
  await setParts(['alice', 'bob'])
})

describe('a running foreground command', () => {
  test('the team turns the dev environment off: it stops and the person is told why', async () => {
    const cmd = shell('alice', chatA).call({ command: 'sleep', timeout_sec: 60 })
    await Bun.sleep(100)
    expect(runs.size).toBe(1)
    await h.api('carol').call(API.updateDevEnvTeam, { body: { enabled: false } })
    const text = out(await cmd)
    expect(text).toContain('Stopped: the dev environment setting or your access to this folder changed.')
    expect([...runs.values()].every((r) => r.state === 'gone')).toBe(true)
  })
  test('the person is taken out of the project: the next poll stops it', async () => {
    const cmd = shell('bob', chatB).call({ command: 'sleep', timeout_sec: 60 })
    await Bun.sleep(100)
    expect(runs.size).toBe(1)
    await pollSrt(h.ctx)
    expect([...runs.values()][0]!.state).toBe('active') // nothing changed: it runs on
    await setParts(['alice'])
    await pollSrt(h.ctx)
    expect(stops).toHaveLength(1)
    expect(out(await cmd)).toContain('Stopped: the dev environment setting or your access to this folder changed.')
  })
})

// QA TC-4939: every run's git runs no repository hook and goes through the git wrapper; a project folder's runs have a
// home of their own (server/src/devenv/srt/git-guard.ts, config.ts projectHome)
describe('git and the home in the project folder', () => {
  test('the wrapper is written, read-only in the run and first on PATH; the run has the git settings; the project\'s own home', async () => {
    expect(out(await shell('alice', chatA).call({ command: 'echo hi' }))).toContain('hi')
    const spec = [...runs.values()].at(-1)!.spec
    const bin = path.join(base, 'devenv', 'bin')
    expect(fs.readFileSync(path.join(bin, 'git'), 'utf8')).toContain("the dev environment's git guard")
    expect(fs.statSync(path.join(bin, 'git')).mode & 0o111).not.toBe(0)
    expect(spec.env.PATH!.split(':')[0]).toBe(bin)
    expect(spec.env.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(spec.env.GIT_CONFIG_VALUE_0).toBe('/dev/null')
    expect(spec.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect((spec.writable ?? []).some((w) => w === bin || w.startsWith(bin + '/'))).toBe(false)
    // her project chat's run: a home for this project folder, not the home of her own chats
    expect(spec.env.HOME).toBe(projectHome(base, 'alice', P.folderPath))
    expect(spec.env.HOME).not.toBe(personHome(base, 'alice'))
  })
})

// QA TC-5348: a hook another person's run left in the project folder has no exec bit when the next run starts, and a
// hook a run writes loses its exec bit when it ends (srt/hook-sweep.ts), whatever the command line sets
describe('git hooks in the project folder', () => {
  test('the exec bit of every hook-named file is taken before the run starts and after it ends', async () => {
    const dir = path.join(h.ctx.files.fx.root, P.folderPath)
    const hook = path.join(dir, 'repo', '.git', 'hooks', 'pre-commit'), other = path.join(dir, 'tools', 'Post-Checkout'), script = path.join(dir, 'build.sh')
    for (const f of [hook, other, script]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '#!/bin/sh\ntrue\n', { mode: 0o755 }) }
    let atStart: number[] = []
    const later = path.join(dir, 'later', 'hooks', 'pre-push')
    onSpawn = () => {
      atStart = [hook, other].map((f) => fs.statSync(f).mode & 0o111)
      // the run itself writes a hook: it stays executable while the run lives
      fs.mkdirSync(path.dirname(later), { recursive: true }); fs.writeFileSync(later, '#!/bin/sh\ntrue\n', { mode: 0o755 })
    }
    try {
      expect(out(await shell('alice', chatA).call({ command: 'echo hi' }))).toContain('hi')
    } finally { onSpawn = null }
    expect(atStart).toEqual([0, 0])
    // an ordinary script keeps its exec bit
    expect(fs.statSync(script).mode & 0o111).toBe(0o111)
    // after the run: its own hook too (the sweep after a run does not hold up the answer)
    for (let i = 0; i < 50 && fs.statSync(later).mode & 0o111; i++) await Bun.sleep(20)
    expect(fs.statSync(later).mode & 0o111).toBe(0)
    expect(fs.statSync(hook).mode & 0o666).toBe(0o644)
  })
})
