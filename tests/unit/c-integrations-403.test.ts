// A service that takes the sign-in and still answers 403 (GitLab's MCP server: "MCP server not enabled for any of your
// groups", denial_reason no_enabled_namespace, for an account without a top-level group) was shown as a bad key ("Sign
// in again"), which signing in again cannot fix. Now the answer's OAuth error code picks the reason (refusal.ts):
// 401 or 403 invalid_token: refused (sign in again); 403 insufficient_scope: scope (sign in again and allow the access);
// any other 403: no_access, status 'error' (no "sign in again" notice, card or AI line), with a short sanitized excerpt
// of what the service said. The same for MCP checks, MCP tool calls and HTTP API checks.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { CallError, integrationsOf } from '../../server/src/integrations/connections/service'
import { authParam, cleanSaid, codeOnly, codeParts, REFUSAL_SAID_MAX, refusalCode, refusalOf, refusalReason } from '../../server/src/integrations/connections/refusal'
import { HIDDEN, secretHider } from '../../server/src/integrations/connections/hide'
import { getRow } from '../../server/src/integrations/connections/store'
import { reasonText, TEXT } from '../../server/src/integrations/connections/text'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { ownNeedsSignIn } from '../../server/src/chat/connect-service'

setDefaultTimeout(30_000)

const GITLAB = { error: 'forbidden', message: 'MCP server not enabled for any of your groups', denial_reason: 'no_enabled_namespace' }
const res = (body: string, headers: Record<string, string> = {}) => ({ headers, body: Buffer.from(body) })
const json = (v: unknown, h: Record<string, string> = {}) => res(JSON.stringify(v), { 'content-type': 'application/json', ...h })

describe('what a 401/403 says (refusal.ts)', () => {
  test('WWW-Authenticate parameters, quoted or not', () => {
    const h = 'Bearer realm="api", error="insufficient_scope", error_description="needs \\"read_api\\"", scope=read_api'
    expect(authParam(h, 'error')).toBe('insufficient_scope')
    expect(authParam(h, 'error_description')).toBe('needs "read_api"')
    expect(authParam(h, 'scope')).toBe('read_api')
    expect(authParam('Bearer error=invalid_token', 'error')).toBe('invalid_token')
    expect(authParam('Bearer realm="x"', 'error')).toBe('')
  })

  test('the words of a JSON body: GitLab, OAuth, JSON-RPC, a bare denial_reason', () => {
    expect(refusalOf(json(GITLAB))).toEqual({ error: 'forbidden', said: 'MCP server not enabled for any of your groups' })
    expect(refusalOf(json({ error: 'insufficient_scope', error_description: 'The token lacks read_api' }))).toEqual({ error: 'insufficient_scope', said: 'The token lacks read_api' })
    expect(refusalOf(json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Not enabled for this group', data: { denial_reason: 'no_enabled_namespace' } } })))
      .toEqual({ error: '', said: 'Not enabled for this group' })
    expect(refusalOf(json({ denial_reason: 'no_enabled_namespace' }))).toEqual({ error: '', said: 'no_enabled_namespace' })
    // a sentence in `error` is the words, not a code
    expect(refusalOf(json({ error: 'You do not have access to this project.' }))).toEqual({ error: '', said: 'You do not have access to this project.' })
    // an event stream's first data line
    expect(refusalOf(res(`event: message\ndata: ${JSON.stringify({ error: { message: 'Seat required' } })}\n\n`, { 'content-type': 'text/event-stream' })).said).toBe('Seat required')
  })

  test('the header wins for the code; its description when the body says nothing; a short text/plain body; never an HTML page', () => {
    expect(refusalOf(json({ message: 'nope' }, { 'www-authenticate': 'Bearer error="invalid_token"' }))).toEqual({ error: 'invalid_token', said: 'nope' })
    expect(refusalOf(res('', { 'www-authenticate': 'Bearer error="insufficient_scope", error_description="needs admin"' }))).toEqual({ error: 'insufficient_scope', said: 'needs admin' })
    expect(refusalOf(res('Forbidden: plan limit', { 'content-type': 'text/plain' }))).toEqual({ error: '', said: 'Forbidden: plan limit' })
    expect(refusalOf(res('<!doctype html><title>Login</title><script>alert(1)</script>', { 'content-type': 'text/html' }))).toEqual({ error: '', said: '' })
    expect(refusalOf(res('{not json', { 'content-type': 'application/json' }))).toEqual({ error: '', said: '' })
  })

  test('sanitized: stored secrets and token-like strings hidden, tags and control or direction characters out, capped', () => {
    const key = 'CANARY-stored-key-9090'
    const hide = secretHider([key])
    const said = refusalOf(json({ message: `bad ${key} and Bearer abcdefghijklmnop1234 access_token=zzzzzzzzzz ghp_abcdefghijklmnopqrst eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz` }), hide).said
    expect(said).toContain(HIDDEN)
    for (const leak of [key, 'abcdefghijklmnop1234', 'zzzzzzzzzz', 'ghp_abcdefghijklmnopqrst', 'eyJhbGciOiJIUzI1NiJ9']) expect(said).not.toContain(leak)
    expect(cleanSaid('<b>no</b> <img src=x onerror=alert(1)>access\u0000\u001b[31m here\u202e\u200b <')).toBe('no access [31m here')
    const long = cleanSaid('x'.repeat(5000))
    expect(long.length).toBe(REFUSAL_SAID_MAX)
    expect(long.endsWith('…')).toBe(true)
    expect(cleanSaid('a\n\n  b\tc')).toBe('a b c')
  })

  test('each status and code to its reason, and the stored code', () => {
    expect(refusalReason(401, '')).toBe('refused')
    expect(refusalReason(401, 'insufficient_scope')).toBe('refused')
    expect(refusalReason(403, 'invalid_token')).toBe('refused')
    expect(refusalReason(403, 'insufficient_scope')).toBe('scope')
    expect(refusalReason(403, '')).toBe('no_access')
    expect(refusalReason(403, 'forbidden')).toBe('no_access')
    expect(refusalCode(401, { error: '', said: 'x' })).toBe('refused:401')
    expect(refusalCode(403, { error: 'insufficient_scope', said: 'x' })).toBe('scope:403')
    expect(refusalCode(403, { error: '', said: 'a: b' })).toBe('no_access:403:a: b')
    expect(refusalCode(403, { error: '', said: '' })).toBe('no_access:403')
    expect(codeParts('no_access:403:a: b')).toEqual({ reason: 'no_access', status: '403', said: 'a: b' })
    expect(codeOnly('no_access:403:a: b')).toBe('no_access:403')
    expect(codeOnly('timeout')).toBe('timeout')
  })

  test('in words, every language: the excerpt and "ask the owner" for no_access (never "sign in again"); sign in and allow for scope', () => {
    for (const L of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
      const said = reasonText('no_access:403:Not enabled: ask', L)!
      expect(said).toContain('Not enabled: ask')
      expect(said).toContain('403')
      expect(said).not.toContain('{')
      expect(reasonText('no_access:403', L)).toBe(TEXT.no_access_bare[L].replace('{status}', '403'))
      expect(reasonText('scope:403', L)).toBe(TEXT.scope[L].replace('{status}', '403'))
      // a reader who cannot change the key: the same words (the fix is at the service, not here)
      expect(reasonText('no_access:403:x y', L, { address: false, key: false })).toBe(reasonText('no_access:403:x y', L))
      expect(reasonText('scope:403', L, { address: true, key: false })).toBe(TEXT.keyMember[L])
    }
    expect(reasonText('no_access:403:x', 'en')).not.toMatch(/sign in again/i)
  })
})

let A: CApp, fake: FakeServices
const warns: { msg: string; fields: Record<string, unknown> }[] = []
beforeAll(async () => {
  A = await makeCApp('c-integrations-403')
  fake = new FakeServices()
  integrationsOf(A.ctx, { net: fake.net() })
  const warn = A.ctx.log.warn.bind(A.ctx.log)
  A.ctx.log.warn = ((msg: string, fields?: Record<string, unknown>) => { warns.push({ msg, fields: fields ?? {} }); return warn(msg, fields) }) as typeof A.ctx.log.warn
})
afterAll(async () => { fake?.stop(); await A?.close() })
afterEach(() => { fake.refuse = null })

const send = (as: Person, method: string, p: string, body?: unknown) =>
  A.json(p, { method, as, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
const check = async (id: string) => (await send('alice', 'POST', `/api/integrations/${id}/refresh`, {})).body
const stored = (id: string) => { const r = getRow(A.ctx.db, id)!; return { status: r.status, last_error: r.last_error } }
const reconnects = async () => ((await send('alice', 'GET', '/api/notifications')).body.items as any[]).filter((x) => x.code === 'connection.reconnect')
function prompt(user: Person) {
  const chat = A.chat(user)
  return integrationToolProvider(A.ctx).build({ userId: user, chatId: chat, turnId: A.turn(user, chat), browser: false, scheduled: false })
}

describe('MCP: check and calls', () => {
  let id = '', tool = ''
  test('a working connection answered 403 "not enabled": signed in, not allowed, the service\'s words; no re-sign-in nag', async () => {
    const made = await send('alice', 'POST', '/api/integrations', { kind: 'mcp', name: 'GitLab', url: `${fake.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY })
    expect(made.body.status).toBe('connected')
    id = made.body.id
    tool = made.body.tools[0].name
    // the service also repeats the key it got: hidden before anything keeps it
    fake.refuse = { status: 403, methods: ['tools/list'], headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...GITLAB, message: `${GITLAB.message} (token ${MCP_KEY})` }) }
    warns.length = 0
    const r = await check(id)
    expect(r).toMatchObject({ status: 'error', lastErrorReason: 'no_access' })
    expect(r.lastError).toContain('Signed in, but the service does not let this account use it (HTTP 403)')
    expect(r.lastError).toContain(`“MCP server not enabled for any of your groups (token ${HIDDEN})”`)
    expect(r.lastError).toContain('owner')
    expect(JSON.stringify(r)).not.toContain(MCP_KEY)
    expect(stored(id)).toEqual({ status: 'error', last_error: `no_access:403:MCP server not enabled for any of your groups (token ${HIDDEN})` })
    expect(await check(id)).toMatchObject({ status: 'error', lastErrorReason: 'no_access' })
    // one log line per refused check: status, reason, the words; never the key
    const logged = warns.filter((w) => w.msg === 'connection check refused by the service')
    expect(logged.length).toBe(2)
    expect(logged[0]!.fields).toMatchObject({ id, status: 403, reason: 'no_access', said: `MCP server not enabled for any of your groups (token ${HIDDEN})` })
    expect(JSON.stringify(warns)).not.toContain(MCP_KEY)
    // no "sign in again": no notice, no reconnect card, the AI still has its tools and is not told it needs a sign-in
    expect(await reconnects()).toEqual([])
    expect(ownNeedsSignIn(getRow(A.ctx.db, id), 'alice')).toBe(false)
    const b = prompt('alice')
    expect(b.prompt).toContain('GitLab')
    expect(b.prompt).not.toMatch(/GitLab[^\n]*needs a new sign-in/)
    expect(b.tools.length).toBeGreaterThan(0)
  })

  test('a tool call answered 403: the AI is told signing in again will not help, with the service\'s words; the status the same', async () => {
    const row = getRow(A.ctx.db, id)!
    fake.refuse = { status: 403, methods: ['tools/call'], headers: { 'content-type': 'application/json' }, body: JSON.stringify(GITLAB) }
    let err: unknown
    try { await integrationsOf(A.ctx).callTool(row, tool, {}) } catch (e) { err = e }
    expect(err).toBeInstanceOf(CallError)
    expect((err as CallError).message).toContain('does not let this account use it (HTTP 403)')
    expect((err as CallError).message).toContain('"MCP server not enabled for any of your groups"')
    expect((err as CallError).message).toContain('Signing in again will not help')
    expect(stored(id)).toEqual({ status: 'error', last_error: 'no_access:403:MCP server not enabled for any of your groups' })
  })

  test('once the owner turns it on, Check again (or a call) brings it back', async () => {
    expect(await check(id)).toMatchObject({ status: 'connected', lastError: null })
  })

  test('403 insufficient_scope: sign in again and allow the access (needs_auth, the sign-in nag is right here)', async () => {
    fake.refuse = { status: 403, methods: ['tools/list'], headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="read_api"' } }
    const r = await check(id)
    expect(r).toMatchObject({ status: 'needs_auth', lastErrorReason: 'scope', lastError: TEXT.scope.en.replace('{status}', '403') })
    expect(stored(id)).toEqual({ status: 'needs_auth', last_error: 'scope:403' })
    expect((await reconnects()).length).toBe(1)
    fake.refuse = null
    expect(await check(id)).toMatchObject({ status: 'connected' })
  })

  test('403 invalid_token and 401: unchanged, the key or sign-in was refused', async () => {
    fake.refuse = { status: 403, methods: ['tools/list'], headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body: 'expired' }
    expect(await check(id)).toMatchObject({ status: 'needs_auth', lastErrorReason: 'refused', lastError: TEXT.refused.en.replace('{status}', '403') })
    fake.refuse = null
    expect(await check(id)).toMatchObject({ status: 'connected' })
    fake.refuse = { status: 401, methods: ['tools/list'], headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'unauthorized', message: 'nope' }) }
    expect(await check(id)).toMatchObject({ status: 'needs_auth', lastErrorReason: 'refused' })
    expect(stored(id)).toEqual({ status: 'needs_auth', last_error: 'refused:401' })
  })
})

describe('HTTP API: its check', () => {
  test('403 no access, 403 insufficient_scope, 401: the same reasons as MCP', async () => {
    const made = await send('alice', 'POST', '/api/integrations', { kind: 'http', name: 'Board API', url: `${fake.base}/refuse`, auth: 'none' })
    expect(made.body.status).toBe('connected')
    const id = made.body.id as string
    fake.refuse = { status: 403, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Your plan does not include the API' }) }
    expect(await check(id)).toMatchObject({ status: 'error', lastErrorReason: 'no_access' })
    expect(stored(id)).toEqual({ status: 'error', last_error: 'no_access:403:Your plan does not include the API' })
    fake.refuse = { status: 403, headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } }
    expect(stored(id).status).toBe('error')
    expect(await check(id)).toMatchObject({ status: 'needs_auth', lastErrorReason: 'scope' })
    fake.refuse = { status: 401 }
    expect(await check(id)).toMatchObject({ status: 'needs_auth', lastErrorReason: 'refused' })
    expect(stored(id)).toEqual({ status: 'needs_auth', last_error: 'refused:401' })
    fake.refuse = null
    expect(await check(id)).toMatchObject({ status: 'connected', lastError: null })
  })
})
