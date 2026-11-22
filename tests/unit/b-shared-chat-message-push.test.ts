// The phone push of a new message in a chat shared with people (docs/decisions/20261122-shared-chat-new-message-notices.md):
// it goes through the push service's rounds like a room's message (one push per message, code chat.message, the icon
// number counting the chat's unread messages), and stops once the chat is read. A regression guard for the SOURCES
// entry: its condition joins push_subscriptions, which has a `kind` of its own.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { addMember, harness, withOwner, type Harness } from './a-lib'

setDefaultTimeout(90_000)
let h: Harness, p: PushService | undefined
afterEach(async () => { await p?.stop(); p = undefined; await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()

test('a person\'s message in a shared chat: one phone push each, the badge counting them; read, nothing more goes', async () => {
  h = await harness('shared-chat-message-push')
  const owner = await withOwner(h)
  const nora = await addMember(h, owner, { username: 'nora' })
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
  const chat = await owner.call('POST', '/api/chats', {})
  const put = (confirmKey?: string) => owner.call('PUT', `/api/chats/${chat.id}/audience`, { subjects: [{ subjectType: 'user', subjectId: nora.id }], ...(confirmKey ? { confirmKey } : {}) })
  let r = await put()
  if (r.status === 'confirm') r = await put(r.confirmKey)
  expect(r.status).toBe('saved')
  const ended = async () => { for (let i = 0; i < 100 && h.ctx.db.query("SELECT 1 FROM turns WHERE chat_id = ? AND status IN ('queued','running')").get(chat.id); i++) await new Promise((x) => setTimeout(x, 50)) }
  for (const text of ['one', 'two']) {
    await owner.call('POST', `/api/chats/${chat.id}/messages`, { content: text, attachmentIds: [], clientMessageId: cm() })
    await ended()
    await p.tick()
  }
  const mine = sent.filter((s) => s.payload.code === 'chat.message')
  expect(mine).toHaveLength(2)
  expect(new Set(mine.map((s) => s.payload.notificationId)).size).toBe(2)
  expect(mine.map((s) => s.payload.badge)).toEqual([1, 2])
  await nora.client.call('POST', `/api/chats/${chat.id}/seen`)
  await owner.call('POST', `/api/chats/${chat.id}/messages`, { content: 'three', attachmentIds: [], clientMessageId: cm() })
  await ended()
  await nora.client.call('POST', `/api/chats/${chat.id}/seen`)
  await p.tick()
  expect(sent.filter((s) => s.payload.code === 'chat.message')).toHaveLength(2)
})
