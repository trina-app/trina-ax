// Connection templates in chats and scheduled tasks (docs/INTEGRATIONS.md "Templates", the brief's R3 and R7), with the
// real chat runtime and the scripted engine:
// R3: the AI is told a template is there to connect; the chat connect card offers the person's own key for it (named by
//   its id, or found by its address), and connecting goes through the template's own path: only a person it is for, the
//   template's address and sign-in fixed, refused when the template changed after the card was shown, never anyone
//   else's connection, also with members' own connections turned off, and not counted toward the personal limit.
// R7: a scheduled task that needs its owner's own key for a template (it names it, or a run used it) does not start
//   without that key: the run's result and the owner's inbox say which template to connect, "Run now" says so too, and
//   another member's key never stands in. Once connected, it runs. Every text that went out is searched for the key.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type SealPurpose } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { FakeServices, MCP_KEY } from '../lib/fake-services'
import { sealSecret } from '../../web/src/lib/seal'
import { credentialsOf } from '../../server/src/credentials/store'
import { integrationsOf, MAX_PERSONAL } from '../../server/src/integrations/connections/service'
import { connectRows } from '../../server/src/chat/connect-service'
import { templatesOf } from '../../server/src/integrations/connections/templates'
import { activeUser } from '../../server/src/integrations/connections/store'
import { missingTemplateKey, namesTemplate, noteScheduleUse } from '../../server/src/integrations/connections/schedule-needs'
import { integrationToolProvider } from '../../server/src/integrations/connections/tools'
import { notificationsOf } from '../../server/src/notifications/service'
import { CONFIRMED } from '../lib/schedule-card'
import { createLogger } from '../../server/src/log'

setDefaultTimeout(60_000)

const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const OTHER = 'CANARY-bob-template-key-4411'

let h: Harness, svc: FakeServices
const published: { userId: string; ev: any }[] = []
const responses: string[] = []
const logs: string[] = []

beforeAll(async () => {
  h = await startHarness({ name: 'template-chat-schedule', askUserTimeoutMs: 8000, turnTimeoutMs: 60_000, log: createLogger({ level: 'debug', name: 'test', sink: (l) => logs.push(l) }) })
  const hub = h.rt().hub
  const publish = hub.publish.bind(hub), publishTo = hub.publishTo.bind(hub)
  hub.publish = (userId, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
  hub.publishTo = (userId, w, ev) => { published.push({ userId, ev: JSON.parse(JSON.stringify(ev)) }); return publishTo(userId, w, ev) }
  svc = new FakeServices()
  integrationsOf(h.ctx, { net: svc.net() })
})
afterAll(async () => { svc?.stop(); await h?.close() })

const admin = () => activeUser(h.ctx.db, 'carol')!
const nobody = { everyone: false, groups: [] as string[], users: [] as string[] }
const makeTemplate = (name: string, users: string[], path = '/mcp-key') =>
  templatesOf(h.ctx).create(admin(), { kind: 'mcp', name, url: `${svc.base}${path}`, auth: 'bearer', access: { ...nobody, users } }, 'en')
const seal = async (secret: string, purpose: SealPurpose = 'integration.secret') => sealSecret(await credentialsOf(h.ctx).sealer.publicKey(), secret, purpose)
async function start(user: string, args: Record<string, unknown>) {
  const chat = await h.api(user).call(API.createChat, { body: {} })
  const r = await h.api(user).call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'connect_service', args, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
  return { chatId: chat.id, turnId: r.turnId, messageId: r.assistantMessage.id }
}
const cards = (turnId: string) => published.filter((p) => p.ev.type === 'turn.request' && p.ev.data.turnId === turnId).map((p) => p.ev.data.request)
const cardOf = (turnId: string) => waitFor(() => cards(turnId)[0], { timeoutMs: 20_000, what: 'connect card' })
async function doneOf(messageId: string): Promise<{ content: string }> {
  const d = await waitFor(() => published.find((p) => p.ev.type === 'message.done' && p.ev.data.messageId === messageId), { timeoutMs: 30_000, what: 'message.done' })
  return d!.ev.data.message
}
async function post(user: string, turnId: string, body: unknown) {
  const r = await h.req(user, `/api/turns/${turnId}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  responses.push(text)
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
const resultOf = (m: { content: string }) => JSON.parse(m.content.slice(m.content.indexOf('{'), m.content.lastIndexOf('}') + 1))
const mineOf = (templateId: string, user: string) => h.ctx.db.query('SELECT id, owner_user_id, status, template_id FROM integrations WHERE template_id = ? AND owner_user_id = ?').get(templateId, user) as { id: string; owner_user_id: string; status: string; template_id: string } | null

describe('R3: the chat connect card for a template', () => {
  test('the AI is told about a template the person has not connected, and only theirs', async () => {
    const t = makeTemplate('Planner', ['alice'])
    const forAlice = integrationToolProvider(h.ctx).build({ userId: 'alice', chatId: 'x', turnId: 'x', browser: false, scheduled: false })
    expect(forAlice.prompt).toContain(`connect_service with template "${t.id}"`)
    const forBob = integrationToolProvider(h.ctx).build({ userId: 'bob', chatId: 'x', turnId: 'x', browser: false, scheduled: false })
    expect(forBob.prompt ?? '').not.toContain(t.id)
    await templatesOf(h.ctx).remove(admin(), t.id)
  })

  test('the card offers the person\'s own key for it; connecting makes their connection from the template', async () => {
    const t = makeTemplate('Board', ['alice'])
    const run = await start('alice', { name: 'Board', template: t.id, why: 'to read your board' })
    const card = await cardOf(run.turnId)
    expect(card).toMatchObject({ kind: 'connect_service', target: 'service', name: 'Board', scope: 'personal', template: { id: t.id, version: 1 }, service: { url: t.url, auth: 'bearer', authHeader: null } })
    const r = await post('alice', run.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
    expect(r.body).toMatchObject({ state: 'connected', status: 'connected' })
    expect(mineOf(t.id, 'alice')).toMatchObject({ id: r.body.integrationId, owner_user_id: 'alice', status: 'connected' })
    expect(resultOf(await doneOf(run.messageId))).toMatchObject({ connected: true, name: 'Board' })
    // asked again: it is connected, no second card
    const again = await start('alice', { name: 'Board', template: t.id })
    expect((await doneOf(again.messageId)).content).toContain('already connected')
    expect(cards(again.turnId)).toEqual([])
    await templatesOf(h.ctx).remove(admin(), t.id)
  })

  test('the address of a template finds it; someone it is not for gets no card for it', async () => {
    const t = makeTemplate('Desk', ['alice'])
    const run = await start('alice', { name: 'Desk tool', kind: 'mcp', url: t.url, auth: 'bearer' })
    const card = await cardOf(run.turnId)
    expect(card.template).toEqual({ id: t.id, version: 1 })
    expect(card.name).toBe('Desk')
    await post('alice', run.turnId, { action: 'skip', requestId: card.requestId })
    // bob: the id is the same as no template; no card
    const bob = await start('bob', { name: 'Desk', template: t.id })
    expect((await doneOf(bob.messageId)).content).toContain('no such template')
    expect(cards(bob.turnId)).toEqual([])
    expect(mineOf(t.id, 'bob')).toBeNull()
    await templatesOf(h.ctx).remove(admin(), t.id)
  })

  test('a template that changed after the card was shown is refused; nothing is sent, nothing made', async () => {
    const t = makeTemplate('Ledger', ['alice'])
    const run = await start('alice', { name: 'Ledger', template: t.id })
    const card = await cardOf(run.turnId)
    await templatesOf(h.ctx).update(admin(), t.id, { name: 'Ledger 2' }, 'en')
    const seen = svc.seen.length
    const r = await post('alice', run.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
    expect(r.status).toBe(409)
    expect(mineOf(t.id, 'alice')).toBeNull()
    expect(svc.seen.length).toBe(seen)
    await post('alice', run.turnId, { action: 'skip', requestId: card.requestId })
    await templatesOf(h.ctx).remove(admin(), t.id)
  })

  test('with members\' own connections turned off, a template card still connects', async () => {
    h.ctx.db.query("INSERT INTO settings (key, value) VALUES ('personalIntegrations', 'false') ON CONFLICT(key) DO UPDATE SET value='false'").run()
    try {
      const t = makeTemplate('Off Desk', ['alice'])
      const run = await start('alice', { name: 'Off Desk', template: t.id })
      const card = await cardOf(run.turnId)
      const r = await post('alice', run.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
      expect(r.body.state).toBe('connected')
      await templatesOf(h.ctx).remove(admin(), t.id)
    } finally {
      h.ctx.db.query("UPDATE settings SET value='true' WHERE key='personalIntegrations'").run()
    }
  })

  test('someone at the personal limit still gets the template card and connects; it does not count toward the limit', async () => {
    const t = makeTemplate('Full Desk', ['erin'])
    const now = new Date().toISOString()
    const ins = h.ctx.db.query("INSERT INTO integrations (id, scope, owner_user_id, created_by, kind, name, slug, url, auth, status, created_at, updated_at) VALUES (?, 'personal', 'erin', 'erin', 'mcp', ?, ?, ?, 'none', 'connected', ?, ?)")
    const own: string[] = []
    for (let i = 0; i < MAX_PERSONAL; i++) { const id = crypto.randomUUID(); own.push(id); ins.run(id, `Own ${i}`, `own-${i}`, `https://own${i}.example.com/mcp`, now, now) }
    try {
      expect(connectRows(h.ctx.db, 'erin', 'personal').count).toBe(MAX_PERSONAL)
      // a new connection of their own is refused at the limit
      const more = await start('erin', { name: 'Another', kind: 'mcp', url: 'https://another.example.com/mcp', auth: 'bearer' })
      expect((await doneOf(more.messageId)).content).toContain(`already ${MAX_PERSONAL} personal connections`)
      expect(cards(more.turnId)).toEqual([])
      // the template's card is not refused, and connecting it leaves the count where it was
      const run = await start('erin', { name: 'Full Desk', template: t.id })
      const card = await cardOf(run.turnId)
      const r = await post('erin', run.turnId, { action: 'connect', requestId: card.requestId, sealed: await seal(MCP_KEY) })
      expect(r.body.state).toBe('connected')
      expect(mineOf(t.id, 'erin')?.owner_user_id).toBe('erin')
      expect(connectRows(h.ctx.db, 'erin', 'personal').count).toBe(MAX_PERSONAL)
    } finally {
      for (const id of own) h.ctx.db.query('DELETE FROM integrations WHERE id = ?').run(id)
      await templatesOf(h.ctx).remove(admin(), t.id)
    }
  })
})

describe('R7: scheduled tasks need the owner\'s own key', () => {
  test('which tasks need a template: one that names it, or one whose run used it', () => {
    expect(namesTemplate('Summarise my Tasks board every morning', 'Tasks')).toBe(true)
    expect(namesTemplate('Summarise my Taskset', 'Tasks')).toBe(false)
    expect(namesTemplate('위키 정리: 사내 Wiki에서 찾기', 'Wiki')).toBe(true)
    expect(namesTemplate('a b', 'ab')).toBe(false)
  })

  test('a run without the owner\'s key does not start: its result and inbox name the template; once connected it runs', async () => {
    const rt = h.rt()
    const t = makeTemplate('Roadmap', ['alice', 'bob'])
    // bob connected it: his key never stands in for alice's
    await templatesOf(h.ctx).connect(activeUser(h.ctx.db, 'bob')!, t.id, { version: 1, secret: OTHER, writePolicy: 'ask' }, 'en').catch(() => {})
    const now = new Date()
    const s = rt.schedules.create('alice', { title: 'Weekly roadmap', prompt: 'Summarise the Roadmap items for the team', repeat: 'daily', time: '09:00' }, new Date(now.getTime() - 2 * 86_400_000), CONFIRMED)
    expect(missingTemplateKey(h.ctx.db, { id: s.id, user_id: 'alice', prompt: 'Summarise the Roadmap items for the team' })).toEqual({ templateId: t.id, name: 'Roadmap' })
    expect(rt.schedules.runDue(now)).toEqual([])
    const listed = (await h.api('alice').call(API.listSchedules)).items.find((x) => x.id === s.id)!
    expect(listed.lastOutcome).toBe('needs_key')
    expect(listed.lastNeed).toEqual({ templateId: t.id, name: 'Roadmap' })
    // no run, no chat: nobody's key was used for alice
    expect(h.ctx.db.query('SELECT count(*) n FROM turns WHERE schedule_id = ?').get(s.id)).toEqual({ n: 0 })
    notificationsOf(h.ctx).reconcile('alice')
    const inbox = (await h.api('alice').call(API.listNotifications, { query: { limit: 50 } })).items
    const n = inbox.find((x) => x.eventType === 'schedule.failure' && x.needsKey)
    expect(n).toMatchObject({ needsKey: { templateId: t.id, name: 'Roadmap' }, link: 'integrations', outcome: 'failed' })
    expect(JSON.stringify(inbox)).not.toContain(OTHER)
    // Run now says it as well
    const runNow = await h.req('alice', `/api/schedules/${s.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(runNow.status).toBe(409)
    expect(await runNow.text()).toContain('Roadmap')
    // connected now: the next run starts
    await templatesOf(h.ctx).connect(activeUser(h.ctx.db, 'alice')!, t.id, { version: 1, secret: MCP_KEY, writePolicy: 'ask' }, 'en')
    expect(missingTemplateKey(h.ctx.db, { id: s.id, user_id: 'alice', prompt: 'Summarise the Roadmap items for the team' })).toBeNull()
    // a key that stopped working counts as none
    h.ctx.db.query("UPDATE integrations SET status = 'needs_auth' WHERE template_id = ? AND owner_user_id = 'alice'").run(t.id)
    expect(missingTemplateKey(h.ctx.db, { id: s.id, user_id: 'alice', prompt: 'x' })?.templateId).toBeUndefined()
    expect(missingTemplateKey(h.ctx.db, { id: s.id, user_id: 'alice', prompt: 'Roadmap' })?.templateId).toBe(t.id)
    rt.schedules.delete('alice', s.id)
    await templatesOf(h.ctx).remove(admin(), t.id)
  })

  test('a task whose run used a template\'s connection needs it next time, even without naming it', async () => {
    const rt = h.rt()
    const t = makeTemplate('Hidden Name', ['alice'])
    const s = rt.schedules.create('alice', { title: 'Plain task', prompt: 'Do the usual thing', repeat: 'daily', time: '09:00' }, undefined, CONFIRMED)
    expect(missingTemplateKey(h.ctx.db, { id: s.id, user_id: 'alice', prompt: 'Do the usual thing' })).toBeNull()
    const chatId = crypto.randomUUID(), turnId = crypto.randomUUID()
    h.ctx.db.query('INSERT INTO chats (id, user_id, title) VALUES (?,?,?)').run(chatId, 'alice', 'run')
    h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, schedule_id) VALUES (?,?,?, 'claude-code', 'done', ?)").run(turnId, chatId, 'alice', s.id)
    noteScheduleUse(h.ctx.db, turnId, { template_id: t.id })
    expect(missingTemplateKey(h.ctx.db, { id: s.id, user_id: 'alice', prompt: 'Do the usual thing' })).toEqual({ templateId: t.id, name: 'Hidden Name' })
    // a turn that is not a scheduled run notes nothing
    const other = crypto.randomUUID()
    h.ctx.db.query("INSERT INTO turns (id, chat_id, user_id, engine, status) VALUES (?,?,?, 'claude-code', 'done')").run(other, chatId, 'alice')
    noteScheduleUse(h.ctx.db, other, { template_id: t.id })
    expect(h.ctx.db.query('SELECT count(*) n FROM schedule_template_needs WHERE template_id = ?').get(t.id)).toEqual({ n: 1 })
    rt.schedules.delete('alice', s.id)
    await templatesOf(h.ctx).remove(admin(), t.id)
  })

  test('no response or row holds a key', () => {
    const text = responses.join('\n') + JSON.stringify(published) + JSON.stringify(h.ctx.db.query('SELECT * FROM integration_template_notices').all())
    expect(text).not.toContain(MCP_KEY)
    expect(text).not.toContain(OTHER)
  })
})
