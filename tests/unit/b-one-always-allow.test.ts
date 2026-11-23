// One "Always allow" (docs/decisions/20261123-one-always-allow.md; the owner, 2026-11-23: "그 대화에서만 항상 허용이
// 아니라 그냥 전체 항상 허용이 있어야할 것 같은데"), and "<connector> 전체 항상 허용" (same day: "질문수도 줄어야해").
// Covered: no card or prompt string offers an Always for one chat; one press of "Bright Data 전체 항상 허용" on the first
// read card means no card for another tool of that connection in a new chat and in the person's scheduled run;
// Settings lists it as one entry and removing it brings the card back; a moved connection, the team's switch off and a
// lost access end it; a change still asks every time; a guest among the people: the card offers the same four buttons
// and the person's Always holds there too; migration 445 removes the per-chat rows and keeps the permanent ones.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type AiAllowance, type Message } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { warnedIn } from '../lib/shared-warned'
import { WARNED_PREFIX } from '../../server/src/integrations/connections/tool-allow'
import { CONFIRMED } from '../lib/schedule-card'
import { FakeServices } from '../lib/fake-services'
import { integrationsOf } from '../../server/src/integrations/connections/service'
import { setAccess } from '../../server/src/integrations/connections/store'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { ALL_TOOLS } from '../../server/src/integrations/connections/tool-allow'
import { alwaysNoteOf } from '../../server/src/integrations/connections/tools'
import { sharedNote } from '../../server/src/chat/turn'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const T = (n: string) => `team_brightdata__${n}`
const ROOT = path.resolve(import.meta.dir, '../..')

let h: Harness, svc: FakeServices
const ws: Record<string, TestSocket> = {}
let projectId: string
let teamId = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b-one-always-allow', askUserTimeoutMs: 3000, stallTimeoutMs: 60_000, timeZone: 'Asia/Seoul' })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  svc = new FakeServices()
  svc.tools = [...svc.tools,
    { name: 'get_post', title: 'Get post', description: 'Reads a post', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'get_profile_update', title: 'Get profile update', description: 'Reads the latest profile update', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'resend_invoice', description: 'Resends an invoice', inputSchema: { type: 'object', properties: { to: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  ]
  integrationsOf(h.ctx, { net: svc.net() })
  const team = await h.api('carol').call(API.createTeamIntegration, { body: { kind: 'mcp', name: 'Bright Data', url: `${svc.base}/mcp-open`, auth: 'none', writePolicy: 'ask', access: { everyone: true, groups: [], users: [] } } as never })
  expect(team.status).toBe('connected')
  teamId = team.id
})
// every person has seen the one notice in the project (docs/decisions/20261123-shared-connector-warning-once.md): the
// cards here are the tools' own
beforeEach(() => { if (h && projectId) warnedIn(h.ctx.db, `p:${projectId}`) })
afterAll(async () => { for (const s of Object.values(ws)) s.close(); svc?.stop(); await h?.close() })

const db = () => h.ctx.db
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
const done = async (user: string, chatId: string, messageId: string) => {
  const d = await ws[user]!.next('message.done', (f) => f.data.messageId === messageId, 30_000)
  await waitFor(() => !h.rt().activeTurn(chatId), { timeoutMs: 15_000 })
  return d.data.message as Message
}
type Card = { question: string; options: { label: string; value: string }[]; note?: string; buttons?: boolean }
async function askCards(user: string, chatId: string, content: string, pick: (card: Card) => string) {
  const started = await send(user, chatId, content)
  const seen = new Set<string>()
  const cards: Card[] = []
  const timer = setInterval(() => {
    for (const f of ws[user]!.frames) {
      if (f.type !== 'turn.request') continue
      const d = (f as { data: { turnId: string; request: { requestId: string } & Card } }).data
      if (d.turnId !== started.turnId || seen.has(d.request.requestId)) continue
      seen.add(d.request.requestId)
      cards.push(d.request)
      void h.api(user).call(API.answerTurn, { params: { id: started.turnId }, body: { kind: 'ask_user', requestId: d.request.requestId, answer: pick(d.request) } }).catch(() => {})
    }
  }, 20)
  try { return { started, cards, done: await done(user, chatId, started.assistantMessage.id) } } finally { clearInterval(timer) }
}
const last = (c: Card) => c.options.at(-1)!.value
const callsOf = (n: string) => svc.calls.filter((c) => c.name === n).length
const via = (name: string, args: Record<string, unknown> = {}) => fake({ tool: name, args, sayResult: true })
const grants = (user: string) => (db().query('SELECT tool FROM connector_tool_allow WHERE user_id = ? ORDER BY tool').all(user) as { tool: string }[]).map((r) => r.tool).filter((t) => !t.startsWith(WARNED_PREFIX))
const clear = () => { db().query('DELETE FROM connector_tool_allow').run(); warnedIn(db(), `p:${projectId}`) }
const allowances = async (user = 'alice') => (await h.api(user).call(API.listAiAllowances)).items as AiAllowance[]
const farTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + 12 * 3_600_000))
/** run a task of alice's in `chatId` now, as at its time; the run's turn id once its answer is done */
async function runTask(chatId: string, prompt: string): Promise<string> {
  const s = h.rt().schedules.create('alice', { title: 'T ' + crypto.randomUUID().slice(0, 6), prompt, repeat: 'daily', time: farTime(), projectId }, undefined, CONFIRMED, { chatId })
  db().query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id)
  expect(h.rt().schedules.runDue(new Date())).toEqual([s.id])
  const t = db().query('SELECT id FROM turns WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1').get(s.id) as { id: string }
  await waitFor(() => (db().query('SELECT status FROM turns WHERE id = ?').get(t.id) as { status: string }).status !== 'queued'
    && (db().query("SELECT status FROM messages WHERE turn_id = ? AND role = 'assistant'").get(t.id) as { status: string } | null)?.status !== 'streaming', { timeoutMs: 30_000 })
  h.rt().schedules.delete('alice', s.id)
  return t.id
}
const toolOk = (turnId: string, tool: string) => (db().query('SELECT ok FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY rowid DESC LIMIT 1').get(turnId, tool) as { ok: number } | null)?.ok

describe('no Always for one chat anywhere', () => {
  test('no card text of the server or the app offers "Always in this chat" or a site for this conversation', () => {
    const files = [
      'server/src/chat/i18n.ts', 'server/src/chat/always-allow.ts', 'server/src/chat/turn.ts', 'server/src/integrations/connections/text.ts',
      'server/src/integrations/connections/tools.ts', 'server/src/tools/url-gate.ts',
      ...['en', 'ko', 'id', 'ja', 'es', 'zh'].map((l) => `web/src/i18n/${l}.ts`),
      'web/test/mock/server.ts', 'web/test/e2e/exfil-followups.spec.ts',
    ]
    const banned = [/Always in this chat/, /이 (대화|채팅)에서 항상 허용/, /이 대화에서 이 사이트 허용/, /Allow this site in this conversation/, /この(会話|チャット)では常に許可/, /Siempre en este chat/, /Selalu di obrolan ini/, /在(此|这个)对话中始终允许/, /ALWAYS_CHAT_VALUE|always_chat|chatScoped|keepAlwaysAt/]
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      for (const b of banned) expect([f, b.source, b.test(text)]).toEqual([f, b.source, false])
    }
  })
})

describe('the line under the four buttons', () => {
  test('never over 300 characters (a longer one keeps the card from showing), in every language, with a long name', () => {
    const long = 'Google Drive (a.very.long.account.name@example-company.co.kr) — shared'.padEnd(80, 'x')
    for (const L of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) {
      for (const name of ['Aside', long]) {
        expect([L, name.length, sharedNote(L, name).length <= 300]).toEqual([L, name.length, true])
        for (const mode of ['reads', 'acts'] as const) expect([L, mode, alwaysNoteOf(L, mode, name, 'Get post').length <= 300]).toEqual([L, mode, true])
      }
    }
    // a short name: both lines
    expect(sharedNote('en', 'Aside')).toContain('Always allow all: every tool of it also runs without asking')
    expect(alwaysNoteOf('en', 'reads', 'Aside', 'Get post')).toContain('Always allow all of Aside')
  })
})

describe('"Bright Data 전체 항상 허용" on the first connector card', () => {
  test('the read card: Allow / Always allow / Always allow all of Bright Data / Don’t allow, one press, a line for both', async () => {
    clear()
    const r = await askCards('alice', (await newShared()).id, via(T('get_post'), { url: 'https://example.com/p/1' }), last)
    expect(r.cards.length).toBe(1)
    expect(r.cards[0]!.options.map((o) => [o.label, o.value])).toEqual([['Allow', 'allow'], ['Always allow', 'always'], ['Always allow all of Bright Data', 'all'], ['Don’t allow', 'deny']])
    expect(r.cards[0]!.buttons).toBe(true)
    expect(r.cards[0]!.note).toContain('in every chat')
    expect(r.cards[0]!.note).toContain('Always allow all of Bright Data: every Bright Data tool runs without asking, and what it returns shows in shared chats too.')
    expect(r.cards[0]!.note!.length).toBeLessThanOrEqual(300)
  })

  test('one press: another tool has no card in a new chat and in the scheduled run; Settings shows one entry; removing it asks again', async () => {
    clear()
    const n = callsOf('get_post')
    const first = await askCards('alice', (await newShared()).id, via(T('get_post'), { url: 'https://example.com/a' }), () => 'all')
    expect(first.cards.length).toBe(1)
    expect(callsOf('get_post')).toBe(n + 1)
    expect(grants('alice')).toEqual([ALL_TOOLS])
    // a new shared chat: another tool of the same connection, no card
    const p = callsOf('get_profile_update')
    const there = await askCards('alice', (await newShared()).id, via(T('get_profile_update'), { url: 'https://example.com/b' }), last)
    expect(there.cards).toEqual([])
    expect(callsOf('get_profile_update')).toBe(p + 1)
    // her scheduled run in a shared chat: no card (nobody could answer one), it runs
    const run = await runTask((await newShared()).id, via(T('get_profile_update'), { url: 'https://example.com/c' }))
    expect(toolOk(run, T('get_profile_update'))).toBe(1)
    expect(callsOf('get_profile_update')).toBe(p + 2)
    // Settings › Allowed for Trina: one entry for the connection
    const rows = (await allowances()).filter((a) => a.kind === 'connector_tool' && a.warned === undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'connector_tool', connection: 'Bright Data', all: true })
    // removed there: the card again, in a new chat and nothing in the scheduled run
    await h.api('alice').call(API.deleteAiAllowance, { params: { id: rows[0]!.id } })
    expect(grants('alice')).toEqual([])
    const again = await askCards('alice', (await newShared()).id, via(T('get_profile_update'), { url: 'https://example.com/d' }), last)
    expect(again.cards.length).toBe(1)
    const run2 = await runTask((await newShared()).id, via(T('get_profile_update'), { url: 'https://example.com/e' }))
    expect(toolOk(run2, T('get_profile_update'))).toBe(0)
  })

  test('it is the person’s own: bob still asks', async () => {
    clear()
    await askCards('alice', (await newShared()).id, via(T('get_post')), () => 'all')
    const bob = await askCards('bob', (await newShared('bob')).id, via(T('get_post')), last)
    expect(bob.cards.length).toBe(1)
  })

  test('a moved connection, the team switch off or a lost access ends it; a change still asks every time', async () => {
    clear()
    await askCards('alice', (await newShared()).id, via(T('get_post')), () => 'all')
    db().query("UPDATE connector_tool_allow SET url = 'https://elsewhere.example.com/mcp'").run()
    warnedIn(db(), `p:${projectId}`)
    expect((await askCards('alice', (await newShared()).id, via(T('get_profile_update')), last)).cards.length).toBe(1)
    expect(grants('alice')).toEqual([])
    await askCards('alice', (await newShared()).id, via(T('get_post')), () => 'all')
    updateTeamSettings(db(), { roomAlwaysAllow: false })
    try {
      const off = await askCards('alice', (await newShared()).id, via(T('get_profile_update')), last)
      expect(off.cards.length).toBe(1)
      expect(off.cards[0]!.options.map((o) => o.value)).toEqual(['allow', 'deny'])
    } finally { updateTeamSettings(db(), { roomAlwaysAllow: true }) }
    expect((await askCards('alice', (await newShared()).id, via(T('get_profile_update')), last)).cards).toEqual([])
    // a change at the team connection in a shared chat: its own card every time, no Always
    const n = callsOf('resend_invoice')
    const w = await askCards('alice', (await newShared()).id, via(T('resend_invoice'), { to: 'x@example.com' }), last)
    expect(w.cards.length).toBe(1)
    expect(w.cards[0]!.options.map((o) => o.value)).not.toContain('all')
    expect(callsOf('resend_invoice')).toBe(n)
    setAccess(db(), teamId, { everyone: false, groups: [], users: ['bob'] })
    expect(grants('alice')).toEqual([])
    setAccess(db(), teamId, { everyone: true, groups: [], users: [] })
    // (a lost access took the notice too: seen again here, the tool's own card is the subject)
    warnedIn(db(), `p:${projectId}`)
    expect((await askCards('alice', (await newShared()).id, via(T('get_profile_update')), last)).cards.length).toBe(1)
  })
})

describe('migration 445', () => {
  test('removes the per-chat rows and keeps the permanent ones', () => {
    const chat = (db().query('SELECT id FROM chats LIMIT 1').get() as { id: string }).id
    const t = new Date().toISOString()
    db().query('DELETE FROM chat_card_approvals').run()
    for (const kind of ['shared_connection', 'shared_unsure_tool', 'shared_own_act', 'card_always', 'file_change', 'connector'])
      db().query('INSERT INTO chat_card_approvals (chat_id, user_id, kind, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(chat, 'alice', kind, 'x', '{}', t)
    db().query('INSERT OR IGNORE INTO chat_allowed_sites (chat_id, user_id, site) VALUES (?, ?, ?)').run(chat, 'alice', 'example.com')
    db().query('INSERT OR IGNORE INTO user_allowed_sites (user_id, site, chat_id, created_at) VALUES (?, ?, ?, ?)').run('alice', 'kept.example', chat, t)
    db().query("INSERT OR IGNORE INTO card_always_allow (user_id, kind, created_at) VALUES ('alice', 'remember', ?)").run(t)
    db().exec(fs.readFileSync(path.join(ROOT, 'server/migrations/445_b_one_always_allow.sql'), 'utf8'))
    expect((db().query("SELECT kind FROM chat_card_approvals WHERE user_id = 'alice' ORDER BY kind").all() as { kind: string }[]).map((r) => r.kind)).toEqual(['connector', 'file_change'])
    expect(db().query('SELECT COUNT(*) n FROM chat_allowed_sites').get()).toEqual({ n: 0 })
    expect(db().query("SELECT COUNT(*) n FROM user_allowed_sites WHERE user_id = 'alice' AND site = 'kept.example'").get()).toEqual({ n: 1 })
    expect(db().query("SELECT COUNT(*) n FROM card_always_allow WHERE user_id = 'alice' AND kind = 'remember'").get()).toEqual({ n: 1 })
    db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run()
    db().query('DELETE FROM chat_card_approvals').run()
  })
})
