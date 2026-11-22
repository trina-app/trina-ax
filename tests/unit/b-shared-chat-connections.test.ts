// Connected services in shared chats (docs/decisions/20261118-shared-chat-connections.md, QA TC-4885 and TC-4886), with
// the fake engine through the real launcher and gate. The project is on projects/falcon: alice writes it, the finance
// group (bob) reads it, so alice and bob see its shared chats; gina (finance, added here) joins later. A team MCP
// connection for everyone ("Bright Data", no key) and alice's own MCP connection ("Alice Mail", a stored key) on the
// fake services. Covered: a team connection everyone may use runs with no card; not while a guest sees the chat (the
// AI is told why); alice's own connection asks alice only (Allow once / Always in this chat / Cancel) and fetches nothing
// before her yes; bob's turn never uses alice's connection; the stored key is never in what bob sees; the answer's read
// record hides an answer built on alice's connection from gina, who joined later, and not the team connection's.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
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
import { TurnExec } from '../../server/src/chat/turn'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const TEAM_TOOL = 'team_brightdata__search_tasks'
const MINE_TOOL = 'my_alicemail__search_tasks'
const MINE_ECHO = 'my_alicemail__echo_text'
const MINE_WRITE = 'my_alicemail__create_task'
const MINE_READ = 'my_alicemail__get_post'

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
  svc.tools = [...svc.tools, { name: 'echo_text', description: 'repeats the caller', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    // a look-up whose name holds a change word as a noun: the read card in a shared chat (read-mark.ts 'unsure')
    { name: 'get_post', title: 'Get post', description: 'Reads a post', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, annotations: { readOnlyHint: true } }]
  integrationsOf(h.ctx, { net: svc.net() })
  const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Bright Data', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(team.status).toBe('connected')
  const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Alice Mail', url: `${svc.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY, writePolicy: 'ask' } as never })
  expect(mine.status).toBe('connected')
})
beforeEach(() => { h?.ctx.db.query('DELETE FROM connector_tool_allow').run() })
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
/** a turn whose cards are answered in order by `pick` (the card, its index) until it ends; returns the cards */
async function askCards(user: string, chatId: string, content: string, pick: (card: { question: string; options: { label: string; value: string }[] }, i: number) => string) {
  const started = await send(user, chatId, content)
  const seen = new Set<string>()
  const cards: { question: string; options: { label: string; value: string }[] }[] = []
  const timer = setInterval(() => {
    for (const f of ws[user]!.frames) {
      if (f.type !== 'turn.request') continue
      const d = (f as { data: { turnId: string; request: { requestId: string; question: string; options: { label: string; value: string }[] } } }).data
      if (d.turnId !== started.turnId || seen.has(d.request.requestId)) continue
      seen.add(d.request.requestId)
      cards.push(d.request)
      void h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: d.request.requestId, answer: pick(d.request, cards.length - 1) } }).catch(() => {})
    }
  }, 20)
  try { return { started, cards, done: await done(user, chatId, started.assistantMessage.id) } } finally { clearInterval(timer) }
}
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
      // alice's own connection still asks her, and the card says a guest is among the people (security review of #1276)
      const own = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'g' }, sayResult: true }), 'cancel')
      expect(own.card.question).toBe('What the AI gets from Alice Mail will show to the 2 people in this chat, including a guest (someone outside the team).')
      // with someone outside the team in the chat, Always holds for this chat only
      expect(own.card.options.map((o) => o.label)).toEqual(['Allow', 'Always in this chat', 'Don’t allow'])
      const said = await ask('alice', chat.id, fake({ echo: 'system' }))
      expect(said.done.content).toContain("The team's connections (Bright Data): not usable in this shared chat, because a guest is in it and guests have no connected services")
      expect(said.done.content).toContain('When a guest is in this chat the team\'s connections are off')
    } finally { db().query("UPDATE users SET guest = 0 WHERE id = 'bob'").run(); db().query("DELETE FROM folder_rules WHERE id = 'conn-guest'").run(); db().query("DELETE FROM guests WHERE user_id = 'bob'").run() }
  })
})

// review of #404: with a guest (someone outside the team) among the people, the read card and the card of a change on
// the person's own things offer and keep Always for this chat only, never for good (as the shared chat card,
// chat/turn.ts sharedConnMayKeep, docs/decisions/20261122-connector-always-allow.md)
describe('a guest in the shared chat: Always holds for this chat only (#404)', () => {
  const guestOn = () => {
    db().query("UPDATE users SET guest = 1 WHERE id = 'bob'").run()
    db().query("INSERT INTO guests (user_id, place_kind, place_id, project_id, created_at) VALUES ('bob', 'project', ?, ?, ?)").run(projectId, projectId, new Date().toISOString())
    db().query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('conn-guest', 'f_projects_falcon', 'user', 'bob', 'read')").run()
  }
  const guestOff = () => { db().query("UPDATE users SET guest = 0 WHERE id = 'bob'").run(); db().query("DELETE FROM folder_rules WHERE id = 'conn-guest'").run(); db().query("DELETE FROM guests WHERE user_id = 'bob'").run() }
  const grants = () => (db().query("SELECT tool FROM connector_tool_allow WHERE user_id = 'alice' AND tool <> ''").all() as { tool: string }[]).map((r) => r.tool).sort()
  /** the widest choice a card offers: for good, else this chat, else once */
  const widest = (c: { options: { value: string }[] }) => (c.options.some((o) => o.value === 'always') ? 'always' : c.options.some((o) => o.value === 'chat') ? 'chat' : c.options[0]!.value)
  const made = () => svc.calls.filter((c) => c.name === 'create_task').length
  const reads = () => svc.calls.filter((c) => c.name === 'get_post').length

  test('the read card and a change card offer "Always in this chat", keep nothing for good, and cover only this chat', async () => {
    const chat = await newShared('bob')
    guestOn()
    try {
      const r = await askCards('alice', chat.id, fake({ tool: MINE_READ, args: { url: 'https://example.com/p/1' }, sayResult: true }, { tool: MINE_WRITE, args: { title: 'with a guest' }, sayResult: true }), widest)
      const read = r.cards.find((c) => c.question.startsWith('Read this page with Alice Mail'))!
      const change = r.cards.find((c) => c.question.includes('Create a task in Alice Mail'))!
      for (const c of [read, change]) {
        expect(c.options.map((o) => [o.label, o.value])).toEqual([['Allow', 'allow'], ['Always in this chat', 'chat'], ['Don’t allow', 'deny']])
        expect((c as { note?: string }).note).toContain('in this chat only')
      }
      expect([reads() > 0, made() > 0]).toEqual([true, true])
      // nothing for good
      expect(grants()).toEqual([])
      // the next answer in this chat: no read card and no change card
      const n = [reads(), made()]
      const next = await askCards('alice', chat.id, fake({ tool: MINE_READ, args: { url: 'https://example.com/p/2' }, sayResult: true }, { tool: MINE_WRITE, args: { title: 'again' }, sayResult: true }), widest)
      expect(next.cards).toEqual([])
      expect([reads(), made()]).toEqual([n[0]! + 1, n[1]! + 1])
      // another shared chat with the guest: both ask again
      const other = await newShared('bob')
      const there = await askCards('alice', other.id, fake({ tool: MINE_READ, args: { url: 'https://example.com/p/3' }, sayResult: true }, { tool: MINE_WRITE, args: { title: 'elsewhere' }, sayResult: true }), (c) => c.options.at(-1)!.value)
      const own = there.cards.filter((c) => !c.question.startsWith('What the AI gets'))
      expect(own.map((c) => c.question.startsWith('Read this page with Alice Mail') || c.question.includes('Create a task in Alice Mail'))).toEqual([true, true])
    } finally { guestOff() }
  })

  test('an Always for good given in a chat without a guest is not used while a guest is here', async () => {
    const plain = await newShared()
    await askCards('alice', plain.id, fake({ tool: MINE_READ, args: { url: 'https://example.com/q/1' }, sayResult: true }, { tool: MINE_WRITE, args: { title: 'no guest' }, sayResult: true }), widest)
    expect(grants()).toEqual(['create_task', 'get_post'])
    const chat = await newShared('bob')
    guestOn()
    try {
      const n = [reads(), made()]
      // the shared card for this chat; the read and the change cards are answered no
      const r = await askCards('alice', chat.id, fake({ tool: MINE_READ, args: { url: 'https://example.com/q/2' }, sayResult: true }, { tool: MINE_WRITE, args: { title: 'guest here' }, sayResult: true }),
        (c) => (c.question.startsWith('What the AI gets') ? 'always' : c.options.at(-1)!.value))
      const asked = r.cards.filter((c) => !c.question.startsWith('What the AI gets'))
      expect(asked.map((c) => c.question.startsWith('Read this page with Alice Mail') || c.question.includes('Create a task in Alice Mail'))).toEqual([true, true])
      for (const c of asked) expect(c.options.map((o) => o.value)).toEqual(['allow', 'chat', 'deny'])
      expect([reads(), made()]).toEqual(n)
    } finally { guestOff() }
    // without the guest again: the Always for good holds
    const back = await newShared()
    const b = await askCards('alice', back.id, fake({ tool: MINE_READ, args: { url: 'https://example.com/q/3' }, sayResult: true }, { tool: MINE_WRITE, args: { title: 'back' }, sayResult: true }), widest)
    expect(b.cards.filter((c) => !c.question.startsWith('What the AI gets'))).toEqual([])
  })
})

describe("the asker's own connection (TC-4886)", () => {
  test('the card goes to alice only, names the service and the people, and nothing is fetched before her answer; Cancel fetches nothing', async () => {
    const chat = await newShared()
    const n = calls()
    let before = -1
    const r = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'invoices' }, sayResult: true }), 'cancel', () => { before = calls() })
    expect(before).toBe(n)
    expect(r.card.question).toBe('What the AI gets from Alice Mail will show to the 2 people in this chat.')
    // one press: three buttons; Always is for good (docs/decisions/20261122-connector-always-allow.md)
    expect(r.card.options.map((o) => [o.label, o.value])).toEqual([['Allow', 'once'], ['Always allow', 'always'], ['Don’t allow', 'cancel']])
    expect((r.card as { buttons?: boolean }).buttons).toBe(true)
    expect((r.card as { note?: string }).note).toContain('in shared chats')
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

  test('Always allow: no card in the next answers, in another shared chat, or when a new person joins; Settings removes it', async () => {
    const chat = await newShared()
    const n = calls()
    await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'a' }, sayResult: true }), 'always')
    expect(calls()).toBe(n + 1)
    const next = await ask('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'b' }, sayResult: true }))
    expect(cardsTo('alice', next.started.turnId)).toEqual([])
    expect(calls()).toBe(n + 2)
    // another shared chat (the owner: "매 대화마다 해야한다니")
    const other = await newShared()
    const there = await ask('alice', other.id, fake({ tool: MINE_TOOL, args: { q: 'c' }, sayResult: true }))
    expect(cardsTo('alice', there.started.turnId)).toEqual([])
    expect(calls()).toBe(n + 3)
    // a teammate joins: Rule A, the Always is final; the answer's read record still names who saw it
    ginaJoins()
    try {
      const wider = await ask('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'd' }, sayResult: true }))
      expect(cardsTo('alice', wider.started.turnId)).toEqual([])
      expect(calls()).toBe(n + 4)
    } finally { ginaLeaves() }
    const row = (await h.api('alice').call(API.listAiAllowances)).items.find((x) => x.kind === 'connector_tool' && x.shared)
    expect(row).toMatchObject({ connection: 'Alice Mail', shared: true })
    await h.api('alice').call(API.deleteAiAllowance, { params: { id: row!.id } })
    const back = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'e' }, sayResult: true }), 'cancel')
    expect(back.card.question).toContain('Alice Mail')
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
    // (echo_text: a read with no change word, so only the connection card)
    const r = await askCards('alice', chat.id, fake({ tool: MINE_ECHO, args: {}, sayResult: true }), (c) => (c.options.some((o) => o.value === 'once') ? 'once' : 'allow'))
    expect(svc.calls.at(-1)!.name).toBe('echo_text')
    const forBob = JSON.stringify(await messages('bob', chat.id)) + JSON.stringify(await h.api('bob').call(API.getChat, { params: { id: chat.id } }))
    expect(forBob).toContain('Authorization')
    expect(forBob).not.toContain(MCP_KEY)
    expect(JSON.stringify(r.done)).not.toContain(MCP_KEY)
    expect(JSON.stringify(events(r.started.turnId))).not.toContain(MCP_KEY)
  })
})

describe('security review of #1276', () => {
  test("a change through alice's own connection: its card offers Always allow for that tool; the shared card never covers it", async () => {
    const chat = await newShared()
    await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'a' }, sayResult: true }), 'always')
    const n = svc.calls.filter((c) => c.name === 'create_task').length
    // no shared card (Always), but the change's own card names it; alice says no: nothing is created
    const r = await askCards('alice', chat.id, fake({ tool: MINE_WRITE, args: { title: 'from the shared chat' }, sayResult: true }), (c) => c.options.at(-1)!.value)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('Create a task in Alice Mail')
    expect(r.cards[0]!.options.map((o) => o.value)).toEqual(['allow', 'always', 'deny'])
    expect(svc.calls.filter((c) => c.name === 'create_task').length).toBe(n)
    // Always allow for create_task: the next one in another shared chat goes with no card
    await askCards('alice', chat.id, fake({ tool: MINE_WRITE, args: { title: 'one' }, sayResult: true }), () => 'always')
    expect(svc.calls.filter((c) => c.name === 'create_task').length).toBe(n + 1)
    const chat2 = await newShared()
    const r2 = await askCards('alice', chat2.id, fake({ tool: MINE_WRITE, args: { title: 'two' }, sayResult: true }), (c) => c.options.at(-1)!.value)
    expect(r2.cards).toEqual([])
    expect(svc.calls.filter((c) => c.name === 'create_task').length).toBe(n + 2)
  })

  test('Always in this chat holds for the connection as it is: reconnected (a new version or account), it asks again', async () => {
    const chat = await newShared()
    await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'a' }, sayResult: true }), 'always')
    db().query("UPDATE integrations SET version = version + 1, account = '{\"email\":\"other@example.com\"}' WHERE name = 'Alice Mail'").run()
    const again = await askWithCard('alice', chat.id, fake({ tool: MINE_TOOL, args: { q: 'b' }, sayResult: true }), 'cancel')
    expect(again.card.question).toContain('Alice Mail')
  })

  test('a team file handed to a connection in a shared chat is refused before any card, and nothing is sent', async () => {
    const chat = await newShared()
    const n = calls()
    const r = await ask('alice', chat.id, fake({ tool: MINE_WRITE, args: { title: 'team-file:projects/falcon/notes.md' }, sayResult: true }))
    expect(cardsTo('alice', r.started.turnId)).toEqual([])
    expect(calls()).toBe(n)
    expect(events(r.started.turnId).find((e) => e.tool === MINE_WRITE)?.summary).toContain('refused (team file in a shared chat)')
  })

  /** a stand-in turn (no engine) for confirmSharedConnection: its audience and its card are the test's */
  function standIn(o: { audience: () => string[]; ask: (asked: readonly string[]) => Promise<string> }) {
    const t = Object.create(TurnExec.prototype) as any
    const own = (o2: Record<string, unknown>) => { for (const [k, v] of Object.entries(o2)) Object.defineProperty(t, k, { value: v, writable: true, configurable: true }) }
    own({
      shared: { kind: 'project', project: {} }, rt: { db: db(), files: h.ctx.files, log: { warn() {} } }, spec: { chatId: 'none', userId: 'alice', locale: 'en' },
      principal: { name: 'Alice Kim' }, id: 'stand-in', sharedConnAllowed: new Map(), sharedConnRefused: new Map(), sharedConnPending: new Map(),
      recorded: [] as string[][],
    })
    own({
      sharedAudience: o.audience,
      askSharedConnection: (_c: unknown, asked: readonly string[]) => o.ask(asked),
      noteSharedReads: (_s: unknown, audience: string[]) => { t.recorded.push([...audience]); return true },
    })
    return t
  }
  const conn = { id: 'conn-1', key: 'conn-1\u00001\u0000', name: 'Alice Mail', sources: [{ type: 'user' as const, id: 'alice', via: 'connection' as const }] }

  test('a parallel call whose audience grew while the card was open asks again; only the asked people are recorded', async () => {
    let people = ['alice', 'bob']
    const asked: string[][] = []
    let release!: (v: string) => void
    const first = new Promise<string>((r) => { release = r })
    const t = standIn({ audience: () => people, ask: (a) => { asked.push([...a]); return asked.length === 1 ? first : Promise.resolve('shared') } })
    const one = t.confirmSharedConnection(conn)
    await Bun.sleep(5)
    people = ['alice', 'bob', 'gina']
    const two = t.confirmSharedConnection(conn)
    await Bun.sleep(5)
    release('shared')
    expect([await one, await two]).toEqual([null, null])
    expect(asked).toEqual([['alice', 'bob'], ['alice', 'bob', 'gina']])
    // every record names exactly the people one card was answered for (gina only after the card that named her)
    expect(t.recorded.length).toBe(2)
    for (const r of t.recorded) expect(asked.map((a) => a.join())).toContain(r.join())
    expect(t.recorded.every((r: string[]) => !r.includes('gina') || asked[1]!.includes('gina'))).toBe(true)
  })

  test('nobody found to see the chat: no card and nothing fetched (fails closed)', async () => {
    let asked = 0
    const t = standIn({ audience: () => [], ask: async () => { asked++; return 'shared' } })
    expect(await t.confirmSharedConnection(conn)).toContain('Nothing was fetched from Alice Mail')
    expect(asked).toBe(0)
  })

  test('an answer that already saved a chat file version: no card, nothing fetched, and the words say why (QA TC-6962)', async () => {
    let asked = 0
    const t = standIn({ audience: () => ['alice', 'bob'], ask: async () => { asked++; return 'shared' } })
    Object.defineProperty(t, 'files', { value: { chatVersionsMade: new Map([['root', 'v2']]) }, configurable: true })
    const said = await t.confirmSharedConnection(conn)
    expect(said).toContain('Nothing was fetched from Alice Mail: this answer already saved a new version of a file of this chat')
    expect(said).not.toContain('who in this shared chat may see')
    expect(asked).toBe(0)
    expect(t.recorded).toEqual([])
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
