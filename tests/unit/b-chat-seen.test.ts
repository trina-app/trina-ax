// Component B: what the chat list says about each chat for the sidebar (docs/DECISIONS.md "Desktop sidebar: rooms
// first"), so no screen asks per chat:
// - Chat.unseen: an answer finished after the person last had the chat on screen (migration 251, chats.seen_at).
//   POST /api/chats/:id/seen clears it, for the owner only, and every window hears it (chat.updated); a reload keeps it.
// - Chat.waiting: the AI asked the person something and waits (an open ask card every window shows); chat.updated says
//   when the card opens and when it closes.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API } from '@mycel/shared/api'
import { ask, startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(30_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
let alice: TestSocket
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-seen', askUserTimeoutMs: 5000, turnTimeoutMs: 60_000 })
  alice = await h.ws('alice', { windowId: 'win-alice-main' })
  await alice.next('hello')
})
afterAll(async () => { alice?.close(); await h.close() })

const listed = async (user: string, id: string) => (await h.api(user).call(API.listChats, { query: {} })).items.find((c) => c.id === id)

describe('Chat.unseen', () => {
  test('a new chat is seen; its finished answer is unseen until the chat is on screen, in every window and after a reload', async () => {
    const other = await h.ws('alice', { windowId: 'win-alice-other' })
    await other.next('hello')
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    expect(chat.unseen).toBeUndefined()
    const r = await ask(h, alice, 'alice', chat.id, fake({ say: 'done while away' }))
    expect(r.done.status).toBe('done')
    // the chat.updated after the answer says it (the sidebar of every window), and so does the list (a reload)
    await other.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.chat?.unseen === true)
    expect((await listed('alice', chat.id))?.unseen).toBe(true)
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).unseen).toBe(true)
    // bob cannot mark it (not his chat), and it stays unseen
    const bobTry = await h.req('bob', `/api/chats/${chat.id}/seen`, { method: 'POST' })
    expect(bobTry.status).toBe(404)
    expect((await listed('alice', chat.id))?.unseen).toBe(true)
    // on screen: seen, everywhere
    const seen = await h.api('alice').call(API.markChatSeen, { params: { id: chat.id } })
    expect(seen.unseen).toBeUndefined()
    await other.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.chat !== null && f.data.chat.unseen === undefined)
    expect((await listed('alice', chat.id))?.unseen).toBeUndefined()
    // a second mark changes nothing and says nothing
    expect((await h.api('alice').call(API.markChatSeen, { params: { id: chat.id } })).unseen).toBeUndefined()
    // the next answer makes it unseen again
    await ask(h, alice, 'alice', chat.id, fake({ say: 'again' }))
    expect((await listed('alice', chat.id))?.unseen).toBe(true)
    other.close()
  })

  test('chats from before the column count as seen: the migration marks every existing chat', () => {
    expect(h.ctx.db.query("SELECT name FROM pragma_table_info('chats') WHERE name = 'seen_at'").all()).toEqual([{ name: 'seen_at' }])
    const sql = fs.readFileSync(path.join(import.meta.dir, '..', '..', 'server', 'migrations', '251_b_chat_seen.sql'), 'utf8')
    expect(sql).toMatch(/^UPDATE chats SET seen_at = strftime/m)
  })
  test('a chat with no mark (an older build made it) counts its answers after it was made', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    await ask(h, alice, 'alice', chat.id, fake({ say: 'from before' }))
    await h.api('alice').call(API.markChatSeen, { params: { id: chat.id } })
    h.ctx.db.query('UPDATE chats SET seen_at = NULL WHERE id = ?').run(chat.id)
    expect((await listed('alice', chat.id))?.unseen).toBe(true)
  })
})

describe('Chat.waiting', () => {
  test('while an ask card is open the list says so, chat.updated tells every window, and it goes when answered', async () => {
    const chat = await h.api('alice').call(API.createChat, { body: {} })
    const r = await h.api('alice').call(API.sendMessage, { params: { id: chat.id }, body: { content: fake({ tool: 'ask_user', args: { question: 'Which color?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] }, sayResult: true }), clientMessageId: cm(), attachmentIds: [] } })
    const card = await alice.next('turn.request', (f) => f.data.turnId === r.turnId)
    await alice.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.chat?.waiting === true)
    expect((await listed('alice', chat.id))?.waiting).toBe(true)
    // one list, no request per chat: the flag is on the chat itself
    expect((await h.api('alice').call(API.getChat, { params: { id: chat.id } })).waiting).toBe(true)
    await h.api('alice').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: card.data.request.requestId, answer: 'blue' } })
    await alice.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.chat !== null && f.data.chat.waiting === undefined)
    await alice.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 20_000)
    expect((await listed('alice', chat.id))?.waiting).toBeUndefined()
  })
})
