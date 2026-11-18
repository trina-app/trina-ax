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
import { _active, accessHash, setSrtSystem, spaceOf } from '../../server/src/devenv/srt/runner'
import { holdSkillFolders, isSkillPlaceholder } from '../../server/src/devenv/srt/placeholders'
import { copyCodeLine } from '../../server/src/chat/tools'
import { unitName } from '../../server/src/devenv/srt/config'
import type { SrtSystem, SpawnSpec, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, namesOthersSkills, OTHERS_SKILLS_REFUSAL } from '../../server/src/devenv/tool'
import { folderView, sharedFolderView, viewAccess } from '../../server/src/devenv/srt/access'
import { copyKey, othersSkillRoots, refuseSkillScriptCopy, scriptCopyRefusal } from '../../server/src/skills/script-copies'

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
    for (const command of [`cp "$TRINA_TEAM/${GROUP_SCRIPT}" . && python3 x.py`, 'python3 $TRINA_TEAM/groups/marketing/skills/grp-tool/scripts/x.py', `cat "$TRINA_TEAM/${P.folderPath}/skills/proj-tool/scripts/y.py"`]) {
      const r = await shell().call({ command })
      expect(r.isError).toBe(true)
      expect(out(r)).toBe(OTHERS_SKILLS_REFUSAL)
    }
    // the project's own skills folder as the folder a command starts in
    expect(out(await shell({ project: P }).call({ command: 'echo in', cwd: 'skills/proj-tool' }))).toBe(OTHERS_SKILLS_REFUSAL)
    expect(runs.size).toBe(n)
  })

  test('which command texts name such a folder: only paths under $TRINA_TEAM (the run hides the rest anyway)', () => {
    for (const c of ['python3 $TRINA_TEAM/groups/m/skills/t/x.py', 'cp ${TRINA_TEAM}/projects/p/skills/a/x.py .', 'cat "$TRINA_TEAM/groups/m/SKILLS/x"', 'ls $TRINA_TEAM//projects/p/skills', 'cat "$TRINA_TEAM/projects/Proj X/skills/a/y.py"']) expect(namesOthersSkills(c)).toBe(true)
    for (const c of ['cat shared/groups/x/skills/a', 'python3 $TRINA_TEAM/skills/team/scripts/x.py', 'echo $TRINA_TEAM/groups/x/skillset', 'ls $TRINA_TEAM/groups/m/notes', 'cd ../../groups/m/skills', 'ls projects/p/skills']) expect(namesOthersSkills(c)).toBe(false)
  })

  test('a run\'s empty skills placeholder is not a group or project skills folder; who makes or removes one never changes another person\'s run hash', async () => {
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const space = spaceOf(h.ctx, { userId: 'alice', chatId: chat, project: null })!
    const before = accessHash(h.ctx, space)
    // bob's group gets a skills folder, then loses it again: alice's runs keep their hash
    fs.mkdirSync(abs('groups/finance/skills/new-one'), { recursive: true })
    expect(othersSkillRoots(team)).toContain('groups/finance/skills')
    expect(accessHash(h.ctx, space)).toBe(before)
    fs.rmSync(abs('groups/finance/skills'), { recursive: true })
    expect(accessHash(h.ctx, space)).toBe(before)
    // a placeholder a run holds (a project's absent skills folder) is left out of the hidden folders
    const ph = 'projects/placeholder-test'
    fs.mkdirSync(abs(ph), { recursive: true })
    const release = holdSkillFolders(team, [`${ph}/skills`])
    try {
      expect(fs.existsSync(abs(`${ph}/skills`))).toBe(true)
      expect(isSkillPlaceholder(path.join(team, ph, 'skills'))).toBe(true)
      expect(othersSkillRoots(team, isSkillPlaceholder)).not.toContain(`${ph}/skills`)
      expect(othersSkillRoots(team)).toContain(`${ph}/skills`)
    } finally { release(); fs.rmSync(abs(ph), { recursive: true, force: true }) }
  })
})
describe('the file tools never save a copy of one that the chat read (QA TC-4932)', () => {
  const read = (file_path: string) => ({ tool: 'read', args: { file_path } })
  const write = (file_path: string, content: string) => ({ tool: 'write', args: { file_path, content }, sayResult: true })
  const say = async (chat: string, ...steps: unknown[]) => (await ask(h, alice, 'alice', chat, fakeLine(...steps))).done.content
  const newChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id

  test('read, then written elsewhere (other line endings and spaces too): refused, nothing saved, the path named', async () => {
    for (const [i, content] of [SCRIPT, SCRIPT.replace(/\n/g, '  \r\n') + '\n\n'].entries()) {
      const said = await say(await newChat(), read(GROUP_SCRIPT), write(`users/alice/copy${i}.py`, content))
      expect(said).toContain(`it is a copy of ${GROUP_SCRIPT}, a file of a group's or project's skill that this chat read`)
      expect(fs.existsSync(abs(`users/alice/copy${i}.py`))).toBe(false)
    }
    expect(await say(await newChat(), read(PROJ_SCRIPT()), write('users/alice/proj-copy.py', SCRIPT.replace('print', 'print("p",')))).toContain(`it is a copy of ${PROJ_SCRIPT()}`)
    expect(await say(await newChat(), read(GROUP_SCRIPT), write('users/alice/mine.py', 'print("a script of my own that is long enough")\n'))).toContain('Created users/alice/mine.py')
  })

  test('read in an earlier answer of the chat, written in a later one: refused too', async () => {
    const chat = await newChat()
    await say(chat, read(GROUP_SCRIPT), { say: 'read it' })
    const said = await say(chat, write('users/alice/later.py', SCRIPT))
    expect(said).toContain('it is a copy of')
    expect(fs.existsSync(abs('users/alice/later.py'))).toBe(false)
  })

  test('edit into a copy is refused; the SKILL.md text, people\'s own saves and saves in a skill folder are not checked', async () => {
    put('users/alice/half.py', SCRIPT.replace('print(root, files)', 'pass'))
    const said = await say(await newChat(), read(GROUP_SCRIPT), read('users/alice/half.py'), { tool: 'edit', args: { file_path: 'users/alice/half.py', old_string: 'pass', new_string: 'print(root, files)' }, sayResult: true })
    expect(said).toContain('it is a copy of')
    expect(fs.readFileSync(abs('users/alice/half.py'), 'utf8')).toContain('pass')
    // the instructions themselves (Markdown) may be quoted into a note
    const md = fs.readFileSync(abs('groups/marketing/skills/grp-tool/SKILL.md'), 'utf8')
    expect(await say(await newChat(), read('groups/marketing/skills/grp-tool/SKILL.md'), write('users/alice/notes.md', md))).toContain('Created users/alice/notes.md')
    const files = { allReads: new Map([[GROUP_SCRIPT, 'h']]) }
    const yes = () => true
    expect(() => refuseSkillScriptCopy({ turnId: null, files }, team, 'users/alice/x.py', Buffer.from(SCRIPT), yes)).not.toThrow()
    expect(() => refuseSkillScriptCopy({ turnId: 't', files }, team, 'users/alice/x.py', Buffer.from(SCRIPT), yes)).toThrow(/a copy of groups\/marketing/)
    expect(() => refuseSkillScriptCopy({ turnId: 't', files }, team, 'groups/marketing/skills/grp-tool/scripts/x2.py', Buffer.from(SCRIPT), yes)).not.toThrow()
    expect(copyKey(Buffer.from('print(1)\n'))).toBeNull()
  })

  test('a copy of a file this chat never read is not compared; the refusal names a path only when the person may read it now', () => {
    expect(() => refuseSkillScriptCopy({ turnId: 't', files: { allReads: new Map() } }, team, 'users/alice/x.py', Buffer.from(SCRIPT), () => true)).not.toThrow()
    // read in an earlier answer, no longer readable (carried): only the hash recorded then is compared (never the disk),
    // and the refusal names nothing
    const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex')
    const gone = (recorded: string, data: string) => {
      try { refuseSkillScriptCopy({ turnId: 't', files: { allReads: new Map(), carried: { hashes: new Map([[GROUP_SCRIPT, recorded]]) } } }, team, 'users/alice/x.py', Buffer.from(data), () => false); return '' } catch (e) { return (e as Error).message }
    }
    const msg = gone(sha(SCRIPT), SCRIPT)
    expect(msg).toContain('it is a copy of a file, a file of a group\'s or project\'s skill')
    expect(msg).not.toContain('groups/')
    // the file on the disk is the same as the save, but the recorded read was another version: not refused (the disk is
    // not read, so nothing is learned about it as it is now); line endings are not evened out for such a file
    expect(gone(sha('an older version of the script, long enough'), SCRIPT)).toBe('')
    expect(gone(sha(SCRIPT), SCRIPT.replace(/\n/g, '\r\n'))).toBe('')
    // the same through allReads (read in this answer, access lost since)
    expect(() => refuseSkillScriptCopy({ turnId: 't', files: { allReads: new Map([[GROUP_SCRIPT, sha(SCRIPT)]]) } }, team, 'users/alice/y.py', Buffer.from(SCRIPT), () => false)).toThrow(/a copy of a file,/)
    expect(scriptCopyRefusal('a.py', null)).not.toContain('marketing')
  })

  test('a save costs no walk of the skills folders: 2,000 group skill files and a save stays fast', () => {
    for (let i = 0; i < 2000; i++) put(`groups/marketing/skills/bulk/scripts/f${i}.py`, `print("file number ${i} of the bulk skill")\n`)
    try {
      const t0 = performance.now()
      for (let i = 0; i < 50; i++) refuseSkillScriptCopy({ turnId: 't', files: { allReads: new Map([['shared/a.md', 'h'], [GROUP_SCRIPT, 'h']]) } }, team, `users/alice/n${i}.py`, Buffer.from(`print("an unrelated script number ${i}")\n`), () => true)
      expect(performance.now() - t0).toBeLessThan(500)
    } finally { fs.rmSync(abs('groups/marketing/skills/bulk'), { recursive: true, force: true }) }
  })
})

describe('copying or moving a group or project skill that holds code (move_skill)', () => {
  const files = [{ path: 'groups/marketing/skills/grp-tool/SKILL.md' }, { path: 'groups/marketing/skills/grp-tool/scripts/x.py' }]
  const group = { level: 'group', group: { id: 'marketing', name: 'Marketing' } }
  test('the card says who wrote the code and that it runs with the access of its new users', () => {
    const l = copyCodeLine({ copy: true, from: group, to: { level: 'personal' }, files } as never, 'en')
    expect(l).toContain('1 script or code file written by members of the group "Marketing"')
    expect(l).toContain('can run with the access of whoever uses the skill there, you included')
    expect(copyCodeLine({ copy: true, from: { level: 'project', project: { id: 'p', name: 'Atlas' } }, to: { level: 'team' }, files } as never, 'en')).toContain('people who can change the project "Atlas"')
    expect(copyCodeLine({ copy: true, from: group, to: { level: 'personal' }, files } as never, 'ko')).toContain('Marketing')
  })
  test('a move says it too; nothing for a Markdown-only skill, a team skill, or into another group or project', () => {
    expect(copyCodeLine({ copy: false, from: group, to: { level: 'personal' }, files } as never, 'en')).toContain('written by members of the group "Marketing"')
    expect(copyCodeLine({ copy: false, from: group, to: { level: 'group', group: { id: 'f', name: 'F' } }, files } as never, 'en')).toBe('')
    expect(copyCodeLine({ copy: true, from: group, to: { level: 'personal' }, files: files.slice(0, 1) } as never, 'en')).toBe('')
    expect(copyCodeLine({ copy: true, from: { level: 'team' }, to: { level: 'personal' }, files } as never, 'en')).toBe('')
    expect(copyCodeLine({ copy: true, from: group, to: { level: 'group', group: { id: 'f', name: 'F' } }, files } as never, 'en')).toBe('')
  })
})
