// A file from the computer in a chat shared with people, read and saved like any other chat's file
// (docs/decisions/20261118-chat-files-full-read-and-save.md, QA TC-4909; server/src/chat/chat-file-tool.ts). Alice shares
// a chat with bob and the marketing group (erin); carol (admin) and dana (owner) are not in it. Covered: chat_file reads
// through the team read path (numbered lines, a file over the old 32 MB cap, a PDF's pages with a scan as a page image,
// a recording reaching the media read), never naming the inner path; save_chat_file copies the file byte for byte into
// the person's own downloads without a card, into a folder others see only after the wider-audience card, refuses
// skills/, instruction names and names instead of ids before any card, and gives nothing to someone no longer in the chat.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { CCITT_SCAN, makePagesPdf } from '../lib/pdf'
import { readScope } from '../../server/src/chat/read-scope'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-files-read-save', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
async function share(user: string, chatId: string, subjects: Sub[]) {
  let r = await put(user, chatId, subjects)
  if (r.status === 'confirm') r = await put(user, chatId, subjects, r.confirmKey)
  if (r.status !== 'saved') throw new Error('not saved')
}
type Card = { requestId: string; question: string; options?: { value: string }[] }
/** a message and the turn to its end; every card is answered with `answer` and kept */
async function run(user: string, chatId: string, content: string, attachmentIds: string[] = [], answer: (c: Card) => string = () => 'skip') {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds } })
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
    if (done && done.type === 'message.done') return { turnId: r.turnId, cards, content: done.data.message.content }
    if (Date.now() > end) throw new Error('turn did not end')
    await Bun.sleep(25)
  }
}
async function upload(user: string, chatId: string, name: string, content: string | Uint8Array) {
  const form = new FormData()
  form.set('chatId', chatId)
  form.set('file', new File([typeof content === 'string' ? content : new Uint8Array(content)], name))
  const res = await h.req(user, '/api/uploads', { method: 'POST', body: form })
  return { status: res.status, body: (await res.json()) as Attachment }
}
let chats = 0
/** a chat alice shares with bob and marketing, with `name` sent in it by alice; the chat and the file id */
async function sent(name: string, content: string | Uint8Array) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await run('alice', c.id, `hello ${++chats}\n${fake({ say: 'hi' })}`)
  await share('alice', c.id, [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'group', subjectId: 'marketing' }])
  const up = await upload('alice', c.id, name, content)
  expect(up.status).toBe(201)
  await run('alice', c.id, `here it is\n${fake({ say: 'ok' })}`, [up.body.id])
  return { chat: c.id, file: up.body.id }
}
const summaries = (turnId: string, tool: string) => (db().query('SELECT summary FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY id').all(turnId, tool) as { summary: string }[]).map((r) => r.summary)

describe('chat_file reads as a team file is read', () => {
  test('numbered lines; a file over the old 32 MB cap (uploads take 50 MB) is read; the inner path is never named', async () => {
    const line = 'x'.repeat(99) + '\n'
    const big = 'FIRST LINE OF THE BIG FILE\n' + line.repeat(Math.ceil((40 * 1024 * 1024) / line.length))
    const { chat, file } = await sent('big-log.txt', big)
    const r = await run('bob', chat, `read it\n${fake({ tool: 'chat_file', args: { file, limit: 3 }, sayResult: true })}`)
    expect(r.content).toContain('FIRST LINE OF THE BIG FILE')
    expect(r.content).not.toContain('too large')
    expect(r.content).not.toContain('.system/')
    expect(r.content).toContain('"big-log.txt"')
    expect(readScope(db(), chat)).toContainEqual({ type: 'chat', id: chat })
    for (const s of summaries(r.turnId, 'chat_file')) expect(s).not.toContain('big-log')
  })

  test('a scanned PDF comes as its page image (not "cannot be read here")', async () => {
    const { chat, file } = await sent('scan.pdf', makePagesPdf([{ image: CCITT_SCAN }]))
    const img = spyOn(h.ctx.files, 'pdfPageImage').mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    try {
      const r = await run('bob', chat, `read the scan\n${fake({ tool: 'chat_file', args: { file, pages: '1' }, sayResult: true })}`)
      expect(r.content).not.toContain('cannot be read here')
      const s = summaries(r.turnId, 'chat_file').join('\n')
      // the read's own pages path: a page image when pictures may go, else the recognized text or the read's note
      expect(s).toMatch(/pages 1 of 1/)
      expect(s).toContain('1 image')
      expect(r.content).toContain('no text layer: shown as an image')
    } finally { img.mockRestore() }
  })

  test('a recording goes to the media read (frames and transcript), not "only its name is known"', async () => {
    const { chat, file } = await sent('meeting.m4a', new Uint8Array(4096))
    const tools = spyOn(h.ctx.files as unknown as { mediaTools(): unknown }, 'mediaTools').mockReturnValue('missing')
    try {
      const r = await run('bob', chat, `what was said?\n${fake({ tool: 'chat_file', args: { file, transcript: true }, sayResult: true })}`)
      expect(r.content).not.toContain('only its name is known')
      expect(summaries(r.turnId, 'chat_file').join('\n')).toContain('audio not read (no ffmpeg)')
    } finally { tools.mockRestore() }
  })
})

describe('save_chat_file', () => {
  test('to the own downloads: no card, the same bytes, then a file tool takes the copy', async () => {
    const bytes = makePagesPdf([{ lines: ['A contract to stamp, with enough words on the page.'] }])
    const { chat, file } = await sent('contract.pdf', bytes)
    const r = await run('bob', chat, `keep it\n${fake({ tool: 'save_chat_file', args: { file }, sayResult: true })}`)
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('users/bob/downloads/contract.pdf')
    expect(new Uint8Array(fs.readFileSync(path.join(h.team, 'users/bob/downloads/contract.pdf')))).toEqual(new Uint8Array(bytes))
    // the copy is the chat's bytes: the shared chat's read card does not ask to share the own folder for it
    const split = await run('bob', chat, `${fake({ tool: 'split_pdf', args: { file_path: 'users/bob/downloads/contract.pdf', every: 1, output_folder: 'users/bob/downloads/parts/' }, sayResult: true })}`)
    expect(split.cards).toHaveLength(0)
    expect(split.content).toContain('contract (part 1).pdf')
    // once changed, it is the folder's file again: the card asks
    fs.appendFileSync(path.join(h.team, 'users/bob/downloads/contract.pdf'), '\n% changed')
    const after = await run('bob', chat, `${fake({ tool: 'read', args: { file_path: 'users/bob/downloads/contract.pdf' }, sayResult: true })}`)
    expect(after.cards).toHaveLength(1)
  })

  test('to a folder people outside the chat see: the wider-audience card first; a no saves nothing, a yes saves', async () => {
    const { chat, file } = await sent('price-list.txt', 'PRICES 2026')
    const no = await run('bob', chat, `${fake({ tool: 'save_chat_file', args: { file, save_as: 'shared/' }, sayResult: true })}`)
    expect(no.cards.length).toBe(1)
    expect(fs.existsSync(path.join(h.team, 'shared/price-list.txt'))).toBe(false)
    const yes = await run('bob', chat, `${fake({ tool: 'save_chat_file', args: { file, save_as: 'shared/' }, sayResult: true })}`, [], () => 'save')
    expect(yes.cards.length).toBe(1)
    expect(fs.readFileSync(path.join(h.team, 'shared/price-list.txt'), 'utf8')).toBe('PRICES 2026')
  })

  test('refused before any card: a name instead of an id, skills/, an instruction name; and nothing for someone taken out', async () => {
    const { chat, file } = await sent('notes.md', '# notes')
    for (const args of [{ file: 'notes.md' }, { file, save_as: 'skills/' }, { file, save_as: 'shared/CLAUDE.md' }]) {
      const r = await run('bob', chat, `${fake({ tool: 'save_chat_file', args, sayResult: true })}`)
      expect(r.cards).toHaveLength(0)
      expect(r.content).toMatch(/file_id|skills folder|instruction file/)
    }
    expect(fs.existsSync(path.join(h.team, 'shared/CLAUDE.md'))).toBe(false)
    // erin leaves the chat's audience (only bob stays): her AI gets nothing of the file
    await share('alice', chat, [{ subjectType: 'user', subjectId: 'bob' }])
    const gone = await run('bob', chat, `${fake({ tool: 'chat_file', args: { file }, sayResult: true })}`)
    expect(gone.content).toContain('# notes')
    const r = await h.api('erin').call(API.sendMessage, { params: { id: chat }, body: { content: 'x', clientMessageId: cm(), attachmentIds: [] } }).then(() => 'sent', () => 'refused')
    expect(r).toBe('refused')
  })
})
