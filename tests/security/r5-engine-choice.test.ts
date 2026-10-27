// Security round 5 (owner decision 2026-10-21): the AI engine and model are the admin's choice. With the shipped
// default ("팀원이 엔진 고르기 허용" off) a member cannot pick an engine or model by any route — not by naming one in a
// send / regenerate / new chat / chat change, not by storing an own default in their preferences, not by changing the
// admin setting — and cannot turn on "Claude 한도에 닿으면 Codex로 넘기기" (which sends conversations to OpenAI).
// Real session service and personas (tests/security/lib): owner dana, admin carol, members alice / erin / bob.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { startInstance, type Instance } from './lib/instance'
import { buildWorld, type World } from './lib/world'

setDefaultTimeout(120_000)
let W: World
let inst: Instance
beforeAll(async () => { inst = await startInstance('r5-engine-choice'); W = await buildWorld(inst, { sharedSubscriptions: true }) })
afterAll(async () => { for (const s of Object.values(W?.sockets ?? {})) s.close(); await inst?.close() })

const turns = (chatId: string) => (inst.ctx.db.query('SELECT COUNT(*) AS n FROM turns WHERE chat_id = ?').get(chatId) as { n: number }).n
const setting = (key: string) => (inst.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null)?.value ?? null

describe('engine / model choice is the admin\'s', () => {
  test('GET /api/me: members cannot pick by default, admins and the owner can', async () => {
    const me = async (who: 'owner' | 'admin' | 'memberIn' | 'memberOut') => (await W.as[who].ok('GET', '/api/me')).user.canChooseEngine
    expect([await me('owner'), await me('admin'), await me('memberIn'), await me('memberOut')]).toEqual([true, true, false, false])
  })

  test('a member naming an engine or model is refused and nothing runs', async () => {
    const a = W.as.memberIn
    const before = turns(W.ids.chatA)
    for (const body of [{ engine: 'codex' }, { model: 'opus' }, { engine: 'codex', model: 'gpt-5' }]) {
      const r = await a.post(`/api/chats/${W.ids.chatA}/messages`, { content: 'hi', attachmentIds: [], clientMessageId: 'cm-' + crypto.randomUUID(), ...body })
      expect(r.status).toBe(403)
      expect(r.json.error.code).toBe('forbidden')
    }
    expect((await a.post(`/api/chats/${W.ids.chatA}/messages/${W.ids.assistantMsg}/regenerate`, { engine: 'codex' })).status).toBe(403)
    expect((await a.post('/api/chats', { engine: 'codex' })).status).toBe(403)
    expect((await a.patch(`/api/chats/${W.ids.chatA}`, { engine: 'codex' })).status).toBe(403)
    expect(turns(W.ids.chatA)).toBe(before)
    expect((await a.ok('GET', `/api/chats/${W.ids.chatA}`)).engine).not.toBe('codex')
  })

  test('a member cannot store an own default engine (it is dropped) nor read one back', async () => {
    const r = await W.as.memberIn.ok('PATCH', '/api/me', { prefs: { theme: 'dark', engine: 'codex', model: 'gpt-5' } })
    expect(r.user.prefs.theme).toBe('dark')
    expect(r.user.prefs.engine).toBeUndefined()
    const row = inst.ctx.db.query("SELECT prefs FROM users WHERE id = 'alice'").get() as { prefs: string }
    expect(JSON.parse(row.prefs).engine).toBeUndefined()
  })

  test('members cannot allow themselves, nor turn on the Codex fallback', async () => {
    const before = [setting('engines.memberChoice'), setting('engines.limitFallback')]
    for (const who of ['memberIn', 'memberOut', 'other'] as const) {
      expect((await W.as[who].patch('/api/admin/engines', { memberChoice: { mode: 'everyone', groupIds: [], userIds: [] } })).status).toBe(403)
      expect((await W.as[who].patch('/api/admin/engines', { limitFallback: true })).status).toBe(403)
      expect((await W.as[who].patch('/api/admin/settings', { memberChoice: { mode: 'everyone' } } as Record<string, unknown>)).status).toBe(403)
    }
    expect([setting('engines.memberChoice'), setting('engines.limitFallback')]).toEqual(before)
    // the admin can; then the member may pick (and sees the engines)
    await W.as.admin.ok('PATCH', '/api/admin/engines', { memberChoice: { mode: 'selected', groupIds: [], userIds: ['alice'] } })
    expect((await W.as.memberIn.ok('GET', '/api/me')).user.canChooseEngine).toBe(true)
    expect((await W.as.memberOut.ok('GET', '/api/me')).user.canChooseEngine).toBe(false)
    expect((await W.as.memberIn.ok('GET', '/api/engines')).canChoose).toBe(true)
    await W.as.admin.ok('PATCH', '/api/admin/engines', { memberChoice: { mode: 'off', groupIds: [], userIds: [] } })
    expect((await W.as.memberIn.ok('GET', '/api/me')).user.canChooseEngine).toBe(false)
  })
})
