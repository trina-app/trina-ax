import { afterAll, beforeAll, expect, test } from 'bun:test'
import { makeCApp, type CApp } from '../lib/c-app'
import { ChatStore } from '../../server/src/chat/store'
import { newId } from '../../server/src/db'

let a: CApp
beforeAll(async () => {
  a = await makeCApp('frequent-access')
  const c = newId(), store = new ChatStore(a.ctx.db)
  a.ctx.db.query('INSERT INTO chats(id,user_id) VALUES(?,?)').run(c, 'alice')
  let parent: string | null = null
  for (let i = 0; i < 2; i++) parent = store.insertMessage({ chatId: c, parentId: parent, role: 'user', authorId: 'alice', content: 'ALICE_PRIVATE_QUESTION', status: 'done' })
  a.ctx.db.query('UPDATE chats SET active_leaf_id=? WHERE id=?').run(parent, c)
  a.ctx.db.query('UPDATE messages SET created_at=? WHERE chat_id=?').run(new Date(Date.now() - 1000).toISOString(), c)
})
afterAll(async () => { await a?.close() })
test('question endpoint binds the authenticated user even when another user is requested; admins cannot query other prompts', async () => {
  expect((await a.json('/api/questions/frequent', { as: 'alice' })).body.items[0]?.question).toBe('ALICE_PRIVATE_QUESTION')
  for (const user of ['bob', 'carol', 'dana'] as const) {
    const r = await a.json('/api/questions/frequent?userId=alice', { as: user })
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).not.toContain('ALICE_PRIVATE_QUESTION')
  }
  expect((await a.req('/api/questions/frequent')).status).toBe(401)
  expect((await a.req('/api/skills/popular')).status).toBe(401)
})
