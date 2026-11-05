// The receipt under an answer (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"; chat/store.ts receiptOf):
// a finished answer that ran a team skill says which one and how many team files went into it, "팀 스킬 '할 일 정리' ·
// 팀 파일 2개": the question's team-file references and the files it read, each once, leaving out personal folders and
// skills/. Counts only; no receipt without a skill run, and none while the answer is still being written.
import { afterEach, expect, test } from 'bun:test'
import { uuidv7 } from '@mycel/shared/api'
import { harness, withOwner, type Harness } from './a-lib'

let h: Harness
afterEach(async () => { await h?.close() })

const TASKS = 'skills/general/meeting-tasks/SKILL.md'

function answer(userId: string, o: { run?: { path: string; name: string; source: 'command' | 'tool' }[]; refs?: string[]; read?: string[]; status?: string }) {
  const db = h.ctx.db
  const chatId = uuidv7()
  const askId = uuidv7()
  const answerId = uuidv7()
  const turnId = uuidv7()
  db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, userId)
  const atts = (o.refs ?? []).map((p) => ({ id: uuidv7(), name: p.split('/').pop(), path: p, size: 1, mime: 'text/markdown', kind: 'text', source: 'team' }))
  db.query("INSERT INTO messages (id, chat_id, role, content, status, attachments) VALUES (?, ?, 'user', '/meeting-tasks 내 할 일 정리해 줘', 'done', ?)").run(askId, chatId, JSON.stringify(atts))
  db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, message_id) VALUES (?, ?, ?, 'claude', 'done', ?)").run(turnId, chatId, userId, answerId)
  db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status, turn_id) VALUES (?, ?, ?, 'assistant', '할 일이에요.', ?, ?)").run(answerId, chatId, askId, o.status ?? 'done', turnId)
  db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
  for (const r of o.run ?? []) db.query('INSERT INTO turn_skill_runs (turn_id, skill_path, skill_name, source) VALUES (?, ?, ?, ?)').run(turnId, r.path, r.name, r.source)
  ;(o.read ?? []).forEach((p, i) => db.query("INSERT INTO message_sources (message_id, ord, path, sha256, locs, via, by_main, by_subagent) VALUES (?, ?, ?, NULL, '[]', 'read', 1, 0)").run(answerId, i, p))
  return chatId
}

test('the skill the answer ran and the team files that went into it, each once; nothing without a run', async () => {
  h = await harness('b-answer-receipt')
  const owner = await withOwner(h)
  const me = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  const last = async (chatId: string) => (await owner.call('GET', `/api/chats/${chatId}/messages`)).items.at(-1)

  const notes = ['groups/Acme/회의록/11-03.md', 'groups/Acme/회의록/11-05.md']
  // attached and read: the same file counts once; the person's own folder, an upload and skills/ are not team files
  const chat = answer(me, {
    run: [{ path: TASKS, name: 'meeting-tasks', source: 'command' }],
    refs: notes,
    read: [notes[0]!, `users/${me}/.attachments/x/note.md`, 'skills/company-profile.json', 'shared/공지.md'],
  })
  expect((await last(chat)).receipt).toEqual({ skill: { path: TASKS, name: 'meeting-tasks' }, teamFiles: 3 })

  // a "/name" run comes before a skill the AI loaded with the skill tool in the same answer
  const both = answer(me, { run: [{ path: 'skills/general/doc-brief/SKILL.md', name: 'doc-brief', source: 'tool' }, { path: TASKS, name: 'meeting-tasks', source: 'command' }] })
  expect((await last(both)).receipt).toEqual({ skill: { path: TASKS, name: 'meeting-tasks' }, teamFiles: 0 })

  // no skill run: no receipt (the step summary stays "작업 N단계"); still being written: none yet
  expect((await last(answer(me, { refs: notes }))).receipt).toBeUndefined()
  expect((await last(answer(me, { run: [{ path: TASKS, name: 'meeting-tasks', source: 'command' }], refs: notes, status: 'streaming' }))).receipt).toBeUndefined()
})
