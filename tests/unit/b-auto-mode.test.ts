// Auto mode (server/src/chat/auto-mode.ts, chat/always-allow.ts autoHere; docs/decisions/20261125-auto-mode.md). Covered:
// the settings (team off by default, allowed, default; the person's own value; the team's "Always allow" off turns it
// off; a guest never), where it applies (the person's own app only: never a scheduled run, Slack, a draft or a
// confidential chat; never with a guest in the turn; an auto-if kind only with a clean floor and a chat that read
// nothing of other people or from outside), the floor kinds (always ask), precedence with Always (Always first, auto
// never writes an Always), the audit rows, the 20-a-day pause, the API (GET/PUT, 409 when the team is off), and real
// answers (a safe copy goes without its card and is audited, a floor card still asks, the team value off brings it back).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, AUTO_KINDS, CARD_ALWAYS_KINDS, type CardAlwaysKind, type TurnRequest } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { RAN_UNDER_AUTO, autoHere, keepAlways, withAlways, type AlwaysPlace } from '../../server/src/chat/always-allow'
import { AUTO_DAY_LIMIT, autoModeAvailable, autoModeOn, autoModeTeam, recentAutoApprovals, setAutoMode } from '../../server/src/chat/auto-mode'
import { getTeamSettings, updateTeamSettings } from '../../server/src/admin/settings'
import { AUTO_WHAT } from '../../server/src/chat/i18n'

setDefaultTimeout(60_000)
let h: Harness
const socks: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-auto-mode', askUserTimeoutMs: 4000, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'carol']) { socks[u] = await h.ws(u, { windowId: `win-am-${u}` }); await socks[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(socks)) s.close(); await h.close() })

const db = () => h.ctx.db
const team = (v: 'off' | 'allowed' | 'default') => updateTeamSettings(db(), { autoMode: v })
const person = (id: string, v: 0 | 1 | null) => db().query('UPDATE users SET auto_mode = ? WHERE id = ?').run(v, id)
const clean = () => {
  db().query('DELETE FROM card_always_allow').run()
  db().query("DELETE FROM audit_log WHERE action IN ('ai.auto_allow', 'ai.auto_mode', 'admin.auto_mode')").run()
  db().query('UPDATE users SET auto_mode = NULL').run()
  team('off')
}
const autoRows = (userId = 'alice') => (db().query("SELECT detail FROM audit_log WHERE action = 'ai.auto_allow' AND actor_id = ?").all(userId) as { detail: string }[]).map((r) => JSON.parse(r.detail) as Record<string, unknown>)
const alwaysRows = () => db().query('SELECT COUNT(*) AS n FROM card_always_allow').get() as { n: number }

/** a watched turn of alice with no guest and a clean chat; `ran` collects the kinds auto mode approved */
function place(o: Partial<AlwaysPlace> = {}, ran: CardAlwaysKind[] = []): AlwaysPlace {
  return { db: db(), userId: 'alice', chatId: 'chat-auto', turnId: 'turn-auto', locale: 'en', clientKind: 'web', guestAmong: () => false, reads: () => ({ others: false, outside: false }), ranAuto: (k) => ran.push(k), ...o }
}
const FREE = { floorFree: true }
const YES_NO = [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]

describe('settings', () => {
  test('off for every team by default; allowed: each person opts in; default: on until the person turns it off', () => {
    clean()
    expect(getTeamSettings(db()).autoMode).toBe('off')
    expect(autoModeTeam(db())).toBe('off')
    expect(autoModeAvailable(db(), 'alice')).toBe(false)
    person('alice', 1)
    // the person's own value counts only while the team allows it
    expect(autoModeOn(db(), 'alice')).toBe(false)
    team('allowed')
    expect(autoModeOn(db(), 'alice')).toBe(true)
    expect(autoModeOn(db(), 'carol')).toBe(false)
    team('default')
    expect(autoModeOn(db(), 'carol')).toBe(true)
    person('carol', 0)
    expect(autoModeOn(db(), 'carol')).toBe(false)
    clean()
  })

  test('the team\'s "Always allow" switch off turns auto mode off; on again, it counts', () => {
    clean()
    team('allowed'); person('alice', 1)
    updateTeamSettings(db(), { roomAlwaysAllow: false })
    try {
      expect(autoModeTeam(db())).toBe('off')
      expect(autoModeOn(db(), 'alice')).toBe(false)
      expect(autoHere(place(), 'big_download')).toBeNull()
    } finally { updateTeamSettings(db(), { roomAlwaysAllow: true }) }
    expect(autoModeOn(db(), 'alice')).toBe(true)
    clean()
  })

  test('a guest never has auto mode, and a turn with a guest among the people never uses it', () => {
    clean()
    team('default')
    db().query("UPDATE users SET guest = 1 WHERE id = 'erin'").run()
    try {
      expect(autoModeAvailable(db(), 'erin')).toBe(false)
      expect(setAutoMode(db(), 'erin', true, 'settings')).toBe(false)
    } finally { db().query("UPDATE users SET guest = 0 WHERE id = 'erin'").run() }
    expect(autoHere(place({ guestAmong: () => true }), 'big_download')).toBeNull()
    // no way to tell: fails closed
    expect(autoHere(place({ guestAmong: undefined }), 'big_download')).toBeNull()
    expect(autoHere(place({ guestAmong: () => { throw new Error('x') } }), 'big_download')).toBeNull()
    clean()
  })

  test('setAutoMode: audited once per change, on refused while the team is off', () => {
    clean()
    expect(setAutoMode(db(), 'alice', true, 'pill')).toBe(false)
    team('allowed')
    expect(setAutoMode(db(), 'alice', true, 'pill')).toBe(true)
    expect(setAutoMode(db(), 'alice', true, 'pill')).toBe(true)
    expect(setAutoMode(db(), 'alice', false, 'settings')).toBe(false)
    const rows = (db().query("SELECT detail FROM audit_log WHERE action = 'ai.auto_mode' AND actor_id = 'alice' ORDER BY id").all() as { detail: string }[]).map((r) => JSON.parse(r.detail))
    expect(rows).toEqual([{ on: true, via: 'pill' }, { on: false, via: 'settings' }])
    clean()
  })
})

describe('where it applies', () => {
  test('the person\'s own app only: never a scheduled run, Slack, a restricted turn (a draft) or a confidential chat', async () => {
    clean()
    team('allowed'); person('alice', 1)
    for (const k of ['web', 'desktop', 'mobile']) expect(autoHere(place({ clientKind: k }), 'big_download'), k).toBe('auto')
    for (const k of ['schedule', 'slack', null]) expect(autoHere(place({ clientKind: k }), 'big_download'), String(k)).toBeNull()
    expect(autoHere(place({ restricted: true }), 'big_download')).toBeNull()
    expect(autoHere(null, 'big_download')).toBeNull()
    const conf = (await h.api('alice').call(API.createChat, { body: {} })).id
    db().query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(conf)
    try { expect(autoHere(place({ chatId: conf }), 'big_download')).toBeNull() } finally { db().query('DELETE FROM safe_ops_chats WHERE chat_id = ?').run(conf) }
    clean()
  })

  test('an auto-if kind needs the call\'s floor and a chat that read nothing of other people or from outside', () => {
    clean()
    team('allowed'); person('alice', 1)
    expect(autoHere(place(), 'move_files', FREE)).toBe('auto-if')
    expect(autoHere(place(), 'move_files')).toBeNull()
    expect(autoHere(place(), 'move_files', { floorFree: false })).toBeNull()
    expect(autoHere(place({ reads: () => ({ others: true, outside: false }) }), 'move_files', FREE)).toBeNull()
    expect(autoHere(place({ reads: () => ({ others: false, outside: true }) }), 'move_files', FREE)).toBeNull()
    expect(autoHere(place({ reads: undefined }), 'move_files', FREE)).toBeNull()
    // an auto kind needs no floor and may follow content from outside, never other people's words (security review:
    // a tool's own card can stand in for the room card)
    expect(autoHere(place({ reads: () => ({ others: false, outside: true }) }), 'bulk_files')).toBe('auto')
    expect(autoHere(place({ reads: () => ({ others: true, outside: false }) }), 'bulk_files')).toBeNull()
    expect(autoHere(place({ reads: undefined }), 'bulk_files')).toBeNull()
    clean()
  })

  test('shared chats follow the same rules: with no guest the auto kinds go, after other people\'s words the auto-if kinds ask', () => {
    clean()
    team('allowed'); person('alice', 1)
    // a shared chat nobody else wrote in (D5): as her own chat
    const shared = place({ chatId: 'chat-auto-shared', reads: () => ({ others: false, outside: false }) })
    expect(autoHere(shared, 'save_wider', FREE)).toBe('auto-if')
    // someone else wrote there: their words are in the chat
    expect(autoHere({ ...shared, reads: () => ({ others: true, outside: false }) }, 'save_wider', FREE)).toBeNull()
    expect(autoHere({ ...shared, reads: () => ({ others: true, outside: false }) }, 'big_download')).toBeNull()
    // a guest among the people: nothing
    expect(autoHere({ ...shared, guestAmong: () => true }, 'big_download')).toBeNull()
    clean()
  })

  test('the floor kinds always ask, whatever the call says', () => {
    clean()
    team('default')
    const floor = CARD_ALWAYS_KINDS.filter((k) => AUTO_KINDS[k] === 'ask')
    expect(floor).toEqual(expect.arrayContaining(['delete_files', 'video', 'post_to_room', 'post_files', 'share_files', 'share_folder', 'folder_access', 'project_members', 'skill_save', 'dev_login', 'remember', 'room_change', 'shared_read', 'shared_save']))
    for (const k of floor) expect(autoHere(place(), k, FREE), k).toBeNull()
    clean()
  })

  test(`after ${AUTO_DAY_LIMIT} approvals in one chat in one day the cards come back there, with one pause line`, () => {
    clean()
    team('allowed'); person('alice', 1)
    let paused = 0
    for (let i = 0; i < AUTO_DAY_LIMIT; i++) db().query("INSERT INTO audit_log (actor_id, action, target, detail, at) VALUES ('alice', 'ai.auto_allow', 'alice', ?, ?)").run(JSON.stringify({ kind: 'big_download', chatId: 'chat-auto-many' }), new Date().toISOString())
    expect(autoHere(place({ chatId: 'chat-auto-many', autoPaused: () => { paused++ } }), 'big_download')).toBeNull()
    expect(paused).toBe(1)
    // a check only (a summary's label): no pause step
    expect(autoHere(place({ chatId: 'chat-auto-many', autoPaused: () => { paused++ } }), 'big_download', undefined, { quiet: true })).toBeNull()
    expect(paused).toBe(1)
    // another chat is not paused
    expect(autoHere(place({ chatId: 'chat-auto-other' }), 'big_download')).toBe('auto')
    clean()
  })
})

describe('withAlways: precedence and audit', () => {
  test('on: no card, the yes at once, one audit row and the step; never an Always row', async () => {
    clean()
    team('allowed'); person('alice', 1)
    const ran: CardAlwaysKind[] = []
    let asked = 0
    const v = await withAlways(place({}, ran), 'move_files', YES_NO, 'yes', async () => { asked++; return 'no' }, 'cardAlways', FREE)
    expect(v).toBe('yes')
    expect(asked).toBe(0)
    expect(ran).toEqual(['move_files'])
    expect(autoRows()).toEqual([{ kind: 'move_files', chatId: 'chat-auto', turnId: 'turn-auto', rule: 'auto-if' }])
    expect(alwaysRows().n).toBe(0)
    expect(recentAutoApprovals(db(), 'alice').map((r) => r.kind)).toEqual(['move_files'])
    expect(recentAutoApprovals(db(), 'carol')).toEqual([])
    clean()
  })

  test('a floor card shows (with its Always offer) and nothing is audited', async () => {
    clean()
    team('default')
    let shown: string[] = []
    await withAlways(place(), 'delete_files', YES_NO, 'yes', async (o) => { shown = o.map((x) => x.value); return 'no' }, 'cardAlways', FREE)
    expect(shown).toEqual(['yes', '__always', 'no'])
    expect(autoRows()).toEqual([])
    clean()
  })

  test('the person\'s own Always wins and is not an auto approval; off again, every card comes back', async () => {
    clean()
    team('allowed'); person('alice', 1)
    keepAlways(db(), 'alice', 'move_files', null)
    expect(await withAlways(place(), 'move_files', YES_NO, 'yes', async () => 'no', 'cardAlways', FREE)).toBe('yes')
    expect(autoRows()).toEqual([])
    db().query('DELETE FROM card_always_allow').run()
    setAutoMode(db(), 'alice', false, 'settings')
    let asked = 0
    await withAlways(place(), 'move_files', YES_NO, 'yes', async () => { asked++; return 'no' }, 'cardAlways', FREE)
    expect(asked).toBe(1)
    clean()
  })

  test('the team value off forces the card', async () => {
    clean()
    person('alice', 1)
    let asked = 0
    await withAlways(place(), 'big_download', YES_NO, 'yes', async () => { asked++; return 'no' })
    expect(asked).toBe(1)
    clean()
  })

  test('every kind auto mode lets go has its step words in every language', () => {
    for (const k of CARD_ALWAYS_KINDS.filter((x) => AUTO_KINDS[x] !== 'ask')) for (const l of ['ko', 'en', 'id', 'ja', 'es', 'zh'] as const) expect((AUTO_WHAT as Record<string, Record<string, string>>)[k]?.[l], `${k} ${l}`).toBeTruthy()
  })
})

describe('API', () => {
  test('GET and PUT /api/ai-allowances/auto-mode; 409 while the team is off; Me says it', async () => {
    clean()
    const off = await h.api('alice').call(API.getAutoMode)
    expect(off).toMatchObject({ available: false, on: false, team: 'off', recent: [] })
    const r = await h.req('alice', '/api/ai-allowances/auto-mode', { method: 'PUT', headers: { 'x-mycel-csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ on: true, via: 'pill' }) })
    expect(r.status).toBe(409)
    await h.api('carol').call(API.updateSettings, { body: { autoMode: 'allowed' } })
    expect((db().query("SELECT detail FROM audit_log WHERE action = 'admin.auto_mode'").get() as { detail: string }).detail).toBe(JSON.stringify({ from: 'off', to: 'allowed' }))
    expect(await h.api('alice').call(API.getAutoMode)).toMatchObject({ available: true, on: false, team: 'allowed' })
    expect((await h.api('alice').call(API.setAutoMode, { body: { on: true, via: 'pill' } })).on).toBe(true)
    expect(autoModeOn(db(), 'alice')).toBe(true)
    // only her own: bob's stays off
    expect((await h.api('bob').call(API.getAutoMode)).on).toBe(false)
    clean()
  })
})

// in a real answer: the copy card of a file of her own folder into a folder the whole team sees (files.copy, auto-if)
describe('in a real answer', () => {
  const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
  const cm = () => 'cm-' + crypto.randomUUID()
  const abs = (rel: string) => path.join(h.team, rel)
  type Ask = TurnRequest & { requestId: string; options?: { label: string; value: string }[] }
  async function turn(user: string, content: string, answer: string) {
    const chatId = (await h.api(user).call(API.createChat, { body: {} })).id
    const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
    const cards: Ask[] = []
    const seen = new Set<string>()
    for (let waited = 0; ; waited += 50) {
      if (waited > 60_000) throw new Error('the answer did not end')
      for (const f of socks[user]!.frames) {
        if (f.type !== 'turn.request' || f.data.turnId !== r.turnId || seen.has(f.data.request.requestId)) continue
        seen.add(f.data.request.requestId)
        cards.push(f.data.request as Ask)
        await h.api(user).call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: f.data.request.requestId, answer } })
      }
      const done = socks[user]!.frames.find((f) => f.type === 'message.done' && f.data.messageId === r.assistantMessage.id)
      if (done && done.type === 'message.done') return { chatId, turnId: r.turnId, cards, message: done.data.message as { content: string; steps?: { tool?: string; label: string }[] } }
      await Bun.sleep(50)
    }
  }
  const own = (n: string) => { fs.mkdirSync(path.dirname(abs(`users/alice/${n}`)), { recursive: true }); fs.writeFileSync(abs(`users/alice/${n}`), 'note\n') }

  test('a safe card (her own file copied where the team sees it) goes without its card, audited, with its step', async () => {
    clean()
    team('allowed'); person('alice', 1)
    try {
      own('am-copy-1.md')
      const r = await turn('alice', fake({ tool: 'copy_files', args: { paths: ['users/alice/am-copy-1.md'], to_folder: 'shared' } }, { say: 'done' }), 'deny')
      expect(r.cards).toEqual([])
      expect(fs.existsSync(abs('shared/am-copy-1.md'))).toBe(true)
      expect(autoRows()).toEqual([{ kind: 'move_files', chatId: r.chatId, turnId: r.turnId, rule: 'auto-if' }])
      expect(r.message.steps?.some((s) => s.tool === 'auto_mode' && s.label.startsWith('Done in auto mode'))).toBe(true)
      // the AI is told it ran under auto mode (the tool result), never that the person approved
      const ev = db().query("SELECT summary FROM tool_events WHERE turn_id = ? AND tool = 'copy_files'").get(r.turnId) as { summary: string } | null
      expect(ev?.summary).toContain('auto mode, no card')
      expect(RAN_UNDER_AUTO).toContain('never say they approved')
    } finally { clean() }
  })

  test('a save auto mode approved is not kept as the person\'s approval for the chat (security review)', async () => {
    clean()
    team('allowed'); person('alice', 1)
    try {
      // a file an AI turn of hers wrote from nothing outside is her own (a file put there by hand counts as outside, QA
      // TC-326), and only the person can see it
      const made = await turn('alice', fake({ tool: 'write', args: { file_path: 'users/alice/am-src.md', content: 'my own note\n' } }, { say: 'done' }), 'skip')
      expect(made.cards).toEqual([])
      const r = await turn('alice', fake({ tool: 'read', args: { file_path: 'users/alice/am-src.md' } }, { tool: 'write', args: { file_path: 'shared/am-wider.md', content: 'from my note\n' } }, { say: 'done' }), 'skip')
      expect(r.cards).toEqual([])
      expect(fs.existsSync(abs('shared/am-wider.md'))).toBe(true)
      expect(autoRows().map((d) => d.kind)).toContain('save_wider')
      expect(db().query("SELECT COUNT(*) AS n FROM chat_card_approvals WHERE chat_id = ? AND kind = 'save_wider'").get(r.chatId)).toEqual({ n: 0 })
    } finally { clean() }
  })

  test('a floor card still asks: a file of someone else copied where the team sees it', async () => {
    clean()
    team('default')
    try {
      const r = await turn('alice', fake({ tool: 'copy_files', args: { paths: ['groups/marketing/campaign-brief.md'], to_folder: 'shared' } }, { say: 'done' }), 'deny')
      expect(r.cards.length).toBe(1)
      expect(autoRows()).toEqual([])
    } finally { clean() }
  })

  test('the team value off forces the card for the same safe copy', async () => {
    clean()
    person('alice', 1)
    try {
      own('am-copy-2.md')
      const r = await turn('alice', fake({ tool: 'copy_files', args: { paths: ['users/alice/am-copy-2.md'], to_folder: 'shared' } }, { say: 'done' }), 'deny')
      expect(r.cards.length).toBe(1)
      expect(fs.existsSync(abs('shared/am-copy-2.md'))).toBe(false)
      expect(autoRows()).toEqual([])
    } finally { clean() }
  })
})
