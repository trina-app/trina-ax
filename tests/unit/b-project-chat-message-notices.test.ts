// A team project's shared chat tells its people of a new message, as a chat shared with people does (owner 2026-11-22,
// docs/decisions/20261122-project-chat-notices-threads-mention-only.md; chat/message-notices.ts), and a reply in a thread
// rings only on a mention. Falcon is on projects/falcon: alice writes it, the finance group (bob, and erin for this file)
// reads it; carol (admin) and dana (owner) are not members. Covered: a person's message gives every other member a
// notice (never the sender, never a non-member, a guest or anyone for an "Only me" chat), the unread number and the
// chat.updated `notice`, Trina's answer as a number only, /seen, "Mute this chat" (no mention gets through it: the main box
// mentions nobody, docs/decisions/20261122-ai-session-no-main-mention.md), the chat's people, the unread list and the push badge for a member who never wrote there, the fan-out's reads not growing with the
// project, and the thread rule (a plain reply listed but not rung, a mention rung with the switch off, pushed anew on an
// open notice).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { chatMessageWanted, noteSharedAnswer, noteSharedMessage, unreadByUser } from '../../server/src/chat/message-notices'
import { hiddenAnswersCutover, setAnswerReads, setHiddenAnswersCutover } from '../../server/src/chat/shared-answers'
import { chatThreadWanted } from '../../server/src/chat/threads'
import { getPreferences, pushEventEnabled, savePreferences } from '../../server/src/notifications/preferences'
import { pushBadge } from '../../server/src/notifications/push-badge'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
let chatId: string
const db = () => h.ctx.db
async function say(user: string, content: string, o: { chat?: string; mentions?: string[] } = {}) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: o.chat ?? chatId }, body: { content: fake({ say: content }), clientMessageId: cm(), attachmentIds: [], ...(o.mentions ? { mentions: o.mentions } : {}) } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return started
}
type Row = { id: string; source_id: string; kind: string; quiet: number; mention: number; read_at: string | null }
const notices = (user: string, chat = chatId) => db().query('SELECT id, source_id, kind, quiet, mention, read_at FROM chat_message_notices WHERE user_id = ? AND chat_id = ? ORDER BY created_at, rowid').all(user, chat) as Row[]
const unread = (user: string) => notices(user).filter((n) => !n.read_at)
const of = (user: string, messageId: string) => notices(user).filter((n) => n.source_id === messageId)
const updates = (user: string) => ws[user]!.frames.filter((f): f is Extract<ServerFrame, { type: 'chat.updated' }> => f.type === 'chat.updated' && f.data.chatId === chatId)

beforeAll(async () => {
  h = await startHarness({ name: 'b-project-chat-message-notices', stallTimeoutMs: 60_000 })
  // a third member: erin reads falcon through the finance group in this file
  db().query("INSERT INTO group_members (group_id, user_id) VALUES ('finance', 'erin')").run()
  for (const u of ['alice', 'bob', 'erin', 'carol']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  projectId = (await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })).id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
  chatId = (await h.api('alice').call(API.createChat, { body: { projectId } })).id
  await say('alice', 'kickoff')
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })
beforeEach(() => (roomsOf(h.ctx) as unknown as { sendBudget: Map<string, unknown> }).sendBudget.clear())

describe('a person\'s message in a project chat', () => {
  test('every other member gets a notice that may ring; the sender and non-members none', async () => {
    const before = updates('erin').length
    const s = await say('bob', 'Can we ship on Friday?')
    const msg = s.userMessage!.id
    for (const u of ['alice', 'erin']) expect(of(u, msg)).toMatchObject([{ kind: 'message', quiet: 0, mention: 0, read_at: null }])
    expect(of('bob', msg)).toEqual([])
    for (const u of ['carol', 'dana']) expect(db().query('SELECT COUNT(*) n FROM chat_message_notices WHERE user_id = ?').get(u)).toEqual({ n: 0 })
    // erin never wrote there: the chat.updated still reaches her with the notice (desktop notice and sound)
    expect(updates('erin').slice(before).some((f) => f.data.notice?.messageId === msg)).toBe(true)
    expect(chatMessageWanted(h.ctx, of('erin', msg)[0]!.id)).toBe(true)
    const e = await h.api('erin').call(API.getChat, { params: { id: chatId } })
    expect(e.unreadCount).toBe(unread('erin').length)
    expect(e.unseen).toBe(true)
  })

  test('Trina\'s answer is a number for the others, never pushed, nothing for its asker', async () => {
    const answers = (u: string) => notices(u).filter((n) => n.kind === 'answer')
    expect(answers('erin').length).toBeGreaterThan(0)
    expect(answers('bob').filter((n) => n.kind === 'answer').length).toBe(1) // alice's kickoff answer only
    for (const n of answers('erin')) { expect(n.quiet).toBe(1); expect(chatMessageWanted(h.ctx, n.id)).toBe(false) }
  })

  test('a member who never wrote there: the unread list has the chat, my chat list does not; the push badge counts it', async () => {
    const list = await h.api('erin').call(API.listChats, { query: {} })
    expect(list.items.some((c) => c.id === chatId)).toBe(false)
    const u = await h.api('erin').call(API.listChats, { query: { unread: '1' } })
    expect(u.items.map((c) => c.id)).toEqual([chatId])
    expect(u.items[0]!.unreadCount).toBe(unread('erin').length)
    expect(pushBadge(h.ctx, 'erin')).toBe(unread('erin').length)
    // not with another filter
    await expect(h.api('erin').call(API.listChats, { query: { unread: '1', projectId } })).rejects.toMatchObject({ status: 400 })
  })

  test('opening the chat reads my notices only', async () => {
    await h.api('erin').call(API.markChatSeen, { params: { id: chatId } })
    expect(unread('erin')).toEqual([])
    expect(unread('alice').length).toBeGreaterThan(0)
    expect((await h.api('erin').call(API.listChats, { query: { unread: '1' } })).items).toEqual([])
  })

  test('"Mute this chat": nothing for me, also for a message naming me with "@"; the audience lists the project chat\'s people but me', async () => {
    expect((await h.api('erin').call(API.muteChat, { params: { id: chatId } })).muted).toBe(true)
    const plain = await say('bob', 'no ping')
    expect(of('erin', plain.userMessage!.id)).toEqual([])
    // an older page still sending `mentions`: ignored (the main box mentions nobody), so the mute holds
    const ping = await say('bob', '@Erin Yoo look', { mentions: ['erin', 'carol'] })
    expect(of('erin', ping.userMessage!.id)).toEqual([])
    expect(db().query('SELECT COUNT(*) n FROM chat_message_notices WHERE user_id = ?').get('carol')).toEqual({ n: 0 })
    expect((await h.api('erin').call(API.unmuteChat, { params: { id: chatId } })).muted).toBeUndefined()
    const a = await h.api('bob').call(API.getChatAudience, { params: { id: chatId } })
    expect(a.mentionable?.map((p) => p.id).sort()).toEqual(['alice', 'erin'])
    // a chat of one person still cannot be muted
    const mine = await h.api('alice').call(API.createChat, { body: {} })
    await expect(h.api('alice').call(API.muteChat, { params: { id: mine.id } })).rejects.toMatchObject({ status: 400 })
  })

  test('an "Only me" chat in the project tells nobody; a guest gets nothing', async () => {
    const own = (await h.api('alice').call(API.createChat, { body: { projectId, private: true } })).id
    await say('alice', 'just me', { chat: own })
    expect(db().query('SELECT COUNT(*) n FROM chat_message_notices WHERE chat_id = ?').get(own)).toEqual({ n: 0 })
    db().query('UPDATE users SET guest = 1 WHERE id = ?').run('erin')
    try {
      const s = await say('bob', 'while erin is a guest')
      expect(of('erin', s.userMessage!.id)).toEqual([])
      expect(of('alice', s.userMessage!.id)).toHaveLength(1)
    } finally { db().query('UPDATE users SET guest = 0 WHERE id = ?').run('erin') }
  })

  test('a member who loses the project: no unread list entry, nothing on the push badge, no push, though the notice stays', async () => {
    const s = await say('bob', 'before erin leaves')
    const n = of('erin', s.userMessage!.id)[0]!
    const before = pushBadge(h.ctx, 'erin')!
    expect(before).toBeGreaterThanOrEqual(unread('erin').length)
    db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'erin'").run()
    try {
      expect((await h.api('erin').call(API.listChats, { query: { unread: '1' } })).items).toEqual([])
      expect(pushBadge(h.ctx, 'erin')).toBe(before - unread('erin').length)
      expect(chatMessageWanted(h.ctx, n.id)).toBe(false)
    } finally {
      db().query("INSERT INTO group_members (group_id, user_id) VALUES ('finance', 'erin')").run()
      await h.api('erin').call(API.markChatSeen, { params: { id: chatId } })
    }
  })

  test('the fan-out reads the same number of times for 3 people or 33 (no read per person)', () => {
    const chat = h.ctx.db.query('SELECT * FROM chats WHERE id = ?').get(chatId) as Parameters<typeof noteSharedMessage>[1]
    const msg = (db().query("SELECT id FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(chatId) as { id: string }).id
    const count = () => {
      const real = db().query.bind(db())
      let n = 0
      const spy = db() as unknown as { query: (sql: string) => unknown }
      spy.query = (sql: string) => { n++; return real(sql) }
      try {
        db().query('DELETE FROM chat_message_notices WHERE source_id = ?').run(msg); n = 0
        const rings = noteSharedMessage(h.ctx, chat, msg, 'bob')
        return { n, rings: rings.size }
      } finally { spy.query = real as never }
    }
    const small = count()
    expect(small.rings).toBe(2)
    for (let i = 0; i < 30; i++) {
      db().query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')").run(`p${i}`, `p${i}`, `P ${i}`)
      db().query("INSERT INTO group_members (group_id, user_id) VALUES ('finance', ?)").run(`p${i}`)
    }
    try {
      const large = count()
      expect(large.rings).toBe(32)
      expect(large.n).toBe(small.n)
    } finally {
      db().query("DELETE FROM chat_message_notices WHERE user_id LIKE 'p%'").run()
      db().query("DELETE FROM group_members WHERE user_id LIKE 'p%'").run()
      db().query("DELETE FROM users WHERE id LIKE 'p%' AND username LIKE 'p%'").run()
    }
  })
})

describe('the answer\'s notices and the unread read stay bounded (review of #362)', () => {
  const chatRow = () => h.ctx.db.query('SELECT * FROM chats WHERE id = ?').get(chatId) as Parameters<typeof noteSharedAnswer>[1]
  const lastAnswer = () => (db().query("SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1").get(chatId) as { id: string }).id
  /** noteSharedAnswer as alice's answer, with every statement it prepares counted and kept */
  const run = (answer: string) => {
    const real = db().query.bind(db())
    const sqls: string[] = []
    const spy = db() as unknown as { query: (sql: string) => unknown }
    db().query('DELETE FROM chat_message_notices WHERE source_id = ?').run(answer)
    spy.query = (sql: string) => { sqls.push(sql); return real(sql) }
    const t0 = performance.now()
    try { noteSharedAnswer(h.ctx, chatRow(), answer, 'alice') } finally { spy.query = real as never }
    return { sqls, ms: performance.now() - t0, told: (db().query('SELECT user_id FROM chat_message_notices WHERE source_id = ?').all(answer) as { user_id: string }[]).map((r) => r.user_id).sort() }
  }
  const addPeople = (n: number) => {
    for (let i = 0; i < n; i++) {
      db().query("INSERT INTO users (id, username, name, role) VALUES (?, ?, ?, 'member')").run(`q${i}`, `q${i}`, `Q ${i}`)
      db().query("INSERT INTO group_members (group_id, user_id) VALUES ('finance', ?)").run(`q${i}`)
    }
  }
  const dropPeople = () => {
    db().query("DELETE FROM chat_message_notices WHERE user_id LIKE 'q%'").run()
    db().query("DELETE FROM group_members WHERE user_id LIKE 'q%'").run()
    db().query("DELETE FROM users WHERE id LIKE 'q%' AND username LIKE 'q%'").run()
  }

  test('a finished answer is judged alone: the same reads for 3 people or 300, never the whole chat per person', async () => {
    // a long chat: many earlier answers the old fan-out walked once per member
    for (let i = 0; i < 15; i++) await say('alice', `step ${i}`)
    const answer = lastAnswer()
    const small = run(answer)
    expect(small.told).toEqual(['bob', 'erin'])
    addPeople(300)
    try {
      const large = run(answer)
      expect(large.told).toHaveLength(302)
      // no statement per person: the same statements as for two people
      expect(large.sqls.length).toBe(small.sqls.length)
      // never a read of every message of the chat (shared-answers.ts chatNodes) nor an account per person
      expect(large.sqls.some((q) => /WHERE m\.chat_id = \? ORDER BY m\.rowid/.test(q))).toBe(false)
      expect(large.sqls.filter((q) => /FROM users WHERE id = \?/.test(q))).toHaveLength(0)
      expect(large.ms).toBeLessThan(2000)
    } finally { dropPeople() }
  })

  test('the answer\'s own record still hides it: an x group from the people not in it; before the cutover, all but its runner', async () => {
    const answer = lastAnswer()
    // what it read is not all known (x): only the people who saw the chat then (bob) see it
    setAnswerReads(db(), chatId, answer, [{ c: ['alice', 'bob'], s: [{ type: 'root' }], x: 1 }])
    expect(run(answer).told).toEqual(['bob'])
    // an older answer (no cutover: the old rule) without a readable record: hidden from all but its runner
    const cut = hiddenAnswersCutover(db())
    db().query('DELETE FROM shared_answer_reads WHERE message_id = ?').run(answer)
    setHiddenAnswersCutover(db(), null)
    try { expect(run(answer).told).toEqual([]) } finally { setHiddenAnswersCutover(db(), cut) }
    setAnswerReads(db(), chatId, answer, [])
    expect(run(answer).told).toEqual(['bob', 'erin'])
  })

  test('everyone\'s unread numbers read the unread rows through their partial index (migration 438)', () => {
    const plan = (db().query(`EXPLAIN QUERY PLAN SELECT user_id, COUNT(*) n FROM chat_message_notices INDEXED BY chat_message_notices_unread_by_chat
      WHERE chat_id = ? AND read_at IS NULL AND suppressed = 0 GROUP BY user_id`).all(chatId) as { detail: string }[]).map((r) => r.detail).join(' | ')
    expect(plan).toContain('chat_message_notices_unread_by_chat')
    expect(plan).not.toContain('TEMP B-TREE')
    // the function itself: read rows are not counted, unread ones are
    const u = unreadByUser(db(), chatId)
    expect(u.get('bob')?.n ?? 0).toBe(unread('bob').length)
    expect(u.get('alice')?.n ?? 0).toBe(unread('alice').length)
  })
})

describe('threads ring only on a mention', () => {
  let root: string
  beforeAll(async () => { root = (await say('alice', 'root answer')).assistantMessage.id })
  const reply = (user: string, text: string, mentions?: string[]) =>
    h.api(user).call(API.sendChatThreadReply, { params: { id: chatId, messageId: root }, body: { text, clientId: cm(), ...(mentions ? { mentions } : {}) } })
  const notice = (user: string) => db().query('SELECT id, mention_id, created_at, read_at FROM chat_thread_notices WHERE user_id = ? AND source_id = ? AND read_at IS NULL').get(user, root) as { id: string; mention_id: string | null; created_at: string } | null
  const threadEvents = (user: string) => ws[user]!.frames.filter((f): f is Extract<ServerFrame, { type: 'chat.thread' }> => f.type === 'chat.thread' && f.data.rootId === root)

  test('"Replies in threads I\'m part of" is off by default; the push of a chat thread is decided per notice', () => {
    expect(getPreferences(db(), 'alice').roomThreadReplies).toBe(false)
    expect(pushEventEnabled(getPreferences(db(), 'alice'), 'chat.thread_reply')).toBe(true)
  })

  test('a plain reply is a row for the asker, never rung or pushed; a mention on that open notice rings and is pushed anew', async () => {
    const r1 = await reply('bob', 'Looks fine')
    await ws.alice!.next('chat.thread', (f) => f.data.reply?.id === r1.id)
    const n1 = notice('alice')!
    expect(n1.mention_id).toBeNull()
    expect(chatThreadWanted(h.ctx, n1.id)).toBe(false)
    expect(threadEvents('alice').find((f) => f.data.reply?.id === r1.id)!.data.notice).toBeUndefined()
    // listed in Mentions & threads all the same
    const inbox = await h.api('alice').call(API.listNotifications, { query: {} })
    expect(inbox.items.some((i) => i.id === n1.id)).toBe(true)
    await Bun.sleep(5)
    const r2 = await reply('erin', '@Alice Kim can you sign?', ['alice'])
    await ws.alice!.next('chat.thread', (f) => f.data.reply?.id === r2.id)
    const n2 = notice('alice')!
    expect(n2.id).toBe(n1.id)
    expect(n2.mention_id).toBe(r2.id)
    expect(n2.created_at > n1.created_at).toBe(true)
    expect(chatThreadWanted(h.ctx, n2.id)).toBe(true)
    expect(threadEvents('alice').find((f) => f.data.reply?.id === r2.id)!.data.notice).toBe('mention')
  })

  test('with the switch on, a plain reply rings as before', async () => {
    savePreferences(db(), 'bob', { roomThreadReplies: true })
    try {
      await h.api('bob').call(API.markChatThreadRead, { params: { id: chatId, messageId: root }, body: { upTo: (db().query('SELECT id FROM chat_thread_replies WHERE root_id = ? ORDER BY id DESC LIMIT 1').get(root) as { id: string }).id } })
      const r = await reply('erin', 'one more')
      await ws.bob!.next('chat.thread', (f) => f.data.reply?.id === r.id)
      expect(chatThreadWanted(h.ctx, notice('bob')!.id)).toBe(true)
      expect(threadEvents('bob').find((f) => f.data.reply?.id === r.id)!.data.notice).toBe('reply')
    } finally { savePreferences(db(), 'bob', { roomThreadReplies: false }) }
  })
})
