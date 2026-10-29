// Chat titles (server/src/chat/title.ts, docs/DECISIONS.md "Chat titles"): the placeholder from the first message
// skips addresses, code, markdown and secrets (the founder's pasted admin token became a chat title, 2026-10-28); the
// answering AI names the chat with set_title, live in the sidebar and header (chat.updated), only while the title is
// automatic, in the chat's first two messages, never in a scheduled run, never after the person renamed it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type Step } from '@mycel/shared/api'
import { MIGRATIONS_DIR, migrate, openDb, readMigrations } from '../../server/src/db'
import { AI_TITLE_MAX, PLACEHOLDER_MAX, TITLE_SCAN_KEY, cleanAiTitle, graphemes, hideTitle, maskStoredTitles, placeholderTitle } from '../../server/src/chat/title'
import { HIDDEN } from '../../server/src/integrations/connections/hide'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { WORK } from '../lib/env'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
// made up, in the shape of the founder's token (joined at run time so secret scanners do not take it for a leak)
const TOKEN = ['aipm', '5c6de5a19f3b4e7d8a2c0b6f1e9d3a7c'].join('_')
// the QA SEC-16 test key: no connection stores it (QA B-W47-3, B-W5-1)
const QA_KEY = ['QA-FAKE', 'KEY-0000-NOT-REAL'].join('-')

describe('placeholder from the first message', () => {
  test("the founder's case: a pasted token line, then normal lines", () => {
    expect(placeholderTitle(`${TOKEN}\n이 토큰으로 AI PM 프로젝트 목록 가져와줘\n그리고 정리해줘`)).toBe('이 토큰으로 AI PM 프로젝트 목록 가져와줘')
    expect(placeholderTitle(`${TOKEN}\n\nList my AI PM projects with this key`)).toBe('List my AI PM projects with this key')
  })

  test('a secret inside a good line is cut out; a line that is mostly a secret is skipped', () => {
    expect(placeholderTitle(`키 ${TOKEN} 연결해줘`)).toBe('키 연결해줘')
    expect(placeholderTitle(`Connect key ${TOKEN} to AI PM`)).toBe('Connect key to AI PM')
    expect(placeholderTitle(`OPENAI_API_KEY=${'sk-' + 'proj-Ab3dEf9hIjK1mNoP2qRsT4uVwXyZ5aBcD6'}\nPlease set up the integration`)).toBe('Please set up the integration')
    expect(placeholderTitle('Authorization: Bearer abc123def456ghi789\ncall the API')).toBe('call the API')
    expect(placeholderTitle('비밀번호: abcd1234\n서버 접속해줘')).toBe('서버 접속해줘')
    expect(placeholderTitle('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAbC12==\n-----END OPENSSH PRIVATE KEY-----\n서버 접속 설정해줘')).toBe('서버 접속 설정해줘')
  })

  test('a named test key is cut out, also when no connection stores it (QA SEC-16, B-W47-3, B-W5-1)', () => {
    expect(placeholderTitle(`${QA_KEY} 이게 무슨 뜻이야?`)).toBe('이게 무슨 뜻이야?')
    expect(placeholderTitle(`What does ${QA_KEY} mean?`)).toBe('What does mean?')
    expect(placeholderTitle(QA_KEY)).toBe('')
    // normal words stay
    expect(placeholderTitle('API key setup guide')).toBe('API key setup guide')
    expect(placeholderTitle('secret santa list')).toBe('secret santa list')
    expect(placeholderTitle('Set OPENAI_API_KEY in the server')).toBe('Set OPENAI_API_KEY in the server')
  })

  test('addresses, code fences and markdown', () => {
    expect(placeholderTitle('https://docs.google.com/document/d/1aBcD3fGh5iJkL7mNoP9qRsT1uVwX3yZ/edit\n이 문서 요약해줘')).toBe('이 문서 요약해줘')
    expect(placeholderTitle('see https://admin:pw1234@github.com/potenlab/team-ax/pull/123 please review')).toBe('see github.com please review')
    expect(placeholderTitle('```\nconst x = 1\n```\n이거 왜 에러나?')).toBe('이거 왜 에러나?')
    expect(placeholderTitle('```\nTypeError: x is undefined\n```')).toBe('TypeError: x is undefined') // only code: its first line
    expect(placeholderTitle('# 회의록 정리\n- 참석자: 김철수')).toBe('회의록 정리')
    expect(placeholderTitle('---\n\n**3분기 매출 보고서** 요약해 주세요.')).toBe('3분기 매출 보고서 요약해 주세요')
    expect(placeholderTitle('> [the plan](https://x.example/p) for `Q4`')).toBe('the plan for Q4')
    expect(placeholderTitle('1. 첫째 할 일')).toBe('첫째 할 일')
    expect(placeholderTitle('|---|---|\n| 이름 | 부서 |')).toBe('이름 부서')
  })

  test('about 40 characters, cut on a grapheme, a sentence or a space', () => {
    const en = placeholderTitle('Can you summarize the Q3 sales report for the board meeting next Tuesday? Also list the risks.')
    expect(en).toBe('Can you summarize the Q3 sales report…')
    const ko = placeholderTitle('이번 주 금요일까지 제출해야 하는 마케팅 캠페인 성과 분석 보고서를 같이 작성해 주실 수 있을까요?')
    expect(graphemes(ko).length).toBeLessThanOrEqual(PLACEHOLDER_MAX)
    expect(ko.endsWith('…')).toBe(true)
    expect(placeholderTitle('Please check the report. Then send it to the whole finance team before noon')).toBe('Please check the report')
    // family emoji are one grapheme each: never split
    const emoji = placeholderTitle('👨‍👩‍👧‍👦'.repeat(50) + ' 가족')
    expect(graphemes(emoji).length).toBeLessThanOrEqual(PLACEHOLDER_MAX)
    expect(emoji.replace(/…$/, '')).toBe('👨‍👩‍👧‍👦'.repeat(39))
  })

  test('nothing usable: an uploaded file name, else empty (the apps show "New chat" in their language)', () => {
    expect(placeholderTitle(TOKEN)).toBe('')
    expect(placeholderTitle('https://example.com/a?token=abc')).toBe('')
    expect(placeholderTitle(' \n\n---\n👍')).toBe('')
    expect(placeholderTitle('', [{ name: 'report-2026.pdf', source: 'upload' }])).toBe('report-2026.pdf')
    expect(placeholderTitle('', [{ name: 'salaries-2026.xlsx', source: 'team' }])).toBe('')
  })
})

describe("the AI's title", () => {
  test('trimmed, one line, no markdown, quotes or trailing punctuation, at most 60 characters', () => {
    expect(cleanAiTitle('  3분기 매출 보고서 요약  ')).toEqual({ ok: true, title: '3분기 매출 보고서 요약' })
    expect(cleanAiTitle('"Summarize Q3 report."')).toEqual({ ok: true, title: 'Summarize Q3 report' })
    expect(cleanAiTitle('**Fix login bug**')).toEqual({ ok: true, title: 'Fix login bug' })
    expect(cleanAiTitle('# 「회의록 정리」')).toEqual({ ok: true, title: '회의록 정리' })
    expect(cleanAiTitle('Line one\nline two')).toEqual({ ok: true, title: 'Line one line two' })
    expect(cleanAiTitle('‮evil​ title')).toEqual({ ok: true, title: 'evil title' })
    const long = cleanAiTitle('word '.repeat(30))
    expect(long.ok && graphemes(long.title).length <= AI_TITLE_MAX).toBe(true)
  })
  test('refused: a secret, or nothing left', () => {
    expect(cleanAiTitle(`Key ${TOKEN} setup`)).toEqual({ ok: false, reason: 'secret' })
    expect(cleanAiTitle('Deploy to https://admin:pw12345@db.example.com now')).toEqual({ ok: false, reason: 'secret' })
    expect(cleanAiTitle(`About ${QA_KEY}`)).toEqual({ ok: false, reason: 'secret' })
    expect(cleanAiTitle('Token economy basics')).toEqual({ ok: true, title: 'Token economy basics' })
    expect(cleanAiTitle('...')).toEqual({ ok: false, reason: 'empty' })
    expect(cleanAiTitle('a')).toEqual({ ok: false, reason: 'empty' })
  })
})

describe('a title the person gives', () => {
  test('secret-looking parts become [hidden key]; normal words stay (QA SEC-16, B-W47-3)', () => {
    expect(hideTitle(`${QA_KEY} plan`)).toBe(`${HIDDEN} plan`)
    expect(hideTitle(`Key ${TOKEN}`)).toBe(`Key ${HIDDEN}`)
    expect(hideTitle('Token economy notes')).toBe('Token economy notes')
    expect(hideTitle('stored abc12345xyz', (t) => t.replace('abc12345xyz', HIDDEN))).toBe(`stored ${HIDDEN}`)
  })
})

describe('existing chats', () => {
  test('the migration marks titles made before it as legacy (never renamed by the AI)', () => {
    const dir = path.join(WORK, 'b-chat-titles-migrate'), part = path.join(dir, 'before')
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(part, { recursive: true })
    for (const m of readMigrations().filter((m) => m.version < 209)) fs.copyFileSync(path.join(MIGRATIONS_DIR, m.name), path.join(part, m.name))
    const db = openDb(path.join(dir, 'app.db'), { migrationsDir: part })
    try {
      db.query("INSERT INTO users (id, username, name, role) VALUES ('alice','alice','Alice','member')").run()
      db.query("INSERT INTO chats (id, user_id, title) VALUES ('c1','alice','Weekly plan'), ('c2','alice','')").run()
      migrate(db, { backupDir: path.join(dir, 'backups') })
      expect(db.query('SELECT id, title_source FROM chats ORDER BY id').all()).toEqual([{ id: 'c1', title_source: 'legacy' }, { id: 'c2', title_source: 'auto' }])
    } finally { db.close() }
  })

  test('at start, once: secret-looking titles are masked or rebuilt from the first message; others stay', () => {
    const db = openDb(':memory:')
    try {
      db.query("INSERT INTO users (id, username, name, role) VALUES ('alice','alice','Alice','member')").run()
      const chat = (id: string, title: string) => db.query("INSERT INTO chats (id, user_id, title, title_source) VALUES (?, 'alice', ?, 'legacy')").run(id, title)
      chat('founder', TOKEN.slice(0, 59) + '…')
      db.query("INSERT INTO messages (id, chat_id, role, content) VALUES ('m1', 'founder', 'user', ?)").run(`${TOKEN}\n이 토큰으로 프로젝트 목록 가져와줘`)
      chat('inline', `키 ${TOKEN} 연결해줘`)
      chat('alone', `Bearer abc123def456ghi789`)
      chat('normal', 'Q3 report: shared/finance/2026-q3.xlsx')
      chat('qa', `${QA_KEY} 이게 무슨 뜻이야?`)
      chat('words', 'API key setup guide')
      db.query('DELETE FROM settings WHERE key = ?').run(TITLE_SCAN_KEY)
      expect(maskStoredTitles(db)).toBe(4)
      const titles = Object.fromEntries((db.query('SELECT id, title FROM chats').all() as { id: string; title: string }[]).map((r) => [r.id, r.title]))
      expect(titles).toEqual({ founder: '이 토큰으로 프로젝트 목록 가져와줘', inline: '키 연결해줘', alone: '', normal: 'Q3 report: shared/finance/2026-q3.xlsx',
        qa: '이게 무슨 뜻이야?', words: 'API key setup guide' })
      // once per detector version
      chat('later', TOKEN)
      expect(maskStoredTitles(db)).toBe(0)
    } finally { db.close() }
  })
})

describe('set_title in real turns', () => {
  let h: Harness
  let alice: TestSocket
  beforeAll(async () => {
    h = await startHarness({ name: 'b-chat-titles', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000 })
    alice = await h.ws('alice', { windowId: 'win-titles-1' })
    await alice.next('hello')
  })
  afterAll(async () => { alice?.close(); await h.close() })

  const source = (chatId: string) => (h.ctx.db.query('SELECT title_source s FROM chats WHERE id = ?').get(chatId) as { s: string }).s
  const tools = (content: string) => content.split(' | ')[0]!.split(',')

  test("first message: placeholder skips the pasted token, then the AI's title arrives live; no step, audited without the title", async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const content = `${TOKEN}\n결제 연동 문서 정리해줘\n` + fake({ echo: 'tools' }, { say: ' | ' }, { tool: 'set_title', args: { title: '결제 연동 문서 정리' }, sayResult: true }, { say: ' | ' }, { echo: 'system' })
    const sent = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const placeholder = await alice.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.chat?.title === '결제 연동 문서 정리해줘')
    expect(placeholder.data.chat!.title).not.toContain('aipm_')
    const named = await alice.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.chat?.title === '결제 연동 문서 정리', 20_000)
    expect(named.data.change).toBe('updated')
    const done = await alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 20_000)
    const [offered, result, system] = done.data.message.content.split(' | ')
    expect(offered!.split(',')).toContain('set_title')
    expect(JSON.parse(result!)).toEqual({ ok: true, title: '결제 연동 문서 정리' })
    expect(system).toContain('call set_title once')
    expect((done.data.message.steps as Step[]).some((s) => s.tool === 'set_title')).toBe(false)
    expect(source(chat.id)).toBe('ai')
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).title).toBe('결제 연동 문서 정리')
    const audit = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'set_title'").get(sent.turnId) as { summary: string }
    expect(audit.summary).toBe('set_title -> ok (11 characters)')
    // second message: named already, so not offered
    const second = await ask(h, alice, 'alice', chat.id, fake({ echo: 'tools' }, { say: ' | ' }, { echo: 'system' }))
    expect(tools(second.done.content)).not.toContain('set_title')
  })

  test('a secret in the title is refused and nothing changes; offered again with the second message, not the third', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const first = await ask(h, alice, 'alice', chat.id, '키 연결 도와줘\n' + fake({ tool: 'set_title', args: { title: `키 ${TOKEN}` }, sayResult: true }))
    expect(first.done.content).toContain('looks like it contains a key')
    let row = await h.api('alice').call(API.getChat, { params: { id: chat.id } })
    expect(row.title).toBe('키 연결 도와줘')
    expect(source(chat.id)).toBe('auto')
    const audit = h.ctx.db.query("SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = 'set_title'").get(first.started.turnId) as { summary: string; ok: number }
    expect(audit).toEqual({ summary: 'set_title -> refused (secret)', ok: 0 })
    const second = await ask(h, alice, 'alice', chat.id, fake({ echo: 'tools' }, { say: ' | ' }, { tool: 'set_title', args: { title: 'API 키 연결' }, sayResult: true }))
    expect(tools(second.done.content)).toContain('set_title')
    row = await h.api('alice').call(API.getChat, { params: { id: chat.id } })
    expect(row.title).toBe('API 키 연결')
    const third = await ask(h, alice, 'alice', chat.id, fake({ echo: 'tools' }))
    expect(tools(third.done.content)).not.toContain('set_title')
  })

  test('after the person renames the chat the AI does not rename it, also when the rename lands mid-turn', async () => {
    const renamed = await h.api('alice').call(API.createChat, { body: {} })
    await h.api('alice').call(API.updateChat, { params: { id: renamed.id }, body: { title: '내 제목' } })
    const r1 = await ask(h, alice, 'alice', renamed.id, fake({ echo: 'tools' }))
    expect(tools(r1.done.content)).not.toContain('set_title')
    expect((await h.api('alice').call(API.getChat, { params: { id: renamed.id } })).title).toBe('내 제목')

    // a title given when the chat is made is the person's own too
    const given = await h.api('alice').call(API.createChat, { body: { title: 'Budget' } })
    const r2 = await ask(h, alice, 'alice', given.id, fake({ echo: 'tools' }))
    expect(tools(r2.done.content)).not.toContain('set_title')

    const racing = await h.api('alice').call(API.createChat, { body: {} })
    const sent = await h.api('alice').call(API.sendMessage, { params: { id: racing.id }, body: {
      content: fake({ sleep: 1500 }, { tool: 'set_title', args: { title: 'AI title' }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await waitFor(() => (h.ctx.db.query("SELECT status FROM turns WHERE id = ?").get(sent.turnId) as { status: string }).status === 'running', { timeoutMs: 10_000 })
    await h.api('alice').call(API.updateChat, { params: { id: racing.id }, body: { title: 'Mine' } })
    const done = await alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 20_000)
    expect(done.data.message.content).toContain('already has its title')
    expect((await h.api('alice').call(API.getChat, { params: { id: racing.id } })).title).toBe('Mine')
    expect(source(racing.id)).toBe('user')
  })

  test('the Codex engine gets it through the same tool set', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { engine: 'codex' } })
    const r = await ask(h, alice, 'alice', chat.id, 'quarterly numbers\n' + fake({ tool: 'set_title', args: { title: 'Quarterly numbers review' }, sayResult: true }))
    expect(JSON.parse(r.done.content)).toEqual({ ok: true, title: 'Quarterly numbers review' })
    expect((r.done.steps as Step[]).some((s) => s.tool === 'set_title')).toBe(false)
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).title).toBe('Quarterly numbers review')
  })

  test('a scheduled run is not offered set_title and keeps its title', async () => {
    const rt = h.rt()
    const now = new Date()
    const made = rt.schedules.create('alice', { title: 'Digest', prompt: fake({ echo: 'tools' }), repeat: 'daily', time: '09:00' }, new Date(now.getTime() - 2 * 86_400_000))
    expect(rt.schedules.runDue(now)).toEqual([made.id])
    const chatId = rt.schedules.get('alice', made.id)!.last_chat_id!
    await waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    const answer = h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { content: string }
    expect(answer.content.split(',')).toContain('read')
    expect(answer.content.split(',')).not.toContain('set_title')
    expect(source(chatId)).toBe('schedule')
    expect((await h.api('alice').call(API.getChat, { params: { id: chatId } })).title.startsWith('⏰ Digest · ')).toBe(true)
  })
})

// without a WebSocket: the titles as the HTTP API shows them
describe('QA SEC-16 through the API', () => {
  let h: Harness
  beforeAll(async () => { h = await startHarness({ name: 'b-chat-titles-sec16', turnTimeoutMs: 60_000 }) })
  afterAll(async () => { await h.close() })

  test('QA SEC-16: the test key is not in the title of the list, search, one chat or a rename (B-W47-3, B-W5-1)', async () => {
    const api = h.api('alice')
    const chat = await api.call(API.createChat, { body: {} })
    const content = `${QA_KEY} 이게 무슨 뜻이야?\n` + fake({ say: 'A made-up test key.' })
    const sent = await api.call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(sent.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 30_000 })
    expect((await api.call(API.getChat, { params: { id: chat.id } })).title).toBe('이게 무슨 뜻이야?')
    const list = await api.call(API.listChats, { query: { limit: 50 } })
    expect(list.items.find((c) => c.id === chat.id)?.title).toBe('이게 무슨 뜻이야?')
    // search still finds the chat by its content; only the title is checked
    const found = await api.call(API.listChats, { query: { q: 'QA-FAKE' } })
    expect(found.items.map((c) => c.id)).toContain(chat.id)
    for (const c of [...list.items, ...found.items]) expect(c.title).not.toContain('FAKE-KEY')
    // the person's own message is kept as typed
    expect((h.ctx.db.query("SELECT content FROM messages WHERE chat_id = ? AND role = 'user'").get(chat.id) as { content: string }).content).toBe(content)
    const renamed = await api.call(API.updateChat, { params: { id: chat.id }, body: { title: `${QA_KEY} notes` } })
    expect(renamed.title).toBe(`${HIDDEN} notes`)
  })
})
