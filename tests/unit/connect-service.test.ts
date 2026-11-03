// connect_service (server/src/chat/connect-service.ts, docs/INTEGRATIONS.md "Connecting from a chat"): the AI fills in
// a connection and the person finishes it on a card; the key goes from the card, sealed for 'integration.secret', to
// POST /api/turns/:id/connect and never reaches the AI. Real turns with the fake engine (tests/lib/b-fake-engine.ts):
// early answers without a card, the card's fields, a sealed key making a personal connection (a wrong one first: the
// same row gets the next key), a seal for another purpose, team connections for admins only, another person's turn,
// /answer refused for these cards, skip, timeout, sign-in then done, and a scheduled run. Also: an HTTP API's notes on
// the card and saved as shown, a team card's "who may use it" changed on a retry, Google Drive finished with done,
// a slow check (two connects at once, the card's time running out or "not now" while a connect runs), "not now"
// after a finished sign-in, the tool names the AI is told, a key that is too long. Invisible or direction-changing
// characters in the name, notes or line (no card, and refused again where the card is saved) while Korean, Japanese
// and emoji names work; another key after personal connections were turned off or after the connection was changed
// in Settings (refused, the key never sent); done before anything was connected. Every text the server let
// out or saved for these turns (answer, steps, audit lines, events, responses, rows, audit log, logs) is searched for
// the key and the sealed value; a failure says where, never the key.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type SealedSecret, type SealPurpose } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { API_KEY, FakeServices, MCP_KEY } from '../lib/fake-services'
import { DRIVE_CONFIG, FakeGoogleDrive } from '../lib/fake-google-drive'
import { sealSecret } from '../../web/src/lib/seal'
import { createLogger } from '../../server/src/log'
import { credentialsOf } from '../../server/src/credentials/store'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { CONNECT_RULE } from '../../server/src/chat/prompt'
import { DRIVE_TOOL_NAMES } from '../../server/src/tools/drive'

setDefaultTimeout(60_000)

const WRONG = 'CANARY-wrong-key-7310'
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness, svc: FakeServices
const published: { userId: string; ev: any }[] = []
const responses: string[] = []
const logs: string[] = []
const sealedSent: SealedSecret[] = []

beforeAll(async () => {
  h = await startHarness({ name: 'connect-service', askUserTimeoutMs: 6000, turnTimeoutMs: 60_000, log: createLogger({ level: 'debug', name: 'test', sink: (l) => logs.push(l) }) })
  h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'true') ON CONFLICT(key) DO UPDATE SET value='true'").run()
  const hub = h.rt().hub
  const publish = hub.publish.bind(hub), publishTo = hub.publishTo.bind(hub)
  hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
  hub.publishTo = (userId, w, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); return publishTo(userId, w, ev) }
  svc = new FakeServices()
  integrationsOf(h.ctx, { net: svc.net() })
})
afterAll(async () => { svc?.stop(); await h?.close() })

/** a sealed key as the browser makes it (web/src/lib/seal.ts) */
async function seal(secret: string, purpose: SealPurpose = 'integration.secret') {
  const s = await sealSecret(await credentialsOf(h.ctx).sealer.publicKey(), secret, purpose)
  sealedSent.push(s)
  return s
}

/** a new chat whose message makes these tool calls (each result said in the answer) */
async function start(user: string, ...calls: Record<string, unknown>[]) {
  const chat = await h.api(user).call(API.createChat, { body: {} })
  const r = await h.api(user).call(API.sendMessage, { params: { id: chat.id }, body: { content: fake(...calls.map((args) => ({ tool: 'connect_service', args, sayResult: true }))), clientMessageId: cm(), attachmentIds: [] } })
  return { chatId: chat.id, turnId: r.turnId, messageId: r.assistantMessage.id }
}
const cards = (turnId: string) => published.filter((p) => p.ev.type === 'turn.request' && p.ev.data.turnId === turnId).map((p) => p.ev.data.request)
async function cardOf(turnId: string) {
  const c = await waitFor(() => cards(turnId)[0], { timeoutMs: 20_000, what: 'connect card' })
  expect(c, 'a card was shown').toBeTruthy()
  return c
}
async function doneOf(messageId: string): Promise<{ content: string; steps: any[] }> {
  const d = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === messageId), { timeoutMs: 30_000, what: 'message.done' })
  expect(d, 'the answer ended').toBeTruthy()
  return d!.ev.data.message
}
async function post(user: string, turnId: string, body: unknown, path = 'connect') {
  const r = await h.req(user, `/api/turns/${turnId}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  responses.push(text)
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
const open = (user: string, chatId: string) => h.api(user).call(API.listTurnRequests, { params: { id: chatId } }).then((r) => r.items.map((i) => i.request.requestId))
const rowsAt = (url: string) => h.ctx.db.query('SELECT id, scope, owner_user_id, status FROM integrations WHERE url = ?').all(url) as { id: string; scope: string; owner_user_id: string | null; status: string }[]
const stepOf = (m: { steps: any[] }) => m.steps.find((s) => s.tool === 'connect_service')
/** the tool's result as the fake engine said it in the answer */
const resultOf = (m: { content: string }) => JSON.parse(m.content.slice(m.content.indexOf('{'), m.content.lastIndexOf('}') + 1))
/** a web session of this person, for a sign-in (the flows are bound to one) */
function session(user: string, id: string) {
  const now = new Date().toISOString(), later = new Date(Date.now() + 3600_000).toISOString()
  h.ctx.db.query('INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id, user, `${id}-hash`, 'web', now, now, later)
}
/** The service at `path` answers only once `go` is called: a check of a connection there runs until then (the
 * fake's requests time out after 5 s). */
function holdService(path: string) {
  let release!: () => void
  svc.hold = { path, until: new Promise<void>((r) => { release = r }) }
  return { go: () => { svc.hold = null; release() } }
}
async function held<T>(path: string, fn: (go: () => void) => Promise<T>): Promise<T> {
  const h = holdService(path)
  try { return await fn(h.go) } finally { h.go() }
}
/** cards opened meanwhile close after `ms` (Admin can make it 30 s; the harness's own time is 6 s) */
async function withCardTime<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const o = (h.rt() as unknown as { o: { askUserTimeoutMs?: number } }).o
  const before = o.askUserTimeoutMs
  o.askUserTimeoutMs = ms
  try { return await fn() } finally { o.askUserTimeoutMs = before }
}
const closedWhy = (requestId: string) => published.find((p) => p.ev.type === 'turn.request.closed' && p.ev.data.requestId === requestId)?.ev.data.reason as string | undefined

/** Everything the server let out or saved, as one text, and whether it holds a key or a sealed value. */
function leaksIn(turnIds: string[]): string[] {
  const parts: [string, string][] = []
  for (const t of turnIds) {
    const m = h.ctx.db.query('SELECT content, steps FROM messages WHERE id = (SELECT message_id FROM turns WHERE id = ?)').get(t) as { content: string; steps: string } | null
    parts.push(['answer and steps', JSON.stringify(m)])
    parts.push(['tool_events', JSON.stringify(h.ctx.db.query('SELECT tool, summary FROM tool_events WHERE turn_id = ?').all(t))])
  }
  parts.push(['events', JSON.stringify(published)])
  parts.push(['responses', responses.join('\n')])
  parts.push(['integration rows', JSON.stringify(h.ctx.db.query('SELECT name, url, notes, last_error, account, tools_json, secret_enc FROM integrations').all())])
  parts.push(['audit log', JSON.stringify(h.ctx.db.query('SELECT action, target, detail FROM audit_log').all())])
  parts.push(['logs', logs.join('\n')])
  // every file of the server's data folder: the database and its log, the engine's session files, the secrets folder
  let files = 0
  for (const rel of fs.readdirSync(h.dataDir, { recursive: true }).map(String)) {
    const abs = path.join(h.dataDir, rel)
    let st: fs.Stats
    try { st = fs.lstatSync(abs) } catch { continue }
    if (!st.isFile()) continue
    files++
    parts.push([`data folder file ${rel}`, fs.readFileSync(abs).toString('latin1')])
  }
  // the search sees what it should: the engine's session file and the database hold this tool's calls
  expect(files).toBeGreaterThan(3)
  expect(parts.some(([where, text]) => where.startsWith('data folder') && text.includes('connect_service'))).toBe(true)
  expect(logs.length).toBeGreaterThan(0)
  const out: string[] = []
  for (const [where, text] of parts) {
    if ([MCP_KEY, API_KEY, WRONG].some((k) => text.includes(k))) out.push(`${where}: a key`)
    if (sealedSent.some((s) => text.includes(s.ct) || text.includes(s.epk))) out.push(`${where}: a sealed value`)
  }
  return out
}

describe('where it is offered', () => {
  test('a chat gets the tool and its rule; a confidential chat does not get the tool', async () => {
    const send = async (chatId: string, content: string) => {
      const r = await h.api('alice').call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
      return (await doneOf(r.assistantMessage.id)).content
    }
    const plain = await h.api('alice').call(API.createChat, { body: {} })
    const out = await send(plain.id, fake({ echo: 'tools' }, { say: ' | ' }, { echo: 'system' }))
    expect(out.split(' | ')[0]!.split(',')).toContain('connect_service')
    expect(out).toContain(CONNECT_RULE)
    const secret = await h.api('alice').call(API.createChat, { body: {} })
    h.ctx.db.query('INSERT INTO safe_ops_chats(chat_id) VALUES (?)').run(secret.id)
    const tools = (await send(secret.id, fake({ echo: 'tools' }))).split(',')
    expect(tools).toContain('read')
    expect(tools).not.toContain('connect_service')
  })
})

describe('connect_service without a card', () => {
  test('bad fields, http, a private address, a key in a field, team by a member, the same address, Drive not set up: answers only', async () => {
    const existing = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Open', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask' } })
    expect(existing.status).toBe('connected')
    const t = await start('alice',
      { name: 'Tasks', kind: 'mcp', auth: 'bearer' },
      { name: 'Tasks', kind: 'mcp', url: 'http://svc.test/mcp-key', auth: 'bearer' },
      { name: 'Tasks', kind: 'mcp', url: 'https://10.0.0.5/mcp', auth: 'bearer' },
      { name: 'Tasks', kind: 'http', url: `${svc.base}/api`, auth: 'bearer', notes: 'Send it as Bearer sk-live-4f9a8b7c6d5e4f3a2b1c' },
      { name: 'Tasks', kind: 'mcp', url: `${svc.base}/mcp-key`, auth: 'bearer', scope: 'team' },
      { name: 'Open again', kind: 'mcp', url: `${svc.base}/mcp-open/`, auth: 'none' },
      { name: 'Tasks', kind: 'mcp', url: `${svc.base}/mcp-key`, auth: 'header', authHeader: 'Cookie' },
      { name: 'Google Drive', target: 'google_drive' },
      // a key-named query value that looks like a key
      { name: 'Tasks', kind: 'mcp', url: `${svc.base}/mcp-key?api_key=abc123def456`, auth: 'none' },
    )
    const m = await doneOf(t.messageId)
    expect(cards(t.turnId)).toEqual([])
    for (const words of ['a service needs url', 'an https address', 'private or office network', 'the notes looks like it contains a key', 'Only an admin can add a team connection', 'already exists: "Open", connected', 'authHeader cannot carry a key', 'Google Drive is not set up', 'the url looks like it contains a key'])
      expect(m.content, words).toContain(words)
    // the step never shows the key-looking notes, and says nothing was connected
    expect(m.steps.filter((s) => s.tool === 'connect_service').length).toBe(9)
    expect(m.content.includes('sk-live-4f9a8b7c6d5e4f3a2b1c') || JSON.stringify(m.steps).includes('sk-live')).toBe(false)
    const events = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'connect_service'").all(t.turnId) as { summary: string }[]
    expect(events.every((e) => e.summary.startsWith('connect_service -> no card ('))).toBe(true)
    expect(rowsAt(`${svc.base}/mcp-key`)).toEqual([])
  })

  test('personal connections off, Drive already connected: answers only', async () => {
    h.ctx.db.query("UPDATE settings SET value='false' WHERE key='personalIntegrations'").run()
    const drive = new FakeGoogleDrive()
    const d = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: drive.fetch })
    const now = new Date().toISOString(), later = new Date(Date.now() + 3600_000).toISOString()
    h.ctx.db.query("INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES('cs-drive','alice','cs-drive-hash','web',?,?,?)").run(now, now, later)
    try {
      const f = d.authorize('alice', 'cs-drive')
      await d.callback(drive.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'cs-drive' })
      d.complete('alice', 'cs-drive', f.flowId)
      expect(d.status('alice').status).toBe('connected')
      const t = await start('alice', { name: 'Linear', kind: 'mcp', url: `${svc.base}/mcp-key`, auth: 'bearer' }, { name: 'Drive', target: 'google_drive' })
      const m = await doneOf(t.messageId)
      expect(cards(t.turnId)).toEqual([])
      expect(m.content).toContain('does not allow personal connections')
      expect(m.content).toContain('Google Drive is already connected')
    } finally {
      h.ctx.db.query("UPDATE settings SET value='true' WHERE key='personalIntegrations'").run()
      await d.disconnect('alice').catch(() => {})
      googleDriveOf(h.ctx, { config: null })
    }
  })
})

describe('the card', () => {
  test('a wrong key, then the right one: one personal connection, connected; nothing anywhere holds the key or the sealed value', async () => {
    const url = `${svc.base}/mcp-key`
    const t = await start('alice', { name: 'Tasks', kind: 'mcp', url, auth: 'bearer', why: 'to read your tasks' })
    const card = await cardOf(t.turnId)
    // what the card shows: where the key goes, never a key
    expect(Object.keys(card).sort()).toEqual(['expiresAt', 'kind', 'name', 'requestId', 'scope', 'service', 'target', 'why'])
    expect(card).toMatchObject({ kind: 'connect_service', target: 'service', name: 'Tasks', scope: 'personal', why: 'to read your tasks', service: { kind: 'mcp', url, host: new URL(url).host, auth: 'bearer', authHeader: null } })
    expect(await open('alice', t.chatId)).toEqual([card.requestId])

    const first = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
    expect(first.status).toBe(200)
    expect(first.body.state).toBe('retry')
    expect(first.body.lastError).toBeTruthy()
    expect(rowsAt(url).length).toBe(1)
    expect(await open('alice', t.chatId)).toEqual([card.requestId]) // the card stays for another key

    const second = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
    expect(second.body).toMatchObject({ state: 'connected', integrationId: first.body.integrationId, status: 'connected' })
    expect(rowsAt(url)).toEqual([{ id: first.body.integrationId, scope: 'personal', owner_user_id: 'alice', status: 'connected' }])

    const m = await doneOf(t.messageId)
    const result = JSON.parse(m.content.slice(m.content.indexOf('{'), m.content.lastIndexOf('}') + 1))
    expect(result).toMatchObject({ connected: true, name: 'Tasks', status: 'connected' })
    expect(result.tools).toContain('search_tasks')
    expect(stepOf(m)).toMatchObject({ kind: 'tool', label: 'Connect service · Tasks', detail: 'Connected', status: 'ok' })
    expect(h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'connect_service'").get(t.turnId)).toEqual({ summary: 'connect_service -> connected' })
    // the stored key works for the AI's calls (the service saw it), and it is in no text
    expect(svc.seen.some((s) => s.path === '/mcp-key' && s.headers.authorization === `Bearer ${MCP_KEY}`)).toBe(true)
    expect(leaksIn([t.turnId])).toEqual([])
    // the card is finished: nothing more goes through it
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).status).toBe(409)
  })

  test('"not now" after a key that did not work takes away the connection that card made', async () => {
    const url = `${svc.base}/mcp-key?card=not-now`
    const t = await start('alice', { name: 'Tasks again', kind: 'mcp', url, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    const first = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
    expect(first.body.state).toBe('retry')
    expect(rowsAt(url).length).toBe(1)
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
    expect(rowsAt(url)).toEqual([])
    // removed the way Settings removes one: audited as alice
    expect(h.ctx.db.query("SELECT actor_id, action FROM audit_log WHERE target = ? AND action = 'integration.delete'").get(first.body.integrationId)).toEqual({ actor_id: 'alice', action: 'integration.delete' })
    const m = await doneOf(t.messageId)
    expect(m.content).toContain('{"skipped":true}')
    expect(m.content).not.toContain('was added')
  })

  test('a key sealed for another purpose is refused; "not now" closes the card and the AI is told skipped', async () => {
    const url = `${svc.base}/mcp-header`
    const t = await start('alice', { name: 'Header tasks', kind: 'mcp', url, auth: 'header', authHeader: 'X-API-Key' })
    const card = await cardOf(t.turnId)
    for (const purpose of ['credential.create', 'speech.key'] as const) {
      const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY, purpose) })
      expect(r.status).toBe(400)
      expect(r.body.error.fields['body.sealed']).toBe('sealed for another request')
    }
    // no key at all for a key service; a key-less body is refused before anything is made
    expect((await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })).status).toBe(400)
    expect(rowsAt(url)).toEqual([])
    expect(await open('alice', t.chatId)).toEqual([card.requestId])
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
    const m = await doneOf(t.messageId)
    expect(m.content).toContain('{"skipped":true}')
    expect(stepOf(m).detail).toBe('Not connected')
    expect(rowsAt(url)).toEqual([])
    expect(leaksIn([t.turnId])).toEqual([])
  })

  test('only the turn\'s person reaches the card, and never through /answer', async () => {
    const t = await start('alice', { name: 'Tasks 2', kind: 'mcp', url: `${svc.base}/mcp-key?x=2`, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    // another person: the turn is not found for them (as /answer)
    expect((await post('bob', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })).status).toBe(404)
    expect((await post('bob', t.turnId, { action: 'skip', requestId: card.requestId })).status).toBe(404)
    expect((await post('carol', t.turnId, { action: 'skip', requestId: card.requestId })).status).toBe(404)
    // /answer: no kind for these cards, and an ask_user answer with the card's id does not close it
    expect((await post('alice', t.turnId, { kind: 'connect_service', requestId: card.requestId, answer: { outcome: 'connected', integrationId: 'x' } }, 'answer')).status).toBe(400)
    expect((await post('alice', t.turnId, { kind: 'ask_user', requestId: card.requestId, answer: 'connected' }, 'answer')).status).toBe(409)
    // a request id that is not an open card of this turn
    expect((await post('alice', t.turnId, { action: 'skip', requestId: 'not-a-card' })).status).toBe(409)
    expect(await open('alice', t.chatId)).toEqual([card.requestId])
    // nobody finishes it: when the card's time is up the AI is told skipped
    const m = await doneOf(t.messageId)
    expect(m.content).toContain('{"skipped":true}')
    expect(stepOf(m).detail).toBe('Not connected')
    expect(rowsAt(`${svc.base}/mcp-key?x=2`)).toEqual([])
  })

  test('team: an admin picks "just me"; the role is checked again when the card is finished', async () => {
    const url = `${svc.base}/mcp-open?team=1`
    const t = await start('carol', { name: 'Team board', kind: 'mcp', url, auth: 'none', scope: 'team' })
    const card = await cardOf(t.turnId)
    expect(card).toMatchObject({ scope: 'team', service: { auth: 'none' } })
    h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = 'carol'").run()
    try { expect((await post('carol', t.turnId, { action: 'connect', requestId: card.requestId })).status).toBe(403) }
    finally { h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = 'carol'").run() }
    expect(rowsAt(url)).toEqual([])
    const r = await post('carol', t.turnId, { action: 'connect', requestId: card.requestId, access: 'me' })
    expect(r.body).toMatchObject({ state: 'connected', status: 'connected' })
    expect(rowsAt(url)).toEqual([{ id: r.body.integrationId, scope: 'team', owner_user_id: null, status: 'connected' }])
    expect(h.ctx.db.query('SELECT subject_type, subject_id FROM integration_access WHERE integration_id = ?').all(r.body.integrationId)).toEqual([{ subject_type: 'user', subject_id: 'carol' }])
    expect(JSON.parse((await doneOf(t.messageId)).content.match(/\{.*\}/)![0])).toMatchObject({ connected: true, name: 'Team board' })
  })

  test('sign-in: added, then done only once the sign-in finished', async () => {
    const url = `${svc.base}/mcp-oauth`
    const t = await start('alice', { name: 'Board', kind: 'mcp', url, auth: 'oauth' })
    const card = await cardOf(t.turnId)
    // done before the card connected anything: said so, not "finish signing in"
    expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body).toEqual({ state: 'retry', lastError: 'Nothing was connected from this card yet. Use its button to connect first.' })
    const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })
    expect(r.body).toMatchObject({ state: 'sign_in', status: 'needs_auth' })
    // done before signing in: not connected yet, the card stays
    expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body.state).toBe('retry')
    expect(await open('alice', t.chatId)).toEqual([card.requestId])
    // the existing sign-in (POST /api/integrations/:id/authorize, the callback) for that connection
    const now = new Date().toISOString(), later = new Date(Date.now() + 3600_000).toISOString()
    h.ctx.db.query("INSERT INTO sessions(id,user_id,token_hash,client,created_at,last_seen_at,expires_at) VALUES('cs-oauth','alice','cs-oauth-hash','web',?,?,?)").run(now, now, later)
    const ints = integrationsOf(h.ctx)
    const f = await ints.authorize({ id: 'alice', role: 'member' }, 'cs-oauth', r.body.integrationId, 'https://team.example.test', 'en')
    expect(await ints.callback(svc.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'cs-oauth' })).toBe(true)
    expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body).toMatchObject({ state: 'connected', integrationId: r.body.integrationId })
    expect(JSON.parse((await doneOf(t.messageId)).content.match(/\{.*\}/)![0])).toMatchObject({ connected: true, name: 'Board', status: 'connected' })
    expect(rowsAt(url).length).toBe(1)
  })

  test('a scheduled run: no card, skipped', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const started = h.rt().createTurn({
      chat: h.rt().store.chatRow(chat.id)!, userId: 'alice', locale: 'en', windowId: null, clientKind: 'schedule', engine: 'claude-code', model: null,
      user: { parentId: null, content: fake({ tool: 'connect_service', args: { name: 'Tasks 3', kind: 'mcp', url: `${svc.base}/mcp-key?x=3`, auth: 'bearer' }, sayResult: true }), attachments: [], clientMessageId: cm() },
    })
    const m = await doneOf(started.assistantMessage.id)
    expect(cards(started.turnId)).toEqual([])
    expect(m.content).toContain('"skipped":true')
    expect(m.content).toContain('scheduled run')
    expect(h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'connect_service'").get(started.turnId)).toEqual({ summary: 'connect_service -> skipped (scheduled run)' })
  })
})

describe('what the card shows and saves', () => {
  test('an HTTP API: the card shows the usage notes, and the connection is saved with exactly what it showed', async () => {
    const url = `${svc.base}/api/v1?card=notes`
    const notes = 'GET /tasks lists the tasks.\n\tPOST /tasks adds one.\u0007 Ask before you delete one.'
    const t = await start('alice', { name: 'Tasks API', kind: 'http', url, auth: 'bearer', notes })
    const card = await cardOf(t.turnId)
    // in full, cleaned the way the store cleans them (a control character becomes a space; lines and tabs stay)
    expect(card.notes).toBe('GET /tasks lists the tasks.\n\tPOST /tasks adds one.  Ask before you delete one.')
    const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(API_KEY) })
    expect(r.status).toBe(200)
    const saved = h.ctx.db.query('SELECT notes FROM integrations WHERE id = ?').get(r.body.integrationId) as { notes: string }
    expect(saved.notes).toBe(card.notes)
    await doneOf(t.messageId)
    // an MCP server has no notes: none on its card
    const m = await start('alice', { name: 'Notes on MCP', kind: 'mcp', url: `${svc.base}/mcp-open?card=notes`, auth: 'none', notes: 'never shown' })
    const mcpCard = await cardOf(m.turnId)
    expect('notes' in mcpCard).toBe(false)
    await post('alice', m.turnId, { action: 'skip', requestId: mcpCard.requestId })
    expect(leaksIn([t.turnId])).toEqual([])
  })

  test('the tool names the AI is told: at most 30, each at most 64 characters, no control or format characters', async () => {
    const before = svc.tools, pageSize = svc.pageSize
    const tool = (name: string) => ({ name, description: 'x', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })
    svc.tools = [tool('\u200b\u2060'), tool('a'.repeat(100)), tool('b\u202eexe.txt'), tool('c\u200bzero\u2028line\u007f'), ...Array.from({ length: 40 }, (_, i) => tool(`tool_${i}`))]
    svc.pageSize = 100
    try {
      const t = await start('alice', { name: 'Many tools', kind: 'mcp', url: `${svc.base}/mcp-open?card=names`, auth: 'none' })
      const card = await cardOf(t.turnId)
      expect((await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })).body.state).toBe('connected')
      const { tools } = resultOf(await doneOf(t.messageId)) as { tools: string[] }
      expect(tools.length).toBe(30)
      // the name of format characters only is left out; the others come cleaned and cut
      expect(tools.slice(0, 4)).toEqual(['a'.repeat(64), 'bexe.txt', 'czeroline', 'tool_0'])
      expect(tools.every((n) => n.length <= 64 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(n))).toBe(true)
    } finally { svc.tools = before; svc.pageSize = pageSize }
  })

  test('a key over 8000 characters is refused after it is opened, and nothing is made', async () => {
    const url = `${svc.base}/mcp-key?card=long`
    const t = await start('alice', { name: 'Long key', kind: 'mcp', url, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal('k'.repeat(8001)) })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe('The key is too long (at most 8000 characters). Paste only the key the service gave you.')
    expect(rowsAt(url)).toEqual([])
    expect(await open('alice', t.chatId)).toEqual([card.requestId])
    await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })
    await doneOf(t.messageId)
  })
})

describe('the card, finished in other ways', () => {
  test('team: "Just me" with a wrong key, then "Everyone" with the right one: everyone may use it', async () => {
    const url = `${svc.base}/mcp-key?team=retry`
    const t = await start('carol', { name: 'Team tasks', kind: 'mcp', url, auth: 'bearer', scope: 'team' })
    const card = await cardOf(t.turnId)
    const first = await post('carol', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG), access: 'me' })
    expect(first.body.state).toBe('retry')
    const id = first.body.integrationId as string
    const access = () => h.ctx.db.query('SELECT subject_type, subject_id FROM integration_access WHERE integration_id = ? ORDER BY subject_type, subject_id').all(id)
    expect(access()).toEqual([{ subject_type: 'user', subject_id: 'carol' }])
    const second = await post('carol', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY), access: 'everyone' })
    expect(second.body).toMatchObject({ state: 'connected', integrationId: id, status: 'connected' })
    expect(access()).toEqual([{ subject_type: 'everyone', subject_id: '' }])
    expect(rowsAt(url).length).toBe(1)
    // changed the way Settings changes it: one audited update with who could use it before and after
    const updates = (h.ctx.db.query("SELECT detail FROM audit_log WHERE target = ? AND action = 'integration.update'").all(id) as { detail: string }[]).map((r) => JSON.parse(r.detail))
    expect(updates.some((d) => d.changed.includes('access') && d.access.after.everyone === true && d.access.before.users.includes('carol'))).toBe(true)
    // a member now has it
    expect((await h.api('alice').call(API.listIntegrations)).items.map((i) => i.id)).toContain(id)
    expect(resultOf(await doneOf(t.messageId))).toMatchObject({ connected: true, name: 'Team tasks' })
    expect(leaksIn([t.turnId])).toEqual([])
  })

  test('Google Drive: done before it is connected keeps the card; done after it says connected', async () => {
    const drive = new FakeGoogleDrive()
    const d = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: drive.fetch })
    session('alice', 'cs-drive-card')
    try {
      const t = await start('alice', { name: 'My Drive', target: 'google_drive', why: 'to read your files' })
      const card = await cardOf(t.turnId)
      expect(card).toMatchObject({ target: 'google_drive', name: 'Google Drive', scope: 'personal', why: 'to read your files' })
      expect(card.service).toBeUndefined()
      // a Drive card has its own sign-in; "connect" is not for it
      expect((await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })).status).toBe(400)
      expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body).toEqual({ state: 'retry', lastError: 'Not connected yet. Finish signing in first.' })
      expect(await open('alice', t.chatId)).toEqual([card.requestId])
      const f = d.authorize('alice', 'cs-drive-card')
      await d.callback(drive.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'cs-drive-card' })
      d.complete('alice', 'cs-drive-card', f.flowId)
      expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body).toEqual({ state: 'connected' })
      const m = await doneOf(t.messageId)
      expect(resultOf(m)).toEqual({ connected: true, name: 'Google Drive', status: 'connected', tools: [...DRIVE_TOOL_NAMES] })
      expect(stepOf(m).detail).toBe('Connected')
    } finally {
      await d.disconnect('alice').catch(() => {})
      googleDriveOf(h.ctx, { config: null })
    }
  })

  test('two connects at once: the second is refused while the first checks', async () => {
    const url = `${svc.base}/mcp-key?card=busy`
    const t = await start('alice', { name: 'Busy tasks', kind: 'mcp', url, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    await held('/mcp-key', async (go) => {
      const first = post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
      // the first one made its connection and is checking it now (the service holds its answer)
      await waitFor(() => rowsAt(url).length === 1, { what: 'the first connect is running' })
      const second = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
      expect(second.status).toBe(409)
      expect(second.body.error.message).toBe('This card is connecting right now. Wait a moment.')
      expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).status).toBe(409)
      go()
      expect((await first).body).toMatchObject({ state: 'connected', status: 'connected' })
    })
    expect(rowsAt(url).length).toBe(1)
    expect(resultOf(await doneOf(t.messageId))).toMatchObject({ connected: true, name: 'Busy tasks' })
  })

  test('the card\'s time runs out while a connect runs: the AI is told what it made, not "skipped"', async () => {
    const url = `${svc.base}/mcp-key?card=slow`
    await withCardTime(1500, async () => {
      const t = await start('alice', { name: 'Slow tasks', kind: 'mcp', url, auth: 'bearer' })
      const card = await cardOf(t.turnId)
      await held('/mcp-key', async (go) => {
        const res = post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
        // the card closes by its timer while the check is held
        expect(await waitFor(() => closedWhy(card.requestId), { what: 'the card closed' })).toBe('timeout')
        expect(rowsAt(url).length).toBe(1)
        go()
        expect((await res).body).toMatchObject({ state: 'connected', status: 'connected' })
        const m = await doneOf(t.messageId)
        expect(resultOf(m)).toMatchObject({ connected: true, name: 'Slow tasks', status: 'connected' })
        expect(stepOf(m).detail).toBe('Connected')
      })
    })
    // and a key that does not work: "added but not working yet", never a bare "skipped"
    const url2 = `${svc.base}/mcp-key?card=slow-wrong`
    await withCardTime(1500, async () => {
      const t = await start('alice', { name: 'Slow wrong', kind: 'mcp', url: url2, auth: 'bearer' })
      const card = await cardOf(t.turnId)
      await held('/mcp-key', async (go) => {
        const res = post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
        expect(await waitFor(() => closedWhy(card.requestId), { what: 'the card closed' })).toBe('timeout')
        go()
        expect((await res).body.state).toBe('retry')
        const r = resultOf(await doneOf(t.messageId))
        expect(r.skipped).toBe(true)
        expect(r.reason).toContain('"Slow wrong" was added but is not working yet')
      })
    })
    // left in Settings, as for any card whose time ran out
    expect(rowsAt(url2).length).toBe(1)
  })

  test('"not now" while a connect runs: that connection stays, and the AI is told what it made', async () => {
    const url = `${svc.base}/mcp-key?card=skip-running`
    const t = await start('alice', { name: 'Skip tasks', kind: 'mcp', url, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    await held('/mcp-key', async (go) => {
      const first = post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
      await waitFor(() => rowsAt(url).length === 1, { what: 'the connect is running' })
      expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
      expect(closedWhy(card.requestId)).toBe('answered')
      go()
      expect((await first).body.state).toBe('retry')
    })
    // not removed under the running connect; the AI hears it was added
    expect(rowsAt(url).length).toBe(1)
    expect(h.ctx.db.query("SELECT 1 FROM audit_log WHERE target = ? AND action = 'integration.delete'").get(rowsAt(url)[0]!.id)).toBeNull()
    const r = resultOf(await doneOf(t.messageId))
    expect(r.skipped).toBe(true)
    expect(r.reason).toContain('"Skip tasks" was added but is not working yet')
  })

  test('"not now" right after the sign-in finished, before its check: the connection and its sign-in stay', async () => {
    const url = `${svc.base}/mcp-oauth?card=signed-in`
    const t = await start('alice', { name: 'Board two', kind: 'mcp', url, auth: 'oauth' })
    const card = await cardOf(t.turnId)
    const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })
    expect(r.body.state).toBe('sign_in')
    const id = r.body.integrationId as string
    session('alice', 'cs-oauth-card')
    const ints = integrationsOf(h.ctx)
    const f = await ints.authorize({ id: 'alice', role: 'member' }, 'cs-oauth-card', id, 'https://team.example.test', 'en')
    const stored = () => h.ctx.db.query('SELECT status, secret_enc IS NOT NULL AS signed FROM integrations WHERE id = ?').get(id) as { status: string; signed: number } | null
    await held('/mcp-oauth', async (go) => {
      const signedIn = ints.callback(svc.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'cs-oauth-card' })
      // the sign-in is stored and its check waits for the service
      await waitFor(() => stored()?.signed === 1, { what: 'the sign-in is stored' })
      expect(stored()!.status).toBe('needs_auth')
      expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
      go()
      expect(await signedIn).toBe(true)
    })
    expect(stored()).toEqual({ status: 'connected', signed: 1 })
    expect(h.ctx.db.query("SELECT 1 FROM audit_log WHERE target = ? AND action = 'integration.delete'").get(id)).toBeNull()
    expect(resultOf(await doneOf(t.messageId)).skipped).toBe(true)
  })
})

describe('what a card may hold', () => {
  test('invisible or direction-changing characters in the name, notes or line: no card, and the field is named', async () => {
    const url = `${svc.base}/api/v1?card=hidden`
    // a hidden instruction in tag characters, a right-to-left override, a zero-width joiner inside a word
    const hidden = ['Tasks\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}', 'Tasks \u202Etxt.exe', 'Ta\u200Dsks']
    const calls = hidden.flatMap((v) => [
      { name: v, kind: 'http', url, auth: 'bearer' },
      { name: 'Tasks', kind: 'http', url, auth: 'bearer', notes: `GET /tasks lists them.\n${v}` },
      { name: 'Tasks', kind: 'http', url, auth: 'bearer', why: `to read ${v}` },
    ])
    const t = await start('alice', ...calls)
    const m = await doneOf(t.messageId)
    expect(cards(t.turnId)).toEqual([])
    for (const field of ['name', 'notes', 'why']) {
      const said = `No card: the ${field} contains invisible or direction-changing characters`
      expect(m.content.split(said).length - 1, field).toBe(3)
    }
    const events = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'connect_service'").all(t.turnId) as { summary: string }[]
    expect(events.map((e) => e.summary)).toEqual(Array(9).fill('connect_service -> no card (hidden text)'))
    expect(m.steps.filter((s) => s.tool === 'connect_service').every((s) => s.detail === 'Not connected')).toBe(true)
    expect(rowsAt(url)).toEqual([])
  })

  test('Korean, Japanese and emoji names, notes with line breaks and an address with a generated id: a card', async () => {
    const shown: { name: string; notes?: string }[] = []
    const cases = [
      { name: '네이버 웍스', kind: 'http', auth: 'bearer', notes: 'GET /tasks 할 일 목록\nPOST /tasks 할 일 추가' },
      { name: 'チャットワーク', kind: 'mcp', auth: 'none' },
      { name: '🎬 Higgsfield', kind: 'mcp', auth: 'none' },
      { name: '👩‍💻 Dev Tools', kind: 'mcp', auth: 'none' },
      { name: '❤️ Love API', kind: 'mcp', auth: 'none' },
    ]
    for (const [i, c] of cases.entries()) {
      // a generated instance id in the address is no key (the title check would hide it; the address check does not)
      const url = c.kind === 'http' ? `${svc.base}/api/v1?card=names${i}` : `${svc.base}/mcp-open?instance=a8F3k29dK3xQ7mZ1pL0vR5tY${i}`
      const t = await start('alice', { ...c, url })
      const card = await cardOf(t.turnId)
      shown.push({ name: card.name, ...(card.notes ? { notes: card.notes } : {}) })
      expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
      await doneOf(t.messageId)
    }
    expect(shown).toEqual(cases.map((c) => ({ name: c.name, ...(c.notes ? { notes: c.notes } : {}) })))
  })

  test('where the card is saved, its name and notes are checked again: an invisible character there is refused', async () => {
    const url = `${svc.base}/mcp-open?card=hidden-save`
    const t = await start('alice', { name: 'Plain', kind: 'mcp', url, auth: 'none' })
    const card = await cardOf(t.turnId)
    // the card the server keeps, which the connect saves, changed after the tool's check
    const kept = h.rt().execFor(t.turnId)!.openRequest(card.requestId) as { name: string }
    kept.name = 'Pla\u200Bin'
    const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe("The card's name or notes hold characters that cannot be seen. Ask the AI to connect it again.")
    expect(rowsAt(url)).toEqual([])
    await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })
    await doneOf(t.messageId)
  })
})

describe('another key on the same card follows the rules of now', () => {
  const keySent = (from: number) => svc.seen.slice(from).some((s) => s.headers.authorization === `Bearer ${MCP_KEY}`)

  test('personal connections turned off meanwhile: the next key and done are refused, and the key goes nowhere', async () => {
    const url = `${svc.base}/mcp-key?card=off-retry`
    const t = await start('alice', { name: 'Off tasks', kind: 'mcp', url, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    expect((await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })).body.state).toBe('retry')
    const was = h.ctx.db.query('SELECT status, secret_enc, version FROM integrations WHERE url = ?').get(url)
    h.ctx.db.query("UPDATE settings SET value='false' WHERE key='personalIntegrations'").run()
    try {
      const before = svc.seen.length
      const again = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
      expect(again.status).toBe(403)
      expect(again.body.error.message).toBe('Your team turned off adding personal connections.')
      expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).status).toBe(403)
      expect(keySent(before)).toBe(false)
      // the connection is as the wrong key left it
      expect(h.ctx.db.query('SELECT status, secret_enc, version FROM integrations WHERE url = ?').get(url)).toEqual(was)
    } finally {
      h.ctx.db.query("UPDATE settings SET value='true' WHERE key='personalIntegrations'").run()
    }
    await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })
    await doneOf(t.messageId)
    expect(leaksIn([t.turnId])).toEqual([])
  })

  test('the connection changed in Settings meanwhile: refused with a word to start again, nothing sent to it, and Not now leaves it', async () => {
    const url = `${svc.base}/mcp-key?card=edited`
    const t = await start('alice', { name: 'Edited tasks', kind: 'mcp', url, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    const first = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
    expect(first.body.state).toBe('retry')
    const id = first.body.integrationId as string
    // the person moves it to another address in Settings
    const moved = `${svc.base}/mcp-key?card=edited-moved`
    await h.api('alice').call(API.updateIntegration, { params: { id }, body: { url: moved } })
    const before = svc.seen.length
    const again = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toBe('This connection was changed or removed in Settings after the card was shown. Nothing was sent. Ask the AI to connect it again.')
    // still so for another key and for done; the key reached no address
    expect((await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })).status).toBe(409)
    expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).status).toBe(409)
    expect(keySent(before)).toBe(false)
    // Not now closes the card and leaves the connection the person changed
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
    expect(h.ctx.db.query('SELECT url FROM integrations WHERE id = ?').get(id)).toEqual({ url: moved })
    const r = resultOf(await doneOf(t.messageId))
    expect(r.skipped).toBe(true)
    expect(r.reason).toContain('changed or removed in Settings')
    expect(leaksIn([t.turnId])).toEqual([])
  })
})
