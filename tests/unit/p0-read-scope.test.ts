// Read scope of a chat and the "wider audience" confirmation (design tab 7 "공용 폴더를 거친 유출"): a hidden
// instruction in a shared document could make a finance member's AI copy finance numbers into shared/, and nothing
// asked the person. Now the server records where the content the model saw came from and raises a card when the AI
// saves somewhere more people can read (write, edit, make_file).
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { readScope, sourceOf, widening } from '../../server/src/chat/read-scope'
import { RuleSet } from '../../server/src/policy/access'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let bob: TestSocket
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'p0-read-scope', askUserTimeoutMs: 5000, turnTimeoutMs: 60_000 })
  bob = await h.ws('bob', { windowId: 'win-p0-bob' })
  alice = await h.ws('alice', { windowId: 'win-p0-alice' })
  await bob.next('hello')
  await alice.next('hello')
})
afterAll(async () => { bob?.close(); alice?.close(); await h?.close() })

async function turn(sock: TestSocket, user: string, content: string, answer?: string | null) {
  const chat = await h.api(user).call(API.createChat, { body: {} })
  const r = await h.api(user).call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  let card: { question: string; origin?: string } | null = null
  if (answer !== undefined) {
    const c = await sock.next('turn.request', (f) => f.data.turnId === r.turnId)
    card = c.data.request as { question: string; origin?: string }
    await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer } })
  }
  const done = await sock.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  const cards = sock.frames.filter((f) => f.type === 'turn.request' && f.data.turnId === r.turnId).length
  return { chatId: chat.id as string, turnId: r.turnId, content: done.data.message.content, card, cards }
}

describe('sources and viewers', () => {
  test('a file maps to its nearest rule folder, a personal folder to its person, the rest to the team default', () => {
    const rules = RuleSet.load(h.ctx.db)
    expect(sourceOf(h.ctx.db, rules, 'groups/finance/budget.md')).toEqual({ type: 'folder', id: 'f_groups_finance' })
    expect(sourceOf(h.ctx.db, rules, 'groups/marketing/salaries/2026.md')).toEqual({ type: 'folder', id: 'f_groups_marketing_salaries' })
    expect(sourceOf(h.ctx.db, rules, 'users/alice/todo.md')).toEqual({ type: 'user', id: 'alice' })
    expect(sourceOf(h.ctx.db, rules, 'CLAUDE.md')).toEqual({ type: 'root' })
  })
})

describe('the AI saves what it read', () => {
  test('finance content into shared/ (everyone sees it): a card; declining keeps the file from being written', async () => {
    const r = await turn(bob, 'bob', fake(
      { tool: 'read', args: { file_path: 'groups/finance/budget.md' } },
      { tool: 'write', args: { file_path: 'shared/leak.md', content: 'CANARY-FIN-7731' }, sayResult: true },
    ), 'skip')
    expect(r.card!.question).toContain('groups/finance/')
    expect(r.card!.question).toContain('shared/leak.md')
    expect(r.content).toContain('did not allow saving')
    expect(fs.existsSync(path.join(h.team, 'shared/leak.md'))).toBe(false)
    const a = h.ctx.db.query("SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = 'write'").get(r.turnId) as { summary: string; ok: number }
    expect(a).toEqual({ summary: 'write -> not allowed by the user (wider audience)', ok: 0 })
    expect(readScope(h.ctx.db, r.chatId)).toEqual([{ type: 'folder', id: 'f_groups_finance' }])
  })

  test('allowed once: saved, and the same folder is not asked again in that turn', async () => {
    const r = await turn(bob, 'bob', fake(
      { tool: 'grep', args: { pattern: 'CANARY', path: 'groups/finance', output_mode: 'content' } },
      { tool: 'write', args: { file_path: 'shared/ok-1.md', content: 'summary' }, sayResult: true },
      { tool: 'write', args: { file_path: 'shared/ok-2.md', content: 'summary' }, sayResult: true },
    ), 'save')
    expect(r.cards).toBe(1)
    expect(fs.existsSync(path.join(h.team, 'shared/ok-1.md'))).toBe(true)
    expect(fs.existsSync(path.join(h.team, 'shared/ok-2.md'))).toBe(true)
  })

  test('no card when the target is not wider: finance into finance, shared into shared, nothing read yet', async () => {
    const a = await turn(bob, 'bob', fake(
      { tool: 'read', args: { file_path: 'groups/finance/budget.md' } },
      { tool: 'write', args: { file_path: 'groups/finance/summary.md', content: 'x' }, sayResult: true },
    ))
    expect(a.content).toContain('Created groups/finance/summary.md')
    const b = await turn(bob, 'bob', fake(
      { tool: 'read', args: { file_path: 'shared/glossary.md' } },
      { tool: 'write', args: { file_path: 'shared/glossary-copy.md', content: 'x' }, sayResult: true },
    ))
    expect(b.content).toContain('Created shared/glossary-copy.md')
    const c = await turn(bob, 'bob', fake({ tool: 'write', args: { file_path: 'shared/fresh.md', content: 'x' }, sayResult: true }))
    expect(c.content).toContain('Created shared/fresh.md')
    expect(a.cards + b.cards + c.cards).toBe(0)
  })

  test('a personal file into a group folder asks too (only the person could see it)', async () => {
    const r = await turn(alice, 'alice', fake(
      { tool: 'read', args: { file_path: 'users/alice/todo.md' } },
      { tool: 'edit', args: { file_path: 'groups/marketing/campaign-brief.md', old_string: 'Goal:', new_string: 'GOAL:' }, sayResult: true },
    ), null)
    expect(r.card!.question).toContain('your personal folder')
    expect(r.content).toContain('did not allow saving')
  })

  test('make_file from a finance source into shared/ asks before converting', async () => {
    const r = await turn(bob, 'bob', fake(
      { tool: 'make_file', args: { format: 'docx', source: 'groups/finance/budget.md', output: 'shared/budget.docx' }, sayResult: true },
    ), 'skip')
    expect(r.card!.question).toContain('groups/finance/')
    expect(fs.existsSync(path.join(h.team, 'shared/budget.docx'))).toBe(false)
  })

  test('project instructions on a finance folder count as read: saving into shared/ from that project asks', async () => {
    const proj = await h.api('bob').call(API.createProject, { body: { name: 'Budget', folderPath: 'groups/finance', instructions: 'Numbers are in budget.md.' } })
    const chat = await h.api('bob').call(API.createChat, { body: { projectId: proj.id } })
    const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'write', args: { file_path: 'shared/from-project.md', content: 'x' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const c = await bob.next('turn.request', (f) => f.data.turnId === r.turnId)
    expect((c.data.request as { question: string }).question).toContain('groups/finance/')
    await h.api('bob').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'skip' } })
    await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    expect(fs.existsSync(path.join(h.team, 'shared/from-project.md'))).toBe(false)
  })

  test('a renamed rule folder is still the same source; a removed one counts as nobody', () => {
    const chat = h.ctx.db.query("SELECT id FROM chats WHERE user_id = 'bob' AND session_read_scope LIKE '%f_groups_finance%' LIMIT 1").get() as { id: string }
    expect(widening(h.ctx.db, chat.id, ['groups', 'finance', 'x.md'])).toBeNull()
    expect(widening(h.ctx.db, chat.id, ['shared', 'x.md'])!.targetViewers).toBe(5)
    h.ctx.db.query("UPDATE chats SET session_read_scope = ? WHERE id = ?").run(JSON.stringify({ sources: [{ type: 'folder', id: 'gone' }] }), chat.id)
    expect(widening(h.ctx.db, chat.id, ['groups', 'finance', 'x.md'])).not.toBeNull()
  })
})
