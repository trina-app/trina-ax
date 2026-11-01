// "참고한 파일" under each answer (docs/DECISIONS.md "Sources under each answer") through whole chat turns: the server
// records what the answer's agents read, searched or grepped with content (names alone are left out), marks what only a
// sub-agent opened, keeps one list per answer (a regenerated answer has its own), and the three engines give the same
// list because they use the same tool handlers. Opening the list re-checks every file for the viewer now.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type EngineId, type MessageSources } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { setSearchEmbedderForTests } from '../../server/src/tools/search'
import { writeApiEngine } from '../../server/src/engine/api-agent'
import { setMemberChoice } from '../../server/src/admin/engine-choice'
import type { Embed } from '../../server/src/search/semantic'
import { which } from '../../server/src/config'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const read = (file_path: string) => ({ tool: 'read', args: { file_path } })
// letters -> a count vector: texts sharing words are close (no model)
const embed: Embed = async (texts) => texts.map((t) => {
  const v = new Float32Array(384)
  for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) { let h = 0; for (const c of w) h = (h * 31 + c.codePointAt(0)!) % 384; v[h]! += 1 }
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
})

/** the same five files for every engine: two reads, three search passages (meetings), a names-only grep */
const SEARCH = { tool: 'search', args: { query: 'weekly sync decisions action items follow up', path: 'shared/meetings', limit: 3 } }
const NAMES = { tool: 'grep', args: { pattern: 'Owner', path: 'groups/marketing' } }
const PLAN = [read('shared/glossary.md'), read('shared/policies/remote-work-v2.md'), SEARCH, NAMES]

let h: Harness
let alice: TestSocket
let mock: ReturnType<typeof Bun.serve>
const script: string[] = []
function sse(calls: { id: string; name: string; args: unknown }[], text?: string): string {
  const lines: string[] = []
  if (text) lines.push(JSON.stringify({ choices: [{ delta: { content: text } }] }))
  calls.forEach((c, i) => lines.push(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] })))
  lines.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  return lines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n'
}

// search by meaning is off by default (MYCEL_SEMANTIC=on turns it on); these turns use it with a stand-in embedder
const semanticBefore = process.env.MYCEL_SEMANTIC
beforeAll(async () => {
  process.env.MYCEL_SEMANTIC = 'on'
  setSearchEmbedderForTests(embed)
  mock = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { if (req.method === 'GET') return Response.json({ data: [{ id: 'm-1' }] }); await req.json(); return new Response(script.shift() ?? sse([], '(no script)')) } })
  h = await startHarness({ name: 'b-answer-sources' })
  writeApiEngine(h.ctx.config.dataDir, { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1' })
  const confs = h.rt().engines.get()
  confs.api = { baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm-1', label: 'M1', key: null }
  delete confs.problems.api
  setMemberChoice(h.ctx, { mode: 'everyone', groupIds: [], userIds: [] })
  alice = await h.ws('alice', { windowId: 'win-alice-sources' })
  await alice.next('hello')
})
afterAll(async () => {
  setSearchEmbedderForTests(null)
  if (semanticBefore === undefined) delete process.env.MYCEL_SEMANTIC; else process.env.MYCEL_SEMANTIC = semanticBefore
  alice?.close(); await h.close(); mock.stop(true)
})

const sourcesOf = (chatId: string, messageId: string, user = 'alice'): Promise<MessageSources> => h.api(user).call(API.messageSources, { params: { id: chatId, messageId } })
const summary = (s: MessageSources) => s.files.map((f) => ({ path: f.path, via: [...f.via] as string[], ...(f.subagent ? { subagent: true } : {}) }))
const FIVE: { path: string; via: string[] }[] = [
  { path: 'shared/glossary.md', via: ['read'] },
  { path: 'shared/policies/remote-work-v2.md', via: ['read'] },
]

describe('what an answer read', () => {
  let claude: { chatId: string; messageId: string; turnId: string }
  test('two reads, three search passages and a names-only grep: five files, in the order first opened', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake(...PLAN, { say: 'Done.' }))
    expect(r.done.status).toBe('done')
    expect(r.done.sourceCount).toBe(5)
    const s = await sourcesOf(chat.id, r.done.id)
    expect(s.unavailable).toBe(0)
    expect(summary(s).slice(0, 2)).toEqual(FIVE)
    const searched = summary(s).slice(2)
    expect(searched).toHaveLength(3)
    expect(searched.every((f) => f.path.startsWith('shared/meetings/') && f.via.join() === 'search')).toBe(true)
    // the names-only grep added nothing
    expect(s.files.some((f) => f.path.startsWith('groups/marketing/'))).toBe(false)
    claude = { chatId: chat.id, messageId: r.done.id, turnId: r.started.turnId }
  })
  test('the search tool gives the AI labels and links it can use in its answer', async () => {
    const out = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'search'").get(claude.turnId) as { summary: string }
    expect(out.summary).toMatch(/-> 3 passages/)
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'search', args: { query: 'weekly sync decisions action items', path: 'shared/meetings', limit: 1 }, sayResult: true }))
    expect(r.done.content).toMatch(/^1\. meeting-\d\d-[\d-]+\.md — shared\/meetings\/meeting-\d\d-[\d-]+\.md \(match \d\.\d\d\)\n {3}link: \[meeting-\d\d-[\d-]+\.md\]\(\/files\/view\?path=shared%2Fmeetings%2Fmeeting-\d\d-[\d-]+\.md\)\n/m)
    if (which('pdftotext')) {
      // a document's place: the page of the passage, in the label and the link (alice's language: Korean)
      const pdf = await ask(h, alice, 'alice', chat.id, fake({ tool: 'search', args: { query: 'Annual leave is 17 days', path: 'shared', limit: 1 }, sayResult: true }))
      expect(pdf.done.content).toContain('1. handbook.pdf · p.1 — shared/handbook.pdf (match ')
      expect(pdf.done.content).toContain('link: [handbook.pdf · p.1](/files/view?path=shared%2Fhandbook.pdf&page=1)')
    }
  })
  test('a regenerated answer has its own list; the first one keeps its own', async () => {
    const r = await h.api('alice').call(API.regenerate, { params: { id: claude.chatId, messageId: claude.messageId }, body: {} })
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    expect(done.data.message.sourceCount).toBe(5)
    const rows = (id: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM message_sources WHERE message_id = ?').get(id) as { n: number }).n
    expect(rows(claude.messageId)).toBe(5)
    expect(rows(r.assistantMessage.id)).toBe(5)
  })
  test('what only a sub-agent opened is marked; a file the main AI read too is not', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake(read('shared/glossary.md'), { agents: [
      { id: 'toolu_SRC1', type: 'Explore', description: 'Read the plan', steps: [read('shared/edit-me.md'), read('shared/glossary.md')] },
    ] }, { say: 'Done.' }))
    expect(r.done.status).toBe('done')
    expect(summary(await sourcesOf(chat.id, r.done.id))).toEqual([
      { path: 'shared/glossary.md', via: ['read'] },
      { path: 'shared/edit-me.md', via: ['read'], subagent: true },
    ])
  })
  test('an answer that read nothing has no list', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ tool: 'list', args: { path: 'shared' } }, { say: 'Only names.' }))
    expect(r.done.sourceCount).toBeUndefined()
    expect(await sourcesOf(chat.id, r.done.id)).toEqual({ files: [], unavailable: 0 })
  })
  test('Codex and the API engine give the same list (the same tool handlers)', async () => {
    const codexChat = await h.api('alice').call(API.createChat, { body: { engine: 'codex' as EngineId } })
    const c = await ask(h, alice, 'alice', codexChat.id, fake(...PLAN, { say: 'Done.' }))
    expect(c.done.engine).toBe('codex')
    const first = await sourcesOf(claude.chatId, claude.messageId)
    expect(summary(await sourcesOf(codexChat.id, c.done.id))).toEqual(summary(first))

    script.push(sse(PLAN.map((p, i) => ({ id: `c${i}`, name: p.tool, args: p.args }))), sse([], 'Done.'))
    const apiChat = await h.api('alice').call(API.createChat, { body: { engine: 'api' as EngineId } })
    const a = await h.api('alice').call(API.sendMessage, { params: { id: apiChat.id }, body: { content: 'look', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [], engine: 'api' as EngineId } })
    await waitFor(() => (h.ctx.db.query('SELECT status FROM messages WHERE id = ?').get(a.assistantMessage.id) as { status: string }).status !== 'streaming', { timeoutMs: 20_000 })
    expect(summary(await sourcesOf(apiChat.id, a.assistantMessage.id))).toEqual(summary(first))
  })
})

describe('the list is checked for the viewer each time it is shown', () => {
  test('a file the viewer lost access to, or that was deleted or moved, is only counted: no name or path in the answer', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    fs.writeFileSync(path.join(h.team, 'shared', 'to-delete.md'), '# 지울 메모\n')
    fs.writeFileSync(path.join(h.team, 'shared', 'to-move.md'), '# 옮길 메모\n')
    const r = await ask(h, alice, 'alice', chat.id, fake(read('groups/marketing/campaign-brief.md'), read('shared/to-delete.md'), read('shared/to-move.md'), read('shared/glossary.md'), { say: 'Done.' }))
    expect(r.done.sourceCount).toBe(4)
    expect((await sourcesOf(chat.id, r.done.id)).files).toHaveLength(4)
    // alice leaves marketing; one file is deleted, one moved
    const groups = h.ctx.db.query("SELECT group_id FROM group_members WHERE user_id = 'alice'").all() as { group_id: string }[]
    h.ctx.db.query("DELETE FROM group_members WHERE user_id = 'alice'").run()
    fs.rmSync(path.join(h.team, 'shared', 'to-delete.md'))
    fs.renameSync(path.join(h.team, 'shared', 'to-move.md'), path.join(h.team, 'shared', 'moved.md'))
    try {
      const res = await h.req('alice', `/api/chats/${chat.id}/messages/${r.done.id}/sources`)
      const raw = await res.text()
      expect(res.status).toBe(200)
      expect(JSON.parse(raw)).toEqual({ files: [{ path: 'shared/glossary.md', name: 'glossary.md', locs: [], via: ['read'] }], unavailable: 3 })
      for (const name of ['campaign-brief', 'to-delete', 'to-move', 'marketing']) expect(raw).not.toContain(name)
      // the count under the answer stays what the AI opened
      const page = await h.api('alice').call(API.listMessages, { params: { id: chat.id } })
      expect(page.items.find((m) => m.id === r.done.id)?.sourceCount).toBe(4)
    } finally {
      for (const g of groups) h.ctx.db.query("INSERT INTO group_members (group_id, user_id) VALUES (?, 'alice')").run(g.group_id)
    }
    // access back: the file shows again (it is checked each time, nothing was deleted from the list)
    expect((await sourcesOf(chat.id, r.done.id)).files.map((f) => f.path)).toContain('groups/marketing/campaign-brief.md')
  })
  test('someone else gets 404 for the list of alice\'s answer', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake(read('shared/glossary.md'), { say: 'Done.' }))
    for (const who of ['bob', 'carol', 'dana']) {
      const res = await h.req(who, `/api/chats/${chat.id}/messages/${r.done.id}/sources`)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('glossary')
    }
  })
  test('deleting the chat for good takes the list with it', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake(read('shared/glossary.md'), { say: 'Done.' }))
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM message_sources WHERE message_id = ?').get(r.done.id) as { n: number }).n).toBe(1)
    h.ctx.db.query('DELETE FROM chats WHERE id = ?').run(chat.id)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM message_sources WHERE message_id = ?').get(r.done.id) as { n: number }).n).toBe(0)
  })
})
