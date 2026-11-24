// While the AI waits on a person's card in a shared chat, the others learn who it waits for and nothing else: no question,
// option, file name, command, host or service of any kind of card, over the socket or any list.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { BROWSER_STEP_VERB, FILE_STEP_VERB } from '@mycel/shared'
import { OPEN_LABEL_TOOLS, PATH_LABEL_TOOLS, stepRepeatsCard } from '../../server/src/chat/open-questions'

setDefaultTimeout(60_000)
const SECRET = 'S3CRET-card-detail'
const WIN = '33333333-3333-4333-8333-333333333333'
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
  alice = await h.ws('alice', { windowId: WIN }); await alice.next('hello')
  bob = await h.ws('bob'); await bob.next('hello')
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { alice?.close(); bob?.close(); await h?.close() })

for (const window of [null, WIN]) for (const card of cards) {
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

const stamp = () => ({ status: 'ok', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() })
test("a step line that repeats a card (question, address, service) is the asker's; a connected service's tool name too", async () => {
  const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'go', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await waitFor(() => !h.rt().activeTurn(chat.id), { timeoutMs: 15_000 })
  const image = { path: 'projects/falcon/shot.png', alt: 'shot' }
  const steps = [
    { id: 's1', kind: 'tool', tool: 'ask_user', label: `Question: ${SECRET}`, ...stamp() },
    { id: 's3', kind: 'tool', tool: 'web_fetch', label: `Fetch · https://${SECRET}.example.com`, ...stamp() },
    { id: 's4', kind: 'tool', tool: 'connect_service', label: `Connect · ${SECRET}`, ...stamp() },
    { id: 's5', kind: 'tool', tool: 'remember', label: `Remembered: ${SECRET}`, ...stamp() },
    { id: 's6', kind: 'tool', tool: `my_gmail__send_${SECRET}`, label: `Send ${SECRET}`, ...stamp() },
    { id: 's6b', kind: 'tool', tool: `team_linear__create_${SECRET}`, label: `Create ${SECRET}`, ...stamp() },
    { id: 's6c', kind: 'tool', tool: 'call_tool', label: `Call ${SECRET}`, ...stamp() },
    { id: 's6d', kind: 'tool', tool: 'api_request', label: `POST ${SECRET}`, ...stamp() },
    { id: 's7', kind: 'tool', tool: 'save_url', label: `Save · https://${SECRET}.example.com`, ...stamp() },
    { id: 's8', kind: 'browser', tool: 'navigate', label: `Open ${SECRET}`, images: [image], ...stamp() },
  ]
  h.ctx.db.query('UPDATE messages SET steps = ? WHERE id = ?').run(JSON.stringify(steps), r.assistantMessage.id)
  const forBob = await h.api('bob').call(API.listMessages, { params: { id: chat.id }, query: {} })
  expect(JSON.stringify(forBob)).not.toContain(SECRET)
  for (const name of ['my_gmail__', 'team_linear__', 'call_tool', 'api_request']) expect(JSON.stringify(forBob)).not.toContain(name)
  const bobSteps = forBob.items.find((m) => m.id === r.assistantMessage.id)!.steps
  // a screenshot the AI shared to the chat stays
  expect(bobSteps.find((s) => s.id === 's8')?.images).toEqual([image] as never)
  expect(JSON.stringify(await h.api('alice').call(API.listMessages, { params: { id: chat.id }, query: {} }))).toContain(SECRET)
})

test("our own step kinds keep their tool name for grouping and lose their words; a look-alike connector does not", async () => {
  const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'go', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await waitFor(() => !h.rt().activeTurn(chat.id), { timeoutMs: 15_000 })
  const kinds = ['agent', 'todo_write', 'attachment', 'engine', 'refusal', 'context', 'history_summary', 'demo_replay']
  const steps = [...kinds.map((tool) => ({ id: `i-${tool}`, kind: 'tool', tool, label: `Line ${SECRET}`, ...stamp() })), { id: 'x', kind: 'tool', tool: 'my_agent__agent', label: `Line ${SECRET}`, ...stamp() }]
  h.ctx.db.query('UPDATE messages SET steps = ? WHERE id = ?').run(JSON.stringify(steps), r.assistantMessage.id)
  const got = (await h.api('bob').call(API.listMessages, { params: { id: chat.id }, query: {} })).items.find((m) => m.id === r.assistantMessage.id)!.steps
  expect(JSON.stringify(got)).not.toContain(SECRET)
  for (const tool of kinds) expect(got.find((s) => s.id === `i-${tool}`)?.tool).toBe(tool)
  expect(got.find((s) => s.id === 'x')?.tool).toBeUndefined()
})

test('what stays for the others: a command (20261118-devenv-shared-chats) and a save_url path they may see', async () => {
  const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'go', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await waitFor(() => !h.rt().activeTurn(chat.id), { timeoutMs: 15_000 })
  const steps = [
    { id: 'c1', kind: 'tool', tool: 'box_shell', label: 'Run · npm test', ...stamp() },
    { id: 'u1', kind: 'tool', tool: 'save_url', label: 'Save', sv: { label: 'Save · projects/falcon/report.pdf', paths: ['projects/falcon/report.pdf'] }, ...stamp() },
    { id: 'u2', kind: 'tool', tool: 'save_url', label: 'Save', sv: { label: 'Save · users/alice/private.pdf', paths: ['users/alice/private.pdf'] }, ...stamp() },
  ]
  h.ctx.db.query('UPDATE messages SET steps = ? WHERE id = ?').run(JSON.stringify(steps), r.assistantMessage.id)
  const bobSteps = (await h.api('bob').call(API.listMessages, { params: { id: chat.id }, query: {} })).items.find((m) => m.id === r.assistantMessage.id)!.steps
  expect(bobSteps.find((s) => s.id === 'c1')?.label).toBe('Run · npm test')
  expect(bobSteps.find((s) => s.id === 'u1')?.label).toBe('Save · projects/falcon/report.pdf')
  expect(bobSteps.find((s) => s.id === 'u2')?.label).toBe('Save')
})

test('every known step tool is on the short list or shows its verb alone', () => {
  const known = [...Object.keys(FILE_STEP_VERB), ...Object.keys(BROWSER_STEP_VERB)]
  expect(known.length).toBeGreaterThan(50)
  for (const tool of known) {
    const step = { kind: 'tool', tool }
    expect([tool, stepRepeatsCard(step, false)]).toEqual([tool, !OPEN_LABEL_TOOLS.has(tool)])
    expect([tool, stepRepeatsCard(step, true)]).toEqual([tool, !OPEN_LABEL_TOOLS.has(tool) && !PATH_LABEL_TOOLS.has(tool)])
  }
  for (const tool of ['find_tools', 'find_skills', 'search', 'artifact', 'skill', 'query_data']) expect([tool, stepRepeatsCard({ kind: 'tool', tool }, true)]).toEqual([tool, true])
})

test('find_tools and find_skills with a select: query reach the others and their AI as the verb alone', async () => {
  const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
  const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: 'go', clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await waitFor(() => !h.rt().activeTurn(chat.id), { timeoutMs: 15_000 })
  const steps = ['find_tools', 'find_skills'].map((tool) => ({ id: tool, kind: 'tool', tool, label: 'Find features "select:my_gmail__send_payroll"', ...stamp() }))
  h.ctx.db.query('UPDATE messages SET steps = ? WHERE id = ?').run(JSON.stringify(steps), r.assistantMessage.id)
  expect(JSON.stringify(await h.api('bob').call(API.listMessages, { params: { id: chat.id }, query: {} }))).not.toContain('send_payroll')
  const b = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content: '@fake ' + JSON.stringify({ echo: 'system' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  const done = await bob.next('message.done', (f) => f.data.messageId === b.assistantMessage.id, 30_000)
  const record = [...String(done.data.message.content).matchAll(/<steps_record>\n([\s\S]*?)\n<\/steps_record>/g)].map((m) => m[1]).join('\n')
  expect(record).toContain('find_tools')
  expect(record).not.toContain('send_payroll')
})
