// The AI's scratch stays out of team folders (docs/decisions/20261121-ai-scratch-files.md). On potenlab.trina.app a
// shared project chat's AI downloaded a GitHub repo into the project folder (13,181 recorded files in one answer) and
// then could not delete it. Here: a project chat's commands get $TRINA_WORK (the chat's work folder; a shared chat's
// own one), the tool text sends downloads and tools there, the bulk guard asks before many new files are recorded and
// moves them otherwise, the summary card counts the rest by folder, and delete_files takes the AI's own files.
//
// The fake dev environment runs each command with the real bash, with the run's environment and folder, so a command
// really makes files in the project folder and the move really runs.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, FILE_SUMMARY_LIST_MAX, uuidv7, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { _active, setSrtSystem, workFolderAt, type SharedRun } from '../../server/src/devenv/srt/runner'
import { chatWork, unitName } from '../../server/src/devenv/srt/config'
import type { SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, callerOf, PROJECT_SCRATCH_TEXT, sharedShellDescription, srtShellDescription } from '../../server/src/devenv/tool'
import { BULK_BYTES, BULK_FILES, bulkCard, movableRoots, moveScript, overBulk, newBulkState, sizeWords, type BulkAsk } from '../../server/src/devenv/bulk'
import { bulkCardFacts } from '../../server/src/chat/tools'
import { fileSummaryOf } from '../../server/src/chat/turn'
import { ownMade, OWN_TRASH_MAX_ENTRIES } from '../../server/src/chat/own-files'
import { DELETE_REFUSAL, deleteFilesTool, OWN_OVERRIDES, type DeleteExec } from '../../server/src/chat/delete-files'
import { componentC } from '../../server/src/team-files/component'
import { TurnFiles } from '../../server/src/files/service'

setDefaultTimeout(120_000)
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
type Settings = { filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[]; denyWrite: string[] } }
interface FakeRun { spec: SpawnSpec; settings: Settings; state: 'active' | 'gone' }
const runs: FakeRun[] = []
const fake: SrtSystem = {
  spawn(spec) {
    const run: FakeRun = { spec, settings: JSON.parse(fs.readFileSync(spec.settingsFile, 'utf8')), state: 'active' }
    runs.push(run)
    const p = Bun.spawn(['bash', '-c', spec.command], { cwd: spec.cwd, env: { ...spec.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdout: 'pipe', stderr: 'pipe' })
    const exited = (async () => {
      const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      fs.writeFileSync(spec.stdoutFile, o); fs.writeFileSync(spec.stderrFile, e); fs.writeFileSync(spec.exitFile, `${code}\n`)
      run.state = 'gone'
      return { code, signal: null }
    })()
    return { pid: p.pid, exited }
  },
  async stop() {},
  async unit(runId): Promise<UnitInfo> { const r = runs.find((x) => x.spec.runId === runId); return !r || r.state === 'gone' ? { state: '', result: '', memoryBytes: null } : { state: 'active', result: '', memoryBytes: 50 << 20 } },
  async units() { return runs.filter((r) => r.state !== 'gone').map((r) => unitName(r.spec.runId)) },
  async forget() {},
  oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}

let h: Harness, base = '', team = '', P: { id: string; folderPath: string; name: string }, chat = ''
const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const last = () => runs.at(-1)!
const abs = (rel: string) => path.join(team, ...rel.split('/'))
const turnOn = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
const sharedRun = (audience: string[], within: string | null): SharedRun => ({ within, audience: () => [...audience], noteReads: () => true })
const MAIN = {}
/** box_shell of one answer (one turn id) in alice's project chat; `keep` answers the bulk card */
function shell(o: { shared?: SharedRun; keep?: (a: BulkAsk) => Promise<boolean | null>; turnId?: string } = {}) {
  const turnId = o.turnId ?? 't-' + crypto.randomUUID()
  const tool = boxShellTool({ ctx: h.ctx, project: P, userId: 'alice', turnId, chatId: chat, signal: new AbortController().signal, redact: (s) => s,
    confirm: async () => 'run', caller: (f) => callerOf(f, MAIN), ...(o.keep ? { keepBulk: o.keep } : {}), ...(o.shared ? { shared: o.shared } : {}) })
  return { turnId, call: (command: string, files: unknown = MAIN) => tool.call({ command, timeout_sec: 120 }, files) }
}
const events = (turnId: string, like = '%') => (h.ctx.db.query("SELECT COUNT(*) AS n FROM file_events WHERE turn_id = ? AND path LIKE ? AND action = 'create'").get(turnId, like) as { n: number }).n
const make = (n: number, dir: string) => `mkdir -p ${dir} && i=0; while [ $i -lt ${n} ]; do i=$((i+1)); echo $i > ${dir}/f$i.txt; done`
const scratch = () => chatWork(base, chat)
const movedDirs = () => { try { return fs.readdirSync(path.join(scratch(), 'from-project')) } catch { return [] } }

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'ai-scratch', askUserTimeoutMs: 2500 })
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-'))
  team = h.ctx.files.fx.root
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Deck Proj', participants: [user('alice'), user('bob')], instructions: '' } })
  P = { id: p.id, folderPath: p.folderPath, name: p.name }
  chat = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
})
afterAll(async () => { setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(() => {
  runs.length = 0; _active().clear()
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  turnOn()
})

describe('a project chat has a scratch folder ($TRINA_WORK)', () => {
  test('the person\'s own project chat: $TRINA_WORK is the chat\'s work folder, writable; the command starts in the project folder', async () => {
    const r = await shell().call('echo "$TRINA_WORK"; pwd')
    expect(out(r)).toContain(scratch())
    const run = last()
    expect(run.spec.env.TRINA_WORK).toBe(scratch())
    expect(run.settings.filesystem.allowWrite).toContain(scratch())
    expect(run.spec.cwd).toBe(fs.realpathSync(abs(P.folderPath)))
    // read, list, glob and grep reach it as chat:work/
    expect(workFolderAt(h.ctx, { userId: 'alice', chatId: chat, project: P })?.path).toBe(scratch())
  })

  test('a shared project chat: a work folder of its own for its people, never the private one', async () => {
    await shell({ shared: sharedRun(['alice', 'bob'], P.folderPath) }).call('echo ok')
    const run = last()
    const w = run.spec.env.TRINA_WORK!
    expect(w.startsWith(path.join(base, 'devenv', 'work-shared', chat) + '/')).toBe(true)
    expect(run.settings.filesystem.allowWrite).toContain(w)
    const named = [...run.settings.filesystem.allowRead, ...run.settings.filesystem.allowWrite]
    expect(named.some((p) => p === scratch() || p.startsWith(path.join(base, 'devenv', 'work') + '/'))).toBe(false)
    // read, list, glob and grep reach it as chat:work/ there too (review M3)
    expect(workFolderAt(h.ctx, { userId: 'alice', chatId: chat, project: P, shared: sharedRun(['alice', 'bob'], P.folderPath) })?.path).toBe(w)
    // other people in the chat (bob left it): another folder
    const n = runs.length
    await shell({ shared: sharedRun(['alice'], P.folderPath) }).call('echo ok')
    expect(runs.length).toBe(n + 1)
    expect(last().spec.env.TRINA_WORK).not.toBe(w)
  })

  test('the tool text sends downloads, clones, installs and previews to $TRINA_WORK; only finished files into the project folder', () => {
    for (const d of [srtShellDescription(false), sharedShellDescription(true)]) {
      expect(d).toContain(PROJECT_SCRATCH_TEXT)
      expect(d).toContain('$TRINA_WORK')
    }
    expect(PROJECT_SCRATCH_TEXT).toContain('git clones')
    expect(PROJECT_SCRATCH_TEXT).toContain('licence')
    expect(srtShellDescription(false)).toContain('make a result in $TRINA_WORK')
  })
})

describe('the bulk guard', () => {
  test('600 new files, the person says move: they go to $TRINA_WORK/from-project/<time>/ with their folders, are not recorded, and the AI is told', async () => {
    const asks: BulkAsk[] = []
    const s = shell({ keep: async (a) => { asks.push(a); return false } })
    const before = movedDirs()
    const r = await s.call(make(600, '_tools/repo/sub'))
    expect(asks).toHaveLength(1)
    expect(asks[0]!.files).toBe(600)
    expect(asks[0]!.folders[0]).toEqual({ path: '_tools/repo/', files: 600 })
    expect(fs.existsSync(abs(`${P.folderPath}/_tools`))).toBe(false)
    const stamp = movedDirs().find((d) => !before.includes(d))!
    expect(fs.readFileSync(path.join(scratch(), 'from-project', stamp, '_tools/repo/sub/f600.txt'), 'utf8')).toBe('600\n')
    expect(events(s.turnId)).toBe(0)
    expect(out(r)).toContain(`were moved out of the project folder to $TRINA_WORK/from-project/${stamp}/`)
    expect(out(r)).not.toContain('Files changed by this command')
    const a = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'dev_env.bulk_files' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(a.detail)).toMatchObject({ turnId: s.turnId, files: 600, decision: 'move', asked: true, moved: 600 })
  })

  test('keep: recorded as before, and no second card in the same answer', async () => {
    const asks: BulkAsk[] = []
    const s = shell({ keep: async (a) => { asks.push(a); return true } })
    const r = await s.call(make(600, 'kept/a'))
    expect(out(r)).toContain('chose to keep the 600 new files')
    expect(events(s.turnId)).toBe(600)
    await s.call(make(600, 'kept/b'))
    expect(asks).toHaveLength(1)
    expect(events(s.turnId)).toBe(1200)
    fs.rmSync(abs(`${P.folderPath}/kept`), { recursive: true, force: true })
  })

  test('no answer (nobody to ask, the card timed out) moves them; under the line nothing asks', async () => {
    const s = shell({ keep: async () => null })
    await s.call(make(20, 'small'))
    expect(events(s.turnId)).toBe(20)
    await s.call(make(BULK_FILES, 'big'))
    // 20 + 500 is over the line for this answer: the command that crossed it moves its own files only
    expect(fs.existsSync(abs(`${P.folderPath}/big`))).toBe(false)
    expect(fs.existsSync(abs(`${P.folderPath}/small/f20.txt`))).toBe(true)
    expect(events(s.turnId)).toBe(20)
    fs.rmSync(abs(`${P.folderPath}/small`), { recursive: true, force: true })
  })

  test('a changed file never moves; new files in a folder that was there move one by one, the folder stays', async () => {
    fs.mkdirSync(abs(`${P.folderPath}/docs`), { recursive: true })
    fs.writeFileSync(abs(`${P.folderPath}/docs/old.md`), 'old\n')
    await shell().call('true') // the window's start knows docs/old.md
    const s = shell({ keep: async () => false })
    await s.call(`echo changed > docs/old.md; ${make(510, 'docs')}`)
    expect(fs.readFileSync(abs(`${P.folderPath}/docs/old.md`), 'utf8')).toBe('changed\n')
    expect(fs.existsSync(abs(`${P.folderPath}/docs/f1.txt`))).toBe(false)
    expect(fs.existsSync(abs(`${P.folderPath}/docs`))).toBe(true)
    const upd = h.ctx.db.query("SELECT COUNT(*) AS n FROM file_events WHERE turn_id = ? AND action = 'update'").get(s.turnId) as { n: number }
    expect(upd.n).toBe(1)
    fs.rmSync(abs(`${P.folderPath}/docs`), { recursive: true, force: true })
  })

  test('what else changed while the card waited (a job writing) is recorded as background, not lost (review M2)', async () => {
    const s = shell({ keep: async () => { fs.writeFileSync(abs(`${P.folderPath}/job-out.txt`), 'job\n'); return false } })
    await s.call(make(600, 'm2/x'))
    expect(fs.existsSync(abs(`${P.folderPath}/m2`))).toBe(false)
    const row = h.ctx.db.query("SELECT detail FROM file_events WHERE path = ? AND action = 'create' ORDER BY id DESC LIMIT 1").get(`${P.folderPath}/job-out.txt`) as { detail: string } | null
    expect(JSON.parse(row!.detail)).toMatchObject({ via: 'dev_env', background: true })
    fs.rmSync(abs(`${P.folderPath}/job-out.txt`), { force: true })
  })

  test('a sub-agent cannot keep them: no card, they move', async () => {
    let asked = 0
    const s = shell({ keep: async () => { asked++; return true } })
    const r = await s.call(make(600, 'helper/x'), { agent: 'a1' })
    expect(asked).toBe(0)
    expect(out(r)).toContain('a sub-agent cannot ask the person to keep them')
    expect(fs.existsSync(abs(`${P.folderPath}/helper`))).toBe(false)
  })

  test('the line, the card words and the move script', () => {
    expect(overBulk(newBulkState(), BULK_FILES, 0)).toBe(false)
    expect(overBulk(newBulkState(), BULK_FILES + 1, 0)).toBe(true)
    expect(overBulk(newBulkState(), 1, BULK_BYTES + 1)).toBe(true)
    expect(overBulk({ files: 0, bytes: 0, kept: true }, 10_000, 0)).toBe(false)
    const c = bulkCard({ files: 13181, bytes: 120 * 1024 * 1024, folders: [{ path: '_tools/ppt-master/', files: 13181 }], project: 'projects/p' }, 'ko')
    expect(c.question).toContain('13,181')
    expect(c.question).toContain('(120 MB)')
    expect(c.details[0]!.text).toContain('_tools › ppt-master (13,181)')
    expect(moveScript('.l', 'from-project/x')).toContain('mv -n --')
  })

  // QA TC-7335: "which the whole team sees" for a project only its creator sees, "(0.0 MB)", "My files › projects ›
  // <name>" and "Mostly in … 11 characters"
  test('the card says who really sees the folder, the project by its name, a size that means something, and the folders with no character count', () => {
    const ask: BulkAsk = { files: 600, bytes: 600 * 4, folders: [{ path: 'bulk/', files: 590 }, { path: '(the project folder)', files: 10 }], project: 'users/alice/projects/qa-solo' }
    const only = bulkCard(ask, 'en', { name: 'QA Solo', who: { kind: 'only' } })
    expect(only.question).toBe('An AI command made 600 new files (2 KB) in the folder of the project “QA Solo”. Only you can see that folder. Keep them in the project folder, or move them to this chat\'s work folder?')
    expect(only.question).not.toContain('whole team')
    expect(only.question).not.toContain('users/')
    expect(only.question).not.toContain('My files')
    expect(only.details).toEqual([{ label: 'Folders with the most new files', text: 'bulk (590)\nRight in the project folder (10)', noSize: true }])
    expect(bulkCard(ask, 'en', { who: { kind: 'team' } }).question).toContain('“qa-solo”. The whole team can see that folder.')
    expect(bulkCard(ask, 'ko', { name: 'QA 솔로', who: { kind: 'some', n: 3 } }).question).toBe('AI 명령이 “QA 솔로” 프로젝트 폴더에 새 파일 600개(2 KB)를 만들었어요. 이 폴더는 3명이 볼 수 있어요. 프로젝트 폴더에 둘까요, 이 채팅의 작업 폴더로 옮길까요?')
    // tiny files: no size at all (never "0.0 MB"); who unknown: nothing said about it
    const tiny = bulkCard({ ...ask, bytes: 600 }, 'en', { name: 'QA Solo', who: null })
    expect(tiny.question).toBe('An AI command made 600 new files in the folder of the project “QA Solo”. Keep them in the project folder, or move them to this chat\'s work folder?')
    for (const L of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
      const q = bulkCard({ ...ask, bytes: 600 }, L, { name: 'X', who: { kind: 'only' } }).question
      expect({ L, q }).toEqual({ L, q: expect.not.stringMatching(/\{|0\.0|MB|\(\)|（）/) })
    }
    expect(sizeWords(0)).toBeNull()
    expect(sizeWords(1023)).toBeNull()
    expect(sizeWords(24_000)).toBe('23 KB')
    expect(sizeWords(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  test('the card\'s facts come from the real folder: a personal project is "only you", a team project its members', async () => {
    const solo = await h.api('alice').call(API.createProject, { body: { name: 'Bulk Solo', scope: 'personal', instructions: '' } })
    const exec = { rt: h.rt(), spec: { userId: 'alice', locale: 'en' } } as unknown as Parameters<typeof bulkCardFacts>[0]
    expect(bulkCardFacts(exec, { project: solo.folderPath, projectId: solo.id })).toEqual({ name: 'Bulk Solo', who: { kind: 'only' } })
    const team = bulkCardFacts(exec, { project: P.folderPath, projectId: P.id })
    expect(team.name).toBe(P.name)
    expect(team.who?.kind).not.toBe('only')
  })

  test('the tool text names the line and never has the AI promise a card below it (QA TC-7336)', () => {
    for (const d of [srtShellDescription(false), sharedShellDescription(true)]) {
      expect(d).toContain(`more than ${BULK_FILES} new files or 200 MB`)
      expect(d).toContain('never tell the person a question about keeping files may come')
      expect(d).not.toContain('When one answer adds many new files to the project folder, the person is asked')
    }
  })

  test('movableRoots: a folder born during the command goes whole; nested ones once; older folders keep theirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'))
    fs.mkdirSync(path.join(root, 'p/old'), { recursive: true })
    const t0 = Date.now() + 5
    while (Date.now() < t0 + 5) { /* a later birth time */ }
    fs.mkdirSync(path.join(root, 'p/new/deep'), { recursive: true })
    const ch = (p: string) => ({ path: `p/${p}`, action: 'create' as const, before: null, after: null, size: 1 })
    expect(movableRoots(root, 'p', [ch('new/deep/a'), ch('new/b'), ch('old/c'), ch('top.txt')], t0)).toEqual(['new', 'old/c', 'top.txt'])
    // a teammate's file saved into the new folder during the command: that folder never moves whole (review L2)
    expect(movableRoots(root, 'p', [ch('new/deep/a'), ch('new/b')], t0, ['p/new/deep/a', 'p/new/b', 'p/new/theirs.md'])).toEqual(['new/b', 'new/deep'])
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('the summary card', () => {
  test('a long list keeps the first files and counts the rest by folder; the header count is the full one', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ path: i < 200 ? `projects/p/_tools/a/f${i}` : `projects/p/_tools/b/f${i}`, action: 'create', detail: '{"via":"dev_env"}' }))
    const s = fileSummaryOf(rows)!
    expect(s.saved).toHaveLength(FILE_SUMMARY_LIST_MAX)
    expect(s.more).toEqual({ count: 150, folders: [{ path: 'projects/p/_tools/a', count: 100 }, { path: 'projects/p/_tools/b', count: 50 }] })
    expect(fileSummaryOf(rows.slice(0, 30))!.more).toBeUndefined()
  })
})

describe('delete_files and the AI\'s own files', () => {
  const ownChat = 'own-' + crypto.randomUUID()
  const otherChat = 'other-' + crypto.randomUUID()
  const turn = (chatId: string, userId = 'alice') => { const id = uuidv7(); h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine) VALUES (?, ?, ?, 'fake')").run(id, chatId, userId); return id }
  const ev = (turnId: string | null, userId: string, rel: string, action = 'create', detail: Record<string, unknown> = { via: 'dev_env' }) =>
    h.ctx.db.query('INSERT INTO file_events (turn_id, user_id, path, action, detail) VALUES (?, ?, ?, ?, ?)').run(turnId, userId, rel, action, JSON.stringify(detail))
  const put = (rel: string) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), 'x\n') }
  const planOf = (paths: string[]) => { const r = componentC(h.ctx).files.planAiTrash('alice', paths, { maxEntries: OWN_TRASH_MAX_ENTRIES }); if (!('plan' in r)) throw new Error(JSON.stringify(r.refused)); return r.plan }
  const own = (rel: string) => ownMade(h.ctx.db, team, { userId: 'alice', chatId: ownChat }, planOf([rel]))
  /** a scratch folder this chat's AI made: two recorded files and a .venv the snapshot skips */
  const scratchDir = (name: string) => {
    const t = turn(ownChat)
    const rel = `${P.folderPath}/${name}`
    for (const f of ['a.txt', 'sub/b.txt']) { put(`${rel}/${f}`); ev(t, 'alice', `${rel}/${f}`) }
    put(`${rel}/.venv/lib/x.py`)
    return { rel, t }
  }

  test('made by this person\'s answers in this chat, nobody else: own (a .venv born with it counts too)', () => {
    expect(own(scratchDir('s1').rel)).toEqual({ own: true })
  })

  test('not own: a file with no history (an old file whose history was pruned), a teammate\'s change, another chat, a move in, a change found between commands, a history that starts with an update', () => {
    const a = scratchDir('s2'); put(`${a.rel}/old-unrecorded.md`)
    expect(own(a.rel).own).toBe(false)
    const b = scratchDir('s3'); ev(turn(ownChat, 'bob'), 'bob', `${b.rel}/a.txt`, 'update')
    expect(own(b.rel).own).toBe(false)
    const c = scratchDir('s4'); ev(turn(otherChat), 'alice', `${c.rel}/a.txt`, 'update')
    expect(own(c.rel).own).toBe(false)
    const d = scratchDir('s5'); put(`${d.rel}/moved.md`); ev(d.t, 'alice', `${d.rel}/moved.md`, 'create', { movedFrom: 'shared/x.md' })
    expect(own(d.rel).own).toBe(false)
    const e = scratchDir('s6'); ev(e.t, 'alice', `${e.rel}/a.txt`, 'update', { via: 'dev_env', background: true })
    expect(own(e.rel).own).toBe(false)
    const rel = `${P.folderPath}/s7`; put(`${rel}/a.txt`); const t = turn(ownChat); ev(t, 'alice', `${rel}/a.txt`, 'update'); ev(t, 'alice', `${rel}/a.txt`, 'create')
    expect(own(rel).own).toBe(false)
    // a file the person saved on the Files screen (no turn)
    const f = scratchDir('s8'); ev(null, 'alice', `${f.rel}/a.txt`, 'update', {})
    expect(own(f.rel).own).toBe(false)
  })

  const execOf = (o: { shared?: boolean; chatId?: string; confidential?: boolean } = {}) => {
    const main = new TurnFiles()
    const asked: unknown[] = []
    const exec = {
      spec: { userId: 'alice', chatId: o.chatId ?? ownChat, turnId: uuidv7(), locale: 'en', clientKind: 'web' },
      room: null, shared: o.shared ? { kind: 'project' } : null, restricted: false, templateRun: false, roomsSeen: false, otherAuthors: !!o.shared, fromSlack: false,
      files: main, rt: h.rt(), livePrincipal: () => h.ctx.files.principal('alice'), openRequests: () => [],
      waitForPerson: (req: unknown) => { asked.push(req); return Promise.resolve('skip') },
    } as unknown as DeleteExec
    return { exec, main, asked }
  }

  test('a shared project chat: the AI\'s own scratch goes to the trash without a card; a teammate\'s file is still refused', async () => {
    const { rel } = scratchDir('s9')
    const { exec, main, asked } = execOf({ shared: true })
    const tool = deleteFilesTool(exec)
    expect(tool.refuse!({ paths: [rel] })).toBeNull()
    const r = await tool.call({ paths: [rel] }, main)
    expect(asked).toHaveLength(0)
    expect(out(r as never)).toContain('files you made yourself in this chat')
    expect(fs.existsSync(abs(rel))).toBe(false)
    const row = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'files.ai_trash' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(row.detail)).toMatchObject({ outcome: 'trashed', own: true })
    // bob's file in the same project: the shared chat's refusal, nothing moved
    put(`${P.folderPath}/bob-notes.md`); ev(turn(ownChat, 'bob'), 'bob', `${P.folderPath}/bob-notes.md`)
    const r2 = await deleteFilesTool(execOf({ shared: true }).exec).call({ paths: [`${P.folderPath}/bob-notes.md`] }, execOf().main)
    expect(fs.existsSync(abs(`${P.folderPath}/bob-notes.md`))).toBe(true)
    expect(r2.isError).toBe(true)
  })

  test('more than 200 own files go in one call (the limit for own files is higher)', async () => {
    const t = turn(ownChat)
    const rel = `${P.folderPath}/many`
    for (let i = 0; i < 260; i++) { put(`${rel}/f${i}.txt`); ev(t, 'alice', `${rel}/f${i}.txt`) }
    const { exec, main } = execOf()
    const r = await deleteFilesTool(exec).call({ paths: [rel] }, main)
    expect(r.isError, out(r as never)).toBeUndefined()
    expect(fs.existsSync(abs(rel))).toBe(false)
  })

  test('which refusals own files go past: never a sub-agent, a restricted, template or confidential chat', async () => {
    expect([...OWN_OVERRIDES].sort()).toEqual(['others', 'roomsSeen', 'scheduled', 'shared', 'sharedFile', 'slack'])
    const { rel } = scratchDir('s10')
    const { exec } = execOf({ shared: true })
    const r = await deleteFilesTool(exec).call({ paths: [rel] }, new TurnFiles())
    expect(r.content[0]).toEqual({ type: 'text', text: DELETE_REFUSAL.subagent })
    expect(fs.existsSync(abs(rel))).toBe(true)
  })
})

// QA TC-7338: deleting a personal project left users/<id>/projects/<name>/c.txt on disk. By design
// (docs/DECISIONS.md "Share a personal project": "Deleting a personal project says 'Only the project goes. Its files stay
// in My files › Projects.'"; web projects.deletePersonal): the folder is the person's own, so it stays, and the Files
// screen lists it there. Not a leftover.
describe('deleting a personal project (QA TC-7338)', () => {
  test('only the project goes: its files stay in the person\'s own folder and the Files screen lists them', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Keep Files', scope: 'personal', instructions: '' } })
    expect(p.folderPath.startsWith('users/alice/projects/')).toBe(true)
    fs.writeFileSync(path.join(abs(p.folderPath), 'c.txt'), 'c\n')
    await h.api('alice').call(API.deleteProject, { params: { id: p.id } })
    expect(h.ctx.db.query('SELECT 1 FROM projects WHERE id = ?').get(p.id)).toBeNull()
    expect(fs.existsSync(path.join(abs(p.folderPath), 'c.txt'))).toBe(true)
    const tree = await h.api('alice').call(API.tree, { query: { path: p.folderPath } })
    expect(tree.entries.map((e) => e.name)).toContain('c.txt')
    // nobody else sees it
    expect((await h.api('bob').call(API.tree, { query: { path: p.folderPath } }).then(() => 200, (e: { status: number }) => e.status))).toBe(404)
  })
})
