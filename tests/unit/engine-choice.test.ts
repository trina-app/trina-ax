// Admin-controlled engine / model choice (owner decision 2026-10-21, admin/engine-choice.ts): the team default
// answers everyone; owner and admins always pick; others only when "팀원이 엔진 고르기 허용" lets them (everyone or
// chosen groups / people). Requests naming an engine or model the person may not pick are refused (403); a chat whose
// engine the admin switched off is answered by the team default with a step note; "Claude 한도에 닿으면 Codex로
// 넘기기" (off by default, never while Codex is off) answers a Claude turn that hit the limit with Codex.
// Fake engine through the real launcher; fixture: alice, erin = marketing; bob = finance; carol = admin; dana = owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, type MemberEngineChoice } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { canChooseEngine, filterEnginePrefs, personalDefault, turnEngine } from '../../server/src/admin/engine-choice'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let alice: TestSocket
let carol: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'engine-choice', memberChoice: { mode: 'off', groupIds: [], userIds: [] } })
  alice = await h.ws('alice')
  carol = await h.ws('carol')
  await alice.next('hello')
  await carol.next('hello')
})
afterAll(async () => { alice?.close(); carol?.close(); await h.close() })

const setChoice = (c: MemberEngineChoice) => h.api('dana').call(API.updateEngines, { body: { memberChoice: c } })
const OFF: MemberEngineChoice = { mode: 'off', groupIds: [], userIds: [] }
async function status(p: Promise<unknown>): Promise<{ status: number; code?: string; message?: string; reason?: unknown }> {
  try { await p; return { status: 200 } } catch (e) {
    if (e instanceof ApiError) return { status: e.status, code: e.code, message: e.message, reason: (e.body as { params?: { reason?: unknown } }).params?.reason }
    throw e
  }
}
const send = (user: string, chatId: string, extra: Record<string, unknown> = {}) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content: fake({ say: 'ok' }), clientMessageId: cm(), attachmentIds: [], ...extra } })

describe('who may pick', () => {
  test('default: owner and admins only; GET /api/engines lists nothing for the others', async () => {
    const who = (id: string, role: string) => canChooseEngine(h.ctx, { id, role })
    expect([who('dana', 'owner'), who('carol', 'admin'), who('alice', 'member'), who('bob', 'member')]).toEqual([true, true, false, false])
    const a = await h.api('alice').call(API.chatEngines)
    expect(a).toMatchObject({ canChoose: false, defaultEngine: 'claude-code', engines: [] })
    const c = await h.api('carol').call(API.chatEngines)
    expect(c.canChoose).toBe(true)
    expect(c.engines.map((e) => e.id)).toEqual(['claude-code', 'codex'])
    expect(c.engines[0]!.models.map((m) => m.id)).toContain('opus')
  })

  test('everyone, or chosen groups and people; unknown groups / people are refused; members cannot change it', async () => {
    await setChoice({ mode: 'everyone', groupIds: [], userIds: [] })
    expect(canChooseEngine(h.ctx, { id: 'bob', role: 'member' })).toBe(true)
    await setChoice({ mode: 'selected', groupIds: ['marketing'], userIds: [] })
    expect([canChooseEngine(h.ctx, { id: 'alice', role: 'member' }), canChooseEngine(h.ctx, { id: 'bob', role: 'member' })]).toEqual([true, false])
    await setChoice({ mode: 'selected', groupIds: [], userIds: ['bob'] })
    expect([canChooseEngine(h.ctx, { id: 'alice', role: 'member' }), canChooseEngine(h.ctx, { id: 'bob', role: 'member' })]).toEqual([false, true])
    expect((await status(setChoice({ mode: 'selected', groupIds: ['nope'], userIds: [] }))).status).toBe(400)
    expect((await status(setChoice({ mode: 'selected', groupIds: [], userIds: ['ghost'] }))).status).toBe(400)
    expect((await status(h.api('alice').call(API.updateEngines, { body: { memberChoice: { mode: 'everyone', groupIds: [], userIds: [] } } }))).status).toBe(403)
    const r = await setChoice(OFF)
    expect(r.memberChoice).toEqual(OFF)
    expect(r.limitFallback).toBe(false)
    expect(h.ctx.db.query("SELECT 1 AS x FROM audit_log WHERE action = 'engines.update' AND detail LIKE '%memberChoice%'").get()).toEqual({ x: 1 })
  })
})

describe('enforcement', () => {
  test('a member who may not pick: naming another engine or model is refused (send, edit, regenerate, new chat, chat change)', async () => {
    await setChoice(OFF)
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    expect(chat.engine).toBe('claude-code')
    const first = await ask(h, alice, 'alice', chat.id, fake({ say: 'first' }))
    const refused = await status(send('alice', chat.id, { engine: 'codex' }))
    expect(refused).toMatchObject({ status: 403, code: 'forbidden', reason: 'engine_choice_not_allowed' })
    expect(refused.message).toContain('admin')
    expect((await status(send('alice', chat.id, { model: 'opus' }))).status).toBe(403)
    expect((await status(h.api('alice').call(API.regenerate, { params: { id: chat.id, messageId: first.started.assistantMessage.id }, body: { engine: 'codex' } }))).status).toBe(403)
    expect((await status(h.api('alice').call(API.editMessage, { params: { id: chat.id, messageId: first.started.userMessage!.id }, body: { content: 'x', attachmentIds: [], model: 'sonnet', clientMessageId: cm() } }))).status).toBe(403)
    expect((await status(h.api('alice').call(API.createChat, { body: { engine: 'codex' } }))).status).toBe(403)
    expect((await status(h.api('alice').call(API.updateChat, { params: { id: chat.id }, body: { engine: 'codex' } }))).status).toBe(403)
    expect((await status(h.api('alice').call(API.updateChat, { params: { id: chat.id }, body: { model: 'opus' } }))).status).toBe(403)
    // nothing was queued or changed by the refused requests
    expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?').get(chat.id) as { n: number }).n).toBe(1)
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).engine).toBe('claude-code')
    // naming exactly what they get anyway (an older client echoing the chat's engine) is fine
    const same = await send('alice', chat.id, { engine: 'claude-code' })
    await alice.next('message.done', (f) => f.data.messageId === same.assistantMessage.id)
    // the rename part of a chat change still works
    expect((await h.api('alice').call(API.updateChat, { params: { id: chat.id }, body: { title: 'renamed' } })).title).toBe('renamed')
  })

  test('admins pick freely; a member allowed by group picks too; nobody picks an engine that is switched off', async () => {
    const chat = await h.api('carol').call(API.createChat, { body: {} })
    const r = await send('carol', chat.id, { engine: 'codex', content: fake({ say: 'codex here' }) })
    const done = await carol.next('message.done', (f) => f.data.messageId === r.assistantMessage.id)
    expect(done.data.message).toMatchObject({ engine: 'codex', status: 'done' })
    await setChoice({ mode: 'selected', groupIds: ['marketing'], userIds: [] })
    const ac = await h.api('alice').call(API.createChat, { body: { engine: 'codex', model: 'fake-2' } })
    expect(ac).toMatchObject({ engine: 'codex', model: 'fake-2' })
    await h.api('dana').call(API.updateEngines, { body: { enabled: { codex: false } } })
    try {
      expect(await status(send('carol', chat.id, { engine: 'codex' }))).toMatchObject({ status: 409, reason: 'engine_off' })
      expect((await status(h.api('alice').call(API.createChat, { body: { engine: 'codex' } }))).status).toBe(409)
      expect((await h.api('carol').call(API.chatEngines)).engines.map((e) => e.id)).toEqual(['claude-code'])
    } finally {
      await h.api('dana').call(API.updateEngines, { body: { enabled: { codex: true } } })
      await setChoice(OFF)
    }
  })

  test('a chat whose engine was switched off continues on the team default, with a step saying so', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    h.ctx.db.query("UPDATE chats SET engine = 'codex', model = 'fake-2' WHERE id = ?").run(chat.id) // made while Codex was allowed
    // still on: the chat keeps its engine, even for someone who may not pick
    const kept = await ask(h, alice, 'alice', chat.id, fake({ say: 'still codex' }))
    expect(kept.done.engine).toBe('codex')
    await h.api('dana').call(API.updateEngines, { body: { enabled: { codex: false } } })
    try {
      const { done } = await ask(h, alice, 'alice', chat.id, fake({ say: 'now claude' }))
      expect(done).toMatchObject({ status: 'done', engine: 'claude-code', content: 'now claude' })
      const note = done.steps.find((s) => s.tool === 'engine')
      expect(note?.label).toBe('Codex is switched off; answering with the team default (Claude Code)')
      expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).engine).toBe('claude-code')
    } finally {
      await h.api('dana').call(API.updateEngines, { body: { enabled: { codex: true } } })
    }
  })

  test('turnEngine: the decision table', () => {
    const member = { id: 'alice', role: 'member' }
    const admin = { id: 'carol', role: 'admin' }
    const dm = () => null
    const chat = { engine: 'claude-code', model: 'opus' }
    expect(turnEngine(h.ctx, member, chat, {}, 'en', dm)).toEqual({ engine: 'claude-code', model: 'opus' })
    expect(turnEngine(h.ctx, member, chat, { engine: 'claude-code', model: 'opus' }, 'en', dm)).toEqual({ engine: 'claude-code', model: 'opus' })
    expect(() => turnEngine(h.ctx, member, chat, { model: null }, 'en', dm)).toThrow()
    expect(turnEngine(h.ctx, admin, chat, { engine: 'codex' }, 'en', dm)).toEqual({ engine: 'codex', model: null })
    expect(turnEngine(h.ctx, admin, chat, { model: 'sonnet' }, 'en', dm)).toEqual({ engine: 'claude-code', model: 'sonnet' })
    expect(() => turnEngine(h.ctx, admin, chat, { model: '--evil' }, 'en', dm)).toThrow()
  })
})

describe('own default engine / model', () => {
  test('only for people who may pick; null clears it; a switched-off engine falls back to the team default', () => {
    h.ctx.db.query(`UPDATE users SET prefs = '{"engine":"codex","model":"fake-2"}' WHERE id IN ('alice', 'carol')`).run()
    expect(personalDefault(h.ctx, { id: 'alice', role: 'member' })).toEqual({ engine: 'claude-code', model: null })
    expect(personalDefault(h.ctx, { id: 'carol', role: 'admin' })).toEqual({ engine: 'codex', model: 'fake-2' })
    expect(filterEnginePrefs(h.ctx, { id: 'alice', role: 'member' }, { engine: 'codex', model: 'x' })).toEqual({})
    expect(filterEnginePrefs(h.ctx, { id: 'carol', role: 'admin' }, { engine: null, model: null })).toEqual({ engine: null, model: null })
    expect(() => filterEnginePrefs(h.ctx, { id: 'carol', role: 'admin' }, { model: '-x' })).toThrow()
    h.ctx.db.query(`INSERT OR REPLACE INTO settings (key, value) VALUES ('engines.enabled', '{"claude-code":true,"codex":false}')`).run()
    expect(personalDefault(h.ctx, { id: 'carol', role: 'admin' })).toEqual({ engine: 'claude-code', model: null })
    h.ctx.db.query(`INSERT OR REPLACE INTO settings (key, value) VALUES ('engines.enabled', '{"claude-code":true,"codex":true}')`).run()
    h.ctx.db.query(`UPDATE users SET prefs = '{}' WHERE id IN ('alice', 'carol')`).run()
  })
})

describe('Claude limit -> Codex fallback', () => {
  test('off by default: a Claude limit ends the answer with the limit error', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const { done } = await ask(h, alice, 'alice', chat.id, fake({ claudeFail: 'rate limit exceeded' }, { say: 'from codex' }))
    expect(done.status).toBe('error')
    expect(done.error?.code).toBe('rate_limited')
    expect(done.engine).toBe('claude-code')
  })

  test('cannot be turned on while Codex is off (switched off, or office mode); switching Codex off turns it off', async () => {
    await h.api('dana').call(API.updateEngines, { body: { enabled: { codex: false } } })
    expect(await status(h.api('dana').call(API.updateEngines, { body: { limitFallback: true } }))).toMatchObject({ status: 409 })
    let r = await h.api('dana').call(API.updateEngines, { body: { enabled: { codex: true }, limitFallback: true } })
    expect(r).toMatchObject({ limitFallback: true, limitFallbackAvailable: true })
    r = await h.api('dana').call(API.updateEngines, { body: { enabled: { codex: false } } })
    expect(r).toMatchObject({ limitFallback: false, limitFallbackAvailable: false })
    r = await h.api('dana').call(API.updateEngines, { body: { enabled: { codex: true } } })
    expect(r.limitFallback).toBe(false) // not quietly back on
    const prev = h.ctx.config.engine.codexBin
    h.ctx.config.engine.codexBin = '' // office mode: Codex off by the installation
    try {
      expect((await status(h.api('dana').call(API.updateEngines, { body: { limitFallback: true } }))).status).toBe(409)
      expect((await h.api('dana').call(API.engines)).limitFallbackAvailable).toBe(false)
      expect((await h.api('carol').call(API.chatEngines)).engines.map((e) => e.id)).toEqual(['claude-code'])
    } finally { h.ctx.config.engine.codexBin = prev }
  })

  test('on: the turn continues with Codex, says so in a step, and is audited', async () => {
    await h.api('dana').call(API.updateEngines, { body: { limitFallback: true } })
    try {
      const chat = await h.api('alice').call(API.createChat, { body: {} })
      const { started, done } = await ask(h, alice, 'alice', chat.id, fake({ claudeFail: 'rate limit exceeded' }, { say: 'from codex' }))
      expect(done).toMatchObject({ status: 'done', engine: 'codex', content: 'from codex' })
      expect(done.error).toBeNull()
      expect(done.steps.find((s) => s.tool === 'engine')?.label).toBe('Claude Code usage limit reached; continuing with Codex')
      expect(h.ctx.db.query('SELECT engine FROM turns WHERE id = ?').get(started.turnId)).toEqual({ engine: 'codex' })
      const a = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'engine.limit_fallback' AND target = ?").get(started.turnId) as { actor_id: string; detail: string }
      expect(a.actor_id).toBe('alice')
      expect(JSON.parse(a.detail)).toMatchObject({ from: 'claude-code', to: 'codex' })
      // the chat stays a Claude chat: the next turn tries Claude again (fresh session from the history)
      expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).engine).toBe('claude-code')
      const next = await ask(h, alice, 'alice', chat.id, fake({ echo: 'resume' }))
      expect(next.done).toMatchObject({ engine: 'claude-code', content: 'resumed=false' })
      // other errors never switch
      const crash = await ask(h, alice, 'alice', chat.id, fake({ claudeFail: 'context window exceeded' }))
      expect(crash.done.engine).toBe('claude-code')
      expect(crash.done.status).toBe('error')
    } finally {
      await h.api('dana').call(API.updateEngines, { body: { limitFallback: false } })
    }
  })
})
