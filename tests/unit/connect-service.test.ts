// connect_service (server/src/chat/connect-service.ts, docs/INTEGRATIONS.md "Connecting from a chat"): the AI fills in
// a connection and the person finishes it on a card; the key goes from the card, sealed for 'integration.secret', to
// POST /api/turns/:id/connect and never reaches the AI. Real turns with the fake engine (tests/lib/b-fake-engine.ts):
// early answers without a card, the card's fields, a sealed key making a personal connection (a wrong one first: the
// same row gets the next key), a seal for another purpose, team connections for admins only, another person's turn,
// /answer refused for these cards, skip, timeout, sign-in then done, and a scheduled run. Every text the server let
// out or saved for these turns (answer, steps, audit lines, events, responses, rows, audit log, logs) is searched for
// the key and the sealed value; a failure says where, never the key.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, type SealedSecret, type SealPurpose } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { DRIVE_CONFIG, FakeGoogleDrive } from '../lib/fake-google-drive'
import { sealSecret } from '../../web/src/lib/seal'
import { createLogger } from '../../server/src/log'
import { credentialsOf } from '../../server/src/credentials/store'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { CONNECT_RULE } from '../../server/src/chat/prompt'

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
    if ([MCP_KEY, WRONG].some((k) => text.includes(k))) out.push(`${where}: a key`)
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
    )
    const m = await doneOf(t.messageId)
    expect(cards(t.turnId)).toEqual([])
    for (const words of ['a service needs url', 'an https address', 'private or office network', 'looks like it contains a key', 'Only an admin can add a team connection', 'already exists: "Open", connected', 'authHeader cannot carry a key', 'Google Drive is not set up'])
      expect(m.content, words).toContain(words)
    // the step never shows the key-looking notes, and says nothing was connected
    expect(m.steps.filter((s) => s.tool === 'connect_service').length).toBe(8)
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
