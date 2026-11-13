// A room's side chat (✦ beside a room, docs/DECISIONS.md "Trina side chat") holds what the room said, so it never goes
// into a project and is never shared with a project's members (QA TC-1010): before, PATCH /api/chats/:id {projectId}
// moved it into a team project and POST /api/chats/:id/share showed the room's words to members outside the room.
// Also QA TC-1011: a member who never wrote in a team project sees the count of its shared chats on the Projects list
// (GET /api/chats/groups projectActivity), never another person's private chat.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { API, ApiError, uuidv7, type Room } from '@mycel/shared/api'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(120_000)
let h: Harness
const ws: Record<string, TestSocket> = {}
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const errOf = async (p: Promise<unknown>) => { try { await p } catch (e) { return e as ApiError } throw new Error('expected an error') }
let projectId = ''
beforeAll(async () => {
  h = await startHarness({ name: 'b-side-chat-no-project', turnTimeoutMs: 60_000 })
  // (team rooms are keyed by their group's id: the fixture's groups get real ids, as the app makes them)
  const db = h.ctx.db
  db.exec('PRAGMA foreign_keys = OFF')
  for (const g of ['marketing', 'finance']) {
    const id = uuidv7()
    for (const sql of ['UPDATE groups SET id = ?1 WHERE id = ?2', 'UPDATE group_members SET group_id = ?1 WHERE group_id = ?2', "UPDATE folder_rules SET subject_id = ?1 WHERE subject_type = 'group' AND subject_id = ?2", 'UPDATE rooms SET group_id = ?1 WHERE group_id = ?2'])
      db.query(sql).run(id, g)
  }
  db.exec('PRAGMA foreign_keys = ON')
  for (const u of ['alice', 'bob']) { ws[u] = await h.ws(u); await ws[u]!.next('hello') }
  // a team project: alice (marketing) made it, bob (finance, not in the marketing room) is a member
  projectId = (await h.api('alice').call(API.createProject, { body: { name: 'Audit', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })).id
})
afterAll(async () => { for (const s of Object.values(ws)) s.close(); await h.close() })

async function ask(user: string, chatId: string, content: string) {
  const s = await h.api(user).call(API.sendMessage, { params: { id: chatId }, body: { content, clientMessageId: 'cm-' + crypto.randomUUID(), attachmentIds: [] } })
  await ws[user]!.next('message.done', (f) => f.data.messageId === s.assistantMessage.id, 30_000)
}

test("a room's side chat never moves into a project and is never shared (QA TC-1010)", async () => {
  const room = ((await h.api('alice').call(API.listRooms)).items as Room[]).find((r) => r.kind === 'team' && r.name === 'Marketing')!
  expect(room).toBeTruthy()
  expect(((await h.api('bob').call(API.listRooms)).items as Room[]).some((r) => r.id === room.id)).toBe(false)
  const side = await h.api('alice').call(API.createChat, { body: { sideRoomId: room.id } })
  await ask('alice', side.id, `> Erin · 10:02\n> ROOM-CANARY-77 the price is 4.2M\n\nWhat does she mean?\n${fake({ say: 'ok' })}`)
  // the move: 400 side_chat_no_project, in the person's words, and nothing changed
  const moved = await errOf(h.api('alice').call(API.updateChat, { params: { id: side.id }, body: { projectId } }))
  expect([moved.status, moved.body.fields?.['body.projectId'], moved.body.params?.reason]).toEqual([400, 'side_chat_no_project', 'side_chat_no_project'])
  expect(moved.body.message).toBe('A chat opened beside a room holds what was said in that room, so it can\'t be moved into a project. Ask in a new chat instead.')
  expect(h.ctx.db.query('SELECT project_id, shared_at FROM chats WHERE id = ?').get(side.id)).toEqual({ project_id: null, shared_at: null })
  // a rename still works (only a project is refused)
  expect((await h.api('alice').call(API.updateChat, { params: { id: side.id }, body: { title: 'Price question' } })).title).toBe('Price question')
  // one an older build let into a project: the share refuses it all the same, and bob never reads it
  h.ctx.db.query('UPDATE chats SET project_id = ? WHERE id = ?').run(projectId, side.id)
  const shared = await errOf(h.api('alice').call(API.shareChat, { params: { id: side.id }, body: {} }))
  expect([shared.status, shared.body.params?.reason]).toEqual([409, 'side_chat'])
  expect(h.ctx.db.query('SELECT shared_at FROM chats WHERE id = ?').get(side.id)).toEqual({ shared_at: null })
  expect((await errOf(h.api('bob').call(API.listMessages, { params: { id: side.id }, query: {} }))).status).toBe(404)
  expect((await h.api('bob').call(API.listChats, { query: { projectId } })).items.map((c) => c.id)).not.toContain(side.id)
  h.ctx.db.query('UPDATE chats SET project_id = NULL WHERE id = ?').run(side.id)
})

test('the Projects list counts the shared chats for a member who never wrote there, never a private one (QA TC-1011)', async () => {
  const shared = await h.api('alice').call(API.createChat, { body: { projectId, title: 'alice shared' } })
  await ask('alice', shared.id, `hello\n${fake({ say: 'hi' })}`)
  const mine = await h.api('alice').call(API.createChat, { body: { projectId, title: 'alice only', private: true } })
  await ask('alice', mine.id, `just me\n${fake({ say: 'hi' })}`)
  const page = (await h.api('bob').call(API.listChats, { query: { projectId } })).items.map((c) => c.id)
  expect(page).toContain(shared.id)
  expect(page).not.toContain(mine.id)
  const count = (user: string) => h.api(user).call(API.listChatGroups, {}).then((g) => g.projectActivity?.find((a) => a.projectId === projectId)?.count ?? 0)
  // bob sees what his project page lists; alice sees both of hers
  expect(await count('bob')).toBe(page.length)
  expect(await count('alice')).toBe(page.length + 1)
})
