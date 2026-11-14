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
import { peopleAudience, peopleChatsLost } from '../../server/src/chat/chat-audience'
import { buildTurnPrompt, sharedSection } from '../../server/src/chat/prompt'

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
    expect(chat.shared).toMatchObject({ kind: 'people', audience: 0, audienceHidden: true, canDelete: false, canUpload: false })
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
    expect(c.added).toBe(1)
    expect(c.provenance?.people).toBe(1)
    expect(JSON.stringify(c)).not.toMatch(/bob|Bob/)
    // nothing saved yet
    expect(db().query('SELECT people_shared_at FROM chats WHERE id = ?').get(id)).toEqual({ people_shared_at: null })
    // a key for another list is no yes for this one
    const other = await put('alice', id, [bob, { subjectType: 'user', subjectId: 'carol' }], c.confirmKey)
    expect(other).toMatchObject({ status: 'confirm', reason: 'changed' })
    const saved = await put('alice', id, [bob], c.confirmKey)
    expect(saved.status).toBe('saved')
    // erin (marketing) added later reads the brief herself: nothing to ask
    expect((await put('alice', id, [bob, marketing])).status).toBe('saved')
    // the widening list of this chat (phase 1's list, chat target): its creator only; its total is the confirm's count
    const carol: Sub = { subjectType: 'user', subjectId: 'carol' }
    const ask2 = await put('alice', id, [bob, marketing, carol])
    const list = await h.api('alice').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: [bob, marketing, carol] } })
    expect(list.total).toBe(ask2.status === 'confirm' ? ask2.hiddenAnswers : 0)
    for (const it of list.items) { expect(it.chatId).toBe(id); expect(it.missedBy).toEqual(['Carol Park']) }
    expect(await reason(h.api('bob').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: [carol] } }))).toEqual([403, 'widening_not_allowed'])
    expect((await errOf(h.api('dana').call(API.wideningAnswers, { body: { target: { kind: 'chat', chatId: id }, add: [carol] } }))).status).toBe(404)
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
    expect(e.body.message).toContain('Share…')
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

describe('rollback guard', () => {
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
