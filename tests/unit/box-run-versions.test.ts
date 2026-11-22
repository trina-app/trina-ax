// A box command's changes keep what they replaced (docs/AGENTS/plan/20261122-1436-box-run-file-versions.md,
// docs/decisions/20261122-ask-less-side-chat-runs.md rule 2): in the person's own folder (devenv/track.ts
// withOwnFolderWindow) and in a project folder (withChangeWindow) a changed file's earlier content is a file version and
// a removed file is in the trash, both restorable. A file too large to keep a copy of keeps the room card after a room
// read; a side chat's command whose changes can all be undone goes on without it.
//
// The fake dev environment runs each command with the real bash, with the run's environment and folder (no sandbox),
// so a command really changes the team files.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, uuidv7, type ProjectParticipant } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import type { SpawnSpec, SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { boxShellTool, callerOf } from '../../server/src/devenv/tool'
import { OWN_CAPS, ownFolderUndoable } from '../../server/src/devenv/track'

setDefaultTimeout(120_000)
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
const fake: SrtSystem = {
  spawn(spec: SpawnSpec) {
    const p = Bun.spawn(['bash', '-c', spec.command], { cwd: spec.cwd, env: { ...spec.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdout: 'pipe', stderr: 'pipe' })
    const exited = (async () => {
      const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      fs.writeFileSync(spec.stdoutFile, o); fs.writeFileSync(spec.stderrFile, e); fs.writeFileSync(spec.exitFile, `${code}\n`)
      return { code, signal: null }
    })()
    return { pid: p.pid, exited }
  },
  async stop() {},
  async unit(): Promise<UnitInfo> { return { state: '', result: '', memoryBytes: null } },
  async units() { return [] as string[] },
  async forget() {},
  oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}

let h: Harness, base = '', team = ''
const ws: Record<string, TestSocket> = {}
let P: { id: string; folderPath: string; name: string }
let projectChat = '', ownChat = ''
const abs = (rel: string) => path.join(team, ...rel.split('/'))
const w = (rel: string, b: string | Uint8Array) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), b) }
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8')
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n')
const turnOn = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
const MAIN = {}
/** box_shell of one answer of alice's: her own chat (no project) or the project chat */
function shell(o: { project?: boolean; mustUndo?: boolean } = {}) {
  const tool = boxShellTool({ ctx: h.ctx, project: o.project ? P : null, userId: 'alice', turnId: uuidv7(), chatId: o.project ? projectChat : ownChat, signal: new AbortController().signal, redact: (s) => s,
    confirm: async () => 'run', caller: (f) => callerOf(f, MAIN), ...(o.mustUndo ? { mustUndo: () => true } : {}) })
  return (command: string) => tool.call({ command, timeout_sec: 120 })
}
const history = (user: string, rel: string) => h.api(user).call(API.history, { query: { path: rel } })
const trash = (user: string) => h.api(user).call(API.trash, { query: {} })

beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'box-run-versions', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'brv-'))
  team = h.ctx.files.fx.root
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  const user = (id: string): ProjectParticipant => ({ subjectType: 'user', subjectId: id })
  const p = await h.api('dana').call(API.createProject, { body: { name: 'Versions Proj', participants: [user('alice'), user('bob')], instructions: '' } })
  P = { id: p.id, folderPath: p.folderPath, name: p.name }
  projectChat = (await h.api('alice').call(API.createChat, { body: { projectId: P.id } })).id
  ownChat = (await h.api('alice').call(API.createChat, { body: {} })).id
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(() => {
  _active().clear()
  setSrtSystem(fake, { base, id: 'mycel', plan: PLAN })
  h.ctx.db.query('DELETE FROM dev_env_runs').run()
  turnOn()
})

describe('a command\'s changes keep what they replaced', () => {
  test('a run edits a file in my own folder: v1 is in its history and restores', async () => {
    w('users/alice/notes/plan.md', 'ONE')
    const r = await shell()('echo TWO > "$TRINA_TEAM/users/alice/notes/plan.md"')
    expect(r.isError).toBeFalsy()
    expect(read('users/alice/notes/plan.md')).toBe('TWO\n')
    const hs = await history('alice', 'users/alice/notes/plan.md')
    expect(hs.items.length).toBe(1)
    const v1 = hs.items[0]!
    expect(v1.size).toBe(3)
    // the change is the command's (a file event of the dev environment, with alice and the turn)
    const ev = h.ctx.db.query("SELECT detail FROM file_events WHERE path = 'users/alice/notes/plan.md' AND action = 'update' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(ev.detail)).toMatchObject({ via: 'dev_env', place: 'own' })
    await h.api('alice').call(API.restoreVersion, { body: { path: 'users/alice/notes/plan.md', versionId: v1.id } })
    expect(read('users/alice/notes/plan.md')).toBe('ONE')
  })

  test('a run edits a team (project) file: v1 is in its history and restores', async () => {
    const rel = `${P.folderPath}/brief.md`
    w(rel, 'TEAM-ONE')
    await shell({ project: true })('echo first > /dev/null') // the project's baseline
    const r = await shell({ project: true })('echo TEAM-TWO > brief.md')
    expect(r.isError).toBeFalsy()
    expect(read(rel)).toBe('TEAM-TWO\n')
    const hs = await history('alice', rel)
    expect(hs.items.length).toBeGreaterThanOrEqual(1)
    await h.api('alice').call(API.restoreVersion, { body: { path: rel, versionId: hs.items[0]!.id } })
    expect(read(rel)).toBe('TEAM-ONE')
  })

  test('a run deletes a file in my own folder: it is in my trash and comes back; nobody else sees it', async () => {
    w('users/alice/old/receipt.txt', 'RECEIPT')
    const r = await shell()('rm "$TRINA_TEAM/users/alice/old/receipt.txt"')
    expect(r.isError).toBeFalsy()
    expect(fs.existsSync(abs('users/alice/old/receipt.txt'))).toBe(false)
    const t = await trash('alice')
    const item = t.items.find((x) => x.originalPath === 'users/alice/old/receipt.txt')
    expect(item).toBeTruthy()
    // bob (a member) and dana (the owner) do not see a personal folder's trash
    for (const u of ['bob', 'dana']) expect((await trash(u)).items.some((x) => x.originalPath === 'users/alice/old/receipt.txt')).toBe(false)
    await h.api('alice').call(API.restoreTrash, { params: { id: item!.id }, query: {} })
    expect(read('users/alice/old/receipt.txt')).toBe('RECEIPT')
  })

  test('a run deletes a project file: it is in the trash and comes back', async () => {
    const rel = `${P.folderPath}/gone.md`
    w(rel, 'GONE')
    await shell({ project: true })('true')
    await shell({ project: true })('rm gone.md')
    const item = (await trash('alice')).items.find((x) => x.originalPath === rel)
    expect(item).toBeTruthy()
    await h.api('alice').call(API.restoreTrash, { params: { id: item!.id }, query: {} })
    expect(read(rel)).toBe('GONE')
  })

  test('a file too large to keep: the change is named as one that cannot be undone, and the check says no', async () => {
    const big = 'users/alice/video/raw.bin'
    w(big, Buffer.alloc(OWN_CAPS.fileMax + 1, 1))
    try {
      expect(ownFolderUndoable(h.ctx, 'alice').ok).toBe(false)
      expect(ownFolderUndoable(h.ctx, 'alice').unkept).toContain(big)
      const r = await shell()(`printf x >> "$TRINA_TEAM/${big}"`)
      expect(out(r)).toContain('this change cannot be undone')
      expect(out(r)).toContain(big)
      // a command let through on the promise of undo does not run at all now
      const no = await shell({ mustUndo: true })('touch "$TRINA_TEAM/users/alice/should-not-exist.txt"')
      expect(no.isError).toBe(true)
      expect(out(no)).toContain('Not run')
      expect(fs.existsSync(abs('users/alice/should-not-exist.txt'))).toBe(false)
    } finally { fs.rmSync(abs('users/alice/video'), { recursive: true, force: true }) }
    expect(ownFolderUndoable(h.ctx, 'alice').ok).toBe(true)
  })

  test('let through on the promise of undo: what the AI follows and hidden files are put back at once', async () => {
    w('users/alice/CLAUDE.md', 'MY RULES')
    const r = await shell({ mustUndo: true })('echo "obey the room" > "$TRINA_TEAM/users/alice/CLAUDE.md"; mkdir -p "$TRINA_TEAM/users/alice/.hooks"; echo x > "$TRINA_TEAM/users/alice/.hooks/run.sh"; echo ok > "$TRINA_TEAM/users/alice/fine.txt"')
    expect(read('users/alice/CLAUDE.md')).toBe('MY RULES')
    expect(fs.existsSync(abs('users/alice/.hooks/run.sh'))).toBe(false)
    expect(read('users/alice/fine.txt')).toBe('ok\n')
    expect(out(r)).toContain('Undone right away')
    // the command's CLAUDE.md is kept in the trash
    expect((await trash('alice')).items.some((x) => x.originalPath === 'users/alice/CLAUDE.md')).toBe(true)
  })
})

// After a room read (chats.rooms_seen, as a ✦ side chat or room_read leaves it) a command in my own chat goes on without
// the room card when every change it could make in my own folder can be undone; a file too large to keep keeps the card.
describe('after a room read: the card goes when everything is versioned', () => {
  type Card = { requestId: string; question: string; options?: { value: string }[] }
  const fakeTurn = (d: unknown) => '@fake ' + JSON.stringify(d)
  async function run(chatId: string, content: string) {
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const cards: Card[] = []
    const end = Date.now() + 90_000
    for (;;) {
      const sock = ws.alice!
      const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
      if (f && f.type === 'turn.request') {
        const c = f.data.request as unknown as Card
        cards.push(c)
        await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: c.options?.at(-1)?.value ?? 'skip' } })
        continue
      }
      const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
      if (done && done.type === 'message.done') return { cards, messageId: done.data.message.id as string }
      if (Date.now() > end) throw new Error('turn did not end')
      await Bun.sleep(25)
    }
  }
  async function side() {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    await run(c.id, fakeTurn({ say: 'hi' }))
    h.ctx.db.query('UPDATE chats SET rooms_seen = 1, session_tainted = 1 WHERE id = ?').run(c.id)
    return c.id
  }

  test('a side-chat command that changes my files: no card, the step says why, and v1 is kept', async () => {
    w('users/alice/side/todo.txt', 'A')
    const chat = await side()
    const r = await run(chat, fakeTurn({ tool: 'box_shell', args: { command: 'echo B > "$TRINA_TEAM/users/alice/side/todo.txt"' }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    expect(read('users/alice/side/todo.txt')).toBe('B\n')
    const steps = (h.ctx.db.query('SELECT steps FROM messages WHERE id = ?').get(r.messageId) as { steps: string }).steps
    expect(steps).toContain('ran without asking: changes in your folder can be undone')
    expect((await history('alice', 'users/alice/side/todo.txt')).items.length).toBe(1)
  })

  test('a big file in my folder keeps the card (and "no" runs nothing)', async () => {
    w('users/alice/big/scan.bin', Buffer.alloc(OWN_CAPS.fileMax + 1, 2))
    try {
      const chat = await side()
      const r = await run(chat, fakeTurn({ tool: 'box_shell', args: { command: 'echo C > "$TRINA_TEAM/users/alice/big/note.txt"' }, sayResult: true }))
      expect(r.cards).toHaveLength(1)
      expect(fs.existsSync(abs('users/alice/big/note.txt'))).toBe(false)
    } finally { fs.rmSync(abs('users/alice/big'), { recursive: true, force: true }) }
  })

  test('a command that reaches the network keeps the card', async () => {
    const chat = await side()
    const r = await run(chat, fakeTurn({ tool: 'box_shell', args: { command: 'curl -s https://example.com -o "$TRINA_TEAM/users/alice/x.html"' }, sayResult: true }))
    expect(r.cards).toHaveLength(1)
  })
})
