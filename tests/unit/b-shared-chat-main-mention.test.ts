// A mention in a shared chat's MAIN box (QA TC-f3-02): the person picked with "@" gets a row under Mentions on 대화's
// 멘션·스레드 (GET /api/notifications, only=rooms, activityTabHas 'mentions') and a phone push, as a thread reply that
// mentions them does. Before, the main box's mention made only a chat_message_notices row, which the Inbox never listed:
// the Mentions tab stayed empty. A plain message (no mention) is still not listed; someone not mentioned gets no row;
// "Mark all as read" on Mentions reads it and its waiting push goes.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { activityTabHas, type InboxNotification } from '@mycel/shared/api'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

test('a main-box @mention: a Mentions row for the person picked and a push; nothing listed for the others', async () => {
  h = await harness('shared-chat-main-mention')
  const owner = await withOwner(h)
  const nora = await addMember(h, owner, { username: 'nora' })
  const jun = await addMember(h, owner, { username: 'jun' })
  getChatRuntime(h.ctx)
  const sent: NativeSend[] = []
  p = new PushService(h.ctx, {
    config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } },
    phoneDecision: () => ({ kind: 'send' }),
  })
  const sid = (h.ctx.db.query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(nora.id) as { id: string }).id
  p.registerDevice(nora.id, sid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex') })
  await new Promise((r) => setTimeout(r, 5))
  const chat = await owner.call('POST', '/api/chats', { title: 'Launch plan' })
  const subjects = [{ subjectType: 'user', subjectId: nora.id }, { subjectType: 'user', subjectId: jun.id }]
  const put = (confirmKey?: string) => owner.call('PUT', `/api/chats/${chat.id}/audience`, { subjects, ...(confirmKey ? { confirmKey } : {}) })
  let r = await put()
  if (r.status === 'confirm') r = await put(r.confirmKey)
  expect(r.status).toBe('saved')
  const ended = async () => { for (let i = 0; i < 600 && h.ctx.db.query("SELECT 1 FROM turns WHERE chat_id = ? AND status IN ('queued','running')").get(chat.id); i++) await new Promise((x) => setTimeout(x, 50)) }
  type List = { items: InboxNotification[]; roomUnreadCount: number; noticeUnreadCount: number }
  const rows = async (c: typeof nora.client) => (await c.call('GET', '/api/notifications?only=rooms')) as List
  const chatRows = (l: List) => l.items.filter((i) => i.code === 'chat.message')

  // a plain message first: not listed (the chat row's number shows it)
  await owner.call('POST', `/api/chats/${chat.id}/messages`, { content: 'plain', attachmentIds: [], clientMessageId: cm() })
  await ended()
  const before = await rows(nora.client)
  expect(chatRows(before)).toEqual([])

  // the main composer's "@nora" (Composer → Chat.tsx onSend → POST /messages with `mentions`)
  const sentMsg = await owner.call('POST', `/api/chats/${chat.id}/messages`, { content: '@NORA can you check?', mentions: [nora.id], attachmentIds: [], clientMessageId: cm() })
  await ended()
  const msgId = sentMsg.userMessage.id as string
  const list = await rows(nora.client)
  const mine = chatRows(list)
  expect(mine).toHaveLength(1)
  const row = mine[0]!
  expect(row).toMatchObject({ code: 'chat.message', link: 'chat', chatId: chat.id, readAt: null, chatMessage: { messageId: msgId, name: 'Olga Owner', mention: true, title: 'Launch plan' } })
  // under Mentions (the page's filter and the server's mark-read share this rule), not under Threads
  expect(activityTabHas(row, 'mentions')).toBe(true)
  expect(activityTabHas(row, 'threads')).toBe(false)
  // a conversation row: counted on 대화's part, never with 활동's own notices
  expect(list.roomUnreadCount).toBe(before.roomUnreadCount + 1)
  expect(list.noticeUnreadCount).toBe(before.noticeUnreadCount)
  expect(chatRows((await nora.client.call('GET', '/api/notifications?only=notices')) as List)).toEqual([])
  // jun was not mentioned: nothing listed for him
  expect(chatRows(await rows(jun.client))).toEqual([])

  // the push of that very notice
  await p.tick()
  const pushed = sent.filter((s) => s.payload.code === 'chat.message' && s.payload.notificationId === row.id)
  expect(pushed).toHaveLength(1)

  // Mentions' "Mark all as read" reads it (and only the mention row: the plain message's notice stays for the chat row)
  // (the chat row's own number and "@" drop with it: a chat.updated for nora with the chat as she sees it now)
  type Upd = { type: string; data: { chatId: string; chat: { unreadCount?: number; mentioned?: true } | null } }
  const chatUpdates = (from: number) => (h.hub.events.slice(from) as { target: string; data: Upd }[]).filter((e) => e.target === nora.id && e.data?.type === 'chat.updated' && e.data.data.chatId === chat.id)
  const mark = h.hub.events.length
  const read = await nora.client.call('POST', '/api/notifications/read', { tab: 'mentions', only: 'rooms' })
  expect(read.read).toBe(1)
  const told = chatUpdates(mark)
  expect(told.length).toBeGreaterThan(0)
  expect(told.at(-1)!.data.data.chat?.mentioned).toBeUndefined()
  const after = await rows(nora.client)
  expect(chatRows(after)[0]!.readAt).not.toBeNull()
  expect(after.roomUnreadCount).toBe(before.roomUnreadCount)
  // one mention row read by id (what opening the row does) works too: a second mention, then POST /:id/read
  await owner.call('POST', `/api/chats/${chat.id}/messages`, { content: '@NORA again', mentions: [nora.id], attachmentIds: [], clientMessageId: cm() })
  await ended()
  const second = chatRows(await rows(nora.client)).find((i) => !i.readAt)!
  const mark2 = h.hub.events.length
  const opened = await nora.client.call('POST', `/api/notifications/${second.id}/read`)
  expect(opened.readAt).not.toBeNull()
  const told2 = chatUpdates(mark2)
  expect(told2.length).toBeGreaterThan(0)
  expect(told2.at(-1)!.data.data.chat?.mentioned).toBeUndefined()
})
