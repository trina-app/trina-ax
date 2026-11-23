// While the AI waits on a person's card in a shared chat, the others learn who it waits for and nothing else: no question,
// option, file name, command, host or service of any kind of card, over the socket or any list.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'

setDefaultTimeout(60_000)
const SECRET = 'S3CRET-card-detail'
const cards = [
  { kind: 'ask_user', requestId: 'leak-ask', question: `Delete ${SECRET}.xlsx?`, origin: 'server', options: [{ label: `Run rm ${SECRET}`, value: 'yes', description: SECRET }] },
  { kind: 'ask_user', requestId: 'leak-picture', question: `Which ${SECRET} picture?`, options: [{ label: SECRET, value: 'a' }] },
  { kind: 'browser_site', requestId: 'leak-site', host: `${SECRET}.example.com`, reason: SECRET },
  { kind: 'connect_service', requestId: 'leak-connect', name: SECRET, integrationId: SECRET },
]
let h: Harness
let alice: TestSocket, bob: TestSocket
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'shared-chat-waits-for', askUserTimeoutMs: 1500, stallTimeoutMs: 60_000 })
  alice = await h.ws('alice'); await alice.next('hello')
  bob = await h.ws('bob'); await bob.next('hello')
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { alice?.close(); bob?.close(); await h?.close() })

for (const window of [null, '33333333-3333-4333-8333-333333333333']) for (const card of cards) {
  test(`${card.requestId} (${window ? 'one window' : 'every window'}): only the name reaches the others`, async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    const from = bob.frames.length
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: '@fake ' + JSON.stringify({ sleep: 1800 }) + '\n@fake ' + JSON.stringify({ say: 'ok' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    await waitFor(() => !!h.rt().execFor(r.turnId), { timeoutMs: 5000 })
    const exec = h.rt().execFor(r.turnId) as unknown as { showCard(c: unknown, o: { window: string | null; timeoutMs: number }): Promise<unknown> }
    void exec.showCard({ ...card, requestId: `${card.requestId}-${crypto.randomUUID()}` }, { window, timeoutMs: 600 })
    expect(await waitFor(async () => (await h.api('bob').call(API.getChat, { params: { id: chat.id } })).waitsFor === 'Alice Kim', { timeoutMs: 2000 })).toBe(true)
    const seen = JSON.stringify([
      await h.api('bob').call(API.getChat, { params: { id: chat.id } }),
      await h.api('bob').call(API.listChats, { query: {} }),
      await h.api('bob').call(API.listChatGroups, {}),
      await h.api('bob').call(API.listTurnRequests, { params: { id: chat.id } }),
      await h.api('bob').call(API.listMessages, { params: { id: chat.id }, query: {} }),
      bob.frames.slice(from),
    ])
    expect(seen).not.toContain(SECRET)
    expect(seen).not.toContain(card.requestId)
    await waitFor(() => !h.rt().activeTurn(chat.id), { timeoutMs: 15_000 })
  })
}

test("a step line that repeats a card (question, command, address) is the asker's: the others read its verb", async () => {
  const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'go', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await waitFor(() => !h.rt().activeTurn(chat.id), { timeoutMs: 15_000 })
  const steps = [
    { id: 's1', kind: 'tool', tool: 'ask_user', label: `Question: ${SECRET}`, status: 'ok', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
    { id: 's2', kind: 'tool', tool: 'box_shell', label: `Run · rm ${SECRET}`, status: 'ok', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
    { id: 's3', kind: 'tool', tool: 'web_fetch', label: `Fetch · https://${SECRET}.example.com`, status: 'ok', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
    { id: 's4', kind: 'tool', tool: 'connect_service', label: `Connect · ${SECRET}`, status: 'ok', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
    { id: 's5', kind: 'tool', tool: 'remember', label: `Remembered: ${SECRET}`, status: 'ok', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
  ]
  h.ctx.db.query('UPDATE messages SET steps = ? WHERE id = ?').run(JSON.stringify(steps), r.assistantMessage.id)
  const forBob = await h.api('bob').call(API.listMessages, { params: { id: chat.id }, query: {} })
  expect(JSON.stringify(forBob)).not.toContain(SECRET)
  const forAlice = await h.api('alice').call(API.listMessages, { params: { id: chat.id }, query: {} })
  expect(JSON.stringify(forAlice)).toContain(SECRET)
})
