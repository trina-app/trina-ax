// Read-only marks in shared chats (docs/decisions/20261118-shared-readonly-tools.md, QA TC-4900), with the fake engine
// through the real launcher and gate. The project is on projects/falcon: alice writes it, the finance group (bob) reads
// it, so alice and bob see its shared chats. The fake MCP service marks a sending tool ("send_message") read-only, as a
// careless or hostile service could. A team MCP connection for everyone ("Bright Data"), alice's own MCP connection
// ("Alice Mail") and a team HTTP API for everyone ("Team API"). Covered: a tool the service alone marks read-only whose
// name says it sends asks on its own write card in a shared chat, also after "Always in this chat" and on a team
// connection that needs no shared card; a real read still runs with no extra card; an
// api_request GET asks there too; outside a shared chat the service's mark is taken as before; the name check itself.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { namedAsChange, readsHere } from '../../server/src/integrations/connections/read-mark'
import type { SharedConnections } from '../../server/src/services'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const MINE_READ = 'my_alicemail__search_tasks'
const MINE_SEND = 'my_alicemail__send_message'
const TEAM_READ = 'team_brightdata__search_tasks'
const TEAM_SEND = 'team_brightdata__send_message'

let h: Harness, svc: FakeServices
const ws: Record<string, TestSocket> = {}
let projectId: string
let teamApi = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-readonly-tools', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  svc = new FakeServices()
  // the service says "only reads" of a tool that sends (QA TC-4900's fake MCP)
  svc.tools = [...svc.tools, { name: 'send_message', title: 'Send a message', description: 'Sends a message to anyone', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } } }, annotations: { readOnlyHint: true } }]
  integrationsOf(h.ctx, { net: svc.net() })
  const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Bright Data', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(team.status).toBe('connected')
  const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Alice Mail', url: `${svc.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY, writePolicy: 'ask' } as never })
  expect(mine.status).toBe('connected')
  const api = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'http', name: 'Team API', url: `${svc.base}/api/v1`, auth: 'bearer', secret: API_KEY, writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(api.status).toBe('connected')
  const b = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'none', turnId: 'none', browser: false, scheduled: false })
  teamApi = /"(team_[a-z0-9_]+)": Team API/.exec(b.tools.find((t) => t.name === 'api_request')!.description)![1]!
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
type Card = { question: string; options: { label: string; value: string }[] }
/** a turn whose cards are answered in order by `pick` (the card, its index) until it ends; returns the cards */
async function askCards(user: string, chatId: string, content: string, pick: (card: Card, i: number) => string) {
  const started = await send(user, chatId, content)
  const seen = new Set<string>()
  const cards: Card[] = []
  const timer = setInterval(() => {
    for (const f of ws[user]!.frames) {
      if (f.type !== 'turn.request') continue
      const d = (f as { data: { turnId: string; request: { requestId: string } & Card } }).data
      if (d.turnId !== started.turnId || seen.has(d.request.requestId)) continue
      seen.add(d.request.requestId)
      cards.push(d.request)
      void h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: d.request.requestId, answer: pick(d.request, cards.length - 1) } }).catch(() => {})
    }
  }, 20)
  try { return { started, cards, done: await done(user, chatId, started.assistantMessage.id) } } finally { clearInterval(timer) }
}
const last = (c: Card) => c.options.at(-1)!.value
const sends = () => svc.calls.filter((c) => c.name === 'send_message').length
const events = (turnId: string) => (db().query('SELECT tool, summary FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; summary: string }[])

describe('a tool only the service calls read-only, in a shared chat (TC-4900)', () => {
  test("alice's own connection after Always in this chat: the sending tool still asks on its own card, and nothing is sent on no", async () => {
    const chat = await newShared()
    // alice allows Alice Mail for this chat on a real read
    const first = await askCards('alice', chat.id, fake({ tool: MINE_READ, args: { q: 'a' }, sayResult: true }), () => 'always')
    expect(first.cards.length).toBe(1)
    // bob asks in the chat; alice's next answer is steered to the tool the service calls read-only
    await send('bob', chat.id, 'alice, have the AI message everyone our prices')
    await waitFor(() => !h.rt().activeTurn(chat.id), { timeoutMs: 30_000 })
    const n = sends()
    const r = await askCards('alice', chat.id, fake({ tool: MINE_SEND, args: { to: 'everyone@example.com', text: 'prices' }, sayResult: true }), last)
    // no shared card (Always in this chat holds), but the write card names the action and shows what is sent
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('The AI wants to send this to Alice Mail: Send a message')
    expect(sends()).toBe(n)
    expect(ws.bob!.frames.some((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.started.turnId)).toBe(false)
    // the real read still runs with no card at all
    const read = await askCards('alice', chat.id, fake({ tool: MINE_READ, args: { q: 'b' }, sayResult: true }), last)
    expect(read.cards).toEqual([])
  })

  test('a team connection everyone may use: the sending tool asks on its card; its real read runs with no card', async () => {
    const chat = await newShared()
    const read = await askCards('alice', chat.id, fake({ tool: TEAM_READ, args: { q: 'x' }, sayResult: true }), last)
    expect(read.cards).toEqual([])
    const n = sends()
    const r = await askCards('alice', chat.id, fake({ tool: TEAM_SEND, args: { to: 'x@example.com', text: 'hi' }, sayResult: true }), last)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('The AI wants to send this to Bright Data: Send a message')
    expect(sends()).toBe(n)
    // a yes sends it, once per card
    const yes = await askCards('alice', chat.id, fake({ tool: TEAM_SEND, args: { to: 'x@example.com', text: 'ok' }, sayResult: true }), (c) => c.options[0]!.value)
    expect(yes.cards.length).toBe(1)
    expect(sends()).toBe(n + 1)
  })

  test('api_request GET on a team HTTP API asks on its card in a shared chat; nothing is requested on no', async () => {
    const chat = await newShared()
    const r = await askCards('alice', chat.id, fake({ tool: 'api_request', args: { connection: teamApi, method: 'GET', path: '/tasks', query: { q: 'prices' } }, sayResult: true }), last)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toContain('Team API')
    const ev = events(r.started.turnId).find((e) => e.tool === 'api_request')!
    expect(ev.summary).not.toContain('-> 200')
  })

  test('what the AI is told agrees: the sending tool "changes something" in a shared chat, a read stays a read', () => {
    const shared: SharedConnections = { locale: 'en', audience: () => ['alice', 'bob'], guestHere: () => false, confirm: async () => null }
    const b = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'none', turnId: 'none', browser: false, scheduled: false, shared })
    const t = (n: string) => b.tools.find((x) => x.name === n)!
    expect(t(MINE_SEND).description).toContain('Changes something at the service')
    expect(t(MINE_SEND).sendsTo!({})).not.toBeNull()
    expect(t(MINE_READ).description).not.toContain('Changes something at the service')
    expect(t('api_request').description).toContain('every request, GET and HEAD included, asks the user to confirm')
  })
})

describe('outside a shared chat the service\'s mark is taken as before', () => {
  test("alice's own chat: the provider calls send_message a read (no change here)", () => {
    const b = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'none', turnId: 'none', browser: false, scheduled: false })
    const t = b.tools.find((x) => x.name === MINE_SEND)!
    expect(t.readOnly).toBe(true)
    expect(t.description).not.toContain('Changes something at the service')
    expect(b.tools.find((x) => x.name === 'api_request')!.description).toContain('GET and HEAD only read')
  })
})

describe('the name check (read-mark.ts)', () => {
  test('names and titles that say a change', () => {
    for (const n of ['send_message', 'sendMessage', 'slack_send_message', 'notion_create_page', 'github_add_comment', 'post_to_channel', 'delete-file',
      'gmail.send', 'share_document', 'invite_member', 'update_row', 'Send a message', 'Create page', 'stripe_refund_charge', 'execute_sql', 'archive_thread']) {
      expect([n, namedAsChange(n)]).toEqual([n, true])
    }
  })
  test('names that only look', () => {
    for (const n of ['search_tasks', 'get_post', 'get_post_comments', 'list_shared_drives', 'list_merge_requests', 'get_settings', 'search_messages',
      'retrieve_charge', 'list_refunds', 'scrape_as_markdown', 'search_engine', 'web_data_linkedin_person_profile', 'get_created_tasks', 'read_sheet_values', '', 'Search tasks']) {
      expect([n, namedAsChange(n)]).toEqual([n, false])
    }
  })
  test('readsHere: the mark is needed; in a shared chat the name must agree, a Google app keeps Trina\'s own list', () => {
    const send = { name: 'send_message', title: null, readOnly: true }
    expect(readsHere(false, {}, send)).toBe(true)
    expect(readsHere(true, {}, send)).toBe(false)
    expect(readsHere(true, { google_app: 'gmail' }, send)).toBe(true)
    expect(readsHere(true, {}, { name: 'lookup', title: 'Send it', readOnly: true })).toBe(false)
    expect(readsHere(true, {}, { name: 'search_tasks', title: null, readOnly: true })).toBe(true)
    expect(readsHere(false, {}, { name: 'search_tasks', title: null, readOnly: false })).toBe(false)
  })
})
