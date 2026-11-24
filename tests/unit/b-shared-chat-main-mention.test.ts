// The main box of an AI chat mentions nobody (owner 2026-11-22, docs/decisions/20261122-ai-session-no-main-mention.md):
// in a chat shared with people (and a project's shared chat, b-project-chat-message-notices.test.ts) a main message
// with "@name" in it, even from an older page that still sends `mentions`, gives the others the plain new-message
// notice only (the chat row's number, the push), never a mention: no row under Mentions, no "@" on the chat row, no
// mention in the desktop ring. A person is mentioned in a thread under an AI answer: that reply is a Mentions row and
// pushed (#321/#360), as before (b-chat-thread-mentions.test.ts, b-project-chat-message-notices.test.ts).
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

test('a main message naming someone with "@": the plain notice for everyone, no mention', async () => {
  h = await harness('shared-chat-main-mention')
  const owner = await withOwner(h)
  const nora = await addMember(h, owner, { username: 'nora' })
  const jun = await addMember(h, owner, { username: 'jun' })
  // what the chat runtime tells each window (its own hub: chat.updated)
  const rtHub = getChatRuntime(h.ctx).hub
  const told: { target: string; data: unknown }[] = []
  const publish = rtHub.publish.bind(rtHub)
  rtHub.publish = (userId, ev) => { told.push({ target: userId, data: JSON.parse(JSON.stringify(ev)) }); publish(userId, ev) }
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
  const mentionRows = (l: List) => l.items.filter((i) => activityTabHas(i, 'mentions'))
  const before = await rows(nora.client)

  // "@nora" typed in the main box, sent the way an older page did (with `mentions`): the server ignores them
  const sentMsg = await owner.call('POST', `/api/chats/${chat.id}/messages`, { content: '@NORA can you check?', mentions: [nora.id], attachmentIds: [], clientMessageId: cm() })
  await ended()
  const msgId = sentMsg.userMessage.id as string
  // the plain new-message notice, for nora and jun alike (#339/#360): no mention
  for (const u of [nora.id, jun.id]) {
    expect(h.ctx.db.query('SELECT kind, mention FROM chat_message_notices WHERE user_id = ? AND source_id = ?').all(u, msgId)).toEqual([{ kind: 'message', mention: 0 }])
  }
  // nothing under Mentions, nothing listed or counted on 대화's 멘션·스레드
  const list = await rows(nora.client)
  expect(list.items.filter((i) => i.code === 'chat.message')).toEqual([])
  expect(mentionRows(list)).toEqual(mentionRows(before))
  expect(list.roomUnreadCount).toBe(before.roomUnreadCount)
  // the chat row: the unread number, no "@"
  const view = await nora.client.call('GET', `/api/chats/${chat.id}`)
  expect(view.unreadCount).toBeGreaterThan(0)
  expect(Object.keys(view)).not.toContain('mentioned')
  // the desktop ring is a plain message's
  type Upd = { type: string; data: { chatId: string; notice?: { messageId: string; mention?: true } } }
  const rings = (told as { target: string; data: Upd }[]).filter((e) => e.target === nora.id && e.data?.type === 'chat.updated' && e.data.data.notice?.messageId === msgId)
  expect(rings.length).toBeGreaterThan(0)
  for (const e of rings) expect(e.data.data.notice).toEqual({ messageId: msgId })
  // the phone push of the plain notice still goes (main messages notify like a channel's)
  await p.tick()
  expect(sent.some((s) => s.payload.code === 'room.chat_message')).toBe(true)

})
