// "Always allow" holds everywhere (docs/decisions/20261122-always-allow-holds-everywhere.md, Rule A: the owner,
// 2026-11-22, "이렇게 또 권한을 매번 대화마다 다 해줘야하는 미친 상황 더 없겠지?"). For each item of the permission audit: the
// person allows once, then there is no card in a new chat and none in their scheduled run (also in a shared chat a
// teammate wrote in); they remove it in Settings › Allowed for Trina (DELETE /api/ai-allowances/:id) and the card comes
// back. A guest among the people of a shared chat changes nothing: there is one Always (docs/decisions/
// 20261123-one-always-allow.md); only the share and post checks of what the asker named still hold there.
// B3 a site for good ("이 사이트 항상 허용") and the in-app browser's office-network sites in Settings; B4 share, room post
// and folder share in a shared chat whose asker's message names nobody; B5 a room post that mentions everyone; B6 a
// scheduled run in a shared chat a teammate wrote in; M2 a dev environment command that can use a login.
// Uses the shared project chat fixture of b-shared-chat-schedules: projects/falcon, alice writes it, bob reads it.
import dnsP from 'node:dns/promises'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type AiAllowance, type Room } from '@mycel/shared/api'
import { uuidv7 } from '@mycel/shared'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'
import { noteEgressIp } from '../../server/src/tools/egress'
import { updateTeamSettings } from '../../server/src/admin/settings'
import { gateUrl, type ConfirmExtra, type TurnPerson } from '../../server/src/tools/url-gate'
import { ALWAYS_VALUE, alwaysHere, keepAlways, withAlways, type AlwaysPlace } from '../../server/src/chat/always-allow'
import { steerableRun } from '../../server/src/chat/shared-run'
import { askLoginAfterOthers } from '../../server/src/devenv/tool'

setDefaultTimeout(90_000)

// no real name lookups (B3 gates addresses only; nothing is fetched)
const original = dnsP.lookup
;(dnsP as unknown as { lookup: unknown }).lookup = async () => { throw Object.assign(new Error('stub: not resolved'), { code: 'ENOTFOUND' }) }

const cm = () => 'cm-' + crypto.randomUUID()
// the fake engine's directives in the person's message, their strings spelled as JSON escapes: the person's own words
// are only what the test writes around them (so "the asker's own message names nobody")
const opaque = (j: string) => j.replace(/"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/\\.|[\p{L}\p{N}]/gu, (c) => (c.length > 1 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)))
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + opaque(JSON.stringify(d))).join('\n')
const plainFake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId = ''
let teamRoom = ''
const db = () => h.ctx.db
const now = () => new Date().toISOString()
const farTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + 12 * 3_600_000))
const put = (rel: string, body: string) => {
  const abs = path.join(h.ctx.files.fx.root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

beforeAll(async () => {
  h = await startHarness({ name: 'b-always-holds-everywhere', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000, timeZone: 'Asia/Seoul' })
  noteEgressIp(h.ctx, '198.51.100.7')
  // the contract's group ids (and a team room's groupId) are UUIDv7; the fixture's are short
  db().exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db().query(sql).run(id, g)
  }
  db().exec('PRAGMA foreign_keys = ON')
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u, { windowId: `win-holds-${u}` }); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  const rooms = (await h.api('alice').call(API.listRooms)).items as Room[]
  teamRoom = rooms.find((r) => r.kind === 'team')!.id
  for (const n of [1, 2, 3, 4, 5, 6]) put(`users/alice/ledger-${n}.txt`, `ledger ${n}`)
  for (const n of [1, 2, 3]) put(`users/alice/work-${n}/plan.md`, `plan ${n}`)
})
afterAll(async () => {
  ;(dnsP as unknown as { lookup: unknown }).lookup = original
  for (const s of Object.values(ws)) s.close()
  await h?.close()
})

const newShared = async (user = 'alice') => (await h.api(user).call(API.createChat, { body: { projectId } })).id as string
/** One turn of `user`; a card it raises is left unanswered (it ends by itself). The cards it raised and the answer. */
async function turn(user: string, chatId: string, content: string) {
  const r = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 40_000)
  const cards = ws[user]!.frames.filter((f) => f.type === 'turn.request' && (f as { data: { turnId?: string } }).data.turnId === r.turnId)
    .map((f) => (f as unknown as { data: { request: { question?: string; options?: { label: string; value: string }[]; requestId: string } } }).data.request)
  return { turnId: r.turnId as string, content: done.data.message.content as string, cards }
}
/** a shared chat alice and bob both wrote in (bob's message asks for nothing) */
async function sharedChatBobWroteIn(): Promise<string> {
  const id = await newShared()
  await turn('alice', id, plainFake({ say: 'hello' }))
  await turn('bob', id, plainFake({ say: 'noted' }) + '\nthanks')
  return id
}
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
const allowances = async (user = 'alice') => (await h.api(user).call(API.listAiAllowances)).items as AiAllowance[]
const removeInSettings = async (id: string, user = 'alice') => h.api(user).call(API.deleteAiAllowance, { params: { id } })
const shared = (p: string) => !!db().query('SELECT 1 FROM file_shares WHERE path = ?').get(p)
const toolOk = (turnId: string, tool: string) => (db().query('SELECT ok FROM tool_events WHERE turn_id = ? AND tool = ? ORDER BY rowid DESC LIMIT 1').get(turnId, tool) as { ok: number } | null)?.ok

// ---------------- B3: a site for good ----------------
type Asked = { question: string; options?: { label: string; value: string }[]; extra?: ConfirmExtra }
function person(answer: string | null, asked: Asked[], o: { forGood?: boolean; scheduled?: boolean } = {}): TurnPerson {
  return {
    locale: 'en',
    async confirm(question, _a, _d, extra) { asked.push({ question, extra }); return answer === 'allow' },
    async choose(question, options, extra) { asked.push({ question, options, extra }); return answer },
    turnUrls: () => [],
    sitesForGood: () => o.forGood !== false,
    ...(o.scheduled ? { unattended: true, scheduledRun: () => true } : {}),
  }
}
async function ownChat(user = 'alice') {
  const chat = await h.api(user).call(API.createChat, { body: {} })
  db().query("INSERT INTO messages (id, chat_id, role, author_id, content, status) VALUES (?, ?, 'user', ?, 'hello', 'done')").run(uuidv7(), chat.id, user)
  return chat.id as string
}
const gate = (chat: string, url: string, p: TurnPerson | null, user = 'alice') => gateUrl(db(), chat, url, p, { turnId: 't-holds', userId: user })

describe('B3: "이 사이트 항상 허용" is for good, listed and removable in Settings', () => {
  test('allowed once: no card in a new chat, a shared chat or a scheduled run; removed in Settings: the card again', async () => {
    const asked: Asked[] = []
    const first = await ownChat()
    expect(await gate(first, 'https://news.forgood.example/a', person('site', asked))).toBe('confirmed')
    // the card says "always", in every chat, and how to undo it
    expect(asked[0]!.options!.find((x) => x.value === 'site')!.label).toBe('Always allow this site (forgood.example)')
    expect(asked[0]!.question).toContain('in all your chats from now on')
    expect(asked[0]!.question).toContain('Settings › Allowed for Trina')
    expect(db().query('SELECT site FROM user_allowed_sites WHERE user_id = ?').all('alice')).toEqual([{ site: 'forgood.example' }])
    // a new chat of hers, a shared chat she asks in, and her scheduled run: no card
    const none: Asked[] = []
    expect(await gate(await ownChat(), 'https://forgood.example/b', person(null, none))).toBe('site')
    expect(await gate(await newShared(), 'https://www.forgood.example/c', person(null, none))).toBe('site')
    expect(await gate(await ownChat(), 'https://forgood.example/d', person(null, none, { scheduled: true }))).toBe('site')
    expect(none).toHaveLength(0)
    // never another person's: bob is asked
    const bobAsked: Asked[] = []
    await expect(gate(await ownChat('bob'), 'https://forgood.example/e', person(null, bobAsked), 'bob')).rejects.toThrow(/did not allow/)
    expect(bobAsked).toHaveLength(1)
    // Settings lists it (a web site), and removing it brings the card back
    const row = (await allowances()).find((a) => a.kind === 'site' && a.site === 'forgood.example')!
    expect(row).toMatchObject({ kind: 'site', place: 'web' })
    await removeInSettings(row.id)
    expect((await allowances()).some((a) => a.kind === 'site' && a.site === 'forgood.example')).toBe(false)
    const again: Asked[] = []
    await expect(gate(await ownChat(), 'https://forgood.example/f', person(null, again))).rejects.toThrow(/did not allow/)
    expect(again).toHaveLength(1)
    // another person cannot remove hers
    await gate(await ownChat(), 'https://news.forgood.example/g', person('site', []))
    const mine = (await allowances()).find((a) => a.kind === 'site' && a.site === 'forgood.example')!
    await expect(removeInSettings(mine.id, 'bob')).rejects.toThrow()
    await removeInSettings(mine.id)
  })

  test('no site for this chat only: a turn whose sites cannot be kept (a Slack question, a draft) or the team\'s switch off offers none and keeps none', async () => {
    const asked: Asked[] = []
    const chat = await newShared()
    await gate(chat, 'https://guestchat.example/a', person('allow', asked, { forGood: false }))
    expect(asked[0]!.options?.map((x) => x.value) ?? []).not.toContain('site')
    expect(db().query("SELECT site FROM user_allowed_sites WHERE user_id = 'alice' AND site = 'guestchat.example'").get()).toBeNull()
    expect(db().query('SELECT COUNT(*) n FROM chat_allowed_sites').get()).toEqual({ n: 0 })
    // the team's "Always allow" switch off: rows for good are ignored, and the card offers no site
    await gate(await ownChat(), 'https://switch.example/a', person('site', []))
    updateTeamSettings(db(), { roomAlwaysAllow: false })
    try {
      const off: Asked[] = []
      await expect(gate(await ownChat(), 'https://switch.example/b', person(null, off))).rejects.toThrow(/did not allow/)
      expect(off[0]!.options?.map((x) => x.value) ?? []).not.toContain('site')
    } finally { updateTeamSettings(db(), { roomAlwaysAllow: true }) }
    expect(await gate(await ownChat(), 'https://switch.example/c', person(null, []))).toBe('site')
  })

  test('the in-app browser\'s office-network sites ("항상 허용") are listed and removable too', async () => {
    h.rt().grantSite('alice', '10.0.0.5')
    expect(h.rt().siteGranted('alice', '10.0.0.5')).toBe(true)
    const row = (await allowances()).find((a) => a.kind === 'site' && a.place === 'office')!
    expect(row).toMatchObject({ kind: 'site', site: '10.0.0.5', place: 'office' })
    await removeInSettings(row.id)
    expect(h.rt().siteGranted('alice', '10.0.0.5')).toBe(false)
  })
})

// ---------------- B4, B5, B6: shares and posts in shared chats, and their scheduled runs ----------------
const shareCall = (n: number) => fake({ tool: 'share_with_person', args: { paths: [`users/alice/ledger-${n}.txt`], people: ['Erin Yoo'] }, sayResult: true })
const folderCall = (n: number) => fake({ tool: 'share_folder', args: { folder: `users/alice/work-${n}`, add: ['Erin Yoo'] }, sayResult: true })
const postCall = (text: string, mention?: string[]) => fake({ tool: 'post_to_room', args: { room: teamRoom, text, ...(mention ? { mention } : {}) }, sayResult: true })
const posted = (text: string) => !!db().query('SELECT 1 FROM room_messages WHERE room_id = ? AND author_id = ? AND body LIKE ?').get(teamRoom, 'alice', `%${text}%`)

describe('B4: share_with_person in a shared chat, the asker\'s message naming nobody', () => {
  test('Always allow once: no card in that chat, a new shared chat or the scheduled run a teammate wrote in; removed: the card', async () => {
    const chat = await sharedChatBobWroteIn()
    // the first card (her message names the file, nobody to get it) offers Always allow
    const r1 = await turn('alice', chat, `please share ledger-1.txt\n${shareCall(1)}`)
    expect(r1.cards).toHaveLength(1)
    expect(r1.cards[0]!.options!.map((o) => o.value)).toContain('__always')
    keepAlways(db(), 'alice', 'share_files', r1.turnId)
    // the same chat and a new shared chat: no card, shared
    expect((await turn('alice', chat, `please\n${shareCall(2)}`)).cards).toHaveLength(0)
    expect(shared('users/alice/ledger-2.txt')).toBe(true)
    const other = await sharedChatBobWroteIn()
    expect((await turn('alice', other, `please\n${shareCall(3)}`)).cards).toHaveLength(0)
    expect(shared('users/alice/ledger-3.txt')).toBe(true)
    // her scheduled run in the shared chat bob wrote in (B6): shared, nobody asked
    const run = await runTask(other, plainFake({ tool: 'share_with_person', args: { paths: ['users/alice/ledger-4.txt'], people: ['Erin Yoo'] }, sayResult: true }))
    expect(steerableRun(db(), run)).toBe(true)
    expect(shared('users/alice/ledger-4.txt')).toBe(true)
    // removed in Settings: the card again
    await removeInSettings('card:share_files')
    expect((await turn('alice', chat, `please share ledger-5.txt\n${shareCall(5)}`)).cards).toHaveLength(1)
    expect(shared('users/alice/ledger-5.txt')).toBe(false)
  })
})

describe('B4: share_folder in a shared chat', () => {
  test('Always allow once: no card in a new shared chat or the scheduled run; a stop in a run is refused; removed: the card', async () => {
    const chat = await sharedChatBobWroteIn()
    const r1 = await turn('alice', chat, `please share the folder "work-1" with Erin Yoo\n${folderCall(1)}`)
    expect(r1.cards).toHaveLength(1)
    expect(r1.cards[0]!.options!.map((o) => o.value)).toContain('__always')
    keepAlways(db(), 'alice', 'share_folder', r1.turnId)
    const other = await sharedChatBobWroteIn()
    const r2 = await turn('alice', other, `please\n${folderCall(2)}`)
    expect(r2.cards).toHaveLength(0)
    expect(toolOk(r2.turnId, 'share_folder')).toBe(1)
    const run = await runTask(other, plainFake({ tool: 'share_folder', args: { folder: 'users/alice/work-3', add: ['Erin Yoo'] }, sayResult: true }))
    expect(toolOk(run, 'share_folder')).toBe(1)
    // a stop has no Always: refused in a run, where nobody answers its card
    const stop = await runTask(other, plainFake({ tool: 'share_folder', args: { folder: 'users/alice/work-3', stop: true }, sayResult: true }))
    expect(toolOk(stop, 'share_folder')).toBe(0)
    await removeInSettings('card:share_folder')
    const r3 = await turn('alice', other, `please share the folder "work-1" with Bob Lee\n${fake({ tool: 'share_folder', args: { folder: 'users/alice/work-1', add: ['Bob Lee'] }, sayResult: true })}`)
    expect(r3.cards).toHaveLength(1)
  })
})

describe('B4 and B5: post_to_room in a shared chat, also mentioning everyone', () => {
  test('Always allow once: no card for a post or an @everyone post in a new shared chat or the run; removed: the card', async () => {
    const chat = await sharedChatBobWroteIn()
    const r1 = await turn('alice', chat, `please\n${postCall('first post')}`)
    expect(r1.cards).toHaveLength(1)
    expect(r1.cards[0]!.options!.map((o) => o.value)).toContain('__always')
    keepAlways(db(), 'alice', 'post_to_room', r1.turnId)
    const other = await sharedChatBobWroteIn()
    expect((await turn('alice', other, `please\n${postCall('second post')}`)).cards).toHaveLength(0)
    expect(posted('second post')).toBe(true)
    // B5: "@everyone", which only her own message may ask for, goes under her Always too
    expect((await turn('alice', other, `tell @everyone\n${postCall('everyone post', ['everyone'])}`)).cards).toHaveLength(0)
    expect(posted('everyone post')).toBe(true)
    // her run in the shared chat bob wrote in (B6)
    const run = await runTask(other, 'tell @everyone\n' + plainFake({ tool: 'post_to_room', args: { room: teamRoom, text: 'run post', mention: ['everyone'] }, sayResult: true }))
    expect(toolOk(run, 'post_to_room')).toBe(1)
    expect(posted('run post')).toBe(true)
    await removeInSettings('card:post_to_room')
    expect((await turn('alice', other, `please\n${postCall('after removal')}`)).cards).toHaveLength(1)
    expect(posted('after removal')).toBe(false)
  })
})

describe('B6: the maker\'s Always in a scheduled run in a shared chat a teammate wrote in', () => {
  const place = (o: Partial<AlwaysPlace>): AlwaysPlace => ({ db: db(), userId: 'alice', chatId: '', turnId: '', locale: 'en', clientKind: 'schedule', ...o })
  test('every kind holds there (the shared read card too)', async () => {
    const chat = await sharedChatBobWroteIn()
    const runTurn = uuidv7()
    const bobMsg = (db().query("SELECT id FROM messages WHERE chat_id = ? AND role = 'user' AND author_id = 'bob' ORDER BY created_at DESC LIMIT 1").get(chat) as { id: string }).id
    db().query("INSERT INTO turns (id, chat_id, user_id, engine, status, started_at, client_kind, user_message_id) VALUES (?, ?, 'alice', 'claude-code', 'done', ?, 'schedule', ?)").run(runTurn, chat, now(), bobMsg)
    expect(steerableRun(db(), runTurn)).toBe(true)
    keepAlways(db(), 'alice', 'shared_read', null)
    keepAlways(db(), 'alice', 'save_wider', null)
    try {
      expect(alwaysHere(place({ chatId: chat, turnId: runTurn }), 'shared_read')).toBe('on')
      expect(alwaysHere(place({ chatId: chat, turnId: runTurn }), 'save_wider')).toBe('on')
    } finally {
      await removeInSettings('card:shared_read')
      await removeInSettings('card:save_wider')
    }
    expect(alwaysHere(place({ chatId: chat, turnId: runTurn }), 'shared_read')).toBeNull()
  })
})

// the owner, 2026-11-23 (docs/decisions/20261123-one-always-allow.md): one Always, never one for this chat only. Every
// card with Always offers [yes] [항상 허용] [no]; an answer of the retired "Always in this chat" (a card raised before) is
// not a yes and keeps nothing
describe('one Always: no "Always in this chat" on any card', () => {
  test('withAlways offers only the Always for good; the old per-chat value is a no and keeps nothing', async () => {
    const chat = await newShared()
    const live = (o: Partial<AlwaysPlace> = {}): AlwaysPlace => ({ db: db(), userId: 'alice', chatId: chat, turnId: uuidv7(), locale: 'en', clientKind: 'web', ...o })
    const forGood = (kind: string) => (db().query("SELECT COUNT(*) n FROM card_always_allow WHERE user_id = 'alice' AND kind = ?").get(kind) as { n: number }).n
    try {
      for (const kind of ['remember', 'skill_files', 'dev_login', 'move_files', 'delete_files'] as const) {
        const asked: { options: { label: string; value: string }[]; note?: string }[] = []
        const old = await withAlways(live(), kind, [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], 'yes', async (options, extra) => { asked.push({ options, ...extra }); return '__always_chat' })
        expect([kind, old, forGood(kind)]).toEqual([kind, '__always_chat', 0])
        expect(asked[0]!.options.map((o) => o.value)).toEqual(['yes', ALWAYS_VALUE, 'no'])
        expect(asked[0]!.options.some((o) => /this chat|this conversation/i.test(o.label))).toBe(false)
        expect(asked[0]!.note ?? '').not.toMatch(/this chat only/i)
        const v = await withAlways(live(), kind, [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }], 'yes', async () => ALWAYS_VALUE)
        expect([kind, v, forGood(kind)]).toEqual([kind, 'yes', 1])
        // a new chat: no card
        expect(alwaysHere(live({ chatId: await newShared() }), kind)).toBe('on')
      }
      expect(db().query("SELECT COUNT(*) n FROM chat_card_approvals WHERE user_id = 'alice' AND kind = 'card_always'").get()).toEqual({ n: 0 })
    } finally { db().query("DELETE FROM card_always_allow WHERE user_id = 'alice'").run() }
  })
})

// ---------------- a guest among the people of a shared chat (real turns): one Always, the own-ask checks stay ----------------
describe('a guest in the shared chat: the share checks what the asker named; the site Always is for good', () => {
  test('the share asks although Always allow is on (the asker named nobody), and the site card offers "Always allow this site"', async () => {
    // a shared chat a guest sees: the one they made (a guest sees no other project chat); bob stands for the guest
    const chat = await newShared('bob')
    await turn('bob', chat, plainFake({ say: 'hello' }))
    // (a guest invited to the project: their guests row names it, and a person rule on its folder)
    db().query("UPDATE users SET guest = 1 WHERE id = 'bob'").run()
    db().query("INSERT INTO guests (user_id, place_kind, place_id, project_id, created_at) VALUES ('bob', 'project', ?, ?, ?)").run(projectId, projectId, now())
    db().query("INSERT INTO folder_rules (id, folder_id, subject_type, subject_id, access) VALUES ('holds-guest', 'f_projects_falcon', 'user', 'bob', 'read')").run()
    keepAlways(db(), 'alice', 'share_files', null)
    try {
      const r = await turn('alice', chat, `please share ledger-6.txt\n${shareCall(6)}`)
      expect(r.cards).toHaveLength(1)
      // (no Always offered where it would not count)
      expect(r.cards[0]!.options!.map((o) => o.value)).toEqual(['share', 'no'])
      expect(shared('users/alice/ledger-6.txt')).toBe(false)
      // the address card: for good, a guest here too (no site for this chat only)
      const w = await turn('alice', chat, `look it up\n${fake({ tool: 'web_fetch', args: { url: 'https://guestsite.example/a' }, sayResult: true })}`)
      expect(w.cards).toHaveLength(1)
      expect(w.cards[0]!.options!.map((o) => o.label)).toContain('Always allow this site (guestsite.example)')
      expect(w.cards[0]!.options!.map((o) => o.label).join(' ')).not.toMatch(/this conversation|this chat/i)
    } finally {
      db().query("UPDATE users SET guest = 0 WHERE id = 'bob'").run()
      db().query("DELETE FROM folder_rules WHERE id = 'holds-guest'").run()
      db().query("DELETE FROM guests WHERE user_id = 'bob'").run()
      await removeInSettings('card:share_files')
    }
    // without the guest, the same chat: Always allow holds, and the site card says "always"
    keepAlways(db(), 'alice', 'share_files', null)
    try {
      expect((await turn('alice', chat, `please\n${shareCall(6)}`)).cards).toHaveLength(0)
      expect(shared('users/alice/ledger-6.txt')).toBe(true)
      const w = await turn('alice', chat, `look it up\n${fake({ tool: 'web_fetch', args: { url: 'https://guestsite2.example/a' }, sayResult: true })}`)
      expect(w.cards[0]!.options!.map((o) => o.label)).toContain('Always allow this site (guestsite2.example)')
    } finally { await removeInSettings('card:share_files') }
  })
})

// ---------------- M2: a dev environment command that can use a login, after teammates changed files ----------------
describe('M2: the login card offers "항상 허용", for good and removable', () => {
  const change = [{ path: 'projects/falcon/app.ts', action: 'update', by: { id: 'bob', name: 'Bob Lee' }, at: now(), background: false }]
  /** the box_shell host's confirm and alwaysOn as chat/tools.ts builds them: the same yes / no card with Always */
  const host = (p: AlwaysPlace, cards: string[][]) => ({
    alwaysOn: (kind: 'dev_login') => alwaysHere(p, kind) === 'on',
    confirm: async (_q: string, options: { label: string; value: string }[], _d: string[], o?: { always?: 'dev_login' }) => {
      const v = await withAlways(p, o!.always!, options, options[0]!.value, async (opts) => { cards.push(opts.map((x) => x.value)); return p.clientKind === 'schedule' ? null : '__always' })
      return typeof v === 'string' ? v : null
    },
  })
  test('the first card offers it; then no card in another chat or the scheduled run; removed in Settings: the card again', async () => {
    const cards: string[][] = []
    const live = (chatId: string): AlwaysPlace => ({ db: db(), userId: 'alice', chatId, turnId: uuidv7(), locale: 'en', clientKind: 'web' })
    expect(await askLoginAfterOthers(host(live(await ownChat()), cards), 'git push origin main', change)).toBe('run')
    expect(cards).toEqual([['run', '__always', 'no']])
    expect((await allowances()).some((a) => a.kind === 'card' && a.card === 'dev_login')).toBe(true)
    expect(await askLoginAfterOthers(host(live(await ownChat()), cards), 'git push origin main', change)).toBe('always')
    expect(await askLoginAfterOthers(host({ ...live(await ownChat()), clientKind: 'schedule' }, cards), 'npm publish', change)).toBe('always')
    expect(cards).toHaveLength(1)
    await removeInSettings('card:dev_login')
    expect(await askLoginAfterOthers(host(live(await ownChat()), cards), 'git push origin main', change)).toBe('run')
    expect(cards).toHaveLength(2)
    await removeInSettings('card:dev_login')
  })
})
