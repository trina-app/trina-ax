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
import { DRIVE_CONFIG, FakeGoogleDrive, membersMayConnect } from '../lib/fake-google-drive'
import { sealSecret } from '../../web/src/lib/seal'
import { createLogger } from '../../server/src/log'
import { credentialsOf } from '../../server/src/credentials/store'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { templatesOf } from '../../server/src/integrations/connections/templates'
import { activeUser } from '../../server/src/integrations/connections/store'
import { googleDriveOf } from '../../server/src/integrations/google-drive/oauth'
import { googleAppsOf } from '../../server/src/integrations/google-apps/service'
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
  h = await startHarness({ name: 'connect-service', askUserTimeoutMs: 6000, stallTimeoutMs: 60_000, log: createLogger({ level: 'debug', name: 'test', sink: (l) => logs.push(l) }) })
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
    for (const words of ['a service needs url', 'an https address', 'private or office network', 'the notes looks like it contains a key', 'Only an admin can add a team connection', 'own connection "Open" is already connected', 'authHeader cannot carry a key', 'Google Drive is not set up', 'the url looks like it contains a key'])
      expect(m.content, words).toContain(words)
    // every refusal says that no card was shown (AI scenario check CON-02: "I'll show a connect card" after a refusal)
    expect(m.content).toContain('and how it signs in). No card was shown.')
    expect(m.content).toContain('Google Drive is not set up for this team yet')
    expect(m.content).toContain('do not say a card is or will be shown')
    // the step never shows the key-looking notes, and says nothing was connected
    expect(m.steps.filter((s) => s.tool === 'connect_service').length).toBe(9)
    expect(m.content.includes('sk-live-4f9a8b7c6d5e4f3a2b1c') || JSON.stringify(m.steps).includes('sk-live')).toBe(false)
    const events = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'connect_service'").all(t.turnId) as { summary: string }[]
    expect(events.every((e) => e.summary.startsWith('connect_service -> no card ('))).toBe(true)
    expect(rowsAt(`${svc.base}/mcp-key`)).toEqual([])
  })

  // AI scenario CON-01.calendar (2026-11-17): the AI looked up Google's preview MCP address for Calendar, filled in an
  // unknown service there and cited "Calendar MCP server" pages. The four built-in Google apps answer by name instead.
  test('Gmail, Google Calendar (also by a Google API address or a Korean name): no card, their own page, ask nothing first', async () => {
    // alice (English app): the fake says each result before the next call, which a Korean app's answer keeps out as
    // interim narration (chat/narration.ts narrationScript, #329); the four results are what this test reads
    const t = await start('alice',
      { name: 'Google Calendar', kind: 'mcp', url: 'https://calendarmcp.googleapis.com/mcp/v1', auth: 'oauth' },
      { name: 'Gmail' },
      { name: '구글 캘린더' },
      { name: 'My mail', kind: 'mcp', url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'oauth' },
    )
    const m = await doneOf(t.messageId)
    expect(cards(t.turnId)).toEqual([])
    expect(m.content.split('one of the app\'s built-in Google apps: it connects on its own page').length - 1).toBe(4)
    expect(m.content).toContain('Google Calendar is one of')
    expect(m.content).toContain('Gmail is one of')
    expect(m.content).toContain('Ask nothing about the task until it is connected')
    expect(m.content).not.toMatch(/MCP server|a service needs url/)
    expect(rowsAt('https://calendarmcp.googleapis.com/mcp/v1')).toEqual([])
    const events = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'connect_service'").all(t.turnId) as { summary: string }[]
    expect(events.map((e) => e.summary)).toEqual(Array(4).fill('connect_service -> no card (google app)'))
  })

  test('personal connections off, the person\'s own connection works: it says it is not used, never that its tools are there (QA TC-2930)', async () => {
    const url = `${svc.base}/mcp-open?own=tc2930`
    const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Own board', url, auth: 'none', writePolicy: 'ask' } })
    expect(mine.status).toBe('connected')
    h.ctx.db.query("UPDATE settings SET value='false' WHERE key='personalIntegrations'").run()
    try {
      const t = await start('alice', { name: 'Board', kind: 'mcp', url, auth: 'none' }, { connection: mine.id, name: 'Own board' })
      const m = await doneOf(t.messageId)
      expect(cards(t.turnId)).toEqual([])
      expect(m.content).toContain('own connection "Own board" is not used in chats now: this team has turned off members\' own connections')
      expect(m.content.split('not used in chats now').length - 1).toBe(2)
      expect(m.content).not.toContain('is already connected')
      expect(m.content).not.toContain('Its tools are yours')
      expect(m.content).toContain('an admin')
      // the AI is not offered its tools either (store.ts usable)
      expect(integrationsOf(h.ctx).usable('alice').some((r) => r.id === mine.id)).toBe(false)
    } finally {
      h.ctx.db.query("UPDATE settings SET value='true' WHERE key='personalIntegrations'").run()
      await integrationsOf(h.ctx).remove(activeUser(h.ctx.db, 'alice')!, mine.id)
    }
  })

  test('personal connections off, the same address asked for again: the address path says it is not used (QA TC-2930)', async () => {
    const url = `${svc.base}/mcp-open?own=tc2930-address`
    const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Address board', url, auth: 'none', writePolicy: 'ask' } })
    expect(mine.status).toBe('connected')
    h.ctx.db.query("UPDATE settings SET value='false' WHERE key='personalIntegrations'").run()
    try {
      // only the address, no connection id: connect-service's working && offByTeam answer
      const t = await start('alice', { name: 'Board', kind: 'mcp', url, auth: 'none' })
      const m = await doneOf(t.messageId)
      expect(cards(t.turnId)).toEqual([])
      expect(m.content).toContain('own connection "Address board" is not used in chats now')
      expect(m.content).not.toContain('is already connected')
      expect(m.content).not.toContain('Its tools are yours')
      expect(rowsAt(url)).toHaveLength(1)
      const ev = h.ctx.db.query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'connect_service'").all(t.turnId) as { summary: string }[]
      expect(ev.map((e) => e.summary)).toEqual(['connect_service -> no card (personal connections off)'])
    } finally {
      h.ctx.db.query("UPDATE settings SET value='true' WHERE key='personalIntegrations'").run()
      await integrationsOf(h.ctx).remove(activeUser(h.ctx.db, 'alice')!, mine.id)
    }
  })

  test('personal connections off, Drive already connected: answers only', async () => {
    h.ctx.db.query("UPDATE settings SET value='false' WHERE key='personalIntegrations'").run()
    const drive = new FakeGoogleDrive()
    const d = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: drive.fetch }); membersMayConnect(h.ctx.db)
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
    const f = await ints.authorize({ id: 'alice', role: 'member' }, 'cs-oauth', r.body.integrationId, 'https://team.example.test', 'en') as { authorizationUrl: string }
    expect(await ints.callback(svc.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'cs-oauth' })).toEqual({ ok: true })
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
    const d = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: drive.fetch }); membersMayConnect(h.ctx.db)
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
    const f = await ints.authorize({ id: 'alice', role: 'member' }, 'cs-oauth-card', id, 'https://team.example.test', 'en') as { authorizationUrl: string }
    const stored = () => h.ctx.db.query('SELECT status, secret_enc IS NOT NULL AS signed FROM integrations WHERE id = ?').get(id) as { status: string; signed: number } | null
    await held('/mcp-oauth', async (go) => {
      const signedIn = ints.callback(svc.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'cs-oauth-card' })
      // the sign-in is stored and its check waits for the service
      await waitFor(() => stored()?.signed === 1, { what: 'the sign-in is stored' })
      expect(stored()!.status).toBe('needs_auth')
      expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
      go()
      expect(await signedIn).toEqual({ ok: true })
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
      { name: '🎬 Videostudio', kind: 'mcp', auth: 'none' },
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

  test('Not now after only the key was replaced in Settings (its check failed too): that connection and its key stay', async () => {
    const url = `${svc.base}/mcp-key?card=key-in-settings`
    const t = await start('alice', { name: 'Key in Settings', kind: 'mcp', url, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    const first = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
    expect(first.body.state).toBe('retry')
    const id = first.body.integrationId as string
    // the person pastes another key in Settings (same address); the service still refuses it
    await h.api('alice').call(API.updateIntegration, { params: { id }, body: { secret: `${WRONG}-settings` } })
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
    expect(rowsAt(url).map((r) => r.id)).toEqual([id])
    const r = resultOf(await doneOf(t.messageId))
    expect(r.skipped).toBe(true)
    expect(r.reason).toContain('changed or removed in Settings › Connectors or Admin')
  })

  test('the card\'s time runs out after its connection was moved in Settings with a working key: the AI is told it changed, not connected', async () => {
    await withCardTime(4000, async () => {
      const url = `${svc.base}/mcp-key?card=moved-then-timeout`
      const t = await start('alice', { name: 'Moved then timed out', kind: 'mcp', url, auth: 'bearer' })
      const card = await cardOf(t.turnId)
      const first = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
      expect(first.body.state).toBe('retry')
      const id = first.body.integrationId as string
      const moved = `${svc.base}/mcp-key?card=moved-then-timeout-2`
      await h.api('alice').call(API.updateIntegration, { params: { id }, body: { url: moved, secret: MCP_KEY } })
      expect(h.ctx.db.query('SELECT status FROM integrations WHERE id = ?').get(id)).toEqual({ status: 'connected' })
      const r = resultOf(await doneOf(t.messageId))
      expect(r.connected).toBeUndefined()
      expect(r.skipped).toBe(true)
      expect(r.reason).toContain('changed or removed in Settings › Connectors or Admin')
    })
  })

  test('the card\'s time runs out after its connection was deleted in Settings: the AI is told so', async () => {
    await withCardTime(4000, async () => {
      const url = `${svc.base}/mcp-key?card=deleted-then-timeout`
      const t = await start('alice', { name: 'Deleted then timed out', kind: 'mcp', url, auth: 'bearer' })
      const card = await cardOf(t.turnId)
      const first = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
      await h.api('alice').call(API.deleteIntegration, { params: { id: first.body.integrationId as string } })
      const r = resultOf(await doneOf(t.messageId))
      expect(r.skipped).toBe(true)
      expect(r.reason).toContain('changed or removed in Settings › Connectors or Admin')
    })
  })

  test('Not now right after the connection was changed in Settings (no retry between): the changed one stays, and the AI is told it changed', async () => {
    const url = `${svc.base}/mcp-key?card=edited-then-not-now`
    const t = await start('alice', { name: 'Edited then skipped', kind: 'mcp', url, auth: 'bearer' })
    const card = await cardOf(t.turnId)
    const first = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(WRONG) })
    expect(first.body.state).toBe('retry')
    const id = first.body.integrationId as string
    const moved = `${svc.base}/mcp-key?card=edited-then-not-now-moved`
    await h.api('alice').call(API.updateIntegration, { params: { id }, body: { url: moved } })
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
    expect(h.ctx.db.query('SELECT url FROM integrations WHERE id = ?').get(id)).toEqual({ url: moved })
    const r = resultOf(await doneOf(t.messageId))
    expect(r.skipped).toBe(true)
    expect(r.reason).toContain('changed or removed in Settings › Connectors or Admin')
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
    expect(again.body.error.message).toBe('This connection was changed or removed in Settings › Connectors or Admin after the card was shown. Nothing was sent. Ask the AI to connect it again.')
    // still so for another key and for done; the key reached no address
    expect((await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })).status).toBe(409)
    expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).status).toBe(409)
    expect(keySent(before)).toBe(false)
    // Not now closes the card and leaves the connection the person changed
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
    expect(h.ctx.db.query('SELECT url FROM integrations WHERE id = ?').get(id)).toEqual({ url: moved })
    const r = resultOf(await doneOf(t.messageId))
    expect(r.skipped).toBe(true)
    expect(r.reason).toContain('changed or removed in Settings › Connectors or Admin')
    expect(leaksIn([t.turnId])).toEqual([])
  })
})

// QA TC-127: the person's own connection whose sign-in or key stopped working gets the same card in the chat as a team
// template, for that connection (never a second one), named by its id or found by its address
describe('signing in again to one\'s own connection', () => {
  test('named by its id: the card signs in to that connection, done connects it, and no second connection is made', async () => {
    const url = `${svc.base}/mcp-oauth?card=again`
    const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Board again', url, auth: 'oauth', writePolicy: 'ask' } })
    expect(mine.status).toBe('needs_auth')
    // the AI's list of connections tells it how
    const { integrationToolProvider } = await import('../../server/src/integrations/connections/tools')
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const prompt = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: chat.id, turnId: 'none', browser: false, scheduled: false }).prompt ?? ''
    expect(prompt).toContain(`call connect_service with connection "${mine.id}" and name "Board again"`)
    const t = await start('alice', { name: 'Board again', connection: mine.id })
    const card = await cardOf(t.turnId)
    expect(card).toMatchObject({ kind: 'connect_service', target: 'service', name: 'Board again', scope: 'personal', reconnect: true, service: { url, auth: 'oauth' } })
    const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })
    expect(r.body).toMatchObject({ state: 'sign_in', integrationId: mine.id })
    session('alice', 'cs-again')
    const ints = integrationsOf(h.ctx)
    const f = await ints.authorize({ id: 'alice', role: 'member' }, 'cs-again', mine.id, 'https://team.example.test', 'en') as { authorizationUrl: string }
    expect(await ints.callback(svc.authorize(f.authorizationUrl), { userId: 'alice', sessionId: 'cs-again' })).toEqual({ ok: true })
    expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body).toMatchObject({ state: 'connected', integrationId: mine.id })
    expect(resultOf(await doneOf(t.messageId))).toMatchObject({ connected: true, name: 'Board again', status: 'connected' })
    expect(rowsAt(url)).toEqual([{ id: mine.id, scope: 'personal', owner_user_id: 'alice', status: 'connected' }])
  })

  test('found by its address (the AI filled it in): a card for that connection, not "already exists"; Not now leaves it', async () => {
    const url = `${svc.base}/mcp-oauth?card=again-by-address`
    const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Issue board', url, auth: 'oauth', writePolicy: 'ask' } })
    const t = await start('alice', { name: 'Issue board', kind: 'mcp', url, auth: 'oauth', why: 'find my issues' })
    const card = await cardOf(t.turnId)
    expect(card).toMatchObject({ reconnect: true, name: 'Issue board', why: 'find my issues', service: { url } })
    expect((await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
    expect(resultOf(await doneOf(t.messageId)).skipped).toBe(true)
    expect(rowsAt(url)).toEqual([{ id: mine.id, scope: 'personal', owner_user_id: 'alice', status: 'needs_auth' }])
  })

  test('a key that stopped working: the card takes a new key for the same connection; nothing holds the key', async () => {
    const url = `${svc.base}/mcp-key?card=again-key`
    const mine = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Keyed tasks', url, auth: 'bearer', secret: WRONG, writePolicy: 'ask' } })
    expect(mine.status).not.toBe('connected')
    const t = await start('alice', { name: 'Keyed tasks', connection: mine.id })
    const card = await cardOf(t.turnId)
    expect(card).toMatchObject({ reconnect: true, service: { url, auth: 'bearer' } })
    const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
    expect(r.body).toMatchObject({ state: 'connected', integrationId: mine.id })
    expect(resultOf(await doneOf(t.messageId))).toMatchObject({ connected: true, name: 'Keyed tasks' })
    expect(rowsAt(url).map((x) => x.id)).toEqual([mine.id])
    expect(leaksIn([t.turnId])).toEqual([])
  })

  test('someone else\'s connection, one that works and an unknown id: no card, said why', async () => {
    const bobs = await h.api('bob').call(API.createIntegration, { body: { kind: 'mcp', name: 'Bob board', url: `${svc.base}/mcp-oauth?card=bob`, auth: 'oauth', writePolicy: 'ask' } })
    const works = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Works', url: `${svc.base}/mcp-open?card=works`, auth: 'none', writePolicy: 'ask' } })
    const t = await start('alice', { name: 'Bob board', connection: bobs.id }, { name: 'Works', connection: works.id }, { name: 'None', connection: 'nope' })
    const m = await doneOf(t.messageId)
    expect(cards(t.turnId)).toEqual([])
    expect(m.content.split('there is no such connection of this person').length - 1).toBe(2)
    expect(m.content).toContain('"Works" does not need a new sign-in or key now')
  })
})

describe('a service in the app\'s list (QA TC-135; editions: owner decision 2026-11-12)', () => {
  const made = 'https://notion-mcp.example.com/mcp'
  test('a listed name, a look-alike or a local name at another address: an unknown service named by its host, at the address given', async () => {
    const cases = [
      { name: 'Notion', url: made },
      { name: 'Notion workspace', url: made },
      { name: 'N\u043etion', url: made },
      { name: '노션', url: made },
      { name: 'Acme GitLab', url: 'https://gitlab.acme.com/api/v4/mcp' },
      { name: 'GitLab', url: 'https://gitlab.acme.com/api/v4/mcp' },
    ]
    for (const c of cases) {
      const t = await start('erin', { ...c, kind: 'mcp', auth: 'oauth' })
      const card = await cardOf(t.turnId)
      const host = new URL(c.url).host
      expect(card, c.name).toMatchObject({ name: host, service: { kind: 'mcp', url: c.url, host, auth: 'oauth' } })
      // the card says whose official address this is not, and which one is (QA TC-135 retest)
      const claimed = c.url === made ? { name: 'Notion', url: 'https://mcp.notion.com/mcp' } : { name: 'GitLab', url: 'https://gitlab.com/api/v4/mcp' }
      expect(card.notOfficial, c.name).toEqual(claimed)
      const { notOfficial: _, ...rest } = card
      expect(JSON.stringify(rest)).not.toMatch(/"name":"(Notion|GitLab)/)
      // the step line above the card names the host too, while the card is open and after
      const live = published.filter((p) => p.ev.type === 'message.step' && p.ev.data.messageId === t.messageId && p.ev.data.step.tool === 'connect_service').map((p) => p.ev.data.step.label as string)
      expect(live.at(-1), c.name).toEndWith(` · ${host}`)
      await post('erin', t.turnId, { action: 'skip', requestId: card.requestId })
      const m = await doneOf(t.messageId)
      expect(stepOf(m).label, c.name).toEndWith(` · ${host}`)
      expect(stepOf(m).label).not.toMatch(/Notion|GitLab|노션|N\u043etion/)
      const r = resultOf(m)
      expect(r).toMatchObject({ skipped: true })
      expect(r.note).toBeUndefined()
    }
    expect(rowsAt(made)).toEqual([])
  })

  test('the official address under any name, or a listed name at its official host: the list\'s address, name and sign-in', async () => {
    const t = await start('erin',
      { name: 'Team wiki', kind: 'mcp', url: 'https://mcp.notion.com/mcp/', auth: 'bearer' },
      { name: 'Notion', kind: 'mcp', url: 'https://mcp.notion.com/other?x=1', auth: 'bearer' },
    )
    const first = await cardOf(t.turnId)
    expect(first).toMatchObject({ name: 'Notion', service: { url: 'https://mcp.notion.com/mcp', host: 'mcp.notion.com', auth: 'oauth', authHeader: null } })
    await post('erin', t.turnId, { action: 'skip', requestId: first.requestId })
    const second = await waitFor(() => cards(t.turnId)[1], { timeoutMs: 20_000, what: 'second card' })
    expect(second).toMatchObject({ name: 'Notion', service: { url: 'https://mcp.notion.com/mcp', auth: 'oauth' } })
    await post('erin', t.turnId, { action: 'skip', requestId: second.requestId })
    const m = await doneOf(t.messageId)
    expect(m.content).toContain("not Notion's official address and was not used")
  })

  test('an ordinary word that is a listed service\'s name is not that service inside a longer name', async () => {
    const url = `${svc.base}/mcp-open?sqft=1`
    const t = await start('erin', { name: 'Square Feet API', kind: 'mcp', url, auth: 'none' })
    const card = await cardOf(t.turnId)
    expect(card).toMatchObject({ name: 'Square Feet API', service: { url } })
    await post('erin', t.turnId, { action: 'skip', requestId: card.requestId })
    await doneOf(t.messageId)
  })
})

describe('the step line of a template card (review of #597)', () => {
  test('the AI names a template "Notion": the step says the verb alone while the card is open, then the template\'s own name', async () => {
    const carol = activeUser(h.ctx.db, 'carol')!
    const tpl = templatesOf(h.ctx).create(carol, { kind: 'mcp', name: 'Acme Wiki', url: `${svc.base}/mcp-key`, auth: 'bearer', access: { everyone: false, groups: [], users: ['alice'] } }, 'en')
    try {
      const t = await start('alice', { template: tpl.id, name: 'Notion' })
      const card = await cardOf(t.turnId)
      expect(card).toMatchObject({ name: 'Acme Wiki', template: { id: tpl.id } })
      const live = published.filter((p) => p.ev.type === 'message.step' && p.ev.data.messageId === t.messageId && p.ev.data.step.tool === 'connect_service').map((p) => p.ev.data.step.label as string)
      expect(live.length).toBeGreaterThan(0)
      for (const l of live) expect(l).not.toContain('Notion')
      expect(live.at(-1)).toBe('Connect service')
      await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })
      const m = await doneOf(t.messageId)
      expect(stepOf(m).label).toBe('Connect service · Acme Wiki')
    } finally {
      await templatesOf(h.ctx).remove(carol, tpl.id)
    }
  })
})

describe('look-alike names, mixed alphabets and connections saved before the list\'s rule (fix/catalog-lookalikes)', () => {
  test('Greek capitals and a mixed-alphabet name that imitates nothing listed: titled by the host', async () => {
    const made = 'https://notion-mcp.example.com/mcp'
    for (const name of ['\u039d\u039f\u03a4\u0399\u039f\u039d', 'Ac\u043ce Tools', 'N\u0585tion']) {
      const t = await start('erin', { name, kind: 'mcp', url: made, auth: 'oauth' })
      const card = await cardOf(t.turnId)
      expect(card, name).toMatchObject({ name: 'notion-mcp.example.com', service: { url: made } })
      await post('erin', t.turnId, { action: 'skip', requestId: card.requestId })
      await doneOf(t.messageId)
    }
  })

  test('a reconnect card for a connection saved as "Notion" at another address: titled by its host; the saved name stays', async () => {
    const url = `${svc.base}/mcp-key?saved=notion`
    const mine = await h.api('erin').call(API.createIntegration, { body: { kind: 'mcp', name: 'Notion', url, auth: 'bearer', secret: WRONG, writePolicy: 'ask' } })
    try {
      expect(mine.status).not.toBe('connected')
      const t = await start('erin', { name: 'Notion', kind: 'mcp', url, auth: 'bearer' })
      const card = await cardOf(t.turnId)
      expect(card).toMatchObject({ reconnect: true, name: new URL(url).host, service: { url } })
      expect(card.notOfficial).toEqual({ name: 'Notion', url: 'https://mcp.notion.com/mcp' })
      const r = await post('erin', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
      expect(r.body).toMatchObject({ state: 'connected', integrationId: mine.id })
      await doneOf(t.messageId)
      expect((h.ctx.db.query('SELECT name FROM integrations WHERE id = ?').get(mine.id) as { name: string }).name).toBe('Notion')
    } finally {
      await integrationsOf(h.ctx).remove(activeUser(h.ctx.db, 'erin')!, mine.id)
    }
  })
})

describe('a team connection limited to other people is never named to the caller (review of #582)', () => {
  test('a member\'s team request is refused before anything is looked up; a personal one does not see it; an admin outside it is told without its name', async () => {
    const url = `${svc.base}/mcp-open?finance=1`
    const carol = activeUser(h.ctx.db, 'carol')!
    const team = await integrationsOf(h.ctx).create(carol, { kind: 'mcp', name: 'Finance board', url, auth: 'none', writePolicy: 'ask', access: { everyone: false, groups: [], users: ['dana'] } }, 'team', 'en')
    try {
      expect(team.status).toBe('connected')
      const t = await start('erin', { name: 'Board', kind: 'mcp', url, auth: 'none', scope: 'team' })
      const m = await doneOf(t.messageId)
      expect(cards(t.turnId)).toEqual([])
      expect(m.content).toContain('Only an admin can add a team connection')
      expect(m.content).not.toContain('Finance')
      expect(m.content).not.toContain('already')
      // a personal request: the team connection is not hers, so she gets a card for her own, and its name never shows
      const p = await start('erin', { name: 'Board', kind: 'mcp', url, auth: 'none' })
      const card = await cardOf(p.turnId)
      expect(card).toMatchObject({ name: 'Board', scope: 'personal' })
      await post('erin', p.turnId, { action: 'skip', requestId: card.requestId })
      expect((await doneOf(p.messageId)).content).not.toContain('Finance')
      // an admin who may not use it: told it exists, never its name, never "its tools are yours"
      const c = await start('carol', { name: 'Board', kind: 'mcp', url, auth: 'none', scope: 'team' })
      const cm2 = await doneOf(c.messageId)
      expect(cards(c.turnId)).toEqual([])
      expect(cm2.content).toContain('not among the people who may use it')
      expect(cm2.content).not.toContain('Finance')
      expect(cm2.content).not.toContain('tools are yours')
    } finally {
      await integrationsOf(h.ctx).remove(carol, team.id)
    }
  })
})

describe('a service the person already has (QA bug 2)', () => {
  test('their own connection needs a new key and a team template has the same address: the card is for their connection, never a second one', async () => {
    const url = `${svc.base}/mcp-key`
    const mine = await h.api('erin').call(API.createIntegration, { body: { kind: 'mcp', name: 'Tasks', url, auth: 'bearer', secret: WRONG, writePolicy: 'ask' } })
    expect(mine.status).not.toBe('connected')
    const carol = activeUser(h.ctx.db, 'carol')!
    const tpl = templatesOf(h.ctx).create(carol, { kind: 'mcp', name: 'Team tasks', url, auth: 'bearer', access: { everyone: false, groups: [], users: ['erin'] } }, 'en')
    const erinRows = () => rowsAt(url).filter((x) => x.owner_user_id === 'erin')
    try {
      // Not now on that card: their connection stays as it was
      const first = await start('erin', { name: 'Tasks', kind: 'mcp', url, auth: 'bearer' })
      const c1 = await cardOf(first.turnId)
      expect(c1.template).toBeUndefined()
      expect(c1).toMatchObject({ reconnect: true, name: 'Tasks', scope: 'personal', service: { url, auth: 'bearer' } })
      await post('erin', first.turnId, { action: 'skip', requestId: c1.requestId })
      await doneOf(first.messageId)
      expect(erinRows().map((x) => x.id)).toEqual([mine.id])
      // a new key on the next card fixes that same connection
      const t = await start('erin', { name: 'Tasks', kind: 'mcp', url, auth: 'bearer' })
      const card = await cardOf(t.turnId)
      expect(card).toMatchObject({ reconnect: true })
      const r = await post('erin', t.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
      expect(r.body).toMatchObject({ state: 'connected', integrationId: mine.id })
      expect(resultOf(await doneOf(t.messageId))).toMatchObject({ connected: true, name: 'Tasks' })
      expect(erinRows()).toEqual([{ id: mine.id, scope: 'personal', owner_user_id: 'erin', status: 'connected' }])
      expect(h.ctx.db.query('SELECT COUNT(*) AS n FROM integrations WHERE template_id = ?').get(tpl.id)).toEqual({ n: 0 })
      // asked again while it works: no card, and it says so
      const again = await start('erin', { name: 'Tasks', kind: 'mcp', url, auth: 'bearer' })
      const m = await doneOf(again.messageId)
      expect(cards(again.turnId)).toEqual([])
      expect(m.content).toContain('own connection "Tasks" is already connected to this service')
    } finally {
      await templatesOf(h.ctx).remove(carol, tpl.id)
      await integrationsOf(h.ctx).remove(activeUser(h.ctx.db, 'erin')!, mine.id)
    }
  })

  test('a working team connection to the same service: no card, it is already connected', async () => {
    const url = `${svc.base}/mcp-open?everyone=bug2`
    const carol = activeUser(h.ctx.db, 'carol')!
    const team = await integrationsOf(h.ctx).create(carol, { kind: 'mcp', name: 'Team board', url, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } }, 'team', 'en')
    try {
      expect(team.status).toBe('connected')
      const t = await start('erin', { name: 'Board', kind: 'mcp', url, auth: 'none' })
      const m = await doneOf(t.messageId)
      expect(cards(t.turnId)).toEqual([])
      expect(m.content).toContain('A team connection, "Team board", is already connected')
      expect(rowsAt(url), JSON.stringify(rowsAt(url))).toHaveLength(1)
    } finally {
      await integrationsOf(h.ctx).remove(carol, team.id)
    }
  })
})

describe('connections waiting for their first sign-in never block the card (QA TC-3048)', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  /** one of alice's own connections, made `age` ms ago; secret null: waiting for its first sign-in */
  const insert = (id: string, auth: string, secret: string | null, age: number) => h.ctx.db.query(`INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, secret_enc, created_at, updated_at)
    VALUES (?, 'personal', 'alice', 'alice', 'mcp', ?, ?, ?, ?, 'needs_auth', ?, ?, ?)`).run(id, id, id, `${svc.base}/mcp-oauth?tc3048=${id}`, auth, secret, ago(age), ago(age))
  /** a refused sign-in try of that connection, `age` ms ago */
  const tried = (id: string, age: number) => h.ctx.db.query(`INSERT INTO integration_oauth_flows (id, integration_id, integration_version, user_id, session_id, state_hash, state, secret_enc, key_version, reason, expires_at, created_at)
    VALUES (?, ?, 1, 'alice', 'tc3048', ?, 'failed', NULL, 1, 'refused', ?, ?)`).run(`flow-${id}`, id, `hash-${id}`, ago(age), ago(age))
  const clean = () => h.ctx.db.query("DELETE FROM integrations WHERE id LIKE 'tc3048-%' OR url LIKE '%tc3048%'").run()
  const id = (p: string, i: number) => `tc3048-${p}${String(i).padStart(2, '0')}`

  test('20 waiting: the card is shown and its Connect replaces the oldest; all tried in the last hour: no card, said why', async () => {
    clean()
    session('alice', 'tc3048')
    try {
      for (let i = 0; i < 20; i++) { insert(id('w', i), 'oauth', null, (30 - i) * 3600_000); tried(id('w', i), (30 - i) * 3600_000) }
      const url = `${svc.base}/mcp-oauth?tc3048=new`
      const t = await start('alice', { name: 'Board', kind: 'mcp', url, auth: 'oauth' })
      const card = await cardOf(t.turnId)
      const r = await post('alice', t.turnId, { action: 'connect', requestId: card.requestId })
      expect(r.body).toMatchObject({ state: 'sign_in', status: 'needs_auth' })
      expect(rowsAt(url).length).toBe(1)
      // the oldest is gone, with its flow; the others stay
      expect(h.ctx.db.query('SELECT 1 FROM integrations WHERE id = ?').get(id('w', 0))).toBeNull()
      expect(h.ctx.db.query('SELECT 1 FROM integration_oauth_flows WHERE id = ?').get(`flow-${id('w', 0)}`)).toBeNull()
      // (alice may have waiting ones from earlier tests too: those are older and went first when there were)
      expect(h.ctx.db.query('SELECT 1 FROM integrations WHERE id = ?').get(id('w', 19))).not.toBeNull()
      expect((h.ctx.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'personal' AND owner_user_id = 'alice' AND template_id IS NULL AND google_app IS NULL AND auth = 'oauth' AND secret_enc IS NULL").get() as { n: number }).n).toBe(20)
      await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })
      await doneOf(t.messageId)
      // every waiting one tried within the hour: none may go, no card
      clean()
      for (let i = 0; i < 20; i++) insert(id('r', i), 'oauth', null, 7200_000)
      // every waiting one of alice's, earlier tests' too
      for (const w of h.ctx.db.query("SELECT id FROM integrations WHERE scope = 'personal' AND owner_user_id = 'alice' AND auth = 'oauth' AND secret_enc IS NULL").all() as { id: string }[]) tried(w.id, 600_000)
      const t2 = await start('alice', { name: 'Board', kind: 'mcp', url, auth: 'oauth' })
      const m = await doneOf(t2.messageId)
      expect(cards(t2.turnId)).toEqual([])
      expect(m.content).toContain('still waiting for their first sign-in')
      // a key connection is never held up by waiting ones
      const t3 = await start('alice', { name: 'Keyed', kind: 'mcp', url: `${svc.base}/mcp-key?tc3048=key`, auth: 'bearer' })
      const keyed = await cardOf(t3.turnId)
      await post('alice', t3.turnId, { action: 'skip', requestId: keyed.requestId })
      await doneOf(t3.messageId)
    } finally { clean() }
  })

  test('20 working: no card, and the answer says working connections', async () => {
    clean()
    try {
      const own = h.ctx.db.query("SELECT count(*) AS n FROM integrations WHERE scope = 'personal' AND owner_user_id = 'alice' AND template_id IS NULL AND google_app IS NULL AND NOT (auth = 'oauth' AND secret_enc IS NULL)").get() as { n: number }
      for (let i = own.n; i < 20; i++) insert(id('s', i), 'oauth', 'sealed', 3600_000)
      const t = await start('alice', { name: 'Board', kind: 'mcp', url: `${svc.base}/mcp-oauth?tc3048=new`, auth: 'oauth' })
      const m = await doneOf(t.messageId)
      expect(cards(t.turnId)).toEqual([])
      expect(m.content).toContain('20 working personal connections')
    } finally { clean() }
  })
})

// #253 (docs/CONNECTIONS.md mismatch 8): onboarding and Admin › Connected apps connect Google for the whole team; the
// chat card offers the same to an owner or admin (teamOffer: the web card opens the very same dialog), never to a
// member, and a team connection a member may use already counts as connected (as on the My setup card).
describe('Google for the team from a chat (#253)', () => {
  /** a Drive an admin shares with the team, working, for `who` ('everyone' or one person) */
  function share(id: string, owner: string, who: string, key: string) {
    const now = new Date().toISOString()
    h.ctx.db.query("INSERT INTO drive_team_shares (id, name, owner_user_id, config_key, account, scopes, secret_enc, key_version, folders, status, version, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', 'drive.readonly', 'sealed', 1, '[]', 'connected', 1, '2099-01-01', ?, ?)").run(id, `Sales ${id}`, owner, key, now, now)
    h.ctx.db.query('INSERT INTO drive_team_share_access (share_id, subject_type, subject_id) VALUES (?, ?, ?)').run(id, who === 'everyone' ? 'everyone' : 'user', who === 'everyone' ? '' : who)
  }
  const dropShares = () => { h.ctx.db.query('DELETE FROM drive_team_share_access').run(); h.ctx.db.query('DELETE FROM drive_team_shares').run() }
  async function withDrive(fn: (key: string) => Promise<void>) {
    const d = googleDriveOf(h.ctx, { config: DRIVE_CONFIG, fetch: new FakeGoogleDrive().fetch }); membersMayConnect(h.ctx.db)
    try { await fn(d.key) } finally { dropShares(); googleDriveOf(h.ctx, { config: null }) }
  }

  test('Drive: an owner or admin gets Connect for the team on the card, a member only their own', async () => {
    await withDrive(async () => {
      for (const [who, team] of [['carol', true], ['dana', true], ['alice', false]] as const) {
        const t = await start(who, { name: 'Google Drive', target: 'google_drive' })
        const card = await cardOf(t.turnId)
        expect(card).toMatchObject({ target: 'google_drive', name: 'Google Drive', scope: 'personal' })
        expect(card.teamOffer).toBe(team ? true : undefined)
        expect((await post(who, t.turnId, { action: 'skip', requestId: card.requestId })).body).toEqual({ state: 'skipped' })
        await doneOf(t.messageId)
      }
    })
  })

  test('Drive: a member a team share covers is connected, no card and nothing to connect', async () => {
    await withDrive(async (key) => {
      share('s-all', 'carol', 'everyone', key)
      const t = await start('alice', { name: 'Google Drive', target: 'google_drive' })
      const m = await doneOf(t.messageId)
      expect(cards(t.turnId)).toEqual([])
      expect(m.content).toContain('Google Drive is connected for this person through a Drive the team shares with them ("Sales s-all"')
      expect(m.content).toContain('Do not ask them to connect it')
      expect(stepOf(m).detail).toBe('Connected')
      // a share for someone else is not theirs: the card as before
      dropShares()
      share('s-bob', 'carol', 'bob', key)
      const t2 = await start('alice', { name: 'Google Drive', target: 'google_drive' })
      const card = await cardOf(t2.turnId)
      expect(card.teamOffer).toBeUndefined()
      await post('alice', t2.turnId, { action: 'skip', requestId: card.requestId })
      await doneOf(t2.messageId)
    })
  })

  test('Drive: after Connect for the team, done is connected; a share that leaves the admin out is "for the team", only for an admin', async () => {
    await withDrive(async (key) => {
      const t = await start('carol', { name: 'Google Drive', target: 'google_drive' })
      const card = await cardOf(t.turnId)
      expect((await post('carol', t.turnId, { action: 'done', requestId: card.requestId })).body.state).toBe('retry')
      // the dialog shared a Drive with Alice only
      share('s-alice', 'carol', 'alice', key)
      // the role is read again: no longer an admin, a share that leaves them out is nothing of theirs
      h.ctx.db.query("UPDATE users SET role = 'member' WHERE id = 'carol'").run()
      try { expect((await post('carol', t.turnId, { action: 'done', requestId: card.requestId })).body.state).toBe('retry') }
      finally { h.ctx.db.query("UPDATE users SET role = 'admin' WHERE id = 'carol'").run() }
      expect((await post('carol', t.turnId, { action: 'done', requestId: card.requestId })).body).toEqual({ state: 'connected' })
      const m = await doneOf(t.messageId)
      expect(resultOf(m)).toMatchObject({ connected: true, name: 'Google Drive', status: 'connected for the team' })
      expect(resultOf(m).note).toContain('this person is not among the people who may use it')
      expect(stepOf(m).detail).toBe('연결됨') // Carol reads Korean
      // one for everyone: the owner is covered, connected without a card
      share('s-all', 'carol', 'everyone', key)
      const t2 = await start('dana', { name: 'Google Drive', target: 'google_drive' })
      const m2 = await doneOf(t2.messageId)
      expect(cards(t2.turnId)).toEqual([])
      expect(m2.content).toContain('through a Drive the team shares with them')
    })
  })

  /** Gmail as this server sees it for the test: set up (reason null), the person's own and the team's account as given */
  async function withGmail(state: { own?: 'connected'; down?: boolean; shared?: 'connected' | 'needs_reconnect'; team?: 'connected' }, fn: () => Promise<void>) {
    const g = googleAppsOf(h.ctx)
    const view = g.view.bind(g), admin = g.adminStatus.bind(g)
    g.view = (user, app) => {
      const v = view(user, app)
      return app !== 'gmail' ? v : { ...v, available: true, reason: null, status: state.own ?? 'disconnected', serviceDown: !!state.down, shared: state.shared ? { id: 'team-gmail', account: { name: null, email: 'team@acme.example' }, status: state.shared, alwaysAllowed: false } : null }
    }
    g.adminStatus = (app) => {
      const a = admin(app)
      return app !== 'gmail' || !state.team ? a : { ...a, configured: true, team: { id: 'team-gmail', status: state.team, account: { name: null, email: 'team@acme.example' }, access: { everyone: false, groups: [], users: ['alice'] }, usedBy: 1, connectedBy: null, connectedAt: new Date().toISOString() } }
    }
    try { await fn() } finally { g.view = view; g.adminStatus = admin }
  }

  test('Gmail: an owner or admin gets a card for the team or their own; a member a card with their own only (TC-8034)', async () => {
    await withGmail({}, async () => {
      const t = await start('carol', { name: 'Gmail', why: 'to send the invoice' })
      const card = await cardOf(t.turnId)
      expect(card).toMatchObject({ target: 'google_app', googleApp: 'gmail', name: 'Gmail', scope: 'personal', teamOffer: true, why: 'to send the invoice' })
      expect(card.service).toBeUndefined()
      // nothing goes through the card itself: its own page, or the team's dialog, then done
      expect((await post('carol', t.turnId, { action: 'connect', requestId: card.requestId })).status).toBe(400)
      expect((await post('carol', t.turnId, { action: 'done', requestId: card.requestId })).body.state).toBe('retry')
      await post('carol', t.turnId, { action: 'skip', requestId: card.requestId })
      expect(resultOf(await doneOf(t.messageId))).toEqual({ skipped: true })
      const m = await start('alice', { name: 'Gmail', why: 'to read the invoice' })
      const own = await cardOf(m.turnId)
      expect(own).toMatchObject({ target: 'google_app', googleApp: 'gmail', name: 'Gmail', scope: 'personal', why: 'to read the invoice' })
      expect(own.teamOffer).toBeUndefined()
      expect(own.service).toBeUndefined()
      // the card connects nothing itself, and "done" before the sign-in says so and keeps the card
      expect((await post('alice', m.turnId, { action: 'connect', requestId: own.requestId })).status).toBe(400)
      expect((await post('alice', m.turnId, { action: 'done', requestId: own.requestId })).body.state).toBe('retry')
      await post('alice', m.turnId, { action: 'skip', requestId: own.requestId })
      expect(resultOf(await doneOf(m.messageId))).toEqual({ skipped: true })
    })
  })

  test('Gmail, a member: a team connection made while the card is open is never "connected" through the admin read', async () => {
    const state: { team?: 'connected' } = {}
    await withGmail(state, async () => {
      const t = await start('alice', { name: 'Gmail' })
      const card = await cardOf(t.turnId)
      // a team account that does not include Alice: nothing of hers, and she is not told about it
      state.team = 'connected'
      expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body.state).toBe('retry')
      await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })
      const m = await doneOf(t.messageId)
      expect(resultOf(m)).toEqual({ skipped: true })
      expect(m.content).not.toContain('team@acme.example')
    })
  })

  test('Gmail, a member: connected on its page, then "I\'ve connected it"', async () => {
    const state: { own?: 'connected' } = {}
    await withGmail(state, async () => {
      const t = await start('alice', { name: 'Gmail' })
      const card = await cardOf(t.turnId)
      state.own = 'connected'
      expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body).toEqual({ state: 'connected' })
      expect(resultOf(await doneOf(t.messageId))).toMatchObject({ connected: true, name: 'Gmail', status: 'connected' })
    })
  })

  test('Gmail: connected but not answering: the result says so, never that its tools are there', async () => {
    const state: { own?: 'connected'; down?: boolean } = {}
    await withGmail(state, async () => {
      const t = await start('alice', { name: 'Gmail' })
      const card = await cardOf(t.turnId)
      Object.assign(state, { own: 'connected', down: true })
      await post('alice', t.turnId, { action: 'done', requestId: card.requestId })
      const note = resultOf(await doneOf(t.messageId)).note as string
      expect(note).toContain('not answering right now')
      expect(note).not.toContain('Its tools are yours')
    })
  })

  test('Gmail: the card timed out: not connected is said, with the way; connected on its page meanwhile counts', async () => {
    const state: { own?: 'connected' } = {}
    await withGmail(state, () => withCardTime(1000, async () => {
      const t = await start('alice', { name: 'Gmail' })
      const none = resultOf(await doneOf(t.messageId))
      expect(none.skipped).toBe(true)
      expect(none.reason).toContain('closed with no answer')
      expect(none.reason).toContain('Settings › Connectors › Gmail')
      const t2 = await start('alice', { name: 'Gmail' })
      await cardOf(t2.turnId)
      state.own = 'connected'
      expect(resultOf(await doneOf(t2.messageId))).toMatchObject({ connected: true, name: 'Gmail', status: 'connected' })
    }))
  })

  test('Gmail: Not now after connecting on its page: skipped, and the AI knows it is connected', async () => {
    const state: { own?: 'connected' } = {}
    await withGmail(state, async () => {
      const t = await start('alice', { name: 'Gmail' })
      const card = await cardOf(t.turnId)
      state.own = 'connected'
      await post('alice', t.turnId, { action: 'skip', requestId: card.requestId })
      const r = resultOf(await doneOf(t.messageId))
      expect(r.skipped).toBe(true)
      expect(r.reason).toContain('pressed Not now')
      expect(r.reason).toContain('already connected')
    })
  })

  test('Gmail, a member a team account covers: no card; one that needs a sign-in keeps the words, without its address', async () => {
    await withGmail({ shared: 'needs_reconnect' }, async () => {
      const t = await start('alice', { name: 'Gmail' })
      const m = await doneOf(t.messageId)
      expect(cards(t.turnId)).toEqual([])
      expect(m.content).toContain('the owner or an admin does it')
      expect(m.content).not.toContain('team@acme.example')
    })
  })

  // security review of #483: nobody is at a screen to press a card on these turns, whoever asks
  for (const clientKind of ['slack', 'schedule'] as const) {
    for (const who of ['alice', 'carol']) {
      test(`Gmail on a ${clientKind} turn, ${who === 'alice' ? 'a member' : 'an admin'}: no card, and the app's real next step`, async () => {
        await withGmail({}, async () => {
          const chat = await h.api(who).call(API.createChat, { body: {} })
          const started = h.rt().createTurn({
            chat: h.rt().store.chatRow(chat.id)!, userId: who, locale: 'en', windowId: null, clientKind, engine: 'claude-code', model: null,
            user: { parentId: null, content: fake({ tool: 'connect_service', args: { name: 'Gmail' }, sayResult: true }), attachments: [], clientMessageId: cm() },
          })
          const m = await doneOf(started.assistantMessage.id)
          expect(cards(started.turnId)).toEqual([])
          expect(m.content).toContain('Settings › Connectors › Gmail')
          expect(m.content).toContain('press Connect and sign in with their Google account')
          expect(m.content).not.toContain('"skipped"')
          expect(m.content).not.toContain('scheduled run')
        })
      })
    }
  }

  test('Gmail: its state cannot be read again after "I\'ve connected it": never "its tools are yours"', async () => {
    const state: { own?: 'connected' } = {}
    await withGmail(state, async () => {
      const t = await start('alice', { name: 'Gmail' })
      const card = await cardOf(t.turnId)
      state.own = 'connected'
      // the card's done reads it once; the tool's read after the card fails
      const g = googleAppsOf(h.ctx), view = g.view.bind(g)
      let reads = 0
      g.view = (user, app) => { if (++reads > 1) throw new Error('read failed'); return view(user, app) }
      expect((await post('alice', t.turnId, { action: 'done', requestId: card.requestId })).body).toEqual({ state: 'connected' })
      const r = resultOf(await doneOf(t.messageId))
      expect(r).toMatchObject({ connected: true, name: 'Gmail', status: 'connected' })
      expect(r.note).toContain('could not be read again')
      expect(r.note).not.toContain('Its tools are yours')
    })
  })

  test('Gmail: an admin makes a team connection that leaves them out and the card times out: told it exists and how to join', async () => {
    const state: { team?: 'connected' } = {}
    await withGmail(state, () => withCardTime(1000, async () => {
      const t = await start('carol', { name: 'Gmail' })
      await cardOf(t.turnId)
      state.team = 'connected'
      const m = await doneOf(t.messageId)
      const r = resultOf(m)
      expect(r).toMatchObject({ connected: true, name: 'Gmail', status: 'connected for the team' })
      expect(r.note).toContain('Admin › Connected apps')
      expect(r.note).toContain('who may use it')
      expect(m.content).not.toContain('team@acme.example')
    }))
  })

  test('Gmail: the same team connection and Not now: skipped, and told it exists and how to join', async () => {
    const state: { team?: 'connected' } = {}
    await withGmail(state, async () => {
      const t = await start('carol', { name: 'Gmail' })
      const card = await cardOf(t.turnId)
      state.team = 'connected'
      await post('carol', t.turnId, { action: 'skip', requestId: card.requestId })
      const r = resultOf(await doneOf(t.messageId))
      expect(r.skipped).toBe(true)
      expect(r.reason).toContain('pressed Not now')
      expect(r.reason).toContain('connected for the team')
    })
  })

  test('Gmail, a member: the card times out while a team connection leaves them out: nothing about it reaches the AI', async () => {
    const state: { team?: 'connected' } = {}
    await withGmail(state, () => withCardTime(1000, async () => {
      const t = await start('alice', { name: 'Gmail' })
      await cardOf(t.turnId)
      state.team = 'connected'
      const m = await doneOf(t.messageId)
      expect(resultOf(m).skipped).toBe(true)
      expect(m.content).not.toContain('connected for the team')
      expect(m.content).not.toContain('team@acme.example')
    }))
  })

  test('Gmail: the owner gets the same card as an admin', async () => {
    const was = h.ctx.db.query("SELECT role FROM users WHERE id = 'carol'").get() as { role: string }
    h.ctx.db.query("UPDATE users SET role = 'owner' WHERE id = 'carol'").run()
    try {
      await withGmail({}, async () => {
        const t = await start('carol', { name: 'Gmail' })
        const card = await cardOf(t.turnId)
        expect(card).toMatchObject({ target: 'google_app', teamOffer: true })
        await post('carol', t.turnId, { action: 'skip', requestId: card.requestId })
        await doneOf(t.messageId)
      })
    } finally { h.ctx.db.query('UPDATE users SET role = ? WHERE id = ?').run(was.role, 'carol') }
  })

  test('Gmail: the team\'s shared account a person may use is connected for them, no card, whoever asks', async () => {
    await withGmail({ shared: 'connected' }, async () => {
      for (const who of ['alice', 'carol']) {
        const t = await start(who, { name: 'Gmail' })
        const m = await doneOf(t.messageId)
        expect(cards(t.turnId)).toEqual([])
        expect(m.content).toContain("Gmail is connected for this person through the team's shared account")
        expect(['Connected', '연결됨']).toContain(stepOf(m).detail)
      }
    })
  })

  test('Gmail: done after the team dialog: connected when the team account includes them, else "for the team"', async () => {
    const state: { shared?: 'connected'; team?: 'connected' } = {}
    await withGmail(state, async () => {
      const t = await start('carol', { name: 'Gmail' })
      const card = await cardOf(t.turnId)
      // the dialog connected the team's account for Alice only
      state.team = 'connected'
      expect((await post('carol', t.turnId, { action: 'done', requestId: card.requestId })).body).toEqual({ state: 'connected' })
      const m = await doneOf(t.messageId)
      expect(resultOf(m)).toMatchObject({ connected: true, name: 'Gmail', status: 'connected for the team' })
      expect(resultOf(m).note).toContain('Admin › Connected apps')
      // one that includes them: connected, its tools theirs
      const t2 = await start('carol', { name: 'Gmail' })
      const card2 = await cardOf(t2.turnId)
      state.shared = 'connected'
      expect((await post('carol', t2.turnId, { action: 'done', requestId: card2.requestId })).body).toEqual({ state: 'connected' })
      expect(resultOf(await doneOf(t2.messageId))).toMatchObject({ connected: true, name: 'Gmail', status: 'connected' })
    })
  })
})

describe('a listed service that signs in only through the team\'s own app (Asana, HubSpot, Box)', () => {
  test('no card: a member is told to ask an admin, an admin where to set it up; nothing is saved', async () => {
    const member = await start('alice', { name: 'Asana', kind: 'mcp', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth' })
    const m = await doneOf(member.messageId)
    expect(cards(member.turnId)).toEqual([])
    expect(m.content).toContain('Asana signs in only through an app the team sets up')
    expect(m.content).toContain('No card was shown.')
    const admin = await start('carol', { name: 'HubSpot' })
    const a = await doneOf(admin.messageId)
    expect(cards(admin.turnId)).toEqual([])
    expect(a.content).toContain('HubSpot signs in only through an app the team makes at HubSpot. No card was shown. This person is an admin')
    expect(rowsAt('https://mcp.asana.com/v2/mcp')).toEqual([])
    expect(rowsAt('https://mcp.hubspot.com')).toEqual([])
  })
})
