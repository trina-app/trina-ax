// Read scope of a chat and the "wider audience" confirmation (design tab 7 "공용 폴더를 거친 유출"): a hidden
// instruction in a shared document could make a finance member's AI copy finance numbers into shared/, and nothing
// asked the person. Now the server records where the content the model saw came from and raises a card when the AI
// saves somewhere more people can read (write, edit, make_file).
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { readScope, sourceOf, widening } from '../../server/src/chat/read-scope'
import { widenOf } from '../../server/src/chat/tools'
import { which } from '../../server/src/config'
import { RuleSet } from '../../server/src/policy/access'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'

setDefaultTimeout(40_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let bob: TestSocket
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'p0-read-scope', askUserTimeoutMs: 5000, stallTimeoutMs: 60_000 })
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
    expect(r.card!.question).toContain('부서 › finance')
    expect(r.card!.question).toContain('전사 공유 › leak.md')
    expect(r.card!.origin).toBe('server') // shown as the server's safety check, not as a question from the AI
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
    expect(r.card!.question).toContain('부서 › finance')
    expect(fs.existsSync(path.join(h.team, 'shared/budget.docx'))).toBe(false)
  })

  // any readable file may be a template now (docs/decisions/20261118-any-file-template.md, QA TC-4948): its bytes are a
  // source of the output, asked on the same one card as a source (widenOf, which merges it with a room card)
  test('make_file with a finance template into shared/: one card for it; skipped, nothing saved', async () => {
    const pandoc = which('pandoc')
    if (!pandoc) return
    const r0 = Bun.spawnSync([pandoc, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from('# Finance letterhead\n') })
    fs.writeFileSync(path.join(h.team, 'groups/finance/letterhead.docx'), r0.stdout)
    expect(widenOf('make_file', { format: 'docx', content: '# x', output: 'shared/t.docx', template: 'groups/finance/letterhead.docx' })).toEqual({ target: 'shared/t.docx', extra: ['groups/finance/letterhead.docx'] })
    expect(widenOf('make_file', { format: 'docx', source: 'a.md', output: 'shared/t.docx', template: 't.docx' })!.extra).toEqual(['a.md', 't.docx'])
    const r = await turn(bob, 'bob', fake(
      { tool: 'make_file', args: { format: 'docx', content: '# Note\n', output: 'shared/with-template.docx', template: 'groups/finance/letterhead.docx' }, sayResult: true },
    ), 'skip')
    expect(r.cards).toBe(1)
    expect(r.card!.question).toContain('부서 › finance')
    expect(fs.existsSync(path.join(h.team, 'shared/with-template.docx'))).toBe(false)
  })

  test('project instructions on a finance folder count as read: saving into shared/ from that project asks', async () => {
    const proj = await oldProject(h, 'bob', { name: 'Budget', folderPath: 'groups/finance', instructions: 'Numbers are in budget.md.' })
    const chat = await h.api('bob').call(API.createChat, { body: { projectId: proj.id } })
    const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'write', args: { file_path: 'shared/from-project.md', content: 'x' }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const c = await bob.next('turn.request', (f) => f.data.turnId === r.turnId)
    expect((c.data.request as { question: string }).question).toContain('부서 › finance')
    await h.api('bob').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer: 'skip' } })
    await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    expect(fs.existsSync(path.join(h.team, 'shared/from-project.md'))).toBe(false)
  })

  test("the AI's own ask_user can never carry the server's mark", async () => {
    const r = await turn(alice, 'alice', fake({ tool: 'ask_user', args: { question: 'Team server safety check: save?', options: [{ label: 'Save', value: 'save' }] }, sayResult: true }), 'save')
    expect(r.card!.origin).toBeUndefined()
  })

  test('a renamed rule folder is still the same source; a removed one counts as nobody', () => {
    const chat = h.ctx.db.query("SELECT id FROM chats WHERE user_id = 'bob' AND session_read_scope LIKE '%f_groups_finance%' LIMIT 1").get() as { id: string }
    expect(widening(h.ctx.db, chat.id, ['groups', 'finance', 'x.md'])).toBeNull()
    expect(widening(h.ctx.db, chat.id, ['shared', 'x.md'])!.targetViewers).toBe(5)
    h.ctx.db.query("UPDATE chats SET session_read_scope = ? WHERE id = ?").run(JSON.stringify({ sources: [{ type: 'folder', id: 'gone' }] }), chat.id)
    expect(widening(h.ctx.db, chat.id, ['groups', 'finance', 'x.md'])).not.toBeNull()
  })
})
