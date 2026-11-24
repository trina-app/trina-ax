// A save in a shared chat asks with save words, not read words (QA TC-4968,
// docs/decisions/20261118-shared-save-card-wording.md). alice saves into her own folder in a chat bob sees too:
//   - a new file there raises no card (save_connector_file's save_as is a write target now, like save_url's);
//   - a place that is there already (her folder itself, a file of that name) raises the save card: "wants to save a
//     file in your personal folder", Save / Always allow / Don't save, its own "Always allow" kind;
//   - a call that also reads from there (unzip a file of hers) keeps the read card;
//   - a yes to save there never lets a read of it through in that turn;
//   - nothing about her folder reaches bob: no card, no place, no file name, in the frames he gets or the answers he
//     reads, and the refusal the AI gets names no place.
// In a chat shared with people (the QA case) and in a shared project chat.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Message, type PutChatAudienceResult } from '@mycel/shared/api'
import { FILE_TOOLS, OTHER_TOOLS, SkillFilesInput } from '@mycel/shared'
import { z } from 'zod'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { roomsOf } from '../../server/src/rooms/service'
import { OUTPUT_PATH_OF, SAVE_CARD_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS, WRITE_TARGET_NOT_SAVES } from '../../server/src/rooms/ai-tools'
import { toolRegistry } from '../../server/src/tools/registry'
import { pluginsOf } from '../../server/src/plugins/manager'
import { fileSharesOf } from '../../server/src/files/shares'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-save-card', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
const doneOf = async (user: string, messageId: string) => (await ws[user]!.next('message.done', (f) => f.data.messageId === messageId, 30_000)).data.message
type Card = { requestId: string; question: string; options: { label: string; value: string }[] }
const cardOf = async (user: string, turnId: string) => (await ws[user]!.next('turn.request', (f) => f.data.turnId === turnId, 15_000)).data.request as unknown as Card
const answer = (user: string, turnId: string, requestId: string, value: string) =>
  h.api(user).call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId, answer: value } })
const audits = (chatId: string) => (db().query("SELECT detail FROM audit_log WHERE action = 'chat.shared_read' AND target = ? ORDER BY id").all(chatId) as { detail: string }[]).map((r) => JSON.parse(r.detail))
const messages = async (user: string, chatId: string): Promise<Message[]> => (await h.api(user).call(API.listMessages, { params: { id: chatId }, query: {} })).items
const aliceDir = () => path.join(h.ctx.files.fx.root, 'users/alice')
const listing = () => fs.readdirSync(aliceDir()).sort()

/** a chat outside projects that alice shares with bob (docs/DECISIONS.md "Chats shared with people and groups") */
async function peopleChat(): Promise<string> {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const first = await send('alice', c.id, 'hello\n' + fake({ say: 'hi' }))
  await doneOf('alice', first.assistantMessage.id)
  const subjects = [{ subjectType: 'user' as const, subjectId: 'bob' }]
  let r: PutChatAudienceResult = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects } })
  if (r.status === 'confirm') r = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects, confirmKey: r.confirmKey } })
  expect(r.status).toBe('saved')
  return c.id
}
const projectChat = async () => (await h.api('alice').call(API.createChat, { body: { projectId } })).id

/** what bob may learn about alice's folder: nothing (names in it, its path, the card's words). The AI's answer he does
 * see (here the fake engine repeats the refusal it got), which names no place. */
function expectNothingForBob(text: string) {
  for (const s of ['users/alice', 'todo.md', 'drafts', 'newsletter', 'audit-copy', 'Draft Q4', 'personal folder', 'wants to save']) expect(text, s).not.toContain(s)
}

describe('the save card', () => {
  // (her own project chat: no save card, as no read card there since docs/decisions/20261123-do-then-undo.md "project
  // saves, own folder"; below)
  for (const where of ['people'] as const) {
    test(`${where}: a save into her own folder that is there asks with save words; no keeps the folder as it was and tells bob nothing`, async () => {
      const chat = where === 'people' ? await peopleChat() : await projectChat()
      const before = listing()
      const bobFrom = ws.bob!.frames.length
      const started = await send('alice', chat, 'save the attachment in my folder\n' + fake({ tool: 'save_connector_file', args: { file: 'mcp-file:nope', save_as: 'users/alice/' }, sayResult: true }))
      const card = await cardOf('alice', started.turnId)
      // the kind and the words of a save, never of a read
      expect(card.question).toContain('The AI wants to save a file in your personal folder.')
      expect(card.question).toContain("1 of the 2 people who see this chat can't open it, so they won't be able to open the file either.")
      expect(card.question).not.toMatch(/\bread\b/i)
      expect(card.options.map((o) => o.label)).toEqual(['Save', 'Always allow', "Don't save"])
      expect(card.options.map((o) => o.value)).toEqual(['share', '__always', 'skip'])
      await answer('alice', started.turnId, card.requestId, 'skip')
      const done = await doneOf('alice', started.assistantMessage.id)
      // the AI is told it was not saved, by whom, and names no place
      expect(done.content).toContain('Not saved (save_connector_file): nothing was saved there.')
      expect(done.content).toContain('did not allow it')
      expect(done.content).toContain('they can save it from a chat of their own')
      expect(done.content).not.toContain('users/alice')
      expect(done.content).not.toContain('Not read')
      expect(done.steps.find((s) => s.tool === 'save_connector_file')).toMatchObject({ label: 'Not saved: not everyone who sees this chat can open that place' })
      expect(listing()).toEqual(before)
      expect(audits(chat).at(-1)).toMatchObject({ decision: 'declined', tool: 'save_connector_file', save: true, places: 1, cannotSee: 1, audience: 2 })
      // bob: no card, and nothing about alice's folder in his frames or in the answers he reads
      const bobFrames = ws.bob!.frames.slice(bobFrom)
      expect(bobFrames.some((f) => f.type === 'turn.request')).toBe(false)
      expectNothingForBob(JSON.stringify(bobFrames))
      expectNothingForBob(JSON.stringify((await messages('bob', chat)).filter((m) => m.role === 'assistant')))
    })
  }

  test('project: in her own project chat a save over her own private file asks nothing; after someone else\'s file, or in a folder she shares, the card stays', async () => {
    const tag = crypto.randomUUID().slice(0, 6), file = `users/alice/own-${tag}.md`, dir = `users/alice/shared-${tag}`, inShare = `${dir}/price.md`
    const put = (rel: string, body: string) => { const abs = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body) }
    const content = (rel: string) => fs.readFileSync(path.join(h.ctx.files.fx.root, ...rel.split('/')), 'utf8')
    put(file, 'old\n'); put(inShare, '100\n')
    const save = (rel: string, body: string) => fake({ tool: 'read', args: { file_path: rel } }, { tool: 'write', args: { file_path: rel, content: body } }, { say: 'done' })
    const cards = (turnId: string) => ws.alice!.frames.filter((f) => f.type === 'turn.request' && f.data.turnId === turnId).length
    const chat = await projectChat()
    const first = await send('alice', chat, `save it\n${save(file, 'new\n')}`)
    await doneOf('alice', first.assistantMessage.id)
    expect(cards(first.turnId)).toBe(0)
    expect(content(file)).toBe('new\n')
    // a folder of hers that is shared: others read what the save changes
    fileSharesOf(h.ctx).put('alice', dir, [{ subjectType: 'user', subjectId: 'erin' }], [], 'en', 'dialog')
    const chat2 = await projectChat()
    const shared = await send('alice', chat2, `save it\n${save(inShare, '999\n')}`)
    const c = await cardOf('alice', shared.turnId)
    await answer('alice', shared.turnId, c.requestId, 'skip')
    await doneOf('alice', shared.assistantMessage.id)
    expect(content(inShare)).toBe('100\n')
    // someone else's words in the chat: the card is back
    const chat3 = await projectChat()
    db().query('UPDATE chats SET others_words = 1 WHERE id = ?').run(chat3)
    const after = await send('alice', chat3, `save it\n${save(file, 'planted\n')}`)
    const c3 = await cardOf('alice', after.turnId)
    await answer('alice', after.turnId, c3.requestId, 'skip')
    await doneOf('alice', after.assistantMessage.id)
    expect(content(file)).toBe('new\n')
  })

  test('a new file in her own folder raises no card (save_connector_file and save_url alike)', async () => {
    const chat = await peopleChat()
    const n = audits(chat).length
    const started = await send('alice', chat, fake(
      { tool: 'save_connector_file', args: { file: 'mcp-file:nope', save_as: 'users/alice/new-report.pdf' }, sayResult: true },
      { tool: 'save_url', args: { url: 'http://127.0.0.1:9/x.pdf', save_as: 'users/alice/fresh/new.pdf' }, sayResult: true },
      { say: 'done' }))
    await doneOf('alice', started.assistantMessage.id)
    expect(ws.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === started.turnId)).toBe(false)
    expect(audits(chat).length).toBe(n)
  })

  test('save_url and write into a place there: the save card (make_file: the extension probes below); unzip of her own file keeps the read card', async () => {
    const chat = await peopleChat()
    const q = async (d: unknown) => {
      const started = await send('alice', chat, fake(d, { say: 'ok' }))
      const card = await cardOf('alice', started.turnId)
      await answer('alice', started.turnId, card.requestId, 'skip')
      await doneOf('alice', started.assistantMessage.id)
      return card
    }
    for (const d of [
      { tool: 'save_url', args: { url: 'http://127.0.0.1:9/x.pdf', save_as: 'users/alice/' } },
      { tool: 'write', args: { file_path: 'users/alice/todo.md', content: 'x' } },
    ]) {
      const card = await q(d)
      expect(card.question, d.tool).toContain('wants to save a file in your personal folder')
      expect(card.options.map((o) => o.label), d.tool).toEqual(['Save', 'Always allow', "Don't save"])
    }
    // a call that can save several files says "files"
    const split = await q({ tool: 'split_pdf', args: { file_path: 'shared/handbook.pdf', every: 1, output_folder: 'users/alice/' } })
    expect(split.question).toContain('The AI wants to save files in your personal folder.')
    expect(split.question).toContain("so they won't be able to open the files either")
    // it reads her file (its names come back): the read card, read words
    const unzip = await q({ tool: 'unzip_file', args: { path: 'users/alice/todo.md', to_folder: 'users/alice/' } })
    expect(unzip.question).toContain('The AI wants to read your personal folder.')
    expect(unzip.options.map((o) => o.label)).toEqual(['Read and share', 'Always allow', "Don't read"])
    expect(fs.readFileSync(path.join(aliceDir(), 'todo.md'), 'utf8')).toContain('Draft Q4 campaign report')
  })

  // security review of #1314: the gate reads save_as as the tool does (savePathArg), and decides "new" with the write's
  // own check, so a path the tool would land on something there always asks first
  test('probes: a leading "/", a leading space, backslashes, a file on the way, a full-width or case-variant name all ask', async () => {
    const chat = await peopleChat()
    const before = listing()
    for (const save_as of ['/users/alice/', '//users/alice/todo.md', ' users/alice/todo.md', 'users\\alice\\todo.md', '\\users\\alice\\', 'users/alice/todo.md/x.pdf', 'users/alice/\uff54odo.md', 'users/alice/TODO.md', 'users/alice/drafts']) {
      const started = await send('alice', chat, fake({ tool: 'save_connector_file', args: { file: 'mcp-file:nope', save_as }, sayResult: true }))
      const card = await cardOf('alice', started.turnId)
      expect(card.question, JSON.stringify(save_as)).toContain('wants to save a file in your personal folder')
      await answer('alice', started.turnId, card.requestId, 'skip')
      const done = await doneOf('alice', started.assistantMessage.id)
      // nothing came back that tells what is there
      for (const s of ['already exists', 'not a folder', 'almost the same name', 'todo.md', 'saved as a copy']) expect(done.content, `${JSON.stringify(save_as)} ${s}`).not.toContain(s)
    }
    expect(listing()).toEqual(before)
    expectNothingForBob(JSON.stringify((await messages('bob', chat)).filter((m) => m.role === 'assistant')))
  })

  // security re-review of #1314: tools that add an extension to `output` ("users/alice/hb" is written as hb.pdf, …):
  // the card weighs the path the tool really writes (OUTPUT_PATH_OF)
  test('probes: an output without its extension, over a file that is there, asks (make_file, merge_pdfs, edit_pdf, stamp_pdf, edit_hwp, comment_docx, resize_images)', async () => {
    for (const f of ['hb.pdf', 'hb.docx', 'hb.hwpx', 'pic.png']) fs.writeFileSync(path.join(aliceDir(), f), 'QA-SSC')
    const plugins = pluginsOf(h.ctx) as unknown as { hwpWriting: () => boolean }
    const hwpWriting = plugins.hwpWriting
    plugins.hwpWriting = () => true
    try {
      const chat = await peopleChat()
      const before = listing()
      const out = 'users/alice/hb'
      for (const d of [
        { tool: 'make_file', args: { content: '# x', format: 'pdf', output: out } },
        { tool: 'merge_pdfs', args: { files: ['shared/handbook.pdf', 'shared/handbook.pdf'], output: out } },
        { tool: 'edit_pdf', args: { file_path: 'shared/handbook.pdf', operations: [{ watermark: { text: 'X' } }], output: out } },
        { tool: 'stamp_pdf', args: { file_path: 'shared/handbook.pdf', image: 'shared/seal.png', output: out } },
        { tool: 'edit_hwp', args: { file_path: 'shared/form.hwpx', changes: [{ find: 'a', replace: 'b' }], output: out } },
        { tool: 'comment_docx', args: { file_path: 'shared/note.docx', comments: [{ on: 'a', text: 'b' }], output: out } },
        // the copy's format picks the extension: "pic" over an existing pic.png
        { tool: 'resize_images', args: { paths: ['shared/photo.jpg'], output: 'users/alice/pic' } },
      ]) {
        if (d.tool === 'comment_docx' && !SHARED_TOOLS.has('comment_docx')) continue
        const started = await send('alice', chat, fake({ ...d, sayResult: true }))
        const card = await cardOf('alice', started.turnId)
        expect(card.question, d.tool).toContain(d.tool === 'resize_images' ? 'wants to save files in your personal folder' : 'wants to save a file in your personal folder')
        await answer('alice', started.turnId, card.requestId, 'skip')
        const done = await doneOf('alice', started.assistantMessage.id)
        for (const s of ['already exists', 'conflict', 'hb.', 'pic.']) expect(done.content, `${d.tool} ${s}`).not.toContain(s)
      }
      expect(listing()).toEqual(before)
      expectNothingForBob(JSON.stringify((await messages('bob', chat)).filter((m) => m.role === 'assistant')))
      // the same rules as the tools
      expect(OUTPUT_PATH_OF.make_file!(out, { format: 'pdf' })).toBe('users/alice/hb.pdf')
      expect(OUTPUT_PATH_OF.edit_hwp!(out, { file_path: 'shared/form.hwp' })).toBe('users/alice/hb.hwp')
      expect(OUTPUT_PATH_OF.comment_docx!(out + '/', {})).toBe('users/alice/hb.docx')
      expect(OUTPUT_PATH_OF.resize_images!('users/alice/pic.webp', {})).toEqual(['users/alice/pic.webp', 'users/alice/pic.jpg', 'users/alice/pic.jpeg', 'users/alice/pic.png', 'users/alice/pic.webp'])
    } finally {
      plugins.hwpWriting = hwpWriting
      for (const f of ['hb.pdf', 'hb.docx', 'hb.hwpx', 'pic.png']) fs.rmSync(path.join(aliceDir(), f), { force: true })
    }
  })

  test('a yes to save there does not let a read of her folder through in the same turn', async () => {
    const chat = await peopleChat()
    const started = await send('alice', chat, fake(
      { tool: 'save_connector_file', args: { file: 'mcp-file:nope', save_as: 'users/alice/' } },
      { tool: 'read', args: { file_path: 'users/alice/todo.md' }, sayResult: true }))
    const save = await cardOf('alice', started.turnId)
    expect(save.question).toContain('wants to save a file')
    await answer('alice', started.turnId, save.requestId, 'share')
    const read = await ws.alice!.next('turn.request', (f) => f.data.turnId === started.turnId && f.data.request.requestId !== save.requestId, 15_000)
    expect((read.data.request as unknown as Card).question).toContain('wants to read your personal folder')
    await answer('alice', started.turnId, (read.data.request as unknown as Card).requestId, 'skip')
    const done = await doneOf('alice', started.assistantMessage.id)
    expect(done.content).not.toContain('Draft Q4 campaign report')
    expectNothingForBob(JSON.stringify((await messages('bob', chat)).filter((m) => m.role === 'assistant')))
  })

  test('"Always allow" on the save card skips later save cards, never a read card', async () => {
    try {
      const chat = await peopleChat()
      const first = await send('alice', chat, fake({ tool: 'save_connector_file', args: { file: 'mcp-file:nope', save_as: 'users/alice/' } }, { say: 'one' }))
      const card = await cardOf('alice', first.turnId)
      await answer('alice', first.turnId, card.requestId, '__always')
      await doneOf('alice', first.assistantMessage.id)
      expect(db().query("SELECT kind FROM card_always_allow WHERE user_id = 'alice'").all()).toEqual([{ kind: 'shared_save' }])
      const again = await send('alice', chat, fake({ tool: 'save_connector_file', args: { file: 'mcp-file:nope', save_as: 'users/alice/' } }, { say: 'two' }))
      await doneOf('alice', again.assistantMessage.id)
      expect(ws.alice!.frames.some((f) => f.type === 'turn.request' && f.data.turnId === again.turnId)).toBe(false)
      const read = await send('alice', chat, fake({ tool: 'read', args: { file_path: 'users/alice/todo.md' }, sayResult: true }))
      const readCard = await cardOf('alice', read.turnId)
      expect(readCard.question).toContain('wants to read')
      await answer('alice', read.turnId, readCard.requestId, 'skip')
      expect((await doneOf('alice', read.assistantMessage.id)).content).not.toContain('Draft Q4 campaign report')
    } finally { db().query('DELETE FROM card_always_allow').run() }
  })
})

describe('every save-type tool', () => {
  test('a save_as, output, output_folder or to_folder field is a write target, and each target is on one card list', () => {
    // every tool's input fields, from the tools themselves: the server's registry (comment_docx, save_connector_file…),
    // the shared schemas (save_room_file, unzip_file…) and skill_files
    const fields = new Map<string, string[]>()
    const reg = toolRegistry(h.ctx.files)
    for (const n of reg.names()) fields.set(n, Object.keys((reg.describeTool(n)!.inputSchema as { properties?: object }).properties ?? {}))
    const shape = (s: z.ZodType) => Object.keys((z.toJSONSchema(s, { io: 'input' }) as { properties?: object }).properties ?? {})
    for (const [n, d] of Object.entries({ ...FILE_TOOLS, ...OTHER_TOOLS })) if (!fields.has(n)) fields.set(n, shape(d.input as z.ZodType))
    fields.set('skill_files', shape(SkillFilesInput))
    for (const n of ['save_room_file', 'comment_docx', 'save_connector_file', 'save_url', 'unzip_file', 'make_file']) expect(fields.has(n), n).toBe(true)
    for (const [n, f] of fields) for (const k of f.filter((x) => ['save_as', 'output', 'output_folder', 'to_folder'].includes(x))) expect(WRITE_TARGET_ARGS[n] ?? [], `${n}.${k}`).toContain(k)
    for (const n of Object.keys(WRITE_TARGET_ARGS)) expect(!!SAVE_CARD_TOOLS[n] !== WRITE_TARGET_NOT_SAVES.has(n), n).toBe(true)
    // the shared chat's save tools ask on the save card
    for (const n of ['save_url', 'save_connector_file', 'make_file', 'unzip_file', 'save_chat_file', 'make_zip'].filter((x) => SHARED_TOOLS.has(x))) expect(SAVE_CARD_TOOLS[n], n).toBeDefined()
  })
})
