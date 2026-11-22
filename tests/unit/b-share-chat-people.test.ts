// A chat outside projects shared with chosen people and groups (docs/DECISIONS.md "Chats shared with people and groups",
// QA TC-1405; server/src/chat/people-share.ts, chat-audience.ts, people-guard.ts). Covered: GET and PUT
// /api/chats/:id/audience (the creator only; the check for newly added people with its key; removals at once; removing
// everyone makes it private again; group sizes only for the creator and admins), who sees it (by name, through a group,
// a group joined, left or deleted, a disabled or deleted account), turns as their sender with SHARED_TOOLS only and
// without memories, a path-less search never over the sender's whole access, the refusals (side chat, scheduled run,
// 1A, moving into a project), Inbox notices (at most one a day per chat and person), "Hide from my list" and the
// rollback guard. People: alice (marketing) shares; bob (finance) by name; erin is in marketing; carol is an admin and
// dana the owner, neither in it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { roomsOf } from '../../server/src/rooms/service'
import { unsharePeopleChecked } from '../../server/src/chat/people-guard'
import { unshareUncheckedChats } from '../../server/src/chat/shared'
import { noSearchPath } from '../../server/src/chat/turn'
import { globFolderPrefix } from '../../server/src/chat/search-path'
import { addSources } from '../../server/src/chat/read-scope'
import { peopleAudience, peopleChatsLost } from '../../server/src/chat/chat-audience'
import { buildTurnPrompt, sharedSection } from '../../server/src/chat/prompt'
import { runAccountCleanups } from '../../server/src/auth/account-removal'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-share-chat-people', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'carol', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  // the room-send budget refills between requests
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
const reason = async (p: Promise<unknown>) => { const e = await errOf(p); return [e.status, e.body.params?.reason] }
const send = (user: string, chatId: string, content: string) =>
  h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
async function ask(user: string, chatId: string, content: string) {
  const started = await send(user, chatId, content)
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return { started, done: done.data.message }
}
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
/** save, answering a confirm with its key */
async function share(user: string, chatId: string, subjects: Sub[]) {
  let r = await put(user, chatId, subjects)
  if (r.status === 'confirm') r = await put(user, chatId, subjects, r.confirmKey)
  if (r.status !== 'saved') throw new Error('not saved')
  return r
}
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
const marketing: Sub = { subjectType: 'group', subjectId: 'marketing' }
const finance: Sub = { subjectType: 'group', subjectId: 'finance' }
const status = async (user: string, p: string) => (await h.req(user, p)).status
const listIds = async (user: string, query: Record<string, string> = {}) => (await h.api(user).call(API.listChats, { query })).items.map((c) => c.id)
const groupIds = async (user: string) => { const g = await h.api(user).call(API.listChatGroups, {}); return [...g.pinned, ...g.other.items].map((c) => c.id) }
async function newChat(user = 'alice', text = 'hello') {
  const c = await h.api(user).call(API.createChat, { body: {} })
  await ask(user, c.id, `${text}\n${fake({ say: `answer to ${text}` })}`)
  return c.id
}

describe('sharing', () => {
  test('a private chat with nobody picked asks for someone; the creator alone may change who sees it', async () => {
    const id = await newChat()
    expect(await reason(put('alice', id, []))).toEqual([400, 'needs_people'])
    // everyone else: the 404 of a missing chat, admins and the owner too
    for (const u of ['bob', 'carol', 'dana']) expect((await errOf(put(u, id, [bob]))).status).toBe(404)
    const a = await h.api('alice').call(API.getChatAudience, { params: { id } })
    expect(a).toMatchObject({ kind: 'private', canEdit: true, subjects: [] })
  })

  test('share with a person and a group: they see, open and continue it, as themselves', async () => {
    const id = await newChat('alice', 'budget questions')
    const r = await share('alice', id, [bob, marketing])
    expect(r.chat.shared?.kind).toBe('people')
    expect(db().query('SELECT shared_at, people_shared_at IS NOT NULL AS p FROM chats WHERE id = ?').get(id)).toEqual({ shared_at: null, p: 1 })
    // by name and through a group: in their lists and their Trina lists, nobody else's
    for (const u of ['bob', 'erin']) {
      expect(await listIds(u)).toContain(id)
      expect(await groupIds(u)).toContain(id)
      expect(await status(u, `/api/chats/${id}`)).toBe(200)
    }
    for (const u of ['carol', 'dana']) {
      expect(await listIds(u)).not.toContain(id)
      expect(await status(u, `/api/chats/${id}`)).toBe(404)
      expect(await status(u, `/api/chats/${id}/messages`)).toBe(404)
      expect(await status(u, `/api/chats/${id}/audience`)).toBe(404)
    }
    // the 404 body is the one of a chat that is not there
    const body = async (p: string) => { const j = await (await h.req('carol', p)).json() as { error: Record<string, unknown> }; delete j.error.requestId; return j }
    expect(await body(`/api/chats/${id}`)).toEqual(await body(`/api/chats/${crypto.randomUUID()}`))
    // bob continues it: his turn, his engine, shared chat rules (no memories, SHARED_TOOLS)
    const b = await ask('bob', id, `from bob\n${fake({ say: 'ok bob' })}`)
    expect(db().query('SELECT user_id, people_checked FROM turns WHERE id = ?').get(b.started.turnId)).toEqual({ user_id: 'bob', people_checked: 1 })
    // the recipient may not change who sees it (403), rename it (403) nor delete it (403)
    expect(await reason(put('bob', id, [bob]))).toEqual([403, 'chat_share_creator_only'])
    expect((await errOf(h.api('bob').call(API.updateChat, { params: { id }, body: { title: 'x' } }))).status).toBe(403)
    expect((await errOf(h.api('bob').call(API.deleteChat, { params: { id } }))).status).toBe(403)
    // audited, counts only
    const rows = db().query("SELECT detail FROM audit_log WHERE action IN ('chat.share', 'chat.audience') AND target = ?").all(id) as { detail: string }[]
    expect(rows.length).toBe(2)
    for (const r of rows) expect(r.detail).not.toMatch(/bob|erin|marketing/i)
  })

  test('the earlier answers were recorded, its session forgotten, its turns marked', async () => {
    const id = await newChat('alice', 'earlier')
    await share('alice', id, [bob])
    expect(db().query('SELECT engine_session_id FROM chats WHERE id = ?').get(id)).toEqual({ engine_session_id: null })
    expect(db().query('SELECT DISTINCT people_checked FROM turns WHERE chat_id = ?').all(id)).toEqual([{ people_checked: 2 }])
    const rec = db().query("SELECT r.reads FROM shared_answer_reads r JOIN messages m ON m.id = r.message_id WHERE m.chat_id = ? AND m.role = 'assistant'").all(id) as { reads: string }[]
    expect(rec.length).toBe(1)
    expect(JSON.parse(rec[0]!.reads)[0].c).toEqual(['alice', 'bob'])
  })

  test('group sizes and the count: only for the creator and admins (S8)', async () => {
    const id = await newChat()
    await share('alice', id, [bob, marketing])
    const mine = await h.api('alice').call(API.getChatAudience, { params: { id } })
    expect(mine.kind).toBe('people')
    expect(mine.canEdit).toBe(true)
    expect(mine.count).toBe(3)
    expect(mine.subjects.find((s) => s.subjectId === 'marketing')).toMatchObject({ members: 2, mine: true })
    const erins = await h.api('erin').call(API.getChatAudience, { params: { id } })
    expect(erins.canEdit).toBe(false)
    expect(erins.count).toBeUndefined()
    expect(erins.subjects.find((s) => s.subjectId === 'marketing')).toEqual({ subjectType: 'group', subjectId: 'marketing', name: 'Marketing', mine: true })
    const chat = await h.api('bob').call(API.getChat, { params: { id } })
    expect(chat.shared).toMatchObject({ kind: 'people', audience: 0, audienceHidden: true, canDelete: false, canUpload: true })
    expect((await h.api('alice').call(API.getChat, { params: { id } })).shared?.audience).toBe(3)
  })

  test('the check: a new person who cannot open what an answer read is asked about, with a key; a changed list asks again', async () => {
    const id = (await h.api('alice').call(API.createChat, { body: {} })).id
    // alice reads the marketing brief (bob, in finance, cannot)
    const r = await ask('alice', id, fake({ tool: 'read', args: { file_path: 'groups/marketing/campaign-brief.md' }, sayResult: true }))
    expect(r.done.content).toContain('Autumn')
    const c = await put('alice', id, [bob])
    expect(c.status).toBe('confirm')
    if (c.status !== 'confirm') return
    expect(c.reason).toBe('unchecked')
    expect(c.check).toMatchObject({ added: 1, fileAnswers: 1, memoryAnswers: 0, accountAnswers: 0, unchecked: 0 })
    expect(JSON.stringify(c)).not.toMatch(/bob|Bob/)
    // nothing saved yet
    expect(db().query('SELECT people_shared_at FROM chats WHERE id = ?').get(id)).toEqual({ people_shared_at: null })
    // a key for another list is no yes for this one
    const other = await put('alice', id, [bob, { subjectType: 'user', subjectId: 'carol' }], c.confirmKey)
    expect(other).toMatchObject({ status: 'confirm', reason: 'changed' })
    const saved = await put('alice', id, [bob], c.confirmKey)
    expect(saved.status).toBe('saved')
    // erin (marketing) added later reads the brief herself: nothing at stake, but the save still carries the check's key
    const quiet = await put('alice', id, [bob, marketing])
    expect(quiet).toMatchObject({ status: 'confirm', reason: 'unchecked', check: { added: 1, fileAnswers: 0, memoryAnswers: 0, accountAnswers: 0, places: [], otherPlaces: false, roomsUnseen: false } })
    if (quiet.status === 'confirm') expect((await put('alice', id, [bob, marketing], quiet.confirmKey)).status).toBe('saved')
    // the widening list of this chat (phase 1's list, chat target): its creator only; its total is the confirm's count
    const carol: Sub = { subjectType: 'user', subjectId: 'carol' }
    const ask2 = await put('alice', id, [bob, marketing, carol])
    const list = await h.api('alice').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: [bob, marketing, carol] } })
    expect(ask2.status).toBe('confirm')
    if (ask2.status === 'confirm') expect(list.total).toBe(ask2.check.fileAnswers)
    for (const it of list.items) { expect(it.chatId).toBe(id); expect(it.missedBy).toEqual(['Carol Park']) }
    expect(await reason(h.api('bob').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: [carol] } }))).toEqual([403, 'widening_not_allowed'])
    expect((await errOf(h.api('dana').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: [carol] } }))).status).toBe(404)
    // its picks are checked as a save checks them: no probe of who is active or of other people's groups
    expect(await reason(h.api('alice').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: [{ subjectType: 'user', subjectId: 'nobody' }] } }))).toEqual([400, 'unknown_subject'])
    expect(await reason(h.api('alice').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: [finance] } }))).toEqual([400, 'unknown_subject'])
    expect(await reason(h.api('alice').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: Array.from({ length: 101 }, (_, i) => ({ subjectType: 'user' as const, subjectId: `u${i}` })) } }))).toEqual([400, 'audience_full'])
  })

  test('removing someone stops their turn first and drops the chat from their windows; removing everyone makes it private', async () => {
    const id = await newChat()
    await share('alice', id, [bob, marketing])
    const slow = await send('bob', id, fake({ sleep: 3000 }, { say: 'slow' }))
    await waitFor(() => h.rt().activeTurnUser(id) === 'bob')
    const r = await share('alice', id, [marketing])
    expect(r.audience.subjects.map((s) => s.subjectId)).toEqual(['marketing'])
    await waitFor(() => (db().query('SELECT status FROM turns WHERE id = ?').get(slow.turnId) as { status: string }).status !== 'running', { timeoutMs: 10_000 })
    expect(db().query('SELECT status FROM turns WHERE id = ?').get(slow.turnId)).toEqual({ status: 'stopped' })
    await ws.bob!.next('chat.updated', (f) => f.data.chatId === id && f.data.change === 'deleted', 10_000)
    expect(await status('bob', `/api/chats/${id}`)).toBe(404)
    // removing everyone: the chat is alice's alone again
    await waitFor(() => !h.rt().activeTurn(id), { timeoutMs: 15_000 })
    const back = await put('alice', id, [])
    expect(back.status).toBe('saved')
    if (back.status === 'saved') { expect(back.chat.shared).toBeUndefined(); expect(back.audience.kind).toBe('private') }
    expect(await status('erin', `/api/chats/${id}`)).toBe(404)
    expect(db().query('SELECT COUNT(*) AS n FROM chat_audience WHERE chat_id = ?').get(id)).toEqual({ n: 0 })
  })

  test('adds wait while a turn runs (chat_busy); removals do not', async () => {
    const id = await newChat()
    await share('alice', id, [bob])
    await send('alice', id, fake({ sleep: 2000 }, { say: 'slow' }))
    await waitFor(() => !!h.rt().activeTurn(id))
    expect(await reason(put('alice', id, [bob, marketing]))).toEqual([409, 'chat_busy'])
    await waitFor(() => !h.rt().activeTurn(id), { timeoutMs: 15_000 })
  })

  test('newly added subjects only are checked: a member adds only their own groups', async () => {
    const id = await newChat()
    expect(await reason(put('alice', id, [finance]))).toEqual([400, 'unknown_subject'])
    expect(await reason(put('alice', id, [{ subjectType: 'user', subjectId: 'nobody' }]))).toEqual([400, 'unknown_subject'])
    // an admin may add any group; a row of a group the creator is not in, once there, stays valid on later saves
    db().query("INSERT INTO chat_audience (chat_id, subject_type, subject_id, added_by, added_at) VALUES (?, 'group', 'finance', 'alice', ?)").run(id, new Date().toISOString())
    db().query('UPDATE chats SET people_shared_at = ? WHERE id = ?').run(new Date().toISOString(), id)
    db().query('UPDATE turns SET people_checked = 2 WHERE chat_id = ?').run(id)
    expect((await share('alice', id, [finance, bob])).status).toBe('saved')
    expect(await reason(put('alice', id, Array.from({ length: 101 }, (_, i) => ({ subjectType: 'user' as const, subjectId: `u${i}` }))))).toEqual([400, 'audience_full'])
  })

  test('refusals: side chat, scheduled run, a project chat, 1A for adds, moving into a project', async () => {
    const side = await newChat()
    db().exec('PRAGMA foreign_keys = OFF')
    try { db().query("UPDATE chats SET side_room_id = 'room-x' WHERE id = ?").run(side) } finally { db().exec('PRAGMA foreign_keys = ON') }
    expect(await reason(put('alice', side, [bob]))).toEqual([409, 'side_chat'])
    const sched = await newChat()
    db().query("UPDATE chats SET title_source = 'schedule' WHERE id = ?").run(sched)
    expect(await reason(put('alice', sched, [bob]))).toEqual([409, 'scheduled_run'])
    const personal = await h.api('alice').call(API.createProject, { body: { name: 'Mine', scope: 'personal', participants: [], instructions: '' } })
    const inProject = (await h.api('alice').call(API.createChat, { body: { projectId: personal.id } })).id
    expect(await reason(put('alice', inProject, [bob]))).toEqual([409, 'project_personal'])
    const id = await newChat()
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try { expect(await reason(put('alice', id, [bob]))).toEqual([409, 'safe_ops']) } finally { delete process.env.MYCEL_SAFE_OPS_1A }
    await share('alice', id, [bob])
    expect(await reason(h.api('alice').call(API.updateChat, { params: { id }, body: { projectId: personal.id } }))).toEqual([409, 'shared_chat_move'])
    // POST /share (a project's members) on a chat outside projects: the revised words
    const e = await errOf(h.api('alice').call(API.shareChat, { params: { id: await newChat() }, body: {} }))
    expect(e.body.params?.reason).toBe('project_not_sharing')
    expect(e.body.message).toContain('Use Share to share')
  })
})

describe('who sees it follows groups and accounts', () => {
  test('joining a listed group lets someone in at once; leaving it takes the chat away; a deleted group drops its row', async () => {
    const id = await newChat()
    const g = await h.api('dana').call(API.createGroup, { body: { name: 'Planning', memberIds: ['alice'] } })
    const planning: Sub = { subjectType: 'group', subjectId: g.id }
    await share('alice', id, [planning])
    // carol (admin) joins the group: she sees it; leaves: 404 and her windows drop it
    await h.api('dana').call(API.updateGroup, { params: { id: g.id }, body: { memberIds: ['alice', 'carol'] } })
    expect(await status('carol', `/api/chats/${id}`)).toBe(200)
    await h.api('dana').call(API.updateGroup, { params: { id: g.id }, body: { memberIds: ['alice'] } })
    expect(await status('carol', `/api/chats/${id}`)).toBe(404)
    await ws.carol!.next('chat.updated', (f) => f.data.chatId === id && f.data.change === 'deleted', 10_000)
    // listed by name and through a group: removing one entry keeps them through the other
    await h.api('dana').call(API.updateGroup, { params: { id: g.id }, body: { memberIds: ['alice', 'bob'] } })
    await share('alice', id, [bob, planning])
    await share('alice', id, [planning])
    expect(await status('bob', `/api/chats/${id}`)).toBe(200)
    await h.api('dana').call(API.deleteGroup, { params: { id: g.id } })
    expect(db().query('SELECT COUNT(*) AS n FROM chat_audience WHERE subject_id = ?').get(g.id)).toEqual({ n: 0 })
    expect(await status('bob', `/api/chats/${id}`)).toBe(404)
  })

  test('peopleChatsLost: only recipients who saw it and do not now', () => {
    const id = crypto.randomUUID()
    db().query("INSERT INTO chats (id, user_id, title, engine, created_at, updated_at, people_shared_at) VALUES (?, 'alice', 't', 'claude-code', ?, ?, ?)").run(id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
    db().query("INSERT INTO chat_audience (chat_id, subject_type, subject_id, added_at) VALUES (?, 'group', 'finance', ?)").run(id, new Date().toISOString())
    const lost = peopleChatsLost(db(), new Map([['bob', ['finance']], ['alice', ['marketing']], ['erin', ['marketing']]]), new Map([['bob', []], ['alice', []], ['erin', ['finance']]]))
    expect(lost.get('bob')).toContain(id)
    expect(lost.has('alice')).toBe(false)
    expect(lost.get('erin') ?? []).not.toContain(id)
    db().query('DELETE FROM chats WHERE id = ?').run(id)
  })

  test('a disabled recipient is out; enabled again, back in (their row stays)', async () => {
    const id = await newChat()
    await share('alice', id, [{ subjectType: 'user', subjectId: 'erin' }])
    const audience = () => (db().query('SELECT user_id FROM chats WHERE id = ?').get(id) as { user_id: string }) && peopleAudience(db(), { id, user_id: 'alice' })
    expect(audience()).toEqual(['alice', 'erin'])
    db().query("UPDATE users SET status = 'disabled' WHERE id = 'erin'").run()
    try {
      expect(audience()).toEqual(['alice'])
      expect(db().query("SELECT COUNT(*) AS n FROM chat_audience WHERE chat_id = ? AND subject_id = 'erin'").get(id)).toEqual({ n: 1 })
      // the who-sees list: marked inactive for the creator; left out for the others in it
      expect((await h.api('alice').call(API.getChatAudience, { params: { id } })).subjects.find((x) => x.subjectId === 'erin')).toMatchObject({ inactive: true })
    } finally { db().query("UPDATE users SET status = 'active' WHERE id = 'erin'").run() }
    expect(await status('erin', `/api/chats/${id}`)).toBe(200)
  })
})

describe('turns in a people-shared chat', () => {
  test('the instructions say it is shared and carry no memories', () => {
    const s = sharedSection({ project: null, audience: 3, asker: 'Bob Lee' })
    expect(s).toContain('3 people chosen by its creator')
    expect(s).toContain('Searches without a folder only look where everyone here may read')
    expect(typeof buildTurnPrompt).toBe('function')
  })

  test('a path of only separators or "." is no path', () => {
    for (const p of [undefined, '', '.', '/', './', '//', ' / ', '.\\', '\\', '/./']) expect({ p, none: noSearchPath(p) }).toEqual({ p, none: true })
    for (const p of ['shared', '/shared', './projects/falcon']) expect({ p, none: noSearchPath(p) }).toEqual({ p, none: false })
  })

  test("a search without a path never runs over the sender's whole access", async () => {
    const id = await newChat()
    await share('alice', id, [bob])
    const r = await ask('alice', id, fake({ tool: 'grep', args: { pattern: 'Draft|CANARY' }, sayResult: true }))
    // alice and bob both read shared/ and projects/falcon: the AI is told to name one; nothing of alice's own folder
    expect(r.done.content).toContain('Not searched')
    expect(r.done.content).toContain('"shared"')
    expect(r.done.content).not.toContain('users/alice')
    expect(r.done.content).not.toContain('groups/')
    expect(r.done.content).not.toContain('Draft Q4')
    for (const path of ['/', './']) {
      const slash = await ask('alice', id, fake({ tool: 'grep', args: { pattern: 'Draft', path }, sayResult: true }))
      expect(slash.done.content).toContain('Not searched')
      expect(slash.done.content).not.toContain('Draft Q4')
    }
    // with a folder everyone reads, it runs
    const named = await ask('alice', id, fake({ tool: 'grep', args: { pattern: 'Falcon', path: 'projects/falcon' }, sayResult: true }))
    expect(named.done.content).toContain('projects/falcon')
  })

  test('nobody in common: refused, never the sender\'s access', async () => {
    const id = await newChat()
    await share('alice', id, [bob])
    // for this test bob reads neither shared/ nor projects/falcon (their rules taken away, put back after)
    const rows = db().query(`SELECT r.* FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE (f.path = 'shared' AND r.subject_type = 'everyone')
      OR (f.path = 'projects/falcon' AND r.subject_type = 'group' AND r.subject_id = 'finance')`).all() as Record<string, string | null>[]
    expect(rows.length).toBe(2)
    for (const r of rows) db().query('DELETE FROM folder_rules WHERE id = ?').run(r.id!)
    try {
      const r = await ask('alice', id, fake({ tool: 'glob', args: { pattern: '**/*.md' }, sayResult: true }))
      expect(r.done.content).toContain('there is no folder everyone in this chat can open')
      expect(r.done.content).not.toContain('users/alice')
    } finally {
      for (const r of rows) db().query(`INSERT INTO folder_rules (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r))
    }
  })
})

describe('QA scenario findings (TC-7041, TC-7042, TC-7047)', () => {
  const cardOf = (user: string, turnId: string) => ws[user]!.next('turn.request', (f) => f.data.turnId === turnId, 15_000)
  const answer = (user: string, turnId: string, requestId: string, value: 'share' | 'skip') =>
    h.api(user).call(API.answerTurn, { params: { id: turnId }, body: { kind: 'ask_user', requestId, answer: value } })

  test('the folder pieces of a glob pattern without a path become its path', () => {
    expect(globFolderPrefix({ pattern: 'users/qa-member/**/*.html' })).toEqual({ path: 'users/qa-member', pattern: '**/*.html' })
    expect(globFolderPrefix({ pattern: 'users/qa-member/a.html', path: '/' })).toEqual({ path: 'users/qa-member', pattern: 'a.html' })
    for (const args of [{ pattern: '**/*.md' }, { pattern: '*.md' }, { pattern: 'users/x/', path: '' }, { pattern: './users/x/*.md' }, { pattern: 'a\\*b/*.md' }, { pattern: 'users/x/*.md', path: 'shared' }, { pattern: '/users/x/*.md' }])
      expect({ args, out: globFolderPrefix(args) }).toEqual({ args, out: null })
  })

  test("TC-7041: a glob of the asker's own folder named in the pattern asks on the card and runs after yes", async () => {
    const id = await newChat()
    await share('alice', id, [bob])
    const started = await send('alice', id, fake({ tool: 'glob', args: { pattern: 'users/alice/**/*.md' }, sayResult: true }))
    const card = await cardOf('alice', started.turnId)
    await answer('alice', started.turnId, card.data.request.requestId, 'share')
    const done = (await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)).data.message
    expect(done.content).not.toContain('Not searched')
    expect(done.content).toContain('newsletter-oct.md')
    // no: nothing of it
    const again = await send('alice', id, fake({ tool: 'glob', args: { pattern: 'users/alice/*.md' }, sayResult: true }))
    const card2 = await cardOf('alice', again.turnId)
    await answer('alice', again.turnId, card2.data.request.requestId, 'skip')
    const no = (await ws.alice!.next('message.done', (f) => f.data.messageId === again.assistantMessage.id, 30_000)).data.message
    expect(no.content).not.toContain('todo.md')
  })

  test('TC-7041: the people chat lines say the own folder works by its path; the menu is named by its exact label', () => {
    const s = sharedSection({ project: null, audience: 3, asker: 'Bob Lee' }, 'ko')
    expect(s).toContain("Bob Lee's own folder (users/<Bob Lee's id>/) works here too")
    expect(s).toContain('"나만 보는 채팅에서 이어 하기" in the menu that opens from this chat\'s title')
    expect(s).toContain('untranslated')
    expect(s).not.toContain("this chat's menu at the top")
  })

  test("TC-7042: the chat's own files are no place someone added to it misses", async () => {
    // what a work-folder read or a chat file read records: the chat itself
    const id = await newChat()
    addSources(db(), id, [{ type: 'chat', id }])
    const p = await h.api('alice').call(API.previewChatAudience, { params: { id }, body: { subjects: [bob] } })
    expect(p.check).toMatchObject({ places: [], otherPlaces: false, fileAnswers: 0, roomsUnseen: false })
    // another chat's files still count
    const other = await newChat()
    const id2 = await newChat()
    addSources(db(), id2, [{ type: 'chat', id: other }])
    const q = await h.api('alice').call(API.previewChatAudience, { params: { id: id2 }, body: { subjects: [bob] } })
    expect(q.check.places.length + (q.check.otherPlaces ? 1 : 0)).toBeGreaterThan(0)
  })

  test('TC-7042: the warning names only picks that bring in someone it is about', async () => {
    const id = await newChat()
    // an answer that read alice's own folder: bob and erin miss it
    addSources(db(), id, [{ type: 'user', id: 'alice' }])
    // erin already sees it through marketing; picking her by name with bob: only bob is new
    await share('alice', id, [marketing])
    const erin: Sub = { subjectType: 'user', subjectId: 'erin' }
    const p = await h.api('alice').call(API.previewChatAudience, { params: { id }, body: { subjects: [marketing, erin, bob] } })
    expect(p.check.places.length + (p.check.otherPlaces ? 1 : 0)).toBeGreaterThan(0)
    // positions in the list as sent, never ids
    expect(p.check.warnPicks).toEqual([2])
    expect(JSON.stringify(p.check)).not.toMatch(/bob|erin/)
  })

  test('TC-7047: a share again after the chat was taken away is a new notice; a quick remove and add is not', async () => {
    const id = await newChat('alice', 'reshare me')
    await share('alice', id, [bob])
    const first = db().query("SELECT id FROM chat_share_notices WHERE user_id = 'bob' AND chat_id = ?").get(id) as { id: string }
    // a quick remove and add while it is unread: the same row
    await share('alice', id, [])
    await share('alice', id, [bob])
    expect(db().query("SELECT id FROM chat_share_notices WHERE user_id = 'bob' AND chat_id = ?").all(id)).toEqual([{ id: first.id }])
    // read (or older than the quiet time): a share again replaces it with a new unread row
    db().query("UPDATE chat_share_notices SET read_at = ? WHERE id = ?").run(new Date().toISOString(), first.id)
    await share('alice', id, [])
    const gone = (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((x) => x.code === 'chat.shared' && x.chatId === null && x.id === first.id)
    expect(gone?.chatShared).toMatchObject({ gone: true, title: null, name: 'Alice Kim' })
    await share('alice', id, [bob])
    const rows = db().query("SELECT id, read_at FROM chat_share_notices WHERE user_id = 'bob' AND chat_id = ?").all(id) as { id: string; read_at: string | null }[]
    expect(rows.length).toBe(1)
    expect(rows[0]!.id).not.toBe(first.id)
    expect(rows[0]!.read_at).toBeNull()
  })
})

describe('QA scenario P1s (TC-7262, TC-7277, TC-7286)', () => {
  const answersOf = (id: string) => (db().query("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY rowid").all(id) as { id: string }[]).map((r) => r.id)
  const withheld = async (user: string, id: string) => (await h.api(user).call(API.listMessages, { params: { id }, query: {} })).items.filter((m) => m.role === 'assistant' && m.withheld).length

  test('TC-7262: a dev environment answer of the private time is told before sharing and not kept from people added later', async () => {
    const id = await newChat('alice', 'video')
    await ask('alice', id, fake({ say: 'made the video' }))
    const [first, dev] = answersOf(id)
    db().query('UPDATE messages SET steps = ? WHERE id = ?').run(JSON.stringify([{ id: 's1', kind: 'tool', tool: 'box_shell', label: 'run', status: 'ok', startedAt: '2026-11-22T00:00:00.000Z', endedAt: '2026-11-22T00:00:01.000Z' }]), dev)
    const c = await put('alice', id, [bob])
    expect(c.status).toBe('confirm')
    if (c.status !== 'confirm') return
    expect(c.check).toMatchObject({ devAnswers: 1, unchecked: 0 })
    await put('alice', id, [bob], c.confirmKey)
    // no x on any answer: erin, added later, sees them all
    for (const m of [first, dev]) expect(JSON.parse((db().query('SELECT reads FROM shared_answer_reads WHERE message_id = ?').get(m) as { reads: string }).reads)[0].x).toBeUndefined()
    await share('alice', id, [bob, { subjectType: 'user', subjectId: 'erin' }])
    expect(await withheld('erin', id)).toBe(0)
  })

  test('TC-7262: a later share says how many earlier answers stay hidden from the person added', async () => {
    const id = await newChat('alice', 'secret')
    await share('alice', id, [bob])
    const [a1] = answersOf(id)
    db().query('UPDATE shared_answer_reads SET reads = ? WHERE message_id = ?').run(JSON.stringify([{ c: ['alice', 'bob'], s: [], x: 1 }]), a1)
    const p = await h.api('alice').call(API.previewChatAudience, { params: { id }, body: { subjects: [bob, { subjectType: 'user', subjectId: 'erin' }] } })
    expect(p.check.hiddenAnswers).toBe(1)
  })

  test('TC-7277/TC-7240: the warning names the files a new person cannot open, with where they are', async () => {
    const id = (await h.api('alice').call(API.createChat, { body: {} })).id
    await ask('alice', id, fake({ tool: 'read', args: { file_path: 'groups/marketing/campaign-brief.md' }, sayResult: true }))
    const p = await h.api('alice').call(API.previewChatAudience, { params: { id }, body: { subjects: [bob] } })
    expect(p.check.fileAnswers).toBe(1)
    expect(p.check.fileNames?.[0]).toMatch(/^campaign-brief\.md · .+$/)
  })

  test('TC-7269: a helper file a later make_file turned into the result is not offered with the chat\'s files', async () => {
    const id = (await h.api('alice').call(API.createChat, { body: {} })).id
    await ask('alice', id, fake({ tool: 'write', args: { file_path: 'users/alice/sq7269/quote.md', content: '# Quote' } }, { tool: 'make_file', args: { format: 'docx', source: 'users/alice/sq7269/quote.md', output: 'users/alice/sq7269/quote.docx' }, sayResult: true }))
    const c = await put('alice', id, [bob])
    if (c.status !== 'confirm') throw new Error('expected a confirm')
    expect((c.check.madeFiles ?? []).map((f) => f.name)).toEqual(['quote.docx'])
  })

  test('TC-7286: a My files attachment in a shared chat goes in as a copy everyone opens; a file everyone reads stays a reference', async () => {
    const id = await newChat()
    await share('alice', id, [bob])
    const mine = await h.api('alice').call(API.attachTeamFile, { body: { chatId: id, path: 'users/alice/todo.md' } })
    const pub = await h.api('alice').call(API.attachTeamFile, { body: { chatId: id, path: 'shared/glossary.md' } })
    const ids = [mine.id, pub.id]
    const r = await h.api('alice').call(API.sendMessage, { params: { id }, body: { content: fake({ say: 'got it' }), clientMessageId: cm(), attachmentIds: ids } })
    await ws.alice!.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 30_000)
    const q = (await h.api('bob').call(API.listMessages, { params: { id }, query: {} })).items.find((m) => m.id === r.userMessage!.id)!
    const copy = q.attachments.find((a) => a.name === 'todo.md')!
    expect(copy.source).toBe('chat')
    expect((await h.req('bob', `/api/chats/${id}/files/${copy.id}`)).status).toBe(200)
    expect(q.attachments.find((a) => a.name === 'glossary.md')?.source).toBe('team')
  })
})

describe('notices, hiding, lists', () => {
  test('one Inbox notice per chat and person a day; it names the sharer and the chat while it is shared', async () => {
    const id = await newChat('alice', 'notice me')
    await share('alice', id, [bob])
    await share('alice', id, [])
    await share('alice', id, [bob])
    const rows = db().query("SELECT named, by_user FROM chat_share_notices WHERE user_id = 'bob' AND chat_id = ?").all(id)
    expect(rows).toEqual([{ named: 1, by_user: 'alice' }])
    const list = await h.api('bob').call(API.listNotifications, { query: {} })
    const n = list.items.find((x) => x.code === 'chat.shared' && x.chatId === id)
    expect(n?.chatShared?.name).toBe('Alice Kim')
    expect(n?.link).toBe('chat')
    // removed: "no longer shared", no title, no link
    await share('alice', id, [])
    const again = (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((x) => x.code === 'chat.shared' && x.sourceId === n!.sourceId)
    expect(again?.chatShared).toMatchObject({ title: null, gone: true })
    expect(again?.link).toBeNull()
    expect(JSON.stringify(again)).not.toContain('notice me')
  })

  test('a group add tells the group\'s people too, without naming them by name', async () => {
    const id = await newChat()
    await share('alice', id, [marketing])
    expect(db().query("SELECT named FROM chat_share_notices WHERE user_id = 'erin' AND chat_id = ?").get(id)).toEqual({ named: 0 })
  })

  test('"Hide from my list": for recipients; opening it brings it back; a search still finds it', async () => {
    const id = await newChat('alice', 'zebra quarterly')
    await share('alice', id, [bob])
    expect(await reason(h.api('alice').call(API.hideChat, { params: { id } }))).toEqual([400, 'chat_hide_creator'])
    await h.api('bob').call(API.hideChat, { params: { id } })
    expect(await listIds('bob')).not.toContain(id)
    expect(await groupIds('bob')).not.toContain(id)
    expect(await listIds('bob', { q: 'zebra' })).toContain(id)
    await h.api('bob').call(API.markChatSeen, { params: { id } })
    expect(await listIds('bob')).toContain(id)
    // outsiders: 404 on hide too
    expect((await errOf(h.api('carol').call(API.hideChat, { params: { id } }))).status).toBe(404)
  })

  test('search: an outsider never finds it by its words', async () => {
    const id = await newChat('alice', 'walrus planning')
    await share('alice', id, [bob])
    expect(await listIds('bob', { q: 'walrus' })).toContain(id)
    for (const u of ['carol', 'dana', 'erin']) expect(await listIds(u, { q: 'walrus' })).not.toContain(id)
  })

  test('the admin delete dialog counts the chats with other people\'s messages', async () => {
    const before = (await h.api('carol').call(API.userSharedChats, { params: { id: 'alice' } })).sharedChats
    const id = await newChat()
    await share('alice', id, [bob])
    await ask('bob', id, `x\n${fake({ say: 'y' })}`)
    expect((await h.api('carol').call(API.userSharedChats, { params: { id: 'alice' } })).sharedChats).toBe(before + 1)
    expect((await errOf(h.api('bob').call(API.userSharedChats, { params: { id: 'alice' } }))).status).toBe(403)
  })
})

describe('a removed account', () => {
  test("a recipient's audience row, hidden row and notices go with the account cleanup", async () => {
    const id = await newChat()
    const ghost = 'ghost-' + crypto.randomUUID().slice(0, 8)
    db().query("INSERT INTO users (id, username, name, role) VALUES (?, ?, 'Ghost', 'member')").run(ghost, ghost)
    await share('alice', id, [{ subjectType: 'user', subjectId: ghost }])
    db().query('INSERT INTO chat_list_hidden (user_id, chat_id, at) VALUES (?, ?, ?)').run(ghost, id, new Date().toISOString())
    expect(db().query('SELECT COUNT(*) AS n FROM chat_share_notices WHERE user_id = ?').get(ghost)).toEqual({ n: 1 })
    db().query("UPDATE users SET status = 'disabled', deleted_at = ? WHERE id = ?").run(new Date().toISOString(), ghost)
    await runAccountCleanups(h.ctx, ghost)
    for (const [t, c] of [['chat_audience', 'subject_id'], ['chat_list_hidden', 'user_id'], ['chat_share_notices', 'user_id']] as const)
      expect(db().query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`).get(ghost), t).toEqual({ n: 0 })
  })
})

describe('rollback guard', () => {
  test('a queued turn waits unmarked; one an older build ran (done, mark left 0) unshares the chat; one still queued does not', async () => {
    const id = await newChat()
    await share('alice', id, [bob])
    // a turn this build ran is marked when it started
    const ran = await ask('bob', id, `x\n${fake({ say: 'y' })}`)
    expect(db().query('SELECT people_checked, shared_checked FROM turns WHERE id = ?').get(ran.started.turnId)).toEqual({ people_checked: 1, shared_checked: 1 })
    // a queued turn as this build writes it (createTurn: 0 until it starts): passed over while it waits
    const t = crypto.randomUUID()
    db().query("INSERT INTO turns (id, chat_id, user_id, engine, status, people_checked, shared_checked) VALUES (?, ?, 'bob', 'claude-code', 'queued', 0, 0)").run(t, id)
    expect(unsharePeopleChecked(db()).unshared).not.toContain(id)
    // an older build picked it up and ran it (its gates off), leaving the mark at 0
    db().query("UPDATE turns SET status = 'done' WHERE id = ?").run(t)
    expect(unsharePeopleChecked(db()).unshared).toContain(id)
    expect(await status('bob', `/api/chats/${id}`)).toBe(404)
  })

  test('the same for a shared project chat (shared_checked)', async () => {
    const p = await h.api('alice').call(API.createProject, { body: { name: `Guard ${Math.random().toString(36).slice(2, 6)}`, participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    const id = (await h.api('alice').call(API.createChat, { body: { projectId: p.id } })).id
    expect((await h.api('alice').call(API.getChat, { params: { id } })).shared).toBeTruthy()
    const t = crypto.randomUUID()
    db().query("INSERT INTO turns (id, chat_id, user_id, engine, status, people_checked, shared_checked) VALUES (?, ?, 'bob', 'claude-code', 'queued', 0, 0)").run(t, id)
    expect(unshareUncheckedChats(db())).not.toContain(id)
    db().query("UPDATE turns SET status = 'done' WHERE id = ?").run(t)
    expect(unshareUncheckedChats(db())).toContain(id)
  })

  test('a turn an older build ran unshares it; a move into a project by an older build undoes the share', async () => {
    const ran = await newChat()
    await share('alice', ran, [bob])
    db().query("INSERT INTO turns (id, chat_id, user_id, engine, status, people_checked) VALUES (?, ?, 'alice', 'claude-code', 'done', 0)").run(crypto.randomUUID(), ran)
    const moved = await newChat()
    await share('alice', moved, [bob])
    const p = await h.api('alice').call(API.createProject, { body: { name: 'Elsewhere', scope: 'personal', participants: [], instructions: '' } })
    db().query('UPDATE chats SET project_id = ? WHERE id = ?').run(p.id, moved)
    const out = unsharePeopleChecked(db())
    expect(out.unshared).toContain(ran)
    expect(out.moved).toContain(moved)
    for (const id of [ran, moved]) {
      expect(db().query('SELECT people_shared_at FROM chats WHERE id = ?').get(id)).toEqual({ people_shared_at: null })
      expect(await status('bob', `/api/chats/${id}`)).toBe(404)
    }
    expect(db().query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chat.unshared_rollback' AND target IN (?, ?)").get(ran, moved)).toEqual({ n: 2 })
  })
})

// ---------------- one press: the preview and the key (QA TC-3092) ----------------
describe('the preview and the key', () => {
  const preview = (user: string, chatId: string, subjects: Sub[]) => h.api(user).call(API.previewChatAudience, { params: { id: chatId }, body: { subjects } })
  const carol: Sub = { subjectType: 'user', subjectId: 'carol' }
  async function briefChat() {
    const id = (await h.api('alice').call(API.createChat, { body: {} })).id
    await ask('alice', id, fake({ tool: 'read', args: { file_path: 'groups/marketing/campaign-brief.md' }, sayResult: true }))
    return id
  }

  test('the preview says what is at stake, saves nothing, and its key saves in one press', async () => {
    const id = await briefChat()
    const audits = () => (db().query("SELECT COUNT(*) AS n FROM audit_log WHERE target = ?").get(id) as { n: number }).n
    const before = audits()
    const p = await preview('alice', id, [bob])
    expect(p.check).toMatchObject({ added: 1, fileAnswers: 1, memoryAnswers: 0, accountAnswers: 0, unchecked: 0 })
    expect(p.previewKey).not.toBe('')
    // never who: no name of the people picked, nor of anyone else
    expect(JSON.stringify(p)).not.toMatch(/bob|Bob|erin|Erin/)
    expect(db().query('SELECT people_shared_at FROM chats WHERE id = ?').get(id)).toEqual({ people_shared_at: null })
    expect(audits()).toBe(before)
    // one press
    expect((await put('alice', id, [bob], p.previewKey)).status).toBe('saved')
  })

  test('a group picked: the preview counts its new people and names nothing of them', async () => {
    const id = await briefChat()
    const p = await preview('alice', id, [marketing])
    // erin is in marketing and reads the brief: nothing at stake, one new person
    expect(p.check).toMatchObject({ added: 1, fileAnswers: 0 })
    expect(JSON.stringify(p)).not.toMatch(/erin|Erin/)
  })

  test('no key, or a key of another list or state: nothing is saved and the answer is the check', async () => {
    const id = await briefChat()
    // add two, take one out: the first preview's key is no yes for the second list
    const two = await preview('alice', id, [bob, carol])
    expect(two.check.added).toBe(2)
    const one = await put('alice', id, [bob], two.previewKey)
    expect(one).toMatchObject({ status: 'confirm', reason: 'changed', check: { added: 1 } })
    // the second list's own preview saves it in one press
    const again = await preview('alice', id, [bob])
    expect((await put('alice', id, [bob], again.previewKey)).status).toBe('saved')
    // a new message since the preview: asked again
    const id2 = await briefChat()
    const p = await preview('alice', id2, [bob])
    await ask('alice', id2, `more\n${fake({ say: 'more' })}`)
    expect(await put('alice', id2, [bob], p.previewKey)).toMatchObject({ status: 'confirm', reason: 'changed' })
    // someone joined the group picked since the preview: asked again
    const id3 = await newChat()
    const g = await preview('alice', id3, [marketing])
    db().query("INSERT INTO group_members (group_id, user_id) VALUES ('marketing', 'carol')").run()
    try {
      expect(await put('alice', id3, [marketing], g.previewKey)).toMatchObject({ status: 'confirm', reason: 'changed', check: { added: 2 } })
    } finally { db().query("DELETE FROM group_members WHERE group_id = 'marketing' AND user_id = 'carol'").run() }
    // taking people out needs no key
    const id4 = await newChat()
    await share('alice', id4, [bob, marketing])
    expect((await put('alice', id4, [marketing])).status).toBe('saved')
  })

  test('memories count only the answers of the chat\'s private time', async () => {
    const memory = crypto.randomUUID()
    db().query("INSERT INTO memories (id, user_id, text, source, created_at) VALUES (?, 'alice', 'likes tea', 'user', ?)").run(memory, '2020-01-01T00:00:00.000Z')
    try {
      const id = await newChat('alice', 'tea')
      expect((await preview('alice', id, [bob])).check.memoryAnswers).toBe(1)
      await share('alice', id, [bob])
      // bob's answer in the shared chat carries no memories
      await ask('bob', id, `from bob\n${fake({ say: 'ok' })}`)
      expect((await preview('alice', id, [bob, carol])).check.memoryAnswers).toBe(1)
    } finally { db().query('DELETE FROM memories WHERE id = ?').run(memory) }
  })

  test('who may preview: its creator; another person in it 403, anyone else 404; the refusals of a save', async () => {
    const id = await newChat()
    await share('alice', id, [bob])
    expect(await reason(preview('bob', id, [bob, carol]))).toEqual([403, 'chat_share_creator_only'])
    for (const u of ['carol', 'dana']) expect((await errOf(preview(u, id, [carol]))).status).toBe(404)
    expect(await reason(preview('alice', id, [bob, { subjectType: 'user', subjectId: 'nobody' }]))).toEqual([400, 'unknown_subject'])
    expect(await reason(preview('alice', id, [bob, finance]))).toEqual([400, 'unknown_subject'])
  })

  test('chat_busy while a turn runs, as a save', async () => {
    const id = await newChat()
    const started = await send('alice', id, `slow\n${fake({ sleep: 3000 }, { say: 'slow' })}`)
    try {
      expect(await reason(preview('alice', id, [bob]))).toEqual([409, 'chat_busy'])
    } finally { await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000) }
  })

  test('at most 60 previews a minute (429); the same list answers from the cache', async () => {
    const id = await newChat()
    const first = await preview('alice', id, [bob])
    const again = await preview('alice', id, [bob])
    expect(again.previewKey).toBe(first.previewKey)
    let limited = false
    for (let i = 0; i < 70 && !limited; i++) {
      try { await preview('alice', id, [bob]) } catch (e) { limited = (e as ApiError).status === 429 }
    }
    expect(limited).toBe(true)
  })
})
