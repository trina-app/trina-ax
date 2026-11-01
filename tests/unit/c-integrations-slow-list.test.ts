// "Check again" on an MCP server whose big tool list comes slowly (Higgsfield, 2026-11: 1.07 MB at 17-38 KB/s, so the
// 30 s of a request cut it every time): tools/list is read for as long as bytes keep coming (mcp.ts MCP_LIST_IDLE_MS)
// up to the check's own limit (MCP_LIST_TIMEOUT_MS); one that stops sending fails at the idle limit. A connected server
// whose check fails for now keeps the list saved before and stays connected, with the reason (Settings: "last check
// failed"); so does one in an error that was only for now. A call that goes through clears that, and an error a failed
// call left, never a needed sign-in. One deadline bounds the whole check. Tool calls keep their fixed 30 s, a turn
// never waits for a check, and a step shows a short look at an MCP call's arguments (secrets hidden before the cut).
// The limits are small here (the net options tests may set), the code is the same.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { API_KEY, FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { MCP_LIST_IDLE_MS, MCP_LIST_TIMEOUT_MS } from '../../server/src/integrations/connections/mcp'
import { TIMEOUT_MS } from '../../server/src/integrations/connections/net'
import { secretHider } from '../../server/src/integrations/connections/hide'
import { getRow } from '../../server/src/integrations/connections/store'
import { TEXT } from '../../server/src/integrations/connections/text'
import { argsPreview, integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnToolContext } from '../../server/src/services'

setDefaultTimeout(30_000)

/** a request (initialize, a tool call), a pause in a list, a whole check */
const REQUEST_MS = 600, IDLE_MS = 400, LIST_MS = 3000

let A: CApp, fake: FakeServices
beforeAll(async () => {
  A = await makeCApp('c-integrations-slow-list')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: { ...fake.net(), timeoutMs: REQUEST_MS, listIdleMs: IDLE_MS, listTimeoutMs: LIST_MS } })
})
afterAll(async () => { fake?.stop(); await A?.close() })

const post = (as: Person, p: string, body: unknown) => A.json(p, { method: 'POST', as, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const timed = async <T>(run: () => Promise<T>) => { const t0 = Date.now(); const r = await run(); return { r, ms: Date.now() - t0 } }
const create = (name: string, q: string) => timed(() => post('alice', '/api/integrations', { kind: 'mcp', name, url: `${fake.base}/mcp-open?${q}`, auth: 'none' }))
const refresh = (id: string) => timed(() => post('alice', `/api/integrations/${id}/refresh`, {}))
const tool = (name: string) => ({ name, description: `${name}: ${'d'.repeat(200)}`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } })
const stored = (id: string) => { const r = getRow(A.ctx.db, id)!; return { status: r.status, last_error: r.last_error } }

function turn(user: Person) {
  const chat = A.chat(user)
  const turnId = A.turn(user, chat)
  const built = integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId, browser: false, scheduled: false })
  const files = { user: A.ctx.files.principal(user), turnId, files: new TurnFiles() } as TurnToolContext['files']
  const tc: TurnToolContext = { turnId, chatId: chat, userId: user, messageId: 'm', locale: 'en', signal: new AbortController().signal, files }
  return { tools: new Map(built.tools.map((t) => [t.name, t])), tc }
}

test('the real limits: the list waits 30 s for a pause and 90 s in all (under the relay\'s 100 s), other requests 30 s; the words say so', () => {
  expect([TIMEOUT_MS, MCP_LIST_IDLE_MS, MCP_LIST_TIMEOUT_MS]).toEqual([30_000, 30_000, 90_000])
  for (const L of ['en', 'ko', 'id', 'ja', 'es'] as const) {
    expect(TEXT.timeout[L]).toContain(String(MCP_LIST_IDLE_MS / 1000))
    expect(TEXT.list_timeout[L]).toContain(String(MCP_LIST_TIMEOUT_MS / 1000))
  }
})

describe('reading a slow tools/list', () => {
  let id = ''
  test('a list that keeps coming past the request limit is read whole', async () => {
    fake.tools = Array.from({ length: 60 }, (_, i) => tool(`s${i}`))
    fake.pageSize = 1000
    // 12 pieces 150 ms apart: about 1.7 s, almost three times REQUEST_MS, never a pause of IDLE_MS
    fake.pace = { methods: ['tools/list'], pieces: 12, gapMs: 150 }
    try {
      const { r, ms } = await create('Studio', 'slow')
      id = r.body.id
      expect(r.body).toMatchObject({ status: 'connected', lastError: null })
      expect(r.body.tools).toHaveLength(60)
      expect(ms).toBeGreaterThan(2 * REQUEST_MS)
    } finally { fake.pace = null }
  })

  test('a list that stops coming fails at the pause limit, long before the check\'s limit; nothing saved before, so an error', async () => {
    fake.pace = { methods: ['tools/list'], pieces: 10, gapMs: 50, stallAfter: 3 }
    try {
      const { r, ms } = await create('Stalls', 'stall')
      expect(r.body).toMatchObject({ status: 'error', lastError: TEXT.timeout.en, tools: [] })
      expect(stored(r.body.id)).toEqual({ status: 'error', last_error: 'timeout' })
      expect(ms).toBeGreaterThanOrEqual(IDLE_MS)
      expect(ms).toBeLessThan(LIST_MS)
    } finally { fake.pace = null }
  })

  test('a list that keeps coming but does not end in the check\'s limit fails with its own reason', async () => {
    // 40 pieces 150 ms apart: 6 s
    fake.pace = { methods: ['tools/list'], pieces: 40, gapMs: 150 }
    try {
      const { r, ms } = await create('Endless', 'cap')
      expect(r.body).toMatchObject({ status: 'error', lastError: TEXT.list_timeout.en })
      expect(stored(r.body.id)).toEqual({ status: 'error', last_error: 'list_timeout' })
      expect(ms).toBeGreaterThanOrEqual(LIST_MS)
      expect(ms).toBeLessThan(LIST_MS + 2000)
    } finally { fake.pace = null }
  })

  test('a failed "Check again" keeps the list saved before and the connection connected, saying why; the next good one clears it', async () => {
    const before = (await A.json('/api/integrations', { as: 'alice' })).body.items.find((i: any) => i.id === id)
    expect(before).toMatchObject({ status: 'connected', lastError: null })
    fake.pace = { methods: ['tools/list'], pieces: 10, gapMs: 50, stallAfter: 3 }
    try {
      const { r } = await refresh(id)
      expect(r.body).toMatchObject({ status: 'connected', lastError: TEXT.timeout.en, toolsUpdatedAt: before.toolsUpdatedAt })
      expect(r.body.tools.map((t: any) => t.name)).toEqual(before.tools.map((t: any) => t.name))
      // in the team's words too
      expect((await A.json('/api/integrations', { as: 'alice', headers: { 'accept-language': 'ko' } })).body.items.find((i: any) => i.id === id).status).toBe('connected')
    } finally { fake.pace = null }
    // the service busy (HTTP 503): the same; refusing the key (HTTP 403): a sign-in is needed, not kept as connected
    fake.listStatus = 503
    expect((await refresh(id)).r.body).toMatchObject({ status: 'connected', lastError: TEXT.http_status.en.replace('{status}', '503') })
    fake.listStatus = 403
    expect((await refresh(id)).r.body).toMatchObject({ status: 'needs_auth' })
    fake.listStatus = null
    expect((await refresh(id)).r.body).toMatchObject({ status: 'connected', lastError: null })
    expect(stored(id)).toEqual({ status: 'connected', last_error: null })
  })

  test('a call that goes through clears "the last check failed"', async () => {
    fake.pace = { methods: ['tools/list'], pieces: 10, gapMs: 50, stallAfter: 3 }
    try { expect((await refresh(id)).r.body).toMatchObject({ status: 'connected', lastError: TEXT.timeout.en }) } finally { fake.pace = null }
    const svc = integrationsOf(A.ctx)
    await svc.callTool(getRow(A.ctx.db, id)!, 's0', { q: 'x' })
    expect(stored(id)).toEqual({ status: 'connected', last_error: null })
  })

  test('a tool call keeps its fixed limit: a slow answer fails and marks an error; a call that goes through clears it', async () => {
    const svc = integrationsOf(A.ctx)
    // 3 pieces 350 ms apart: 700 ms, past REQUEST_MS, with no pause of IDLE_MS (the list's rule is not the calls')
    fake.pace = { methods: ['tools/call'], pieces: 3, gapMs: 350 }
    try {
      await expect(svc.callTool(getRow(A.ctx.db, id)!, 's0', {})).rejects.toThrow('did not answer within 30 seconds')
    } finally { fake.pace = null }
    expect(stored(id)).toEqual({ status: 'error', last_error: 'timeout' })
    // an error that was only for now (the row of a connection the 30 s cut before): a check that fails for now too
    // keeps the saved list and says so, it is not "Error"
    fake.pace = { methods: ['tools/list'], pieces: 10, gapMs: 50, stallAfter: 3 }
    try { expect((await refresh(id)).r.body).toMatchObject({ status: 'connected', lastError: TEXT.timeout.en }) } finally { fake.pace = null }
    fake.pace = { methods: ['tools/call'], pieces: 3, gapMs: 350 }
    try { await expect(svc.callTool(getRow(A.ctx.db, id)!, 's0', {})).rejects.toThrow() } finally { fake.pace = null }
    await svc.callTool(getRow(A.ctx.db, id)!, 's0', {})
    expect(stored(id)).toEqual({ status: 'connected', last_error: null })
  })

  test('a failure that stops the calls too is an error, and a check that fails for now does not make it "connected"', async () => {
    // the service sends us elsewhere: not only for now
    fake.listStatus = 307
    expect((await refresh(id)).r.body).toMatchObject({ status: 'error', lastError: TEXT.redirect.en.replace('{status}', '307') })
    fake.listStatus = null
    fake.pace = { methods: ['tools/list'], pieces: 10, gapMs: 50, stallAfter: 3 }
    try { expect((await refresh(id)).r.body).toMatchObject({ status: 'error', lastError: TEXT.timeout.en }) } finally { fake.pace = null }
    expect((await refresh(id)).r.body).toMatchObject({ status: 'connected', lastError: null })
  })

  test('a call that goes through never clears a sign-in that is needed', async () => {
    A.ctx.db.query("UPDATE integrations SET status='needs_auth', last_error='refused:401' WHERE id=?").run(id)
    await integrationsOf(A.ctx).callTool(getRow(A.ctx.db, id)!, 's0', {})
    expect(stored(id)).toEqual({ status: 'needs_auth', last_error: 'refused:401' })
    expect((await refresh(id)).r.body).toMatchObject({ status: 'connected', lastError: null })
  })

  test('api_request: only a 2xx answer clears an error', async () => {
    const api = (await post('alice', '/api/integrations', { kind: 'http', name: 'Tasks API', url: `${fake.base}/api/v1`, auth: 'bearer', secret: API_KEY })).body
    expect(api.status).toBe('connected')
    const svc = integrationsOf(A.ctx)
    const req = { method: 'GET', body: null, contentType: null }
    A.ctx.db.query("UPDATE integrations SET status='error', last_error='http_status:503' WHERE id=?").run(api.id)
    // the AI's path is not there: says nothing about the service
    expect((await svc.apiRequest(getRow(A.ctx.db, api.id)!, `${fake.base}/api/v1/`, req)).status).toBe(404)
    expect(stored(api.id)).toEqual({ status: 'error', last_error: 'http_status:503' })
    expect((await svc.apiRequest(getRow(A.ctx.db, api.id)!, `${fake.base}/api/v1/tasks`, req)).status).toBe(200)
    expect(stored(api.id)).toEqual({ status: 'connected', last_error: null })
  })

  test('one deadline for the whole check: a new session after a lost one does not start the time again', async () => {
    fake.tools = Array.from({ length: 4 }, (_, i) => tool(`s${i}`))
    fake.pageSize = 2
    // each page takes about 2.25 s; the server forgets our session while the first is coming, so the second page is
    // refused (404) and a new session starts. Its first page would end past the check's limit: the check ends there
    fake.pace = { methods: ['tools/list'], pieces: 10, gapMs: 250 }
    const forget = setTimeout(() => fake.sessions.clear(), 1500)
    try {
      const { r, ms } = await refresh(id)
      expect(r.body).toMatchObject({ status: 'connected', lastError: TEXT.list_timeout.en })
      expect(ms).toBeGreaterThanOrEqual(LIST_MS)
      expect(ms).toBeLessThan(LIST_MS + 1500)
    } finally { clearTimeout(forget); fake.pace = null }
    expect((await refresh(id)).r.body).toMatchObject({ status: 'connected', lastError: null })
    fake.tools = Array.from({ length: 60 }, (_, i) => tool(`s${i}`))
    fake.pageSize = 1000
    expect((await refresh(id)).r.body.tools).toHaveLength(60)
  })

  test('a chat turn never waits for a slow check: it uses the saved list, and its calls go through meanwhile', async () => {
    // 20 pieces 100 ms apart: a check of about 2 s
    fake.pace = { methods: ['tools/list'], pieces: 20, gapMs: 100 }
    let done = false
    const checking = refresh(id).then((x) => { done = true; return x })
    try {
      await Bun.sleep(150)
      const t0 = Date.now()
      const { tools, tc } = turn('alice')
      const r = await tools.get('my_studio__s1')!.call({ q: 'leaf' }, tc)
      expect(r.isError).toBeFalsy()
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(done).toBe(false)
      expect((await checking).r.body).toMatchObject({ status: 'connected', lastError: null })
    } finally { await checking; fake.pace = null }
  })

  test('a step shows a short look at the arguments: a price check and the paid run it was for are told apart', () => {
    const { tools } = turn('alice')
    const label = tools.get('my_studio__s0')!.label!
    const quote = label({ model: 'z_image', prompt: 'a green leaf', get_cost: true }, 'en')
    const paid = label({ model: 'z_image', prompt: 'a green leaf' }, 'en')
    // flags and numbers first, so a long prompt never pushes them out
    expect(quote).toBe('Studio · s0 (get_cost: true, model: "z_image", prompt: "a green leaf")')
    expect(paid).toBe('Studio · s0 (model: "z_image", prompt: "a green leaf")')
    expect(label({}, 'en')).toBe('Studio · s0')
    const long = argsPreview({ prompt: 'a leaf\non white '.repeat(20), model: 'z_image', options: { size: '1k' }, refs: ['x'], count: 1, get_cost: true })
    // texts in the AI's order, each cut to 40 characters
    expect(long).toStartWith('count: 1, get_cost: true, prompt: "a leaf on white a leaf on white a leaf …", model: "z_image"')
    expect(long.length).toBeLessThanOrEqual(100)
    expect(long).not.toContain('\n')
    expect(argsPreview({ options: { size: '1k' }, refs: ['x'], note: null })).toBe('note: null, options: {…}, refs: […]')
    for (const nothing of [null, undefined, 'text', 3, ['a']]) expect(argsPreview(nothing)).toBe('')
    // a stored secret is hidden in the whole text before it is cut (a cut one could not be found later); a text
    // under a secret's name is not shown
    const secret = 'CANARY-' + 'k'.repeat(60)
    const hidden = argsPreview({ note: `use ${secret} here`, api_key: 'typed-key', password: 'pw', max_tokens: 5 }, secretHider([secret]))
    expect(hidden).toBe('max_tokens: 5, note: "use [hidden key] here", api_key: •••, password: •••')
    expect(hidden).not.toContain('CANARY')
  })
})
