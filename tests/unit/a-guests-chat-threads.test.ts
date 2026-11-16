// Threads on AI answers (docs/decisions/20261116-chat-answer-threads.md) and guests (docs/DECISIONS.md "Guests: only
// what they were invited to"): the four thread endpoints are on the guest allow-list on purpose, and the thread's gate
// (chat/threads.ts threadAccess → chatFor) is the real check. A real guest in a team project replies under an answer of
// their own shared chat there (201, never 403), and gets the 404 of a missing chat for a member's shared chat of the
// same project. Answers are written straight into the database (no engine in this harness).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

/** a question and a finished answer in `chatId`, as a turn would leave them */
function answered(chatId: string, by: string): string {
  const q = uuidv7(), a = uuidv7(), at = new Date().toISOString()
  h.ctx.db.query("INSERT INTO messages (id, chat_id, role, author_id, content, status, created_at) VALUES (?, ?, 'user', ?, 'Which seal?', 'done', ?)").run(q, chatId, by, at)
  h.ctx.db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, created_at) VALUES (?, ?, ?, 'assistant', 'The corporate seal.', 'done', ?)").run(a, chatId, q, at)
  h.ctx.db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(a, chatId)
  return a
}

test('a guest replies in a thread of their own shared chat (201); a member\'s shared chat is the 404 of a missing chat', async () => {
  h = await harness('a-guests-chat-threads')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const project = await mia.client.call('POST', '/api/projects', { name: 'Quote', participants: [] })
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'project', id: project.id } })
  const own = await g.client.call('POST', '/api/chats', { projectId: project.id })
  expect(own.shared).toBeTruthy()
  const ownAnswer = answered(own.id, g.id)
  const post = await g.client.try('POST', `/api/chats/${own.id}/messages/${ownAnswer}/thread`, { text: 'Seal, please.', clientId: 'cid-guest-0001' })
  expect(post.status).toBe(201)
  expect(post.body).toMatchObject({ author: { id: g.id }, content: 'Seal, please.', canDelete: true })
  const list = await g.client.try('GET', `/api/chats/${own.id}/messages/${ownAnswer}/thread`)
  expect(list.status).toBe(200)
  expect(list.body.replies.length).toBe(1)
  // the project's member sees the guest's chat and its thread (owner decision 2026-11-14)
  expect((await mia.client.try('GET', `/api/chats/${own.id}/messages/${ownAnswer}/thread`)).status).toBe(200)
  // mia's own shared chat of the same project: never the guest's (the one 404 of a missing chat, for every route)
  const hers = await mia.client.call('POST', '/api/chats', { projectId: project.id })
  const herAnswer = answered(hers.id, mia.id)
  const reply = await mia.client.call('POST', `/api/chats/${hers.id}/messages/${herAnswer}/thread`, { text: 'members only', clientId: 'cid-mia-00001' })
  for (const [m, p, body] of [
    ['GET', `/api/chats/${hers.id}/messages/${herAnswer}/thread`, undefined],
    ['POST', `/api/chats/${hers.id}/messages/${herAnswer}/thread`, { text: 'x', clientId: 'cid-guest-0002' }],
    ['POST', `/api/chats/${hers.id}/messages/${herAnswer}/thread/read`, { upTo: reply.id }],
    ['DELETE', `/api/chats/${hers.id}/thread-replies/${reply.id}`, undefined],
    // her reply's id under the guest's own chat: no way in either
    ['DELETE', `/api/chats/${own.id}/thread-replies/${reply.id}`, undefined],
  ] as const) {
    const r = await g.client.try(m, p, body)
    expect(`${m} ${p} ${r.status}`).toBe(`${m} ${p} 404`)
    expect(JSON.stringify(r.body ?? {})).not.toContain('members only')
  }
  expect((h.ctx.db.query('SELECT COUNT(*) AS n FROM chat_thread_replies WHERE chat_id = ?').get(hers.id) as { n: number }).n).toBe(1)
})
