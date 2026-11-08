// Who wrote in each shared chat, on its project's page (Chat.shared.people and peopleCount; chat/shared.ts chatPeople;
// docs/DECISIONS.md "Shared project chats", "The faces on the project page"): the people who sent a question there, its
// creator included, the most recent first, at most 3, and how many in all. Only in a project's chat list, only for the
// shared chats the viewer sees there (the list's own filter), and from one grouped query for the whole page over
// messages_author_chat, never one per chat. The project is on projects/falcon: alice writes it, bob (finance) reads it,
// carol (admin) and dana (owner) see everything, erin does not see it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, CHAT_PEOPLE_SHOWN, type Chat } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { chatPeople } from '../../server/src/chat/shared'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-people', turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await h.api('alice').call(API.createProject, { body: { name: 'Falcon', folderPath: 'projects/falcon', scope: 'team', participants: [], instructions: '' } })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const newShared = async (user = 'alice') => h.api(user).call(API.createChat, { body: { projectId } })
/** a question through the API, and its answer (the fake engine), as a person really writes in a chat */
async function ask(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content: content + '\n' + fake({ say: 'ok' }), clientMessageId: cm(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
}
/** a question written straight into the database, as a turn stores it (people without a socket here; the order exact) */
const wrote = (user: string, chatId: string) =>
  db().query("INSERT INTO messages (id, chat_id, role, content, author_id) VALUES (?, ?, 'user', 'a question', ?)").run(crypto.randomUUID(), chatId, user)
const projectList = async (user: string, query: Record<string, string | boolean> = {}) => (await h.api(user).call(API.listChats, { query: { projectId, ...query } })).items
const inList = async (user: string, chatId: string): Promise<Chat | undefined> => (await projectList(user)).find((c) => c.id === chatId)
const names = (c: Chat | undefined) => c?.shared?.people?.map((p) => p.id)

describe('the people of a shared chat on its project page', () => {
  test('the most recent writer first, at most 3, and how many wrote; its creator counts as any writer', async () => {
    const chat = await newShared()
    // made, nobody wrote yet: no faces (the page shows its creator), count 0
    expect((await inList('bob', chat.id))?.shared).toMatchObject({ by: { id: 'alice' }, people: [], peopleCount: 0 })
    await ask('alice', chat.id, 'first question')
    await ask('bob', chat.id, 'second question')
    expect((await inList('carol', chat.id))?.shared).toMatchObject({ people: [{ id: 'bob', name: 'Bob Lee' }, { id: 'alice', name: 'Alice Kim' }], peopleCount: 2 })
    // the same person again moves to the front, and is counted once
    await ask('alice', chat.id, 'third question')
    expect(names(await inList('bob', chat.id))).toEqual(['alice', 'bob'])
    // five people: the three most recent, and 5
    wrote('carol', chat.id)
    wrote('dana', chat.id)
    // erin lost the project since (she is not in its audience): her questions are still in the chat, so she counts
    wrote('erin', chat.id)
    const five = await inList('bob', chat.id)
    expect(names(five)).toEqual(['erin', 'dana', 'carol'])
    expect(five?.shared?.peopleCount).toBe(5)
    expect(five?.shared?.people).toHaveLength(CHAT_PEOPLE_SHOWN)
    wrote('bob', chat.id)
    expect(names(await inList('alice', chat.id))).toEqual(['bob', 'erin', 'dana'])
    // an answer is nobody's question: it changes nothing
    db().query("INSERT INTO messages (id, chat_id, role, content, author_id) VALUES (?, ?, 'assistant', 'an answer', 'alice')").run(crypto.randomUUID(), chat.id)
    expect(names(await inList('alice', chat.id))).toEqual(['bob', 'erin', 'dana'])
    expect((await inList('alice', chat.id))?.shared?.peopleCount).toBe(5)
  })

  test('each chat its own people; a private chat in the project has none', async () => {
    const one = await newShared()
    const two = await newShared('bob')
    const own = await h.api('alice').call(API.createChat, { body: {} })
    await h.api('alice').call(API.updateChat, { params: { id: own.id }, body: { projectId } })
    await ask('alice', one.id, 'mine')
    await ask('bob', two.id, 'his')
    await ask('alice', own.id, 'private')
    const list = await projectList('alice')
    expect(list.find((c) => c.id === one.id)?.shared).toMatchObject({ people: [{ id: 'alice' }], peopleCount: 1 })
    expect(list.find((c) => c.id === two.id)?.shared).toMatchObject({ by: { id: 'bob' }, people: [{ id: 'bob' }], peopleCount: 1 })
    const priv = list.find((c) => c.id === own.id)
    expect(priv).toBeTruthy()
    expect(priv!.shared).toBeUndefined()
  })

  test('only in a project\'s list, and only for the chats the viewer sees there', async () => {
    const chat = await newShared()
    await ask('alice', chat.id, 'a question')
    await ask('bob', chat.id, 'another')
    // a single chat, the chat list and the trash: no people
    const one = await h.api('bob').call(API.getChat, { params: { id: chat.id } })
    expect(one.shared).toBeTruthy()
    expect(one.shared!.people).toBeUndefined()
    expect(one.shared!.peopleCount).toBeUndefined()
    const mine = (await h.api('bob').call(API.listChats, { query: {} })).items.find((c) => c.id === chat.id)
    expect(mine?.shared).toBeTruthy()
    expect(mine!.shared!.people).toBeUndefined()
    // erin does not see the project: its shared chats are not listed for her, so nobody's face is
    const forErin = await projectList('erin')
    expect(forErin.find((c) => c.id === chat.id)).toBeUndefined()
    expect(forErin.some((c) => c.shared)).toBe(false)
    // bob loses the project: gone from his list, faces and all
    db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'bob'").run()
    try {
      expect(await inList('bob', chat.id)).toBeUndefined()
      expect((await projectList('bob')).some((c) => c.shared)).toBe(false)
    } finally { db().query("INSERT INTO group_members VALUES ('finance','bob')").run() }
    // a shared chat in its creator's trash: no people there
    await h.api('alice').call(API.deleteChat, { params: { id: chat.id } })
    const trash = (await projectList('alice', { trash: true })).find((c) => c.id === chat.id)
    expect(trash?.shared).toBeTruthy()
    expect(trash!.shared!.people).toBeUndefined()
    await h.api('alice').call(API.restoreChat, { params: { id: chat.id } })
  })

  test('one grouped query for the whole page, over messages_author_chat (no query per chat)', async () => {
    const chats = [await newShared(), await newShared(), await newShared(), await newShared('bob')]
    for (const [i, c] of chats.entries()) { wrote('alice', c.id); if (i % 2) wrote('bob', c.id) }
    const d = db()
    const seen: string[] = []
    const real = d.query
    d.query = ((sql: string) => { seen.push(sql); return real.call(d, sql) }) as typeof d.query
    let list: Chat[]
    try { list = await projectList('bob') } finally { delete (d as unknown as Record<string, unknown>).query }
    for (const c of chats) expect(list.find((x) => x.id === c.id)?.shared?.peopleCount).toBe(1 + (chats.indexOf(c) % 2))
    const people = seen.filter((s) => s.includes('MAX(m.rowid)'))
    expect(people).toHaveLength(1)
    // each (person, chat) pair a seek on the covering index: no scan of the messages, no read of a message row
    const plan = (d.query('EXPLAIN QUERY PLAN ' + people[0]).all(JSON.stringify(chats.map((c) => c.id))) as { detail: string }[]).map((r) => r.detail).join(' | ')
    expect(plan).toContain('USING COVERING INDEX messages_author_chat (author_id=? AND chat_id=?)')
    expect(plan).not.toMatch(/SCAN m\b/)
    // nothing to ask for: no query at all
    expect(chatPeople(d, []).size).toBe(0)
  })
})
