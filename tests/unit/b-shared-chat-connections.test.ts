// Connected services in shared chats (docs/decisions/20261118-shared-chat-connections.md, QA TC-4885 and TC-4886), with
// the fake engine through the real launcher and gate. The project is on projects/falcon: alice writes it, the finance
// group (bob) reads it, so alice and bob see its shared chats; gina (finance, added here) joins later. A team MCP
// connection for everyone ("Bright Data", no key) and alice's own MCP connection ("Alice Mail", a stored key) on the
// fake services. Covered: a team connection everyone may use runs with no card; not while a guest sees the chat (the
// AI is told why); alice's own connection asks alice only (Allow once / Always in this chat / Cancel) and fetches nothing
// before her yes; bob's turn never uses alice's connection; the stored key is never in what bob sees; the answer's read
// record hides an answer built on alice's connection from gina, who joined later, and not the team connection's.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message } from '@mycel/shared/api'
import { addTestPerson, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { answerRecord, lateHides, type ParsedGroup } from '../../server/src/chat/shared-answers'
import { sharedSection } from '../../server/src/chat/prompt'
import type { SharedConnections } from '../../server/src/services'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const TEAM_TOOL = 'team_brightdata__search_tasks'
const MINE_TOOL = 'my_alicemail__search_tasks'
const MINE_ECHO = 'my_alicemail__echo_text'

let h: Harness, svc: FakeServices
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-connections', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  h.ctx.db.query("INSERT INTO users (id, username, name, role) VALUES ('gina', 'gina', 'Gina Han', 'member')").run()
  addTestPerson('gina', { id: 'gina', name: 'Gina Han', role: 'member', locale: 'en' })
  for (const u of ['alice', 'bob', 'gina']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  svc = new FakeServices()
  svc.tools = [...svc.tools, { name: 'echo_text', description: 'repeats the caller', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]
  integrationsOf(h.ctx, { net: svc.net() })
  const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Bright Data', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(team.status).toBe('connected')
  const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Alice Mail', url: `${svc.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY, writePolicy: 'ask' } as never })
  expect(mine.status).toBe('connected')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); svc?.stop(); await h?.close() })

const db = () => h.ctx.db
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
const done = async (user: string, chatId: string, messageId: string) => {
  const d = await ws[user]!.next('message.done', (f) => f.data.messageId === messageId, 30_000)
  await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
  return d.data.message as Message
}
/** a turn with no card expected */
async function ask(user: string, chatId: string, content: string) {
  const started = await send(user, chatId, content)
  return { started, done: await done(user, chatId, started.assistantMessage.id) }
}
/** a turn whose first card is answered with `value` (null: left open until it runs out) */
async function askWithCard(user: string, chatId: string, content: string, value: string | null, before?: () => void) {
  const started = await send(user, chatId, content)
  const card = await ws[user]!.next('turn.request', (f) => f.data.turnId === started.turnId, 15_000)
  before?.()
  if (value) await h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: value } })
  return { started, card: card.data.request as { question: string; options: { label: string; value: string }[] }, done: await done(user, chatId, started.assistantMessage.id) }
}
const calls = () => svc.calls.length
const events = (turnId: string) => (db().query('SELECT tool, summary FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; summary: string }[])
const cardsTo = (user: string, turnId: string) => ws[user]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === turnId)
const messages = async (user: string, chatId: string): Promise<Message[]> => (await h.api(user).call(API.listMessages, { params: { id: chatId }, query: {} })).items
const answerFor = async (user: string, chatId: string, id: string) => (await messages(user, chatId)).find((m) => m.id === id)!
const ginaJoins = () => db().query("INSERT OR IGNORE INTO group_members VALUES ('finance', 'gina')").run()
const ginaLeaves = () => db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'gina'").run()

describe('a team connection (TC-4885)', () => {
  test('everyone in the chat may use it: it runs with no card, and its answer joins the read record', async () => {
    const chat = await newShared()
    const n = calls()
    const r = await ask('alice', chat.id, fake({ tool: TEAM_TOOL, args: { q: 'prices' }, sayResult: true }))
    expect(cardsTo('alice', r.started.turnId)).toEqual([])
    expect(calls()).toBe(n + 1)
    expect(r.done.content).toContain('search_tasks')
    const rec = answerRecord(db(), r.done.id)!
    const g = rec.reads.find((x) => x.s.some((s) => s.type === 'integration'))!
    expect([g.c, g.k, g.y]).toEqual([['alice', 'bob'], 1, undefined])
    // gina joins later: the team connection is hers too, so she sees the answer
    ginaJoins()
    try { expect((await answerFor('gina', chat.id, r.done.id)).withheld).toBeUndefined() } finally { ginaLeaves() }
  })

  test('a guest in the chat: not run, nothing fetched, and the AI is told why in plain words', async () => {
    // a shared chat a guest sees: the one they made (a guest sees no other project chat); bob stands for the guest
    const chat = await newShared('bob')
    const n = calls()
    // (a guest invited to the project: their guests row names it, and a person rule on its folder)
    db().query("UPDATE users SET guest = 1 WHERE id = 'bob'").run()
    db().query("INSERT INTO guests (user_id, place_kind, place_id, project_id, created_at) VALUES ('bob', 'project', ?, ?, ?)").run(projectId, projectId, new Date().toISOString())
    db().query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('conn-guest', 'f_projects_falcon', 'user', 'bob', 'read')").run()
    try {
      const r = await ask('alice', chat.id, fake({ tool: TEAM_TOOL, args: { q: 'prices' }, sayResult: true }))
      expect(calls()).toBe(n)
      // (the tool is not offered: the turn's call of it fails); the instructions say why
      expect(r.done.content).not.toContain('search_tasks: ')
      const said = await ask('alice', chat.id, fake({ echo: 'system' }))
      expect(said.done.content).toContain("The team's connections (Bright Data): not usable in this shared chat, because a guest is in it and guests have no connected services")
      expect(said.done.content).toContain('When a guest is in this chat the team\'s connections are off')
    } finally { db().query("UPDATE users SET guest = 0 WHERE id = 'bob'").run(); db().query("DELETE FROM folder_rules WHERE id = 'conn-guest'").run(); db().query("DELETE FROM guests WHERE user_id = 'bob'").run() }
  })
})

describe("the asker's own connection (TC-4886)", () => {
  test('the card goes to alice only, names the service and the people, and nothing is fetched before her answer; Cancel fetches nothing', async () => {
    const chat = await newShared()
    const n = calls()
    let before = -1
    const r = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'invoices' }, sayResult: true }), 'cancel', () => { before = calls() })
    expect(before).toBe(n)
    expect(r.card.question).toBe('The AI wants to use Alice Mail. This will show what Alice Mail returns to the 2 people in this chat.')
    expect(r.card.options.map((o) => [o.label, o.value])).toEqual([['Allow once', 'once'], ['Always in this chat', 'always'], ['Cancel', 'cancel']])
    expect(cardsTo('bob', r.started.turnId)).toEqual([])
    expect(calls()).toBe(n)
    expect(events(r.started.turnId).find((e) => e.tool === MINE_TOOL)?.summary).toContain('not fetched (shared chat)')
    expect(r.done.content).toContain('Nothing was fetched from Alice Mail')
  })

  test('no answer in time fetches nothing', async () => {
    const chat = await newShared()
    const n = calls()
    const r = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'x' }, sayResult: true }), null)
    expect(calls()).toBe(n)
    expect(r.done.content).toContain('Nothing was fetched from Alice Mail')
  })

  test('Allow once: fetched for this answer, asked again in the next one; a later joiner does not see the answer', async () => {
    const chat = await newShared()
    const n = calls()
    const r = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'a' }, sayResult: true }, { tool: MINE_TOOL, args: { q: 'b' }, sayResult: true }), 'once')
    // one card covers the answer's two calls
    expect(cardsTo('alice', r.started.turnId).length).toBe(1)
    expect(calls()).toBe(n + 2)
    expect(svc.calls.at(-1)!.auth).toBe(`Bearer ${MCP_KEY}`)
    const g = answerRecord(db(), r.done.id)!.reads.find((x) => x.s.some((s) => s.type === 'user'))!
    expect([g.c, g.k, g.y, g.s]).toEqual([['alice', 'bob'], 1, 1, [{ type: 'user', id: 'alice', via: 'connection' }]])
    // bob saw the chat then: he sees it; gina joins later and may not use alice's connection: one line in its place
    expect((await answerFor('bob', chat.id, r.done.id)).content).toContain('search_tasks')
    ginaJoins()
    try {
      const forGina = await answerFor('gina', chat.id, r.done.id)
      expect([forGina.withheld, forGina.content]).toEqual([true, ''])
    } finally { ginaLeaves() }
    // the next answer asks again
    const again = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'c' }, sayResult: true }), 'cancel')
    expect(again.card.question).toContain('Alice Mail')
  })

  test('Always in this chat: no card for the next answers while the same people see it; a new person makes it ask again', async () => {
    const chat = await newShared()
    const n = calls()
    await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'a' }, sayResult: true }), 'always')
    expect(calls()).toBe(n + 1)
    const next = await ask('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'b' }, sayResult: true }))
    expect(cardsTo('alice', next.started.turnId)).toEqual([])
    expect(calls()).toBe(n + 2)
    ginaJoins()
    try {
      const wider = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'c' }, sayResult: true }), 'cancel')
      expect(wider.card.question).toContain('the 3 people in this chat')
      expect(calls()).toBe(n + 2)
    } finally { ginaLeaves() }
  })

  test("bob's turn in the same chat never uses alice's connection", async () => {
    const chat = await newShared()
    await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'a' }, sayResult: true }), 'always')
    const n = calls()
    const r = await ask('bob', chat.id, fake({ tool: MINE_TOOL, args: { q: 'bob asks' }, sayResult: true }, { tool: 'call_tool', args: { name: MINE_TOOL, arguments: { q: 'bob asks' } }, sayResult: true }))
    expect(calls()).toBe(n)
    expect(svc.calls.some((c) => c.args?.q === 'bob asks')).toBe(false)
    expect(cardsTo('alice', r.started.turnId)).toEqual([])
    expect(cardsTo('bob', r.started.turnId)).toEqual([])
  })

  test('the stored key never reaches what bob sees: the answer, its steps, the chat', async () => {
    const chat = await newShared()
    const r = await askWithCard('alice', chat.id, fake({ tool: MINE_ECHO, args: {}, sayResult: true }), 'once')
    expect(svc.calls.at(-1)!.name).toBe('echo_text')
    const forBob = JSON.stringify(await messages('bob', chat.id)) + JSON.stringify(await h.api('bob').call(API.getChat, { params: { id: chat.id } }))
    expect(forBob).toContain('Authorization')
    expect(forBob).not.toContain(MCP_KEY)
    expect(JSON.stringify(r.done)).not.toContain(MCP_KEY)
    expect(JSON.stringify(events(r.started.turnId))).not.toContain(MCP_KEY)
  })
})

describe('the instructions and the provider in a shared chat', () => {
  const shared = (o: { guest?: boolean; audience?: string[] } = {}): SharedConnections => ({ locale: 'en', audience: () => o.audience ?? ['alice', 'bob'], guestHere: () => !!o.guest, confirm: async () => null })
  const build = (o: { guest?: boolean } = {}) => integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'none', turnId: 'none', browser: false, scheduled: false, shared: shared(o) })

  test('each connection says whether a card comes first; connecting a new one is not offered here', () => {
    const b = build()
    const names = b.tools.map((t) => t.name)
    expect(names).toContain(TEAM_TOOL)
    expect(names).toContain(MINE_TOOL)
    const line = (name: string) => b.prompt!.split('\n').find((l) => l.startsWith(`- ${name} `))!
    expect(line('Bright Data')).toContain('everyone in this shared chat may use it, so it works here with no extra card')
    expect(line('Alice Mail')).toContain('before its first call the server asks them on a card only they see')
    expect(b.prompt).toContain('connecting is not done in a shared chat')
    expect(b.prompt).not.toContain('connect_service')
  })

  test('a guest in the chat: no team connection tool, and the list says why', () => {
    const b = build({ guest: true })
    const names = b.tools.map((t) => t.name)
    expect(names).not.toContain(TEAM_TOOL)
    expect(names).toContain(MINE_TOOL)
    expect(b.prompt).toContain("The team's connections (Bright Data): not usable in this shared chat, because a guest is in it")
  })

  test('the shared section no longer says connected services are off, and says how the card works', () => {
    const text = sharedSection({ project: 'Falcon', audience: 2, asker: 'Alice Kim', members: null }, 'en')
    expect(text).not.toContain('connected services (and connecting one)')
    expect(text).toContain('connecting a new service')
    expect(text).toContain('the server asks Alice Kim on a card only they see')
    expect(text).toContain("never another person's")
  })

  test('a k group hides a late answer from someone not in it who may not read every place now', () => {
    const g: ParsedGroup = { c: new Set(['alice', 'bob']), s: [{ type: 'user', id: 'alice', via: 'connection' }], x: false, y: true, k: true }
    expect(lateHides([g], 'bob', () => false)).toBe(false)
    expect(lateHides([g], 'gina', () => false)).toBe(true)
    expect(lateHides([g], 'gina', () => true)).toBe(false)
    // without a way to judge the places: hidden (fails closed)
    expect(lateHides([g], 'gina')).toBe(true)
  })
})
