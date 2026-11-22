// The phone push of a new message in a chat shared with people (docs/decisions/20261122-shared-chat-new-message-notices.md):
// it goes through the push service's rounds like a room's message (one push per message, code chat.message, the icon
// number counting the chat's unread messages), and stops once the chat is read. A regression guard for the SOURCES
// entry: its condition joins push_subscriptions, which has a `kind` of its own.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { getChatRuntime } from '../../server/src/chat/runtime'
import { pushBadge } from '../../server/src/notifications/push-badge'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness as BHarness } from '../lib/b-harness'

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
  // (the harness has no AI login: each turn ends in an error, which can take about 11 s on a machine without one)
  const ended = async () => { for (let i = 0; i < 600 && h.ctx.db.query("SELECT 1 FROM turns WHERE chat_id = ? AND status IN ('queued','running')").get(chat.id); i++) await new Promise((x) => setTimeout(x, 50)) }
  // nora's unread notices in the chat by kind: one per person's message, and one per finished answer of Trina's (for the
  // number only, never pushed). Whether this machine's turn ends in an answer or in an error (no AI login) decides
  // whether there are answers; the badge counts exactly the notices, never one message twice
  const unread = (kind?: 'message' | 'answer') => (h.ctx.db.query(`SELECT COUNT(*) n FROM chat_message_notices WHERE user_id = ? AND chat_id = ? AND read_at IS NULL AND suppressed = 0${kind ? ' AND kind = ?' : ''}`)
    .get(...[nora.id, chat.id, ...(kind ? [kind] : [])]) as { n: number }).n
  const want: number[] = []
  for (const [i, text] of ['one', 'two'].entries()) {
    await owner.call('POST', `/api/chats/${chat.id}/messages`, { content: text, attachmentIds: [], clientMessageId: cm() })
    await ended()
    expect(unread('message')).toBe(i + 1)
    expect(unread('answer')).toBeLessThanOrEqual(i + 1)
    want.push(unread())
    await p.tick()
  }
  const mine = sent.filter((s) => s.payload.code === 'chat.message')
  expect(mine).toHaveLength(2)
  expect(new Set(mine.map((s) => s.payload.notificationId)).size).toBe(2)
  expect(mine.map((s) => s.payload.badge)).toEqual(want)
  await nora.client.call('POST', `/api/chats/${chat.id}/seen`)
  await owner.call('POST', `/api/chats/${chat.id}/messages`, { content: 'three', attachmentIds: [], clientMessageId: cm() })
  await ended()
  await nora.client.call('POST', `/api/chats/${chat.id}/seen`)
  await p.tick()
  expect(sent.filter((s) => s.payload.code === 'chat.message')).toHaveLength(2)
})

// With an answer (the fake engine): each exchange is two unread messages for the other person, the message and Trina's
// answer (message-notices.ts: an answer counts for the number only), so the icon reads 2, then 4. One notice per message
// and per answer: nothing is counted twice (QA from #350's review: "badge [2, 4]" is this, not a double count)
test('an exchange with an answer: one notice for the message, one for the answer; the number counts both, once each', async () => {
  const b: BHarness = await startHarness({ name: 'shared-chat-message-badge', stallTimeoutMs: 60_000 })
  try {
    const sock = await b.ws('alice'); await sock.next('hello')
    const chat = (await b.api('alice').call(API.createChat, { body: {} })).id
    const bob = (b.ctx.db.query("SELECT id FROM users WHERE username = 'bob'").get() as { id: string }).id
    const subjects = [{ subjectType: 'user' as const, subjectId: bob }]
    let r = await b.api('alice').call(API.putChatAudience, { params: { id: chat }, body: { subjects } })
    if (r.status === 'confirm') r = await b.api('alice').call(API.putChatAudience, { params: { id: chat }, body: { subjects, confirmKey: r.confirmKey } })
    expect(r.status).toBe('saved')
    const kinds = () => (b.ctx.db.query('SELECT kind FROM chat_message_notices WHERE user_id = ? AND chat_id = ? AND read_at IS NULL AND suppressed = 0 ORDER BY created_at, kind DESC').all(bob, chat) as { kind: string }[]).map((x) => x.kind)
    const badges: (number | null)[] = []
    for (const t of ['one', 'two']) {
      await ask(b, sock, 'alice', chat, '@fake ' + JSON.stringify({ say: `ok ${t}` }))
      for (let i = 0; i < 40 && kinds().length < badges.length * 2 + 2; i++) await new Promise((x) => setTimeout(x, 50))
      badges.push(pushBadge(b.ctx, bob))
    }
    expect(kinds().sort()).toEqual(['answer', 'answer', 'message', 'message'])
    expect(badges).toEqual([2, 4])
    sock.close()
  } finally { await b.close() }
})
