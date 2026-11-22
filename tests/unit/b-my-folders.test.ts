// my_folders through a real turn (server/src/chat/my-folders.ts; docs/decisions/20261122-demo-permission-scene.md): the
// AI reads a folder it cannot find, calls my_folders, and the step carries the card's record (Step.folders) from the
// server's rules. Only the person whose turn it was ever gets that record (ChatStore.viewSteps).
// The fixture team (tests/lib/fixtures.ts): alice in Marketing, bob in Finance, carol admin, dana owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, uuidv7, type Step } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { ChatStore } from '../../server/src/chat/store'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')

let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-my-folders', stallTimeoutMs: 60_000 })
  for (const u of ['alice']) { socks[u] = await h.ws(u, { windowId: `win-mf-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h?.close() })

async function turn(who: string, content: string, inChat?: string) {
  const chatId = inChat ?? (await h.api(who).call(API.createChat, { body: {} })).id
  const r = await h.api(who).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await socks[who]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
  return { chatId, content: done.data.message.content as string, steps: done.data.message.steps as Step[] }
}

describe('the card under the answer', () => {
  test('a folder that is not found, then my_folders: the step lists the folders with their access, nothing hidden', async () => {
    const r = await turn('alice', ['Show me the management folder',
      fake({ tool: 'list', args: { path: 'groups/finance' }, sayResult: true }),
      fake({ tool: 'my_folders', args: {}, sayResult: true })].join('\n'))
    expect(r.content).toContain('not found or no access')
    const step = r.steps.find((s) => s.tool === 'my_folders')!
    expect(step.label).toBe('Check the folders open to you')
    expect(step.folders).toContainEqual({ path: 'shared', access: 'edit' })
    expect(step.folders).toContainEqual({ path: 'groups/marketing', access: 'edit' })
    expect(step.folders).toContainEqual({ path: 'skills', access: 'view' })
    expect(step.folders?.at(-1)).toEqual({ path: 'users/alice', access: 'edit' })
    // the folder she asked about and every other one closed to her are not there, on the card or in the AI's text
    expect(JSON.stringify(step)).not.toMatch(/finance|salaries/)
    expect(r.content).not.toMatch(/- groups\/finance\/ \(|salaries/)
    // another viewer (the chat shared later) never gets the record
    const store = new ChatStore(h.ctx.db)
    const view = { viewer: 'bob', canList: () => true, canRead: () => true, failed: '', runner: false }
    const seen = store.viewSteps({ chat_id: r.chatId }, r.steps, view)
    expect(seen.find((s) => s.tool === 'my_folders')?.folders).toBeUndefined()
    expect(store.viewSteps({ chat_id: r.chatId }, r.steps, { ...view, viewer: 'alice', runner: true }).find((s) => s.tool === 'my_folders')?.folders?.length).toBe(step.folders!.length)
  })
})

describe('where it is offered (review of #353: the tool set is built after othersWrote is known)', () => {
  test('her own chat offers it; a chat someone else wrote in does not offer it (nor looking_at)', async () => {
    const own = await turn('alice', fake({ echo: 'tools' }))
    expect(own.content.split(',')).toContain('my_folders')
    expect(own.content.split(',')).toContain('looking_at')
    // a chat with bob's message and an answer to it (the active leaf), then alice's turn
    const chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
    const q = uuidv7(), ans = uuidv7(), when = new Date(Date.now() - 60_000).toISOString()
    h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status, created_at) VALUES (?, ?, 'user', 'bob', 'which folders are there?', 'done', ?)").run(q, chatId, when)
    h.ctx.db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, created_at) VALUES (?, ?, ?, 'assistant', 'ok', 'done', ?)").run(ans, chatId, q, when)
    h.ctx.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(ans, chatId)
    const others = await turn('alice', fake({ echo: 'tools' }), chatId)
    expect(others.content).not.toBe('')
    expect(others.content.split(',')).not.toContain('my_folders')
    expect(others.content.split(',')).not.toContain('looking_at')
  })
})
