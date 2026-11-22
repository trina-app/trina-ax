// "항상 허용" on a connector tool's read card is for good (docs/decisions/20261122-connector-always-allow.md, migration
// 441). The owner, 2026-11-22: "이 세션에서만 항상 허용이니깐 이걸 매 세션마다 봐야하는거잖아". A team connection everyone may
// use ("Bright Data") marks read-only a scraper with no change word (no card at all in a shared chat) and a look-up
// whose name holds a change word as a noun (get_post: the read card). Covered: the card's plain words and buttons;
// Always allow in chat A means no card in chat B; another person still asks; Settings lists it and deleting it asks
// again; a re-pointed connection, the team's switch off and a lost access each end it; a change still asks every time.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { setAccess } from '../../server/src/integrations/connections/store'
import { updateTeamSettings } from '../../server/src/admin/settings'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const T = (n: string) => `team_brightdata__${n}`

let h: Harness, svc: FakeServices
const ws: Record<string, TestSocket> = {}
let projectId: string
let teamId = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b-connector-tool-always', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  svc = new FakeServices()
  svc.tools = [...svc.tools,
    { name: 'scrape_as_markdown', description: 'Scrapes a page', inputSchema: { type: 'object', properties: { url: { type: 'string' }, format: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'get_post', title: 'Get post', description: 'Reads a post', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'resend_invoice', description: 'Resends an invoice', inputSchema: { type: 'object', properties: { to: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  ]
  integrationsOf(h.ctx, { net: svc.net() })
  const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Bright Data', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(team.status).toBe('connected')
  teamId = team.id
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
type Card = { question: string; options: { label: string; value: string }[]; note?: string }
/** a turn whose cards are answered by `pick` until it ends; returns the cards */
async function askCards(user: string, chatId: string, content: string, pick: (card: Card) => string) {
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
      void h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: d.request.requestId, answer: pick(d.request) } }).catch(() => {})
    }
  }, 20)
  try { return { started, cards, done: await done(user, chatId, started.assistantMessage.id) } } finally { clearInterval(timer) }
}
const last = (c: Card) => c.options.at(-1)!.value
const callsOf = (n: string) => svc.calls.filter((c) => c.name === n).length
const via = (name: string, args: Record<string, unknown> = {}) => fake({ tool: name, args, sayResult: true })
const grants = (user: string) => (db().query('SELECT tool FROM connector_tool_allow WHERE user_id = ?').all(user) as { tool: string }[]).map((r) => r.tool)
const clear = () => db().query('DELETE FROM connector_tool_allow').run()

describe('a read-only connector tool in a shared chat', () => {
  test('a tool with no change word (scrape_as_markdown) runs with no card', async () => {
    const chat = await newShared()
    const n = callsOf('scrape_as_markdown')
    const r = await askCards('alice', chat.id, via(T('scrape_as_markdown'), { url: 'https://m.example.com/acme/1', format: 'text' }), last)
    expect(r.cards).toEqual([])
    expect(callsOf('scrape_as_markdown')).toBe(n + 1)
  })

  test("the read card says what happens in plain words, with Allow, Always allow and Don't allow", async () => {
    clear()
    const chat = await newShared()
    const n = callsOf('get_post')
    const r = await askCards('alice', chat.id, via(T('get_post'), { url: 'https://m.example.com/acme/222?x=1' }), last)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toBe('Read this page with Bright Data · m.example.com/acme/222')
    expect(r.cards[0]!.question).not.toContain('can’t tell')
    expect(r.cards[0]!.options.map((o) => [o.label, o.value])).toEqual([['Allow', 'allow'], ['Always allow', 'always'], ['Don’t allow', 'deny']])
    expect(r.cards[0]!.note).toContain('in every chat')
    expect(callsOf('get_post')).toBe(n)
    // with no web address: the tool by its title
    const r2 = await askCards('alice', chat.id, via(T('get_post')), last)
    expect(r2.cards[0]!.question).toBe('Read from Bright Data: Get post')
  })

  test('Always allow in chat A: no card in chat B, in a new answer; Settings lists it; another person still asks', async () => {
    clear()
    const a = await newShared()
    const n = callsOf('get_post')
    const first = await askCards('alice', a.id, via(T('get_post'), { url: 'https://example.com/a' }), () => 'always')
    expect(first.cards.length).toBe(1)
    expect(callsOf('get_post')).toBe(n + 1)
    expect(grants('alice')).toEqual(['get_post'])
    const b = await newShared()
    const there = await askCards('alice', b.id, via(T('get_post'), { url: 'https://example.com/b' }), last)
    expect(there.cards).toEqual([])
    expect(callsOf('get_post')).toBe(n + 2)
    // Settings › Allowed for Trina
    const list = await h.api('alice').call(API.listAiAllowances)
    const row = list.items.find((x) => x.kind === 'connector_tool')
    expect(row).toMatchObject({ kind: 'connector_tool', connection: 'Bright Data', tool: 'Get post' })
    // bob's own choice: his card still comes (alice's Always is hers)
    const bobs = await newShared('bob')
    const bob = await askCards('bob', bobs.id, via(T('get_post'), { url: 'https://example.com/c' }), last)
    expect(bob.cards.length).toBe(1)
    expect((await h.api('bob').call(API.listAiAllowances)).items.some((x) => x.kind === 'connector_tool')).toBe(false)
    // and bob cannot delete alice's
    const del = await h.req('bob', `/api/ai-allowances/${encodeURIComponent(row!.id)}`, { method: 'DELETE' })
    expect(del.status).toBe(404)
    expect(grants('alice')).toEqual(['get_post'])
  })

  test('deleting it in Settings asks again', async () => {
    const list = await h.api('alice').call(API.listAiAllowances)
    const row = list.items.find((x) => x.kind === 'connector_tool')!
    await h.api('alice').call(API.deleteAiAllowance, { params: { id: row.id } })
    expect(grants('alice')).toEqual([])
    const c = await newShared()
    const r = await askCards('alice', c.id, via(T('get_post'), { url: 'https://example.com/d' }), last)
    expect(r.cards.length).toBe(1)
  })

  test('a re-pointed connection, the team switch off, or a lost access ends it', async () => {
    clear()
    const a = await newShared()
    await askCards('alice', a.id, via(T('get_post')), () => 'always')
    expect(grants('alice')).toEqual(['get_post'])
    // the connection now points elsewhere than when it was chosen
    db().query("UPDATE connector_tool_allow SET url = 'https://elsewhere.example.com/mcp'").run()
    expect((await askCards('alice', (await newShared()).id, via(T('get_post')), last)).cards.length).toBe(1)
    expect((await h.api('alice').call(API.listAiAllowances)).items.some((x) => x.kind === 'connector_tool')).toBe(false)
    clear()
    await askCards('alice', (await newShared()).id, via(T('get_post')), () => 'always')
    // the team's "Always allow" switch off: the row is ignored, and the card offers no Always
    updateTeamSettings(db(), { roomAlwaysAllow: false })
    try {
      const off = await askCards('alice', (await newShared()).id, via(T('get_post')), last)
      expect(off.cards.length).toBe(1)
      expect(off.cards[0]!.options.map((o) => o.value)).toEqual(['allow', 'deny'])
    } finally { updateTeamSettings(db(), { roomAlwaysAllow: true }) }
    expect((await askCards('alice', (await newShared()).id, via(T('get_post')), last)).cards).toEqual([])
    // the team connection's rule leaves alice out: her Always goes and does not come back with her access
    setAccess(db(), teamId, { everyone: false, groups: [], users: ['bob'] })
    expect(grants('alice')).toEqual([])
    setAccess(db(), teamId, { everyone: true, groups: [], users: [] })
    expect((await askCards('alice', (await newShared()).id, via(T('get_post')), last)).cards.length).toBe(1)
  })

  test('a change still asks every time, also after Always allow on a read', async () => {
    clear()
    await askCards('alice', (await newShared()).id, via(T('get_post')), () => 'always')
    const chat = await newShared()
    const n = callsOf('resend_invoice')
    const r = await askCards('alice', chat.id, via(T('resend_invoice'), { to: 'x@example.com' }), last)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.options.map((o) => o.value)).not.toContain('always')
    expect(callsOf('resend_invoice')).toBe(n)
  })
})
