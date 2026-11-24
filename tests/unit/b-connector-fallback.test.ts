// A built-in tool that fails and a connected tool that does the same job (F1 measurement, 2026-11-24: web_fetch got a
// 403, the AI asked "shall I try <service>?" and the person repeated the request three times). What the AI is told:
// web_fetch's description and its failure, and "Connected services", say to use a connected tool that only reads at
// once, without asking, in general words (no service named). What the server does, with the fake engine through the
// real launcher and gate: after the 403 the read-only connected tool runs with no card and no ask, in a private chat and
// in a shared chat whose one connection notice was seen; a connected tool that changes something still shows its card.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { warnedIn } from '../lib/shared-warned'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { FALLBACK_TO_CONNECTION, integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { FETCH_FALLBACK_HINT, FETCH_FALLBACK_LINE, SITE_REFUSED } from '../../server/src/tools'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const READ = 'team_pagereader__read_page'
const CHANGE = 'team_pagereader__create_task'
/** service names the guidance must not carry: it is general, for every connection */
const NAMES = /bright ?data|firecrawl|apify|aside|scrap(e|er) ?(api|ing ?bee)|zenrows|exa|tavily|perplexity/i

let h: Harness, svc: FakeServices
let site: ReturnType<typeof Bun.serve>
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  // a site that refuses the server's fetch, as the F1 page did
  site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => new URL(req.url).pathname === '/blocked' ? new Response('Forbidden', { status: 403 }) : new URL(req.url).pathname.startsWith('/missing') ? new Response('Not here', { status: 404 }) : new Response('<html><body><p>open page</p></body></html>', { headers: { 'content-type': 'text/html' } }) })
  h = await startHarness({ name: 'b-connector-fallback', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000, fetch: { testAllow: (ip) => ip === '127.0.0.1', lookup: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs: 3000 } })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  svc = new FakeServices()
  // a page reader marked read-only by its service, next to the fake service's own change tool (create_task)
  svc.tools = [...svc.tools, { name: 'read_page', description: 'Reads a web page and returns its text', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, annotations: { readOnlyHint: true } }]
  integrationsOf(h.ctx, { net: svc.net() })
  const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Page Reader', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(team.status).toBe('connected')
})
beforeEach(() => { if (h && projectId) warnedIn(h.ctx.db, `p:${projectId}`) })
afterAll(async () => { for (const s of Object.values(ws)) s.close(); svc?.stop(); site?.stop(true); await h?.close() })

const blocked = () => `http://blocked.example:${site.port}/blocked`
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
type Card = { question: string; options: { label: string; value: string }[] }
/** a turn whose cards are answered "no" (the last option) until it ends; returns the cards and the answer */
async function turn(user: string, chatId: string, content: string) {
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
      void h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: d.request.requestId, answer: d.request.options.at(-1)!.value } }).catch(() => {})
    }
  }, 20)
  try {
    const d = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
    await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
    return { started, cards, done: d.data.message as Message }
  } finally { clearInterval(timer) }
}
const events = (turnId: string) => h.ctx.db.query('SELECT tool, ok, summary FROM tool_events WHERE turn_id = ? ORDER BY id').all(turnId) as { tool: string; ok: number; summary: string }[]
const reads = () => svc.calls.filter((c) => c.name === 'read_page').length
const creates = () => svc.calls.filter((c) => c.name === 'create_task').length

describe('what the AI is told', () => {
  test('web_fetch: its description and a refused page say to use a connected read-only tool at once, in general words', () => {
    expect(FETCH_FALLBACK_LINE).toContain('without asking')
    expect(FETCH_FALLBACK_HINT).toContain('instead of asking the user whether to try it')
    for (const s of [FETCH_FALLBACK_LINE, FETCH_FALLBACK_HINT, FALLBACK_TO_CONNECTION]) expect(s).not.toMatch(NAMES)
  })
  test('the hint goes only with a site that refused the server: not a missing page, an unknown name, a refused address or a no', () => {
    for (const m of ['the site answered HTTP 403', 'the site answered HTTP 401', 'the site answered HTTP 429', 'the site answered HTTP 503', 'the site sent no valid HTTP response']) expect([m, SITE_REFUSED.test(m)]).toEqual([m, true])
    for (const m of ['the site answered HTTP 404', 'the site answered HTTP 500', 'could not resolve intranet.corp', 'intranet.corp points to a private, local or reserved address', 'the user did not allow following the redirect, so the page was not opened', 'not a valid URL']) expect([m, SITE_REFUSED.test(m)]).toEqual([m, false])
    expect(FALLBACK_TO_CONNECTION).toContain('Never after the user said no on a card')
  })
  test('"Connected services" carries the rule when something is connected; a change tool still names its card', () => {
    const b = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'none', turnId: 'none', browser: false, scheduled: false })
    expect(b.prompt).toContain(FALLBACK_TO_CONNECTION)
    expect(FALLBACK_TO_CONNECTION).toContain('do not ask whether to try it')
    expect(FALLBACK_TO_CONNECTION).toContain('still asks on its card')
    expect(b.tools.find((t) => t.name === READ)!.description).not.toContain('Changes something at the service')
    expect(b.tools.find((t) => t.name === CHANGE)!.description).toContain('Changes something at the service')
  })
})

describe('a page that will not open, then the connected reader', () => {
  test('private chat: the 403 says what to do next; the read-only connected tool runs with no card and no ask', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const n = reads()
    const r = await turn('alice', chat.id, `${blocked()}\n` + fake(
      { tool: 'web_fetch', args: { url: blocked() }, sayResult: true },
      { tool: READ, args: { url: blocked() }, sayResult: true },
    ))
    expect(r.cards).toEqual([])
    const ev = events(r.started.turnId)
    const fetchEv = ev.find((e) => e.tool === 'web_fetch')!
    expect(fetchEv.ok).toBe(0)
    expect(r.done.content).toContain('the site answered HTTP 403')
    expect(r.done.content).toContain(FETCH_FALLBACK_HINT)
    expect(reads()).toBe(n + 1)
    expect(ev.some((e) => e.tool === READ && e.ok === 1)).toBe(true)
    expect(ev.some((e) => e.tool === 'ask_user')).toBe(false)
  })

  test('shared chat after its one notice: the same, no card; a change tool there still shows its card and does nothing on no', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: { projectId } })
    const n = reads()
    const r = await turn('alice', chat.id, `${blocked()}\n` + fake(
      { tool: 'web_fetch', args: { url: blocked() }, sayResult: true },
      { tool: READ, args: { url: blocked() }, sayResult: true },
    ))
    expect(r.cards).toEqual([])
    expect(reads()).toBe(n + 1)
    const c = creates()
    const w = await turn('alice', chat.id, fake({ tool: CHANGE, args: { title: 'from the page' }, sayResult: true }))
    expect(w.cards.length).toBe(1)
    expect(creates()).toBe(c)
  })

  test('a page that is not there (404): no hint, the AI is not sent elsewhere', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const gone = `http://blocked.example:${site.port}/missing-404`
    const r = await turn('alice', chat.id, `${gone}\n` + fake({ tool: 'web_fetch', args: { url: gone }, sayResult: true }))
    expect(r.done.content).toContain('the site answered HTTP 404')
    expect(r.done.content).not.toContain(FETCH_FALLBACK_HINT)
  })

  test('a private chat: a change tool after a failed fetch still asks on its card', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const c = creates()
    const r = await turn('alice', chat.id, `${blocked()}\n` + fake(
      { tool: 'web_fetch', args: { url: blocked() }, sayResult: true },
      { tool: CHANGE, args: { title: 'page' }, sayResult: true },
    ))
    expect(r.cards.length).toBe(1)
    expect(creates()).toBe(c)
  })
})
