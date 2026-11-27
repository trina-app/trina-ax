// A continued chat in my history, like the Claude app's session list (docs/decisions/20261127-fork-in-history.md):
// GET /api/chats?ids= brings the originals of continuations that no page brought yet, by my history's own rule only
// (never a chat in the trash, one I hid, another person's private chat, one no longer shared with me); a continuation
// of a chat in one of my sections starts in that section, and outside it when the section is full (the fork never fails
// for it).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, NAV_FOLDER_ITEMS_MAX, type Chat } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'
import { newId } from '../../server/src/db'

setDefaultTimeout(90_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()

let h: Harness
const ws: Record<string, TestSocket> = {}
beforeAll(async () => {
  h = await startHarness({ name: 'b-fork-in-history', askUserTimeoutMs: 2500, stallTimeoutMs: 60_000 })
  for (const u of ['alice', 'bob', 'carol']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

async function answered(user: string, title: string): Promise<Chat> {
  const c = await h.api(user).call(API.createChat, { body: { title } })
  const started = await h.api(user).call(API.sendMessage, { params: { id: c.id }, body: { content: `${title}\n${fake({ say: 'OK' })}`, clientMessageId: cm() } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === started.assistantMessage.id, 30_000)
  return c
}
async function sharedWith(owner: string, title: string, who: string): Promise<Chat> {
  const c = await answered(owner, title)
  const subjects = [{ subjectType: 'user' as const, subjectId: who }]
  let r = await h.api(owner).call(API.putChatAudience, { params: { id: c.id }, body: { subjects } })
  if (r.status === 'confirm') r = await h.api(owner).call(API.putChatAudience, { params: { id: c.id }, body: { subjects, confirmKey: r.confirmKey } })
  expect(r.status).toBe('saved')
  return c
}
const byIds = async (user: string, ids: string[]) => (await h.api(user).call(API.listChats, { query: { ids: ids.join(',') } })).items.map((c) => c.id)
const status = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { return (e as ApiError).status } }

describe('GET /api/chats?ids=', () => {
  test('my own chat, only by my history\'s rule: never one in the trash, hidden, another person\'s, or no longer shared with me', async () => {
    const mine = await answered('alice', 'mine')
    const trashed = await answered('alice', 'in the trash')
    await h.api('alice').call(API.deleteChat, { params: { id: trashed.id } })
    const bobs = await answered('bob', 'bob private')
    const hidden = await sharedWith('carol', 'carol hidden', 'alice')
    await h.api('alice').call(API.hideChat, { params: { id: hidden.id } })
    const unshared = await sharedWith('carol', 'carol unshared', 'alice')
    await h.api('carol').call(API.putChatAudience, { params: { id: unshared.id }, body: { subjects: [] } })
    const kept = await sharedWith('carol', 'carol kept', 'alice')
    // one shared with me that I never hid: in my list, so answered
    const got = await byIds('alice', [mine.id, trashed.id, bobs.id, hidden.id, unshared.id, kept.id])
    expect(got.sort()).toEqual([mine.id, kept.id].sort())
    // nothing about the others leaks in the raw answer either
    const raw = await (await h.req('alice', `/api/chats?ids=${[bobs.id, hidden.id, unshared.id, trashed.id].join(',')}`)).text()
    for (const t of ['bob private', 'carol hidden', 'carol unshared', 'in the trash']) expect(raw).not.toContain(t)
  })

  test('alone: not with a search, a project, the trash, a cursor, other or unread; at most 50 ids', async () => {
    const id = (await answered('alice', 'alone')).id
    for (const q of [`q=x`, 'trash=1', 'other=1', 'unread=1', `cursor=abc`]) expect((await h.req('alice', `/api/chats?ids=${id}&${q}`)).status).toBe(400)
    const many = Array.from({ length: 51 }, () => id).join(',')
    expect((await h.req('alice', `/api/chats?ids=${many}`)).status).toBe(400)
    expect(await status(h.api('alice').call(API.listChats, { query: { ids: id } }))).toBe(200)
  })
})

describe('a continuation of a chat in one of my sections', () => {
  test('starts in that section; a full section leaves it outside and the continuation is still made', async () => {
    const f = await h.api('alice').call(API.createNavFolder, { body: { kind: 'chats', name: 'Reports' } })
    const a = await answered('alice', 'report draft')
    await h.api('alice').call(API.setChatFolder, { params: { id: a.id }, body: { folderId: f.id } })
    const cont = await h.api('alice').call(API.forkChat, { params: { id: a.id }, body: {} })
    expect(cont.folderId).toBe(f.id)
    expect(cont.forkParents).toEqual([a.id])
    // not in one: none
    const b = await answered('alice', 'loose')
    expect((await h.api('alice').call(API.forkChat, { params: { id: b.id }, body: {} })).folderId).toBeUndefined()
    // the section full: the continuation is made, outside it
    const db = h.ctx.db
    const n = (db.query('SELECT COUNT(*) n FROM nav_folder_items WHERE folder_id = ?').get(f.id) as { n: number }).n
    const now = new Date().toISOString()
    const ins = db.query("INSERT INTO chats (id, user_id, project_id, title, title_source, engine, model, created_at, updated_at) VALUES (?, 'alice', NULL, 'x', 'user', 'claude-code', NULL, ?, ?)")
    const fill = db.query("INSERT INTO nav_folder_items (folder_id, user_id, kind, chat_id, room_id, added_at) VALUES (?, 'alice', 'chats', ?, NULL, ?)")
    db.transaction(() => { for (let i = n; i < NAV_FOLDER_ITEMS_MAX; i++) { const id = newId(); ins.run(id, now, now); fill.run(f.id, id, now) } })()
    const outside = await h.api('alice').call(API.forkChat, { params: { id: a.id }, body: {} })
    expect(outside.folderId).toBeUndefined()
    expect(outside.forkParents).toEqual([a.id])
  })
})
