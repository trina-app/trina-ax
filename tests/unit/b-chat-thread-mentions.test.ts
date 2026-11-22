// @mentions in threads under AI answers of shared chats (docs/decisions/20261118-chat-thread-mentions.md, chat/threads.ts,
// migration 417). Falcon is on projects/falcon: alice writes it, bob reads it; carol (admin) and dana (owner) are not
// members; erin sees only public/. Covered: the box's people (the chat's audience, never me, only while I may reply),
// the server keeping only mentions of people who see the thread now (an outsider, myself, a made-up id and someone the
// answer is hidden from are dropped), the mentioned person following the thread and getting the one notice marked as a
// mention (the Inbox row "mentioned you", by who did), a people-shared chat's audience, and the push following the
// thread setting.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { activityTabHas, API, type ApiError, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { chatThreadPath, chatThreadWanted, followersOf, unreadThreadMentions } from '../../server/src/chat/threads'
import { pushBadge } from '../../server/src/notifications/push-badge'
import { savePreferences } from '../../server/src/notifications/preferences'
import { hiddenAnswersCutover, setHiddenAnswersCutover } from '../../server/src/chat/shared-answers'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-thread-mentions', stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })
// every reply takes a send token (rooms SEND_BURST, then 1 a second per person): this file's tests together send more than
// one burst, which a fast machine does inside a second (429 on the Mac mini), so each test starts with a full budget
beforeEach(() => (roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear())

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
async function answered(chat: string, user = 'alice', say = 'Use the corporate seal.') {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chat }, body: { content: fake({ say }), clientMessageId: cm(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return started.assistantMessage.id
}
const reply = (user: string, chat: string, root: string, text: string, mentions?: string[]) =>
  h.api(user).call(API.sendChatThreadReply, { params: { id: chat, messageId: root }, body: { text, clientId: cm(), ...(mentions ? { mentions } : {}) } })
const thread = (user: string, chat: string, root: string) => h.api(user).call(API.listChatThread, { params: { id: chat, messageId: root }, query: {} })
const notice = (user: string, root: string) => db().query('SELECT id, by_user, reply_id, mention_id, read_at FROM chat_thread_notices WHERE user_id = ? AND source_id = ? AND read_at IS NULL').get(user, root) as { id: string; by_user: string; reply_id: string; mention_id: string | null } | null
const ids = (people: { id: string }[] | undefined) => (people ?? []).map((p) => p.id)

describe('a project chat', () => {
  let chatId: string
  let root: string
  beforeAll(async () => {
    chatId = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
    root = await answered(chatId)
  })

  test('the box offers exactly the people who see the thread now, never me', async () => {
    expect(ids((await thread('alice', chatId, root)).people)).toEqual(['bob'])
    expect(ids((await thread('bob', chatId, root)).people)).toEqual(['alice'])
    // whoever does not see the chat gets the one 404, so no list either
    for (const u of ['carol', 'erin', 'dana']) expect((await errOf(thread(u, chatId, root))).status).toBe(404)
  })

  test('only mentions of people who see the thread are kept: an outsider, myself, a made-up id and duplicates go', async () => {
    expect(followersOf(db(), root)).toEqual([])
    const r = await reply('alice', chatId, root, '@Bob Lee @Carol @Erin can you check?', ['bob', 'carol', 'erin', 'alice', 'nobody', 'bob'])
    expect(r.mentions).toEqual(['bob'])
    expect(JSON.parse((db().query('SELECT mentions FROM chat_thread_replies WHERE id = ?').get(r.id) as { mentions: string }).mentions)).toEqual(['bob'])
    // the list and the live event carry the same
    expect((await thread('bob', chatId, root)).replies.find((x) => x.id === r.id)?.mentions).toEqual(['bob'])
    const ev = await ws.bob!.next('chat.thread', (f) => f.data.rootId === root && f.data.reply?.id === r.id)
    expect(ev.data.reply?.mentions).toEqual(['bob'])
    // bob follows from this reply on (as a room thread's mention); his unread dot follows the thread rule
    expect(followersOf(db(), root)).toEqual(['alice', 'bob'])
    const list = await h.api('bob').call(API.listMessages, { params: { id: chatId }, query: {} })
    expect(list.items.find((m) => m.id === root)?.thread).toMatchObject({ replyCount: 1, newReplies: true })
    // his one notice says it mentions him; nobody outside the chat got anything
    const n = notice('bob', root)
    expect(n).toMatchObject({ by_user: 'alice', reply_id: r.id, mention_id: r.id })
    for (const u of ['carol', 'erin', 'dana']) expect(db().query('SELECT 1 FROM chat_thread_notices WHERE user_id = ? AND source_id = ?').get(u, root)).toBeNull()
    // the Inbox row: "mentioned you", by alice, with the chat's title, while he sees it
    const row = (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((i) => i.id === n!.id)!
    expect(row).toMatchObject({ link: 'chat_thread', chatThread: { chatId, rootId: root, name: 'Alice Kim', mention: true } })
  })

  test('a later reply without a mention keeps the notice a mention, by who mentioned him; read, the next reply is a plain one', async () => {
    const first = notice('bob', root)!
    const r2 = await reply('alice', chatId, root, 'also the date')
    expect(r2.mentions).toEqual([])
    const n = notice('bob', root)!
    expect(n).toMatchObject({ id: first.id, reply_id: r2.id, mention_id: first.mention_id })
    const row = (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((i) => i.id === n.id)!
    expect(row.chatThread).toMatchObject({ name: 'Alice Kim', mention: true })
    await h.api('bob').call(API.markChatThreadRead, { params: { id: chatId, messageId: root }, body: { upTo: r2.id } })
    expect(notice('bob', root)).toBeNull()
    await reply('alice', chatId, root, 'one more')
    const plain = notice('bob', root)!
    expect(plain.mention_id).toBeNull()
    const row2 = (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((i) => i.id === plain.id)!
    expect(row2.chatThread?.mention).toBeUndefined()
  })

  test('the mentioning reply deleted: the notice no longer says "mentioned you"', async () => {
    const r = await reply('alice', chatId, root, '@Bob Lee look', ['bob'])
    const n = notice('bob', root)!
    expect(n.mention_id).toBe(r.id)
    await h.api('alice').call(API.deleteChatThreadReply, { params: { id: chatId, replyId: r.id } })
    const left = notice('bob', root)
    // an earlier unread reply keeps the notice; it is a plain one now
    expect(left?.id).toBe(n.id)
    const row = (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((i) => i.id === n.id)!
    expect(row.chatThread?.mention).toBeUndefined()
  })

  test('a mention is pushed whatever "Replies in threads I\'m part of" says (off by default: a thread rings only on a mention)', async () => {
    await reply('alice', chatId, root, '@Bob Lee push?', ['bob'])
    const n = notice('bob', root)!
    const row = (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((i) => i.id === n.id)!
    expect(row.chatThread?.mention).toBe(true)
    const due = Date.now() + 60_000
    expect(chatThreadWanted(h.ctx, n.id, due)).toBe(true)
    savePreferences(db(), 'bob', { roomThreadReplies: true })
    try { expect(chatThreadWanted(h.ctx, n.id, due)).toBe(true) }
    finally { savePreferences(db(), 'bob', { roomThreadReplies: false }) }
  })

  // the owner 11-22: the 프로젝트 list showed "1" and nothing else did; the app icon's number counts it too (push-badge.ts)
  test('an unread mention counts on the app icon\'s number (a push\'s badge) until the thread is read; a plain reply does not', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
    const r0 = await answered(c, 'alice', 'badge root')
    const base = pushBadge(h.ctx, 'bob')!
    const mentions = unreadThreadMentions(h.ctx, 'bob')
    // alice follows her own answer: a plain reply by bob gives her a notice that is no mention
    await reply('bob', c, r0, 'plain one')
    expect(unreadThreadMentions(h.ctx, 'alice')).toBe(0)
    const r = await reply('alice', c, r0, '@Bob Lee badge?', ['bob'])
    expect(unreadThreadMentions(h.ctx, 'bob')).toBe(mentions + 1)
    expect(pushBadge(h.ctx, 'bob')).toBe(base + 1)
    await h.api('bob').call(API.markChatThreadRead, { params: { id: c, messageId: r0 }, body: { upTo: r.id } })
    expect(unreadThreadMentions(h.ctx, 'bob')).toBe(mentions)
    expect(pushBadge(h.ctx, 'bob')).toBe(base)
    // someone outside the project never counts one
    expect(unreadThreadMentions(h.ctx, 'erin')).toBe(0)
  })

  test('someone the answer is hidden from is not offered and not kept', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
    const hiddenRoot = await answered(c, 'alice', 'hidden from bob')
    const before = hiddenAnswersCutover(db())
    setHiddenAnswersCutover(db(), '9999-12-31T00:00:00.000Z')
    db().query('DELETE FROM shared_answer_reads WHERE message_id = ?').run(hiddenRoot)
    try {
      expect(ids((await thread('alice', c, hiddenRoot)).people)).toEqual([])
      const r = await reply('alice', c, hiddenRoot, '@Bob Lee?', ['bob'])
      expect(r.mentions).toEqual([])
      expect(followersOf(db(), hiddenRoot)).toEqual(['alice'])
      expect(db().query('SELECT 1 FROM chat_thread_notices WHERE user_id = ? AND source_id = ?').get('bob', hiddenRoot)).toBeNull()
    } finally {
      setHiddenAnswersCutover(db(), before)
    }
  })
})

describe('a chat shared with people', () => {
  type Sub = { subjectType: 'user' | 'group'; subjectId: string }
  // the sharing budget is the rooms' sending one: a 429 waits the second it says, as the app does
  const put = async (subjects: Sub[], id: string, confirmKey?: string): Promise<PutChatAudienceResult> => {
    for (let i = 0; ; i++) {
      try { return await h.api('alice').call(API.putChatAudience, { params: { id }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } }) }
      catch (e) { if ((e as ApiError).status !== 429 || i > 5) throw e; await Bun.sleep(1100) }
    }
  }
  async function share(id: string, subjects: Sub[]) {
    let r = await put(subjects, id)
    if (r.status === 'confirm') r = await put(subjects, id, r.confirmKey)
    expect(r.status).toBe('saved')
  }

  // the owner's report (2026-11-22): "@test" in a 2-person shared chat's thread showed as a mention, and the person saw
  // nothing. The notice was made but listed only with the app's own notices: it is a conversation row now, as a room's
  let twoPeople = ''
  test('a mention reaches the person: 멘션·스레드 (Mentions, Threads), counted on 대화, the live notice, the thread link', async () => {
    const c = twoPeople = (await h.api('alice').call(API.createChat, { body: {} })).id
    const root = await answered(c, 'alice', 'two people answer')
    await share(c, [{ subjectType: 'user', subjectId: 'bob' }])
    const before = await h.api('bob').call(API.listNotifications, { query: { limit: 1 } })
    const r = await reply('alice', c, root, '@Bob Lee i\ndsf', ['bob'])
    expect(r.mentions).toEqual(['bob'])
    // the live event tells bob it gave him a notice (the desktop app tells it); the writer gets none
    const ev = await ws.bob!.next('chat.thread', (f) => f.data.rootId === root && f.data.reply?.id === r.id)
    expect(ev.data.notice).toBe('mention')
    const mine = await ws.alice!.next('chat.thread', (f) => f.data.rootId === root && f.data.reply?.id === r.id)
    expect(mine.data.notice).toBeUndefined()
    const n = notice('bob', root)!
    // 대화's 멘션·스레드 lists it (with who, for the photo), 활동's notices do not
    const rooms = await h.api('bob').call(API.listNotifications, { query: { only: 'rooms' } })
    const row = rooms.items.find((i) => i.id === n.id)!
    expect(row).toMatchObject({ code: 'chat.thread_reply', link: 'chat_thread', readAt: null, chatThread: { chatId: c, rootId: root, name: 'Alice Kim', byId: 'alice', mention: true } })
    expect((await h.api('bob').call(API.listNotifications, { query: { only: 'notices' } })).items.some((i) => i.id === n.id)).toBe(false)
    expect((await h.api('bob').call(API.listNotifications, { query: {} })).items.some((i) => i.id === n.id)).toBe(true)
    // counted with the conversation rows (대화's mark), not with 활동's notices; the whole count as before
    const after = await h.api('bob').call(API.listNotifications, { query: { limit: 1 } })
    expect(after.unreadCount).toBe(before.unreadCount + 1)
    expect(after.roomUnreadCount).toBe((before.roomUnreadCount ?? 0) + 1)
    expect(after.noticeUnreadCount).toBe(before.noticeUnreadCount)
    // under Mentions and Threads (the page's tabs and "Mark all as read" share the rule), never DMs
    expect(['all', 'mentions', 'threads', 'dms'].map((t) => activityTabHas(row, t as 'all'))).toEqual([true, true, true, false])
    // a tap (and the push) opens the thread
    expect(chatThreadPath(h.ctx, n.id)).toBe(`/c/${c}/t/${root}`)
    // "Mark all as read" on 활동's notices leaves it; on 멘션·스레드's Mentions it reads it and bob's place in the thread
    await h.api('bob').call(API.markAllNotificationsRead, { body: { tab: 'all', only: 'notices' } })
    expect(notice('bob', root)?.id).toBe(n.id)
    const read = await h.api('bob').call(API.markAllNotificationsRead, { body: { tab: 'mentions', only: 'rooms' } })
    expect(read.read).toBeGreaterThanOrEqual(1)
    expect(notice('bob', root)).toBeNull()
    expect((db().query('SELECT last_read_id FROM chat_thread_follows WHERE root_id = ? AND user_id = ?').get(root, 'bob') as { last_read_id: string }).last_read_id).toBe(r.id)
  })

  test('a plain reply is a Threads row, not a Mentions one; it rings nothing by default (a thread rings only on a mention)', async () => {
    // the same two-person chat, another answer (a share less: the sharing budget)
    const c = twoPeople
    const root = await answered(c, 'alice', 'plain reply answer')
    await reply('bob', c, root, 'first from bob')
    const r = await reply('alice', c, root, 'thanks')
    const ev = await ws.bob!.next('chat.thread', (f) => f.data.rootId === root && f.data.reply?.id === r.id)
    expect(ev.data.notice).toBeUndefined()
    const n = notice('bob', root)!
    const row = (await h.api('bob').call(API.listNotifications, { query: { only: 'rooms' } })).items.find((i) => i.id === n.id)!
    expect(row.chatThread?.mention).toBeUndefined()
    expect(activityTabHas(row, 'threads')).toBe(true)
    expect(activityTabHas(row, 'mentions')).toBe(false)
    // the next reply of the same unread run updates the notice: no second desktop notification; a first mention is one
    const again = await reply('alice', c, root, 'one more')
    expect((await ws.bob!.next('chat.thread', (f) => f.data.rootId === root && f.data.reply?.id === again.id)).data.notice).toBeUndefined()
    const named = await reply('alice', c, root, '@Bob Lee look', ['bob'])
    expect((await ws.bob!.next('chat.thread', (f) => f.data.rootId === root && f.data.reply?.id === named.id)).data.notice).toBe('mention')
    expect(notice('bob', root)?.id).toBe(n.id)
    // Threads' "Mark all as read" reads it (Mentions' would too now) and tells bob's other windows the thread is read
    await h.api('bob').call(API.markAllNotificationsRead, { body: { tab: 'threads', only: 'rooms' } })
    expect(notice('bob', root)).toBeNull()
    expect((await ws.bob!.next('chat.thread', (f) => f.data.rootId === root && f.data.change === 'read')).data.thread?.newReplies).toBe(false)
  })

  test('quiet hours: the notice is made, the desktop app is not told; All with no `only` reads it once', async () => {
    const c = twoPeople
    const root = await answered(c, 'alice', 'quiet hours answer')
    savePreferences(db(), 'bob', { quietHours: { on: true, start: '00:00', end: '23:59', weekends: true } })
    try {
      const r = await reply('alice', c, root, '@Bob Lee at night', ['bob'])
      expect((await ws.bob!.next('chat.thread', (f) => f.data.rootId === root && f.data.reply?.id === r.id)).data.notice).toBeUndefined()
      expect(notice('bob', root)?.mention_id).toBe(r.id)
    } finally { savePreferences(db(), 'bob', { quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } }) }
    const read = await h.api('bob').call(API.markAllNotificationsRead, { body: { tab: 'all' } })
    expect(read.read).toBeGreaterThanOrEqual(1)
    expect(notice('bob', root)).toBeNull()
    // read once: nothing is left to read
    expect((await h.api('bob').call(API.markAllNotificationsRead, { body: { tab: 'all' } })).read).toBe(0)
  })

  test('several mentions in one unread notice: deleting the newest falls back to the one still there, by its author (TC-4853)', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const root = await answered(c, 'alice', 'three people answer')
    await share(c, [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'erin' }])
    const a = await reply('alice', c, root, '@Bob Lee first', ['bob'])
    await reply('alice', c, root, 'no mention in between')
    const cc = await reply('erin', c, root, '@Bob Lee second', ['bob'])
    const n = notice('bob', root)!
    // the notice keeps its first mention as where to look from
    expect(n).toMatchObject({ mention_id: a.id, reply_id: cc.id })
    const rowOf = async () => (await h.api('bob').call(API.listNotifications, { query: {} })).items.find((i) => i.id === n.id)!
    expect((await rowOf()).chatThread).toMatchObject({ mention: true, name: 'Erin Yoo' })
    // the newest mention deleted: still "mentioned you", now by alice (her reply is still there)
    await h.api('erin').call(API.deleteChatThreadReply, { params: { id: c, replyId: cc.id } })
    expect(notice('bob', root)?.id).toBe(n.id)
    expect((await rowOf()).chatThread).toMatchObject({ mention: true, name: 'Alice Kim' })
    // the first one deleted too: a plain reply notice (the reply without a mention is still unread)
    await h.api('alice').call(API.deleteChatThreadReply, { params: { id: c, replyId: a.id } })
    expect(notice('bob', root)?.id).toBe(n.id)
    expect((await rowOf()).chatThread?.mention).toBeUndefined()
    // the first deleted but a later one there: found from the first one's place on
    const later = await reply('erin', c, root, '@Bob Lee third', ['bob'])
    expect(notice('bob', root)).toMatchObject({ id: n.id, mention_id: a.id, reply_id: later.id })
    expect((await rowOf()).chatThread).toMatchObject({ mention: true, name: 'Erin Yoo' })
  })

  test('the people come only with the first page (an older page carries none)', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const root = await answered(c, 'alice', 'paged answer')
    await share(c, [{ subjectType: 'user', subjectId: 'bob' }])
    for (const t of ['one', 'two', 'three']) await reply('alice', c, root, t)
    const first = await h.api('bob').call(API.listChatThread, { params: { id: c, messageId: root }, query: { limit: 1 } })
    expect(ids(first.people)).toEqual(['alice'])
    expect(first.nextCursor).toBeTruthy()
    const older = await h.api('bob').call(API.listChatThread, { params: { id: c, messageId: root }, query: { limit: 1, cursor: first.nextCursor! } })
    expect(older.replies.map((r) => r.content)).toEqual(['two'])
    expect(older.people).toBeUndefined()
  })

  test('its creator and its people are offered; someone taken out is dropped at send time', async () => {
    const c = (await h.api('alice').call(API.createChat, { body: {} })).id
    const root = await answered(c, 'alice', 'people chat answer')
    await share(c, [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'erin' }])
    expect(ids((await thread('bob', c, root)).people).sort()).toEqual(['alice', 'erin'])
    expect(ids((await thread('alice', c, root)).people).sort()).toEqual(['bob', 'erin'])
    // the client's list is never trusted: erin taken out between the list and the send
    await share(c, [{ subjectType: 'user', subjectId: 'bob' }])
    const r = await reply('bob', c, root, '@Erin @Alice Kim', ['erin', 'alice'])
    expect(r.mentions).toEqual(['alice'])
    expect(db().query('SELECT 1 FROM chat_thread_notices WHERE user_id = ? AND source_id = ?').get('erin', root)).toBeNull()
    expect(notice('alice', root)?.mention_id).toBe(r.id)
  })
})
