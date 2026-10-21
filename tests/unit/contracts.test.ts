// The shared REST / WebSocket contract (shared/src/api): registry sanity, schemas, ids, helpers.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { PRODUCT } from '@mycel/shared'
import {
  API, API_GROUPS, ApiClient, ApiError, ClientFrame, ERROR_MESSAGES, ErrorCode, ErrorStatus, Locale, Message, RelPath, ServerEvent, ServerFrame,
  SendMessageBody, TurnAnswerBody, UploadTarget, buildPath, isSchema, isUuid7, listEndpoints, localeFromAcceptLanguage, uuidv7, uuidv7Time,
  type Endpoint,
} from '@mycel/shared/api'

const now = new Date().toISOString()
const msg = (over: Partial<z.input<typeof Message>> = {}): z.input<typeof Message> => ({
  id: uuidv7(), chatId: uuidv7(), parentId: null, role: 'assistant', author: null, content: 'hi', attachments: [], steps: [],
  status: 'streaming', error: null, turnId: uuidv7(), engine: 'claude-code', model: null, files: null, usage: null, createdAt: now,
  branch: { index: 0, count: 1, siblingIds: [] }, ...over,
})

describe('product name', () => {
  test('UI shows Team AX, machine id stays mycel', () => {
    expect(PRODUCT.displayName).toBe('Team AX')
    expect(PRODUCT.id).toBe('mycel')
    expect(PRODUCT.envPrefix).toBe('MYCEL_')
  })
})

describe('uuidv7', () => {
  test('format, version and variant bits', () => {
    for (let i = 0; i < 1000; i++) expect(isUuid7(uuidv7())).toBe(true)
    expect(isUuid7('01890a5d-ac96-4000-8000-000000000000')).toBe(false) // v4 nibble
    expect(isUuid7(crypto.randomUUID())).toBe(false)
  })
  test('monotonic within the same millisecond, sortable as strings', () => {
    const t = Date.now()
    const ids = Array.from({ length: 5000 }, () => uuidv7(t))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
  test('encodes the time', () => {
    const t = Date.UTC(2026, 9, 21, 3, 4, 5, 678)
    expect(uuidv7Time(uuidv7(t + 10_000))).toBe(t + 10_000)
  })
})

describe('endpoint registry', () => {
  const all = listEndpoints()
  test('no key is shadowed when the groups are merged', () => {
    const total = Object.values(API_GROUPS).reduce((n, g) => n + Object.keys(g).length, 0)
    expect(Object.keys(API).length).toBe(total)
  })
  test('method + path unique, paths under /api, owners A–G, summaries present', () => {
    const seen = new Set<string>()
    for (const { name, ep } of all) {
      const k = `${ep.method} ${ep.path}`
      expect(seen.has(k), `${name}: duplicate ${k}`).toBe(false)
      seen.add(k)
      expect(ep.path.startsWith('/api/'), name).toBe(true)
      expect(['A', 'B', 'C', 'D', 'E', 'F', 'G']).toContain(ep.owner)
      expect(ep.summary.length, name).toBeGreaterThan(5)
      expect(/^\/api(\/(:[a-zA-Z]+|[a-z0-9-]+))+$/.test(ep.path), `${name}: odd path ${ep.path}`).toBe(true)
    }
  })
  test('GET has no body; empty responses are 204; 202 only for queued work', () => {
    for (const { name, ep } of all) {
      if (ep.method === 'GET') expect(ep.body, name).toBeUndefined()
      if (!isSchema(ep.response) && ep.response.kind === 'empty') expect(ep.status, name).toBe(204)
      if (ep.status === 202) expect(['sendMessage', 'regenerate', 'editMessage', 'transcribe', 'startUpdate', 'startBackup', 'startRestore', 'startExport']).toContain(name)
    }
  })
  test('owner-reauth endpoints carry a password field', () => {
    for (const { name, ep } of all.filter((x) => x.ep.auth === 'owner-reauth')) {
      expect(isSchema(ep.body), name).toBe(true)
      expect(Object.keys((ep.body as z.ZodObject<any>).shape)).toContain('password')
    }
  })
  test('every endpoint of the design tab 4 table is present', () => {
    const want = [
      'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/auth/password', 'GET /api/me', 'POST /api/invites/:token/accept',
      'GET /api/chats', 'POST /api/chats', 'PATCH /api/chats/:id', 'DELETE /api/chats/:id', 'GET /api/chats/:id/messages', 'POST /api/chats/:id/messages',
      'POST /api/chats/:id/stop', 'POST /api/chats/:id/restore', 'GET /api/projects', 'POST /api/projects', 'PATCH /api/projects/:id', 'DELETE /api/projects/:id',
      'GET /api/files/tree', 'GET /api/files/content', 'GET /api/files/download', 'POST /api/files/upload', 'POST /api/files/move', 'DELETE /api/files',
      'GET /api/files/history', 'POST /api/files/restore', 'POST /api/uploads', 'GET /api/chats/:id/artifacts', 'GET /api/memories', 'DELETE /api/memories',
      'POST /api/transcribe', 'POST /api/upload-sessions', 'PUT /api/upload-sessions/:id/chunks/:n', 'GET /api/upload-sessions/:id', 'POST /api/upload-sessions/:id/complete',
      'GET /api/jobs/:id', 'POST /api/jobs/:id/cancel', 'POST /api/turns/:id/answer',
      'GET /api/admin/users', 'POST /api/admin/users', 'PATCH /api/admin/users/:id', 'DELETE /api/admin/users/:id', 'GET /api/admin/groups',
      'POST /api/admin/folder-rules/preview', 'GET /api/admin/engines', 'GET /api/admin/budgets', 'GET /api/admin/settings', 'GET /api/admin/usage', 'GET /api/admin/audit',
      'GET /api/health', 'GET /api/admin/diagnostics', 'POST /api/admin/update', 'POST /api/admin/backup', 'POST /api/admin/restore',
    ]
    const have = new Set(all.map(({ ep }) => `${ep.method} ${ep.path}`))
    for (const w of want) expect(have.has(w), w).toBe(true)
  })
  test('buildPath fills and encodes params', () => {
    expect(buildPath(API.regenerate.path, { id: 'a b', messageId: 'x/y' })).toBe('/api/chats/a%20b/messages/x%2Fy/regenerate')
    expect(() => buildPath(API.getChat.path, {})).toThrow('missing path param id')
  })
})

describe('schemas', () => {
  test('RelPath accepts team-relative paths only', () => {
    for (const ok of ['', 'a', 'finance/2026/q3.xlsx', 'users/alice/.attachments/x/y.png', '회의록/메모.md']) expect(RelPath.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['/etc/passwd', 'a/../b', '..', './a', 'a//b', 'a/', 'a\\b', 'a\0b']) expect(RelPath.safeParse(bad).success, bad).toBe(false)
  })
  test('every error code has a status and messages in ko/en/id', () => {
    for (const c of ErrorCode.options) {
      expect(ErrorStatus[c]).toBeGreaterThanOrEqual(400)
      for (const l of Locale.options) expect(ERROR_MESSAGES[c][l].length).toBeGreaterThan(3)
    }
  })
  test('Accept-Language -> ko / en / id', () => {
    expect(localeFromAcceptLanguage('en-US,en;q=0.9')).toBe('en')
    expect(localeFromAcceptLanguage('id-ID')).toBe('id')
    expect(localeFromAcceptLanguage('fr-FR, ko;q=0.5')).toBe('ko')
    expect(localeFromAcceptLanguage(undefined)).toBe('en')
  })
  test('send message: content or attachment, idempotency key required', () => {
    expect(SendMessageBody.safeParse({ content: 'hello', clientMessageId: 'abcdefgh' }).success).toBe(true)
    expect(SendMessageBody.safeParse({ content: '  ', clientMessageId: 'abcdefgh' }).success).toBe(false)
    expect(SendMessageBody.safeParse({ content: '', attachmentIds: [uuidv7()], clientMessageId: 'abcdefgh' }).success).toBe(true)
    expect(SendMessageBody.safeParse({ content: 'x' }).success).toBe(false)
  })
  test('turn answers and upload targets are discriminated', () => {
    expect(TurnAnswerBody.safeParse({ kind: 'ask_user', requestId: 'r1', answer: null }).success).toBe(true)
    expect(TurnAnswerBody.safeParse({ kind: 'browser_site', requestId: 'r1', decision: 'always' }).success).toBe(true)
    expect(TurnAnswerBody.safeParse({ kind: 'browser_site', requestId: 'r1', answer: 'x' }).success).toBe(false)
    expect(UploadTarget.parse({ kind: 'path', path: 'a/b.zip' })).toEqual({ kind: 'path', path: 'a/b.zip', onExists: 'rename' })
    expect(UploadTarget.safeParse({ kind: 'path', path: '../x' }).success).toBe(false)
  })
})

describe('WebSocket protocol', () => {
  test('events carry seq and parse by type', () => {
    const chatId = uuidv7(), messageId = uuidv7()
    const evs = [
      { type: 'message.delta', seq: 1, at: Date.now(), data: { chatId, messageId, offset: 0, text: '안녕' } },
      { type: 'message.step', seq: 2, at: Date.now(), data: { chatId, messageId, step: { id: 's1', kind: 'tool', tool: 'grep', label: 'grep "x"', status: 'running', startedAt: now, endedAt: null } } },
      { type: 'message.done', seq: 3, at: Date.now(), data: { chatId, messageId, status: 'done', message: msg({ id: messageId, chatId, status: 'done' }) } },
      { type: 'queue.position', seq: 4, at: Date.now(), data: { chatId, messageId, turnId: uuidv7(), position: 2 } },
      { type: 'files.changed', seq: 5, at: Date.now(), data: { changes: [{ path: 'a/b.md', action: 'move', from: 'a/c.md', by: { id: 'alice', name: 'Alice' }, turnId: null }] } },
      { type: 'turn.request', seq: 6, at: Date.now(), data: { turnId: uuidv7(), chatId, messageId, request: { kind: 'ask_user', requestId: 'q1', question: 'A or B?', options: [{ label: 'A', value: 'a' }] } } },
      { type: 'job.progress', seq: 7, at: Date.now(), data: { jobId: uuidv7(), kind: 'transcribe', progress: 0.5, message: null } },
      { type: 'browser.call', seq: 8, at: Date.now(), data: { windowId: 'w123456789', call: { callId: 'c1', turnId: uuidv7(), chatId, tool: 'navigate', args: { url: 'https://example.com' }, deadline: Date.now() + 60000 } } },
      { type: 'session.ended', seq: 9, at: Date.now(), data: { reason: 'password_changed' } },
    ]
    for (const e of evs) expect(ServerEvent.safeParse(e).success, e.type).toBe(true)
    expect(ServerEvent.safeParse({ ...evs[0], seq: 0 }).success).toBe(false)
    expect(ServerFrame.safeParse({ type: 'hello', epoch: 'e1', seq: 10, resumed: true, windowId: 'w123456789', serverVersion: '0.1.0', pingIntervalMs: 20000 }).success).toBe(true)
    expect(ServerFrame.safeParse({ type: 'reset', epoch: 'e2', seq: 0, reason: 'server_restarted' }).success).toBe(true)
  })
  test('client frames', () => {
    expect(ClientFrame.safeParse({ type: 'ping', t: 1 }).success).toBe(true)
    expect(ClientFrame.safeParse({ type: 'browser.result', result: { callId: 'c1', ok: true, content: [{ type: 'text', text: 'ok' }] } }).success).toBe(true)
    expect(ClientFrame.safeParse({ type: 'browser.result', result: { callId: 'c1', ok: true, content: [{ type: 'image', mime: 'image/gif', data: '' }] } }).success).toBe(false)
  })
})

describe('ApiClient', () => {
  test('sends CSRF + window headers, builds query strings, maps errors', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      if (url.includes('/api/chats?')) return Response.json({ items: [], nextCursor: null })
      return Response.json({ error: { code: 'forbidden', message: '권한이 없습니다.' } }, { status: 403 })
    }) as unknown as typeof fetch
    const api = new ApiClient({ baseUrl: 'http://x', windowId: 'w123456789', fetch: fake })
    expect(await api.call(API.listChats, { query: { limit: 5, trash: 'true' } })).toEqual({ items: [], nextCursor: null })
    expect(seen[0]!.url).toBe('http://x/api/chats?limit=5&trash=true')
    const err = await api.call(API.stop, { params: { id: uuidv7() } }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('forbidden')
    const h = seen[1]!.init.headers as Record<string, string>
    expect(h['x-mycel-csrf']).toBe('1')
    expect(h['x-mycel-window']).toBe('w123456789')
  })
  test('the endpoint type carries params / body (compile-time check)', () => {
    const ep: Endpoint = API.sendMessage
    expect(ep.method).toBe('POST')
  })
})
