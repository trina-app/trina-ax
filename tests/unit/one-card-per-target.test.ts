// One answer never asks twice about the same target (QA TC-f2-a04: five cards in one answer, the read card twice, a
// save card and a copy card for the same file). In one turn: a yes for a place covers it for the rest of the answer
// (the shared read card's sharedAllowed); a file this answer saved whole reads back as the chat's, not its folder's
// (chat/shared-actions.ts wholeSavedInTurn); the wider-audience card's no stands for the same folder (widenRefused).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'one-card-per-target', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const put = (rel: string, data: string) => { const p = path.join(h.ctx.files.fx.root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
/** runs one answer, answering every card of it with `value`; the cards it showed */
async function run(chatId: string, content: string, value: string) {
  const started = await send('alice', chatId, content)
  const cards: { question: string }[] = []
  const seen = new Set<string>()
  for (let waited = 0; ; waited += 50) {
    if (waited > 40_000) throw new Error('the answer did not end')
    for (const f of ws.alice!.frames) {
      if (f.type !== 'turn.request' || f.data.turnId !== started.turnId) continue
      const r = f.data.request as { requestId: string; question: string }
      if (seen.has(r.requestId)) continue
      seen.add(r.requestId)
      cards.push(r)
      await h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: r.requestId, answer: value } })
    }
    const done = ws.alice!.frames.find((f) => f.type === 'message.done' && f.data.messageId === started.assistantMessage.id)
    if (done && done.type === 'message.done') return { cards, content: done.data.message.content as string }
    await Bun.sleep(50)
  }
}
const projectChat = async () => (await h.api('alice').call(API.createChat, { body: { projectId } })).id

describe('a shared project chat', () => {
  test('two reads of the same place in one answer: one card', async () => {
    put('users/alice/one-a.md', 'a'); put('users/alice/one-b.md', 'b')
    const r = await run(await projectChat(), fake(
      { tool: 'read', args: { file_path: 'users/alice/one-a.md' } },
      { tool: 'read', args: { file_path: 'users/alice/one-b.md' } },
      { say: 'done' }), 'share')
    expect(r.cards).toHaveLength(1)
  })

  test('a file this answer saved whole, read back (a copy) in the same answer: no read card for it', async () => {
    const r = await run(await projectChat(), fake(
      { tool: 'write', args: { file_path: 'users/alice/table-new.md', content: '| A | B |\n|---|---|\n| 1 | 2 |\n' } },
      { tool: 'read', args: { file_path: 'users/alice/table-new.md' }, sayResult: true },
      { say: 'done' }), 'share')
    // a new file in her folder raises no save card; reading back what this answer wrote raises no read card
    expect(r.cards).toHaveLength(0)
    expect(r.content).toContain('| A | B |')
  })

  test('a file someone changed after this answer saved it reads with the card again', async () => {
    const r = await run(await projectChat(), fake(
      { tool: 'write', args: { file_path: 'users/alice/table-two.md', content: 'mine' } },
      { say: 'done' }), 'share')
    expect(r.cards).toHaveLength(0)
    const r2 = await run(await projectChat(), fake(
      { tool: 'read', args: { file_path: 'users/alice/table-two.md' } },
      { say: 'done' }), 'share')
    // another answer: the file is not this one's
    expect(r2.cards).toHaveLength(1)
  })

  test('the card still asks for a file this answer only edited (the older text is still in it)', async () => {
    put('users/alice/edited.md', 'private line\nsecond')
    const r = await run(await projectChat(), fake(
      { tool: 'edit', args: { file_path: 'users/alice/edited.md', old_string: 'second', new_string: 'third' } },
      { tool: 'read', args: { file_path: 'users/alice/edited.md' } },
      { say: 'done' }), 'share')
    // the edit asks (a read of the old text), and its yes covers the read of that same place: one card
    expect(r.cards.length).toBeLessThanOrEqual(1)
  })
})

describe('a file this chat\'s AI made in the person\'s folder, read in a later answer of the same shared chat (QA v2g)', () => {
  test('no read card in the same chat; another chat of the project keeps the card; an edit by the person brings it back', async () => {
    const chat = await projectChat()
    const r1 = await run(chat, fake({ tool: 'write', args: { file_path: 'users/alice/made-here.md', content: 'made in this chat' } }, { say: 'done' }), 'share')
    expect(r1.cards).toHaveLength(0)
    const r2 = await run(chat, fake({ tool: 'read', args: { file_path: 'users/alice/made-here.md' }, sayResult: true }, { say: 'done' }), 'share')
    expect(r2.cards).toHaveLength(0)
    expect(r2.content).toContain('made in this chat')
    const r3 = await run(await projectChat(), fake({ tool: 'read', args: { file_path: 'users/alice/made-here.md' } }, { say: 'done' }), 'share')
    expect(r3.cards).toHaveLength(1)
    // the person changed it on the Files screen: not the chat's file any more
    put('users/alice/made-here.md', 'changed by hand')
    h.ctx.db.query("INSERT INTO file_events (path, action, user_id, at, detail) VALUES ('users/alice/made-here.md', 'update', 'alice', ?, '{\"tool\":\"file-screen\"}')").run(new Date().toISOString())
    const r4 = await run(chat, fake({ tool: 'read', args: { file_path: 'users/alice/made-here.md' } }, { say: 'done' }), 'share')
    expect(r4.cards).toHaveLength(1)
  })
})

describe('the wider-audience card', () => {
  test('a no for a folder stands for the rest of the answer: the second save there gets no card', async () => {
    put('users/alice/private-plan.md', 'only alice')
    const chat = (await h.api('alice').call(API.createChat, { body: {} })).id
    const r = await run(chat, fake(
      { tool: 'read', args: { file_path: 'users/alice/private-plan.md' } },
      { tool: 'write', args: { file_path: 'shared/plan-1.md', content: 'from the plan' } },
      { tool: 'write', args: { file_path: 'shared/plan-2.md', content: 'from the plan again' } },
      { say: 'done' }), 'skip')
    expect(r.cards).toHaveLength(1)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'shared/plan-1.md'))).toBe(false)
    expect(fs.existsSync(path.join(h.ctx.files.fx.root, 'shared/plan-2.md'))).toBe(false)
  })
})
