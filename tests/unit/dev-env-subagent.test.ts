// Run code where Claude Code would (QA TC-4911, docs/decisions/20261118-run-code-skills-subagents.md): a general-purpose
// sub-agent has box_shell when the main AI has it, with the same folders and fence; it raises no card (sites, a login
// command after other people's changes), starts no job or dev server and patches no step. A skill's bundled scripts run
// with box_shell when the turn has it. Teams from before the dev environment came get a one-time offer, never a switch
// flipped. A fake srt system records each run's settings (real srt runs are Linux only: tests/linux, the Docker suite).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type ProjectParticipant, type Step } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { _active, setSrtSystem, type SharedRun } from '../../server/src/devenv/srt/runner'
import { unitName } from '../../server/src/devenv/srt/config'
import type { SrtSystem, SpawnSpec, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, oldTeamOffer, saveTeamSetting, TEAM_SETTING_KEY, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, callerOf, HELPER_NO_CARD, HELPER_NO_JOB } from '../../server/src/devenv/tool'
import { pollSrt } from '../../server/src/devenv/jobs'
import { skillBlock, skillScriptsLine, skillScriptsRun } from '../../server/src/chat/prompt'

setDefaultTimeout(60_000)
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
type Settings = { filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[]; denyWrite: string[] } }
interface FakeRun { spec: SpawnSpec; settings: Settings; state: 'active' | 'gone'; resolve: (v: { code: number | null; signal: string | null }) => void }
const runs = new Map<string, FakeRun>()
const fake: SrtSystem = {
  spawn(spec) {
    let resolve!: FakeRun['resolve']
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    runs.set(spec.runId, { spec, settings: JSON.parse(fs.readFileSync(spec.settingsFile, 'utf8')), state: 'active', resolve })
    const m = /^echo (.*)$/.exec(spec.command)
    if (m) queueMicrotask(() => { fs.appendFileSync(spec.stdoutFile, m[1] + '\n'); fs.writeFileSync(spec.exitFile, '0\n'); runs.get(spec.runId)!.state = 'gone'; resolve({ code: 0, signal: null }) })
    return { pid: 999_999, exited }
  },
  async stop(runId) { const r = runs.get(runId); if (r && r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGTERM' }) } },
  async unit(runId): Promise<UnitInfo> { const r = runs.get(runId); return !r || r.state === 'gone' ? { state: '', result: '', memoryBytes: null } : { state: 'active', result: '', memoryBytes: 50 << 20 } },
  async units() { return [...runs.entries()].filter(([, r]) => r.state !== 'gone').map(([id]) => unitName(id)) },
  async forget(runId) { const r = runs.get(runId); if (r) r.state = 'gone' },
  oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}

const fakeLine = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let h: Harness, base = '', team = '', P: { id: string; folderPath: string; name: string }
let alice: TestSocket
const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const last = () => [...runs.values()].at(-1)!
const abs = (rel: string) => path.join(team, rel)
const readable = (r: FakeRun) => [...new Set([...r.settings.filesystem.allowRead, ...r.settings.filesystem.allowWrite])]
const turnOn = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
/** a turn's state for the main AI, and a sub-agent's (files/service.ts forAgent: its own object with an agent id) */
const MAIN = { agent: null }
const CHILD = { agent: 'toolu_child1' }

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'devenv-subagent', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-devsub' })
  await alice.next('hello')
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-'))
  team = h.ctx.files.fx.root
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Proj Sub', participants: [user('alice'), user('bob')], instructions: '' } })
  P = { id: p.id, folderPath: p.folderPath, name: p.name }
  fs.mkdirSync(abs(`${P.folderPath}/secret`), { recursive: true })
  fs.writeFileSync(abs(`${P.folderPath}/secret/s.md`), 'SECRET')
  const fid = crypto.randomUUID()
  h.ctx.db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, `${P.folderPath}/secret`)
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(crypto.randomUUID(), fid)
  // a team skill with a bundled script
  fs.mkdirSync(abs('skills/csv-report/scripts'), { recursive: true })
  fs.writeFileSync(abs('skills/csv-report/SKILL.md'), '---\nname: csv-report\ndescription: Make a report from a CSV file\n---\n\nRun scripts/report.py on the CSV.\n')
  fs.writeFileSync(abs('skills/csv-report/scripts/report.py'), 'print("report")\n')
})
afterAll(async () => { alice?.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(() => {
  for (const r of runs.values()) if (r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGKILL' }) }
  runs.clear(); _active().clear()
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  turnOn()
})

describe('a sub-agent runs commands (box_shell)', () => {
  test('a whole turn: the general-purpose child gets box_shell and the answer\'s cap; its command runs and is audited as its own', async () => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const defs = await ask(h, alice, 'alice', chat, fakeLine({ echo: 'agents' }))
    const agents = JSON.parse(defs.done.content) as Record<string, { tools: string[]; maxTurns: number }>
    expect(agents['general-purpose']!.tools).toContain('mcp__team__box_shell')
    expect(agents.Explore!.tools).not.toContain('mcp__team__box_shell')
    const r = await ask(h, alice, 'alice', chat, fakeLine({ agents: [{ id: 'toolu_SH1', type: 'general-purpose', description: 'Run it', steps: [{ tool: 'box_shell', args: { command: 'echo from-child' }, sayChildResult: true }] }] }, { say: 'done' }))
    expect(r.done.content).toContain('from-child')
    expect(runs.size).toBe(1)
    const ev = h.ctx.db.query("SELECT summary, ok, parent_tool_use_id FROM tool_events WHERE turn_id = ? AND tool = 'box_shell'").all(r.started.turnId) as { summary: string; ok: number; parent_tool_use_id: string | null }[]
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ ok: 1, parent_tool_use_id: 'toolu_SH1' })
    expect(ev[0]!.summary).toContain('(sub-agent)')
    // the child's step sits under its sub-task and carries no waiting state of the main AI
    const child = (r.done.steps as Step[]).find((s) => s.tool === 'box_shell')!
    expect(child.parentId).toBeTruthy()
    expect(child.devEnvRun).toBeUndefined()
  })

  test('a shared project chat: the child\'s command has the same fence as the main AI\'s', () => {
    const shared: SharedRun = { within: P.folderPath, audience: () => ['alice', 'bob'], noteReads: () => true }
    const tool = boxShellTool({ ctx: h.ctx, project: P, userId: 'alice', turnId: 't-' + crypto.randomUUID(), chatId: 'c-' + crypto.randomUUID(), signal: new AbortController().signal, redact: (s) => s,
      confirm: async () => 'run', shared, caller: (f) => (f === CHILD ? { helper: true, key: 'toolu_child1' } : { helper: false, key: '' }) })
    return (async () => {
      expect(out(await tool.call({ command: 'echo main' }, MAIN))).toContain('main')
      const m = last()
      expect(out(await tool.call({ command: 'echo child' }, CHILD))).toContain('child')
      const c = last()
      expect(c).not.toBe(m)
      expect(readable(c).sort()).toEqual(readable(m).sort().map((p) => p.replace(m.spec.runId, c.spec.runId)).sort())
      expect(c.settings.filesystem.denyRead).toContain(abs(`${P.folderPath}/secret`))
      expect(readable(c).some((p) => p.startsWith(abs('users')))).toBe(false)
    })()
  })

  test('no card, no job, no dev server, no job results and no step patch from a child; the main AI keeps them', async () => {
    const asked: string[] = []
    const queued: unknown[] = []
    const tool = boxShellTool({ ctx: h.ctx, project: null, userId: 'alice', turnId: 't-' + crypto.randomUUID(), chatId: (await h.api('alice').call(API.createChat, { body: {} })).id, signal: new AbortController().signal, redact: (s) => s,
      confirm: async () => 'run', askSite: async (host) => { asked.push(host); return 'once' }, queueStep: (r) => queued.push(r),
      caller: (f) => (f === CHILD ? { helper: true, key: 'toolu_child1' } : { helper: false, key: '' }) })
    for (const extra of [{ job: true }, { background: true }]) {
      const r = await tool.call({ command: 'echo long', ...extra }, CHILD)
      expect(r.isError).toBe(true)
      expect(out(r)).toBe(HELPER_NO_JOB)
    }
    expect(runs.size).toBe(0)
    const site = await tool.call({ command: 'echo net', request_sites: ['api.example-child.com'] }, CHILD)
    expect(site.isError).toBe(true)
    expect(out(site)).toContain('a sub-agent cannot ask the person')
    expect(out(site)).toContain('api.example-child.com')
    expect(asked).toEqual([])
    expect(runs.size).toBe(0)
    // nothing recorded as refused by the person: the main AI may still ask
    expect(h.ctx.db.query("SELECT 1 FROM audit_log WHERE action = 'dev_env.site_denied' AND detail LIKE '%api.example-child.com%'").get()).toBeNull()
    const mainSite = await tool.call({ command: 'echo net', request_sites: ['api.example-child.com'] }, MAIN)
    expect(asked).toEqual(['api.example-child.com'])
    expect(out(mainSite)).toContain('net')
    // the child's plain command runs
    expect(out(await tool.call({ command: 'echo ok' }, CHILD))).toContain('ok')
    expect(queued).toEqual([])
  })
})

describe('a skill\'s bundled scripts (QA TC-4911)', () => {
  test('with box_shell the instructions and the loaded skill say they run there; never "cannot execute"', async () => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const sys = (await ask(h, alice, 'alice', chat, fakeLine({ echo: 'system' }))).done.content
    expect(sys).toContain(skillScriptsLine(true))
    expect(sys).not.toContain('This runtime cannot execute bundled scripts.')
    const sub = (await ask(h, alice, 'alice', chat, fakeLine({ echo: 'subagentPrompt' }))).done.content
    expect(sub).toContain(skillScriptsLine(true))
    const loaded = (await ask(h, alice, 'alice', chat, fakeLine({ tool: 'skill', args: { name: 'csv-report' }, sayResult: true }))).done.content
    expect(loaded).toContain('Its bundled scripts run with box_shell from "$TRINA_TEAM/skills/csv-report/"')
    expect(loaded).not.toContain('Bundled scripts cannot be executed here')
  })

  test('without the dev environment: the old line, nothing about box_shell', async () => {
    saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: false })
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const sys = (await ask(h, alice, 'alice', chat, fakeLine({ echo: 'system' }))).done.content
    expect(sys).toContain('This runtime cannot execute bundled scripts.')
    expect(sys).not.toContain('run with box_shell')
    const loaded = (await ask(h, alice, 'alice', chat, fakeLine({ tool: 'skill', args: { name: 'csv-report' }, sayResult: true }))).done.content
    expect(loaded).toContain('Bundled scripts cannot be executed here')
  })
})

describe('teams from before the dev environment (migration 236)', () => {
  const raw = (v: string | null) => {
    h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(TEAM_SETTING_KEY)
    if (v !== null) h.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run(TEAM_SETTING_KEY, v)
  }
  test('offered only while the row is the migration\'s; never turned on', async () => {
    try {
      raw('{"enabled":false}')
      expect(oldTeamOffer(h.ctx.db)).toBe(true)
      expect(teamSetting(h.ctx.db).enabled).toBe(false)
      const r = await h.api('carol').call(API.devEnvTeam)
      expect(r.offer).toBe(true)
      expect(r.setting.enabled).toBe(false)
      // a new team (no row: on by default), an admin's save (the whole setting, also when off), a bad row: no offer
      raw(null)
      expect(oldTeamOffer(h.ctx.db)).toBe(false)
      raw('{"enabled":false}')
      saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: false })
      expect(oldTeamOffer(h.ctx.db)).toBe(false)
      expect((await h.api('carol').call(API.devEnvTeam)).offer).toBe(false)
      raw('not json')
      expect(oldTeamOffer(h.ctx.db)).toBe(false)
      raw('{"enabled":true}')
      expect(oldTeamOffer(h.ctx.db)).toBe(false)
      // an admin's save through the API ends the offer
      raw('{"enabled":false}')
      const after = await h.api('carol').call(API.updateDevEnvTeam, { body: { network: 'offline' } })
      expect(after.offer).toBe(false)
      expect(after.setting.enabled).toBe(false)
    } finally { turnOn() }
  })
})

describe('review of #1289', () => {
  const tracked = () => ({ ctx: h.ctx, project: P, userId: 'alice', turnId: 't-' + crypto.randomUUID(), chatId: 'c-' + crypto.randomUUID(), signal: new AbortController().signal, redact: (s: string) => s })
  const foreign = () => h.ctx.db.query("INSERT INTO file_events (user_id, path, action, at) VALUES ('dana', ?, 'update', ?)").run(`${P.folderPath}/by-dana-${crypto.randomUUID().slice(0, 6)}.md`, new Date().toISOString())

  test('M1: scripts run only for a team skill and the person\'s own skill; never a group or project skill\'s', () => {
    const body = { description: 'd', body: 'Run scripts/x.py.' }
    const team = { path: 'skills/t/SKILL.md', name: 't', ...body }
    const own = { path: 'users/alice/skills/p/SKILL.md', name: 'p', ...body }
    const group = { path: 'groups/sales/skills/g/SKILL.md', name: 'g', group: { id: 'g1', name: 'Sales' }, ...body }
    const project = { path: `${P.folderPath}/skills/pr/SKILL.md`, name: 'pr', project: { id: P.id, name: P.name }, ...body }
    expect([team, own, group, project].map((x) => skillScriptsRun(x as Parameters<typeof skillScriptsRun>[0]))).toEqual([true, true, false, false])
    expect(skillBlock(team, '', 'loaded', { scripts: true })).toContain('Its bundled scripts run with box_shell from "$TRINA_TEAM/skills/t/"')
    expect(skillBlock(own, '', 'loaded', { scripts: true })).toContain('Its bundled scripts run with box_shell from "$TRINA_TEAM/users/alice/skills/p/"')
    for (const s of [group, project]) {
      const b = skillBlock(s, '', 'loaded', { scripts: true })
      expect(b).toContain('Its bundled scripts are never run, in any way (not with box_shell either)')
      expect(b).not.toContain('run with box_shell from')
      expect(skillBlock(s, '', 'invoked', { scripts: true })).toContain('are never run')
    }
    // the list's line says the same: which skills' scripts run, and that group and project scripts never do
    expect(skillScriptsLine(true)).toContain('of a team skill or of the user\'s own [personal] skill run with box_shell')
    expect(skillScriptsLine(true)).toContain('Never run the scripts of a [group: …] or [project: …] skill')
  })

  test('M1 end to end: a loaded group skill and project skill say their scripts never run', async () => {
    // the fixture's marketing group (alice is in it), linked to its folder as tests/unit/group-skills.test.ts does
    h.ctx.db.query('UPDATE groups SET folder_id = (SELECT id FROM folders WHERE path = ?) WHERE id = ?').run('groups/marketing', 'marketing')
    fs.mkdirSync(abs('groups/marketing/skills/grp-tool/scripts'), { recursive: true })
    fs.writeFileSync(abs('groups/marketing/skills/grp-tool/SKILL.md'), '---\nname: grp-tool\ndescription: A group tool\n---\n\nRun scripts/x.py.\n')
    fs.writeFileSync(abs('groups/marketing/skills/grp-tool/scripts/x.py'), 'print(1)\n')
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const g = (await ask(h, alice, 'alice', chat, fakeLine({ tool: 'skill', args: { name: 'grp-tool' }, sayResult: true }))).done.content
    expect(g).toContain('The group (of "Marketing"')
    expect(g).toContain('are never run, in any way')
    expect(g).not.toContain('run with box_shell from')
    fs.mkdirSync(abs(`${P.folderPath}/skills/proj-tool/scripts`), { recursive: true })
    fs.writeFileSync(abs(`${P.folderPath}/skills/proj-tool/SKILL.md`), '---\nname: proj-tool\ndescription: A project tool\n---\n\nRun scripts/x.py.\n')
    const pchat = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
    const loaded = (await ask(h, alice, 'alice', pchat, fakeLine({ tool: 'skill', args: { name: 'proj-tool' }, sayResult: true }))).done.content
    expect(loaded).toContain('The project (of')
    expect(loaded).toContain('are never run, in any way')
    expect(loaded).not.toContain('run with box_shell from')
  })

  test('a helper\'s login command after other people\'s changes: refused (HELPER_NO_CARD), no card, nothing run', async () => {
    foreign()
    const confirms: string[] = []
    const tool = boxShellTool({ ...tracked(), confirm: async (q) => { confirms.push(q); return 'run' }, caller: (f) => callerOf(f, MAIN) })
    const r = await tool.call({ command: 'git push' }, CHILD)
    expect(r.isError).toBe(true)
    expect(out(r)).toBe(HELPER_NO_CARD)
    expect(confirms).toEqual([])
    expect(runs.size).toBe(0)
  })

  test('L1: a helper\'s command leaves the main AI\'s "changed by other people" note and the login card', async () => {
    foreign()
    const confirms: string[] = []
    const t = tracked()
    const tool = boxShellTool({ ...t, confirm: async (q) => { confirms.push(q); return 'run' }, caller: (f) => callerOf(f, MAIN) })
    expect(out(await tool.call({ command: 'echo child' }, CHILD))).toContain('child')
    const first = out(await tool.call({ command: 'echo main' }, MAIN))
    expect(first).toContain('Changed by other people since this person\'s last command')
    // the main AI's login command still asks after the helper ran
    const again = boxShellTool({ ...tracked(), confirm: async (q) => { confirms.push(q); return 'no' }, caller: (f) => callerOf(f, MAIN) })
    foreign()
    await again.call({ command: 'echo child2' }, CHILD)
    await again.call({ command: 'git push' }, MAIN)
    expect(confirms).toHaveLength(1)
    // L2: the audit line says which agent ran it
    const rows = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'dev_env.command' AND detail LIKE ?").all(`%${t.turnId}%`) as { detail: string }[]
    const details = rows.map((x) => JSON.parse(x.detail) as { by?: string; agent?: string; command: string })
    expect(details.find((d) => d.command === 'echo child')).toMatchObject({ by: 'sub-agent', agent: 'toolu_child1' })
    expect(details.find((d) => d.command === 'echo main')!.by).toBeUndefined()
  })

  test('an unknown agent counts as a helper (fails closed); the turn\'s own state is the main AI', () => {
    const main = {}
    expect(callerOf(main, main)).toEqual({ helper: false, key: '' })
    expect(callerOf(undefined, main)).toEqual({ helper: false, key: '' })
    expect(callerOf({ agent: null, agentView: true }, main)).toEqual({ helper: true, key: '?' })
    expect(callerOf({ agent: 'toolu_X' }, main)).toEqual({ helper: true, key: 'toolu_X' })
  })

  test('the audience changes while a helper\'s command runs in a shared chat: the next poll stops it', async () => {
    const audience = ['alice', 'bob']
    const shared: SharedRun = { within: P.folderPath, audience: () => [...audience], noteReads: () => true }
    const tool = boxShellTool({ ...tracked(), confirm: async () => 'run', shared, caller: (f) => callerOf(f, MAIN) })
    const cmd = tool.call({ command: 'sleep', timeout_sec: 60 }, CHILD)
    await Bun.sleep(150)
    expect(last().state).toBe('active')
    audience.push('erin')
    await pollSrt(h.ctx)
    expect(out(await cmd)).toContain('Stopped: the dev environment setting or your access to this folder changed.')
  })
})
