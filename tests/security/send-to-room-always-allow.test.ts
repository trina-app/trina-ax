// "대화에 보내기" under the person's own "Always allow" for room posts (chat/answer-share.ts shareAnswerToRoom;
// docs/decisions/20261120-send-to-room-who-can-see.md). The choice is final (Rule A), and it is only ever the sender's:
//   - another person's "Always allow" never skips this person's ask;
//   - the team's switch off: asked as before;
//   - the hard stops stay: a confidential conversation is never sent;
//   - "Always allow" for posts with their files sends copies only of files the person may share: a teammate's file
//     stays a link (the people who could not open it still cannot).
// Answers are written straight into the database (no engine), the fixture team: alice and erin in marketing, bob in
// finance.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { API, uuidv7, type Room } from '@mycel/shared/api'
import { startHarness, type Harness } from '../lib/b-harness'
import { roomsOf } from '../../server/src/rooms/service'
import { updateTeamSettings } from '../../server/src/admin/settings'

setDefaultTimeout(60_000)
const cm = () => 'cm-' + crypto.randomUUID()
let h: Harness
let room: Room
let clock = Date.now()

beforeAll(async () => {
  h = await startHarness({ name: 'sec-send-to-room-always' })
  roomsOf(h.ctx).clock = () => (clock += 10_000)
  // alice and bob: bob (finance) cannot open the marketing folder
  room = await h.api('alice').call(API.createRoom, { body: { kind: 'group', userIds: ['bob'], name: 'pair' } })
  const put = (rel: string, by: string) => {
    const abs = path.join(h.ctx.files.fx.root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, `${rel} by ${by}`)
    h.ctx.db.query("INSERT INTO file_events (user_id, path, action, size) VALUES (?, ?, 'create', 1)").run(by, rel)
  }
  put('groups/marketing/alice-plan.md', 'alice')
  put('groups/marketing/erin-plan.md', 'erin')
})
afterAll(async () => { await h?.close() })

/** an answer of `user`'s own chat that read `read` (its source list), linking what `content` links */
function answer(user: string, content: string, read: string[]) {
  const db = h.ctx.db
  const chatId = uuidv7(), askId = uuidv7(), answerId = uuidv7()
  db.query('INSERT INTO chats (id, user_id) VALUES (?, ?)').run(chatId, user)
  db.query("INSERT INTO messages (id, chat_id, role, content, status) VALUES (?, ?, 'user', '정리해 줘', 'done')").run(askId, chatId)
  db.query("INSERT INTO messages (id, chat_id, parent_id, role, content, status) VALUES (?, ?, ?, 'assistant', ?, 'done')").run(answerId, chatId, askId, content)
  db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(answerId, chatId)
  read.forEach((p, i) => db.query("INSERT INTO message_sources (message_id, ord, path, sha256, locs, via, by_main, by_subagent) VALUES (?, ?, ?, NULL, '[]', 'read', 1, 0)").run(answerId, i, p))
  return { chatId, answerId }
}
async function share(user: string, a: { chatId: string; answerId: string }) {
  const r = await h.req(user, `/api/chats/${a.chatId}/messages/${a.answerId}/share-to-room`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room.id, clientMessageId: cm() }) })
  return { status: r.status, json: await r.json() as any }
}
const always = (user: string, kind: string) => h.ctx.db.query('INSERT OR IGNORE INTO card_always_allow (user_id, kind, created_at) VALUES (?, ?, ?)').run(user, kind, new Date().toISOString())
const clear = () => h.ctx.db.query('DELETE FROM card_always_allow').run()
const link = (p: string) => `[${p.split('/').pop()}](/files/view?path=${encodeURI(p)})`

test("another person's Always allow never skips mine; mine sends", async () => {
  clear()
  always('bob', 'post_to_room')
  const a = answer('alice', '요약', ['groups/marketing/alice-plan.md'])
  expect((await share('alice', a)).json.status).toBe('confirm')
  always('alice', 'post_to_room')
  expect((await share('alice', a)).json.status).toBe('sent')
  clear()
})

test("the team's switch off: asked as before, the rows kept", async () => {
  clear()
  always('alice', 'post_to_room')
  updateTeamSettings(h.ctx.db, { roomAlwaysAllow: false })
  try {
    const a = answer('alice', '요약', ['groups/marketing/alice-plan.md'])
    expect((await share('alice', a)).json.status).toBe('confirm')
  } finally { updateTeamSettings(h.ctx.db, { roomAlwaysAllow: true }); clear() }
})

test('a confidential conversation is never sent, Always allow or not', async () => {
  clear()
  always('alice', 'post_files')
  const a = answer('alice', '기밀', ['groups/marketing/alice-plan.md'])
  h.ctx.db.query('INSERT INTO safe_ops_chats (chat_id, material) VALUES (?, 1)').run(a.chatId)
  const r = await share('alice', a)
  expect(r.status).toBe(409)
  expect(r.json.error.params.reason).toBe('confidential')
  clear()
})

test("Always allow with files: my own file goes as a copy; a teammate's file stays a link bob still cannot open", async () => {
  clear()
  always('alice', 'post_files')
  const a = answer('alice', `${link('groups/marketing/alice-plan.md')} ${link('groups/marketing/erin-plan.md')}`, [])
  const r = await share('alice', a)
  expect(r.json.status).toBe('sent')
  const copies = h.ctx.db.query('SELECT name FROM room_files WHERE message_id = ?').all(r.json.message.id) as { name: string }[]
  expect(copies.map((c) => c.name)).toEqual(['alice-plan.md'])
  clear()
})
