// my_folders through a real turn (server/src/chat/my-folders.ts; docs/decisions/20261122-demo-permission-scene.md): the
// AI reads a folder it cannot find, calls my_folders, and the step carries the card's record (Step.folders) from the
// server's rules. Only the person whose turn it was ever gets that record (ChatStore.viewSteps).
// The fixture team (tests/lib/fixtures.ts): alice in Marketing, bob in Finance, carol admin, dana owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Step } from '@mycel/shared/api'
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

async function turn(who: string, content: string) {
  const chatId = (await h.api(who).call(API.createChat, { body: {} })).id
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
