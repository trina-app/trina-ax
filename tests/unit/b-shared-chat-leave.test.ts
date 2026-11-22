// Leaving a chat shared with people, and saying who lost access and why (docs/decisions/20261122-shared-chat-leave-and-
// lost-notices.md; plan docs/AGENTS/plan/20261122-0027-shared-chat-ux-gaps.md). Covered: POST /api/chats/:id/leave (by
// name only; a group keeps you in: refused; the creator can't; the last one out makes it private), the "added / removed /
// left" lines (GET …/audience events), the Inbox's 'chat.lost' notices (stopped, moved to the trash and taken back on
// restore, the creator's account deleted with the day the chat goes), Chat.shared.byGone, an answer stopped for its
// removed requester (Message.stoppedFor) and the delete dialog's count. People: alice (marketing) shares; bob (finance);
// erin (marketing); carol an admin; dana the owner.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, type PutChatAudienceResult } from '@mycel/shared/api'
import { addTestPerson, startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-leave', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
const reason = async (p: Promise<unknown>) => { const e = await errOf(p); return [e.status, e.body.params?.reason] }
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
async function share(user: string, chatId: string, subjects: Sub[]) {
  let r = await put(user, chatId, subjects)
  if (r.status === 'confirm') r = await put(user, chatId, subjects, r.confirmKey)
  if (r.status !== 'saved') throw new Error('not saved')
  return r
}
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
const erin: Sub = { subjectType: 'user', subjectId: 'erin' }
const marketing: Sub = { subjectType: 'group', subjectId: 'marketing' }
async function newChat(user = 'alice', text = 'hello') {
  const c = await h.api(user).call(API.createChat, { body: {} })
  const started = await h.api(user).call(API.sendMessage, { params: { id: c.id }, body: { content: `${text}\n${fake({ say: `answer to ${text}` })}`, clientMessageId: cm(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return c.id
}
const lost = async (user: string, chatId: string) => (await h.api(user).call(API.listNotifications, { query: {} })).items.filter((x) => x.code === 'chat.lost' && (x.chatId === chatId || db().query('SELECT 1 FROM chat_lost_notices WHERE id = ? AND chat_id = ?').get(x.id, chatId)))
const sees = async (user: string, chatId: string) => (await h.req(user, `/api/chats/${chatId}`)).status === 200

describe('leave', () => {
  test('someone shared with by name leaves: out at once, a line says so, the creator keeps the chat', async () => {
    const id = await newChat('alice', 'leave me')
    await share('alice', id, [bob, erin])
    expect(await sees('bob', id)).toBe(true)
    const r = await h.api('bob').call(API.leaveChat, { params: { id } })
    expect(r).toEqual({ ok: true })
    expect(await sees('bob', id)).toBe(false)
    expect(await sees('erin', id)).toBe(true)
    expect(db().query("SELECT COUNT(*) AS n FROM chat_audience WHERE chat_id = ? AND subject_id = 'bob'").get(id)).toEqual({ n: 0 })
    // the lines: alice added bob and erin, then bob left (names read now)
    const a = await h.api('alice').call(API.getChatAudience, { params: { id } })
    expect(a.events?.map((e) => [e.kind, e.actor, e.names])).toEqual([['added', 'Alice Kim', expect.arrayContaining(['Bob Lee'])], ['left', 'Bob Lee', []]])
    // audited, counts only
    expect(db().query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chat.leave' AND target = ? AND actor_id = 'bob'").get(id)).toEqual({ n: 1 })
  })

  test('the creator can\'t leave; someone who would still see it through a listed group is told so and stays', async () => {
    const id = await newChat('alice', 'group stays')
    await share('alice', id, [erin, marketing])
    // named: erin (also by name), never the creator
    expect((await h.api('erin').call(API.getChat, { params: { id } })).shared?.named).toBe(true)
    expect((await h.api('alice').call(API.getChat, { params: { id } })).shared?.named).toBeUndefined()
    expect(await reason(h.api('alice').call(API.leaveChat, { params: { id } }))).toEqual([400, 'chat_leave_creator'])
    const e = await errOf(h.api('erin').call(API.leaveChat, { params: { id } }))
    expect([e.status, e.body.params?.reason]).toEqual([409, 'chat_leave_group'])
    expect(e.message).toContain('Marketing')
    expect(await sees('erin', id)).toBe(true)
    // someone who does not see it: the 404 of a missing chat
    expect((await errOf(h.api('bob').call(API.leaveChat, { params: { id } }))).status).toBe(404)
  })

  test('the last one out makes it the creator\'s own chat again', async () => {
    const id = await newChat('alice', 'last one')
    await share('alice', id, [bob])
    await h.api('bob').call(API.leaveChat, { params: { id } })
    const row = db().query('SELECT people_shared_at FROM chats WHERE id = ?').get(id) as { people_shared_at: string | null }
    expect(row.people_shared_at).toBeNull()
    expect(await sees('alice', id)).toBe(true)
  })

  test('a leaver\'s running answer there stops', async () => {
    const id = await newChat('alice', 'busy')
    await share('alice', id, [bob])
    const started = await h.api('bob').call(API.sendMessage, { params: { id }, body: { content: `long\n${fake({ sleep: 20_000 })}`, clientMessageId: cm(), attachmentIds: [] } })
    await waitFor(() => !!h.rt().activeTurn(id))
    await h.api('bob').call(API.leaveChat, { params: { id } })
    await waitFor(() => (db().query('SELECT status FROM messages WHERE id = ?').get(started.assistantMessage.id) as { status: string }).status === 'stopped')
  })
})

describe('lost-access notices', () => {
  test('stopped sharing: the people taken out are told who, without the chat\'s title', async () => {
    const id = await newChat('alice', 'secret title stop')
    await share('alice', id, [bob])
    await share('alice', id, [])
    const n = await lost('bob', id)
    expect(n).toHaveLength(1)
    expect(n[0]!.chatLost).toEqual({ reason: 'stopped', name: 'Alice Kim', title: null })
    expect(n[0]!.link).toBeNull()
    expect(JSON.stringify(n[0])).not.toContain('secret title stop')
    // the earlier "shared a chat with you" is read now (it would only repeat "no longer shared")
    expect(db().query("SELECT COUNT(*) AS n FROM chat_share_notices WHERE user_id = 'bob' AND chat_id = ? AND read_at IS NULL").get(id)).toEqual({ n: 0 })
    // shared again a moment later (a quick remove and add): the notice is taken back, the share notice is unread again
    await share('alice', id, [bob])
    expect(await lost('bob', id)).toHaveLength(0)
    expect(db().query("SELECT COUNT(*) AS n FROM chat_share_notices WHERE user_id = 'bob' AND chat_id = ? AND read_at IS NULL").get(id)).toEqual({ n: 1 })
    // taken out again and shared again only after the quiet time: the notice stays, names the chat and opens it again
    await share('alice', id, [])
    db().query("UPDATE chat_lost_notices SET created_at = ? WHERE user_id = 'bob' AND chat_id = ?").run(new Date(Date.now() - 11 * 60_000).toISOString(), id)
    await share('alice', id, [bob])
    const again = (await lost('bob', id))[0]!
    expect(again.chatLost?.title).toBeTruthy()
    expect(again.link).toBe('chat')
  })

  test('moved to the trash: the others are told; a restore takes the unread notice back', async () => {
    const id = await newChat('alice', 'trash me')
    await share('alice', id, [bob, erin])
    await h.api('alice').call(API.deleteChat, { params: { id } })
    expect((await lost('bob', id)).map((x) => x.chatLost?.reason)).toEqual(['deleted'])
    expect((await lost('erin', id)).map((x) => x.chatLost?.name)).toEqual(['Alice Kim'])
    expect(await lost('alice', id)).toHaveLength(0)
    await h.api('alice').call(API.restoreChat, { params: { id } })
    expect(await lost('bob', id)).toHaveLength(0)
  })
})

describe('a creator\'s account goes', () => {
  const makeUser = async (name: string) => {
    const id = name.split(' ')[0]!.toLowerCase()
    addTestPerson(id, { id, name, role: 'member', locale: 'en' })
    db().query("INSERT INTO users (id, username, name, role, locale) VALUES (?, ?, ?, 'member', 'en')").run(id, id, name)
    const sock = await h.ws(id); await sock.next('hello')
    ws[id] = sock
    return id
  }

  test('deleted: the delete dialog counts every chat they shared; the people are told when it goes; the line under the box says so', async () => {
    const frank = await makeUser('Frank Ode')
    const id = await newChat(frank, 'frank shares')
    await share(frank, id, [bob])
    // shared, nobody else wrote yet: counted all the same (QA TC-7341)
    expect((await h.api('dana').call(API.userSharedChats, { params: { id: frank } })).sharedChats).toBe(1)
    await h.api('dana').call(API.deleteUser, { params: { id: frank }, query: { personalFolder: 'delete' }, body: {} })
    const n = await lost('bob', id)
    expect(n).toHaveLength(1)
    expect(n[0]!.chatLost).toMatchObject({ reason: 'account', name: 'Frank Ode' })
    const until = Date.parse(n[0]!.chatLost!.until!)
    expect(until).toBeGreaterThan(Date.now() + 6 * 86_400_000)
    // bob still sees the chat until then, and reads why under the box
    const c = await h.api('bob').call(API.getChat, { params: { id } })
    expect(c.shared?.byGone).toEqual({ state: 'deleted', until: n[0]!.chatLost!.until! })
  })

  test('switched off: the line under the box says so; back on, it goes', async () => {
    const gina = await makeUser('Gina Park')
    const id = await newChat(gina, 'gina shares')
    await share(gina, id, [bob])
    await h.api('dana').call(API.updateUser, { params: { id: gina }, body: { status: 'disabled' } })
    expect((await h.api('bob').call(API.getChat, { params: { id } })).shared?.byGone).toEqual({ state: 'disabled' })
    await h.api('dana').call(API.updateUser, { params: { id: gina }, body: { status: 'active' } })
    expect((await h.api('bob').call(API.getChat, { params: { id } })).shared?.byGone).toBeUndefined()
  })

  test('an answer running for a removed requester stops and says why to the others', async () => {
    const hank = await makeUser('Hank Yu')
    const id = await newChat('alice', 'hank asks here')
    await share('alice', id, [{ subjectType: 'user', subjectId: hank }])
    const started = await h.api(hank).call(API.sendMessage, { params: { id }, body: { content: `long work\n${fake({ sleep: 20_000 })}`, clientMessageId: cm(), attachmentIds: [] } })
    await waitFor(() => !!h.rt().activeTurn(id))
    await h.api('dana').call(API.deleteUser, { params: { id: hank }, query: { personalFolder: 'delete' }, body: {} })
    await waitFor(() => (db().query('SELECT status FROM messages WHERE id = ?').get(started.assistantMessage.id) as { status: string }).status === 'stopped')
    const page = await h.api('alice').call(API.listMessages, { params: { id }, query: {} })
    const m = page.items.find((x) => x.id === started.assistantMessage.id)
    expect(m?.stoppedFor).toEqual({ reason: 'requester_removed', name: 'Hank Yu' })
    // never the "paused at a limit" outcome
    expect(m?.stopReason ?? null).toBeNull()
  })

  test('a queued turn of a removed person never stops someone else\'s running answer there', async () => {
    const ivy = await makeUser('Ivy Cho')
    const id = await newChat('alice', 'alice runs')
    await share('alice', id, [{ subjectType: 'user', subjectId: ivy }])
    const mine = await h.api('alice').call(API.sendMessage, { params: { id }, body: { content: `mine\n${fake({ sleep: 4000 }, { say: 'alice done' })}`, clientMessageId: cm(), attachmentIds: [] } })
    await waitFor(() => !!h.rt().activeTurn(id))
    const theirs = await h.api(ivy).call(API.sendMessage, { params: { id }, body: { content: `theirs\n${fake({ say: 'never' })}`, clientMessageId: cm(), attachmentIds: [] } }).catch(() => null)
    await h.api('dana').call(API.updateUser, { params: { id: ivy }, body: { status: 'disabled' } })
    const done = await ws.alice!.next('message.done', (f) => f.data.messageId === mine.assistantMessage.id, 30_000)
    expect(done.data.status).toBe('done')
    if (theirs) {
      const row = db().query('SELECT status, stopped_for FROM messages WHERE id = ?').get(theirs.assistantMessage.id) as { status: string; stopped_for: string | null }
      expect(row).toEqual({ status: 'stopped', stopped_for: 'requester_disabled' })
    }
  })
})
