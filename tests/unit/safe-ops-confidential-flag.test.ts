// The confidential flag the web app reads to show artifacts and HTML / SVG previews without scripts outside the desktop
// app (web/src/lib/confidential.ts): Chat.confidential for a chat marked by Safe operations 1A, and
// Me.server.allChatsConfidential while 1A is on. Showing it marks nothing (unlike confidentialChat()).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { AuthService } from '../../server/src/auth/service'

let h: Harness
/** GET /api/me's body for alice (the harness signs people in without session rows; AuthService.me needs one) */
function me() {
  const sid = crypto.randomUUID()
  const now = new Date().toISOString()
  h.ctx.db.query('INSERT INTO sessions (id, user_id, token_hash, client, user_agent, created_at, last_seen_at, expires_at, temp_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
    .run(sid, 'alice', 'x-' + sid, 'web', 'test', now, now, new Date(Date.now() + 3600_000).toISOString())
  return new AuthService(h.ctx).me('alice', sid)
}
beforeAll(async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  h = await startHarness({ name: 'safe-ops-confidential-flag' })
})
afterAll(async () => {
  delete process.env.MYCEL_SAFE_OPS_1A
  await h.close()
})

test('a chat marked confidential says so; others and /api/me do not', async () => {
  const api = h.api('alice')
  const marked = await api.call(API.createChat, { body: {} })
  const plain = await api.call(API.createChat, { body: {} })
  expect((await api.call(API.getChat, { params: { id: marked.id } })).confidential).toBeUndefined()
  h.ctx.db.query('INSERT INTO safe_ops_chats(chat_id) VALUES (?)').run(marked.id)
  expect((await api.call(API.getChat, { params: { id: marked.id } })).confidential).toBe(true)
  expect((await api.call(API.getChat, { params: { id: plain.id } })).confidential).toBeUndefined()
  const list = await api.call(API.listChats, { query: {} })
  expect(list.items.find((c) => c.id === marked.id)?.confidential).toBe(true)
  expect(list.items.find((c) => c.id === plain.id)?.confidential).toBeUndefined()
  expect(me().server.allChatsConfidential).toBeUndefined()
  // reading the flag marked nothing
  expect(h.ctx.db.query('SELECT count(*) AS n FROM safe_ops_chats').get()).toEqual({ n: 1 })
})

test('with Safe operations 1A on, every chat and the server say so, still without marking', async () => {
  process.env.MYCEL_SAFE_OPS_1A = '1'
  try {
    const api = h.api('alice')
    const chat = await api.call(API.createChat, { body: {} })
    expect(chat.confidential).toBe(true)
    expect(me().server.allChatsConfidential).toBe(true)
    expect(h.ctx.db.query('SELECT 1 FROM safe_ops_chats WHERE chat_id = ?').get(chat.id)).toBeNull()
  } finally {
    delete process.env.MYCEL_SAFE_OPS_1A
  }
})
