// The one queue of the dev environment on srt (server/src/devenv/srt/queue.ts, docs/DECISIONS.md "Dev environment: one
// queue"): commands and jobs share the plan's slots; a command waits (at most 5 minutes) instead of a "busy" refusal;
// a fair share per person; a cancel by the owner only; dev servers refused when full; idle stop after 10 minutes; the
// dev environment on by default for a new team, existing teams unchanged; tickets after a restart. Against a fake system
// (no systemd, no srt), as tests/unit/dev-env-srt.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, DEV_ENV_SRT_WARNING_VERSION, type Step } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { migrate, MIGRATIONS_DIR } from '../../server/src/db'
import { _active, placeInLine, reconcile, setSrtSystem } from '../../server/src/devenv/srt/runner'
import { COMMAND_WAIT_MS, commandWaitFor, FULL_MESSAGE, pickNext, setCommandWait, shareOf, startOrder } from '../../server/src/devenv/srt/queue'
import { unitName } from '../../server/src/devenv/srt/config'
import type { SpawnSpec, SrtSystem } from '../../server/src/devenv/srt/system'
import { pollSrt, runResultsForAI } from '../../server/src/devenv/jobs'
import { mayUseDevEnv, newConsent, saveTeamSetting, TEAM_DEFAULT_ON, TEAM_SETTING_KEY, teamInForce, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool } from '../../server/src/devenv/tool'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'

setDefaultTimeout(40_000)

// ---------------- the start order (pure) ----------------

const w = (id: string, userId: string) => ({ id, userId })
/** start entries one by one while slots are free (each start holds a slot until the test frees it) */
function fill(waiting: { id: string; userId: string }[], running: string[], max: number, served = new Map<string, number>()) {
  const left = [...waiting], held = [...running], started: string[] = []
  let tick = 100
  for (;;) {
    const id = pickNext(left, held, max, served)
    if (!id) return { started, held }
    const e = left.splice(left.findIndex((x) => x.id === id), 1)[0]!
    started.push(id); held.push(e.userId); served.set(e.userId, tick++)
  }
}

describe('the start order', () => {
  test('the share: max(1, floor(maxRunning / 2))', () => {
    expect([1, 2, 3, 4].map(shareOf)).toEqual([1, 1, 1, 2])
  })
  test('queue order: oldest first when nobody holds a slot or was served', () => {
    expect(fill([w('a1', 'alice'), w('b1', 'bob'), w('e1', 'erin')], [], 1).started).toEqual(['a1'])
    expect(startOrder([w('a1', 'alice'), w('b1', 'bob'), w('e1', 'erin')], [], 1, new Map())).toEqual(['a1', 'b1', 'e1'])
    // one person's entries keep their order
    expect(startOrder([w('a1', 'alice'), w('a2', 'alice'), w('a3', 'alice')], [], 1, new Map())).toEqual(['a1', 'a2', 'a3'])
  })
  test('1 slot: plain turn-taking (the person served last waits behind the others)', () => {
    // alice ran last; her second entry is older than bob's, but bob goes first
    expect(pickNext([w('a2', 'alice'), w('b1', 'bob')], [], 1, new Map([['alice', 5]]))).toBe('b1')
    expect(startOrder([w('a2', 'alice'), w('a3', 'alice'), w('b1', 'bob'), w('b2', 'bob')], [], 1, new Map([['alice', 5]]))).toEqual(['b1', 'a2', 'b2', 'a3'])
    // the slot is held: nothing starts
    expect(pickNext([w('b1', 'bob')], ['alice'], 1, new Map())).toBeNull()
  })
  test('2 slots: one per person while others wait', () => {
    // alice holds 1 (her share): bob gets the free slot, though alice's entry is older
    expect(fill([w('a2', 'alice'), w('b1', 'bob'), w('b2', 'bob')], ['alice'], 2).started).toEqual(['b1'])
  })
  test('4 slots: two per person while others wait', () => {
    const r = fill([w('a1', 'alice'), w('a2', 'alice'), w('a3', 'alice'), w('b1', 'bob'), w('e1', 'erin')], [], 4)
    expect(r.started.sort()).toEqual(['a1', 'a2', 'b1', 'e1'])
    // alice at 2 already, a slot free, bob waits: bob gets it
    expect(pickNext([w('a3', 'alice'), w('b2', 'bob')], ['alice', 'alice', 'erin'], 4, new Map())).toBe('b2')
  })
  test('no idle slot when only one person waits: past the share they get the free slots', () => {
    expect(fill([w('a1', 'alice'), w('a2', 'alice')], [], 2).started).toEqual(['a1', 'a2'])
    expect(fill([w('a1', 'alice'), w('a2', 'alice'), w('a3', 'alice'), w('a4', 'alice')], [], 4).started).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(pickNext([w('a3', 'alice')], ['alice', 'alice'], 4, new Map())).toBe('a3')
  })
  test('the wait of a command: 5 minutes, less when the tool call (30 minutes) would end first', () => {
    expect(COMMAND_WAIT_MS).toBe(5 * 60_000)
    expect(commandWaitFor(120_000)).toBe(5 * 60_000)
    expect(commandWaitFor(1800_000)).toBe(0)
    expect(commandWaitFor(1600_000)).toBe(30 * 60_000 - 60_000 - 1600_000)
  })
})

// ---------------- the runner against a fake system ----------------

interface FakeRun { spec: SpawnSpec; state: 'active' | 'gone'; resolve: (v: { code: number | null; signal: string | null }) => void }
const runs = new Map<string, FakeRun>()
let cpu = 0
/** commands: "echo X", "sleep" (runs until stopped or ended) */
const fake: SrtSystem = {
  spawn(spec) {
    let resolve!: FakeRun['resolve']
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    const r: FakeRun = { spec, state: 'active', resolve }
    runs.set(spec.runId, r)
    queueMicrotask(() => {
      const m = /^echo (.*)$/.exec(spec.command)
      if (!m) return
      fs.appendFileSync(spec.stdoutFile, m[1] + '\n'); fs.writeFileSync(spec.exitFile, '0\n'); r.state = 'gone'; resolve({ code: 0, signal: null })
    })
    return { pid: 999_999, exited }
  },
  async stop(runId) { const r = runs.get(runId); if (r && r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGTERM' }) } },
  async unit(runId) { const r = runs.get(runId); return !r || r.state === 'gone' ? { state: '', result: '', memoryBytes: null } : { state: 'active', result: '', memoryBytes: 50 << 20 } },
  async units() { return [...runs.entries()].filter(([, r]) => r.state === 'active').map(([id]) => unitName(id)) },
  async forget() {},
  oomKills() { return 0 },
  cpuUsec() { return cpu },
  procs() { return [] },
  async selfTest() { return '' },
}
const finish = (runId: string) => {
  const r = runs.get(runId)!
  fs.writeFileSync(r.spec.exitFile, '0\n'); r.state = 'gone'; r.resolve({ code: 0, signal: null })
}

let h: Harness
let devBase = ''
let chatA = '', chatA2 = '', chatB = '', chatE = '', falconId = '', chatFalcon = ''
const plan = (maxRunning: number): DevEnvPlan => ({ format: 1, plan: 'test', maxRunning, cpus: 1.5, memoryMiB: 1536, pids: 512, diskGiB: 4, network: 'open' })
const steps: { user: string; run: NonNullable<Step['devEnvRun']> }[] = []
const publish: { user: string; frame: { type: string } }[] = []
const shell = (userId: string, chatId: string, signal = new AbortController().signal, project: { id: string; folderPath: string; name: string } | null = null) =>
  boxShellTool({ ctx: h.ctx, project, userId, turnId: 'turn-1', chatId, signal, confirm: async () => null, redact: (s) => s, queueStep: (run) => steps.push({ user: userId, run }) })
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const rows = () => h.ctx.db.query('SELECT * FROM dev_env_runs ORDER BY started_at, id').all() as Record<string, unknown>[]
const active = () => [...runs.values()].filter((r) => r.state === 'active')
const runIdOf = (unit: unknown) => String(unit).slice('trina-dev-'.length, -'.scope'.length)
const turnOnTeam = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
/** wait until the condition holds (the queue moves on timers and promises) */
async function until(f: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!f()) { if (Date.now() > end) throw new Error('timed out waiting'); await Bun.sleep(10) }
}

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  process.env.MYCEL_DEV_ENV_RUNNER = 'srt'
  h = await startHarness({ name: 'dev-env-queue' })
  devBase = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-queue-'))
  setSrtSystem(fake, { base: devBase, id: 'mycel', plan: plan(1) })
  chatA = (await h.api('alice').call(API.createChat, { body: {} })).id
  chatA2 = (await h.api('alice').call(API.createChat, { body: {} })).id
  chatB = (await h.api('bob').call(API.createChat, { body: {} })).id
  chatE = (await h.api('erin').call(API.createChat, { body: {} })).id
  falconId = (await h.api('alice').call(API.createProject, { body: { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' } })).id
  chatFalcon = (await h.api('alice').call(API.createChat, { body: { projectId: falconId } })).id
  const real = h.ctx.services.realtime.publish.bind(h.ctx.services.realtime)
  h.ctx.services.realtime.publish = ((user: string, frame: never) => { publish.push({ user, frame }); return real(user, frame) }) as typeof h.ctx.services.realtime.publish
})
afterAll(async () => {
  setSrtSystem(null)
  for (const k of ['MYCEL_DEV_ENV', 'MYCEL_DEV_ENV_RUNNER']) delete process.env[k]
  await h.close()
  fs.rmSync(devBase, { recursive: true, force: true })
})
beforeEach(() => {
  for (const r of runs.values()) if (r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGKILL' }) }
  runs.clear(); steps.length = 0; publish.length = 0; cpu = 0
  _active().clear()
  setSrtSystem(fake, { base: devBase, id: 'mycel', plan: plan(1) })
  for (const t of ['dev_env_runs', 'dev_env_notices']) h.ctx.db.query(`DELETE FROM ${t}`).run()
  h.ctx.db.query("DELETE FROM audit_log WHERE action LIKE 'dev_env.%'").run()
  turnOnTeam()
})

describe('commands wait in the queue (no "busy")', () => {
  test('a command waits behind a running job, shows its place, and runs when the slot is free', async () => {
    expect(out(await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'render' }))).toContain('Started as job render')
    const p = shell('bob', chatB).call({ command: 'echo built' })
    await until(() => steps.length === 1)
    expect(steps[0]).toMatchObject({ user: 'bob', run: { kind: 'command', state: 'waiting', position: 1 } })
    const ticket = rows().find((r) => r.foreground === 1)!
    expect(ticket).toMatchObject({ state: 'waiting', kind: 'job', user_id: 'bob', command: 'echo built' })
    expect(steps[0]!.run.id).toBe(String(ticket.id))
    // bob sees it as a waiting command in his list
    expect((await h.api('bob').call(API.myDevEnvRuns, {})).waiting).toMatchObject([{ id: ticket.id, kind: 'command', position: 1, name: 'echo built' }])
    expect(active().length).toBe(1)
    finish(runIdOf(rows().find((r) => r.name === 'render')!.unit))
    await pollSrt(h.ctx)
    const r = await p
    expect(out(r)).toContain('Exit code 0.')
    expect(out(r)).toContain('built')
    expect(steps.at(-1)!.run).toMatchObject({ id: ticket.id, state: 'started' })
    // the ticket is gone; it never gave a job result or a notice
    expect(rows().filter((x) => x.foreground === 1)).toEqual([])
    expect(runResultsForAI(h.ctx, 'bob', chatB)).toEqual([])
    expect(publish.filter((x) => x.user === 'bob' && x.frame.type === 'notice')).toEqual([])
  })
  test('a free slot and nobody waiting: the command runs at once with no waiting state', async () => {
    expect(out(await shell('alice', chatA).call({ command: 'echo now' }))).toContain('now')
    expect(steps).toEqual([])
    expect(rows()).toEqual([])
  })
  test('a bad plan file: the command is refused at once with the reason; it does not wait as if the queue were full', async () => {
    const planFile = path.join(devBase, 'bad-plan.json')
    fs.writeFileSync(planFile, '{bad')
    setSrtSystem(fake, { base: devBase, id: 'mycel', planFile })
    const t0 = Date.now()
    const r = await shell('alice', chatA).call({ command: 'echo never' })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('the dev environment is not available')
    expect(out(r)).not.toContain(FULL_MESSAGE)
    expect(steps).toEqual([])
    expect(rows()).toEqual([])
    expect(runs.size).toBe(0)
  })
  test('jobs and commands are one FIFO queue; tickets do not count in the caps of waiting jobs', async () => {
    await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'one' })
    const cmd = shell('bob', chatB).call({ command: 'echo b' })
    await until(() => steps.length === 1)
    const job = await shell('erin', chatE).call({ command: 'echo e', job: true, log_name: 'two' })
    expect(out(job)).toContain('Queued as job two')
    expect(out(job)).toContain('position 2')
    expect(steps.at(-1)).toMatchObject({ user: 'erin', run: { kind: 'job', state: 'waiting', position: 2 } })
    // three more waiting jobs of bob are allowed: his ticket is not a waiting job
    for (const n of ['w1', 'w2', 'w3']) expect(out(await shell('bob', chatB).call({ command: 'sleep', job: true, log_name: n }))).toContain('Queued')
    finish(runIdOf(rows().find((r) => r.name === 'one')!.unit))
    await pollSrt(h.ctx)
    expect(out(await cmd)).toContain('b')
    // the command held the slot and gave it back: erin's job is next
    await until(() => rows().some((r) => r.name === 'two' && r.state !== 'waiting'))
  })
  test('a command that waits 5 minutes ends with "The dev environment is full"; the AI and the person are told', async () => {
    setCommandWait(150)
    await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'long' })
    const r = await shell('bob', chatB).call({ command: 'echo late' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain(FULL_MESSAGE)
    expect(FULL_MESSAGE).toBe('The dev environment is full. Try again later.')
    expect(steps.map((s) => s.run.state)).toEqual(['waiting', 'expired'])
    expect(rows().filter((x) => x.foreground === 1)).toEqual([])
    expect(active().length).toBe(1)
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'dev_env.command' AND actor_id = 'bob'").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ result: { error: 'full' } })
  })
  test('the turn stops while the command waits: the ticket goes, nothing runs', async () => {
    await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'long' })
    const ac = new AbortController()
    const p = shell('bob', chatB, ac.signal).call({ command: 'echo never' })
    await until(() => steps.length === 1)
    ac.abort()
    expect(out(await p)).toContain('did not run')
    expect(rows().filter((x) => x.foreground === 1)).toEqual([])
    expect(runs.size).toBe(1)
  })
})

describe('cancel', () => {
  test('only the owner cancels a waiting command; the call ends and says so; no notice', async () => {
    await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'long' })
    const p = shell('bob', chatB).call({ command: 'echo cancel me' })
    await until(() => steps.length === 1)
    const id = steps[0]!.run.id
    await expect(h.api('alice').call(API.stopMyDevEnvRun, { params: { runId: id } })).rejects.toThrow()
    await expect(h.api('carol').call(API.stopMyDevEnvRun, { params: { runId: id } })).rejects.toThrow()
    expect(rows().some((r) => r.id === id)).toBe(true)
    const left = await h.api('bob').call(API.stopMyDevEnvRun, { params: { runId: id } })
    expect(left.waiting).toEqual([])
    const r = await p
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('cancelled this command')
    expect(steps.at(-1)!.run).toMatchObject({ id, state: 'cancelled' })
    expect(rows().some((x) => x.id === id)).toBe(false)
    expect(runs.size).toBe(1)
    expect(publish.filter((x) => x.user === 'bob' && x.frame.type === 'notice')).toEqual([])
    expect(h.ctx.db.query("SELECT COUNT(*) AS n FROM dev_env_notices WHERE user_id = 'bob'").get()).toEqual({ n: 0 })
  })
  test('the project page: other readers and admins cannot cancel a waiting command; its owner can', async () => {
    await shell('bob', chatB).call({ command: 'sleep', job: true, log_name: 'long' })
    const p = shell('alice', chatFalcon, undefined, { id: falconId, folderPath: 'projects/falcon', name: 'Falcon' }).call({ command: 'echo mine' })
    await until(() => steps.length === 1)
    const id = steps[0]!.run.id
    // the project page lists it as a waiting command
    expect((await h.api('bob').call(API.devEnv, { params: { id: falconId } })).runs?.waiting).toMatchObject([{ id, kind: 'command' }])
    for (const who of ['bob', 'carol']) await expect(h.api(who).call(API.devEnvRunStop, { params: { id: falconId, runId: id } })).rejects.toThrow()
    expect(rows().some((r) => r.id === id)).toBe(true)
    await h.api('alice').call(API.devEnvRunStop, { params: { id: falconId, runId: id } })
    expect(out(await p)).toContain('cancelled this command')
  })
  test('the owner cancels a waiting job from the chat', async () => {
    await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'long' })
    await shell('bob', chatB).call({ command: 'echo j', job: true, log_name: 'queued' })
    const id = steps.at(-1)!.run.id
    await expect(h.api('erin').call(API.stopMyDevEnvRun, { params: { runId: id } })).rejects.toThrow()
    await h.api('bob').call(API.stopMyDevEnvRun, { params: { runId: id } })
    expect(rows().find((r) => r.id === id)).toMatchObject({ state: 'ended', end_reason: 'stopped' })
  })
})

describe('fair share in the runner', () => {
  test('2 slots: a person at their share waits while another person waits; past that no slot stays idle', async () => {
    setSrtSystem(fake, { base: devBase, id: 'mycel', plan: plan(2) })
    await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'a1' })
    // nobody else waits: alice's second job takes the idle slot
    expect(out(await shell('alice', chatA2).call({ command: 'sleep', job: true, log_name: 'a2' }))).toContain('Started')
    expect(out(await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'a3' }))).toContain('Queued')
    expect(out(await shell('bob', chatB).call({ command: 'sleep', job: true, log_name: 'b1' }))).toContain('Queued')
    // a slot comes free: bob goes first, though alice's job waited longer (she holds her share)
    finish(runIdOf(rows().find((r) => r.name === 'a1')!.unit))
    await pollSrt(h.ctx)
    const state = (n: string) => rows().find((r) => r.name === n)!.state
    expect([state('a3'), state('b1')]).toEqual(['waiting', 'running'])
    expect(placeInLine(h.ctx, String(rows().find((r) => r.name === 'a3')!.id))).toBe(1)
  })
})

describe('dev servers', () => {
  test('refused when full, with "Preview is full. Close another preview or wait."', async () => {
    expect(out(await shell('alice', chatA).call({ command: 'sleep', background: true, log_name: 'web' }))).toContain('Started in the background')
    const r = await shell('bob', chatB).call({ command: 'sleep', background: true, log_name: 'web2' })
    expect(r.isError).toBe(true)
    expect(out(r)).toContain('Preview is full. Close another preview or wait.')
    expect(rows().filter((x) => x.kind === 'server').length).toBe(1)
  })
  test('an unused dev server stops after 10 minutes (the new default)', async () => {
    expect(DEV_ENV_DEFAULT_LIMITS.idleStopMin).toBe(10)
    expect(TEAM_DEFAULT_ON.limits.idleStopMin).toBe(10)
    await shell('alice', chatA).call({ command: 'sleep', background: true, log_name: 'web' })
    const realNow = Date.now
    let offset = 0
    Date.now = () => realNow() + offset
    try {
      await pollSrt(h.ctx) // the first CPU reading
      offset = 9 * 60_000
      await pollSrt(h.ctx)
      expect(rows()[0]).toMatchObject({ state: 'running' })
      offset = 10 * 60_000 + 1000
      await pollSrt(h.ctx)
      expect(rows()[0]).toMatchObject({ state: 'ended', end_reason: 'idle' })
    } finally { Date.now = realNow }
  })
})

describe('a restart of the server', () => {
  test('waiting jobs stay in the queue; a waiting command that lost its call ends as lost and never runs', async () => {
    await shell('alice', chatA).call({ command: 'sleep', job: true, log_name: 'long' })
    await shell('bob', chatB).call({ command: 'echo j', job: true, log_name: 'next' })
    // a ticket from the old process: a row with no call waiting for it
    const at = new Date().toISOString()
    h.ctx.db.query("INSERT INTO dev_env_runs (id, user_id, chat_id, kind, name, command, root, state, started_at, ai_told_at, foreground) VALUES ('old-ticket', 'erin', ?, 'job', 'command-aaaaaa', 'echo lost', ?, 'waiting', ?, ?, 1)").run(chatE, devBase, at, at)
    await reconcile(h.ctx)
    expect(rows().find((r) => r.id === 'old-ticket')).toMatchObject({ state: 'ended', end_reason: 'lost' })
    expect(rows().find((r) => r.name === 'next')).toMatchObject({ state: 'waiting' })
    finish(runIdOf(rows().find((r) => r.name === 'long')!.unit))
    await pollSrt(h.ctx)
    expect(rows().find((r) => r.name === 'next')!.state).not.toBe('waiting')
    expect([...runs.values()].some((r) => r.spec.command === 'echo lost')).toBe(false)
    expect(publish.filter((x) => x.user === 'erin')).toEqual([])
    expect(runResultsForAI(h.ctx, 'erin', chatE)).toEqual([])
  })
  test('the poll also ends a ticket with no call', async () => {
    const at = new Date().toISOString()
    h.ctx.db.query("INSERT INTO dev_env_runs (id, user_id, chat_id, kind, name, command, root, state, started_at, ai_told_at, foreground) VALUES ('old-2', 'erin', ?, 'job', 'command-bbbbbb', 'echo lost', ?, 'waiting', ?, ?, 1)").run(chatE, devBase, at, at)
    await pollSrt(h.ctx)
    expect(rows().find((r) => r.id === 'old-2')).toMatchObject({ state: 'ended', end_reason: 'lost' })
    expect(runs.size).toBe(0)
  })
})

describe('on by default for a new team', () => {
  test('no stored setting: on, "Allowed sites only", with the current warning; admins can still turn it off', async () => {
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(TEAM_SETTING_KEY)
    const s = teamSetting(h.ctx.db)
    expect(s).toMatchObject({ enabled: true, network: 'open', scope: { mode: 'writers' }, consent: { by: null, warningVersion: DEV_ENV_SRT_WARNING_VERSION } })
    expect(teamInForce(s)).toBe(true)
    expect(mayUseDevEnv(h.ctx.db, h.ctx.files, 'alice')).toBe(true)
    const off = await h.api('carol').call(API.updateDevEnvTeam, { body: { enabled: false } })
    expect(off.setting.enabled).toBe(false)
    expect(mayUseDevEnv(h.ctx.db, h.ctx.files, 'alice')).toBe(false)
    // a bad stored row stays off
    h.ctx.db.query('UPDATE settings SET value = ? WHERE key = ?').run('not json', TEAM_SETTING_KEY)
    expect(teamSetting(h.ctx.db).enabled).toBe(false)
  })
  const freshDb = () => new Database(':memory:')
  const before236 = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'))
    for (const f of fs.readdirSync(MIGRATIONS_DIR)) if (/^\d{3}_/.test(f) && Number(f.slice(0, 3)) < 236) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f))
    return dir
  }
  const stored = (db: Database) => (db.query('SELECT value FROM settings WHERE key = ?').get(TEAM_SETTING_KEY) as { value: string } | null)?.value ?? null
  test('the migration: a new database (no people yet) gets no row, so the default (on) applies', () => {
    const db = freshDb()
    migrate(db)
    expect(stored(db)).toBeNull()
    expect(teamSetting(db).enabled).toBe(true)
    db.close()
  })
  test('the migration: an existing team with people and no row stays off', () => {
    const db = freshDb(), dir = before236()
    try {
      migrate(db, { migrationsDir: dir })
      db.query("INSERT INTO users (id, username, name, role) VALUES ('dana', 'dana', 'Dana', 'owner')").run()
      migrate(db)
      expect(JSON.parse(stored(db)!)).toEqual({ enabled: false })
      expect(teamSetting(db).enabled).toBe(false)
      expect(teamInForce(teamSetting(db))).toBe(false)
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }) }
  })
  test('the migration: an existing team with a row keeps it as it is (on stays on, off stays off)', () => {
    for (const value of [JSON.stringify({ ...TEAM_DEFAULT_ON, consent: { by: { id: 'dana', name: 'Dana' }, at: '2026-11-01T00:00:00.000Z', warningVersion: 2 } }), JSON.stringify({ extraDomains: ['api.example.com'] })]) {
      const db = freshDb(), dir = before236()
      try {
        migrate(db, { migrationsDir: dir })
        db.query("INSERT INTO users (id, username, name, role) VALUES ('dana', 'dana', 'Dana', 'owner')").run()
        db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run(TEAM_SETTING_KEY, value)
        migrate(db)
        expect(stored(db)).toBe(value)
      } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }) }
    }
  })
})
