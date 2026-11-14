// A foreground command stops like a job when its person loses the folder (taken out of the project) or the dev
// environment is turned off while it runs (QA TC-1143, TC-1144): the tracker checks the commands of this process too.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import { unitName } from '../../server/src/devenv/srt/config'
import type { SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { pollSrt } from '../../server/src/devenv/jobs'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool } from '../../server/src/devenv/tool'
setDefaultTimeout(40_000)
const PLAN2: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
interface FakeRun { spec: SpawnSpec; state: 'active' | 'gone'; resolve: (v: { code: number | null; signal: string | null }) => void }
const runs = new Map<string, FakeRun>()
const stops: string[] = []
const fake: SrtSystem = {
  spawn(spec) {
    let resolve!: FakeRun['resolve']
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    runs.set(spec.runId, { spec, state: 'active', resolve })
    const m = /^echo (.*)$/.exec(spec.command)
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
