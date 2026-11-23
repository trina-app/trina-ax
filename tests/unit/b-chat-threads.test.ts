// Threads on AI answers in shared chats (docs/decisions/20261116-chat-answer-threads.md, chat/threads.ts): people talk
// under a finished answer; the AI never reads it. With the fake engine through the real launcher. Falcon is on
// projects/falcon: alice writes it, bob reads it (finance); carol (admin) and dana (owner) are not members; erin sees
// only public/. Covered: the one gate (404 for everyone who does not see the chat or the answer, a question, another
// chat's ids), replies and their summary, the same clientId once, the cap, the read-only reasons, delete and
// moderation (audited with ids only), followers and one notice per unread thread (in place), the Inbox row read live,
// the push's wanted and path, the setting, delete settling notices, read marks, people-shared chats and losing access
// (no event, no notice, the replay turned into resync), a thread quoted into a question (the turn's gates read it as
// other people's words) and the AI-isolation marker.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, CHAT_THREAD_MAX, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { waitFor } from '../lib/wait'
import { chatThreadPath, chatThreadWanted, followersOf, threadVisibleTo } from '../../server/src/chat/threads'
import { quotesOnBranch, withoutQuoteLines } from '../../server/src/chat/read-rooms'
import { ownWords } from '../../server/src/chat/project-members'
import { sharedTranscriptText } from '../../server/src/chat/shared'
import { notificationsOf } from '../../server/src/notifications/service'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { savePreferences } from '../../server/src/notifications/preferences'
import { cancelDisabledPushDeliveries } from '../../server/src/notifications/push-events'
import { hiddenAnswersCutover, setHiddenAnswersCutover } from '../../server/src/chat/shared-answers'
import { TEXT } from '../../server/src/chat/i18n'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const MARKER = 'ZEBRA-MARKER-7731'

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
let chatId: string
let answerId: string
let questionId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-threads', stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'carol', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  const c = await h.api('alice').call(API.createChat, { body: { projectId } })
  chatId = c.id
  const a = await ask('alice', chatId, fake({ say: 'Use the corporate seal or the CEO line.' }))
  answerId = a.started.assistantMessage.id
  questionId = a.started.userMessage!.id
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
async function ask(user: string, chat: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chat }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const done = await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return { started, done: done.data.message }
}
const reply = (user: string, text: string, o: { chat?: string; root?: string; clientId?: string } = {}) =>
  h.api(user).call(API.sendChatThreadReply, { params: { id: o.chat ?? chatId, messageId: o.root ?? answerId }, body: { text, clientId: o.clientId ?? cm() } })
const thread = (user: string, o: { chat?: string; root?: string } = {}) => h.api(user).call(API.listChatThread, { params: { id: o.chat ?? chatId, messageId: o.root ?? answerId }, query: {} })
const notices = (user: string, root = answerId) => db().query('SELECT id, by_user, reply_id, read_at FROM chat_thread_notices WHERE user_id = ? AND source_id = ? ORDER BY created_at, id').all(user, root) as { id: string; by_user: string; reply_id: string; read_at: string | null }[]
const threadEvents = (user: string, root = answerId) => ws[user]!.frames.filter((f): f is Extract<ServerFrame, { type: 'chat.thread' }> => f.type === 'chat.thread' && f.data.rootId === root)
const summaryOf = async (user: string, chat = chatId, root = answerId) => (await h.api(user).call(API.listMessages, { params: { id: chat }, query: {} })).items.find((m) => m.id === root)?.thread

describe('the gate', () => {
  test('whoever does not see the chat or the answer gets the one 404, for every route; a question or a running answer has no thread', async () => {
    for (const u of ['carol', 'erin', 'dana']) {
      expect((await errOf(thread(u))).status).toBe(404)
      expect((await errOf(reply(u, 'hi'))).status).toBe(404)
      expect((await errOf(h.api(u).call(API.markChatThreadRead, { params: { id: chatId, messageId: answerId }, body: { upTo: answerId } }))).status).toBe(404)
    }
    // a question, a made-up id, another chat's answer under this chat's id: the same 404
    expect((await errOf(thread('bob', { root: questionId }))).status).toBe(404)
    expect((await errOf(reply('bob', 'hi', { root: crypto.randomUUID().replace(/^(.{14})./, '$17') }))).body.code).toBe('not_found')
    const other = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a2 = await ask('alice', other.id, fake({ say: 'other' }))
    expect((await errOf(thread('bob', { root: a2.started.assistantMessage.id }))).status).toBe(404)
    expect((await errOf(reply('bob', 'x', { root: a2.started.assistantMessage.id }))).status).toBe(404)
    // a private chat of one person ("Only me") has none
    const mine = await h.api('alice').call(API.createChat, { body: { projectId, private: true } })
    const a3 = await ask('alice', mine.id, fake({ say: 'mine' }))
    expect((await errOf(reply('alice', 'x', { chat: mine.id, root: a3.started.assistantMessage.id }))).status).toBe(404)
    // an answer that failed has none either (done and stopped only)
    const failed = await ask('alice', other.id, fake({ fail: 'boom' }))
    expect(failed.done.status).toBe('error')
    expect((await errOf(reply('alice', 'x', { chat: other.id, root: failed.started.assistantMessage.id }))).status).toBe(404)
  })

  test('an empty, blank or too long reply is refused before anything is kept', async () => {
    expect((await errOf(reply('bob', '   '))).status).toBe(400)
    expect((await errOf(reply('bob', 'x'.repeat(10_001)))).status).toBe(400)
    expect((db().query('SELECT COUNT(*) AS n FROM chat_thread_replies').get() as { n: number }).n).toBe(0)
  })
})

describe('replies', () => {
  test('a reply shows for everyone who sees the chat, live; the asker follows and gets one notice; the same clientId posts once', async () => {
    const before = threadEvents('alice').length
    const clientId = cm()
    const r = await reply('bob', 'Corporate seal, or the CEO line?', { clientId })
    expect(r).toMatchObject({ chatId, rootId: answerId, author: { id: 'bob', name: 'Bob Lee' }, content: 'Corporate seal, or the CEO line?', canDelete: true })
    expect((await reply('bob', 'Corporate seal, or the CEO line?', { clientId })).id).toBe(r.id)
    // the same clientId under another answer is not a way to post there
    expect((db().query('SELECT COUNT(*) AS n FROM chat_thread_replies WHERE root_id = ?').get(answerId) as { n: number }).n).toBe(1)
    const t = await thread('alice')
    expect(t.replies.map((x) => [x.content, x.canDelete])).toEqual([['Corporate seal, or the CEO line?', true]]) // alice made the chat: she moderates
    expect(t).toMatchObject({ canReply: true, onShownBranch: true, full: false, version: { index: 1, count: 1 } })
    expect(t.root.content).toContain('corporate seal')
    expect((await thread('bob')).replies[0]!.canDelete).toBe(true)
    // the live event, to alice (who sees the chat), with her own summary: the asker follows, so it is new for her
    const ev = await ws.alice!.next('chat.thread', (f) => f.data.rootId === answerId && f.data.change === 'reply')
    expect(threadEvents('alice').length).toBe(before + 1)
    expect(ev.data.thread).toMatchObject({ replyCount: 1, repliers: [{ id: 'bob', name: 'Bob Lee' }], newReplies: true })
    expect(ev.data.reply).toMatchObject({ id: r.id, canDelete: true })
    // nobody outside the chat hears anything
    expect(threadEvents('carol').length + threadEvents('erin').length).toBe(0)
    // the summary rides on the messages: new for alice, not for bob (his own)
    expect(await summaryOf('alice')).toMatchObject({ replyCount: 1, newReplies: true })
    expect(await summaryOf('bob')).toMatchObject({ replyCount: 1, newReplies: false })
    expect(followersOf(db(), answerId)).toEqual(['alice', 'bob'])
    expect(notices('alice').length).toBe(1)
    expect(notices('bob').length).toBe(0)
  })

  test('more replies while the notice is unread update it in place (one row, one push); a read marks it, and the next reply makes a new one', async () => {
    const first = notices('alice')[0]!
    const r2 = await reply('bob', 'Seal. Legal said so last time.')
    const now = notices('alice')
    expect(now.length).toBe(1)
    expect([now[0]!.id, now[0]!.reply_id, now[0]!.by_user]).toEqual([first.id, r2.id, 'bob'])
    // the Inbox row, read now: who and which chat, never the text
    const inbox = await h.api('alice').call(API.listNotifications, { query: {} })
    const row = inbox.items.find((i) => i.eventType === 'chat.thread_reply')!
    expect(row).toMatchObject({ link: 'chat_thread', chatId, chatThread: { chatId, rootId: answerId, name: 'Bob Lee' } })
    expect(JSON.stringify(row)).not.toContain('Legal said')
    // the push of a plain reply: wanted with "Replies in threads I'm part of" on (its default, as in Slack), outside
    // quiet hours, and its path is the thread; with it off, a thread rings only on a mention
    expect(chatThreadWanted(h.ctx, first.id)).toBe(true)
    savePreferences(db(), 'alice', { roomThreadReplies: false })
    expect(chatThreadWanted(h.ctx, first.id)).toBe(false)
    savePreferences(db(), 'alice', { roomThreadReplies: true })
    expect(chatThreadWanted(h.ctx, first.id)).toBe(true)
    expect(pushPathOf(h.ctx, 'chat.thread_reply', first.id)).toBe(`/c/${chatId}/t/${answerId}`)
    expect(chatThreadPath(h.ctx, first.id)).toBe(`/c/${chatId}/t/${answerId}`)
    // read up to the newest: the notice counts as read, her other windows hear it
    await h.api('alice').call(API.markChatThreadRead, { params: { id: chatId, messageId: answerId }, body: { upTo: r2.id } })
    expect(notices('alice')[0]!.read_at).not.toBeNull()
    expect(chatThreadWanted(h.ctx, first.id)).toBe(false)
    await ws.alice!.next('chat.thread', (f) => f.data.change === 'read' && f.data.rootId === answerId)
    expect(await summaryOf('alice')).toMatchObject({ replyCount: 2, newReplies: false })
    // a read mark never goes back, and a reply of another thread is no mark here
    expect((await errOf(h.api('alice').call(API.markChatThreadRead, { params: { id: chatId, messageId: answerId }, body: { upTo: questionId } }))).status).toBe(404)
    await reply('bob', 'Also the date line.')
    expect(notices('alice').length).toBe(2)
  })

  test('"Replies in threads I\'m part of" off: no push (what waits is cancelled), the Inbox row still comes', async () => {
    const open = notices('alice').find((n) => !n.read_at)!
    const sid = (db().query("SELECT id FROM sessions WHERE user_id = 'alice' LIMIT 1").get() as { id: string }).id
    db().query("INSERT INTO push_subscriptions (id, user_id, session_id, secret_enc, key_version, config_key, created_at, endpoint_hash, kind) VALUES ('sub-a', 'alice', ?, 'x', 1, 'k', ?, 'h', 'web')").run(sid, new Date(0).toISOString())
    db().query("INSERT INTO chat_thread_push_deliveries (notification_id, subscription_id, next_at, expires_at) VALUES (?, 'sub-a', ?, ?)").run(open.id, new Date().toISOString(), new Date(Date.now() + 86400_000).toISOString())
    const p = savePreferences(db(), 'alice', { roomThreadReplies: false })
    cancelDisabledPushDeliveries(h.ctx, 'alice', p)
    expect((db().query("SELECT state FROM chat_thread_push_deliveries WHERE subscription_id = 'sub-a'").get() as { state: string }).state).toBe('cancelled')
    expect(chatThreadWanted(h.ctx, open.id)).toBe(false)
    const inbox = await h.api('alice').call(API.listNotifications, { query: {} })
    expect(inbox.items.some((i) => i.id === open.id)).toBe(true)
    savePreferences(db(), 'alice', { roomThreadReplies: true })
    expect(chatThreadWanted(h.ctx, open.id)).toBe(true)
    db().query("DELETE FROM push_subscriptions WHERE id = 'sub-a'").run()
  })

  test('delete: the author; the creator moderates (audited with ids only); a plain member may not; the only unread reply gone takes its notice', async () => {
    const mine = await reply('alice', 'I will ask legal.')
    // bob is neither its author nor a moderator (not the creator; finance only reads Falcon)
    expect((await errOf(h.api('bob').call(API.deleteChatThreadReply, { params: { id: chatId, replyId: mine.id } }))).status).toBe(403)
    expect((await thread('bob')).replies.find((r) => r.id === mine.id)!.canDelete).toBe(false)
    // another chat's id with this reply: the 404 of a missing reply
    const other = await h.api('alice').call(API.createChat, { body: { projectId } })
    expect((await errOf(h.api('alice').call(API.deleteChatThreadReply, { params: { id: other.id, replyId: mine.id } }))).status).toBe(404)
    // bob's own reply, while alice's notice of it is unread: gone for everyone, the notice with it
    const open = notices('alice').find((n) => !n.read_at)!
    const bobs = db().query("SELECT id FROM chat_thread_replies WHERE root_id = ? AND author_id = 'bob' ORDER BY id DESC LIMIT 1").get(answerId) as { id: string }
    expect(open.reply_id).toBe(bobs.id)
    await h.api('bob').call(API.deleteChatThreadReply, { params: { id: chatId, replyId: bobs.id } })
    expect(notices('alice').some((n) => n.id === open.id)).toBe(false)
    await ws.alice!.next('chat.thread', (f) => f.data.change === 'deleted' && f.data.replyId === bobs.id)
    // the creator deletes someone else's: audited, ids only
    const first = db().query("SELECT id FROM chat_thread_replies WHERE root_id = ? AND author_id = 'bob' ORDER BY id LIMIT 1").get(answerId) as { id: string }
    await h.api('alice').call(API.deleteChatThreadReply, { params: { id: chatId, replyId: first.id } })
    const audit = db().query("SELECT actor_id, target, detail FROM audit_log WHERE action = 'chat.thread_reply_deleted'").all() as { actor_id: string; target: string; detail: string }[]
    expect(audit.length).toBe(1)
    expect([audit[0]!.actor_id, audit[0]!.target, JSON.parse(audit[0]!.detail)]).toEqual(['alice', chatId, { root: answerId, reply: first.id, author: 'bob' }])
    expect(audit[0]!.detail).not.toContain('seal')
    // her own: no audit
    await h.api('alice').call(API.deleteChatThreadReply, { params: { id: chatId, replyId: mine.id } })
    expect((db().query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'chat.thread_reply_deleted'").get() as { n: number }).n).toBe(1)
  })

  test('safe operations: readable, no new replies (409 safe_ops)', async () => {
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      const e = await errOf(reply('bob', 'x'))
      expect([e.status, e.body.params?.reason]).toEqual([409, 'safe_ops'])
      const t = await thread('bob')
      expect([t.canReply, t.readOnlyReason]).toEqual([false, 'safe_ops'])
    } finally { delete process.env.MYCEL_SAFE_OPS_1A }
  })

  test('the cap: at most 500 replies (409 thread_full); the page says it is full', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a = await ask('alice', c.id, fake({ say: 'cap' }))
    const root = a.started.assistantMessage.id
    const at = new Date().toISOString()
    const ins = db().query("INSERT INTO chat_thread_replies (id, chat_id, root_id, author_id, content, client_id, created_at) VALUES (?, ?, ?, 'alice', 'x', NULL, ?)")
    db().transaction(() => { for (let i = 0; i < CHAT_THREAD_MAX; i++) ins.run(Bun.randomUUIDv7(), c.id, root, at) })()
    const e = await errOf(reply('bob', 'one more', { chat: c.id, root }))
    expect([e.status, e.body.params?.reason]).toEqual([409, 'thread_full'])
    const t = await thread('bob', { chat: c.id, root })
    expect([t.full, t.canReply, t.replies.length]).toEqual([true, false, 50])
    // older pages, oldest first within each, until none are left
    const older = await h.api('bob').call(API.listChatThread, { params: { id: c.id, messageId: root }, query: { cursor: t.nextCursor! } })
    expect(older.replies.length).toBe(50)
    expect(older.replies.at(-1)!.id < t.replies[0]!.id).toBe(true)
  })

  test('a new version of the answer has no thread; the old one keeps its own and says it is not on the shown branch', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a = await ask('alice', c.id, fake({ say: 'v1' }))
    const v1 = a.started.assistantMessage.id
    await reply('bob', 'on v1', { chat: c.id, root: v1 })
    const again = await h.api('alice').call(API.regenerate, { params: { id: c.id, messageId: v1 }, body: {} })
    await ws.alice!.next('message.done', (f) => f.data.messageId === again.assistantMessage.id, 30_000)
    expect(await summaryOf('bob', c.id, again.assistantMessage.id)).toBeUndefined()
    const t = await thread('bob', { chat: c.id, root: v1 })
    expect([t.onShownBranch, t.version]).toEqual([false, { index: 1, count: 2 }])
    expect(t.replies.map((r) => r.content)).toEqual(['on v1'])
  })
})

describe('people-shared chats and losing access', () => {
  type Sub = { subjectType: 'user' | 'group'; subjectId: string }
  const put = (subjects: Sub[], id: string, confirmKey?: string) => h.api('alice').call(API.putChatAudience, { params: { id }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
  async function share(id: string, subjects: Sub[]) {
    let r = await put(subjects, id)
    if (r.status === 'confirm') r = await put(subjects, id, r.confirmKey)
    expect(r.status).toBe('saved')
  }

  test('someone taken out of the chat: the chat\'s reason (no_longer_shared), no event, no notice, a replay turned into resync', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const a = await ask('alice', c.id, fake({ say: 'people chat answer' }))
    const root = a.started.assistantMessage.id
    await share(c.id, [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'erin' }])
    // a guest-free audience: bob and erin reply, both follow
    await reply('bob', 'bob here', { chat: c.id, root })
    await reply('erin', 'erin here', { chat: c.id, root })
    expect(followersOf(db(), root)).toEqual(['alice', 'bob', 'erin'])
    // bob's window goes away; a reply is buffered for him; then he is taken out
    const hello = ws.bob!.frames.find((f) => f.type === 'hello') as Extract<ServerFrame, { type: 'hello' }>
    await reply('alice', 'still bob in it', { chat: c.id, root })
    await ws.bob!.next('chat.thread', (f) => f.data.rootId === root && f.data.reply?.content === 'still bob in it')
    const seq = ws.bob!.frames.filter((f) => f.type === 'chat.thread' && f.data.rootId === root && f.data.reply?.content === 'still bob in it').map((f) => (f as { seq: number }).seq)[0]!
    ws.bob!.close()
    await share(c.id, [{ subjectType: 'user', subjectId: 'erin' }])
    const e = await errOf(thread('bob', { chat: c.id, root }))
    expect([e.status, e.body.params?.reason]).toEqual([404, 'no_longer_shared'])
    expect((await errOf(reply('bob', 'x', { chat: c.id, root }))).status).toBe(404)
    expect(threadVisibleTo(h.ctx, 'bob', c.id, root)).toBe(false)
    const bobNotices = notices('bob', root).length
    await reply('erin', 'after bob left', { chat: c.id, root })
    // a follower who lost the chat gets no new notice
    expect(notices('bob', root).length).toBe(bobNotices)
    // his Inbox row of before says nothing of it any more
    const inbox = await h.api('bob').call(API.listNotifications, { query: {} })
    const ids = new Set(notices('bob', root).map((n) => n.id))
    expect(ids.size).toBeGreaterThan(0)
    const rows = inbox.items.filter((x) => ids.has(x.id))
    expect(rows.length).toBe(ids.size)
    for (const i of rows) expect(i).toMatchObject({ chatId: null, link: null, chatThread: { chatId: null, rootId: null, name: null, title: null, gone: true } })
    // reconnecting from before that reply: no replay of thread text, a resync
    const again = await h.ws('bob', { epoch: hello.epoch, after: seq - 1 })
    ws.bob = again
    const first = await again.next('resync', () => true, 5000).catch(() => null)
    expect(first).not.toBeNull()
    expect(again.frames.some((f) => f.type === 'chat.thread')).toBe(false)
  })

  test('a chat that stopped being shared: its creator reads the thread, no new replies (not_shared)', async () => {
    const c = await h.api('alice').call(API.createChat, { body: {} })
    const a = await ask('alice', c.id, fake({ say: 'soon private' }))
    const root = a.started.assistantMessage.id
    await share(c.id, [{ subjectType: 'user', subjectId: 'erin' }])
    await reply('erin', 'a reply', { chat: c.id, root })
    await share(c.id, [])
    const t = await thread('alice', { chat: c.id, root })
    expect([t.canReply, t.readOnlyReason, t.replies.length]).toEqual([false, 'not_shared', 1])
    const e = await errOf(reply('alice', 'x', { chat: c.id, root }))
    expect([e.status, e.body.params?.reason]).toEqual([409, 'not_shared'])
    expect((await errOf(thread('erin', { chat: c.id, root }))).status).toBe(404)
  })
})

describe('the AI never reads a thread', () => {
  test('a marker only in a reply is in no prompt, history, transcript, search or other table; a quoted thread is other people\'s words', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a = await ask('alice', c.id, fake({ say: 'the first answer' }))
    const root = a.started.assistantMessage.id
    await reply('bob', `We decided: ${MARKER}`, { chat: c.id, root })
    // a next turn by someone who sees the thread: the system prompt, the message and the history it gets
    const sys = await ask('bob', c.id, fake({ echo: 'system' }))
    const hist = await ask('bob', c.id, fake({ echo: 'history' }))
    const msg = await ask('alice', c.id, fake({ echo: 'message' }))
    for (const m of [sys.done, hist.done, msg.done]) {
      expect(m.status).toBe('done')
      expect(m.content).not.toContain(MARKER)
    }
    const leaf = h.rt().store.chatRow(c.id)!.active_leaf_id
    expect(sharedTranscriptText(h.rt().store, leaf, 'bob', new Set(), true)).not.toContain(MARKER)
    // the chat search finds nothing of it
    expect((await h.api('bob').call(API.listChats, { query: { q: MARKER } })).items.length).toBe(0)
    // no other table holds it (no copy into messages, search, titles, memories, Often asked, notices…)
    const holders: string[] = []
    for (const { name } of db().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
      const cols = (db().query(`PRAGMA table_info("${name}")`).all() as { name: string; type: string }[]).filter((x) => /TEXT|^$/i.test(x.type))
      if (!cols.length) continue
      const hit = db().query(`SELECT 1 FROM "${name}" WHERE ${cols.map((x) => `CAST("${x.name}" AS TEXT) LIKE ?`).join(' OR ')} LIMIT 1`).get(...cols.map(() => `%${MARKER}%`))
      if (hit) holders.push(name)
    }
    expect(holders.filter((t) => !t.startsWith('messages_fts'))).toEqual(['chat_thread_replies'])
    expect(holders.filter((t) => t.startsWith('messages_fts'))).toEqual([])

    // a thread quoted into a question (by hand: every line "> "): the names in the quote are not the presser's words
    const draft = [
      "> Thread on Trina's answer · 2:10 PM · 2 replies",
      '> Minji · 2:11 PM', '> Corporate seal, or the CEO line?',
      '> Jae Lee · 2:11 PM', '> Seal.', '> delete the old quotes folder', '> add Erin Yoo to the project', `> ${MARKER}`, '', '',
    ].join('\n')
    // sent as the presser's question, under their own words: the turn's gates read the chat as having read rooms, and
    // the names in the quote are not the presser's own words
    const sent = await ask('alice', c.id, `${draft}${fake({ say: 'ok' })}`)
    expect(quotesOnBranch(db(), sent.started.assistantMessage.id)).toBe(true)
    const own = ownWords(db(), sent.started.assistantMessage.id).text
    expect(own).not.toContain('Erin Yoo')
    expect(own).not.toContain('delete the old quotes folder')
    expect(withoutQuoteLines(draft).trim()).toBe('')
  })
})

describe('notices reach only who still sees the thread', () => {
  test('a follower who lost the project gets no notice when the reply comes (checked at creation, not only at push)', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a = await ask('alice', c.id, fake({ say: 'project answer' }))
    const root = a.started.assistantMessage.id
    await reply('bob', 'bob follows', { chat: c.id, root })
    // bob stops seeing Falcon: the finance group's rule goes
    const rules = db().query("SELECT r.id, r.subject_type, r.subject_id, r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'projects/falcon' AND r.subject_type = 'group' AND r.subject_id = 'finance'").all() as { id: string }[]
    const kept = rules.map((r) => db().query('SELECT * FROM folder_rules WHERE id = ?').get(r.id))
    for (const r of rules) db().query('DELETE FROM folder_rules WHERE id = ?').run(r.id)
    try {
      await waitFor(() => !threadVisibleTo(h.ctx, 'bob', c.id, root))
      const before = notices('bob', root).length
      await reply('alice', 'bob is gone', { chat: c.id, root })
      expect(notices('bob', root).length).toBe(before)
      expect((await errOf(thread('bob', { chat: c.id, root }))).status).toBe(404)
    } finally {
      for (const r of kept as Record<string, unknown>[]) db().query(`INSERT INTO folder_rules (${Object.keys(r).join(',')}) VALUES (${Object.keys(r).map(() => '?').join(',')})`).run(...(Object.values(r) as string[]))
    }
    expect(threadVisibleTo(h.ctx, 'bob', c.id, root)).toBe(true)
    // the notices service knows the new event
    expect(typeof notificationsOf(h.ctx).chatThreadReply).toBe('function')
  })
})

// ---------------- follow-ups of the security review (QA TC-3783 … TC-3788) ----------------
describe('every route answers the one 404 for a hidden answer and a chat in the trash (TC-3787)', () => {
  const routes = (chat: string, root: string, replyId: string) => [
    ['list', () => thread('bob', { chat, root })],
    ['reply', () => reply('bob', 'x', { chat, root })],
    ['read', () => h.api('bob').call(API.markChatThreadRead, { params: { id: chat, messageId: root }, body: { upTo: replyId } })],
    ['delete', () => h.api('bob').call(API.deleteChatThreadReply, { params: { id: chat, replyId } })],
  ] as const

  test('a chat in the trash: 404 for everyone but those who may manage it; its creator reads it, deletes nothing (TC-3783)', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a = await ask('alice', c.id, fake({ say: 'soon in the trash' }))
    const root = a.started.assistantMessage.id
    const r = await reply('bob', 'bob before the trash', { chat: c.id, root })
    await h.api('alice').call(API.deleteChat, { params: { id: c.id } })
    for (const [name, run] of routes(c.id, root, r.id)) {
      const e = await errOf(run())
      expect({ name, status: e.status, code: e.body.code, reason: e.body.params?.reason }).toEqual({ name, status: 404, code: 'not_found', reason: undefined })
    }
    const t = await thread('alice', { chat: c.id, root })
    expect([t.readOnlyReason, t.canReply, t.replies.map((x) => x.canDelete)]).toEqual(['trash', false, [false]])
    expect((await errOf(h.api('alice').call(API.deleteChatThreadReply, { params: { id: c.id, replyId: r.id } }))).status).toBe(404)
    expect((await errOf(reply('alice', 'x', { chat: c.id, root }))).status).toBe(404)
  })

  test('safe operations: no delete, the API refuses it like any write (409 safe_ops) and the page offers none (TC-3784)', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a = await ask('alice', c.id, fake({ say: 'safe' }))
    const root = a.started.assistantMessage.id
    const r = await reply('alice', 'mine', { chat: c.id, root })
    process.env.MYCEL_SAFE_OPS_1A = '1'
    try {
      const e = await errOf(h.api('alice').call(API.deleteChatThreadReply, { params: { id: c.id, replyId: r.id } }))
      expect([e.status, e.body.params?.reason]).toEqual([409, 'safe_ops'])
      // its words are about deleting the reply, not "continuing shared chats" (TC-3937)
      expect(Object.values(TEXT.threadReplyDeleteSafeOps)).toContain(e.body.message)
      expect(Object.values(TEXT.sharedChatSafeOps)).not.toContain(e.body.message)
      expect((await thread('alice', { chat: c.id, root })).replies.map((x) => x.canDelete)).toEqual([false])
    } finally { delete process.env.MYCEL_SAFE_OPS_1A }
    expect((await thread('alice', { chat: c.id, root })).replies.map((x) => x.canDelete)).toEqual([true])
  })

  test('the notices are found by their answer and their chat through an index, never a scan of the table (TC-3785)', () => {
    // (a statement of its own, finalized: a cached EXPLAIN of a DELETE left open would hold the server's next commit)
    const plan = (sql: string) => {
      const st = db().prepare(`EXPLAIN QUERY PLAN ${sql}`)
      try { return (st.all('x') as { detail: string }[]).map((r) => r.detail).join(' | ') } finally { st.finalize() }
    }
    // what the triggers and settleNotices run
    expect(plan('DELETE FROM chat_thread_notices WHERE source_id = ?')).toMatch(/USING (COVERING )?INDEX chat_thread_notices_source/)
    expect(plan('DELETE FROM chat_thread_notices WHERE chat_id = ?')).toMatch(/USING (COVERING )?INDEX chat_thread_notices_chat/)
    expect(plan('SELECT id FROM chat_thread_notices n WHERE n.source_id = ? AND n.read_at IS NULL')).toMatch(/USING (COVERING )?INDEX chat_thread_notices_(source|open)/)
    for (const sql of ['DELETE FROM chat_thread_notices WHERE source_id = ?', 'DELETE FROM chat_thread_notices WHERE chat_id = ?']) expect(plan(sql)).not.toMatch(/^SCAN chat_thread_notices$/)
  })

  test('a purged chat takes its thread notices with it (TC-3785)', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a = await ask('alice', c.id, fake({ say: 'to purge' }))
    const root = a.started.assistantMessage.id
    await reply('bob', 'a notice for alice', { chat: c.id, root })
    expect(notices('alice', root).length).toBe(1)
    h.rt().purgeChat(c.id)
    await waitFor(() => !db().query('SELECT 1 FROM chats WHERE id = ?').get(c.id))
    expect(db().query('SELECT COUNT(*) AS n FROM chat_thread_notices WHERE chat_id = ? OR source_id = ?').get(c.id, root)).toEqual({ n: 0 })
    expect(db().query('SELECT COUNT(*) AS n FROM chat_thread_replies WHERE chat_id = ?').get(c.id)).toEqual({ n: 0 })
  })

  test('an answer hidden from bob: the same 404 on every route; its asker still reads the thread', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const a = await ask('alice', c.id, fake({ say: 'hidden from bob' }))
    const root = a.started.assistantMessage.id
    const r = await reply('alice', 'only alice sees this', { chat: c.id, root })
    // an older answer with nothing recorded of what it read (chat/shared-answers.ts): hidden from all but its asker
    const before = hiddenAnswersCutover(db())
    setHiddenAnswersCutover(db(), '9999-12-31T00:00:00.000Z')
    db().query('DELETE FROM shared_answer_reads WHERE message_id = ?').run(root)
    try {
      for (const [name, run] of routes(c.id, root, r.id)) {
        const e = await errOf(run())
        expect({ name, status: e.status, code: e.body.code, leaks: JSON.stringify(e.body).includes('only alice') }).toEqual({ name, status: 404, code: 'not_found', leaks: false })
      }
      expect(threadVisibleTo(h.ctx, 'bob', c.id, root)).toBe(false)
      expect((await thread('alice', { chat: c.id, root })).replies.length).toBe(1)
      // and no line under it in bob's messages
      expect(await summaryOf('bob', c.id, root)).toBeUndefined()
    } finally {
      // put the setting back as it was, also when there was none
      setHiddenAnswersCutover(db(), before)
    }
    expect(hiddenAnswersCutover(db())).toBe(before)
  })
})

describe('chat events are not replayed to someone taken out of a people-shared chat (TC-3788)', () => {
  test('bob, offline, taken out: his reconnect gets resync, not the chat\'s events since', async () => {
    type Sub = { subjectType: 'user' | 'group'; subjectId: string }
    const put = (subjects: Sub[], id: string, confirmKey?: string) => h.api('alice').call(API.putChatAudience, { params: { id }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
    const share = async (id: string, subjects: Sub[]) => { let r = await put(subjects, id); if (r.status === 'confirm') r = await put(subjects, id, r.confirmKey); expect(r.status).toBe('saved') }
    const c = await h.api('alice').call(API.createChat, { body: {} })
    await ask('alice', c.id, fake({ say: 'first' }))
    await share(c.id, [{ subjectType: 'user', subjectId: 'bob' }])
    const bobWs = await h.ws('bob')
    const hello = await bobWs.next('hello')
    bobWs.close()
    await bobWs.closedWith()
    // something happens in the chat while bob's window is away: its chat.updated is buffered for him
    await ask('alice', c.id, fake({ say: 'SECRET-AFTER-BOB-LEFT' }))
    await share(c.id, [])
    const again = await h.ws('bob', { epoch: hello.epoch, after: hello.seq })
    const first = await again.next('resync', () => true, 5000).catch(() => null)
    expect(first).not.toBeNull()
    expect(again.frames.some((f) => (f.type === 'chat.updated' && (f as { data: { chat: unknown } }).data.chat !== null) || f.type.startsWith('message.'))).toBe(false)
    again.close()
    // her own window: the same replay goes through untouched
    const aliceWs = await h.ws('alice')
    const ah = await aliceWs.next('hello')
    aliceWs.close()
    await aliceWs.closedWith()
    await h.api('alice').call(API.updateChat, { params: { id: c.id }, body: { title: 'renamed' } })
    const back = await h.ws('alice', { epoch: ah.epoch, after: ah.seq })
    expect((await back.next('hello')).resumed).toBe(true)
    back.close()
  })
})

describe('QA TC-3625: after a thread was quoted, "add them to the project" in a shared chat', () => {
  test('a shared chat does not offer change_project_members, and its prompt tells the AI to say so plainly (delete_files is there for the AI\'s own files only, QA TC-7332)', async () => {
    const c = await h.api('alice').call(API.createChat, { body: { projectId } })
    const tools = (await ask('alice', c.id, fake({ echo: 'tools' }))).done.content
    expect(tools).toContain('read')
    expect(tools.split(',')).not.toContain('change_project_members')
    expect(tools.split(',')).toContain('delete_files')
    const sys = (await ask('alice', c.id, fake({ echo: 'system' }))).done.content
    expect(sys).toContain("Only an admin changes this project's members")
    expect(sys).toContain("putting other people's team files in the trash")
    expect(sys).toContain('say plainly')
    // a person's own chat in the same project does have them (the card is reachable there)
    const own = await h.api('alice').call(API.createChat, { body: { projectId, private: true } })
    const mine = (await ask('alice', own.id, fake({ echo: 'tools' }))).done.content
    expect(mine).toContain('change_project_members')
  })
})
