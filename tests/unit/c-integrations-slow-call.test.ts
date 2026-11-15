// A connection's tool that takes minutes (a web scraper: Bright Data's LinkedIn scrape answers in 1-2 minutes, and the
// 30 s of a request cut every call, 2026-11-15). A tools/call waits as long as the service works on it: it fails only
// when nothing comes for MCP_CALL_IDLE_MS (progress notifications for our progressToken, or any bytes, keep it alive),
// and in any case at MCP_CALL_TIMEOUT_MS, under the engines' own 30 minutes. Stop ends the call at once and tells the
// service. The limits are scaled down here (the net options tests may set: 1 s of "request" stands for 30 s, so the
// 3 s silent call is the 90 s one), the code is the same.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { MCP_CALL_IDLE_MS, MCP_CALL_TIMEOUT_MS, MCP_LIST_TIMEOUT_MS } from '../../server/src/integrations/connections/mcp'
import { TIMEOUT_MS } from '../../server/src/integrations/connections/net'
import { getRow } from '../../server/src/integrations/connections/store'
import { TEXT } from '../../server/src/integrations/connections/text'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { MCP_TOOL_TIMEOUT_MS } from '../../server/src/engine/claude'
import { CODEX_TOOL_TIMEOUT_SEC } from '../../server/src/engine/codex'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnToolContext } from '../../server/src/services'

setDefaultTimeout(30_000)

/** a request (initialize), a call with nothing coming, a whole call: 1/30 of the real 30 s, 5 min, 15 min */
const REQUEST_MS = 1000, IDLE_MS = 10_000, CALL_MS = 30_000
/** the same, smaller, for the tests of the limits themselves */
const SHORT = { idle: 1500, call: 4000 }

let A: CApp, fake: FakeServices, id = ''
beforeAll(async () => {
  A = await makeCApp('c-integrations-slow-call')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: { ...fake.net(), timeoutMs: REQUEST_MS, callIdleMs: IDLE_MS, callTimeoutMs: CALL_MS } })
  fake.tools = [{ name: 'scrape_as_markdown', description: 'scrape a page', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, annotations: { readOnlyHint: true } }]
  // a team connection an admin added (the owner's Bright Data case), for everyone
  const json = { 'content-type': 'application/json' }
  const r = await A.json('/api/admin/integrations', { method: 'POST', as: 'carol', headers: json, body: JSON.stringify({ kind: 'mcp', name: 'Scraper', url: `${fake.base}/mcp-open`, auth: 'none' }) })
  expect(r.body).toMatchObject({ scope: 'team', status: 'connected' })
  id = r.body.id
  expect((await A.json(`/api/integrations/${id}`, { method: 'PATCH', as: 'carol', headers: json, body: JSON.stringify({ access: { everyone: true, groups: [], users: [] } }) })).status).toBe(200)
})
afterAll(async () => { fake?.stop(); await A?.close() })

const svc = () => integrationsOf(A.ctx)
const row = () => getRow(A.ctx.db, id)!
const stored = () => { const r = row(); return { status: r.status, last_error: r.last_error } }
const timed = async <T>(run: () => Promise<T>) => { const t0 = Date.now(); try { return { r: await run(), ms: Date.now() - t0 } } catch (e) { return { e: e as Error, ms: Date.now() - t0 } } }
const short = async <T>(run: () => Promise<T>) => {
  const net = svc().net
  net.callIdleMs = SHORT.idle; net.callTimeoutMs = SHORT.call
  try { return await run() } finally { net.callIdleMs = IDLE_MS; net.callTimeoutMs = CALL_MS }
}

function turn(user: Person, signal = new AbortController().signal) {
  const chat = A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: false })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles() } as TurnToolContext['files']
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal, files }
  return { tools: new Map(built.tools.map((t) => [t.name, t])), tc }
}

test('the real limits: 5 minutes with nothing coming, 15 minutes in all, under the engines\' 30 minutes; the words say so', () => {
  expect([TIMEOUT_MS, MCP_CALL_IDLE_MS, MCP_CALL_TIMEOUT_MS]).toEqual([30_000, 5 * 60_000, 15 * 60_000])
  // a 90 s scrape fits with room; the engines wait longer than we do, so the AI gets our reason
  expect(MCP_CALL_IDLE_MS).toBeGreaterThan(90_000)
  expect(MCP_CALL_TIMEOUT_MS).toBeLessThan(MCP_TOOL_TIMEOUT_MS)
  expect(MCP_CALL_TIMEOUT_MS).toBeLessThan(CODEX_TOOL_TIMEOUT_SEC * 1000)
  // a check keeps its own 90 s (the relay's 100 s for an answer to start): not changed here
  expect(MCP_LIST_TIMEOUT_MS).toBe(90_000)
  for (const L of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
    expect(TEXT.call_idle[L]).toContain(String(MCP_CALL_IDLE_MS / 60_000))
    expect(TEXT.call_timeout[L]).toContain(String(MCP_CALL_TIMEOUT_MS / 60_000))
  }
})

describe('a slow tool', () => {
  test('a silent call three times the request limit (the 90 s scrape) goes through, in a turn too', async () => {
    fake.slow = { ms: 3 * REQUEST_MS }
    try {
      const { r, ms } = await timed(() => svc().callTool(row(), 'scrape_as_markdown', { url: 'https://example.com/post' }))
      expect(r).toMatchObject({ content: [{ type: 'text', text: 'scrape_as_markdown: done after 3000 ms' }] })
      expect(ms).toBeGreaterThanOrEqual(3 * REQUEST_MS)
      // what the AI gets through the team connection's tool
      const { tools, tc } = turn('alice')
      const out = await tools.get('team_scraper__scrape_as_markdown')!.call({ url: 'https://example.com/post' }, tc)
      expect(out.isError).toBeFalsy()
      expect(JSON.stringify(out.content)).toContain('done after 3000 ms')
    } finally { fake.slow = null }
    expect(stored()).toEqual({ status: 'connected', last_error: null })
    // every call names a progressToken of its own, so a service may report progress
    const tokens = fake.progressTokens.slice(-2)
    expect(tokens.every((t) => typeof t === 'string' && t.length > 10)).toBe(true)
    expect(tokens[0]).not.toBe(tokens[1])
  })

  test('progress notifications keep a call alive past the pause limit, up to the whole call\'s limit', async () => {
    await short(async () => {
      // 3 s, past the 1.5 s pause limit, with progress every 300 ms
      fake.slow = { ms: 3000, progressEveryMs: 300 }
      try {
        const { r, ms } = await timed(() => svc().callTool(row(), 'scrape_as_markdown', {}))
        expect(r).toMatchObject({ content: [{ text: 'scrape_as_markdown: done after 3000 ms' }] })
        expect(ms).toBeGreaterThanOrEqual(3000)
      } finally { fake.slow = null }
    })
  })

  test('nothing coming for the pause limit fails cleanly, long before the whole call\'s limit', async () => {
    await short(async () => {
      fake.slow = { ms: 10_000 }
      try {
        const { e, ms } = await timed(() => svc().callTool(row(), 'scrape_as_markdown', {}))
        expect(e?.message).toBe(`Scraper sent nothing for 5 minutes, so the call was stopped (a call may run up to 15 minutes while the service keeps sending)`)
        expect(ms).toBeGreaterThanOrEqual(SHORT.idle)
        expect(ms).toBeLessThan(SHORT.call)
      } finally { fake.slow = null }
    })
    expect(stored()).toEqual({ status: 'error', last_error: 'call_idle' })
    // Settings words, and a call that goes through clears it
    expect((await A.json('/api/admin/integrations', { as: 'carol' })).body.items.find((i: any) => i.id === id).lastError).toBe(TEXT.call_idle.en)
    await svc().callTool(row(), 'scrape_as_markdown', {})
    expect(stored()).toEqual({ status: 'connected', last_error: null })
  })

  test('a call past the hard limit fails cleanly at it, even while progress keeps coming (a hung service cannot hold the turn)', async () => {
    fake.cancelled = []
    await short(async () => {
      fake.slow = { ms: 20_000, progressEveryMs: 200 }
      try {
        const { tools, tc } = turn('alice')
        const t0 = Date.now()
        const out = await tools.get('team_scraper__scrape_as_markdown')!.call({}, tc)
        const ms = Date.now() - t0
        expect(out.isError).toBe(true)
        expect(JSON.stringify(out.content)).toContain('did not finish within 15 minutes, so the call was stopped')
        expect(ms).toBeGreaterThanOrEqual(SHORT.call)
        expect(ms).toBeLessThan(SHORT.call + 2000)
      } finally { fake.slow = null }
    })
    expect(stored()).toEqual({ status: 'error', last_error: 'call_timeout' })
    // the service is told to stop its work (it may be billing for it)
    for (let i = 0; i < 40 && !fake.cancelled.length; i++) await Bun.sleep(50)
    expect(fake.cancelled).toEqual([{ requestId: fake.progressTokens.at(-1), reason: 'timed out' }])
    expect(TEXT.call_timeout.en).toBe('A tool of the service did not finish within 15 minutes, so the call was stopped.')
    await svc().callTool(row(), 'scrape_as_markdown', {})
    expect(stored()).toEqual({ status: 'connected', last_error: null })
  })

  test('Stop ends the call at once and tells the service; the connection stays as it was', async () => {
    fake.slow = { ms: 20_000, progressEveryMs: 200 }
    fake.cancelled = []
    const stop = new AbortController()
    try {
      const { tools, tc } = turn('alice', stop.signal)
      setTimeout(() => stop.abort(), 500)
      const t0 = Date.now()
      const out = await tools.get('team_scraper__scrape_as_markdown')!.call({}, tc).catch((e) => ({ thrown: e }))
      expect(Date.now() - t0).toBeLessThan(2000)
      expect(out).toMatchObject({ isError: true, summary: 'team_scraper__scrape_as_markdown -> stopped' })
      expect(JSON.stringify(out)).toContain('Scraper was stopped because the answer was stopped')
    } finally { fake.slow = null }
    // the service is told which request (best effort, after the stop)
    for (let i = 0; i < 40 && !fake.cancelled.length; i++) await Bun.sleep(50)
    expect(fake.cancelled).toEqual([{ requestId: fake.progressTokens.at(-1), reason: 'stopped by the user' }])
    expect(stored()).toEqual({ status: 'connected', last_error: null })
  })
})
