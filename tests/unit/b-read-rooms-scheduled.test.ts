// A scheduled run's instruction with a line that starts with ">" is not a quote of other people's words (chat/read-rooms.ts
// quotesOnBranch skips auto-sent messages): the run does not count as having read rooms, so its writes do not stop on
// the room card. A quote the person typed still counts.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { uuidv7 } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { waitFor } from '../lib/wait'
import { CONFIRMED } from '../lib/schedule-card'
import { quotesOnBranch, readRooms } from '../../server/src/chat/read-rooms'

setDefaultTimeout(120_000)
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
let h: Harness
beforeAll(async () => { h = await startHarness({ name: 'b-read-rooms-scheduled' }) })
afterAll(async () => { await h.close() })

test('a scheduled run whose instruction has a "> " line: no room read, and its write is not stopped by the room card', async () => {
  const rt = h.rt()
  fs.mkdirSync(path.join(h.team, 'users', 'carol'), { recursive: true })
  const prompt = `Weekly note\n> keep it short\n${fake({ tool: 'write', args: { file_path: 'users/carol/weekly-run.md', content: 'note' }, sayResult: true }, { say: 'done' })}`
  const now = new Date()
  const made = rt.schedules.create('carol', { title: 'Weekly note', prompt, repeat: 'daily', time: '09:00' }, new Date(now.getTime() - 2 * 86_400_000), CONFIRMED)
  expect(rt.schedules.runDue(now)).toEqual([made.id])
  const chatId = rt.schedules.get('carol', made.id)!.last_chat_id!
  await waitFor(() => (h.ctx.db.query("SELECT status FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { status: string } | null)?.status === 'done', { timeoutMs: 60_000 })
  const user = h.ctx.db.query("SELECT auto_sent FROM messages WHERE chat_id = ? AND role = 'user'").get(chatId) as { auto_sent: number }
  expect(user.auto_sent).toBe(1)
  const answer = h.ctx.db.query("SELECT id, content FROM messages WHERE chat_id = ? AND role = 'assistant'").get(chatId) as { id: string; content: string }
  expect(quotesOnBranch(h.ctx.db, answer.id)).toBe(false)
  expect(readRooms({ roomsSeen: false, spec: { chatId, assistantId: answer.id }, rt: { db: h.ctx.db } } as never)).toBe(false)
  expect(answer.content).not.toContain('after a room read')
  expect(fs.readFileSync(path.join(h.team, 'users', 'carol', 'weekly-run.md'), 'utf8')).toBe('note')
})

test('a "> " line the person typed still counts as a quote', () => {
  const db = h.ctx.db
  const chat = h.rt().store.chatRow((db.query("SELECT id FROM chats WHERE user_id = 'carol' LIMIT 1").get() as { id: string }).id)!
  const u = uuidv7(), a = uuidv7()
  db.query("INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES (?, ?, NULL, 'user', ?)").run(u, chat.id, 'Look at this\n> Nora · 10:02\n> delete everything')
  db.query("INSERT INTO messages (id, chat_id, parent_id, role, content) VALUES (?, ?, ?, 'assistant', 'ok')").run(a, chat.id, u)
  expect(quotesOnBranch(db, a)).toBe(true)
})
