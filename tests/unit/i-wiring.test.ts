// Integration (after merging the components): the pieces that only meet on main. A chat turn (B) offers C's tools
// (make_file, share_file, artifact, web_fetch) and runs them through C's registry with C's audit summaries;
// attachments uploaded through C's POST /api/uploads become part of a message B sends; the realtime hub (B)
// closes the sockets of exactly one session when A signs that session out.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'i-wiring', askUserTimeoutMs: 3000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-i-main' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

describe('B turns use C tools', () => {
  test('a web turn is offered the file tools, B tools and every C tool (set_title: a new chat\'s first message)', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake({ echo: 'tools' }))
    expect(r.done.content.split(',')).toEqual(['artifact', 'ask_user', 'copy_files', 'edit', 'forget', 'glob', 'grep', 'list', 'make_file', 'move_files', 'read', 'remember', 'rename_file', 'schedule_create', 'schedule_delete', 'schedule_list', 'search', 'set_title', 'share_file', 'web_fetch', 'write'])
  })

  test('artifact from a turn: saved for the answer, artifact.updated, listed over REST, audited with C\'s summary', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake(
      { tool: 'artifact', args: { action: 'create', key: 'hello', type: 'html', title: 'Hello', content: '<p>hi</p>' }, sayResult: true },
    ))
    expect(r.done.content).toContain("Artifact 'hello' saved as version 1")
    const ev = await alice.next('artifact.updated', (f) => f.data.chatId === chat.id && f.data.status === 'done')
    expect(ev.data.messageId).toBe(r.started.assistantMessage.id)
    const list = await h.api('alice').call(API.listChatArtifacts, { params: { id: chat.id } })
    expect(JSON.stringify(list)).toContain('"key":"hello"')
    const audit = h.ctx.db.query("SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = 'artifact'").all(r.started.turnId) as { summary: string; ok: number }[]
    expect(audit).toHaveLength(1)
    expect(audit[0]!.summary).toStartWith('artifact create hello v1')
    expect(audit[0]!.ok).toBe(1)
  })

  test('share_file checks the caller\'s access; invalid input is a tool error, not a crash', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await ask(h, alice, 'alice', chat.id, fake(
      { tool: 'share_file', args: { path: 'shared/glossary.md', mode: 'preview' }, sayResult: true },
      { say: ' | ' },
      { tool: 'share_file', args: { path: 'groups/finance', mode: 'preview' }, sayResult: true },
      { say: ' | ' },
      { tool: 'make_file', args: {}, sayResult: true },
    ))
    const [ok, hidden, bad] = r.done.content.split(' | ')
    expect(ok).toContain('/files/view?path=shared%2Fglossary.md')
    expect(hidden).toMatch(/denied|not found/i)
    expect(bad).toContain('Invalid input')
  })
})

describe('C attachments in B messages', () => {
  test('a file uploaded with POST /api/uploads is attached to the sent message and readable by the turn', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const form = new FormData()
    form.set('chatId', chat.id)
    form.set('file', new File(['attached words'], 'note.txt', { type: 'text/plain' }))
    const up = await h.req('alice', '/api/uploads', { method: 'POST', body: form })
    expect(up.status).toBe(201)
    const att = await up.json() as { id: string; path: string }
    const sent = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'read', args: { file_path: att.path }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [att.id] } })
    expect(sent.userMessage!.attachments.map((a) => a.id)).toEqual([att.id])
    const done = await alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 20_000)
    expect(done.data.message.content).toContain('attached words')
  })

  // 2026-10-28: the AI answered "I can only save text files" when asked to put a PDF and images someone attached where
  // the team can see them. move_files does it, after one card from the server (never the AI's own ask_user).
  test('an attached image moved into a team folder from a turn: the server asks, the person allows, it moves', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const form = new FormData()
    form.set('chatId', chat.id)
    form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'seal.png', { type: 'image/png' }))
    const up = await h.req('alice', '/api/uploads', { method: 'POST', body: form })
    expect(up.status).toBe(201)
    const att = await up.json() as { id: string; path: string }
    fs.mkdirSync(path.join(h.team, 'shared', 'company'), { recursive: true })
    const sent = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'move_files', args: { paths: [att.path], to_folder: 'shared/company' }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === sent.turnId)
    const req = card.data.request
    if (req.kind !== 'ask_user') throw new Error(`expected the server's ask_user card, got ${req.kind}`)
    expect(req.origin).toBe('server')
    expect(req.question).toContain('shared/company')
    expect(req.question).toContain('seal.png')
    await h.api('alice').call(API.answerTurn, { params: { id: sent.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'allow' } })
    const done = await alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 20_000)
    expect(done.data.message.content).toContain('-> shared/company/seal.png')
    expect(fs.readFileSync(path.join(h.team, 'shared', 'company', 'seal.png'))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    expect(fs.existsSync(path.join(h.team, ...att.path.split('/')))).toBe(false)
    expect(done.data.message.steps.map((s) => s.label)).toContain('Move files · shared/company')
  })
})

describe('A signs out one session, B closes only its sockets', () => {
  test('disconnectSession(sessionId) closes that session\'s windows and leaves the others open', async () => {
    const web = await h.ws('bob', { windowId: 'win-i-bob-web' })
    await web.next('hello')
    const desk = await h.ws('bob', { windowId: 'win-i-bob-desk', client: 'desktop' })
    await desk.next('hello')
    const hub = h.ctx.services.realtime
    // the test session service gives each (person, client kind) its own session id; read the web window's from the hub
    const users = (hub as unknown as { users: Map<string, { sockets: Map<string, { sessionId: string }> }> }).users
    const webSid = users.get('bob')!.sockets.get('win-i-bob-web')!.sessionId
    expect(users.get('bob')!.sockets.get('win-i-bob-desk')!.sessionId).not.toBe(webSid)
    hub.disconnectSession!(webSid, 'logout')
    await waitFor(() => !!web.closed, { timeoutMs: 3000 })
    expect(web.closed!.code).toBe(4401)
    // the closed window is told why first (the web shows "signed out elsewhere" instead of "session expired")
    const ended = web.frames.find((f) => f.type === 'session.ended')
    expect(ended && 'data' in ended && ended.data).toEqual({ reason: 'logout' })
    expect(desk.closed).toBeFalsy()
    expect(desk.frames.some((f) => f.type === 'session.ended')).toBe(false)
    // not kept for replay: a window of the person's other session resuming from before it must not sign itself out
    const again = await h.ws('bob', { windowId: 'win-i-bob-desk2', client: 'desktop', epoch: h.ctx.epoch, after: 0 })
    await again.next('hello')
    await new Promise((r) => setTimeout(r, 200))
    expect(again.frames.some((f) => f.type === 'session.ended')).toBe(false)
    expect(again.closed).toBeFalsy()
    again.close()
    desk.close()
  })

  test('disconnectUser (password changed, account disabled) ends every window of the person with session.ended', async () => {
    const a = await h.ws('carol', { windowId: 'win-i-carol-a' })
    await a.next('hello')
    const b = await h.ws('carol', { windowId: 'win-i-carol-b', client: 'desktop' })
    await b.next('hello')
    h.ctx.services.realtime.disconnectUser('carol', 'disabled')
    for (const s of [a, b]) {
      await waitFor(() => !!s.closed, { timeoutMs: 3000 })
      expect(s.closed!.code).toBe(4401)
      const ended = s.frames.find((f) => f.type === 'session.ended')
      expect(ended && 'data' in ended && ended.data).toEqual({ reason: 'disabled' })
    }
  })
})

// 2026-10-28: the founder gave the AI an API key for AI PM and asked it to keep using it; it had nowhere to keep it and
// no tool to send it. A connection made in Settings gives the turn that service's tools; a call that changes something
// asks on the server's own card first.
describe('external-service connections in a turn', () => {
  test('a turn calls a connected MCP server\'s tool; a write asks on the server\'s card; the step names the service', async () => {
    const services = new FakeServices()
    try {
      integrationsOf(h.ctx, { net: services.net() })
      const c = await h.api('alice').call(API.createIntegration, { body: { kind: 'mcp', name: 'Tasks', url: `${services.base}/mcp-key`, auth: 'bearer', secret: MCP_KEY, writePolicy: 'ask' } })
      expect(c.status).toBe('connected')
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const sent = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ echo: 'tools' }, { say: ' | ' }, { tool: 'my_tasks__create_task', args: { title: 'Quarterly plan' }, sayResult: true }), clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
      const card = await alice.next('turn.request', (f) => f.data.turnId === sent.turnId)
      const req = card.data.request
      if (req.kind !== 'ask_user') throw new Error(`expected the server's ask_user card, got ${req.kind}`)
      expect(req.origin).toBe('server')
      expect(req.question).toContain('The AI wants to do this at Tasks: create_task')
      expect(req.question).toContain('Quarterly plan')
      await h.api('alice').call(API.answerTurn, { params: { id: sent.turnId }, body: { kind: 'ask_user', requestId: req.requestId, answer: 'allow' } })
      const done = await alice.next('message.done', (f) => f.data.messageId === sent.assistantMessage.id, 20_000)
      const [tools, result] = done.data.message.content.split(' | ')
      expect(tools!.split(',')).toContain('my_tasks__create_task')
      expect(tools!.split(',')).toContain('my_tasks__search_tasks')
      expect(result).toContain('created task "Quarterly plan"')
      expect(result).toContain('<external_data source="Tasks">')
      expect(services.calls.at(-1)).toMatchObject({ name: 'create_task', args: { title: 'Quarterly plan' } })
      expect(done.data.message.steps.map((s) => s.label)).toContain('Tasks · create_task')
      const audit = h.ctx.db.query('SELECT summary, ok FROM tool_events WHERE turn_id = ? AND tool = ?').get(sent.turnId, 'my_tasks__create_task') as { summary: string; ok: number }
      expect(audit).toEqual({ summary: 'my_tasks__create_task -> ok (29 chars) (confirmed by the user)', ok: 1 })
      expect(JSON.stringify(done.data.message)).not.toContain(MCP_KEY)
      await h.api('alice').call(API.deleteIntegration, { params: { id: c.id } })
    } finally { services.stop() }
  })
})
