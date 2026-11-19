// Jobs and dev servers in shared chats, and a chat's commands reaching its own dev server
// (docs/decisions/20261118-devenv-shared-jobs-mac-localhost.md, QA TC-4989, TC-4990). A fake srt system records each
// run's settings and environment; real srt runs are Linux only (tests/linux/srt-attack.ts, the Docker suite) and the
// Mac's Seatbelt rules are checked in dev-env-srt-mac.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { _active, bridgeWait, previewAllowed, reachTargets, runsOf, setSrtSystem, sharedLogKey, spaceOf, type SharedRun } from '../../server/src/devenv/srt/runner'
import { chatHome, chatLogs, personLogs, runIdOfUnit, sharedLogs, unitName } from '../../server/src/devenv/srt/config'
import type { Forwarder, SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { pollSrt } from '../../server/src/devenv/jobs'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, sharedShellDescription, srtShellDescription } from '../../server/src/devenv/tool'
import { sharedChatResolver } from '../../server/src/devenv/shared-chat'
import { peopleAudience } from '../../server/src/chat/chat-audience'

setDefaultTimeout(60_000)
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
type Settings = { filesystem: { allowRead: string[]; allowWrite: string[]; denyRead: string[]; denyWrite: string[] } }
interface FakeRun { spec: SpawnSpec; settings: Settings; state: 'active' | 'gone'; resolve: (v: { code: number | null; signal: string | null }) => void }
const runs = new Map<string, FakeRun>()
const stops: string[] = []
const forwards: { runId: string; port: number; socket: string }[] = []
const bridges: { runId: string; port: number; socket: string; stopped: boolean }[] = []
const end = (r: FakeRun, code: number | null) => { if (r.state === 'gone') return; r.state = 'gone'; if (code !== null) fs.writeFileSync(r.spec.exitFile, `${code}\n`); r.resolve({ code, signal: code === null ? 'SIGTERM' : null }) }
const base0: SrtSystem = {
  spawn(spec) {
    let resolve!: FakeRun['resolve']
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { resolve = r })
    const r: FakeRun = { spec, settings: JSON.parse(fs.readFileSync(spec.settingsFile, 'utf8')), state: 'active', resolve }
    runs.set(spec.runId, r)
    // "echo X": prints X and ends at once (a bridge-wait start and the entry-guard first line, srt/mounts.ts, are
    // skipped); anything else runs on
    const m = /(?:^|; )echo (.*)$/.exec(spec.command.split('\n').pop()!)
    if (m) queueMicrotask(() => { fs.appendFileSync(spec.stdoutFile, m[1] + '\n'); end(r, 0) })
    return { pid: 999_999, exited }
  },
  async stop(runId) { stops.push(runId); const r = runs.get(runId); if (r) end(r, null) },
  async unit(runId): Promise<UnitInfo> { const r = runs.get(runId); return !r || r.state === 'gone' ? { state: '', result: '', memoryBytes: null } : { state: 'active', result: '', memoryBytes: 50 << 20 } },
  async units() { return [...runs.entries()].filter(([, r]) => r.state !== 'gone').map(([id]) => unitName(id)) },
  async forget(runId) { const r = runs.get(runId); if (r) r.state = 'gone' },
  oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}
const fakeForwarder = (socket: string, onStop?: () => void): Forwarder => { let done!: () => void; const exited = new Promise<void>((r) => { done = r }); return { socket, stop: () => { onStop?.(); done() }, exited } }
/** Linux with the sandbox helper: preview forwarders and bridges */
const linux: SrtSystem = {
  ...base0,
  forward: async (o) => { forwards.push(o); return fakeForwarder(o.socket) },
  bridge: async (o) => { const b = { ...o, stopped: false }; bridges.push(b); return fakeForwarder(o.socket, () => { b.stopped = true }) },
}
/** a Mac team server: each run's port is its slot's */
const macPorts = new Map<string, number>()
const mac: SrtSystem & { slotOf(id: string): { account: string; port: number } | null } = {
  ...base0,
  spawn(spec) { macPorts.set(spec.runId, 47901 + macPorts.size); return base0.spawn(spec) },
  slotOf(id) { const p = macPorts.get(id); return p && runs.get(id)?.state === 'active' ? { account: '_axdev1', port: p } : null },
}

let h: Harness, base = '', team = '', P: { id: string; folderPath: string; name: string }
let chat = ''
const ws: Record<string, TestSocket> = {}
const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const last = () => [...runs.values()].at(-1)!
const abs = (rel: string) => path.join(team, rel)
const readable = (r: FakeRun) => [...new Set([...r.settings.filesystem.allowRead, ...r.settings.filesystem.allowWrite])]
const turnOn = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
/** the chat's SharedRun as a turn makes it: who sees the chat now from the database, the reads recorded */
function live(chatId: string, noted: { folders: readonly string[]; audience: readonly string[] }[] = []): SharedRun {
  const r = sharedChatResolver(h.ctx, chatId)!
  return { within: r.within, audience: r.audience, noteReads: (folders, a) => { noted.push({ folders, audience: a }); return true } }
}
const shell = (userId: string, shared: SharedRun | undefined, chatId = chat, project: typeof P | null = P) =>
  boxShellTool({ ctx: h.ctx, project, userId, turnId: 't-' + crypto.randomUUID(), chatId, signal: new AbortController().signal, redact: (s) => s,
    confirm: async () => 'run', ...(shared ? { shared } : {}) })
type Row = { id: string; user_id: string; state: string; shared_key: string; access: string; unit: string; end_reason: string | null; ended_at: string | null; name: string; port: number | null }
const rows = () => h.ctx.db.query('SELECT id, user_id, state, shared_key, access, unit, end_reason, ended_at, name, port FROM dev_env_runs ORDER BY started_at, id').all() as Row[]
const setParticipants = async (ids: string[]) => {
  const access = await h.api('dana').call(API.getProjectAccess, { params: { id: P.id } })
  await h.api('dana').call(API.putProjectParticipants, { params: { id: P.id }, body: { participants: ids.map(user), expectedHash: access.rulesHash } })
}

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'devenv-shared-jobs', askUserTimeoutMs: 2500 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsj-'))
  team = h.ctx.files.fx.root
  setSrtSystem(linux, { base, id: 'mycel', plan: PLAN })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Proj J', participants: [user('alice'), user('bob')], instructions: '' } })
  P = { id: p.id, folderPath: p.folderPath, name: p.name }
  chat = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
  // a folder in the project only alice may open
  fs.mkdirSync(abs(`${P.folderPath}/secret`), { recursive: true })
  fs.writeFileSync(abs(`${P.folderPath}/secret/s.md`), 'SECRET')
  const fid = crypto.randomUUID()
  h.ctx.db.query('INSERT INTO folders (id, path, limited) VALUES (?, ?, 1)').run(fid, `${P.folderPath}/secret`)
  h.ctx.db.query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES (?, ?, 'user', 'alice', 'write')").run(crypto.randomUUID(), fid)
})
afterAll(async () => {
  // the last test's runs end too: their folder holds (srt/placeholders.ts) must not outlive this file
  for (const r of runs.values()) end(r, null)
  await pollSrt(h.ctx)
  await new Promise((r) => setTimeout(r, 50))
  for (const s of Object.values(ws)) s.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(async () => {
  for (const r of runs.values()) end(r, null)
  runs.clear(); stops.length = 0; forwards.length = 0; bridges.length = 0; macPorts.clear(); _active().clear()
  setSrtSystem(linux, { base, id: 'mycel', plan: PLAN })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  turnOn()
})

describe('jobs in a shared project chat (QA TC-4989)', () => {
  test('a job runs with the shared chat\'s fence; its row remembers the chat\'s people; reads are recorded first', async () => {
    const noted: { folders: readonly string[]; audience: readonly string[] }[] = []
    const t = out(await shell('alice', live(chat, noted)).call({ command: 'echo built', job: true, log_name: 'build' }))
    expect(t).toContain('Started as job build')
    const r = last()
    // the same fence as a command there: the project folder, without what bob cannot open, nothing personal
    // (the project folder holds a folder bob may not open: given entry by entry, that folder not even by its name, and
    // the entries are checked inside the sandbox first, as for a command: QA TC-4945, srt/mounts.ts)
    const fsx = r.settings.filesystem as { allowRead: string[]; allowWrite: string[]; denyRead: string[]; denyWrite?: string[] }
    expect(fsx.allowWrite).not.toContain(abs(P.folderPath))
    expect([...fsx.allowRead, ...fsx.allowWrite, ...fsx.denyRead, ...(fsx.denyWrite ?? [])].some((p) => p.startsWith(abs(`${P.folderPath}/secret`)))).toBe(false)
    expect(r.spec.command.split('\n')[0]).toMatch(/^\/usr\/bin\/xargs -0 \/usr\/bin\/stat -c %d:%i -- < '.+'.*exit 97/)
    expect(readable(r).some((p) => p.startsWith(abs('users')))).toBe(false)
    expect(readable(r)).not.toContain(personLogs(base, 'alice'))
    expect(r.spec.env.HOME).toBe(path.join(chatHome(base, chat), r.spec.runId))
    const [row] = rows()
    expect(row!.shared_key).toMatch(/^[0-9a-f]{32}$/)
    expect(row!.access).not.toBe('')
    // its log is the chat's for these people, never alice's
    expect(r.spec.env.TRINA_LOGS).toBe(sharedLogs(base, chat, row!.shared_key))
    expect(r.spec.stdoutFile).toBe(path.join(sharedLogs(base, chat, row!.shared_key), 'build.log'))
    // the answer's record: what it may read, with everyone who sees the chat
    expect(noted.length).toBeGreaterThan(0)
    expect([...noted[0]!.audience].sort()).toEqual([...live(chat).audience()].sort())
    expect(noted[0]!.folders.some((f) => f.includes('secret'))).toBe(false)
    // it ends: the home and temp folder of its run go, the log stays for the chat's next commands
    await pollSrt(h.ctx)
    expect(rows()[0]!.ended_at).not.toBeNull()
    expect(fs.existsSync(r.spec.env.HOME!)).toBe(false)
    expect(fs.existsSync(r.spec.env.TMPDIR!)).toBe(false)
    expect(fs.readFileSync(r.spec.stdoutFile, 'utf8')).toBe('built\n')
  })

  test('the result goes to the next call in the chat, whoever makes it, once; never to alice\'s own chat', async () => {
    await shell('alice', live(chat)).call({ command: 'sleep', job: true, log_name: 'r1' })
    const job = last()
    fs.appendFileSync(job.spec.stdoutFile, 'RESULT-TEXT\n')
    end(job, 0)
    await pollSrt(h.ctx)
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    expect(out(await shell('alice', undefined, own, null).call({ command: 'echo mine' }))).not.toContain('RESULT-TEXT')
    const noted: { folders: readonly string[]; audience: readonly string[] }[] = []
    const b = out(await shell('bob', live(chat, noted)).call({ command: 'echo next' }))
    expect(b).toContain('Job r1 ended with exit code 0.')
    expect(b).toContain('RESULT-TEXT')
    expect(noted.length).toBeGreaterThan(0)
    expect(out(await shell('bob', live(chat)).call({ command: 'echo again' }))).not.toContain('RESULT-TEXT')
  })

  test('a later command of the same people reads the job\'s log in $TRINA_LOGS; the project page shows no log line of it', async () => {
    await shell('alice', live(chat)).call({ command: 'sleep', job: true, log_name: 'long' })
    const job = last()
    await shell('bob', live(chat)).call({ command: 'echo tail' })
    const cmd = last()
    expect(cmd.spec.env.TRINA_LOGS).toBe(job.spec.env.TRINA_LOGS)
    expect(readable(cmd)).toContain(job.spec.env.TRINA_LOGS)
    h.ctx.db.query("UPDATE dev_env_runs SET last_line = 'LINE-FROM-THE-LOG' WHERE name = 'long'").run()
    const page = await runsOf(h.ctx, { projectId: P.id })
    expect(page.running.find((x) => x.name === 'long')!.lastLine).toBe('')
    const mine = await runsOf(h.ctx, { userId: 'alice' })
    expect(mine.running.find((x) => x.name === 'long')!.lastLine).toBe('LINE-FROM-THE-LOG')
    // a second job with that log name in this chat: refused (one log folder for the chat's people)
    expect(out(await shell('bob', live(chat)).call({ command: 'sleep', job: true, log_name: 'long' }))).toContain('still runs in this chat')
  })

  test('someone joins who cannot open what the job sees: it stops at once; its result and log are not given to the new audience', async () => {
    await shell('alice', live(chat)).call({ command: 'sleep', job: true, log_name: 'j2' })
    const job = last()
    await pollSrt(h.ctx)
    expect(job.state).toBe('active')
    // erin joins the project: the chat's people change
    await setParticipants(['alice', 'bob', 'erin'])
    try {
      await Bun.sleep(300)
      expect(stops).toContain(job.spec.runId)
      const r = rows().find((x) => x.name === 'j2')!
      expect(r.end_reason).toBe('setting')
      fs.writeFileSync(path.join(job.spec.env.TRINA_LOGS!, 'j2.log'), 'OLD-AUDIENCE-LOG\n')
      const t = out(await shell('alice', live(chat)).call({ command: 'echo now' }))
      expect(t).not.toContain('j2')
      // another key: another, empty logs folder
      expect(last().spec.env.TRINA_LOGS).not.toBe(job.spec.env.TRINA_LOGS)
      expect(readable(last())).not.toContain(job.spec.env.TRINA_LOGS)
    } finally { await setParticipants(['alice', 'bob']) }
  })

  test('the person who started it leaves the project: it stops', async () => {
    await shell('alice', live(chat)).call({ command: 'sleep', job: true, log_name: 'j3' })
    const job = last()
    await setParticipants(['bob'])
    try {
      await Bun.sleep(300)
      expect(stops).toContain(job.spec.runId)
      expect(rows().find((x) => x.name === 'j3')!.end_reason).toBe('setting')
    } finally { await setParticipants(['alice', 'bob']) }
  })

  test('a job that waited in the queue while the chat\'s people changed does not start', async () => {
    setSrtSystem(linux, { base, id: 'mycel', plan: { ...PLAN, maxRunning: 1 } })
    await shell('alice', live(chat)).call({ command: 'sleep', job: true, log_name: 'first' })
    expect(out(await shell('alice', live(chat)).call({ command: 'echo second', job: true, log_name: 'second' }))).toContain('Queued as job second')
    const spawned = runs.size
    await setParticipants(['alice', 'bob', 'erin'])
    try {
      await Bun.sleep(300)
      await pollSrt(h.ctx)
      // the first stopped (the people changed), the second never started
      expect(runs.size).toBe(spawned)
      expect(rows().find((x) => x.name === 'second')!.end_reason).toBe('setting')
    } finally { await setParticipants(['alice', 'bob']) }
  })

  test('a row whose chat is no longer shared stops', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
    await shell('alice', live(c), c).call({ command: 'sleep', job: true, log_name: 'j4' })
    const job = last()
    h.ctx.db.query('UPDATE chats SET shared_at = NULL WHERE id = ?').run(c)
    await pollSrt(h.ctx)
    expect(stops).toContain(job.spec.runId)
  })

  test('the tool text: jobs and dev servers run here, with the same folders', () => {
    const d = sharedShellDescription(true)
    expect(d).toContain('Jobs and dev servers run here too, with the same folders')
    expect(d).not.toContain('job and background are refused')
    expect(d).toContain('job=true')
  })
})

describe('dev servers in shared chats (QA TC-4989)', () => {
  test('a shared chat\'s dev server: everyone in the chat may open its preview, nobody else; a person\'s own: only them', async () => {
    const t = out(await shell('alice', live(chat)).call({ command: 'sleep', background: true, port: 3000, log_name: 'web' }))
    expect(t).toContain('Started in the background')
    const row = rows().find((x) => x.name === 'web')!
    expect(row.port).toBe(3000)
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'alice' })).not.toBeNull()
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'bob' })).not.toBeNull()
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'erin' })).toBeNull()
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'carol' })).toBeNull()
    // through the route: erin gets not found
    await expect(h.api('erin').call(API.previewMyDevEnvRun, { params: { runId: row.id }, body: { port: 3000 } })).rejects.toMatchObject({ status: 404 })
    // bob (in the chat) gets past the check: this fake server has no preview origin, so the answer is "not set up"
    await expect(h.api('bob').call(API.previewMyDevEnvRun, { params: { runId: row.id }, body: { port: 3000 } })).rejects.toMatchObject({ status: 409 })
    // alice's own chat's dev server: bob may not open it
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', undefined, own, null).call({ command: 'sleep', background: true, port: 3001, log_name: 'own' })
    const mine = rows().find((x) => x.name === 'own')!
    expect(previewAllowed(h.ctx, { rowId: mine.id, userId: 'bob' })).toBeNull()
    expect(previewAllowed(h.ctx, { rowId: mine.id, userId: 'alice' })).not.toBeNull()
  })

  // security review of #1336: the logs key counts reads and writes alike, so a person who may only read the project
  // must not reach or preview (and so drive) the dev server of one who may write it
  test('a person who may only read the project neither reaches nor previews a writer\'s dev server; the logs key is the same', async () => {
    await shell('alice', live(chat)).call({ command: 'sleep', background: true, port: 3000, log_name: 'wr' })
    const row = rows().find((x) => x.name === 'wr')!
    const rule = h.ctx.db.query("SELECT r.id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = ? AND r.subject_type = 'user' AND r.subject_id = 'bob'").get(P.folderPath) as { id: string; access: string }
    h.ctx.db.query("UPDATE folder_rules SET access = 'read' WHERE id = ?").run(rule.id)
    try {
      const bob = spaceOf(h.ctx, { userId: 'bob', chatId: chat, project: { id: P.id, folderPath: P.folderPath }, shared: live(chat) })!
      // the same people and view for the logs and results
      expect(sharedLogKey(h.ctx, bob)).toBe(row.shared_key)
      expect(reachTargets(h.ctx, bob)).toEqual([])
      expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'bob' })).toBeNull()
      // the writer who started it still may
      const alice = spaceOf(h.ctx, { userId: 'alice', chatId: chat, project: { id: P.id, folderPath: P.folderPath }, shared: live(chat) })!
      expect(reachTargets(h.ctx, alice).map((t) => t.name)).toEqual(['wr'])
      expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'alice' })).not.toBeNull()
    } finally { h.ctx.db.query('UPDATE folder_rules SET access = ? WHERE id = ?').run(rule.access, rule.id) }
  })

  test('preview fails closed once the row\'s key or access hash is no longer the one of now', async () => {
    await shell('alice', live(chat)).call({ command: 'sleep', background: true, port: 3000, log_name: 'stale' })
    const row = rows().find((x) => x.name === 'stale')!
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'bob' })).not.toBeNull()
    h.ctx.db.query("UPDATE dev_env_runs SET shared_key = ? WHERE id = ?").run('0'.repeat(32), row.id)
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'bob' })).toBeNull()
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'alice' })).toBeNull()
    h.ctx.db.query("UPDATE dev_env_runs SET shared_key = ?, access = 'other' WHERE id = ?").run(row.shared_key, row.id)
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'alice' })).toBeNull()
  })

  test('a chat shared with people and groups: a dev server in its shared work folder; someone added stops it', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const put = async (ids: string[]) => {
      const subjects = ids.map((id) => ({ subjectType: 'user' as const, subjectId: id }))
      let r = await h.api('alice').call(API.putChatAudience, { params: { id: c }, body: { subjects } })
      if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: c }, body: { subjects, confirmKey: r.confirmKey } })
      expect(r.status).toBe('saved')
    }
    await put(['bob'])
    expect(peopleAudience(h.ctx.db, { id: c, user_id: 'alice' }).sort()).toEqual(['alice', 'bob'])
    await shell('alice', live(c), c, null).call({ command: 'sleep', background: true, port: 3000, log_name: 'pweb' })
    const srv = last()
    expect(srv.spec.cwd.startsWith(fs.realpathSync(path.join(base, 'devenv', 'work-shared', c)))).toBe(true)
    const row = rows().find((x) => x.name === 'pweb')!
    expect(previewAllowed(h.ctx, { rowId: row.id, userId: 'bob' })).not.toBeNull()
    await put(['bob', 'erin'])
    await Bun.sleep(300)
    expect(stops).toContain(srv.spec.runId)
  })
})

describe('a chat\'s commands reach its own dev server (QA TC-4990)', () => {
  test('Linux: a later command reaches the chat\'s dev server through a bridge, at the port named; nothing of another chat or person', async () => {
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', undefined, own, null).call({ command: 'sleep', background: true, port: 3000, log_name: 'srv' })
    const srv = last()
    // bob's chat and another chat of alice's: their commands reach nothing
    const other = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', undefined, other, null).call({ command: 'echo other' })
    const bobs = (await h.api('bob').call(API.createChat, { body: {} })).id
    await shell('bob', undefined, bobs, null).call({ command: 'echo bob' })
    await Bun.sleep(50)
    expect(bridges).toEqual([])
    // the same chat: the note names it, the command waits for the bridge, the bridge goes into the new run
    const t = out(await shell('alice', undefined, own, null).call({ command: 'echo curl' }))
    expect(t).toContain('This command can reach the running dev server of this chat: srv (a dev server) at localhost:3000.')
    const cmd = last()
    expect(cmd.spec.command.startsWith(bridgeWait([3000]))).toBe(true)
    await Bun.sleep(50)
    expect(forwards).toEqual([{ runId: srv.spec.runId, port: 3000, socket: expect.stringContaining(srv.spec.runId) }])
    expect(bridges).toHaveLength(1)
    expect(bridges[0]).toMatchObject({ runId: cmd.spec.runId, port: 3000, socket: forwards[0]!.socket })
    // the command ended: its bridge is stopped
    expect(bridges[0]!.stopped).toBe(true)
  })

  test('Linux: a dev server from before the person\'s access narrowed is not reached; a shared chat\'s rows are not a private run\'s', async () => {
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', undefined, own, null).call({ command: 'sleep', background: true, port: 3000, log_name: 'old' })
    h.ctx.db.query("UPDATE dev_env_runs SET access = 'a-wider-view' WHERE name = 'old'").run()
    const sp = spaceOf(h.ctx, { userId: 'alice', chatId: own, project: null })!
    expect(reachTargets(h.ctx, sp)).toEqual([])
    // the shared project chat: alice's shared dev server is reached by bob's command there (same people, same view)
    await shell('alice', live(chat)).call({ command: 'sleep', background: true, port: 5173, log_name: 'vite' })
    const shared = spaceOf(h.ctx, { userId: 'bob', chatId: chat, project: { id: P.id, folderPath: P.folderPath }, shared: live(chat) })!
    expect(reachTargets(h.ctx, shared).map((x) => [x.name, x.port])).toEqual([['vite', 5173]])
    // a person's private run in that folder (a project chat that is not shared) reaches no shared row
    const priv = spaceOf(h.ctx, { userId: 'alice', chatId: chat, project: { id: P.id, folderPath: P.folderPath } })!
    expect(reachTargets(h.ctx, priv)).toEqual([])
    // a different audience: another key, nothing reached
    const wider: SharedRun = { ...live(chat), audience: () => [...live(chat).audience(), 'erin'] }
    const sw = { ...shared, shared: wider }
    expect(sharedLogKey(h.ctx, sw)).not.toBe(sharedLogKey(h.ctx, shared))
    expect(reachTargets(h.ctx, sw)).toEqual([])
  })

  test('macOS: the dev server listens on its own $PORT; a later command of the chat may connect to it, no other', async () => {
    setSrtSystem(mac, { base, id: 'mycel', plan: PLAN, platform: 'darwin' })
    expect(srtShellDescription(false)).toContain('later box_shell commands in this chat reach the dev server at localhost:<that port>')
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    const s = out(await shell('alice', undefined, own, null).call({ command: 'sleep', background: true, log_name: 'next' }))
    const srv = last()
    const port = macPorts.get(srv.spec.runId)!
    expect(s).toContain(`listening on $PORT, which is ${port}`)
    expect(s).toContain(`reach it at localhost:${port}`)
    const t = out(await shell('alice', undefined, own, null).call({ command: 'echo curl' }))
    expect(t).toContain(`at localhost:${port}`)
    expect(last().spec.reach).toEqual([{ runId: srv.spec.runId, port }])
    // macOS needs no bridge and no wait
    expect(last().spec.command).toBe('echo curl')
    // another chat of alice's: nothing
    const other = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', undefined, other, null).call({ command: 'echo x' })
    expect(last().spec.reach).toBeUndefined()
    // the dev server stopped: nothing to reach
    end(srv, null)
    await pollSrt(h.ctx)
    await shell('alice', undefined, own, null).call({ command: 'echo y' })
    expect(last().spec.reach).toBeUndefined()
  })

  test('runIdOfUnit of a row names the run the reach target says', async () => {
    const own = (await h.api('alice').call(API.createChat, { body: {} })).id
    await shell('alice', undefined, own, null).call({ command: 'sleep', background: true, port: 4000, log_name: 'u' })
    const row = rows().find((x) => x.name === 'u')!
    const sp = spaceOf(h.ctx, { userId: 'alice', chatId: own, project: null })!
    expect(reachTargets(h.ctx, sp)).toEqual([{ rowId: row.id, runId: runIdOfUnit(row.unit), name: 'u', kind: 'server', port: 4000 }])
    expect(chatLogs(base, own)).toBeTruthy()
  })
})
