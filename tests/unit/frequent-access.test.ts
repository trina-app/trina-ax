// "My frequent questions" left Home (docs/DECISIONS.md "Home: what my group often asks") and its endpoint is removed
// (fix/followups-1112): nobody reads anyone's repeated questions through it any more. Popular skills (the Skills page)
// still need a sign-in.
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
})
afterAll(async () => { await a?.close() })
test('GET /api/questions/frequent is gone, for the person and for anyone else; popular skills still need a sign-in', async () => {
  for (const user of ['alice', 'bob', 'dana'] as const) {
    const r = await a.json('/api/questions/frequent?userId=alice', { as: user })
    expect(r.status, user).toBe(404)
    expect(JSON.stringify(r.body)).not.toContain('ALICE_PRIVATE_QUESTION')
  }
  expect((await a.req('/api/skills/popular')).status).toBe(401)
})
