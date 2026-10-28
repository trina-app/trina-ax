// A service that repeats the stored key (QA, 2026-10-28): an endpoint that lists the request's headers, an answer with
// the key %-escaped, base64-encoded or escaped as JSON or HTML, an error page or a JSON-RPC error that repeats it, an MCP
// tool that returns its own token in text or in structured content only, a streamed answer with the key split across
// network pieces, OAuth tokens refreshed during the call. Real turns: what the AI is given, the chat, the stored steps,
// tool_events, the logs, the database and the files on disk never hold a key in any of those forms
// (server/src/integrations/connections/hide.ts, through tools.ts `hiding`); ordinary words that are parts of it stay.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7 } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { HIDDEN, MIN_SECRET, secretHider } from '../../server/src/integrations/connections/hide'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import type { OAuthSecret } from '../../server/src/integrations/connections/oauth'
import { connectionAad, getRow } from '../../server/src/integrations/connections/store'
import { integrationToolProvider, MAX_RESULT_CHARS } from '../../server/src/integrations/connections/tools'
import { TurnFiles } from '../../server/src/files/service'
import type { TurnToolContext } from '../../server/src/services'
import { createLogger } from '../../server/src/log'

setDefaultTimeout(60_000)

/** characters a URL, JSON and HTML escape, and base64 of it has + and / */
const ECHO_KEY = 'CANARY/echo+key=7731&x'
const HDR_KEY = 'CANARY-header-key-5150'
const CLIENT_SECRET = 'CANARY-client-secret-8086'
/** the words of the echo answers: parts of the keys, never hidden */
const WORDS = 'words: CANARY echo key 7731 x'

// ---------------- what a text gives away ----------------
const unpercent = (s: string) => s.replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => { try { return decodeURIComponent(m) } catch { return m } })
const unhtml = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const unjson = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/\\([/"\\])/g, '$1')
/** every base64 run, decoded from each of its first four characters (any alignment) */
const unbase64 = (s: string) => (s.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? []).flatMap((run) => [0, 1, 2, 3].map((i) => Buffer.from(run.slice(i), 'base64').toString('latin1')))
/** The secrets a text gives away: whole, or their first or last MIN_SECRET characters (a key cut in two), as they are
 * or after undoing %-escapes, form encoding, HTML and JSON escapes or base64. */
function leaked(text: string, secrets: string[]): string[] {
  const views = [text, unpercent(text), unpercent(text.replace(/\+/g, ' ')), unhtml(text), unjson(text), ...unbase64(text)]
  return secrets.filter((k) => views.some((v) => v.includes(k) || v.includes(k.slice(0, MIN_SECRET)) || v.includes(k.slice(-MIN_SECRET))))
}

describe('hiding the forms of a value (hide.ts)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  test('the value, Bearer, %-escapes in either case, form encoding, JSON and HTML escapes, base64 alone and around it', () => {
    const hide = secretHider([ECHO_KEY])
    const forms = [
      `Authorization: Bearer ${ECHO_KEY}`, encodeURIComponent(ECHO_KEY), encodeURIComponent(ECHO_KEY).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
      String(new URLSearchParams({ k: ECHO_KEY })), JSON.stringify({ k: ECHO_KEY }).replace(/\//g, '\\/'), `<b>${ECHO_KEY.replace(/&/g, '&amp;')}</b>`,
      `${ECHO_KEY.replace(/&/g, '&#38;').replace(/\//g, '&#x2F;')}`, JSON.stringify(ECHO_KEY).replace(/[/+&=]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')),
      b64(ECHO_KEY), b64(ECHO_KEY).replace(/=+$/, ''), Buffer.from(ECHO_KEY).toString('base64url'), `Basic ${b64('user:' + ECHO_KEY)}`, `Basic ${b64('me:' + ECHO_KEY)}`,
      `Basic ${b64('u:' + ECHO_KEY)}`, b64(ECHO_KEY + ':'), b64('Bearer ' + ECHO_KEY), encodeURIComponent(b64(ECHO_KEY)),
    ]
    for (const f of forms) {
      const out = hide(f)
      expect(out, f).toContain(HIDDEN)
      expect(leaked(out, [ECHO_KEY]), `${f} -> ${out}`).toEqual([])
    }
    expect(hide(`Bearer ${ECHO_KEY}`)).toBe(`Bearer ${HIDDEN}`)
    expect(hide(b64(ECHO_KEY))).toBe(HIDDEN)
  })

  test('short values and parts of a value stay; hiding twice changes nothing; no values, nothing to do', () => {
    expect(MIN_SECRET).toBe(8)
    expect(secretHider(['abc1234'])('key abc1234 here')).toBe('key abc1234 here')
    const hide = secretHider([MCP_KEY, null, '', 'short'])
    const words = 'CANARY mcp key 4411 / CANARY-mcp / key-4411 / CANARY-mcp-key-441 / short'
    expect(hide(words)).toBe(words)
    const once = hide(`a ${MCP_KEY}${MCP_KEY} b ${b64(MCP_KEY)}`)
    expect(once).toBe(`a ${HIDDEN}${HIDDEN} b ${HIDDEN}`)
    expect(hide(once)).toBe(once)
    expect(secretHider([])('x')).toBe('x')
    // a value with spaces around it is hidden as it would be sent (trimmed) too
    expect(secretHider([` ${HDR_KEY} `])(`x-key: ${HDR_KEY}`)).toBe(`x-key: ${HIDDEN}`)
  })

  test('a 1 MB answer with a long token is checked quickly', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ'.repeat(30) + '.c2lnbmF0dXJl_-x'
    const hide = secretHider([jwt, ECHO_KEY, CLIENT_SECRET])
    const big = 'lorem ipsum, dolor/sit+amet=1&b; '.repeat(32_000) + jwt
    const t0 = performance.now()
    expect(hide(big).endsWith(HIDDEN)).toBe(true)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})

// ---------------- real turns ----------------
let h: Harness, sock: TestSocket, fake: FakeServices
let echo: any, echoHdr: any, board: any, signed: any
const logs: string[] = []
const secrets = () => [ECHO_KEY, HDR_KEY, MCP_KEY, CLIENT_SECRET, ...fake.issued]

const ECHO_TOOLS = [
  ...['echo_text', 'echo_structured', 'echo_resource', 'echo_is_error', 'echo_rpc_error'].map((name) => ({ name, description: `repeats the token (${name})`, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })),
  // the server writes its own token into its tool list: hidden in the words; a tool named with it is left out
  { name: 'whoami', title: 'Who am I ({token})', description: 'Shows who you are. Your token is {token}.', inputSchema: { type: 'object', properties: { token: { type: 'string', default: '{token}' } } }, annotations: { readOnlyHint: true } },
  { name: 'leak_{token}', description: 'named with the token', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
]

beforeAll(async () => {
  h = await startHarness({ name: 'c-integrations-echo', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000, log: createLogger({ level: 'debug', sink: (l) => logs.push(l) }) })
  sock = await h.ws('alice', { windowId: 'win-echo' })
  await sock.next('hello')
  fake = new FakeServices()
  fake.tools = ECHO_TOOLS
  fake.pageSize = 10
  integrationsOf(h.ctx, { net: fake.net() })
  const api = h.api('alice')
  echo = await api.call(API.createIntegration, { body: { kind: 'http', name: 'Echo', url: `${fake.base}/echo`, auth: 'bearer', secret: ECHO_KEY } })
  echoHdr = await api.call(API.createIntegration, { body: { kind: 'http', name: 'Echo header', url: `${fake.base}/echo`, auth: 'header', authHeader: 'X-Echo-Key', secret: HDR_KEY } })
  board = await api.call(API.createIntegration, { body: { kind: 'mcp', name: 'Board', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY } })
  expect([echo.status, echoHdr.status, board.status]).toEqual(['connected', 'connected', 'connected'])
})
afterAll(async () => { sock?.close(); fake?.stop(); await h?.close() })

interface Turn { text: string; steps: unknown; events: { tool: string; summary: string; ok: number }[]; stored: { content: string; steps: string } }
/** One real turn that calls these tools and says each result (what the AI was given) as its answer. */
async function turn(...calls: { tool: string; args?: unknown }[]): Promise<Turn> {
  const chat = await h.api('alice').call(API.createChat, { body: {} })
  const content = calls.map((c) => '@fake ' + JSON.stringify({ tool: c.tool, args: c.args ?? {}, sayResult: true }) + '\n@fake {"say":"\\n----\\n"}').join('\n')
  const r = await ask(h, sock, 'alice', chat.id, content, { ms: 40_000 })
  const events = h.ctx.db.query("SELECT tool, summary, ok FROM tool_events WHERE turn_id = ? AND tool <> '(connect)' ORDER BY id").all(r.started.turnId) as Turn['events']
  const stored = h.ctx.db.query('SELECT content, steps FROM messages WHERE id = ?').get(r.started.assistantMessage.id) as Turn['stored']
  expect(events).toHaveLength(calls.length)
  return { text: r.done.content, steps: r.done.steps, events, stored }
}
/** One call of a tool as a running turn of alice would make it, without the engine (a 40,000-character answer). */
async function direct(name: string, args: unknown) {
  const chat = uuidv7(), turnId = uuidv7()
  h.ctx.db.query('INSERT INTO chats (id, user_id, title) VALUES (?,?,?)').run(chat, 'alice', 'direct')
  h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?,?,?, 'claude-code', 'running')").run(turnId, chat, 'alice')
  const built = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: chat, turnId, browser: false, scheduled: false })
  const files = { user: h.ctx.files.principal('alice'), turnId, files: new TurnFiles() } as TurnToolContext['files']
  const r = await built.tools.find((t) => t.name === name)!.call(args, { turnId, chatId: chat, userId: 'alice', messageId: 'm', locale: 'en', signal: new AbortController().signal, files })
  return { text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), summary: r.summary ?? '' }
}
/** No key in what the AI was given (the answer says it), the steps, tool_events, the stored message or the logs. */
function expectHidden(t: Turn) {
  for (const [where, text] of Object.entries({ answer: t.text, steps: JSON.stringify(t.steps), toolEvents: JSON.stringify(t.events), stored: JSON.stringify(t.stored), logs: logs.join('\n') })) {
    expect(leaked(text, secrets()), where).toEqual([])
  }
  expect(t.text).toContain(HIDDEN)
}

describe('a service that repeats the key, in real turns', () => {
  test('an endpoint that lists the request headers: the Bearer key and a custom key header are hidden; the words stay', async () => {
    const t = await turn({ tool: 'api_request', args: { connection: 'my_echo', method: 'GET', path: '/headers' } }, { tool: 'api_request', args: { connection: 'my_echoheader', method: 'GET', path: '/headers' } })
    expectHidden(t)
    expect(t.text).toContain(`"authorization":"Bearer ${HIDDEN}"`)
    expect(t.text).toContain(`"x-echo-key":"${HIDDEN}"`)
    expect(t.text.split(WORDS)).toHaveLength(3) // parts of the keys as ordinary words: untouched
    expect(t.events.map((e) => e.summary)).toEqual([expect.stringMatching(/^api_request my_echo GET \/echo\/headers -> 200 \(\d+ B\)$/), expect.stringMatching(/^api_request my_echoheader GET \/echo\/headers -> 200/)])
    // the service did get the key (only in its header)
    expect(fake.seen.filter((s) => s.path === '/echo/headers').map((s) => s.headers.authorization ?? s.headers['x-echo-key'])).toEqual([`Bearer ${ECHO_KEY}`, HDR_KEY])
  })

  test('the key %-escaped (either case), form-encoded, base64 (alone, URL-safe, Basic user:key), JSON- and HTML-escaped; a redirect with it; the 40,000-character cut inside it', async () => {
    const t = await turn(
      { tool: 'api_request', args: { connection: 'my_echo', method: 'GET', path: '/encoded' } },
      { tool: 'api_request', args: { connection: 'my_echo', method: 'GET', path: '/redirect' } },
    )
    expectHidden(t)
    for (const line of [`url: ${HIDDEN}`, `url-lower: ${HIDDEN}`, `form: k=${HIDDEN}`, `base64: ${HIDDEN}`, `base64url: ${HIDDEN}`, `json: {"k":"${HIDDEN}"}`, `unicode: ${HIDDEN}`, `html: <code>${HIDDEN}</code>`, WORDS]) {
      expect(t.text).toContain(line)
    }
    expect(t.text).toMatch(/basic: Basic \S*\[hidden key\]/)
    expect(t.text).toContain(`Location: https://svc.test/login?token=${HIDDEN}`)
    // hidden before the answer is cut for the AI: no first half of the key at the end
    const long = await direct('api_request', { connection: 'my_echo', method: 'GET', path: '/long' })
    expect(long.text).toContain(`(cut to ${MAX_RESULT_CHARS} characters)`)
    expect(long.text).toMatch(/L\[hidden key\n<\/external_data>$/)
    expect(leaked(long.text + long.summary, secrets())).toEqual([])
  })

  test('an MCP tool that returns its token in text, in structured content only, in a resource link; a tool list that names it', async () => {
    const t = await turn({ tool: 'my_board__echo_text' }, { tool: 'my_board__echo_structured' }, { tool: 'my_board__echo_resource' })
    expectHidden(t)
    expect(t.text).toContain(`Authorization: Bearer ${HIDDEN}; tokens: ${HIDDEN}; words: CANARY mcp key token`)
    expect(t.text).toContain(`{"authorization":"Bearer ${HIDDEN}","token":"${HIDDEN}","base64":"${HIDDEN}","url":"${HIDDEN}","all":"${HIDDEN}"}`)
    expect(t.text).toContain(`[resource https://svc.test/files?access_token=${HIDDEN}]`)
    expect(t.events.map((e) => e.summary)).toEqual([expect.stringMatching(/^my_board__echo_text -> ok \(\d+ chars\)$/), expect.stringMatching(/^my_board__echo_structured -> ok/), expect.stringMatching(/^my_board__echo_resource -> ok/)])
    // the saved tool list (the AI's tool descriptions, what the API shows its users)
    const listed = (await h.api('alice').call(API.listIntegrations, {})).items.find((i) => i.id === board.id)!
    expect(listed.tools.map((x) => x.name)).not.toContain(`leak_${MCP_KEY}`)
    expect(listed.tools.find((x) => x.name === 'whoami')).toMatchObject({ title: `Who am I (${HIDDEN})`, description: `Shows who you are. Your token is ${HIDDEN}.` })
    const saved = getRow(h.ctx.db, board.id)!.tools_json
    expect(saved).toContain(`"default":"${HIDDEN}"`)
    expect(leaked(saved + JSON.stringify(listed), secrets())).toEqual([])
  })

  test('errors: an error page and an error result that repeat the key, a JSON-RPC error cut inside it; a 401 that repeats it (lastError is a code)', async () => {
    const t = await turn(
      { tool: 'api_request', args: { connection: 'my_echo', method: 'GET', path: '/error' } },
      { tool: 'my_board__echo_is_error' },
      { tool: 'my_board__echo_rpc_error' },
      { tool: 'api_request', args: { connection: 'my_echo', method: 'GET', path: '/unauthorized' } },
    )
    expectHidden(t)
    expect(t.text).toContain(`Authorization: Bearer ${HIDDEN} is not valid here.`)
    expect(t.text).toContain(`the token ${HIDDEN} has no access to this board`)
    expect(t.text).toContain('Board answered with an error: xxx')
    expect(t.text).toContain(`"got":"${HIDDEN}"`)
    expect(t.events.map((e) => [e.summary.replace(/ \(\d+ (B|chars)\)/, ''), e.ok])).toEqual([
      ['api_request my_echo GET /echo/error -> 400', 0], ['my_board__echo_is_error -> error answer', 0], ['my_board__echo_rpc_error -> error answer', 0], ['api_request my_echo GET /echo/unauthorized -> 401', 0],
    ])
    const row = getRow(h.ctx.db, echo.id)!
    expect([row.status, row.last_error]).toEqual(['needs_auth', 'refused:401'])
    const listed = (await h.api('alice').call(API.listIntegrations, {})).items.find((i) => i.id === echo.id)!
    expect(listed.lastError).toContain('HTTP 401')
    expect(leaked(JSON.stringify(listed), secrets())).toEqual([])
    // the key again: connected
    expect((await h.api('alice').call(API.updateIntegration, { params: { id: echo.id }, body: { secret: ECHO_KEY } })).status).toBe('connected')
  })

  test('streamed answers: the key split across two network pieces of an event stream (REST and MCP) is hidden once joined', async () => {
    fake.sse = true
    try {
      const t = await turn({ tool: 'api_request', args: { connection: 'my_echo', method: 'GET', path: '/stream' } }, { tool: 'my_board__echo_text' })
      expectHidden(t)
      expect(t.text).toContain(`data: {"delta":"${HIDDEN}"}`)
      expect(t.text).toContain(`Authorization: Bearer ${HIDDEN}`)
      expect(t.text).toContain(WORDS)
    } finally { fake.sse = false }
  })

  test('OAuth: the access and refresh tokens and the client secret are hidden, also tokens refreshed during the call and earlier ones', async () => {
    const svc = integrationsOf(h.ctx)
    signed = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Signed', url: `${fake.base}/mcp-oauth`, auth: 'oauth' } })
    // signed in already (the sign-in itself is c-integrations-oauth.test.ts): a confidential client and its tokens
    const access = 'CANARY-access-first-' + crypto.randomUUID().slice(0, 8), refresh = 'CANARY-refresh-first-' + crypto.randomUUID().slice(0, 8)
    fake.clients.set('client-echo', { redirectUris: ['https://team.example/cb'] })
    fake.access.set(access, fake.now + 3600_000)
    fake.refresh.add(refresh)
    fake.issued.push(access, refresh)
    const row = getRow(h.ctx.db, signed.id)!
    const secret: OAuthSecret = {
      type: 'oauth', resource: `${fake.base}/mcp-oauth`, scope: 'tasks',
      server: { issuer: `${fake.base}/as`, authorizationEndpoint: `${fake.base}/as/authorize`, tokenEndpoint: `${fake.base}/as/token`, registrationEndpoint: null, revocationEndpoint: `${fake.base}/as/revoke` },
      client: { clientId: 'client-echo', clientSecret: CLIENT_SECRET, authMethod: 'client_secret_post', redirectUri: 'https://team.example/cb' },
      tokens: { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + 3600_000 },
    }
    const sealed = svc.box.seal(connectionAad(row), secret)
    h.ctx.db.query('UPDATE integrations SET secret_enc = ?, key_version = ? WHERE id = ?').run(sealed.enc, sealed.keyVersion, row.id)
    expect((await svc.check(getRow(h.ctx.db, row.id)!)).status).toBe('connected')
    fake.echoExtra = `client_secret=${CLIENT_SECRET}`
    try {
      const first = await turn({ tool: 'my_signed__echo_text' })
      expectHidden(first)
      expect(first.text).toContain(`Authorization: Bearer ${HIDDEN}; tokens: ${HIDDEN} ${HIDDEN} ${HIDDEN} client_secret=${HIDDEN}`)
      // the service forgets the token: a 401, a refresh during the call (new access and refresh tokens), the call again
      for (const round of [1, 2]) {
        for (const a of fake.access.keys()) fake.access.delete(a)
        const before = fake.refreshCount
        const t = await turn({ tool: 'my_signed__echo_text' })
        expect(fake.refreshCount).toBe(before + 1)
        expectHidden(t)
        // every token so far (the first ones too, after two refreshes) and the client secret
        expect(fake.issued).toHaveLength(2 + 2 * round)
        expect(t.text).toContain(`tokens: ${Array(1 + fake.issued.length).fill(HIDDEN).join(' ')} client_secret=${HIDDEN}`)
      }
    } finally { fake.echoExtra = '' }
  })

  test('nothing in the database, the logs or any file of the server holds a key', () => {
    const tables = ['integrations', 'integration_oauth_flows', 'audit_log', 'tool_events', 'messages', 'turns', 'chats']
    const dump = tables.map((t) => JSON.stringify(h.ctx.db.query(`SELECT * FROM ${t}`).all())).join('\n')
    expect(leaked(dump + logs.join('\n'), secrets())).toEqual([])
    expect(logs.length).toBeGreaterThan(0)
    const files: string[] = []
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p) } }
    walk(h.base)
    expect(files.length).toBeGreaterThan(0)
    const found = files.filter((f) => { const b = fs.readFileSync(f).toString('latin1'); return secrets().some((k) => b.includes(k)) })
    expect(found).toEqual([])
  })
})
