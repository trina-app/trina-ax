// Chat places P3 (docs/AGENTS/plan/20261121-0652-places-outputs.md): the produce tools write `output: chat:files/<name>`
// (attached to the answer through #200's entry), a document's pictures resolve through the place its source is in, and
// the chat file's link /c/<chat>?file=<id> is the one the tools give and the API engine's link guard keeps. alice shares
// a chat with erin (both in marketing); a fake srt system stands in for the runs, and a command's file is put into the
// chat's shared work folder directly (as tests/unit/work-file-attach.test.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API, DEV_ENV_DEFAULT_LIMITS, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makePng } from '../lib/images'
import { _active, setSrtSystem } from '../../server/src/devenv/srt/runner'
import { devenvPaths } from '../../server/src/devenv/srt/config'
import { NO_WORK_WORDS } from '../../server/src/devenv/work-files'
import type { SrtSystem, UnitInfo } from '../../server/src/devenv/srt/system'
import type { DevEnvPlan } from '../../server/src/devenv/srt/plan'
import { newConsent, saveTeamSetting, teamSetting } from '../../server/src/devenv/setting'
import { TurnFiles, type ToolCtx } from '../../server/src/files/service'
import { attachProduced, authorizeOutput, chatLinksInText, chatOutput, placeRef, type ChatPlaces } from '../../server/src/files/place-output'
import { PLACE_WORDS, type ResolveCtx } from '../../server/src/files/places'
import { LinkGuard } from '../../server/src/engine/api-links'
import { ToolError } from '../../server/src/policy/errors'
import { chatFilesOf } from '../../server/src/chat/chat-files'
import { findPdfBrowser } from '../../server/src/files/html-pdf'

import { expectNoRawPlace } from '../lib/card-places'
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
  h = await startHarness({ name: 'places-produce', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-'))
  setSrtSystem(fakeSys, { base, id: 'mycel', plan: PLAN })
  fs.mkdirSync(path.join(h.team, 'users/alice'), { recursive: true })
  fs.writeFileSync(path.join(h.team, 'users/alice/private.png'), makePng(8, 8))
  fs.writeFileSync(path.join(h.team, 'shared/public.png'), makePng(9, 9))
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
type Card = { requestId: string; question: string }
async function run(user: string, chatId: string, content: string, answer: 'share' | 'skip' = 'skip') {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const cards: Card[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      expectNoRawPlace(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer } })
      continue
    }
    const done = sock.frames.find((x) => x.type === 'message.done' && x.data.message.turnId === r.turnId)
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content as string, messageId: done.data.message.id as string, attachments: (done.data.message.attachments ?? []) as Attachment[] }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
/** a chat alice shares with erin; with `files`, a command run in it (its shared work folder made) and `files` put there */
async function sharedChat(files?: Record<string, Uint8Array | string>) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await run('alice', c.id, fake({ say: 'hi' }))
  await share('alice', c.id, [{ subjectType: 'user', subjectId: 'erin' }])
  if (!files) return { chat: c.id as string, root: '' }
  await run('alice', c.id, fake({ tool: 'box_shell', args: { command: 'true' } }))
  const top = path.join(devenvPaths(base).workShared, c.id)
  const root = path.join(top, fs.readdirSync(top)[0]!)
  for (const [rel, b] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), b) }
  return { chat: c.id as string, root }
}
const teamFiles = (dir: string) => { try { return fs.readdirSync(path.join(h.team, dir)) } catch { return [] } }
/** the docx holds this PNG byte for byte */
function docxHas(bytes: Uint8Array, file: string): boolean {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-unzip-'))
  Bun.spawnSync(['unzip', '-o', '-q', file, '-d', out])
  const media = path.join(out, 'word', 'media')
  return (fs.existsSync(media) ? fs.readdirSync(media) : []).some((f) => Buffer.from(fs.readFileSync(path.join(media, f))).equals(Buffer.from(bytes)))
}
const chatFileAbs = (chatId: string, id: string) => path.join(chatFilesOf(h.ctx).root(), chatId, id)

describe('output: chat:files/<name> in a chat shared with people', () => {
  test('make_file attaches the file to the answer: no card, origin ai, the chat link, no team file; erin opens it', async () => {
    const { chat } = await sharedChat()
    const r = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: '# Plan\n\nHello', output: 'chat:files/plan.docx' }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    const att = r.attachments.find((a) => a.name === 'plan.docx')!
    expect(att).toMatchObject({ source: 'chat', origin: 'ai' })
    expect(r.content).toContain(`/c/${chat}?file=${att.id}`)
    expect(r.content).toContain('attached to your answer')
    expect(r.content).not.toContain('/files/view?path=chat')
    expect(teamFiles('users/alice').filter((f) => f.startsWith('plan'))).toEqual([])
    expect((await h.req('erin', `/api/chats/${chat}/files/${att.id}`)).status).toBe(200)
    expect((await h.req('carol', `/api/chats/${chat}/files/${att.id}`)).status).not.toBe(200)
    // a taken name is never overwritten (P4 makes versions): the second one is "plan (2).docx"
    const again = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: '# Plan 2', output: 'chat:files/plan.docx' }, sayResult: true }))
    expect(again.attachments.map((a) => a.name)).toContain('plan (2).docx')
  })

  test('QA TC-7279/TC-7261: a new file the AI makes in the asker\'s own folder goes to the chat; a named sub-folder keeps it there', async () => {
    const { chat } = await sharedChat()
    const r = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: '# Report', output: 'users/alice/q3.docx' }, sayResult: true }))
    const att = r.attachments.find((a) => a.name === 'q3.docx')
    expect(att).toMatchObject({ source: 'chat', origin: 'ai' })
    expect(r.cards).toHaveLength(0)
    expect(fs.existsSync(path.join(h.team, 'users/alice/q3.docx'))).toBe(false)
    expect((await h.req('erin', `/api/chats/${chat}/files/${att!.id}`)).status).toBe(200)
    // the asker names the folder in their own message: saved there, as asked
    const named = await run('alice', chat, `reports 폴더에 저장해줘\n${fake({ tool: 'make_file', args: { format: 'docx', content: '# Report 2', output: 'users/alice/reports/q4.docx' }, sayResult: true })}`)
    expect(named.attachments.find((a) => a.name === 'q4.docx')).toBeUndefined()
    expect(fs.existsSync(path.join(h.team, 'users/alice/reports/q4.docx'))).toBe(true)
    // a team folder everyone in the chat may open: unchanged
    const team = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: '# Shared', output: 'shared/sq-shared.docx' }, sayResult: true }))
    expect(team.attachments.find((a) => a.name === 'sq-shared.docx')).toBeUndefined()
  })

  test('a picture only the asker may open asks the shared read card; no = nothing attached', async () => {
    const { chat } = await sharedChat()
    const r = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: '# Q\n\n![x](users/alice/private.png)', output: 'chat:files/q.docx' }, sayResult: true }), 'skip')
    expect(r.cards.length).toBe(1)
    expect(r.content).toContain('Not attached')
    expect(r.attachments.filter((a) => a.name === 'q.docx')).toHaveLength(0)
    // a picture everyone here may open: no card
    const ok = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: '# Q\n\n![x](shared/public.png)', output: 'chat:files/q.docx' }, sayResult: true }))
    expect(ok.cards).toHaveLength(0)
    expect(ok.attachments.map((a) => a.name)).toContain('q.docx')
  })

  test('the PDF tools, resize_images and make_zip take it too', async () => {
    const { chat } = await sharedChat()
    // a PDF needs pandoc and typst (the CI unit shards have neither: c-make-file-rich skips the same way)
    if ((process.env.MYCEL_TYPST_BIN || Bun.which('typst')) && Bun.which('pandoc')) {
      const pdf = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'pdf', content: '# One', output: 'chat:files/one.pdf' } }))
      expect(pdf.attachments.map((a) => a.name)).toContain('one.pdf')
    }
    const z = await run('alice', chat, fake({ tool: 'make_zip', args: { paths: ['shared/public.png'], output: 'chat:files/pics.zip' }, sayResult: true }))
    expect(z.attachments.map((a) => a.name)).toContain('pics.zip')
    expect(z.content).toContain(`/c/${chat}?file=`)
  })
})

describe('sources and pictures resolve through their own place', () => {
  test('a Markdown source in chat:work/ takes its pictures from the work folder, never from the team folder', async () => {
    const pic = makePng(12, 7)
    const { chat } = await sharedChat({ 'in/doc.md': '# Doc\n\n![a](img/a.png)\n', 'in/img/a.png': pic, 'in/team.md': '# T\n\n![p](shared/public.png)\n' })
    const r = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', source: 'chat:work/in/doc.md', output: 'chat:files/doc.docx' }, sayResult: true }))
    const att = r.attachments.find((a) => a.name === 'doc.docx')!
    expect(att).toBeTruthy()
    expect(docxHas(pic, chatFileAbs(chat, att.id))).toBe(true)
    // shared/public.png is a team file this person may read, but the document is in the work folder: not found there
    const t = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', source: 'chat:work/in/team.md', output: 'chat:files/team.docx' }, sayResult: true }))
    expect(t.content).toContain("image 'shared/public.png'")
    expect(t.attachments.filter((a) => a.name === 'team.docx')).toHaveLength(0)
  })

  test.skipIf(!findPdfBrowser())('an HTML page in chat:work/ is printed with its pictures from the work folder only', async () => {
    const { chat } = await sharedChat({ 'in/p.html': '<html><body><h1>P</h1><img src="img/a.png"><img src="../../shared/public.png"><img src="/shared/public.png"></body></html>', 'in/img/a.png': makePng(30, 20) })
    const r = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'pdf', source: 'chat:work/in/p.html', output: 'chat:files/p.pdf' }, sayResult: true }))
    expect(r.attachments.map((a) => a.name)).toContain('p.pdf')
    expect(r.cards).toHaveLength(0)
    // the team file is not loaded (the page's place has none of that name)
    expect(r.content).toContain('public.png')
    expect(r.content).not.toContain('img/a.png')
    const ev = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'make_file'").get(r.turnId) as { summary: string }
    expect(ev.summary).toContain('chat:files/')
  })

  test('a Markdown file of the chat with a picture of the chat: both through chat:files/, out to the chat or a team folder', async () => {
    const { chat } = await sharedChat()
    const pic = makePng(6, 4)
    const upload = async (name: string, content: string | Uint8Array) => {
      const form = new FormData()
      form.set('chatId', chat)
      form.set('file', new File([typeof content === 'string' ? content : new Uint8Array(content)], name))
      return (await (await h.req('alice', '/api/uploads', { method: 'POST', body: form })).json()) as Attachment
    }
    const md = await upload('brief.md', '# Brief\n\n![l](logo.png)\n')
    const logo = await upload('logo.png', pic)
    const sentNow = await h.api('alice').call(API.sendMessage, { params: { id: chat }, body: { content: fake({ say: 'ok' }), clientMessageId: cm(), attachmentIds: [md.id, logo.id] } })
    await ws.alice!.next('message.done', (f) => f.data.message.turnId === sentNow.turnId, 30_000)
    const r = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', source: `chat:files/${md.id}/brief.md`, output: 'chat:files/brief.docx' }, sayResult: true }))
    const att = r.attachments.find((a) => a.name === 'brief.docx')!
    expect(att).toBeTruthy()
    expect(docxHas(pic, chatFileAbs(chat, att.id))).toBe(true)
    // the picture written as the app's link to it (a real model did, QA TC-6460): the same chat file
    const l = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: `# L\n\n![l](/files/view?path=${encodeURIComponent(`chat:files/${logo.id}/logo.png`)})`, output: 'chat:files/linked.docx' }, sayResult: true }))
    const la = l.attachments.find((a) => a.name === 'linked.docx')!
    expect(docxHas(pic, chatFileAbs(chat, la.id))).toBe(true)
    // into the asker's own folder when they say so (fewer people than the chat): no card, a team file (QA TC-7279: unasked,
    // it goes to the chat)
    const t = await run('alice', chat, `내 파일에 저장해줘\n${fake({ tool: 'make_file', args: { format: 'docx', source: `chat:files/${md.id}/brief.md`, output: 'users/alice/brief.docx' }, sayResult: true })}`)
    expect(t.cards).toHaveLength(0)
    expect(fs.existsSync(path.join(h.team, 'users/alice/brief.docx'))).toBe(true)
  })

  test('a chat:work/ picture named in content, into a team folder: the work folder is its place', async () => {
    const pic = makePng(5, 5)
    const { chat } = await sharedChat({ 'out/chart.png': pic })
    const r = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: '# C\n\n![c](chat:work/out/chart.png)', output: 'chat:files/c.docx' }, sayResult: true }))
    const att = r.attachments.find((a) => a.name === 'c.docx')!
    expect(docxHas(pic, chatFileAbs(chat, att.id))).toBe(true)
  })
})

// ---- the rules, on a hand-built call context
function placesFor(kind: ResolveCtx['chatKind'], o: { main?: boolean; hidden?: boolean; chatId?: string | null } = {}): ChatPlaces {
  const ctx: ResolveCtx = { db: h.ctx.db, userId: 'alice', chatId: o.chatId === undefined ? 'c-none' : o.chatId, main: o.main ?? true, chatKind: kind, hiddenGroup: !!o.hidden, workFolder: () => null, live: () => true }
  return {
    ctx,
    async attach() { throw new Error('not here') },
    open() { throw new ToolError('not found', 'not_found') },
    names: () => new Set(),
    head() { throw new ToolError('not found', 'not_found') },
    async version() { throw new Error('not here') },
    async restore() { throw new Error('not here') },
  }
}
const ctxWith = (places?: ChatPlaces): ToolCtx => ({ user: h.ctx.files.principal('alice'), turnId: null, files: new TurnFiles(), ...(places ? { places } : {}) })
const why = (f: () => unknown) => { try { f(); return null } catch (e) { return (e as Error).message } }

describe('who may attach', () => {
  test('a project chat keeps its project folder; a personal, locked or scheduled chat, a guest, a sub-agent and no chat are refused', () => {
    expect(why(() => chatOutput(ctxWith(placesFor('project')), 'chat:files/a.pptx'))).toBe(PLACE_WORDS.projectSave)
    expect(why(() => chatOutput(ctxWith(placesFor('personal')), 'chat:files/a.pptx'))).toBe(PLACE_WORDS.personalSave)
    expect(why(() => chatOutput(ctxWith(placesFor('locked')), 'chat:files/a.pptx'))).toBe(PLACE_WORDS.lockedSave)
    expect(why(() => chatOutput(ctxWith(placesFor('scheduled')), 'chat:files/a.pptx'))).toBe(PLACE_WORDS.lockedSave)
    expect(why(() => chatOutput(ctxWith(placesFor('guest')), 'chat:files/a.pptx'))).toBe(PLACE_WORDS.lockedSave)
    expect(why(() => chatOutput(ctxWith(placesFor('people', { main: false })), 'chat:files/a.pptx'))).toBe(PLACE_WORDS.noChat)
    expect(why(() => chatOutput(ctxWith(), 'chat:files/a.pptx'))).toBe(PLACE_WORDS.noChat)
  })

  test('the k refusal: an answer with a hidden-from-later group attaches nothing', () => {
    expect(why(() => chatOutput(ctxWith(placesFor('people', { hidden: true })), 'chat:files/a.pptx'))).toBe(PLACE_WORDS.hiddenTurn)
  })

  test('chat:work/ outputs wait for P2; an existing chat file by id is a new version of it (QA TC-7267); other forms are refused', () => {
    expect(why(() => chatOutput(ctxWith(placesFor('people')), 'chat:work/out/a.pptx'))).toBe(NO_WORK_WORDS.elsewhere)
    expect(chatOutput(ctxWith(placesFor('people')), 'chat:files/01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208/a.pptx')).toEqual({ name: 'a.pptx', id: '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208' })
    expect(why(() => chatOutput(ctxWith(placesFor('people')), 'chat:files/'))).toContain('name the new file')
    expect(why(() => chatOutput(ctxWith(placesFor('people')), 'room:files/a.pptx'))).toContain('room files are not paths yet')
    expect(why(() => authorizeOutput(h.ctx.files.fx, h.ctx.files.rules(), ctxWith(placesFor('people')), 'chat:files/a.docx', { mustExist: true }))).toBe(PLACE_WORDS.inPlace)
    // a team path is the team rule's, unchanged
    expect(chatOutput(ctxWith(placesFor('people')), 'shared/a.pptx')).toBeNull()
  })

  test('the limits: the turn\'s file count and bytes are checked before the attach', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-lim-'))
    const f = path.join(dir, 'out.docx')
    fs.writeFileSync(f, 'x'.repeat(100))
    // a real chat shared with people is not needed: the limits refuse before anything reaches the chat
    const { chat } = await sharedChat()
    const c = ctxWith({ ...placesFor('people', { chatId: chat }) })
    for (let i = 0; i < 10_000; i++) c.files.filesWritten.add(`x${i}`)
    expect(await attachProduced(h.ctx, c, ['chat:files', 'a.docx'], f).then(() => null, (e: Error) => e.message)).toContain('files')
    const d = ctxWith({ ...placesFor('people', { chatId: chat }) })
    d.files.bytesWritten = 1e15
    expect(await attachProduced(h.ctx, d, ['chat:files', 'a.docx'], f).then(() => null, (e: Error) => e.message)).toMatch(/MB|GB|bytes/)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a reference inside a document never leaves its place', () => {
    expect(placeRef({ kind: 'work', dir: ['in'] }, 'img/a.png')).toBe('chat:work/in/img/a.png')
    expect(placeRef({ kind: 'work', dir: ['in'] }, '../../shared/x.png')).toBeNull()
    expect(placeRef({ kind: 'chatFiles' }, 'logo.png')).toBe('chat:files/logo.png')
    expect(placeRef({ kind: 'chatFiles' }, 'img/logo.png')).toBeNull()
    expect(placeRef({ kind: 'team', dir: ['shared'] }, 'a.png')).toBeNull()
  })
})

describe('the chat file link', () => {
  const id = '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208'
  test('a tool result\'s link to chat:files/<id>/… becomes /c/<chat>?file=<id>', () => {
    const t = chatLinksInText(`Saved chat:files/${id}/deck.pptx. Link for the user: [deck.pptx](/files/view?path=chat%3Afiles%2F${id}%2Fdeck.pptx)`, 'chat-1', true)
    expect(t).toContain(`[deck.pptx](/c/chat-1?file=${id})`)
    expect(t).not.toContain('/files/view')
    expect(t).toContain('everyone in this chat opens it under your answer')
    expect(chatLinksInText('Saved shared/a.docx: [a.docx](/files/view?path=shared%2Fa.docx)', 'chat-1', true)).toBe('Saved shared/a.docx: [a.docx](/files/view?path=shared%2Fa.docx)')
  })

  test('QA TC-6778: in a chat only the person sees, the attached-file line names no one', () => {
    const t = chatLinksInText(`Saved chat:files/${id}/deck.pptx. Link for the user: [deck.pptx](/files/view?path=chat%3Afiles%2F${id}%2Fdeck.pptx)`, 'chat-1', false)
    expect(t).toContain(`[deck.pptx](/c/chat-1?file=${id})`)
    expect(t).toContain('it opens under your answer')
    expect(t).not.toMatch(/everyone/i)
  })

  test('the API engine keeps the chat file link a tool gave and drops an invented one; a chat link alone goes through', () => {
    const g = new LinkGuard()
    g.allow(`Attached: [deck.pptx](/c/chat-1?file=${id})`)
    expect(g.clean(`Here: [deck.pptx](/c/chat-1?file=${id})`)).toBe(`Here: [deck.pptx](/c/chat-1?file=${id})`)
    expect(g.clean('Here: [other.pptx](/c/chat-1?file=01a1fc0c-bb3a-74b5-a134-000000000000)')).toBe('Here: other.pptx')
    expect(g.clean('See [the chat](/c/chat-2)')).toBe('See [the chat](/c/chat-2)')
  })
})

// Independent review of P3 (2026-11-21): the refusals of the whole turn path, a name a person cannot see, the link
// guard's spellings and which tools' text becomes a chat-file link
describe('review: refusals before any card, hidden names, the link guard', () => {
  test('a personal or project chat gets the resolver\'s own words and no card', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const r = await run('alice', c.id, fake({ tool: 'make_file', args: { format: 'docx', content: '# A\n\n![x](users/alice/private.png)', output: 'chat:files/a.docx' }, sayResult: true }))
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain(PLACE_WORDS.personalSave)
    expect(r.attachments).toHaveLength(0)
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Places P3 review', instructions: '', participants: [{ subjectType: 'group', subjectId: 'marketing' }] } })
    const pc = await h.api('alice').call(API.createChat, { body: { projectId: p.id } })
    const q = await run('alice', pc.id, fake({ tool: 'make_file', args: { format: 'docx', content: '# A\n\n![x](users/alice/private.png)', output: 'chat:files/a.docx' }, sayResult: true }))
    expect(q.cards).toHaveLength(0)
    expect(q.content).toContain(PLACE_WORDS.projectSave)
  })

  test('a sub-agent\'s chat:files output attaches nothing (only the read card for its source, as for any call)', async () => {
    const { chat } = await sharedChat()
    fs.writeFileSync(path.join(h.team, 'users/alice/private.md'), '# Only alice')
    const r = await run('alice', chat, fake({ agents: [{ id: 'c1', type: 'general-purpose', description: 'make it', steps: [{ tool: 'make_file', args: { format: 'docx', source: 'users/alice/private.md', output: 'chat:files/sub.docx' }, sayChildResult: true }] }] }), 'share')
    expect(r.cards.length).toBeLessThanOrEqual(1)
    expect(r.attachments.filter((a) => a.name === 'sub.docx')).toHaveLength(0)
    expect(r.content).toContain(PLACE_WORDS.noChat)
  })

  test('a name only someone else\'s unsent upload holds is not taken: no "(2)" that would tell it is there', async () => {
    const { chat } = await sharedChat()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-up-'))
    const f = path.join(tmp, 'up.bin')
    fs.writeFileSync(f, 'erin draft')
    await chatFilesOf(h.ctx).create('erin', chat, 'secret plan.docx', f, crypto.createHash('sha256').update('erin draft').digest('hex'))
    fs.rmSync(tmp, { recursive: true, force: true })
    const r = await run('alice', chat, fake({ tool: 'make_file', args: { format: 'docx', content: '# Plan', output: 'chat:files/secret plan.docx' }, sayResult: true }))
    expect(r.attachments.map((a) => a.name)).toContain('secret plan.docx')
    expect(r.content).not.toContain('secret plan (2)')
  })

  test('the link guard: a spelling the router opens the same way (case, a closing slash) is the same link', () => {
    const id = '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208'
    const other = '01a1fc0c-bb3a-74b5-a134-000000000000'
    const g = new LinkGuard()
    g.allow(`Attached: [deck.pptx](/c/chat-1?file=${id})`)
    expect(g.clean(`[a](/c/chat-1/?file=${id})`)).toBe(`[a](/c/chat-1/?file=${id})`)
    expect(g.clean(`[a](/C/chat-1/?file=${other})`)).toBe('a')
    expect(g.clean(`[a](/c/chat-1/?file=${other})`)).toBe('a')
    expect(g.clean('See [the chat](/c/chat-2/)')).toBe('See [the chat](/c/chat-2/)')
  })

  test('only a produce tool\'s result becomes a chat-file link: a data file that holds one stays as it is', async () => {
    const { chat } = await sharedChat()
    const id = '01a1fc0c-bb3a-74b5-a134-7fcbe2e1b208'
    fs.writeFileSync(path.join(h.team, 'shared/links.csv'), `name,link\nx,/files/view?path=chat%3Afiles%2F${id}%2Fx.pdf\n`)
    const r = await run('alice', chat, fake({ tool: 'query_data', args: { paths: ['shared/links.csv'], sql: 'SELECT link FROM data' }, sayResult: true }))
    expect(r.content).not.toContain(`/c/${chat}?file=`)
    expect(r.content).not.toContain('attached to your answer')
  })
})
