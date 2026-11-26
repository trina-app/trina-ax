// A team project's shared chat tells nobody of someone else's message (owner 2026-11-26, docs/decisions/
// 20261126-project-chat-mention-only.md, replacing the 11-22 rule; chat/message-notices.ts): a new chat a teammate
// starts, a message in a chat I wrote in, Trina's answers and a scheduled run's answer give no notice, no unread number,
// no push and no desktop ring; old unread rows from before are never shown (migration 457 reads them). Only a mention
// notifies: a thread reply that mentions me rings with "Replies in threads I'm part of" off, a plain reply does not.
// Falcon is on projects/falcon: alice writes it, the finance group (bob, and erin for this file) reads it; carol (admin)
// and dana (owner) are not members.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { chatMessageWanted, noteSharedAnswer, noteSharedMessage, unreadByUser } from '../../server/src/chat/message-notices'
import { chatThreadWanted } from '../../server/src/chat/threads'
import { getPreferences, pushEventEnabled, savePreferences } from '../../server/src/notifications/preferences'
import { pushBadge } from '../../server/src/notifications/push-badge'
import { roomsOf } from '../../server/src/rooms/service'
import { CONFIRMED } from '../lib/schedule-card'
import { waitFor } from '../lib/wait'

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

describe('someone else\'s message in a project chat', () => {
  const noRing = (user: string, from: number, messageId: string) => expect(updates(user).slice(from).some((f) => f.data.notice?.messageId === messageId)).toBe(false)

  test('a message in a chat I wrote in: no notice, number, mark or ring for me or anyone', async () => {
    await h.api('alice').call(API.markChatSeen, { params: { id: chatId } })
    const before = { alice: updates('alice').length, erin: updates('erin').length }
    const s = await say('bob', 'Can we ship on Friday?')
    const msg = s.userMessage!.id
    for (const u of ['alice', 'erin', 'bob', 'carol', 'dana']) expect(notices(u)).toEqual([])
    noRing('alice', before.alice, msg)
    noRing('erin', before.erin, msg)
    // the chat.updated still reaches the members (the new message shows), without an unread number
    expect(updates('erin').length).toBeGreaterThan(before.erin)
    for (const f of updates('erin').slice(before.erin)) expect(f.data.chat?.unreadCount).toBeUndefined()
    const a = await h.api('alice').call(API.getChat, { params: { id: chatId } })
    expect(a.unreadCount).toBeUndefined()
    expect(a.unseen).toBeFalsy()
    const e = await h.api('erin').call(API.getChat, { params: { id: chatId } })
    expect(e.unreadCount).toBeUndefined()
    expect(e.unseen).toBeFalsy()
  })

  test('a new chat a teammate starts in the project tells nobody', async () => {
    const theirs = (await h.api('bob').call(API.createChat, { body: { projectId } })).id
    await say('bob', 'a new idea', { chat: theirs })
    expect(db().query('SELECT COUNT(*) n FROM chat_message_notices WHERE chat_id = ?').get(theirs)).toEqual({ n: 0 })
    for (const u of ['alice', 'erin']) expect(ws[u]!.frames.some((f) => f.type === 'chat.updated' && f.data.chatId === theirs && !!f.data.notice)).toBe(false)
    for (const u of ['alice', 'erin']) {
      expect((await h.api(u).call(API.listChats, { query: { unread: '1' } })).items).toEqual([])
      expect(pushBadge(h.ctx, u)).toBe(0)
    }
  })

  test('Trina\'s answer and an "@" sent by an older page in the main box tell nobody', async () => {
    const ping = await say('bob', '@Erin Yoo look', { mentions: ['erin', 'carol'] })
    expect(of('erin', ping.userMessage!.id)).toEqual([])
    expect(of('erin', ping.assistantMessage.id)).toEqual([])
    const chat = h.ctx.db.query('SELECT * FROM chats WHERE id = ?').get(chatId) as Parameters<typeof noteSharedAnswer>[1]
    expect(noteSharedAnswer(h.ctx, chat, ping.assistantMessage.id, 'bob').size).toBe(0)
    expect(noteSharedMessage(h.ctx, chat, ping.userMessage!.id, 'bob').size).toBe(0)
    expect(db().query('SELECT COUNT(*) n FROM chat_message_notices WHERE chat_id = ?').get(chatId)).toEqual({ n: 0 })
  })

  test('an unread row made before the change is never shown or pushed, and migration 457 reads it', async () => {
    const msg = (db().query("SELECT id FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1").get(chatId) as { id: string }).id
    const id = crypto.randomUUID()
    db().query(`INSERT INTO chat_message_notices (id, user_id, event_type, source_id, chat_id, by_user, kind, created_at, suppressed, quiet, mention)
      VALUES (?, 'erin', 'chat.message', ?, ?, 'bob', 'message', ?, 0, 0, 0)`).run(id, msg, chatId, new Date().toISOString())
    expect((await h.api('erin').call(API.getChat, { params: { id: chatId } })).unreadCount).toBeUndefined()
    expect((await h.api('erin').call(API.listChats, { query: { unread: '1' } })).items).toEqual([])
    expect(pushBadge(h.ctx, 'erin')).toBe(0)
    expect(chatMessageWanted(h.ctx, id)).toBe(false)
    expect(unreadByUser(db(), chatId).get('erin')?.n).toBe(1)
    db().exec(await Bun.file(new URL('../../server/migrations/457_b_project_chat_notices_read.sql', import.meta.url)).text())
    expect(unread('erin')).toEqual([])
  })

  test('the audience still lists the chat\'s people but me (who a thread reply may mention)', async () => {
    const a = await h.api('bob').call(API.getChatAudience, { params: { id: chatId } })
    expect(a.mentionable?.map((p) => p.id).sort()).toEqual(['alice', 'erin'])
  })
})

describe('threads ring only on a mention', () => {
  let root: string
  // these tests read the switch off for alice and bob (on by default since 2026-11-23,
  // docs/decisions/20261123-thread-replies-default-on.md): with it off, a thread rings only on a mention
  beforeAll(async () => {
    root = (await say('alice', 'root answer')).assistantMessage.id
    for (const u of ['alice', 'bob']) savePreferences(db(), u, { roomThreadReplies: false })
  })
  const reply = (user: string, text: string, mentions?: string[]) =>
    h.api(user).call(API.sendChatThreadReply, { params: { id: chatId, messageId: root }, body: { text, clientId: cm(), ...(mentions ? { mentions } : {}) } })
  const notice = (user: string) => db().query('SELECT id, mention_id, created_at, read_at FROM chat_thread_notices WHERE user_id = ? AND source_id = ? AND read_at IS NULL').get(user, root) as { id: string; mention_id: string | null; created_at: string } | null
  const threadEvents = (user: string) => ws[user]!.frames.filter((f): f is Extract<ServerFrame, { type: 'chat.thread' }> => f.type === 'chat.thread' && f.data.rootId === root)

  test('"Replies in threads I\'m part of" is on by default (as in Slack); the push of a chat thread is decided per notice', () => {
    expect(getPreferences(db(), 'nobody-saved-settings').roomThreadReplies).toBe(true)
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

// AB4: a scheduled run's answer in a project chat is Trina's, not the reader's own: it tells nobody either (only its
// owner's finished notice, notifications/chat-answers.ts)
describe("a scheduled run's answer in a project chat", () => {
  const farTime = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + 12 * 3_600_000))
  test('no member gets a notice or a ring', async () => {
    const before = updates('bob').length
    const s = h.rt().schedules.create('alice', { title: 'Morning ' + crypto.randomUUID().slice(0, 6), prompt: fake({ say: 'the morning summary' }), repeat: 'daily', time: farTime(), projectId }, undefined, CONFIRMED, { chatId })
    db().query('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id)
    expect(h.rt().schedules.runDue(new Date())).toEqual([s.id])
    const t = db().query('SELECT id FROM turns WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1').get(s.id) as { id: string }
    const answer = () => (db().query("SELECT id, status FROM messages WHERE turn_id = ? AND role = 'assistant'").get(t.id) as { id: string; status: string } | null)
    await waitFor(() => answer()?.status === 'done', { timeoutMs: 30_000 })
    h.rt().schedules.delete('alice', s.id)
    await Bun.sleep(200)
    const a = answer()!.id
    for (const u of ['alice', 'bob', 'erin']) expect(of(u, a)).toEqual([])
    expect(updates('bob').slice(before).some((f) => (f.data as { notice?: { messageId: string } }).notice?.messageId === a)).toBe(false)
  })
})
