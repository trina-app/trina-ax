import { afterAll, beforeEach, expect, test } from 'bun:test'
import { makeEnv } from '../lib/env'
import { newId } from '../../server/src/db'
import { ChatStore } from '../../server/src/chat/store'
import { frequentQuestions } from '../../server/src/chat/frequent-questions'

const e = makeEnv('frequent-questions'), store = new ChatStore(e.db)
const now = new Date('2026-10-27T00:00:00.000Z'), at = '2026-10-20T00:00:00.000Z'
beforeEach(() => { e.db.query('DELETE FROM chats').run(); e.db.query("UPDATE users SET status='active' WHERE id='alice'").run() })
afterAll(() => e.db.close())
function chat(owner = 'alice') {
  const id = newId()
  e.db.query('INSERT INTO chats(id,user_id,created_at,updated_at) VALUES(?,?,?,?)').run(id, owner, at, at)
  return id
}
function message(chatId: string, content: string, parentId: string | null = null, owner = 'alice', role: 'user' | 'assistant' = 'user') {
  const id = store.insertMessage({ chatId, content, parentId, authorId: role === 'user' ? owner : null, role, status: 'done' })
  e.db.query('UPDATE messages SET created_at=? WHERE id=?').run(at, id)
  e.db.query('UPDATE chats SET active_leaf_id=? WHERE id=?').run(id, chatId)
  return id
}
const read = (user = 'alice') => frequentQuestions(e.db, user, now)

test('counts each own active user message once; whitespace normalization and stable ties', () => {
  const c = chat(); const first = message(c, '  Weekly\n  report? ')
  const answer = message(c, 'Answer only', first, 'alice', 'assistant')
  const second = message(c, 'Weekly report?', answer)
  message(c, 'Another generated answer', second, 'alice', 'assistant')
  expect(read().items).toEqual([{ question: 'Weekly report?', count: 2, lastUsedAt: at }])
  expect(read('bob').items).toEqual([])
})
test('inactive edit branches, deleted chats/messages, assistant and other author text are excluded', () => {
  const c = chat(); message(c, 'old edited text')
  const current = message(c, 'replacement'); message(c, 'replacement', current)
  const theirs = chat('bob'); message(theirs, 'other person secret', null, 'bob'); message(theirs, 'other person secret', null, 'bob')
  expect(JSON.stringify(read())).not.toContain('secret')
  expect(read().items.map(x => x.question)).toEqual(['replacement'])
  e.db.query('UPDATE chats SET deleted_at=? WHERE id=?').run(at, c)
  expect(read().items).toEqual([])
})
test('scheduled prompts and regenerations do not inflate personal question frequency', () => {
  const c = chat(); const first = message(c, 'scheduled prompt'); const second = message(c, 'scheduled prompt', first)
  for (const m of [first, second]) e.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,user_message_id,client_kind,schedule_id) VALUES(?,?,?,'claude-code','done',?,'schedule','s')").run(newId(), c, 'alice', m)
  const human = message(c, 'human prompt', second)
  for (let i = 0; i < 3; i++) e.db.query("INSERT INTO turns(id,chat_id,user_id,engine,status,user_message_id) VALUES(?,?,?,'claude-code','done',?)").run(newId(), c, 'alice', human)
  expect(read().items).toEqual([])
})
test('30-day half-open range, oversized prompts and disabled accounts are excluded', () => {
  const c = chat(); const m = message(c, 'past'); message(c, 'past', m)
  e.db.query("UPDATE messages SET created_at='2026-09-01T00:00:00.000Z'").run()
  expect(read().items).toEqual([])
  let p = message(c, 'x'.repeat(2001)); message(c, 'x'.repeat(2001), p)
  expect(read().items).toEqual([])
  p = message(c, 'recent'); message(c, 'recent', p)
  expect(read().items).toHaveLength(1)
  e.db.query("UPDATE users SET status='disabled' WHERE id='alice'").run()
  expect(read().items).toEqual([])
})
test('malformed cross-chat parent pointers never reveal another owner and cycles are bounded', () => {
  const b = chat('bob'), secret = message(b, 'BOB_SECRET', null, 'bob')
  const c = chat(), own = message(c, 'own', secret)
  expect(JSON.stringify(read())).not.toContain('BOB_SECRET')
  e.db.query('UPDATE messages SET parent_id=? WHERE id=?').run(own, own)
  const result = read()
  expect(result.items).toEqual([])
  expect(result.sampled).toBe(true)
})
