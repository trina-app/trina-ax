// A chat shared with people "with files": inside it, a path to a file copied in means the chat's copy for everyone,
// the AI included (plan docs/AGENTS/plan/20261122-0503-shared-chat-copy-paths.md; QA TC-v1b-*, QA-D flow 4). Alice's
// private chat makes a quote PDF in her own folder (stamp_pdf: a tool whose output counts as made by the chat); she shares the chat with bob and its files. Covered: bob's AI edits
// "the quote" by the path in the answer → a new version of the chat's copy, never a new file and never the original;
// alice's own edit by that path is a version of the copy too; bob's transcript names the copy's path; a chat made
// private again maps nothing; the pure mapping (which tools and arguments, spellings, the text).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment } from '@mycel/shared/api'
import { chatFilePath } from '@mycel/shared/places'
import { PDFDocument } from 'pdf-lib'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { makePagedPdf } from '../lib/pdf'
import { makePng } from '../lib/images'
import { chatFilesOf } from '../../server/src/chat/chat-files'
import { sharedCopyMap } from '../../server/src/chat/chat-files-share'
import { mapCopyPaths, mapCopyText } from '../../server/src/chat/copy-paths'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'shared-copy-paths', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const store = () => chatFilesOf(h.ctx)
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
async function ask(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm() } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 60_000)
  return { id: started.assistantMessage.id as string, content: done.data.message.content as string }
}
const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')
const onDisk = (rel: string) => new Uint8Array(fs.readFileSync(path.join(h.team, rel)))
const pagesOfBytes = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount()
const copyPages = async (user: string, chatId: string, id: string) => pagesOfBytes(new Uint8Array(await (await h.req(user, `/api/chats/${chatId}/files/${id}`)).arrayBuffer()))
const eventsAt = (rel: string) => (db().query('SELECT COUNT(*) n FROM file_events WHERE path = ?').get(rel) as { n: number }).n

let n = 0
/** alice's private chat makes `users/alice/<dir>/견적서.pdf` (3 pages) and links it; shared with bob and its files */
async function sharedQuote() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const dir = `users/alice/quote-${++n}-${crypto.randomUUID().slice(0, 6)}`
  // the pages come from a team file bob opens too (an answer that read alice's own files would be hidden from him)
  const src = `shared/quote-src-${n}-${crypto.randomUUID().slice(0, 6)}.pdf`
  fs.mkdirSync(path.dirname(path.join(h.team, src)), { recursive: true })
  fs.writeFileSync(path.join(h.team, src), makePagedPdf([['Q-1'], ['Q-2'], ['Q-3']]))
  fs.writeFileSync(path.join(h.team, `${src}.png`), makePng())
  const orig = `${dir}/견적서.pdf`
  const made = await ask('alice', c.id, `make the quote\n${fake({ tool: 'read', args: { file_path: src } }, { tool: 'stamp_pdf', args: { file_path: src, image: `${src}.png`, output: orig } }, { say: `견적서를 만들었어요: [견적서.pdf](${orig})` })}`)
  expect(fs.existsSync(path.join(h.team, orig))).toBe(true)
  const p = await h.api('alice').call(API.previewChatAudience, { params: { id: c.id }, body: { subjects: [bob] } })
  const s = await h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects: [bob], confirmKey: p.previewKey, withFiles: true } })
  expect(s.status).toBe('saved')
  const atts = JSON.parse((db().query('SELECT attachments FROM messages WHERE id = ?').get(made.id) as { attachments: string }).attachments) as Attachment[]
  const copy = atts.find((a) => a.origin === 'shared-copy')!
  expect(copy).toBeTruthy()
  return { chatId: c.id as string, orig, copy, answer: made.id }
}

describe('another member edits the shared quote by the answer\'s path', () => {
  test('bob\'s AI: a new version of the chat\'s copy; no new file; the original never touched', async () => {
    const { chatId, orig, copy } = await sharedQuote()
    const before = onDisk(orig)
    const eventsBefore = eventsAt(orig)
    // the AI follows the link in the first answer (the creator's own folder, which bob cannot open)
    const r = await ask('bob', chatId, `3쪽 빼줘\n${fake({ tool: 'read', args: { file_path: orig } }, { tool: 'edit_pdf', args: { file_path: orig, operations: [{ remove_pages: '3' }] }, sayResult: true })}`)
    expect(r.content).toContain('saved as version 2')
    expect(store().chain(copy.id)).toHaveLength(2)
    expect(await copyPages('bob', chatId, copy.id)).toBe(2)
    expect(await copyPages('alice', chatId, copy.id)).toBe(2)
    // one file of that name in the chat, nothing in bob's own folder
    expect(store().visibleTo('bob', chatId).filter((v) => v.root.name.startsWith('견적서'))).toHaveLength(1)
    expect(fs.existsSync(path.join(h.team, 'users/bob')) ? fs.readdirSync(path.join(h.team, 'users/bob'), { recursive: true }).filter((f) => String(f).includes('견적서')) : []).toEqual([])
    // the original: the same bytes, no new file event, never shown to bob
    expect(sha(onDisk(orig))).toBe(sha(before))
    expect(await pagesOfBytes(onDisk(orig))).toBe(3)
    expect(eventsAt(orig)).toBe(eventsBefore)
    expect(r.content).not.toContain(orig)
  })

  test('a leading "/" or "./", or the link\'s URL-encoded form, is the same file; alice\'s own edit is a version of the copy too', async () => {
    const { chatId, orig, copy } = await sharedQuote()
    const before = sha(onDisk(orig))
    const r = await ask('bob', chatId, fake({ tool: 'read', args: { file_path: `/${orig}` } }, { tool: 'edit_pdf', args: { file_path: encodeURI(`./${orig}`), operations: [{ remove_pages: '3' }] }, sayResult: true }))
    expect(r.content).toContain('saved as version 2')
    // the creator, in the shared chat: the chat's copy, not her original (one file, not two)
    const a = await ask('alice', chatId, fake({ tool: 'read', args: { file_path: orig } }, { tool: 'edit_pdf', args: { file_path: orig, operations: [{ remove_pages: '2' }] }, sayResult: true }))
    expect(a.content).toContain('saved as version 3')
    expect(await copyPages('bob', chatId, copy.id)).toBe(1)
    expect(sha(onDisk(orig))).toBe(before)
  })

  test('bob\'s transcript names the copy\'s chat path, never the original; alice\'s chat made private again maps nothing', async () => {
    const { chatId, orig, copy, answer } = await sharedQuote()
    const copies = sharedCopyMap(h.ctx, chatId, 'bob')
    expect([...copies.keys()]).toEqual([orig])
    const items = h.rt().history(answer, { runner: 'bob', withheld: new Set(), everyone: true, copies })
    const text = items.find((m) => m.id === answer)!.content
    expect(text).toContain(`[견적서.pdf](${chatFilePath(copy.id, copy.name)})`)
    expect(text).not.toContain(orig)
    expect(text).toContain(`path ${chatFilePath(copy.id, copy.name)}`)
    // made private again: alice's paths are her own team files again (edit_pdf of a team file saves "(edited)" beside it)
    await h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects: [] } })
    expect(sharedCopyMap(h.ctx, chatId, 'alice').size).toBe(1)
    const r = await ask('alice', chatId, fake({ tool: 'read', args: { file_path: orig } }, { tool: 'edit_pdf', args: { file_path: orig, operations: [{ remove_pages: '3' }] }, sayResult: true }))
    expect(r.content).not.toContain('saved as version')
    expect(r.content).toContain(`${orig} is unchanged`)
    expect(store().chain(copy.id)).toHaveLength(1)
  })
})

describe('the mapping itself', () => {
  const copies = new Map([['users/junho/견적서.pdf', { id: '0190f3c2-7d1a-7c3e-9b2a-1f2e3d4c5b6a', name: '견적서.pdf' }]])
  const to = chatFilePath('0190f3c2-7d1a-7c3e-9b2a-1f2e3d4c5b6a', '견적서.pdf')
  test('reads and in-place edits map; destinations and the tools about the original itself keep it', () => {
    expect(mapCopyPaths('read', { file_path: ' /users/junho/견적서.pdf ' }, copies)).toEqual({ args: { file_path: to }, mapped: 1 })
    expect(mapCopyPaths('edit_pdf', { file_path: 'users/junho/견적서.pdf', output: 'users/junho/견적서.pdf', operations: [{ insert_pdf: { file: 'users/junho/견적서.pdf' } }] }, copies).args)
      .toEqual({ file_path: to, output: to, operations: [{ insert_pdf: { file: to } }] })
    expect(mapCopyPaths('merge_pdfs', { files: ['users/junho/견적서.pdf', { path: 'shared/a.pdf' }], output: 'shared/m.pdf' }, copies).args)
      .toEqual({ files: [to, { path: 'shared/a.pdf' }], output: 'shared/m.pdf' })
    expect(mapCopyPaths('copy_files', { paths: ['users/junho/견적서.pdf'], to_folder: 'users/junho' }, copies).args).toEqual({ paths: [to], to_folder: 'users/junho' })
    // make_file's output is a new file's place: kept (a team path, refused or saved by the team rules)
    expect(mapCopyPaths('make_file', { output: 'users/junho/견적서.pdf' }, copies).mapped).toBe(0)
    expect(mapCopyPaths('edit_files', { file_paths: ['users/junho/견적서.pdf', 'shared/a.md'], old_string: 'users/junho/견적서.pdf', new_string: 'x' }, copies).args)
      .toEqual({ file_paths: [to, 'shared/a.md'], old_string: 'users/junho/견적서.pdf', new_string: 'x' })
    for (const t of ['delete_files', 'move_files', 'rename_file', 'who_can_open', 'share_with_person', 'stop_sharing']) expect(mapCopyPaths(t, { paths: ['users/junho/견적서.pdf'], path: 'users/junho/견적서.pdf' }, copies).mapped).toBe(0)
    // another file of the folder, a longer name: kept
    expect(mapCopyPaths('read', { file_path: 'users/junho/견적서.pdf.bak' }, copies).mapped).toBe(0)
    const same = { file_path: 'users/junho/other.pdf' }
    expect(mapCopyPaths('read', same, copies).args).toBe(same)
  })
  test('the text: as written, after a "/", URL-encoded (encoded again), before a Korean particle or a sentence\'s "."; never inside a longer path', () => {
    const t = mapCopyText(`[견적서](users/junho/견적서.pdf) · /users/junho/견적서.pdf에 저장 · (${encodeURI('users/junho/견적서.pdf')}) · users/junho/견적서.pdf.bak · xusers/junho/견적서.pdf · saved to users/junho/견적서.pdf.`, copies)
    expect(t).toBe(`[견적서](${to}) · ${to}에 저장 · (${encodeURI(to)}) · users/junho/견적서.pdf.bak · xusers/junho/견적서.pdf · saved to ${to}.`)
    // a name with "$&" is put in as written (never read as a replacement pattern)
    const odd = new Map([['users/junho/a$&b.pdf', { id: '0190f3c2-7d1a-7c3e-9b2a-1f2e3d4c5b6a', name: 'a$&b.pdf' }]])
    expect(mapCopyText('see users/junho/a$&b.pdf', odd)).toBe(`see ${chatFilePath('0190f3c2-7d1a-7c3e-9b2a-1f2e3d4c5b6a', 'a$&b.pdf')}`)
  })
})
