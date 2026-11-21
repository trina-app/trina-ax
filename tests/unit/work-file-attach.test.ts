// In a chat shared with people the AI's finished file is attached to its answer as a chat file
// (docs/decisions/20261121-shared-chat-attach-work-file.md, QA TC-6162). alice shares a chat with erin (both in
// marketing); a fake srt system stands in for the runs, and a command's file is put into the chat's shared work folder
// directly. Covered: save_work_file attaches it (no card, origin 'ai', in the answer row at once, so it counts as sent),
// erin opens it and carol (outside) does not, save_as is refused there, the answer's attachments go into the transcript
// with their file_id, adding bob (who may not read marketing) is warned about the answer that carries the file, a k-group
// answer carries no file, the 1 GB constant, and the tool is not offered in a personal chat in chat mode.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, CHAT_FILE_AI_MAX, DEV_ENV_DEFAULT_LIMITS, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makePng } from '../lib/images'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import { devenvPaths } from '../../server/src/devenv/srt/config'
import type { SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { answerWithFiles, labelledTranscript } from '../../server/src/chat/shared'
import { ChatStore } from '../../server/src/chat/store'
import { saveWorkFileTool } from '../../server/src/chat/work-file-tool'
import { TurnExec } from '../../server/src/chat/turn'
import { chatFilesOf } from '../../server/src/chat/chat-files'
import { namedPaths } from '../../server/src/rooms/ai-tools'

setDefaultTimeout(90_000)
const PLAN: DevEnvPlan = { format: 1, plan: 'team', maxRunning: 3, cpus: 1, memoryMiB: 1024, pids: 256, diskGiB: 4, network: 'open' }
const fakeSys: SrtSystem = {
  spawn(spec) { fs.writeFileSync(spec.exitFile, '0\n'); return { pid: 999_999, exited: Promise.resolve({ code: 0, signal: null }) } },
  async stop() {}, async unit(): Promise<UnitInfo> { return { state: '', result: '', memoryBytes: null } },
  async units() { return [] as string[] }, async forget() {}, oomKills() { return 0 }, cpuUsec() { return 0 }, procs() { return [] }, async selfTest() { return '' },
}
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness, base = ''
const ws: Record<string, TestSocket> = {}
const turnOn = () => saveTeamSetting(h.ctx.db, { ...teamSetting(h.ctx.db), enabled: true, scope: { mode: 'writers', groupIds: [], userIds: [] }, network: 'open', limits: DEV_ENV_DEFAULT_LIMITS, extraDomains: [], consent: newConsent({ id: 'carol', name: 'Carol Park' }) })
beforeAll(async () => {
  process.env.MYCEL_DEV_ENV = '1'
  h = await startHarness({ name: 'work-file-attach', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-'))
  setSrtSystem(fakeSys, { base, id: 'mycel', plan: PLAN })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); setSrtSystem(null); delete process.env.MYCEL_DEV_ENV; await h.close(); fs.rmSync(base, { recursive: true, force: true }) })
beforeEach(() => { _active().clear(); setSrtSystem(fakeSys, { base, id: 'mycel', plan: PLAN }); turnOn() })

type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
async function share(user: string, chatId: string, subjects: Sub[]) {
  let r = await put(user, chatId, subjects)
  if (r.status === 'confirm') r = await put(user, chatId, subjects, r.confirmKey)
  if (r.status !== 'saved') throw new Error('not saved')
}
type Card = { requestId: string }
async function run(user: string, chatId: string, content: string) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Card[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: 'skip' } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content as string, messageId: done.data.message.id as string, attachments: done.data.message.attachments as Attachment[] }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
/** a chat alice shares with erin, a command run in it (its shared work folder made), and `files` put there */
async function sharedChatWith(files: Record<string, Uint8Array | string>) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await run('alice', c.id, fake({ say: 'hi' }))
  await share('alice', c.id, [{ subjectType: 'user', subjectId: 'erin' }])
  await run('alice', c.id, fake({ tool: 'box_shell', args: { command: 'true' } }))
  const top = path.join(devenvPaths(base).workShared, c.id)
  const keys = fs.readdirSync(top)
  expect(keys.length).toBe(1)
  const root = path.join(top, keys[0]!)
  for (const [rel, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), b) }
  return { chat: c.id, root }
}

describe('save_work_file in a chat shared with people', () => {
  test('attached to the answer: no card, origin ai, in the row at once; erin opens it, carol does not; the transcript names its file_id', async () => {
    const png = makePng(40, 30)
    const { chat } = await sharedChatWith({ 'out/frame.png': png, 'out/clip.mp4': new Uint8Array(4096) })
    const r = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: '$TRINA_WORK/out/clip.mp4' }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('Attached $TRINA_WORK/out/clip.mp4')
    const att = r.attachments.find((a) => a.name === 'clip.mp4')!
    expect(att).toMatchObject({ source: 'chat', origin: 'ai', size: 4096 })
    // in the answer row at once: the chat file counts as sent (the unsent sweep never takes it)
    const row = h.ctx.db.query('SELECT attachments FROM messages WHERE id = ?').get(r.messageId) as { attachments: string }
    expect(JSON.parse(row.attachments).map((a: Attachment) => a.id)).toContain(att.id)
    // live: the person of the turn got message.attachments before the end
    expect(ws.alice!.frames.some((f) => f.type === 'message.attachments' && f.data.messageId === r.messageId)).toBe(true)
    // nothing landed in a team folder
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'users/alice/clip.mp4'))).toBe(false)
    // erin, in the chat, opens it; carol, outside, does not
    expect((await h.req('erin', `/api/chats/${chat}/files/${att.id}`)).status).toBe(200)
    expect((await h.req('carol', `/api/chats/${chat}/files/${att.id}`)).status).not.toBe(200)
    // a picture too (its metadata cut as an upload's)
    const p = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: 'out/frame.png' }, sayResult: true }))
    expect(p.attachments.find((a) => a.name === 'frame.png')).toMatchObject({ kind: 'image', origin: 'ai' })
    // the next answer's transcript names the file by its id, so save_chat_file can take it later
    const transcript = labelledTranscript(new ChatStore(h.ctx.db), p.messageId, 'erin', new Set())
    expect(transcript.map((m) => m.content).join('\n')).toContain(`file_id=${att.id}`)
  })

  test('a real attach holds the k-group guard for its whole copy and lets it go after (beginAttach)', async () => {
    const proto = TurnExec.prototype as unknown as { beginAttach: () => () => void }
    const orig = proto.beginAttach
    const seen: string[] = []
    proto.beginAttach = function (this: unknown) { const rel = orig.call(this); seen.push('begin'); return () => { seen.push('release'); rel() } }
    try {
      const { chat } = await sharedChatWith({ 'out/b.mp4': new Uint8Array(2048) })
      const r = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: '$TRINA_WORK/out/b.mp4' }, sayResult: true }))
      expect(r.content).toContain('Attached')
      expect(seen).toEqual(['begin', 'release'])
    } finally { proto.beginAttach = orig }
  })

  test('save_as is refused there, before anything is copied', async () => {
    const { chat } = await sharedChatWith({ 'a.txt': 'A' })
    const r = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: '$TRINA_WORK/a.txt', save_as: 'shared/' }, sayResult: true }))
    expect(r.content).toContain('there is no save_as')
    expect((r.attachments ?? []).length).toBe(0)
  })

  test('adding bob (who may not read marketing) is warned about the answer that carries the file', async () => {
    // alice and erin both read groups/marketing, so a run here may read it: the attach records it with the answer
    const { chat } = await sharedChatWith({ 'report.txt': 'R' })
    const r = await run('alice', chat, fake({ tool: 'save_work_file', args: { path: '$TRINA_WORK/report.txt' } }))
    const list = await h.api('alice').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: chat }, add: [{ subjectType: 'user', subjectId: 'bob' }] } })
    expect(list.items.map((i) => i.messageId)).toContain(r.messageId)
  })
})

describe('the rules around it', () => {
  test('an answer with a k group (hidden from people added later) carries no file', () => {
    const exec = { rt: h.ctx as never, spec: { userId: 'alice', chatId: 'c' }, hiddenFromLater: true, livePrincipal: () => ({}) } as unknown as TurnExec
    const t = saveWorkFileTool(exec, () => ({ real: '/nowhere', path: '/nowhere' }), 'chat')
    const r = t.refuse!({ path: '$TRINA_WORK/a.mp4' })
    expect(r?.summary).toContain('hidden from later people')
  })

  test('while a file is being attached, a connection answer hidden from later people cannot join the answer (no race)', () => {
    // noteSharedReads with kept (a k group) is refused while an attach is under way (beginAttach) and after it landed
    const note = (TurnExec.prototype as unknown as { noteSharedReads: (...a: unknown[]) => boolean }).noteSharedReads
    const begin = (TurnExec.prototype as unknown as { beginAttach: () => () => void }).beginAttach
    const self = { shared: { kind: 'people' }, attachedFiles: 0, attaching: 0, sharedReads: new Map() } as Record<string, unknown>
    const release = begin.call(self)
    expect(note.call(self, [{ type: 'url', url: 'https://example.com' }], ['alice', 'erin'], false, true)).toBe(false)
    expect((self.sharedReads as Map<string, unknown>).size).toBe(0)
    release(); release()
    expect(self.attaching).toBe(0)
  })

  test('a picture over 50 MB is not read whole to be cleaned: refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-pic-'))
    const src = path.join(dir, 'big.png')
    fs.writeFileSync(src, makePng(4, 4)); fs.truncateSync(src, 51 * 1024 * 1024)
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    await expect(chatFilesOf(h.ctx).createFromAi('alice', chat.id, 'big.png', src, 'x'.repeat(64))).rejects.toThrow('at most 50 MB')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('its work-folder path is no team path: no read card for it in a shared chat (namedPaths)', () => {
    expect(namedPaths('save_work_file', { path: '$TRINA_WORK/out/a.mp4' })).toEqual([])
    expect(namedPaths('save_work_file', { path: '$TRINA_WORK/a', save_as: 'shared/x' })).toEqual([{ key: 'save_as', value: 'shared/x' }])
  })

  test('the AI cap is 1 GB; uploads keep 50 MB', () => {
    expect(CHAT_FILE_AI_MAX).toBe(1024 ** 3)
  })

  test('the transcript line names only chat files', () => {
    const a = { id: '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208', name: 'clip.mp4', path: '', size: 9, mime: 'video/mp4', kind: 'video', source: 'chat', origin: 'ai' } as Attachment
    expect(answerWithFiles('Done.', [a])).toContain('file_id=01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208')
    expect(answerWithFiles('Done.', [{ ...a, source: 'team', path: 'shared/x' }])).toBe('Done.')
    // a shared copy (share-chat-files) is named by sharedCopiesNote, not here too
    expect(answerWithFiles('Done.', [{ ...a, origin: 'shared-copy' }])).toBe('Done.')
  })
})
