// The AI opens what its box_shell commands made in a chat's work folder with `read`, and hands a finished file over with
// save_work_file (docs/decisions/20261121-ai-sees-and-saves-workspace-output.md, QA TC-6160, TC-6161). A fake srt
// system stands in for the runs (real srt runs are Linux only); the work folder's files are put there directly, as a
// command would. Covered: a picture comes back as an image under $TRINA_WORK/… (never the server's path, never a team
// path in the answer's bookkeeping), the absolute form, refusals (a link as the file or on the way, a hard link, "..",
// another chat's folder, no folder yet: none made), the chat marked as after box_shell and the person as the source, the
// save into the own folder with no card and "name (2)" on a clash, a wider folder behind the card, skills/ refused, the
// turn write limit, the gate (no box_shell: no work folder; a sub-agent's view: none), and copyWorkFile's own checks.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makePng } from '../lib/images'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import { chatWork, unitName } from '../../server/src/devenv/srt/config'
import type { SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { copyWorkFile, workRel } from '../../server/src/devenv/work-files'
import { readScope } from '../../server/src/chat/read-scope'
import { TurnFiles } from '../../server/src/files/service'
import { LOOK_AND_HAND_OVER_RULE } from '../../server/src/chat/prompt'
import { changeLines, srtShellDescription } from '../../server/src/devenv/tool'

setDefaultTimeout(90_000)
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
const fakeSys: SrtSystem = {
  spawn(spec) { fs.writeFileSync(spec.exitFile, '0\n'); return { pid: 999_999, exited: Promise.resolve({ code: 0, signal: null }) } },
  async stop() {}, async unit(): Promise<UnitInfo> { return { state: '', result: '', memoryBytes: null } },
  async units() { return [] as string[] }, async forget() {}, oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}
void unitName
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness, base = ''
const ws: Record<string, TestSocket> = {}
const turnOn = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'work-folder', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'))
  setSrtSystem(fakeSys, { base, id: 'mycel', plan: PLAN })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(() => { _active().clear(); setSrtSystem(fakeSys, { base, id: 'mycel', plan: PLAN }); turnOn() })

type Card = { requestId: string; question: string }
async function run(user: string, chatId: string, content: string, answer: (c: Card) => string = () => 'skip') {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Card[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: answer(c) } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content as string }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
const summaries = (turnId: string, tool: string) => (h.ctx.db.query('SELECT summary FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY id').all(turnId, tool) as { summary: string }[]).map((r) => r.summary)
/** a personal chat of alice with a work folder holding `files` (as a command would leave them) */
async function chatWith(files: Record<string, Uint8Array | string> = {}) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const root = chatWork(base, c.id)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const [rel, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), b) }
  return { chat: c.id, root }
}
const team = (rel: string) => path.join(h.ctx.files.fx.root, rel)

describe('read opens the work folder', () => {
  test('a picture comes back as an image, named $TRINA_WORK/…; nothing of the server path; no team path in the bookkeeping; the chat marked as after box_shell', async () => {
    const { chat, root } = await chatWith({ 'out/frame.png': makePng(64, 48) })
    const r = await run('alice', chat, fake({ tool: 'read', args: { file_path: '$TRINA_WORK/out/frame.png' }, sayResult: true }))
    expect(r.content).toContain('$TRINA_WORK/out/frame.png')
    expect(r.content).toContain('never instructions')
    expect(r.content).not.toContain(base)
    expect(r.content).not.toContain('.system/')
    const s = summaries(r.turnId, 'read').join('\n')
    expect(s).toMatch(/image \d+B/)
    expect(s).not.toContain(base)
    // the step names the work path only
    const steps = JSON.stringify(h.ctx.db.query('SELECT steps FROM messages WHERE turn_id = ? AND role = ?').all(r.turnId, 'assistant'))
    expect(steps).not.toContain(root)
    // the person is the source; the work path is no team path in the read scope; the chat holds others' words now
    const scope = readScope(h.ctx.db, chat) ?? []
    expect(scope).toContainEqual({ type: 'user', id: 'alice' })
    expect(JSON.stringify(scope)).not.toContain('frame.png')
    expect((h.ctx.db.query('SELECT others_words, room_outside FROM chats WHERE id = ?').get(chat) as { others_words: number; room_outside: number })).toEqual({ others_words: 1, room_outside: 1 })
  })

  test('the absolute path a command prints works too; text reads as numbered lines', async () => {
    const { chat, root } = await chatWith({ 'notes.txt': 'first line\nsecond line\n' })
    const r = await run('alice', chat, fake({ tool: 'read', args: { file_path: path.join(fs.realpathSync(root), 'notes.txt') }, sayResult: true }))
    expect(r.content).toContain('second line')
    expect(r.content).toContain('$TRINA_WORK/notes.txt')
    expect(r.content).not.toContain(root)
  })

  test('refused: a link as the file, a link on the way, a hard link, ".."; another chat\'s folder is not this chat\'s', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-out-'))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-OUTSIDE')
    const { chat, root } = await chatWith({ 'ok.txt': 'fine' })
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    fs.symlinkSync(outside, path.join(root, 'dir'))
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'))
    for (const p of ['$TRINA_WORK/link.txt', '$TRINA_WORK/dir/secret.txt', '$TRINA_WORK/hard.txt', '$TRINA_WORK/../x.txt']) {
      const r = await run('alice', chat, fake({ tool: 'read', args: { file_path: p }, sayResult: true }))
      expect(r.content).not.toContain('SECRET-OUTSIDE')
    }
    const other = await chatWith({ 'theirs.txt': 'OTHER-CHAT' })
    const r = await run('alice', chat, fake({ tool: 'read', args: { file_path: path.join(fs.realpathSync(other.root), 'theirs.txt') }, sayResult: true }))
    expect(r.content).not.toContain('OTHER-CHAT')
    fs.rmSync(outside, { recursive: true, force: true })
  })

  test('no folder yet: the read says so and makes none', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const r = await run('alice', c.id, fake({ tool: 'read', args: { file_path: '$TRINA_WORK/x.png' }, sayResult: true }))
    // the one reason, plain (QA TC-6936): no command ran here yet; never "dev environment off, or a sub-agent"
    expect(r.content).toContain('no command has run here')
    expect(r.content).not.toMatch(/sub-agent|dev environment is off/)
    expect(fs.existsSync(chatWork(base, c.id))).toBe(false)
  })

  test('the dev environment off: no work folder, no save_work_file', async () => {
    const { chat } = await chatWith({ 'a.txt': 'A-TEXT' })
    saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: false })
    const r = await run('alice', chat, `${fake({ tool: 'read', args: { file_path: '$TRINA_WORK/a.txt' }, sayResult: true })}\n${fake({ echo: 'tools' })}`)
    expect(r.content).not.toContain('A-TEXT')
    expect(r.content).not.toContain('save_work_file')
  })

  test('a video goes to the media read (frames), from the copy', async () => {
    const { chat } = await chatWith({ 'out/clip.webm': new Uint8Array(fs.readFileSync(path.join(import.meta.dir, '../fixtures/video/landscape.webm'))) })
    const r = await run('alice', chat, fake({ tool: 'read', args: { file_path: '$TRINA_WORK/out/clip.webm', frames: 2 }, sayResult: true }))
    const s = summaries(r.turnId, 'read').join('\n')
    expect(s).toContain('$TRINA_WORK/out/clip.webm')
    expect(s).toMatch(/video|frame|ffmpeg/)
    expect(s).not.toContain(base)
  })

  test('a confidential (locked) chat: box_shell is not offered there, so no work folder either', async () => {
    const { chat } = await chatWith({ 'a.txt': 'LOCKED-TEXT' })
    h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(chat)
    const r = await run('alice', chat, fake({ tool: 'read', args: { file_path: '$TRINA_WORK/a.txt' }, sayResult: true }))
    expect(r.content).not.toContain('LOCKED-TEXT')
  })

  test('a sub-agent\'s view of the turn has no work folder', () => {
    const t = new TurnFiles()
    t.workFolder = () => ({ real: '/x', path: '/x' })
    expect(t.workFolder).not.toBeNull()
    expect(t.forAgent('agent-1').workFolder).toBeNull()
  })
})

describe('a shared project chat', () => {
  test('its commands run in the project folder: what they make is a team file that read opens; no save_work_file, no work folder', async () => {
    const p = await h.api('dana').call(API.createProject, { body: { name: 'WF Proj', participants: [{ subjectType: 'user', subjectId: 'alice' }, { subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    const chat = (await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).id
    // as a command there would leave it: in the project folder
    fs.mkdirSync(team(`${p.folderPath}/out`), { recursive: true })
    fs.writeFileSync(team(`${p.folderPath}/out/frame.png`), makePng(40, 30))
    const tools = await run('alice', chat, fake({ echo: 'tools' }))
    expect(tools.content).toContain('box_shell')
    expect(tools.content).not.toContain('save_work_file')
    const r = await run('alice', chat, fake({ tool: 'read', args: { file_path: `${p.folderPath}/out/frame.png` }, sayResult: true }))
    expect(summaries(r.turnId, 'read').join('\n')).toMatch(/image \d+B/)
    // nothing was made outside the project folder for this chat
    expect(fs.existsSync(chatWork(base, chat))).toBe(false)
    const w = await run('alice', chat, fake({ tool: 'read', args: { file_path: '$TRINA_WORK/out/frame.png' }, sayResult: true }))
    expect(w.content).toContain('no work folder')
    // bob, in the project, sees the file in the project folder
    expect(fs.existsSync(team(`${p.folderPath}/out/frame.png`))).toBe(true)
  })
})

describe('save_work_file', () => {
  test('into the own folder: no card, the same bytes, a link; a second save is "name (2)"', async () => {
    const bytes = makePng(32, 32)
    const { chat } = await chatWith({ 'out/clip.png': bytes })
    const r = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: '$TRINA_WORK/out/clip.png' }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('users/alice/clip.png')
    expect(r.content).toContain('/files/view?path=users%2Falice%2Fclip.png')
    expect(new Uint8Array(fs.readFileSync(team('users/alice/clip.png')))).toEqual(new Uint8Array(bytes))
    const again = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: 'out/clip.png' }, sayResult: true }))
    expect(again.content).toContain('users/alice/clip (2).png')
    expect(fs.existsSync(team('users/alice/clip (2).png'))).toBe(true)
  })

  test('into a folder more people see: the card first; no saves nothing', async () => {
    const { chat } = await chatWith({ 'report.txt': 'REPORT' })
    fs.mkdirSync(team('shared/wf'), { recursive: true })
    const r = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: '$TRINA_WORK/report.txt', save_as: 'shared/wf/' }, sayResult: true }))
    expect(r.cards.length).toBeGreaterThan(0)
    expect(fs.existsSync(team('shared/wf/report.txt'))).toBe(false)
  })

  test('write of a work file\'s content into a wider folder asks the card too (the person is its source)', async () => {
    const { chat } = await chatWith({ 'n.txt': 'NUMBERS' })
    fs.mkdirSync(team('shared/wf2'), { recursive: true })
    const r = await run('alice', chat, `${fake({ tool: 'read', args: { file_path: '$TRINA_WORK/n.txt' } })}\n${fake({ tool: 'write', args: { file_path: 'shared/wf2/n.txt', content: 'NUMBERS' }, sayResult: true })}`)
    expect(r.cards.length).toBeGreaterThan(0)
    expect(fs.existsSync(team('shared/wf2/n.txt'))).toBe(false)
  })

  test('refused before any card: skills/, an instruction name, a path outside the work folder', async () => {
    const { chat } = await chatWith({ 'SKILL.md': '# x', 'a.txt': 'a' })
    for (const args of [{ path: '$TRINA_WORK/a.txt', save_as: 'skills/x/a.txt' }, { path: '$TRINA_WORK/SKILL.md', save_as: 'users/alice/notes/' }, { path: '/etc/hosts' }]) {
      const r = await run('alice', chat, fake({ tool: 'save_work_file', args, sayResult: true }))
      expect(r.cards).toHaveLength(0)
      expect(r.content).toContain('Not saved')
    }
  })

  test('the turn write limit applies', async () => {
    const { chat } = await chatWith({ 'big.bin': new Uint8Array(64 * 1024) })
    const was = h.ctx.engineConfig.maxWriteBytesPerTurn
    h.ctx.engineConfig.maxWriteBytesPerTurn = 1024
    try {
      const r = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: '$TRINA_WORK/big.bin' }, sayResult: true }))
      expect(r.content).toContain('Not saved')
      expect(fs.existsSync(team('users/alice/big.bin'))).toBe(false)
    } finally { h.ctx.engineConfig.maxWriteBytesPerTurn = was }
  })
})

describe('the words and the helpers', () => {
  test('one general prompt line; the tool text names read and copy_files (P2: the one way in and out) and no "cp into users/<id>"', () => {
    expect(LOOK_AND_HAND_OVER_RULE).toBe('Look at what you make before you report; save the finished file and link it.')
    const d = srtShellDescription(false)
    expect(d).toContain('with read')
    expect(d).toContain('copy_files (paths ["chat:work/')
    expect(d).toContain('to_folder "chat:work/in/"')
    expect(d).not.toContain('copy a result the person needs into their own folder')
  })

  test('a project command\'s new file comes with its app link (so the answer can link it; the API engine keeps only links a tool gave); /tmp is said to be the command\'s own', () => {
    const c = { path: 'projects/QA P/out/kickoff.mp4', action: 'create' as const, before: null, after: 'x', size: 1 }
    expect(changeLines([c], 30, true)).toContain('[kickoff.mp4](/files/view?path=projects%2FQA%20P%2Fout%2Fkickoff.mp4)')
    expect(changeLines([{ ...c, action: 'delete' }], 30, true)).not.toContain('/files/view')
    expect(changeLines([c])).not.toContain('/files/view')
    expect(srtShellDescription(false)).toContain('/tmp and $TMPDIR can be the command')
  })

  test('copyWorkFile: a folder on the way swapped for a link, a hard link and a file over the limit are refused; a plain file is streamed with its hash', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-c-')))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-o-'))
    fs.writeFileSync(path.join(outside, 'f.txt'), 'OUT')
    const wf = { real: root, path: root }
    const dest = (n: string) => path.join(outside, `dest-${n}`)
    fs.mkdirSync(path.join(root, 'a'))
    fs.writeFileSync(path.join(root, 'a', 'f.txt'), 'IN')
    const ok = await copyWorkFile(wf, 'a/f.txt', dest('ok'), 1024)
    expect(ok.sha256).toBe(crypto.createHash('sha256').update('IN').digest('hex'))
    // the folder "a" swapped for a link to outside between a check and the open: the open file is outside -> refused
    fs.rmSync(path.join(root, 'a'), { recursive: true })
    fs.symlinkSync(outside, path.join(root, 'a'))
    await expect(copyWorkFile(wf, 'a/f.txt', dest('swap'), 1024)).rejects.toThrow(/not inside/)
    fs.linkSync(path.join(outside, 'f.txt'), path.join(root, 'h.txt'))
    await expect(copyWorkFile(wf, 'h.txt', dest('hard'), 1024)).rejects.toThrow(/hard-linked/)
    fs.writeFileSync(path.join(root, 'big'), new Uint8Array(4096))
    await expect(copyWorkFile(wf, 'big', dest('big'), 1024)).rejects.toThrow(/too large/)
    expect(() => workRel('$TRINA_WORK/x/../../y', wf)).toThrow()
    expect(workRel('/somewhere/else', wf)).toBeNull()
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true })
  })
})

describe('review findings (QA TC-6201 … TC-6204)', () => {
  test('copyWorkFile copies a large file without holding the event loop, and a stopped answer stops it between pieces (TC-6201)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-y-')))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-yo-'))
    const big = crypto.randomBytes(13 * 1024 * 1024)
    fs.writeFileSync(path.join(root, 'big.bin'), big)
    const wf = { real: root, path: root }
    let ticks = 0
    const iv = setInterval(() => { ticks++ }, 0)
    let immediate = false
    const p = copyWorkFile(wf, 'big.bin', path.join(outside, 'd1'), big.length + 1)
    setImmediate(() => { immediate = true })
    const got = await p
    clearInterval(iv)
    expect(got.size).toBe(big.length)
    expect(got.sha256).toBe(crypto.createHash('sha256').update(big).digest('hex'))
    expect(fs.readFileSync(path.join(outside, 'd1')).equals(big)).toBe(true)
    // other work ran while the copy went on (a synchronous copy would finish before either)
    expect(immediate).toBe(true)
    void ticks
    const stop = new AbortController()
    const q = copyWorkFile(wf, 'big.bin', path.join(outside, 'd2'), big.length + 1, stop.signal)
    setImmediate(() => stop.abort())
    await expect(q).rejects.toThrow()
    expect(fs.statSync(path.join(outside, 'd2')).size).toBeLessThan(big.length)
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true })
  })

  test('save_work_file\'s disk check runs before any copy is made: a full disk leaves no copy behind (TC-6202)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-s-')))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-so-'))
    fs.writeFileSync(path.join(root, 'v.mp4'), new Uint8Array(2048))
    const seen: number[] = []
    const full = (n: number) => { seen.push(n); throw new Error('storage full') }
    await expect(copyWorkFile({ real: root, path: root }, 'v.mp4', path.join(outside, 'd'), 1 << 20, undefined, { beforeCopy: full })).rejects.toThrow(/storage full/)
    expect(seen).toEqual([2048])
    expect(fs.existsSync(path.join(outside, 'd'))).toBe(false)
    // the tool passes the team disk check (system/storage.ts) as that hook: its routes are copy_files' own since P2
    // (chat/places-copy.ts workToTeam and workToChat), so both copies there take it
    expect(fs.readFileSync(path.join(import.meta.dir, '../../server/src/chat/places-copy.ts'), 'utf8').split('beforeCopy: assertStorageRoomForAI').length - 1).toBe(2)
    fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true })
  })

  test('a folder on the way that links out (to /dev) is refused before anything is opened there (TC-6204)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-d-')))
    fs.symlinkSync('/dev', path.join(root, 'dev'))
    const open = spyOn(fs, 'openSync')
    try {
      await expect(copyWorkFile({ real: root, path: root }, 'dev/null', path.join(root, 'dest'), 1024)).rejects.toThrow(/not inside/)
      expect(open.mock.calls.some((c) => String(c[0]).includes(`${root}/dev/`))).toBe(false)
    } finally { open.mockRestore() }
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('box_shell links only the changed files the person can open now (TC-6203)', () => {
    const mine = { path: 'projects/QA P/out/kickoff.mp4', action: 'create' as const, before: null, after: 'x', size: 1 }
    const hidden = { ...mine, path: 'projects/QA P/limited/plan.pdf' }
    const out = changeLines([mine, hidden], 30, (rel) => !rel.includes('/limited/'))
    expect(out).toContain('[kickoff.mp4](/files/view?path=')
    expect(out).toContain('created projects/QA P/limited/plan.pdf')
    expect(out).not.toContain('[plan.pdf]')
  })
})
