// A phone push when someone shares a chat with me by name (QA TC-1414, docs/DECISIONS.md "Chats shared with me: a push
// that names the sharer"; server/src/notifications/chat-shares.ts). Covered: a share by name is pushed once (code
// chat.shared, the chat's path, ids only); a group's people get the Inbox row alone; a second share the same day adds
// no second push; a same-day group notice upgraded by a share by name is pushed once; "Chats shared with me" off makes
// no push and cancels what waits, while the Inbox row stays; quiet hours, a removed share and a read notice stop it;
// the iPhone extension's label answer names the sharer and never the chat's title. People: alice shares; bob by name;
// erin through marketing (and later by name).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import crypto from 'node:crypto'
import { API, type PutChatAudienceResult } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { PushService } from '../../server/src/notifications/push-service'
import type { NativeSend } from '../../server/src/notifications/push-native'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { chatShareWanted } from '../../server/src/notifications/chat-shares'
import { notificationsOf } from '../../server/src/notifications/service'
import { savePreferences } from '../../server/src/notifications/preferences'
import { CHAT_SHARED_BY, pushMessages } from '../../server/src/notifications/text'
import { roomsOf } from '../../server/src/rooms/service'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let clock = Date.now()
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-share-push', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  roomsOf(h.ctx).clock = () => (clock += 10_000)
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const bob: Sub = { subjectType: 'user', subjectId: 'bob' }
const erin: Sub = { subjectType: 'user', subjectId: 'erin' }
const marketing: Sub = { subjectType: 'group', subjectId: 'marketing' }
const put = (user: string, chatId: string, subjects: Sub[], confirmKey?: string): Promise<PutChatAudienceResult> =>
  h.api(user).call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
async function share(chatId: string, subjects: Sub[]) {
  let r = await put('alice', chatId, subjects)
  if (r.status === 'confirm') r = await put('alice', chatId, subjects, r.confirmKey)
  if (r.status !== 'saved') throw new Error('not saved')
}
async function newChat(text: string) {
  const c = await h.api('alice').call(API.createChat, { body: {} })
  const started = await h.api('alice').call(API.sendMessage, { params: { id: c.id }, body: { content: `${text}\n${fake({ say: `answer to ${text}` })}`, clientMessageId: cm(), attachmentIds: [] } })
  await ws.alice!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  // the chat's title is the person's words: it must never reach a push
  await h.api('alice').call(API.updateChat, { params: { id: c.id }, body: { title: `SECRET-TITLE ${text}` } })
  return c.id
}
const noticeOf = (user: string, chatId: string) => db().query('SELECT id, named, by_user, read_at FROM chat_share_notices WHERE user_id = ? AND chat_id = ?').get(user, chatId) as { id: string; named: number; by_user: string; read_at: string | null } | null
const prefs = (user: string, body: Record<string, unknown>) => h.api(user).call(API.updateNotificationPreferences, { body } as never)

/** A push service with an iPhone of `user` (label key registered) through a fake gateway, and a clock the test moves. */
function phone(user: string) {
  const sent: NativeSend[] = []
  let now = Date.now()
  const p = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), transport: async () => { throw new Error('no web push here') },
    nativeTransport: async (i) => { sent.push(i); return { statusCode: 200 } }, now: () => now, phoneDecision: () => ({ kind: 'send' }) })
  const sid = (db().query('SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user) as { id: string }).id
  const key = crypto.randomBytes(32).toString('base64url')
  const device = p.registerDevice(user, sid, { consent: true, platform: 'ios', environment: 'production', token: crypto.randomBytes(32).toString('hex'),
    labelHash: crypto.createHash('sha256').update(key).digest('hex') })
  const tick = async () => { now = Math.max(now + 5, Date.now()); await p.tick() }
  return { p, sent, tick, label: (notificationId: string) => p.label(device.id, { key, notificationId }), later: (ms: number) => { now = Date.now() + ms } }
}
const shares = (sent: NativeSend[]) => sent.filter((s) => s.payload.code === 'chat.shared')

describe('who gets a push', () => {
  test('by name: one push with the code and the chat path, ids only; the iPhone label names the sharer, never the title', async () => {
    const ph = phone('bob')
    try {
      await new Promise((r) => setTimeout(r, 5))
      const id = await newChat('pricing plan')
      await share(id, [bob])
      const n = noticeOf('bob', id)!
      expect(n).toMatchObject({ named: 1, by_user: 'alice' })
      await ph.tick()
      expect(shares(ph.sent)).toHaveLength(1)
      const payload = shares(ph.sent)[0]!.payload
      expect(payload).toMatchObject({ code: 'chat.shared', notificationId: n.id, path: `/c/${id}` })
      expect(Object.keys(payload).sort()).toEqual(['badge', 'code', 'locale', 'notificationId', 'path', 'tag'])
      expect(JSON.stringify(payload)).not.toMatch(/SECRET|Alice|pricing/)
      // the extension's words: who shared it and a fixed line, nothing of the chat
      const words = ph.label(n.id)
      expect(words).toEqual({ title: 'Alice Kim', body: CHAT_SHARED_BY[payload.locale] })
      expect(JSON.stringify(words)).not.toMatch(/SECRET|pricing/)
      // the same notice never twice; removing and adding bob again the same day: still one notice, no second push
      await ph.tick()
      await share(id, [])
      await share(id, [bob])
      await ph.tick()
      expect(shares(ph.sent)).toHaveLength(1)
      expect(pushPathOf(h.ctx, 'chat.shared', n.id)).toBe(`/c/${id}`)
    } finally { await ph.p.stop() }
  })

  test('through a group: the Inbox row only; taken out and named the same day: that row is pushed once', async () => {
    const ph = phone('erin')
    try {
      await new Promise((r) => setTimeout(r, 5))
      const id = await newChat('group plan')
      await share(id, [marketing])
      expect(noticeOf('erin', id)).toMatchObject({ named: 0 })
      await ph.tick()
      expect(shares(ph.sent)).toHaveLength(0)
      // the Inbox lists it
      const list = await h.api('erin').call(API.listNotifications, { query: {} })
      expect(list.items.some((x) => x.code === 'chat.shared' && x.chatId === id)).toBe(true)
      // a label for a group notice: nothing
      expect(ph.label(noticeOf('erin', id)!.id)).toEqual({})
      await share(id, [])
      await share(id, [erin])
      expect(db().query('SELECT COUNT(*) n FROM chat_share_notices WHERE user_id = ? AND chat_id = ?').get('erin', id)).toEqual({ n: 1 })
      expect(noticeOf('erin', id)).toMatchObject({ named: 1, by_user: 'alice' })
      await ph.tick()
      expect(shares(ph.sent)).toHaveLength(1)
    } finally { await ph.p.stop() }
  })
})

describe('what stops it', () => {
  test('"Chats shared with me" off: no push, a waiting one cancelled, the Inbox row stays; on again by default', async () => {
    expect(notificationsOf(h.ctx).preferences('bob').chatShares).toBe(true)
    const ph = phone('bob')
    try {
      await new Promise((r) => setTimeout(r, 5))
      const id = await newChat('switch off')
      expect((await prefs('bob', { chatShares: false })).chatShares).toBe(false)
      await share(id, [bob])
      await ph.tick()
      expect(shares(ph.sent)).toHaveLength(0)
      const n = noticeOf('bob', id)!
      expect((await h.api('bob').call(API.listNotifications, { query: {} })).items.some((x) => x.id === n.id)).toBe(true)
      expect(ph.label(n.id)).toEqual({})

      // a push that waits (the gateway refused once) is cancelled by switching it off
      await prefs('bob', { chatShares: true })
      const id2 = await newChat('waiting one')
      const fail = new PushService(h.ctx, { config: () => null, native: () => ({ url: 'https://push.example.test' }), nativeTransport: async () => ({ statusCode: 503 }), now: () => Date.now(), phoneDecision: () => ({ kind: 'send' }) })
      try {
        await share(id2, [bob])
        await fail.tick()
      } finally { await fail.stop() }
      const n2 = noticeOf('bob', id2)!
      expect(db().query("SELECT state FROM chat_share_push_deliveries WHERE notification_id = ?").all(n2.id)).toContainEqual({ state: 'pending' })
      await prefs('bob', { chatShares: false })
      expect(db().query("SELECT state FROM chat_share_push_deliveries WHERE notification_id = ? AND state IN ('pending','sending')").all(n2.id)).toEqual([])
      // the other switches are untouched by it
      expect(notificationsOf(h.ctx).preferences('bob').chatAnswers).toBe(true)
    } finally { await prefs('bob', { chatShares: true }); await ph.p.stop() }
  })

  test('a switched-off sharer is named nowhere: not in Activity (the browser push reads it), not in the iPhone label', async () => {
    const ph = phone('bob')
    try {
      await new Promise((r) => setTimeout(r, 5))
      const id = await newChat('switched off sharer')
      await share(id, [bob])
      await ph.tick()
      const n = noticeOf('bob', id)!
      const named = async () => (await h.api('bob').call(API.getNotification, { params: { id: n.id } })).chatShared?.name ?? null
      expect(await named()).toBe('Alice Kim')
      db().query("UPDATE users SET status = 'disabled' WHERE id = 'alice'").run()
      try {
        expect(await named()).toBeNull()
        expect(ph.label(n.id)).toEqual({})
      } finally { db().query("UPDATE users SET status = 'active' WHERE id = 'alice'").run() }
      expect(await named()).toBe('Alice Kim')
    } finally { await ph.p.stop() }
  })

  test('quiet hours, a removed share and a read notice: not wanted', async () => {
    const id = await newChat('stops')
    await share(id, [bob])
    const n = noticeOf('bob', id)!
    expect(chatShareWanted(h.ctx, n.id)).toBe(true)
    // quiet hours all day long, a weekday at noon UTC
    savePreferences(db(), 'bob', { quietHours: { on: true, start: '00:00', end: '23:59', weekends: true } })
    expect(chatShareWanted(h.ctx, n.id, Date.parse('2026-11-11T12:00:00Z'))).toBe(false)
    savePreferences(db(), 'bob', { quietHours: { on: false, start: '22:00', end: '08:00', weekends: false } })
    expect(chatShareWanted(h.ctx, n.id)).toBe(true)
    // read in the Inbox
    db().query('UPDATE chat_share_notices SET read_at = ? WHERE id = ?').run(new Date().toISOString(), n.id)
    expect(chatShareWanted(h.ctx, n.id)).toBe(false)
    db().query('UPDATE chat_share_notices SET read_at = NULL WHERE id = ?').run(n.id)
    // no longer shared with bob: neither wanted nor a path
    await share(id, [])
    expect(chatShareWanted(h.ctx, n.id)).toBe(false)
    expect(pushPathOf(h.ctx, 'chat.shared', n.id)).toBeUndefined()
  })
})

test('the browser push words: the generic line and the line under the sharer\'s name, in every language', () => {
  for (const l of ['en', 'ko', 'id', 'ja', 'es', 'zh'] as const) {
    const m = pushMessages(l)
    expect(m.bodies['chat.shared']).toBeTruthy()
    expect(m.chatSharedBy).toBe(CHAT_SHARED_BY[l])
  }
})
