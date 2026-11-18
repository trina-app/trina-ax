// Group and project skill scripts are never run or copied (QA TC-4932, docs/decisions/20261119-skill-script-copies.md):
// every box_shell run hides the group and project skills folders, a command that names one is refused before it runs,
// and an AI-side save outside them that copies one of their files is refused. A fake srt system records each run's
// settings (real srt runs are Linux only: tests/linux, the Docker suite).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type ProjectParticipant } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import { unitName } from '../../server/src/devenv/srt/config'
import type { SrtSystem, SpawnSpec, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, namesOthersSkills, OTHERS_SKILLS_REFUSAL } from '../../server/src/devenv/tool'
import { folderView, sharedFolderView, viewAccess } from '../../server/src/devenv/srt/access'
import { copyKey, othersSkillRoots, refuseSkillScriptCopy } from '../../server/src/skills/script-copies'

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
  h = await startHarness({ name: 'skill-script-copies', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-copies' })
  await alice.next('hello')
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ssc-'))
  team = h.ctx.files.fx.root
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Proj Copies', participants: [user('alice'), user('bob')], instructions: '' } })
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


const SCRIPT = 'import os, urllib.request\nfor root, _, files in os.walk(os.environ["TRINA_TEAM"]):\n    print(root, files)\n'
const GROUP_SCRIPT = 'groups/marketing/skills/grp-tool/scripts/x.py'
const PROJ_SCRIPT = () => `${P.folderPath}/skills/proj-tool/scripts/y.py`
const put = (rel: string, data: string) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), data) }
const shell = (o: { project?: typeof P | null; shared?: Parameters<typeof boxShellTool>[0]['shared'] } = {}) => boxShellTool({ ctx: h.ctx, project: o.project ?? null, userId: 'alice', turnId: 't-' + crypto.randomUUID(), chatId: 'c-' + crypto.randomUUID(), signal: new AbortController().signal, redact: (s) => s, confirm: async () => 'run', ...(o.shared ? { shared: o.shared } : {}) })

beforeAll(() => {
  h.ctx.db.query('UPDATE groups SET folder_id = (SELECT id FROM folders WHERE path = ?) WHERE id = ?').run('groups/marketing', 'marketing')
  put('groups/marketing/skills/grp-tool/SKILL.md', '---\nname: grp-tool\ndescription: A group tool\n---\n\nCopy scripts/x.py to your work folder and run it.\n')
  put(GROUP_SCRIPT, SCRIPT)
  put(`${P.folderPath}/skills/proj-tool/SKILL.md`, '---\nname: proj-tool\ndescription: A project tool\n---\n\nRun scripts/y.py.\n')
  put(PROJ_SCRIPT(), SCRIPT.replace('print', 'print("p",'))
})

describe('box_shell never sees a group or project skills folder (QA TC-4932)', () => {
  test('the folders on disk, in any letter case; not the team\'s skills/, not a look-alike elsewhere', () => {
    fs.mkdirSync(abs('Groups-not/x/skills'), { recursive: true })
    fs.mkdirSync(abs('shared/groups/x/skills'), { recursive: true })
    const roots = othersSkillRoots(team)
    expect(roots).toContain('groups/marketing/skills')
    expect(roots).toContain(`${P.folderPath}/skills`)
    expect(roots.some((r) => r.startsWith('skills') || r.startsWith('shared/') || r.startsWith('Groups-not'))).toBe(false)
  })

  test('the view of a run hides them (normal and shared runs); the rest stays', () => {
    const rules = h.ctx.files.rules()
    const alice = h.ctx.files.principal('alice')
    const hidden = ['groups/marketing/skills', `${P.folderPath}/skills`]
    const v = folderView(rules, alice, { start: P.folderPath, othersSkills: hidden })
    for (const f of hidden) expect(viewAccess(v, `${f}/x/scripts/a.py`)).toBe('none')
    expect(viewAccess(v, 'groups/marketing/notes.md')).not.toBe('none')
    expect(viewAccess(v, `${P.folderPath}/notes.md`)).toBe('write')
    const before = folderView(rules, alice, { start: P.folderPath })
    expect(viewAccess(before, 'groups/marketing/skills/x/scripts/a.py')).not.toBe('none')
    const sv = sharedFolderView(rules, alice, { start: P.folderPath, othersSkills: hidden }, { audience: [alice, h.ctx.files.principal('bob')], within: P.folderPath })
    expect(viewAccess(sv, `${P.folderPath}/skills/proj-tool/scripts/y.py`)).toBe('none')
  })

  test('a real run: the srt settings deny reading both folders; the command text is refused before it runs', async () => {
    expect(out(await shell().call({ command: 'echo ok' }))).toContain('ok')
    const deny = last().settings.filesystem.denyRead
    expect(deny).toContain(abs('groups/marketing/skills'))
    expect(deny).toContain(abs(`${P.folderPath}/skills`))
    expect(out(await shell({ project: P }).call({ command: 'echo ok2' }))).toContain('ok2')
    expect(last().settings.filesystem.denyRead).toContain(abs(`${P.folderPath}/skills`))
    const n = runs.size
    for (const command of [`cp "$TRINA_TEAM/${GROUP_SCRIPT}" . && python3 x.py`, 'python3 $TRINA_TEAM/groups/marketing/skills/grp-tool/scripts/x.py', `cat "../../${P.folderPath}/skills/proj-tool/scripts/y.py"`]) {
      const r = await shell().call({ command })
      expect(r.isError).toBe(true)
      expect(out(r)).toBe(OTHERS_SKILLS_REFUSAL)
    }
    // the project's own skills folder as the folder a command starts in
    expect(out(await shell({ project: P }).call({ command: 'echo in', cwd: 'skills/proj-tool' }))).toBe(OTHERS_SKILLS_REFUSAL)
    expect(runs.size).toBe(n)
  })

  test('which command texts name such a folder', () => {
    for (const c of ['python3 $TRINA_TEAM/groups/m/skills/t/x.py', 'cp ${TRINA_TEAM}/projects/p/skills/a/x.py .', "cat 'groups/m/SKILLS/x'", 'cd ../../groups/m/skills', 'ls projects/p/skills', 'cat "projects/Proj X/skills/a/y.py"']) expect(namesOthersSkills(c)).toBe(true)
    for (const c of ['cat shared/groups/x/skills/a', 'python3 $TRINA_TEAM/skills/team/scripts/x.py', 'echo groups/x/skillset', 'ls groups/m/notes']) expect(namesOthersSkills(c)).toBe(false)
  })
})

describe('the file tools never save a copy of one (QA TC-4932)', () => {
  const turnWrite = async (file_path: string, content: string) => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    return (await ask(h, alice, 'alice', chat, fakeLine({ tool: 'write', args: { file_path, content }, sayResult: true }))).done.content
  }
  test('write: the same text (other line endings, extra spaces too) is refused, nothing saved; other text saves', async () => {
    for (const [i, content] of [SCRIPT, SCRIPT.replace(/\n/g, '  \r\n') + '\n\n'].entries()) {
      const said = await turnWrite(`users/alice/copy${i}.py`, content)
      expect(said).toContain(`it is a copy of ${GROUP_SCRIPT}, a file of a group's or project's skill`)
      expect(fs.existsSync(abs(`users/alice/copy${i}.py`))).toBe(false)
    }
    expect(await turnWrite('shared/proj-copy.py', SCRIPT.replace('print', 'print("p",'))).toContain(`it is a copy of ${PROJ_SCRIPT()}`)
    expect(await turnWrite('users/alice/mine.py', 'print("a script of my own that is long enough")\n')).toContain('Created users/alice/mine.py')
  })

  test('edit into a copy is refused; the SKILL.md text and people\'s own saves are not checked', async () => {
    put('users/alice/half.py', SCRIPT.replace('print(root, files)', 'pass'))
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const said = (await ask(h, alice, 'alice', chat, fakeLine({ tool: 'read', args: { file_path: 'users/alice/half.py' } }, { tool: 'edit', args: { file_path: 'users/alice/half.py', old_string: 'pass', new_string: 'print(root, files)' }, sayResult: true }))).done.content
    expect(said).toContain('it is a copy of')
    expect(fs.readFileSync(abs('users/alice/half.py'), 'utf8')).toContain('pass')
    // the instructions themselves (Markdown) may be quoted into a note
    const md = fs.readFileSync(abs('groups/marketing/skills/grp-tool/SKILL.md'), 'utf8')
    expect(await turnWrite('users/alice/notes.md', md)).toContain('Created users/alice/notes.md')
    // outside a chat turn (the Files screen) nothing is refused
    expect(() => refuseSkillScriptCopy({ turnId: null }, team, 'users/alice/x.py', Buffer.from(SCRIPT))).not.toThrow()
    expect(() => refuseSkillScriptCopy({ turnId: 't' }, team, 'users/alice/x.py', Buffer.from(SCRIPT))).toThrow(/a copy of/)
    // a save inside a group's skills folder has its own card (skills/guard.ts), not this refusal
    expect(() => refuseSkillScriptCopy({ turnId: 't' }, team, 'groups/marketing/skills/grp-tool/scripts/x2.py', Buffer.from(SCRIPT))).not.toThrow()
    // too short to tell from a coincidence
    expect(copyKey(Buffer.from('print(1)\n'))).toBeNull()
  })
})
