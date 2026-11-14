// Who else wrote in each shared chat, in every chat list (Chat.shared.people and peopleCount; chat/shared.ts chatPeople;
// docs/DECISIONS.md "Faces in every chat list", amending "The faces on the project page"): the other people who sent a
// question there (its creator included when they did, never the viewer), the most recent first, at most 3, and how
// many in all. In every list but the trash (a project's page, my chat list, a search, the Trina list's groups) and in
// chat.updated, only for the shared chats the viewer sees there (the list's own filter), and from one grouped query for
// the whole response over messages_author_chat, never one per chat. The project is on projects/falcon: alice writes it, bob (finance) reads it;
// carol (admin) and dana (owner) are not its members, so they do not see its chats (docs/DECISIONS.md "Project contents
// only for members"); erin does not see it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, CHAT_PEOPLE_SHOWN, type Chat } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { oldProject } from '../lib/legacy-project'
import { chatPeople, peopleFor } from '../../server/src/chat/shared'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-shared-chat-people', stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await oldProject(h, 'alice', { name: 'Falcon', folderPath: 'projects/falcon', instructions: '' })
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

describe('the people of a shared chat in its lists', () => {
  test('the others only, the most recent writer first, at most 3, and how many others wrote', async () => {
    const chat = await newShared()
    // made, nobody wrote yet: no faces (the row shows the people icon), count 0
    expect((await inList('bob', chat.id))?.shared).toMatchObject({ by: { id: 'alice' }, people: [], peopleCount: 0 })
    await ask('alice', chat.id, 'first question')
    // only its creator wrote: bob sees her face, alice sees nobody else (her row keeps the icon)
    expect((await inList('bob', chat.id))?.shared).toMatchObject({ people: [{ id: 'alice', name: 'Alice Kim' }], peopleCount: 1 })
    expect((await inList('alice', chat.id))?.shared).toMatchObject({ people: [], peopleCount: 0 })
    await ask('bob', chat.id, 'second question')
    expect((await inList('bob', chat.id))?.shared).toMatchObject({ people: [{ id: 'alice', name: 'Alice Kim' }], peopleCount: 1 })
    expect((await inList('alice', chat.id))?.shared).toMatchObject({ people: [{ id: 'bob', name: 'Bob Lee' }], peopleCount: 1 })
    // carol (admin) is not a member: the project's list does not have it for her, faces and all
    expect(await inList('carol', chat.id)).toBeUndefined()
    // five people: the three most recent others, and 4 others (carol and dana wrote there as admins before "Project
    // contents only for members": their questions are still in the chat, so they count, as erin's below)
    wrote('carol', chat.id)
    wrote('dana', chat.id)
    // erin lost the project since (she is not in its audience): her questions are still in the chat, so she counts
    wrote('erin', chat.id)
    const forBob = await inList('bob', chat.id)
    expect(names(forBob)).toEqual(['erin', 'dana', 'carol'])
    expect(forBob?.shared?.peopleCount).toBe(4)
    expect(forBob?.shared?.people).toHaveLength(CHAT_PEOPLE_SHOWN)
    wrote('bob', chat.id)
    // the same person again moves to the front, and is counted once
    expect(names(await inList('alice', chat.id))).toEqual(['bob', 'erin', 'dana'])
    // an answer is nobody's question: it changes nothing
    db().query("INSERT INTO messages (id, chat_id, role, content, author_id) VALUES (?, ?, 'assistant', 'an answer', 'alice')").run(crypto.randomUUID(), chat.id)
    expect(names(await inList('alice', chat.id))).toEqual(['bob', 'erin', 'dana'])
    expect((await inList('alice', chat.id))?.shared?.peopleCount).toBe(4)
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
    expect(list.find((c) => c.id === one.id)?.shared).toMatchObject({ people: [], peopleCount: 0 })
    expect(list.find((c) => c.id === two.id)?.shared).toMatchObject({ by: { id: 'bob' }, people: [{ id: 'bob' }], peopleCount: 1 })
    const priv = list.find((c) => c.id === own.id)
    expect(priv).toBeTruthy()
    expect(priv!.shared).toBeUndefined()
  })

  test('in every list but the trash (my list, a search, the Trina list\'s groups) and chat.updated; never a single chat', async () => {
    const chat = await newShared()
    await h.api('alice').call(API.updateChat, { params: { id: chat.id }, body: { title: 'Falcon budget faces' } })
    await ask('alice', chat.id, 'a question')
    await ask('bob', chat.id, 'another')
    // a single chat: no people (its header keeps the shared mark)
    const one = await h.api('bob').call(API.getChat, { params: { id: chat.id } })
    expect(one.shared).toBeTruthy()
    expect(one.shared!.people).toBeUndefined()
    expect(one.shared!.peopleCount).toBeUndefined()
    // my chat list (the Trina list, the history, the phone's drawer)
    const mine = (await h.api('bob').call(API.listChats, { query: {} })).items.find((c) => c.id === chat.id)
    expect(mine?.shared).toMatchObject({ people: [{ id: 'alice', name: 'Alice Kim' }], peopleCount: 1 })
    // a search (Cmd+K)
    const found = (await h.api('alice').call(API.listChats, { query: { q: 'faces' } })).items.find((c) => c.id === chat.id)
    expect(found?.shared).toMatchObject({ people: [{ id: 'bob', name: 'Bob Lee' }], peopleCount: 1 })
    // the Trina list's groups: the project's group holds it
    const groups = await h.api('bob').call(API.listChatGroups)
    const inGroups = [...groups.pinned, ...groups.projects.flatMap((p) => p.top), ...groups.other.items].find((c) => c.id === chat.id)
    expect(inGroups?.shared).toMatchObject({ people: [{ id: 'alice' }], peopleCount: 1 })
    // pinned: the same faces
    await h.api('bob').call(API.pinChat, { params: { id: chat.id } })
    try {
      expect((await h.api('bob').call(API.listChatGroups)).pinned.find((c) => c.id === chat.id)?.shared).toMatchObject({ people: [{ id: 'alice' }], peopleCount: 1 })
      expect((await h.api('bob').call(API.listChats, { query: {} })).items.find((c) => c.id === chat.id)?.shared?.people).toEqual([{ id: 'alice', name: 'Alice Kim' }])
    } finally { await h.api('bob').call(API.unpinChat, { params: { id: chat.id } }) }
    // chat.updated: each person's own view, without themselves
    const from = { alice: ws.alice!.frames.length, bob: ws.bob!.frames.length }
    await h.api('alice').call(API.updateChat, { params: { id: chat.id }, body: { title: 'Falcon budget faces 2' } })
    const ev = async (u: 'alice' | 'bob') => (await ws[u]!.next('chat.updated', (f) => f.data.chatId === chat.id && f.data.chat?.title === 'Falcon budget faces 2' && ws[u]!.frames.indexOf(f) >= from[u])).data.chat!
    expect((await ev('alice')).shared).toMatchObject({ people: [{ id: 'bob' }], peopleCount: 1 })
    expect((await ev('bob')).shared).toMatchObject({ people: [{ id: 'alice' }], peopleCount: 1 })
    // erin does not see the project: its shared chats are not listed for her anywhere, so nobody's face is (her own
    // questions there from before do not bring it back)
    wrote('erin', chat.id)
    const forErin = await projectList('erin')
    expect(forErin.find((c) => c.id === chat.id)).toBeUndefined()
    expect(forErin.some((c) => c.shared)).toBe(false)
    expect((await h.api('erin').call(API.listChats, { query: {} })).items.some((c) => c.id === chat.id)).toBe(false)
    expect((await h.api('erin').call(API.listChats, { query: { q: 'faces' } })).items.some((c) => c.id === chat.id)).toBe(false)
    const erinGroups = await h.api('erin').call(API.listChatGroups)
    expect([...erinGroups.pinned, ...erinGroups.projects.flatMap((p) => p.top), ...erinGroups.other.items].some((c) => c.id === chat.id)).toBe(false)
    // bob loses the project: gone from his list, faces and all
    db().query("DELETE FROM group_members WHERE group_id = 'finance' AND user_id = 'bob'").run()
    try {
      expect(await inList('bob', chat.id)).toBeUndefined()
      expect((await projectList('bob')).some((c) => c.shared)).toBe(false)
      expect((await h.api('bob').call(API.listChats, { query: {} })).items.some((c) => c.id === chat.id)).toBe(false)
    } finally { db().query("INSERT INTO group_members VALUES ('finance','bob')").run() }
    // a shared chat in its creator's trash: no people there
    await h.api('alice').call(API.deleteChat, { params: { id: chat.id } })
    const trash = (await projectList('alice', { trash: true })).find((c) => c.id === chat.id)
    expect(trash?.shared).toBeTruthy()
    expect(trash!.shared!.people).toBeUndefined()
    await h.api('alice').call(API.restoreChat, { params: { id: chat.id } })
  })

  test('a chat that is not shared has none', async () => {
    const own = await h.api('alice').call(API.createChat, { body: {} })
    await ask('alice', own.id, 'private')
    const mine = (await h.api('alice').call(API.listChats, { query: {} })).items.find((c) => c.id === own.id)
    expect(mine).toBeTruthy()
    expect(mine!.shared).toBeUndefined()
    const groups = await h.api('alice').call(API.listChatGroups)
    expect([...groups.pinned, ...groups.projects.flatMap((p) => p.top), ...groups.other.items].find((c) => c.id === own.id)?.shared).toBeUndefined()
  })

  test('peopleFor: the viewer left out, at most 3, the count of the others', () => {
    const w = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase() }))
    expect(peopleFor(w, 'b')).toEqual({ people: [w[0]!, w[2]!, w[3]!], count: 4 })
    expect(peopleFor(w, 'zz')).toEqual({ people: w.slice(0, 3), count: 5 })
    expect(peopleFor([w[0]!], 'a')).toEqual({ people: [], count: 0 })
    expect(peopleFor(undefined, 'a')).toEqual({ people: [], count: 0 })
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
    // bob sees alice in each, himself never
    for (const c of chats) expect(list.find((x) => x.id === c.id)?.shared?.people).toEqual([{ id: 'alice', name: 'Alice Kim' }])
    const people = seen.filter((s) => s.includes('MAX(m.rowid)'))
    expect(people).toHaveLength(1)
    // each (person, chat) pair a seek on the covering index: no scan of the messages, no read of a message row
    const plan = (d.query('EXPLAIN QUERY PLAN ' + people[0]).all(JSON.stringify(chats.map((c) => c.id))) as { detail: string }[]).map((r) => r.detail).join(' | ')
    expect(plan).toContain('USING COVERING INDEX messages_author_chat (author_id=? AND chat_id=?)')
    expect(plan).not.toMatch(/SCAN m\b/)
    // nothing to ask for: no query at all
    expect(chatPeople(d, [], 'bob').size).toBe(0)
  })

  test('my chat list and the Trina list\'s groups: one people query each', async () => {
    const chats = [await newShared(), await newShared(), await newShared()]
    for (const c of chats) { wrote('alice', c.id); wrote('bob', c.id) }
    const d = db()
    for (const read of [() => h.api('bob').call(API.listChats, { query: {} }), () => h.api('bob').call(API.listChatGroups)]) {
      const seen: string[] = []
      const real = d.query
      d.query = ((sql: string) => { seen.push(sql); return real.call(d, sql) }) as typeof d.query
      try { await read() } finally { delete (d as unknown as Record<string, unknown>).query }
      expect(seen.filter((x) => x.includes('MAX(m.rowid)'))).toHaveLength(1)
    }
  })
})
