// Pinned chats (docs/DECISIONS.md "Pinned chats", server/src/chat/pins.ts): "상단에 고정" / "고정 해제" on a chat row.
// The project is on projects/falcon and shares its chats: alice writes it, the finance group (bob) reads it, carol
// (admin) and dana (owner) see everything; erin is not in its audience. Covered: pin and unpin (idempotent, my windows
// hear it, nobody else), the order of the list and its pages (my list, a project's page, a search), a shared chat's pin
// is its viewer's own, a pin of a chat I can no longer see is not shown and goes, the trash, a purge, a deleted project
// and a deleted person take their pins, and the cap.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, type Chat, type ServerFrame } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { updateGroupAs } from '../../server/src/admin/groups'
import { CHAT_PINS_MAX } from '../../server/src/chat/pins'

setDefaultTimeout(60_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
let projectId: string
beforeAll(async () => {
  h = await startHarness({ name: 'b-chat-pins', askUserTimeoutMs: 2500, turnTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'carol', 'dana', 'erin']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  const p = await h.api('alice').call(API.createProject, { body: { name: 'Falcon', folderPath: 'projects/falcon', scope: 'team', participants: [], instructions: '' } })
  projectId = p.id
  await h.api('alice').call(API.updateProject, { params: { id: projectId }, body: { shareChats: true } })
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

const db = () => h.ctx.db
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
const pin = (user: string, id: string) => h.api(user).call(API.pinChat, { params: { id } })
const unpin = (user: string, id: string) => h.api(user).call(API.unpinChat, { params: { id } })
const list = async (user: string, query: Record<string, string> = {}) => (await h.api(user).call(API.listChats, { query })).items
const ids = async (user: string, query: Record<string, string> = {}) => (await list(user, query)).map((c) => c.id)
const pinRows = (chatId: string) => (db().query('SELECT user_id FROM chat_pins WHERE chat_id = ? ORDER BY user_id').all(chatId) as { user_id: string }[]).map((r) => r.user_id)
/** a chat of `user`, last active `minutesAgo` (the list's order is by last activity) */
async function chat(user: string, minutesAgo: number, body: { projectId?: string } = {}): Promise<Chat> {
  const c = await h.api(user).call(API.createChat, { body })
  db().query('UPDATE chats SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), c.id)
  return c
}
async function ask(user: string, chatId: string, content: string) {
  const started = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
}
type Updated = Extract<ServerFrame, { type: 'chat.updated' }>
const seqOf = (f: ServerFrame) => ('seq' in f && typeof f.seq === 'number' ? f.seq : 0)
const mark = () => Object.fromEntries(Object.keys(ws).map((u) => [u, h.rt().hub.lastSeq(u)])) as Record<string, number>
const updates = (user: string, chatId: string, from: number) =>
  ws[user]!.frames.filter((f): f is Updated => f.type === 'chat.updated' && seqOf(f) > from && f.data.chatId === chatId)
/** every frame the server has sent so far reached each socket (before "hears nothing") */
async function caughtUp() {
  const to = mark()
  await waitFor(() => Object.keys(to).every((u) => ws[u]!.frames.reduce((n, f) => Math.max(n, seqOf(f)), 0) >= to[u]!), { timeoutMs: 10_000 })
}

describe('pin and unpin', () => {
  test('a pin puts the chat first in my list, only my windows hear it; unpin puts it back; both are idempotent', async () => {
    const old = await chat('alice', 300)
    const mid = await chat('alice', 200)
    const fresh = await chat('alice', 100)
    const from = mark()
    const pinned = await pin('alice', old.id)
    expect(pinned.pinnedAt).toBeString()
    expect((await h.api('alice').call(API.getChat, { params: { id: old.id } })).pinnedAt).toBe(pinned.pinnedAt)
    const first = await ids('alice')
    expect(first[0]).toBe(old.id)
    expect(first.filter((id) => id === old.id)).toHaveLength(1)
    expect(first.indexOf(fresh.id)).toBeLessThan(first.indexOf(mid.id))
    // my windows hear it with the pin; nobody else hears anything
    await ws.alice!.next('chat.updated', (f) => f.data.chatId === old.id && !!f.data.chat?.pinnedAt)
    await caughtUp()
    expect(updates('alice', old.id, from.alice).map((f) => [f.data.change, f.data.chat?.pinnedAt])).toEqual([['updated', pinned.pinnedAt]])
    for (const u of ['bob', 'carol', 'dana', 'erin']) expect(updates(u, old.id, from[u])).toEqual([])
    // pinned again: unchanged (its place does not move), no event
    const again = mark()
    expect((await pin('alice', old.id)).pinnedAt).toBe(pinned.pinnedAt)
    await caughtUp()
    expect(updates('alice', old.id, again.alice)).toEqual([])

    const before = mark()
    const off = await unpin('alice', old.id)
    expect(off.pinnedAt).toBeUndefined()
    await ws.alice!.next('chat.updated', (f) => f.data.chatId === old.id && seqOf(f) > before.alice)
    expect(updates('alice', old.id, before.alice).map((f) => f.data.chat?.pinnedAt)).toEqual([undefined])
    const back = await ids('alice')
    expect(back.indexOf(fresh.id)).toBeLessThan(back.indexOf(mid.id))
    expect(back.indexOf(mid.id)).toBeLessThan(back.indexOf(old.id))
    expect((await unpin('alice', old.id)).pinnedAt).toBeUndefined()
    expect(pinRows(old.id)).toEqual([])
  })

  test('only a chat I can see: someone else\'s, a missing one or one in the trash is not found', async () => {
    const mine = await chat('alice', 50)
    expect((await errOf(pin('erin', mine.id))).status).toBe(404)
    expect((await errOf(unpin('erin', mine.id))).status).toBe(404)
    expect((await errOf(pin('alice', crypto.randomUUID()))).status).toBe(404)
    await h.api('alice').call(API.deleteChat, { params: { id: mine.id } })
    expect((await errOf(pin('alice', mine.id))).status).toBe(404)
    expect(pinRows(mine.id)).toEqual([])
  })
})

describe('the order', () => {
  test('pinned first, the most recently pinned first; the pages after the first leave them out', async () => {
    const a = await chat('carol', 400)
    const b = await chat('carol', 300)
    const c = await chat('carol', 200)
    const d = await chat('carol', 100)
    await pin('carol', b.id)
    await pin('carol', a.id)
    // the first page: the pins, then the newest of the rest
    const all = await ids('carol')
    expect(all.slice(0, 2)).toEqual([a.id, b.id])
    expect(all.slice(2)).toEqual([d.id, c.id])
    // one by one: every chat once, the pins on the first page
    const seen: string[][] = []
    let cursor: string | undefined
    do {
      const page = await h.api('carol').call(API.listChats, { query: { limit: 1, ...(cursor ? { cursor } : {}) } })
      seen.push(page.items.map((x) => x.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen[0]).toEqual([a.id, b.id, d.id])
    expect(seen.flat()).toEqual([a.id, b.id, d.id, c.id])
    // a search keeps the usual order and marks the pins
    await h.api('carol').call(API.updateChat, { params: { id: a.id }, body: { title: 'PINWORD alpha' } })
    await h.api('carol').call(API.updateChat, { params: { id: d.id }, body: { title: 'PINWORD delta' } })
    db().query('UPDATE chats SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - 400 * 60_000).toISOString(), a.id)
    const found = await list('carol', { q: 'PINWORD' })
    expect(found.map((x) => [x.id, !!x.pinnedAt])).toEqual([[d.id, false], [a.id, true]])
    // the trash has no pins
    expect((await list('carol', { trash: '1' })).some((x) => x.pinnedAt)).toBe(false)
  })

  test("a project's page starts with my pins there", async () => {
    const p = await h.api('carol').call(API.createProject, { body: { name: 'Pins', scope: 'personal', instructions: '' } })
    const x = await chat('carol', 30, { projectId: p.id })
    const y = await chat('carol', 20, { projectId: p.id })
    const outside = await chat('carol', 10)
    await pin('carol', x.id)
    await pin('carol', outside.id)
    expect(await ids('carol', { projectId: p.id })).toEqual([x.id, y.id])
    expect((await ids('carol')).slice(0, 2)).toEqual([outside.id, x.id])
  })
})

describe('shared project chats', () => {
  test("a pin is its viewer's own: the others neither see it nor hear of it, also when the chat changes later", async () => {
    const shared = await h.api('alice').call(API.createChat, { body: { projectId } })
    await ask('alice', shared.id, 'alice asks\n' + fake({ say: 'ok' }))
    await ask('bob', shared.id, 'bob asks\n' + fake({ say: 'ok' }))
    const from = mark()
    const mine = await pin('bob', shared.id)
    expect(mine.pinnedAt).toBeString()
    expect(mine.shared?.mine).toBe(true)
    expect((await ids('bob'))[0]).toBe(shared.id)
    for (const u of ['alice', 'carol']) expect((await h.api(u).call(API.getChat, { params: { id: shared.id } })).pinnedAt).toBeUndefined()
    expect((await list('alice')).find((x) => x.id === shared.id)?.pinnedAt).toBeUndefined()
    await ws.bob!.next('chat.updated', (f) => f.data.chatId === shared.id && !!f.data.chat?.pinnedAt)
    await caughtUp()
    for (const u of ['alice', 'carol', 'dana', 'erin']) expect(updates(u, shared.id, from[u])).toEqual([])
    // alice's next turn: everyone who sees it hears it as they see it, bob with his pin, alice without
    const turn = mark()
    await ask('alice', shared.id, 'again\n' + fake({ say: 'ok' }))
    await waitFor(() => updates('bob', shared.id, turn.bob).length > 0, { timeoutMs: 10_000 })
    await caughtUp()
    expect(updates('bob', shared.id, turn.bob).every((f) => f.data.chat?.pinnedAt === mine.pinnedAt)).toBe(true)
    expect(updates('alice', shared.id, turn.alice).length).toBeGreaterThan(0)
    expect(updates('alice', shared.id, turn.alice).every((f) => f.data.chat?.pinnedAt === undefined)).toBe(true)
    // carol (admin) may pin it too, for herself
    await pin('carol', shared.id)
    expect(pinRows(shared.id)).toEqual(['bob', 'carol'])
    await unpin('carol', shared.id)
    expect((await h.api('bob').call(API.getChat, { params: { id: shared.id } })).pinnedAt).toBe(mine.pinnedAt)
  })

  test('a pin of a chat I can no longer see is not shown and goes; erin cannot pin it', async () => {
    const shared = await h.api('alice').call(API.createChat, { body: { projectId } })
    await ask('bob', shared.id, 'bob asks\n' + fake({ say: 'ok' }))
    await pin('bob', shared.id)
    expect((await errOf(pin('erin', shared.id))).status).toBe(404)
    // bob leaves the finance group: he loses projects/falcon
    updateGroupAs(h.ctx, 'dana', 'finance', { memberIds: [] }, 'en')
    try {
      expect(await ids('bob', { projectId })).not.toContain(shared.id)
      expect(await ids('bob')).not.toContain(shared.id)
      expect(pinRows(shared.id)).toEqual([])
      expect((await errOf(unpin('bob', shared.id))).status).toBe(404)
    } finally { updateGroupAs(h.ctx, 'dana', 'finance', { memberIds: ['bob'] }, 'en') }
    // back in the group: the chat is in his list again (he wrote in it), not pinned
    const back = (await list('bob')).find((x) => x.id === shared.id)
    expect(back).toBeDefined()
    expect(back!.pinnedAt).toBeUndefined()
  })
})

describe('what takes a pin away', () => {
  test("the trash takes everyone's pin of the chat (restored, it is not pinned); a purge too", async () => {
    const shared = await h.api('alice').call(API.createChat, { body: { projectId } })
    await ask('bob', shared.id, 'bob asks\n' + fake({ say: 'ok' }))
    await pin('alice', shared.id)
    await pin('bob', shared.id)
    expect(pinRows(shared.id)).toEqual(['alice', 'bob'])
    await h.api('alice').call(API.deleteChat, { params: { id: shared.id } })
    expect(pinRows(shared.id)).toEqual([])
    const back = await h.api('alice').call(API.restoreChat, { params: { id: shared.id } })
    expect(back.pinnedAt).toBeUndefined()
    expect((await list('bob')).find((x) => x.id === shared.id)?.pinnedAt).toBeUndefined()

    const gone = await chat('alice', 5)
    await pin('alice', gone.id)
    h.rt().purgeChat(gone.id)
    expect(pinRows(gone.id)).toEqual([])
  })

  test("a deleted project's shared chats lose their pins", async () => {
    const p = await h.api('dana').call(API.createProject, { body: { name: 'Temp pins', scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
    await h.api('dana').call(API.updateProject, { params: { id: p.id }, body: { shareChats: true } })
    const shared = await h.api('bob').call(API.createChat, { body: { projectId: p.id } })
    await pin('bob', shared.id)
    await pin('dana', shared.id)
    await h.api('dana').call(API.deleteProject, { params: { id: p.id } })
    expect(pinRows(shared.id)).toEqual([])
  })

  test(`at most ${CHAT_PINS_MAX} pins; a pin of a chat in the trash does not count`, async () => {
    const many: Chat[] = []
    for (let i = 0; i < CHAT_PINS_MAX; i++) many.push(await h.api('dana').call(API.createChat, { body: {} }))
    for (const c of many) await pin('dana', c.id)
    const one = await h.api('dana').call(API.createChat, { body: {} })
    const e = await errOf(pin('dana', one.id))
    expect(e.status).toBe(409)
    expect(e.body.params?.reason).toBe('chat_pins_full')
    // a pin left by an older build on a chat in the trash: dropped, so it does not count
    db().query('UPDATE chats SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), many[0]!.id)
    expect((await pin('dana', one.id)).pinnedAt).toBeString()
    // the list carries every pin on its first page
    expect((await list('dana', { limit: '1' })).filter((x) => x.pinnedAt)).toHaveLength(CHAT_PINS_MAX)
  })

  test("a deleted person's pins go", async () => {
    const own = await chat('erin', 5)
    await pin('erin', own.id)
    expect(pinRows(own.id)).toEqual(['erin'])
    await h.api('dana').call(API.deleteUser, { params: { id: 'erin' }, query: { personalFolder: 'delete' }, body: {} })
    expect((db().query("SELECT COUNT(*) AS n FROM chat_pins WHERE user_id = 'erin'").get() as { n: number }).n).toBe(0)
  })
})
