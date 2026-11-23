// An app on the person's computer (Aside, the listed `aside mcp`) and "항상 허용" (docs/decisions/20261122-connector-always-allow.md).
// The owner, 2026-11-22, on Aside's repl card ("매 콜마다 해야하네") and its shared chat card ("매 대화마다 해야한다니"):
// every connector card offers Always allow, kept per person and tool (or connection) in every chat until removed in
// Settings. Covered: the repl card says "In Aside: <title>" (its code behind Details) with Allow / Always allow / Don't allow;
// Always in a private chat means no card in the next private chat; in a chat shared with bob, Always on the shared card
// and on the repl card means no card at all in another shared chat; bob's turn never uses alice's Aside.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, LOCAL_APP_PRESETS, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const DESK = 'win-aside-always1'
const ASIDE = LOCAL_APP_PRESETS.find((p) => p.id === 'aside')!.spec
const ASIDE_TOOLS = [
  { name: 'browser_profiles', description: 'List browser profiles.', inputSchema: { type: 'object', properties: {} } },
  { name: 'repl', description: 'Run Playwright-style JavaScript in Aside Browser.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, code: { type: 'string' }, profile_id: { type: 'string' } } } },
]
const REPL = (title: string) => fake({ tool: 'my_aside__repl', args: { title, code: "await openTab('https://example.com/')", profile_id: 'p1' }, sayResult: true })

let h: Harness
let desk: TestSocket
let stop: () => void
const calls: string[] = []
let asideId = ''
beforeAll(async () => {
  h = await startHarness({ name: 'c-local-apps-always', askUserTimeoutMs: 5000, relay: { windowGoneMs: 600, sweepMs: 100 } })
  desk = await h.ws('alice', { windowId: DESK, client: 'desktop' })
  await desk.next('hello')
  const done = new Set<string>()
  const timer = setInterval(() => {
    for (const f of desk.frames as ServerFrame[]) {
      if (f.type !== 'local.call' || done.has(f.data.call.callId)) continue
      const call = f.data.call
      done.add(call.callId)
      desk.send({ type: 'local.ack', callId: call.callId })
      const m = call.message as { id?: string; method: string; params?: { name?: string } }
      if (m.method === 'tools/call') calls.push(m.params?.name ?? '')
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aside', version: '1.26.1115.1556' } }
        : m.method === 'tools/list' ? { tools: ASIDE_TOOLS }
        : m.method === 'tools/call' ? { content: [{ type: 'text', text: `ran ${m.params?.name}` }] }
        : null
      desk.send({ type: 'local.result', result: { callId: call.callId, ok: true, message: m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result } } })
    }
  }, 20)
  stop = () => clearInterval(timer)
  const made = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.createLocalIntegration, { body: { name: 'Aside', spec: ASIDE } })
  expect(made.status).toBe('connected')
  asideId = made.id
})
afterAll(async () => { stop?.(); desk?.close(); await h?.close() })
beforeEach(() => {
  h.ctx.db.query('DELETE FROM connector_tool_allow').run()
  h.ctx.db.query("UPDATE integrations SET write_policy = 'ask' WHERE id = ?").run(asideId)
})

type Card = { question: string; options: { label: string; value: string }[]; buttons?: boolean; note?: string }
/** a turn from alice's desktop whose cards are answered by `pick` until it ends */
async function ask(chatId: string, content: string, pick: (c: Card) => string) {
  const started = await h.api('alice', { window: DESK, client: 'desktop' }).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const answered = new Set<string>()
  const cards: Card[] = []
  const timer = setInterval(() => {
    for (const fr of desk.frames) {
      if (fr.type !== 'turn.request') continue
      const d = (fr as { data: { turnId: string; request: { requestId: string } & Card } }).data
      if (d.turnId !== started.turnId || answered.has(d.request.requestId)) continue
      answered.add(d.request.requestId)
      cards.push(d.request)
      void h.api('alice').call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: d.request.requestId, answer: pick(d.request) } }).catch(() => {})
    }
  }, 20)
  try {
    const done = await desk.next('message.done', (fr) => fr.data.messageId === started.assistantMessage.id, 40_000)
    await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
    return { started, cards, content: done.data.message.content as string }
  } finally { clearInterval(timer) }
}
const always = () => 'always'
const deny = (c: Card) => c.options.at(-1)!.value
const privateChat = async () => (await h.api('alice').call(API.createChat, { body: {} })).id
async function sharedWithBob() {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const put = (confirmKey?: string) => h.api('alice').call(API.putChatAudience, { params: { id: c.id }, body: { subjects: [{ subjectType: 'user', subjectId: 'bob' }], ...(confirmKey ? { confirmKey } : {}) } })
  let r = await put()
  if (r.status === 'confirm') r = await put(r.confirmKey)
  expect(r.status).toBe('saved')
  return c.id
}
const repls = () => calls.filter((c) => c === 'repl').length

describe("Aside's repl: one card with Always allow, in every chat", () => {
  test('the card says what happens in plain words, one press, and Don\'t allow runs nothing', async () => {
    const n = repls()
    const r = await ask(await privateChat(), REPL('Open the mail page'), deny)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.question).toBe('Run a task in Aside · the AI calls it: Open the mail page')
    expect(r.cards[0]!.question).not.toContain('send')
    // the code, the profile id: behind one "Details" (users are not developers)
    expect((r.cards[0] as { details?: { hidden?: boolean }[] }).details?.every((d) => d.hidden)).toBe(true)
    expect(r.cards[0]!.options.map((o) => [o.label, o.value])).toEqual([['Allow', 'allow'], ['Always allow', 'always'], ['Don’t allow', 'deny']])
    expect(r.cards[0]!.buttons).toBe(true)
    expect(repls()).toBe(n)
  })

  test('with no title the card says a plain generic line', async () => {
    const r = await ask(await privateChat(), fake({ tool: 'my_aside__repl', args: { code: 'listBrowserTabs()' }, sayResult: true }), deny)
    expect(r.cards[0]!.question).toBe('Run a task in Aside')
  })

  test('a private chat: Always allow, then no card in the next private chat', async () => {
    const n = repls()
    const first = await ask(await privateChat(), REPL('one'), always)
    expect(first.cards.length).toBe(1)
    expect(repls()).toBe(n + 1)
    const next = await ask(await privateChat(), REPL('two'), deny)
    expect(next.cards).toEqual([])
    expect(repls()).toBe(n + 2)
  })

  test('a chat shared with bob: the one notice and Always on the repl card; another shared chat shows only its own notice', async () => {
    const n = repls()
    const pick = (c: Card) => (c.options.some((o) => o.value === 'always') ? 'always' : c.options[0]!.value)
    const a = await ask(await sharedWithBob(), REPL('in A'), pick)
    // the one notice of this shared chat (docs/decisions/20261123-shared-connector-warning-once.md) and the repl card
    expect(a.cards.length).toBe(2)
    expect(a.cards[0]!.question).toBe('Other people in this chat can also see what the AI gets from Aside.')
    expect(a.cards[0]!.question).not.toContain('을(를)')
    expect(a.cards[0]!.buttons).toBe(true)
    expect(a.cards[0]!.options.map((o) => o.value)).toEqual(['once'])
    expect(a.cards[1]!.question).toBe('Run a task in Aside · the AI calls it: in A')
    expect(repls()).toBe(n + 1)
    // another chat shared with bob (in no project): its own notice once, the repl's Always holds
    const b = await ask(await sharedWithBob(), REPL('in B'), deny)
    expect(b.cards.map((c) => c.question)).toEqual(['Other people in this chat can also see what the AI gets from Aside.'])
    expect(repls()).toBe(n + 2)
    // Settings › Allowed for Trina lists the repl's Always and the two notices; removing the repl one asks again
    const items = (await h.api('alice').call(API.listAiAllowances)).items.filter((x) => x.kind === 'connector_tool')
    expect(items.map((x) => (x.kind === 'connector_tool' ? [x.connection, x.tool, !!x.shared, x.warned !== undefined] : null)).sort()).toEqual([['Aside', '', true, true], ['Aside', '', true, true], ['Aside', 'Repl', false, false]].sort())
    await h.api('alice').call(API.deleteAiAllowance, { params: { id: items.find((x) => x.kind === 'connector_tool' && !x.shared)!.id } })
    const c = await ask(await sharedWithBob(), REPL('in C'), deny)
    // its notice (a new chat), then the repl card again: no is pressed, nothing runs
    expect(c.cards.length).toBe(2)
    expect(repls()).toBe(n + 2)
  })
})
