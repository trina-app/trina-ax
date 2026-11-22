// A new message in a chat shared with people tells the others (docs/decisions/20261122-shared-chat-new-message-notices.md,
// chat/message-notices.ts; scenario QA TC-7406, TC-r2b-07, TC-r2a-01, TC-r2d-05). With the fake engine through the real
// launcher. alice makes a chat and shares it with bob and carol by name; erin never sees it. Covered: a person's message
// gives everyone else a notice (not the sender), the chat.updated `notice` and the per-viewer unread number, Trina's answer
// as an unread number only (never pushed; not for the asker), the push's wanted and path, reading by /seen and by
// writing, the room default "nothing" and quiet, "Mute this chat" (a mention still reaches), mentions kept only among
// who sees it, and someone taken out losing their notices.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { chatMessagePath, chatMessageWanted } from '../../server/src/chat/message-notices'
import { pushPathOf } from '../../server/src/notifications/push-events'
import { savePreferences } from '../../server/src/notifications/preferences'
import { notificationsOf } from '../../server/src/notifications/service'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let chatId: string
type Sub = { subjectType: 'user' | 'group'; subjectId: string }
const put = (subjects: Sub[], confirmKey?: string) => h.api('alice').call(API.putChatAudience, { params: { id: chatId }, body: { subjects, ...(confirmKey ? { confirmKey } : {}) } })
async function share(subjects: Sub[]) {
  let r = await put(subjects)
  if (r.status === 'confirm') r = await put(subjects, r.confirmKey)
  expect(r.status).toBe('saved')
}
async function say(user: string, content: string, mentions?: string[]) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content: fake({ say: content }), clientMessageId: cm(), attachmentIds: [], ...(mentions ? { mentions } : {}) } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return started
}
type Row = { id: string; source_id: string; kind: string; quiet: number; mention: number; read_at: string | null }
const notices = (user: string) => h.ctx.db.query('SELECT id, source_id, kind, quiet, mention, read_at FROM chat_message_notices WHERE user_id = ? AND chat_id = ? ORDER BY created_at, rowid').all(user, chatId) as Row[]
const unread = (user: string) => notices(user).filter((n) => !n.read_at)
const viewOf = async (user: string) => h.api(user).call(API.getChat, { params: { id: chatId } })
const updates = (user: string) => ws[user]!.frames.filter((f): f is Extract<ServerFrame, { type: 'chat.updated' }> => f.type === 'chat.updated' && f.data.chatId === chatId)

beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-message-notices', stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'carol', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  chatId = (await h.api('alice').call(API.createChat, { body: {} })).id
  await say('alice', 'first')
  await share([{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'carol' }])
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

describe('a person\'s message', () => {
  test('everyone else who sees the chat gets a notice that may ring; the sender and someone outside get none', async () => {
    const before = updates('alice').length
    const s = await say('bob', 'Can we ship on Friday?')
    const msg = s.userMessage!.id
    for (const u of ['alice', 'carol']) expect(notices(u).filter((n) => n.source_id === msg)).toMatchObject([{ kind: 'message', quiet: 0, mention: 0, read_at: null }])
    expect(notices('bob')).toEqual([])
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM chat_message_notices WHERE user_id = ?').get('erin')).toEqual({ n: 0 })
    // the chat.updated that follows the send carries the notice for alice (the desktop app tells it and rings)
    expect(updates('alice').slice(before).some((f) => f.data.notice?.messageId === msg)).toBe(true)
    expect(updates('bob').some((f) => f.data.notice)).toBe(false)
    // the push: wanted while unread and seen, opening the chat at the message
    const n = notices('alice').find((x) => x.source_id === msg)!
    expect(chatMessageWanted(h.ctx, n.id)).toBe(true)
    expect(chatMessagePath(h.ctx, n.id)).toBe(`/c/${chatId}/m/${msg}`)
    expect(pushPathOf(h.ctx, 'chat.message', n.id)).toBe(`/c/${chatId}/m/${msg}`)
    // what a push opens (the service worker's signed-in fetch), never listed in Activity
    expect(notificationsOf(h.ctx).get('alice', n.id)).toMatchObject({ code: 'chat.message', link: 'chat', chatId, chatMessage: { messageId: msg } })
    expect((await h.api('alice').call(API.listNotifications, { query: {} })).items.some((i) => i.code === 'chat.message')).toBe(false)
  })

  test('Trina\'s answer is an unread number for the others, never pushed, nothing for its asker', async () => {
    const answers = (u: string) => notices(u).filter((n) => n.kind === 'answer')
    expect(answers('alice').length).toBeGreaterThan(0)
    expect(answers('carol').length).toBeGreaterThan(0)
    expect(answers('bob')).toEqual([])
    for (const n of answers('alice')) { expect(n.quiet).toBe(1); expect(chatMessageWanted(h.ctx, n.id)).toBe(false) }
    // each viewer's own number and unseen mark
    const a = await viewOf('alice')
    expect(a.unreadCount).toBe(unread('alice').length)
    expect(a.unseen).toBe(true)
    expect((await viewOf('bob')).unreadCount).toBeUndefined()
  })

  test('opening the chat reads my notices only; writing in it reads them too', async () => {
    await h.api('alice').call(API.markChatSeen, { params: { id: chatId } })
    expect(unread('alice')).toEqual([])
    expect((await viewOf('alice')).unreadCount).toBeUndefined()
    expect(unread('carol').length).toBeGreaterThan(0)
    for (const n of notices('alice')) expect(chatMessageWanted(h.ctx, n.id)).toBe(false)
    await say('carol', 'Friday works')
    expect(unread('carol')).toEqual([])
    expect(unread('alice').length).toBeGreaterThan(0)
  })
})

describe('settings, mute and mentions', () => {
  test('the room default "nothing" keeps the number but never pushes', async () => {
    savePreferences(h.ctx.db, 'alice', { roomLevel: 'none' })
    const s = await say('bob', 'quiet one')
    const n = notices('alice').find((x) => x.source_id === s.userMessage!.id)!
    expect(n.quiet).toBe(1)
    expect(chatMessageWanted(h.ctx, n.id)).toBe(false)
    savePreferences(h.ctx.db, 'alice', { roomLevel: 'direct' })
  })

  test('a muted chat tells nothing, but a mention still reaches; a mention of someone outside is dropped', async () => {
    const muted = await h.api('carol').call(API.muteChat, { params: { id: chatId } })
    expect(muted.muted).toBe(true)
    expect(unread('carol')).toEqual([])
    const plain = await say('bob', 'no ping')
    expect(notices('carol').some((n) => n.source_id === plain.userMessage!.id)).toBe(false)
    const ping = await say('bob', '@Carol Park look', ['carol', 'erin', 'bob'])
    const n = notices('carol').find((x) => x.source_id === ping.userMessage!.id)!
    expect(n).toMatchObject({ kind: 'message', mention: 1, quiet: 0 })
    expect(chatMessageWanted(h.ctx, n.id)).toBe(true)
    expect((await viewOf('carol')).mentioned).toBe(true)
    // erin does not see the chat, bob sent it: neither gets a notice of it
    expect(h.ctx.db.query('SELECT COUNT(*) n FROM chat_message_notices WHERE user_id IN (?, ?) AND source_id = ?').get('erin', 'bob', ping.userMessage!.id)).toEqual({ n: 0 })
    expect(updates('carol').some((f) => f.data.notice?.messageId === ping.userMessage!.id && f.data.notice.mention)).toBe(true)
    // muting again later: the plain ones of a mute never come back; unmute tells again
    expect((await h.api('carol').call(API.unmuteChat, { params: { id: chatId } })).muted).toBeUndefined()
  })

  test('only a chat shared with people can be muted; someone who cannot see it gets the 404', async () => {
    const mine = await h.api('alice').call(API.createChat, { body: {} })
    await expect(h.api('alice').call(API.muteChat, { params: { id: mine.id } })).rejects.toMatchObject({ status: 400 })
    await expect(h.api('erin').call(API.muteChat, { params: { id: chatId } })).rejects.toMatchObject({ status: 404 })
  })

  test('someone taken out loses their notices and mute; the push for one made before is no longer wanted', async () => {
    const s = await say('bob', 'before carol leaves')
    const n = notices('carol').find((x) => x.source_id === s.userMessage!.id)!
    expect(chatMessageWanted(h.ctx, n.id)).toBe(true)
    await share([{ subjectType: 'user', subjectId: 'bob' }])
    expect(notices('carol')).toEqual([])
    expect(chatMessageWanted(h.ctx, n.id)).toBe(false)
  })

  test('the people the box may mention: everyone who sees it but me', async () => {
    await share([{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'carol' }])
    const a = await h.api('bob').call(API.getChatAudience, { params: { id: chatId } })
    expect(a.mentionable?.map((p) => p.id).sort()).toEqual(['alice', 'carol'])
  })
})
