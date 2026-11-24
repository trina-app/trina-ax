// The dev environment in shared chats (docs/decisions/20261118-devenv-shared-chats.md, QA TC-4848): a team project's
// chat is shared by default, and box_shell is offered there now, fenced so that nothing reaches the other people in the
// chat that they could not open themselves. A fake srt system records each run's settings and environment (real srt
// runs are Linux only: tests/linux, the Docker suite).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { _active, inOldWorkFolder, setSrtSystem, sharedWorkOf, workFolderChange, type SharedRun } from '../../server/src/devenv/srt/runner'
import { chatHome, chatLogs, chatWork, personHome, personLogs, sharedWork, sharedWorkKey, unitName } from '../../server/src/devenv/srt/config'
import { peopleAudience } from '../../server/src/chat/chat-audience'
import type { SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { pollSrt } from '../../server/src/devenv/jobs'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, lockedTopsNote } from '../../server/src/devenv/tool'
import { sharedSection } from '../../server/src/chat/prompt'

setDefaultTimeout(60_000)
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
type Settings = { filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[]; denyWrite: string[] } }
interface FakeRun { spec: SpawnSpec; settings: Settings; state: 'active' | 'gone'; resolve: (v: { code: number | null; signal: string | null }) => void }
const runs = new Map<string, FakeRun>()
const stops: string[] = []
const fake: SrtSystem = {
  spawn(spec) {
    let resolve!: FakeRun['resolve']
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    // the settings file is removed when the run ends: read it now
    runs.set(spec.runId, { spec, settings: JSON.parse(fs.readFileSync(spec.settingsFile, 'utf8')), state: 'active', resolve })
    // (a shared run's command starts with the check of its pinned entries, srt/mounts.ts entryGuard: the AI's command
    // is the last line)
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

let h: Harness, base = '', team = '', P: { id: string; folderPath: string; name: string }
let chat = ''
const ws: Record<string, TestSocket> = {}
const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const last = () => [...runs.values()].at(-1)!
const turnOn = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
/** a SharedRun as the turn makes it (chat/turn.ts): the audience is read each time, the reads are recorded */
function sharedRun(audience: string[], within: string | null, noted: { folders: readonly string[]; audience: readonly string[] }[] = [], ok = true): SharedRun {
  return { within, audience: () => [...audience], noteReads: (folders, a) => { noted.push({ folders, audience: a }); return ok } }
}
const confirms: string[] = []
const shell = (userId: string, shared: SharedRun | undefined, chatId = chat, signal = new AbortController().signal) =>
  boxShellTool({ ctx: h.ctx, project: shared ? (shared.within === null ? null : P) : chatId === chat ? P : null, userId, turnId: 't-' + crypto.randomUUID(), chatId, signal, redact: (s) => s,
    confirm: async (q) => { confirms.push(q); return 'run' }, ...(shared ? { shared } : {}) })
const abs = (rel: string) => path.join(team, rel)
const listCards = async (id: string) => (await h.api('alice').call(API.listTurnRequests, { params: { id } })).items
const fsOf = (r: FakeRun) => r.settings.filesystem
const readable = (r: FakeRun) => [...new Set([...fsOf(r).allowRead, ...fsOf(r).allowWrite])]
/** every path a run's settings name (an entry of any list shows its name in the run) */
const named = (r: FakeRun) => [...fsOf(r).allowRead, ...fsOf(r).allowWrite, ...fsOf(r).denyRead, ...fsOf(r).denyWrite]

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'devenv-shared', askUserTimeoutMs: 2500 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-'))
  team = h.ctx.files.fx.root
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Proj S', participants: [user('alice'), user('bob')], instructions: '' } })
  P = { id: p.id, folderPath: p.folderPath, name: p.name }
  chat = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
  // a folder in the project only alice may open (a limited folder with her rule), and her own folder
  fs.mkdirSync(abs(`${P.folderPath}/secret`), { recursive: true })
  fs.writeFileSync(abs(`${P.folderPath}/secret/s.md`), 'SECRET')
  fs.mkdirSync(abs('users/alice'), { recursive: true })
  const fid = crypto.randomUUID()
  h.ctx.db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, `${P.folderPath}/secret`)
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(crypto.randomUUID(), fid)
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(() => {
  for (const r of runs.values()) if (r.state === 'active') { r.state = 'gone'; r.resolve({ code: null, signal: 'SIGKILL' }) }
  runs.clear(); stops.length = 0; confirms.length = 0; _active().clear()
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  turnOn()
})

describe('a shared project chat', () => {
  test('the chat is shared, and its turn offers box_shell; the instructions no longer say it is not available', async () => {
    expect((h.ctx.db.query('SELECT shared_at FROM chats WHERE id = ?').get(chat) as { shared_at: string | null }).shared_at).not.toBeNull()
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { content: '@fake {"echo":"tools"}', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const done = await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
    expect(done.data.message.content.split(',').map((t: string) => t.replace(/^mcp__team__/, ''))).toContain('box_shell')
    const on = sharedSection({ project: 'Proj S', audience: 2, asker: 'Alice Kim' }, 'en', false, false, false, true)
    const off = sharedSection({ project: 'Proj S', audience: 2, asker: 'Alice Kim' }, 'en')
    expect(off).toContain('the dev environment.')
    expect(on).not.toContain('the dev environment.')
    expect(on).toContain('box_shell commands here see only the team folders everyone in this chat may open inside the project folder')
  })

  test('the site card of a command: bob reads only who it waits for, never the host', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId: P.id } })
    const from = ws.bob!.frames.length
    const r = await h.api('alice').call(API.sendMessage, { params: { id: c.id }, body: { content: '@fake ' + JSON.stringify({ tool: 'box_shell', args: { command: 'echo reached', request_sites: ['site-secret.example.com'] }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    let card: Awaited<ReturnType<typeof listCards>>[number] | undefined
    for (let i = 0; i < 400 && !card; i++) { card = (await listCards(c.id)).find((x) => x.turnId === r.turnId && x.request.kind === 'dev_env_site'); if (!card) await Bun.sleep(25) }
    expect(card?.request).toMatchObject({ kind: 'dev_env_site', host: 'site-secret.example.com' })
    const bobView = await h.api('bob').call(API.getChat, { params: { id: c.id } })
    expect(bobView.waitsFor).toBe('Alice Kim')
    const got = JSON.stringify([bobView, ws.bob!.frames.slice(from).filter((f) => f.type === 'chat.updated' || f.type === 'turn.request')])
    expect(got).not.toContain('site-secret')
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'dev_env_site', requestId: card!.request.requestId, decision: 'deny' } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    expect((await h.api('bob').call(API.getChat, { params: { id: c.id } })).waitsFor).toBeUndefined()
  })

  test('a whole turn: the command runs in the project folder, without what bob cannot open, and the answer records what it may read', async () => {
    const started = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { content: '@fake {"tool":"box_shell","args":{"command":"echo hi"},"sayResult":true}', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const done = await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
    expect(done.data.message.content).toContain('hi')
    const r = last()
    expect(r.spec.cwd).toBe(fs.realpathSync(abs(P.folderPath)))
    // the turn ran it as a shared chat's run: a home of this command in the chat's folder
    expect(r.spec.env.HOME).toBe(path.join(chatHome(base, chat), r.spec.runId))
    // the project folder holds a folder bob may not open: given entry by entry, that folder not even by its name
    // (QA TC-4945, srt/mounts.ts), and the AI is told what it cannot change there
    expect(fsOf(r).allowWrite).not.toContain(abs(P.folderPath))
    expect(named(r).some((p) => p.startsWith(abs(`${P.folderPath}/secret`)))).toBe(false)
    expect(done.data.message.content).toContain(lockedTopsNote([P.folderPath]))
    // the entries given one by one are checked inside the sandbox before the command (QA TC-4945 review)
    expect(r.spec.command.split('\n')[0]).toMatch(/^\/usr\/bin\/xargs -0 \/usr\/bin\/stat -c %d:%i -- < '.+'.*exit 97/)
    expect(r.spec.command.split('\n').pop()).toBe('echo hi')
    expect(r.spec.command).not.toContain('secret')
    expect(readable(r).some((p) => p.startsWith(abs('users')))).toBe(false)
    expect(readable(r).filter((p) => p.startsWith(team + '/')).every((p) => p.startsWith(abs(P.folderPath)))).toBe(true)
    // the answer's record (chat/shared-answers.ts): the project folder, with alice and bob
    const reads = (h.ctx.db.query('SELECT reads FROM shared_answer_reads WHERE message_id = ?').get(started.assistantMessage.id) as { reads: string | null } | null)?.reads ?? ''
    expect(reads).toContain('alice')
    expect(reads).toContain('bob')
  })

  test('alice (writes the project): the restricted folder and her own folder are not in the run; the chat\'s home, not hers', async () => {
    const r0 = await shell('alice', sharedRun(['alice', 'bob'], P.folderPath)).call({ command: 'echo ok' })
    expect(out(r0)).toContain('ok')
    const r = last()
    expect(fsOf(r).allowWrite).not.toContain(abs(P.folderPath))
    expect(named(r).some((p) => p.startsWith(abs(`${P.folderPath}/secret`)))).toBe(false)
    expect(out(r0)).toContain(lockedTopsNote([P.folderPath]))
    expect(readable(r)).not.toContain(abs('users/alice'))
    expect(readable(r)).not.toContain(abs('shared'))
    expect(r.spec.env.HOME).toBe(path.join(chatHome(base, chat), r.spec.runId))
    // the logs folder of the chat's people and their view (config.ts sharedLogs), not of one command
    expect(r.spec.env.TRINA_LOGS!.startsWith(chatLogs(base, chat) + '/')).toBe(true)
    expect(r.spec.env.TRINA_LOGS).not.toContain(r.spec.runId)
    expect(readable(r)).not.toContain(personHome(base, 'alice'))
    expect(readable(r)).not.toContain(personLogs(base, 'alice'))
    expect(Object.values(r.spec.env).some((v) => v.includes(personHome(base, 'alice')))).toBe(false)
    expect(r.spec.stdoutFile.startsWith(chatLogs(base, chat))).toBe(true)
  })

  test('bob (reads the project): read-only, the restricted folder hidden', async () => {
    // bob only reads the project folder while this runs
    const rule = h.ctx.db.query("SELECT r.id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? AND r.subject_type = 'user' AND r.subject_id = 'bob'").get(P.folderPath) as { id: string; access: string }
    h.ctx.db.query("UPDATE folder_rules SET access = 'read' WHERE id = ?").run(rule.id)
    try { await shell('bob', sharedRun(['alice', 'bob'], P.folderPath)).call({ command: 'echo ok' }) } finally { h.ctx.db.query('UPDATE folder_rules SET access = ? WHERE id = ?').run(rule.access, rule.id) }
    const r = last()
    expect(fsOf(r).allowWrite.filter((p) => p.startsWith(team + '/'))).toEqual([])
    // read-only with a folder bob may not open inside: given entry by entry, that folder not even by its name (TC-4929)
    expect(fsOf(r).allowRead.some((p) => p.startsWith(abs(P.folderPath) + '/'))).toBe(true)
    expect([...readable(r), ...fsOf(r).denyRead].some((p) => p.startsWith(abs(`${P.folderPath}/secret`)))).toBe(false)
  })

  test('a cwd in the folder bob may not open is refused with the words of a folder that is not there (QA TC-4945)', async () => {
    const tool = shell('alice', sharedRun(['alice', 'bob'], P.folderPath))
    const n = runs.size
    const hidden = out(await tool.call({ command: 'ls', cwd: 'secret' }))
    const missing = out(await tool.call({ command: 'ls', cwd: 'no-such-folder' }))
    expect(runs.size).toBe(n)
    expect(hidden).toBe(missing)
    expect(hidden).not.toContain('SECRET')
  })

  test('each call reads the audience again: alone in the chat, alice\'s next command sees her restricted folder', async () => {
    const audience = ['alice', 'bob']
    const tool = shell('alice', sharedRun(audience, P.folderPath))
    const one = await tool.call({ command: 'echo 1' })
    expect(named(last()).some((p) => p.startsWith(abs(`${P.folderPath}/secret`)))).toBe(false)
    expect(out(one)).toContain(lockedTopsNote([P.folderPath]))
    audience.splice(1, 1)
    const two = await tool.call({ command: 'echo 2' })
    // alone: the project folder whole again, her folder in it, no note
    expect(fsOf(last()).allowWrite).toContain(abs(P.folderPath))
    expect(fsOf(last()).denyRead).not.toContain(abs(`${P.folderPath}/secret`))
    expect(out(two)).not.toContain('cannot add, rename or delete')
  })

  test('the audience changes while a command runs: the next poll stops it', async () => {
    const audience = ['alice', 'bob']
    const cmd = shell('alice', sharedRun(audience, P.folderPath)).call({ command: 'sleep', timeout_sec: 60 })
    await Bun.sleep(150)
    expect(runs.size).toBe(1)
    await pollSrt(h.ctx)
    expect(last().state).toBe('active')
    // erin joins the chat and cannot open the project: the run's view is no longer the one it started with
    audience.push('erin')
    await pollSrt(h.ctx)
    expect(stops).toHaveLength(1)
    expect(out(await cmd)).toContain('Stopped: the dev environment setting or your access to this folder changed.')
  })

  // review 4: a rule change (here bob taken out of the project) is checked at once through the access hook
  test('the project\'s people change while a command runs: it stops at once, with no wait for the poll', async () => {
    const cmd = shell('alice', sharedRun(['alice', 'bob'], P.folderPath)).call({ command: 'sleep', timeout_sec: 60 })
    await Bun.sleep(150)
    expect(last().state).toBe('active')
    const access = await h.api('dana').call(API.getProjectAccess, { params: { id: P.id } })
    await h.api('dana').call(API.putProjectParticipants, { params: { id: P.id }, body: { participants: [user('alice')], expectedHash: access.rulesHash } })
    try {
      await Bun.sleep(300)
      expect(stops).toHaveLength(1)
      expect(out(await cmd)).toContain('Stopped: the dev environment setting or your access to this folder changed.')
    } finally {
      const a = await h.api('dana').call(API.getProjectAccess, { params: { id: P.id } })
      await h.api('dana').call(API.putProjectParticipants, { params: { id: P.id }, body: { participants: [user('alice'), user('bob')], expectedHash: a.rulesHash } })
    }
  })

  // review 3: the notes go to everyone in the chat
  test('notes name no path in a folder some people here cannot open, and no other person\'s jobs', async () => {
    const at = new Date().toISOString()
    const ev = h.ctx.db.query("INSERT INTO file_events (user_id, path, action, at) VALUES ('dana', ?, 'update', ?)")
    ev.run(`${P.folderPath}/secret/plan-SECRETNAME.md`, at)
    ev.run(`${P.folderPath}/visible-OPENNAME.md`, at)
    h.ctx.db.query("INSERT INTO dev_env_runs (id, user_id, chat_id, project_id, turn_id, kind, name, command, root, cwd, state, started_at) VALUES (?, 'bob', NULL, ?, 't0', 'job', 'bob-PRIVATEJOB', 'x', ?, '', 'running', ?)")
      .run(crypto.randomUUID(), P.id, abs(P.folderPath), at)
    // a file someone saved in the restricted folder between two commands, and one the command's window catches
    const tool = shell('alice', sharedRun(['alice', 'bob'], P.folderPath))
    const first = out(await tool.call({ command: 'echo 1' }))
    expect(first).toContain('visible-OPENNAME.md')
    expect(first).not.toContain('SECRETNAME')
    expect(first).not.toContain('PRIVATEJOB')
    expect(first).not.toMatch(/and \d+ more/)
    fs.writeFileSync(abs(`${P.folderPath}/secret/between-SECRETNAME.md`), 'x')
    fs.writeFileSync(abs(`${P.folderPath}/between-OPENNAME.md`), 'x')
    const second = out(await tool.call({ command: 'echo 2' }))
    expect(second).toContain('between-OPENNAME.md')
    expect(second).not.toContain('SECRETNAME')
    // her own chat (not shared): the same notes name everything, as before
    h.ctx.db.query("DELETE FROM dev_env_runs").run()
  })

  // re-review B: a restricted folder that is no longer on disk (renamed or in the trash) keeps its paths out of the notes
  test('notes: paths in a restricted folder that is gone from the disk are not named', async () => {
    const at = new Date().toISOString()
    // gone-hr: limited to alice, its rules still there, the folder itself moved away
    const fid = crypto.randomUUID()
    h.ctx.db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, `${P.folderPath}/gone-hr`)
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(crypto.randomUUID(), fid)
    const ev = h.ctx.db.query("INSERT INTO file_events (user_id, path, action, at) VALUES ('dana', ?, 'update', ?)")
    ev.run(`${P.folderPath}/gone-hr/pay-RULEDGONE.md`, at)
    // renamed-hr: renamed away, its rules went with it: by the rules alone the old path would be readable
    ev.run(`${P.folderPath}/renamed-hr/pay-RENAMEDGONE.md`, at)
    ev.run(`${P.folderPath}/still-OPENNAME2.md`, at)
    try {
      const first = out(await shell('alice', sharedRun(['alice', 'bob'], P.folderPath)).call({ command: 'echo 1' }))
      expect(first).toContain('still-OPENNAME2.md')
      expect(first).not.toContain('RULEDGONE')
      expect(first).not.toContain('RENAMEDGONE')
    } finally { h.ctx.db.query('DELETE FROM folders WHERE id = ?').run(fid) }
  })

  // review 5: the reason a run is refused names folders (personal ones too): only in the log in a shared chat
  test('refused settings: a generic reason in a shared chat', async () => {
    const id = crypto.randomUUID()
    // a connected folder's source over the projects: every run that reads a project is refused by the settings check
    h.ctx.db.query('INSERT INTO connected_folders (id, name, source) VALUES (?, ?, ?)').run(id, 'nas-test', abs('projects'))
    try {
      const t = out(await shell('alice', sharedRun(['alice', 'bob'], P.folderPath)).call({ command: 'echo x' }))
      expect(t).toContain('refused settings (see the server log)')
      expect(t).not.toContain(team)
      expect(runs.size).toBe(0)
    } finally { h.ctx.db.query('DELETE FROM connected_folders WHERE id = ?').run(id) }
  })

  test('someone who cannot be loaded, or the person no longer in the chat: nothing runs', async () => {
    expect(out(await shell('alice', sharedRun(['alice', 'nobody-here'], P.folderPath)).call({ command: 'echo x' }))).toContain('could not run')
    expect(out(await shell('alice', sharedRun(['bob'], P.folderPath)).call({ command: 'echo x' }))).toContain('could not run')
    expect(runs.size).toBe(0)
  })

  test('the reads are recorded before the run, without the restricted folder; a record that fails stops the run', async () => {
    const noted: { folders: readonly string[]; audience: readonly string[] }[] = []
    await shell('alice', sharedRun(['alice', 'bob'], P.folderPath, noted)).call({ command: 'echo ok' })
    expect(noted).toHaveLength(1)
    expect(noted[0]!.folders).toContain(P.folderPath)
    expect(noted[0]!.folders).not.toContain(`${P.folderPath}/secret`)
    expect([...noted[0]!.audience].sort()).toEqual(['alice', 'bob'])
    runs.clear()
    const r = await shell('alice', sharedRun(['alice', 'bob'], P.folderPath, [], false)).call({ command: 'echo ok' })
    expect(out(r)).toContain('could not run')
    expect(runs.size).toBe(0)
  })

  // jobs and dev servers do run in a shared chat now (dev-env-shared-jobs.test.ts)
  test('no login commands (and no card for them); no job results of the person', async () => {
    const s = sharedRun(['alice', 'bob'], P.folderPath)
    expect(out(await shell('alice', s).call({ command: 'git push origin main' }))).toContain('do not run in a shared chat')
    expect(out(await shell('alice', s).call({ command: 'git push origin main', job: true }))).toContain('do not run in a shared chat')
    expect(confirms).toEqual([])
    expect(runs.size).toBe(0)
    // a job alice ran in her own chat earlier: its result is not told here
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    h.ctx.db.query("INSERT INTO dev_env_runs (id, user_id, chat_id, project_id, turn_id, kind, name, command, root, cwd, state, started_at, ended_at, exit_code, log_tail) VALUES (?, 'alice', ?, NULL, 't0', 'job', 'render', 'x', ?, '', 'ended', ?, ?, 0, 'PRIVATE-JOB-TAIL')")
      .run(crypto.randomUUID(), chat, path.join(base, 'devenv/work', own), new Date().toISOString(), new Date().toISOString())
    expect(out(await shell('alice', s).call({ command: 'echo ok' }))).not.toContain('PRIVATE-JOB-TAIL')
  })

  test('the tool text says what a command sees here', () => {
    const t = shell('alice', sharedRun(['alice', 'bob'], P.folderPath))
    expect(t.description).toContain('This is a shared chat')
    expect(t.description).toContain('not even the person\'s own')
    expect(t.description).not.toContain('person\'s own folder users/<id>')
  })
})

describe('a chat shared with people and groups', () => {
  // QA TC-4929: an empty placeholder of a folder only alice may open named it to everyone in the chat
  test('a folder only one of them may open is not listed at all (no empty placeholder)', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    fs.mkdirSync(abs('shared/hr-ONLYALICE'), { recursive: true }); fs.writeFileSync(abs('shared/hr-ONLYALICE/pay.md'), 'x')
    const fid = crypto.randomUUID()
    h.ctx.db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, 'shared/hr-ONLYALICE')
    h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(crypto.randomUUID(), fid)
    try {
      await shell('alice', sharedRun(['alice', 'bob'], null), c).call({ command: 'echo ls' })
      const r = last()
      const all = [...fsOf(r).allowRead, ...fsOf(r).allowWrite, ...fsOf(r).denyRead, ...fsOf(r).denyWrite]
      expect(all.some((p) => p.includes('hr-ONLYALICE'))).toBe(false)
      // shared/ is given entry by entry: what everyone may read is there
      expect(fsOf(r).allowRead).not.toContain(abs('shared'))
      expect(fsOf(r).allowRead).toContain(abs('shared/glossary.md'))
      // alice's own chat: the folder is hers to read, given as before
      await shell('alice', undefined, c).call({ command: 'echo ls' })
      expect(readable(last()).some((p) => p === abs('shared') || p === abs('shared/hr-ONLYALICE'))).toBe(true)
    } finally {
      h.ctx.db.query('DELETE FROM folders WHERE id = ?').run(fid)
      fs.rmSync(abs('shared/hr-ONLYALICE'), { recursive: true, force: true })
    }
  })

  // QA TC-4928: srt's proxy login (per run) in what a command printed never reaches the AI or the chat
  test('the proxy login a command prints is hidden in its answer', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const t = out(await shell('alice', sharedRun(['alice', 'bob'], null), c).call({ command: 'echo http_proxy=http://srt.ZW52:0f1e2d3c4b5a69788796a5b4c3d2e1f0@localhost:3128 CLOUDSDK_PROXY_PASSWORD=0f1e2d3c4b5a69788796a5b4c3d2e1f0' }))
    expect(t).toContain('http_proxy=http://srt.ZW52:<hidden>@localhost:3128')
    expect(t).not.toContain('0f1e2d3c4b5a69788796a5b4c3d2e1f0')
  })

  test('only the folders everyone in it may open, read-only; the chat\'s work folder is writable', async () => {
    const people = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', sharedRun(['alice', 'bob'], null), people).call({ command: 'echo ok' })
    const r = last()
    const work = sharedWorkOf(h.ctx, people, 'alice', sharedRun(['alice', 'bob'], null))!
    expect(work.startsWith(path.join(base, 'devenv', 'work-shared', people) + '/')).toBe(true)
    expect(r.spec.cwd).toBe(fs.realpathSync(work))
    expect(fsOf(r).allowWrite.filter((p) => p.startsWith(team + '/'))).toEqual([])
    expect(fsOf(r).allowWrite).toContain(work)
    expect(fsOf(r).allowRead).toContain(abs('shared'))
    expect(readable(r)).not.toContain(abs('groups/marketing'))
    expect(readable(r)).not.toContain(abs('groups/finance'))
    expect(readable(r).some((p) => p.startsWith(abs('users')))).toBe(false)
    expect(readable(r)).not.toContain(abs(`${P.folderPath}/secret`))
    expect(r.spec.env.HOME).toBe(path.join(chatHome(base, people), r.spec.runId))
  })

  // review 1: a chat's private work folder may hold copies of the person's own files
  test('a private chat that becomes shared: its private work folder is never mounted in a shared run', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', undefined, c).call({ command: 'echo private' })
    const priv = chatWork(base, c)
    expect(last().spec.cwd).toBe(fs.realpathSync(priv))
    fs.writeFileSync(path.join(priv, 'copy-of-diary.md'), 'PRIVATE')
    await shell('alice', sharedRun(['alice', 'bob'], null), c).call({ command: 'echo shared' })
    const r = last()
    expect(r.spec.cwd).not.toBe(fs.realpathSync(priv))
    expect(r.spec.cwd.startsWith(fs.realpathSync(path.join(base, 'devenv', 'work-shared')))).toBe(true)
    expect(readable(r).some((p) => p === priv || p.startsWith(priv + '/'))).toBe(false)
    expect(fs.existsSync(path.join(r.spec.cwd, 'copy-of-diary.md'))).toBe(false)
  })

  // review 2: what a run left behind must not reach a later, wider audience
  test('a new person in the chat gets an empty work folder; the same people get theirs again', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', sharedRun(['alice'], null), c).call({ command: 'echo 1' })
    const alone = last().spec.cwd
    fs.writeFileSync(path.join(alone, 'from-alice-alone.md'), 'x')
    await shell('alice', sharedRun(['alice', 'bob'], null), c).call({ command: 'echo 2' })
    const both = last().spec.cwd
    expect(both).not.toBe(alone)
    expect(fs.readdirSync(both)).toEqual([])
    await shell('alice', sharedRun(['bob', 'alice'], null), c).call({ command: 'echo 3' })
    expect(last().spec.cwd).toBe(both)
  })

  // QA TC-6936: why a work folder is missing or empty, the same for every spelling of its path
  test('the people changed: fresh before the new folder is made, after once it is; an old folder\'s path is known, never opened', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const alone = sharedRun(['alice'], null), both = sharedRun(['alice', 'bob'], null)
    expect(workFolderChange(h.ctx, { userId: 'alice', chatId: c, shared: alone })).toBeNull()
    await shell('alice', alone, c).call({ command: 'echo 1' })
    const first = last().spec.cwd
    expect(workFolderChange(h.ctx, { userId: 'alice', chatId: c, shared: alone })).toBeNull()
    // bob joined: an earlier folder is there, the new one not yet
    expect(workFolderChange(h.ctx, { userId: 'alice', chatId: c, shared: both })).toBe('fresh')
    expect(inOldWorkFolder(h.ctx, { userId: 'alice', chatId: c, shared: both }, path.join(first, 'in', 'proposal.html'))).toBe(true)
    expect(inOldWorkFolder(h.ctx, { userId: 'alice', chatId: c, shared: alone }, path.join(first, 'in', 'proposal.html'))).toBe(false)
    expect(inOldWorkFolder(h.ctx, { userId: 'alice', chatId: c, shared: both }, '/etc/passwd')).toBe(false)
    await shell('alice', both, c).call({ command: 'echo 2' })
    expect(workFolderChange(h.ctx, { userId: 'alice', chatId: c, shared: both })).toBe('after')
    // a personal chat never says the people changed
    expect(workFolderChange(h.ctx, { userId: 'alice', chatId: c })).toBeNull()
  })

  // re-review A: the same people, but someone's access narrowed: what a run copied while they could read it stays away
  test('the same people, someone\'s access narrowed: an empty work folder', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', sharedRun(['alice', 'bob'], null), c).call({ command: 'echo 1' })
    const before = last().spec.cwd
    fs.writeFileSync(path.join(before, 'copy-from-project.md'), 'x')
    const access = await h.api('dana').call(API.getProjectAccess, { params: { id: P.id } })
    await h.api('dana').call(API.putProjectParticipants, { params: { id: P.id }, body: { participants: [user('alice')], expectedHash: access.rulesHash } })
    try {
      await shell('alice', sharedRun(['alice', 'bob'], null), c).call({ command: 'echo 2' })
      const after = last().spec.cwd
      expect(after).not.toBe(before)
      expect(fs.readdirSync(after)).toEqual([])
    } finally {
      const a = await h.api('dana').call(API.getProjectAccess, { params: { id: P.id } })
      await h.api('dana').call(API.putProjectParticipants, { params: { id: P.id }, body: { participants: [user('alice'), user('bob')], expectedHash: a.rulesHash } })
    }
    // bob back: the folder of that view again
    await shell('alice', sharedRun(['alice', 'bob'], null), c).call({ command: 'echo 3' })
    expect(last().spec.cwd).toBe(before)
  })

  test('the people change between choosing the work folder and the run: nothing runs', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    let n = 0
    const moving: SharedRun = { within: null, audience: () => (n++ === 0 ? ['alice'] : ['alice', 'bob']), noteReads: () => true }
    expect(out(await shell('alice', moving, c).call({ command: 'echo x' }))).toContain('the people of this chat changed')
    expect(runs.size).toBe(0)
  })

  test('the home and temp folder of a shared chat\'s command are its own, and gone when it ends; its logs folder is the chat\'s people\'s', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const tool = shell('alice', sharedRun(['alice', 'bob'], null), c)
    await tool.call({ command: 'echo 1' })
    const first = last().spec
    await tool.call({ command: 'echo 2' })
    const second = last().spec
    expect(second.env.HOME).not.toBe(first.env.HOME)
    expect(second.env.TMPDIR).not.toBe(first.env.TMPDIR)
    for (const sp of [first, second]) {
      expect(fs.existsSync(sp.env.HOME!)).toBe(false)
      expect(fs.existsSync(sp.env.TMPDIR!)).toBe(false)
      // the command's own output files are gone from it
      expect(fs.readdirSync(sp.env.TRINA_LOGS!).filter((f) => f.includes(sp.runId))).toEqual([])
    }
    // the same people: the same logs folder (a job's log there is read by their next command)
    expect(second.env.TRINA_LOGS).toBe(first.env.TRINA_LOGS)
  })

  // review 4: the change is checked at once, not at the next poll
  test('someone is added to the chat while a command runs: it stops at once', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const put = async (ids: string[]) => {
      const subjects = ids.map((id) => ({ subjectType: 'user' as const, subjectId: id }))
      let r = await h.api('alice').call(API.putChatAudience, { params: { id: c }, body: { subjects } })
      if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: c }, body: { subjects, confirmKey: r.confirmKey } })
      expect(r.status).toBe('saved')
    }
    await put(['bob'])
    const live: SharedRun = { within: null, audience: () => peopleAudience(h.ctx.db, { id: c, user_id: 'alice' }), noteReads: () => true }
    const cmd = shell('alice', live, c).call({ command: 'sleep', timeout_sec: 60 })
    await Bun.sleep(150)
    expect(last().state).toBe('active')
    await put(['bob', 'erin'])
    await Bun.sleep(300)
    expect(stops).toHaveLength(1)
    expect(out(await cmd)).toContain('Stopped: the dev environment setting or your access to this folder changed.')
  })
})
