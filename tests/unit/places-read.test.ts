// The chat place chat:files/ in the core file tools (plan docs/AGENTS/plan/20261121-0615-chat-places-as-paths.md P1;
// server/src/files/service.ts callPlace, server/src/chat/chat-file-tool.ts chatPlaceHooks). Alice shares a chat with bob
// and the marketing group (erin). Covered: read by the id form and by name (one code path with chat_file: its bookkeeping,
// no inner path, no read card, the chat as the read scope's source), list / glob / grep of chat:files/, the transcript's
// path, refusals (another chat's file, someone else's unsent upload, a held file, a file carried by a hidden answer, a
// chat with no chat files, write and edit, a tool that does not take a chat place yet), and that a chat file is opened
// only through ChatFiles.open.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Attachment, type PutChatAudienceResult } from '@mycel/shared/api'
import { chatFilePath } from '@mycel/shared/places'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { readScope } from '../../server/src/chat/read-scope'
import { setAnswerReads } from '../../server/src/chat/shared-answers'
import { roomsOf } from '../../server/src/rooms/service'
import { TurnFiles } from '../../server/src/files/service'
import { chatFilesOf } from '../../server/src/chat/chat-files'

import { expectNoRawPlace } from '../lib/card-places'
setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'places-read', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  let clock = Date.now()
  roomsOf(h.ctx).clock = () => (clock += 10_000)
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
type Card = { requestId: string; question: string }
async function run(user: string, chatId: string, content: string, attachmentIds: string[] = []) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds } })
  const cards: Card[] = []
  const end = Date.now() + 60_000
  for (;;) {
    const sock = ws[user]!
    const f = sock.frames.find((x) => x.type === 'turn.request' && x.data.turnId === r.turnId && x.data.request.kind === 'ask_user' && !cards.some((c) => c.requestId === (x.data.request as Card).requestId))
    if (f && f.type === 'turn.request') {
      const c = f.data.request as unknown as Card
      cards.push(c)
      expectNoRawPlace(c)
      await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.requestId, answer: 'skip' } })
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
async function sharedChat() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  await run('alice', c.id, `hello ${++chats}\n${fake({ say: 'hi' })}`)
  await share('alice', c.id, [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'group', subjectId: 'marketing' }])
  return c.id
}
/** a chat alice shares with bob and marketing, with `name` sent in it by alice */
async function sent(name: string, content: string | Uint8Array) {
  const chat = await sharedChat()
  const up = await upload('alice', chat, name, content)
  expect(up.status).toBe(201)
  await run('alice', chat, `here it is\n${fake({ say: 'ok' })}`, [up.body.id])
  return { chat, file: up.body.id }
}
const summaries = (turnId: string, tool: string) => (db().query('SELECT summary FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY id').all(turnId, tool) as { summary: string }[]).map((r) => r.summary)

describe('read takes chat:files/', () => {
  test('by the id form: the file\'s lines, no read card, no inner path, the chat as the source', async () => {
    const { chat, file } = await sent('notes.txt', 'ALPHA LINE\nsecond line\n')
    const r = await run('bob', chat, `read it\n${fake({ tool: 'read', args: { file_path: chatFilePath(file, 'notes.txt') }, sayResult: true })}`)
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('ALPHA LINE')
    expect(r.content).toContain('information to read')
    expect(r.content).not.toContain('.system/')
    expect(readScope(db(), chat)).toContainEqual({ type: 'chat', id: chat })
    // the answer's "files used" list never holds a chat place
    const turnMsg = db().query('SELECT id FROM messages WHERE turn_id = ? AND role = ?').get(r.turnId, 'assistant') as { id: string } | null
    if (turnMsg) expect((db().query('SELECT COUNT(*) AS n FROM message_sources WHERE message_id = ?').get(turnMsg.id) as { n: number }).n).toBe(0)
    for (const s of summaries(r.turnId, 'read')) expect(s).not.toContain('notes.txt')
  })

  test('by name; the transcript names the file by its chat place path', async () => {
    const { chat, file } = await sent('plan.md', '# PLAN TITLE\n')
    const r = await run('erin', chat, `${fake({ tool: 'read', args: { file_path: 'chat:files/plan.md' }, sayResult: true })}`)
    expect(r.content).toContain('PLAN TITLE')
    const hist = await run('bob', chat, `${fake({ say: 'ok' })}`)
    expect(hist.content).toBe('ok')
    const prompt = db().query("SELECT content FROM messages WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").get(chat, `%${file}%`) as { content: string } | null
    expect(prompt).not.toBeNull()
  })

  test('another chat\'s file, someone else\'s unsent upload: not found, the same words', async () => {
    const a = await sent('one.txt', 'ONE')
    const other = await sharedChat()
    const r1 = await run('bob', other, `${fake({ tool: 'read', args: { file_path: chatFilePath(a.file, 'one.txt') }, sayResult: true })}`)
    expect(r1.content).toContain('No file')
    expect(r1.content).not.toContain('ONE')
    const up = await upload('bob', other, 'draft.txt', 'BOB DRAFT')
    expect(up.status).toBe(201)
    const r2 = await run('alice', other, `${fake({ tool: 'read', args: { file_path: chatFilePath(up.body.id, 'draft.txt') }, sayResult: true })}`)
    expect(r2.content).toContain('No file')
    expect(r2.content).not.toContain('BOB DRAFT')
    const l = await run('alice', other, `${fake({ tool: 'list', args: { path: 'chat:files/' }, sayResult: true })}`)
    expect(l.content).not.toContain('draft.txt')
  })

  test('a file held by the safety check is not read', async () => {
    const bytes = 'HELD CONTENT'
    const { chat, file } = await sent('held.txt', bytes)
    h.ctx.files.quarantine.add(Buffer.from(bytes), 'image')
    const r = await run('bob', chat, `${fake({ tool: 'read', args: { file_path: chatFilePath(file, 'held.txt') }, sayResult: true })}`)
    expect(r.content).toContain("held by the team's safety check")
    expect(r.content).not.toContain('HELD CONTENT')
  })

  test('a file carried only by an answer hidden from people who join later (k) is not read', async () => {
    const { chat, file } = await sent('k.txt', 'K SECRET')
    const ans = db().query("SELECT id, attachments FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(chat) as { id: string }
    const att = db().query("SELECT attachments FROM messages WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").get(chat, `%${file}%`) as { attachments: string }
    db().query('UPDATE messages SET attachments = ? WHERE id = ?').run(att.attachments, ans.id)
    db().query("UPDATE messages SET attachments = '[]' WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").run(chat, `%${file}%`)
    setAnswerReads(db(), chat, ans.id, [{ c: ['alice', 'bob', 'erin'], s: [{ type: 'integration', id: 'x' }], k: 1 }])
    const r = await run('alice', chat, `${fake({ tool: 'read', args: { file_path: chatFilePath(file, 'k.txt') }, sayResult: true })}`)
    expect(r.content).toContain('kept from some people')
    expect(r.content).not.toContain('K SECRET')
  })
})

describe('list, glob and grep of chat:files/', () => {
  test('list shows each file by its path; glob by name; grep in text files', async () => {
    const chat = await sharedChat()
    const a = await upload('alice', chat, 'budget.csv', 'item,cost\nrent,100\n')
    const b = await upload('alice', chat, 'memo.md', 'The RENT goes up.\n')
    await run('alice', chat, `two files\n${fake({ say: 'ok' })}`, [a.body.id, b.body.id])
    const l = await run('bob', chat, `${fake({ tool: 'list', args: { path: 'chat:files/' }, sayResult: true })}`)
    expect(l.cards).toHaveLength(0)
    expect(l.content).toContain(chatFilePath(a.body.id, 'budget.csv'))
    expect(l.content).toContain(chatFilePath(b.body.id, 'memo.md'))
    const g = await run('bob', chat, `${fake({ tool: 'glob', args: { pattern: '*.md', path: 'chat:files/' }, sayResult: true })}`)
    expect(g.content).toContain('memo.md')
    expect(g.content).not.toContain('budget.csv')
    const s = await run('bob', chat, `${fake({ tool: 'grep', args: { pattern: 'rent', path: 'chat:files/', '-i': true, output_mode: 'content' }, sayResult: true })}`)
    expect(s.content).toContain(`${chatFilePath(a.body.id, 'budget.csv')}:2:rent,100`)
    expect(s.content).toContain('The RENT goes up.')
    expect(readScope(db(), chat)).toContainEqual({ type: 'chat', id: chat })
  })
})

describe('refusals', () => {
  test('a personal chat with no chat files: chat:files/ says where its attachments are', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const r = await run('alice', c.id, `${fake({ tool: 'read', args: { file_path: 'chat:files/x.txt' }, sayResult: true })}`)
    // plain words the AI may pass on (QA TC-6941): no files of its own, and where an attached file is read from
    expect(r.content).toContain('This chat has no files of its own')
    expect(r.content).not.toContain('<attachments>')
  })
  test('write and edit of a chat file, list of a chat file, room:, chat:other: plain words, nothing done', async () => {
    const { chat, file } = await sent('w.txt', 'W')
    // (P4: a write of an existing chat file is a new version, after a read: tests/unit/places-ai-versions.test.ts)
    const w = await run('bob', chat, `${fake({ tool: 'write', args: { file_path: chatFilePath(file, 'w.txt'), content: 'X' }, sayResult: true })}`)
    expect(w.content).toContain('first (with read)')
    const room = await run('bob', chat, `${fake({ tool: 'read', args: { file_path: 'room:files/a.png' }, sayResult: true })}`)
    expect(room.content).toContain('room files are not paths yet')
    const other = await run('bob', chat, `${fake({ tool: 'read', args: { file_path: 'chat:other/a' }, sayResult: true })}`)
    expect(other.content).toContain('the only chat places')
    // (P2: list takes chat:work/; this chat has no work folder)
    const work = await run('bob', chat, `${fake({ tool: 'list', args: { path: 'chat:work/' }, sayResult: true })}`)
    expect(work.content).toContain('no work folder')
  })
  test('a registered tool that does not take a chat place yet: refused before any card', async () => {
    const { chat, file } = await sent('src.md', '# x')
    // (make_file's source takes one since P3: tests/unit/places-produce.test.ts; merge_pdfs' files do not)
    const r = await run('bob', chat, `${fake({ tool: 'merge_pdfs', args: { files: [chatFilePath(file, 'src.md')], output: 'users/bob/out.pdf' }, sayResult: true })}`)
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('does not take a chat file')
    expect(fs.existsSync(path.join(h.team, 'users/bob/out.pdf'))).toBe(false)
  })
  test('a sub-agent\'s view of the turn has no chat place', () => {
    const files = new TurnFiles()
    files.chatPlace = { read: async () => ({ text: '', summary: '' }), list: () => ({ text: '', summary: '' }), glob: () => ({ text: '', summary: '' }), grep: () => ({ text: '', summary: '' }) }
    const sub = (files as unknown as { view(agent: string | null): TurnFiles }).view('agent-1')
    expect(sub.chatPlace).toBeNull()
  })
})

describe('review fixes (adversarial review of P1)', () => {
  test('grep of chat:files/ runs its pattern in ripgrep: a backtracking pattern ends at once, ripgrep syntax, a bad one says so', async () => {
    const chat = await sharedChat()
    const a = await upload('alice', chat, 'xs.txt', 'x'.repeat(5000) + '\nfound \\d here\nline 42 here\n')
    await run('alice', chat, `x\n${fake({ say: 'ok' })}`, [a.body.id])
    const t = Date.now()
    const slow = await run('bob', chat, `${fake({ tool: 'grep', args: { pattern: '(x+x+)+y', path: 'chat:files/' }, sayResult: true })}`)
    expect(Date.now() - t).toBeLessThan(20_000)
    expect(slow.content).toContain('No matches found')
    const re = await run('bob', chat, `${fake({ tool: 'grep', args: { pattern: '\\bline \\d+\\b', path: 'chat:files/', output_mode: 'content' }, sayResult: true })}`)
    expect(re.content).toContain(`${chatFilePath(a.body.id, 'xs.txt')}:3:line 42 here`)
    const bad = await run('bob', chat, `${fake({ tool: 'grep', args: { pattern: '(unclosed', path: 'chat:files/' }, sayResult: true })}`)
    expect(bad.content).toContain('Invalid regular expression')
  })

  test('a chat file read through read counts as other people\'s words, as chat_file does', async () => {
    const chat = await sharedChat()
    const up = await upload('bob', chat, 'bob.txt', 'BOB WROTE THIS')
    await run('bob', chat, `mine\n${fake({ say: 'ok' })}`, [up.body.id])
    // the chat is no longer shared: its files stay, and other people's words matter again (Always allow cards)
    await share('alice', chat, [])
    for (const args of [{ tool: 'read', args: { file_path: chatFilePath(up.body.id, 'bob.txt') } }, { tool: 'grep', args: { pattern: 'BOB', path: 'chat:files/' } }]) {
      db().query('UPDATE chats SET others_words = 0 WHERE id = ?').run(chat)
      const r = await run('alice', chat, `${fake({ ...args, sayResult: true })}`)
      expect(r.content).toContain(args.tool === 'read' ? 'BOB WROTE THIS' : 'bob.txt')
      expect((db().query('SELECT others_words FROM chats WHERE id = ?').get(chat) as { others_words: number }).others_words).toBe(1)
    }
  })

  test('write and edit of a chat place are refused before any card (a room card after a room read)', async () => {
    const { chat, file } = await sent('w2.txt', 'W')
    db().query('UPDATE chats SET rooms_seen = 1 WHERE id = ?').run(chat)
    for (const c of [
      { tool: 'write', args: { file_path: 'chat:files/new.txt', content: 'X' }, says: 'No file' },
      { tool: 'edit', args: { file_path: chatFilePath(file, 'w2.txt'), old_string: 'W', new_string: 'X' }, says: 'first (with read)' },
      { tool: 'write', args: { file_path: 'chat:work/a.txt', content: 'X' }, says: 'box_shell' },
      { tool: 'edit', args: { file_path: 'room:files/a.txt', old_string: 'a', new_string: 'b' }, says: 'room files are not paths yet' },
      { tool: 'edit_files', args: { file_paths: ['shared/none.md', 'chat:work/w2.txt'], old_string: 'W', new_string: 'X' }, says: 'Leave it out of file_paths' },
    ]) {
      const r = await run('bob', chat, `${fake({ tool: c.tool, args: c.args, sayResult: true })}`)
      expect(r.cards).toHaveLength(0)
      expect(r.content).toContain(c.says)
    }
  })

  test('a file carried only by a hidden answer (k) is not listed, globbed or searched either', async () => {
    const { chat, file } = await sent('k2.txt', 'K2 SECRET')
    const ans = db().query("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(chat) as { id: string }
    const att = db().query("SELECT attachments FROM messages WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").get(chat, `%${file}%`) as { attachments: string }
    db().query('UPDATE messages SET attachments = ? WHERE id = ?').run(att.attachments, ans.id)
    db().query("UPDATE messages SET attachments = '[]' WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").run(chat, `%${file}%`)
    setAnswerReads(db(), chat, ans.id, [{ c: ['alice', 'bob', 'erin'], s: [{ type: 'integration', id: 'x' }], k: 1 }])
    const l = await run('alice', chat, `${fake({ tool: 'list', args: { path: 'chat:files/' }, sayResult: true })}`)
    expect(l.content).not.toContain('k2.txt')
    const g = await run('alice', chat, `${fake({ tool: 'glob', args: { pattern: '*.txt', path: 'chat:files/' }, sayResult: true })}`)
    expect(g.content).not.toContain('k2.txt')
    const s = await run('alice', chat, `${fake({ tool: 'grep', args: { pattern: 'K2', path: 'chat:files/', output_mode: 'content' }, sayResult: true })}`)
    expect(s.content).not.toContain('K2 SECRET')
  })

  test('the Share check does not count an answer that read a chat file as one using files a newcomer cannot open', async () => {
    for (const how of ['chat_file', 'read']) {
      const { chat, file } = await sent('n.txt', 'N TEXT')
      const call = how === 'read' ? { tool: 'read', args: { file_path: chatFilePath(file, 'n.txt') } } : { tool: 'chat_file', args: { file } }
      const r = await run('bob', chat, `${fake({ ...call, sayResult: true })}`)
      expect(r.content).toContain('N TEXT')
      expect(readScope(db(), chat)).toContainEqual({ type: 'chat', id: chat })
      const res = await put('alice', chat, [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'group', subjectId: 'marketing' }, { subjectType: 'user', subjectId: 'carol' }])
      expect(res.status).toBe('confirm')
      if (res.status === 'confirm') expect(res.check.fileAnswers).toBe(0)
    }
  })
})

describe('versions and the hidden-answer check (batch P1 x P4, QA TC-6567)', () => {
  // a message carries a chain by its root's id; a version's own id is on no message, so the hidden-answer check must
  // look at the chain's root, or a file changed once escapes it
  test('a changed file carried only by a hidden answer (k) is not read, listed, globbed or searched by any of its ids', async () => {
    const { chat, file } = await sent('kv.txt', 'KV ONE')
    const v = await chatFilesOf(h.ctx).putVersion('alice', chat, file, { bytes: new TextEncoder().encode('KV TWO SECRET') })
    expect(v.row.id).not.toBe(file)
    const ans = db().query("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(chat) as { id: string }
    const att = db().query("SELECT attachments FROM messages WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").get(chat, `%${file}%`) as { attachments: string }
    db().query('UPDATE messages SET attachments = ? WHERE id = ?').run(att.attachments, ans.id)
    db().query("UPDATE messages SET attachments = '[]' WHERE chat_id = ? AND role = 'user' AND attachments LIKE ?").run(chat, `%${file}%`)
    setAnswerReads(db(), chat, ans.id, [{ c: ['alice', 'bob', 'erin'], s: [{ type: 'integration', id: 'x' }], k: 1 }])
    const store = chatFilesOf(h.ctx)
    // by the chain: the root's id and the version's id both count as carried
    expect(store.kCarried(store.row(file)!)).toBe(true)
    expect(store.kCarried(v.row)).toBe(true)
    for (const id of [file, v.row.id]) {
      const r = await run('alice', chat, `${fake({ tool: 'read', args: { file_path: chatFilePath(id, 'kv.txt') }, sayResult: true })}`)
      expect(r.content).not.toContain('KV TWO SECRET')
      expect(r.content).not.toContain('KV ONE')
    }
    const l = await run('alice', chat, `${fake({ tool: 'list', args: { path: 'chat:files/' }, sayResult: true })}`)
    expect(l.content).not.toContain('kv.txt')
    const g = await run('alice', chat, `${fake({ tool: 'glob', args: { pattern: '*.txt', path: 'chat:files/' }, sayResult: true })}`)
    expect(g.content).not.toContain('kv.txt')
    const s = await run('alice', chat, `${fake({ tool: 'grep', args: { pattern: 'KV', path: 'chat:files/', output_mode: 'content' }, sayResult: true })}`)
    expect(s.content).not.toContain('KV TWO SECRET')
  })

  test('a changed file anyone may open is listed once, by its chain id, with its newest bytes', async () => {
    const { chat, file } = await sent('kv2.txt', 'KV2 ONE')
    await chatFilesOf(h.ctx).putVersion('alice', chat, file, { bytes: new TextEncoder().encode('KV2 TWO') })
    const seen = chatFilesOf(h.ctx).visibleTo('bob', chat).filter((v) => v.head.name === 'kv2.txt')
    expect(seen.length).toBe(1)
    expect(seen[0]!.id).toBe(file)
    // the old file id resolves to the head: ChatFiles.find, and a read by the first id's path gives the newest bytes
    expect(chatFilesOf(h.ctx).find('bob', chat, file)?.head.sha256).toBe(seen[0]!.head.sha256)
    const r = await run('alice', chat, `${fake({ tool: 'read', args: { file_path: chatFilePath(file, 'kv2.txt') }, sayResult: true })}`)
    expect(r.content).toContain('KV2 TWO')
    expect(r.content).not.toContain('KV2 ONE')
    const l = await run('alice', chat, `${fake({ tool: 'list', args: { path: 'chat:files/' }, sayResult: true })}`)
    expect(l.content).toContain(chatFilePath(file, 'kv2.txt'))
    const s = await run('alice', chat, `${fake({ tool: 'grep', args: { pattern: 'KV2', path: 'chat:files/', output_mode: 'content' }, sayResult: true })}`)
    expect(s.content).toContain('KV2 TWO')
    expect(s.content).not.toContain('KV2 ONE')
  })

  // putVersion does not refuse a turn whose answer holds a k group by itself: its callers must (a k answer's words
  // must not reach a version everyone in the chat opens). Nothing calls it from a turn yet (P4's tool side).
  test.todo('a turn whose answer holds a k group cannot save a version of a chat file (the caller of putVersion refuses)', () => {})
})

describe('one way to open a chat file', () => {
  test('only chat/chat-files.ts names the chat files\' storage', () => {
    const root = path.join(import.meta.dir, '../../server/src')
    const hits: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (p.endsWith('.ts') && /['"`]chat-files['"`]|\.root\(\)\s*,\s*chatId|chatFilesOf\([^)]*\)\.root\(/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p))
      }
    }
    walk(root)
    // system/storage.ts only adds up the folder's bytes for the storage line; it opens no file
    expect(hits.sort()).toEqual(['chat/chat-files.ts', 'system/storage.ts'])
  })
})
