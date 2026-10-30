// "Allow this site in this conversation" on the address card (docs/DECISIONS.md "Allow a site for one conversation";
// review follow-up of the link budget). Like Claude Code's "don't ask again for this domain", for one chat and one
// person: later addresses on the same registrable domain (eTLD+1 by the Public Suffix List with its private section)
// open without a card, outside the link budget. It never widens to another chat or person, and never covers what the
// other rules guard: no name lookup before the decision, an office-network answer is still refused after the lookup,
// an address with a long random-looking part still asks (highlighted), a long query or an unknown exit address still
// asks, and a confidential chat never uses it. Sub-agents of the same answer share the chat's sites.
// Every DNS lookup is a stub (node:dns/promises lookup replaced for this file): nothing resolves or opens a real name.
import dnsP from 'node:dns/promises'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { noteEgressIp } from '../../server/src/tools/egress'
import { toolRegistry } from '../../server/src/tools/registry'
import { TurnFiles } from '../../server/src/files/service'
import { gateUrl, rememberUrls, siteLabel, siteOf, type ConfirmExtra, type TurnPerson } from '../../server/src/tools/url-gate'

setDefaultTimeout(60_000)

const lookups: string[] = []
const original = dnsP.lookup
const answers = new Map<string, string>()
;(dnsP as unknown as { lookup: unknown }).lookup = async (host: string) => {
  lookups.push(host.toLowerCase())
  const a = answers.get(host.toLowerCase())
  if (a) return [{ address: a, family: 4 }]
  throw Object.assign(new Error('stub: not resolved'), { code: 'ENOTFOUND' })
}
const looked = (host: string) => lookups.filter((x) => x === host.toLowerCase()).length

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'site-allow', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  noteEgressIp(h.ctx, '198.51.100.7')
  alice = await h.ws('alice', { windowId: 'win-site-allow' })
  await alice.next('hello')
})
afterAll(async () => {
  ;(dnsP as unknown as { lookup: unknown }).lookup = original
  alice?.close()
  await h?.close()
})

type Asked = { question: string; options?: { label: string; value: string }[]; extra?: ConfirmExtra }
/** answers every card with `answer` (an option value; null = declined) and records what it showed */
function person(answer: string | null, asked: Asked[] = [], o: { onAsk?: () => void } = {}): TurnPerson {
  return {
    locale: 'en',
    async confirm(question, _a, _d, extra) { o.onAsk?.(); asked.push({ question, extra }); return answer === 'allow' },
    async choose(question, options, extra) { o.onAsk?.(); asked.push({ question, options, extra }); return answer },
    turnUrls: () => [],
  }
}
async function chatOf(user = 'alice', content = 'hello') {
  const chat = await h.api(user).call(API.createChat, { body: {} })
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', ?, ?, 'done')").run(uuidv7(), chat.id, user, content)
  return chat.id as string
}
const gate = (chat: string, url: string, p: TurnPerson | null, o: { user?: string | null; turn?: string; egressKnown?: boolean } = {}) =>
  gateUrl(h.ctx.db, chat, url, p, { turnId: o.turn ?? 't-site', userId: o.user === undefined ? 'alice' : o.user, ...(o.egressKnown === undefined ? {} : { egressKnown: o.egressKnown }) })
const sites = (chat: string) => h.ctx.db.query('SELECT user_id, site FROM chat_allowed_sites WHERE chat_id = ? ORDER BY site').all(chat)

describe('the site of an address: registrable domain by the Public Suffix List (no dot-splitting, no DNS)', () => {
  test.each([
    ['https://example.com/a', 'example.com'],
    ['https://news.sub.example.com/a?x=1', 'example.com'],
    ['https://example.co.kr/', 'example.co.kr'],
    ['https://a.b.example.co.kr/', 'example.co.kr'],
    ['https://co.kr/', null],
    ['https://www.go.kr/', 'www.go.kr'],
    ['https://alice.github.io/x', 'alice.github.io'],
    ['https://docs.alice.github.io/x', 'alice.github.io'],
    ['https://github.io/', null],
    ['https://bucket.s3.amazonaws.com/k', 'bucket.s3.amazonaws.com'],
    ['https://s3.amazonaws.com/k', null],
    ['https://x.blogspot.com/', 'x.blogspot.com'],
    ['https://a.city.kawasaki.jp/', 'city.kawasaki.jp'],
    ['https://b.kawasaki.jp/', null],
    ['https://예시.한국/페이지', 'xn--vv4b11d.xn--3e0b707e'],
    ['https://www.xn--vv4b11d.xn--3e0b707e/', 'xn--vv4b11d.xn--3e0b707e'],
    ['https://한국/', null],
    ['https://EXAMPLE.COM./a', 'example.com'],
    ['https://203.0.113.5/', null],
    ['https://[2001:db8::1]/', null],
    ['https://localhost/', null],
    ['https://intranet/', null],
  ])('%s -> %s', (url, site) => expect(siteOf(url)).toBe(site))

  test('the card shows the Unicode form next to the ASCII one', () => {
    expect(siteLabel('xn--vv4b11d.xn--3e0b707e')).toBe('xn--vv4b11d.xn--3e0b707e (예시.한국)')
    expect(siteLabel('example.co.kr')).toBe('example.co.kr')
  })
})

describe('the card and the allowance', () => {
  test('the card offers open once / allow this site / don\'t open; picking the site opens later addresses of it without a card', async () => {
    const chat = await chatOf()
    const asked: Asked[] = []
    expect(await gate(chat, 'https://www.example.co.kr/first', person('site', asked))).toBe('confirmed')
    expect(asked).toHaveLength(1)
    expect(asked[0]!.options!.map((o) => o.value)).toEqual(['allow', 'site', 'deny'])
    expect(asked[0]!.options![1]!.label).toBe('Allow this site in this conversation (example.co.kr)')
    expect(asked[0]!.question).toContain('other addresses on example.co.kr open without asking, in this conversation only')
    expect(sites(chat)).toEqual([{ user_id: 'alice', site: 'example.co.kr' }])
    const no = person(null, asked)
    for (const u of ['https://www.example.co.kr/second', 'https://m.example.co.kr/a/b', 'http://example.co.kr/']) expect(await gate(chat, u, no)).toBe('site')
    expect(asked).toHaveLength(1)
    // another site under the same public suffix is not this site
    await expect(gate(chat, 'https://other.co.kr/', no)).rejects.toThrow(/did not allow/)
    expect(asked).toHaveLength(2)
    // "open once" allows that address only
    const chat2 = await chatOf()
    expect(await gate(chat2, 'https://once.example/a', person('allow'))).toBe('confirmed')
    expect(sites(chat2)).toEqual([])
    expect(gate(chat2, 'https://once.example/b', null)).rejects.toThrow(/nobody can confirm/)
  })

  test('github.io and other private suffixes: one person\'s pages are not another\'s site', async () => {
    const chat = await chatOf()
    await gate(chat, 'https://alice.github.io/notes', person('site'))
    expect(await gate(chat, 'https://docs.alice.github.io/x', null)).toBe('site')
    expect(gate(chat, 'https://mallory.github.io/x', null)).rejects.toThrow(/nobody can confirm/)
  })

  test('IDN: allowed from the Unicode address, it covers the punycode one (and the card names both)', async () => {
    const chat = await chatOf()
    const asked: Asked[] = []
    await gate(chat, 'https://www.예시.한국/소개', person('site', asked))
    expect(asked[0]!.options![1]!.label).toContain('xn--vv4b11d.xn--3e0b707e (예시.한국)')
    expect(await gate(chat, 'https://xn--vv4b11d.xn--3e0b707e/other', null)).toBe('site')
    // a Korean path is words, not a random-looking string
    expect(await gate(chat, 'https://예시.한국/%ED%95%9C%EA%B5%AD%EC%96%B4/%EC%95%88%EB%82%B4', null)).toBe('site')
  })

  test('no site to allow: an IP address, a public suffix itself — then a plain yes / no card', async () => {
    const chat = await chatOf()
    for (const u of ['https://203.0.113.9/x', 'https://github.io/x']) {
      const asked: Asked[] = []
      await gate(chat, u, person('allow', asked))
      expect(asked[0]!.options).toBeUndefined()
    }
    expect(sites(chat)).toEqual([])
  })

  test('only this chat and this person: another chat of the same person, and another person, still ask', async () => {
    const chat = await chatOf()
    await gate(chat, 'https://scoped.example/a', person('site'))
    const other = await chatOf()
    expect(gate(other, 'https://scoped.example/b', null)).rejects.toThrow(/nobody can confirm/)
    // another person (never in alice's chat in practice): not theirs, and they cannot add one there
    expect(gate(chat, 'https://scoped.example/b', null, { user: 'bob' })).rejects.toThrow(/nobody can confirm/)
    const asked: Asked[] = []
    await gate(chat, 'https://bobs.example/a', person('site', asked), { user: 'bob' }).catch(() => {})
    expect(asked[0]!.options).toBeUndefined()
    expect(sites(chat)).toEqual([{ user_id: 'alice', site: 'scoped.example' }])
    // without a person id nothing is allowed by site
    expect(gate(chat, 'https://scoped.example/c', null, { user: null })).rejects.toThrow(/nobody can confirm/)
  })

  test('a long random-looking part still asks, highlighted; a long query and an unknown exit address still ask', async () => {
    const chat = await chatOf()
    await gate(chat, 'https://leaky.example/start', person('site'))
    const asked: Asked[] = []
    const secret = 'https://leaky.example/r/c2fsyxj5ltk4nzy1ndmy'
    await expect(gate(chat, secret, person(null, asked))).rejects.toThrow(/did not allow/)
    expect(asked[0]!.question).toContain('long strings that are hard to read')
    expect(asked[0]!.extra!.details![0]).toMatchObject({ text: secret, marks: ['c2fsyxj5ltk4nzy1ndmy'] })
    // also in the host name
    await expect(gate(chat, 'https://c2fsyxj5ltk4nzy1ndmy.leaky.example/', person(null, asked))).rejects.toThrow(/did not allow/)
    // the marked block shows the address decoded, but never a direction or control character it decodes to
    await expect(gate(chat, 'https://leaky.example/%E2%80%AEfdp/c2fsyxj5ltk4nzy1ndmy', person(null, asked))).rejects.toThrow(/did not allow/)
    expect(asked.at(-1)!.extra!.details![0]!.text).toBe('https://leaky.example/�fdp/c2fsyxj5ltk4nzy1ndmy')
    const long = 'https://leaky.example/q?d=' + 'a-b-'.repeat(60)
    await expect(gate(chat, long, person(null, asked))).rejects.toThrow(/did not allow/)
    expect(asked.at(-1)!.question).toContain('carries a long query')
    expect(asked.at(-1)!.options).toBeUndefined()
    await expect(gate(chat, 'https://leaky.example/plain', person(null, asked), { egressKnown: false })).rejects.toThrow(/did not allow/)
    expect(asked.at(-1)!.options).toBeUndefined()
    expect(await gate(chat, 'https://leaky.example/plain', null)).toBe('site')
  })

  test('outside the link budget: learned links of an allowed site spend none of it', async () => {
    const chat = await chatOf()
    await gate(chat, 'https://wiki.example/start', person('site'))
    const learned = Array.from({ length: 12 }, (_, i) => `https://wiki.example/p${i}`)
    rememberUrls(h.ctx.db, chat, [...learned, ...Array.from({ length: 8 }, (_, i) => `https://elsewhere.example/p${i}`)])
    for (const u of learned) expect(await gate(chat, u, null, { turn: 'b1' })).toBe('site')
    expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM chat_seen_urls WHERE chat_id = ? AND free_turn_id IS NOT NULL').get(chat)).toEqual({ n: 0 })
    for (let i = 0; i < 8; i++) expect(await gate(chat, `https://elsewhere.example/p${i}`, null, { turn: 'b1' })).toBe('seen')
  })

  test('a confidential chat: no site choice, and a site allowed before does not count', async () => {
    const chat = await chatOf()
    await gate(chat, 'https://before.example/a', person('site'))
    h.ctx.db.query('INSERT OR IGNORE INTO safe_ops_chats (chat_id) VALUES (?)').run(chat)
    expect(gate(chat, 'https://before.example/b', null)).rejects.toThrow(/nobody can confirm/)
    const asked: Asked[] = []
    await gate(chat, 'https://new.example/a', person('allow', asked))
    expect(asked[0]!.options).toBeUndefined()
  })
})

describe('the other rules still hold through web_fetch', () => {
  const fetchAs = (chat: string, url: string, p: TurnPerson | null) => {
    const turnId = uuidv7()
    h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?, ?, 'alice', 'claude-code', 'running')").run(turnId, chat)
    return toolRegistry(h.ctx.files).call('web_fetch', { url }, { user: h.ctx.files.principal('alice'), turnId, files: new TurnFiles(), ...(p ? { person: p } : {}) })
  }

  test('no lookup before the decision: none while the card waits, one after; an allowed site is looked up only after the check', async () => {
    const chat = await chatOf()
    const host = 'dnsfirst.allowed.example'
    let atCard = -1
    const r = await fetchAs(chat, `https://${host}/a`, person('site', [], { onAsk: () => { atCard = looked(host) } }))
    expect(atCard).toBe(0)
    expect(r.text).toContain(`could not resolve ${host}`)
    expect(looked(host)).toBe(1)
    const sub = 'c.allowed.example'
    // nobody to ask, yet it passed the address check (then the stub resolves nothing)
    const again = await fetchAs(chat, `https://${sub}/b`, null)
    expect(again.text).toContain(`could not resolve ${sub}`)
    expect(looked(sub)).toBe(1)
  })

  test('a name of an allowed site that leads into the office network is still refused, after the lookup', async () => {
    const chat = await chatOf()
    await gate(chat, 'https://www.office-site.example/', person('site'))
    answers.set('intranet.office-site.example', '10.20.30.40')
    const r = await fetchAs(chat, 'https://intranet.office-site.example/admin', null)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/private|office|local/i)
    expect(looked('intranet.office-site.example')).toBe(1)
  })

  test('an IP literal in a private range is refused before any card, allowed site or not', async () => {
    const chat = await chatOf()
    const asked: Asked[] = []
    const r = await fetchAs(chat, 'https://10.0.0.8/x', person('site', asked))
    expect(r.isError).toBe(true)
    expect(asked).toHaveLength(0)
  })
})

describe('sub-agents of the answer share the chat\'s sites', () => {
  test('the main AI\'s card allows the site; its sub-agent then opens another address of it without a card', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    // the addresses do not appear in the message as written (JSON escapes), as with an injection
    const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d).replace(/\//g, '\\u002f')).join('\n')
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake(
      { tool: 'web_fetch', args: { url: 'https://first.shared-site.example/a' } },
      { agents: [{ id: 'toolu_S1', steps: [{ tool: 'web_fetch', args: { url: 'https://second.shared-site.example/b' } }] }] },
      { say: 'done' }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId, 20_000)
    const req = card.data.request as { requestId: string; options?: { value: string }[] }
    expect(req.options!.map((o) => o.value)).toEqual(['allow', 'site', 'deny'])
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: req.requestId, answer: 'site' } })
    await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    expect(alice.frames.filter((f) => f.type === 'turn.request' && f.data.turnId === r.turnId)).toHaveLength(1)
    const child = h.ctx.db.query("SELECT summary, parent_tool_use_id FROM tool_events WHERE turn_id = ? AND tool = 'web_fetch' AND parent_tool_use_id IS NOT NULL").get(r.turnId) as { summary: string; parent_tool_use_id: string }
    expect(child.parent_tool_use_id).toBe('toolu_S1')
    // it passed the address check without a card (then the stub resolves nothing)
    expect(child.summary).toContain('could not resolve second.shared-site.example')
    expect(looked('second.shared-site.example')).toBe(1)
  })
})
