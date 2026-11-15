// Often-asked questions and guests (docs/DECISIONS.md "Guests: only what they were invited to"): a guest's questions
// never surface to the team, and a guest never sees the team's frequent questions. Real guest through invite + accept.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { newId } from '../../server/src/db'
import { ChatStore } from '../../server/src/chat/store'
import { setSetting, updateTeamSettings } from '../../server/src/admin/settings'
import { buildSnapshot, oftenAskedFor, readQuestions, SINCE_KEY } from '../../server/src/chat/often-asked'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('a guest\'s questions are not read for the team; a guest gets no list and is no audience', async () => {
  h = await harness('a-guests-often-asked')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const room = await groupChat(mia.client, [nora.id, otto.id])
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const db = h.ctx.db, store = new ChatStore(db)
  const NOW = new Date(Date.now() + 60_000)
  setSetting(db, SINCE_KEY, new Date(Date.now() - 86400_000).toISOString())
  updateTeamSettings(db, { oftenAsked: true })
  const ask = (user: string, content: string) => {
    const id = newId(), at = new Date().toISOString()
    db.query('INSERT INTO chats (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, user, at, at)
    const m = store.insertMessage({ chatId: id, content, parentId: null, authorId: user, role: 'user', status: 'done' })
    db.query('UPDATE chats SET active_leaf_id = ? WHERE id = ?').run(m, id)
    db.query("INSERT INTO turns (id, chat_id, user_id, engine, status, user_message_id, client_kind) VALUES (?, ?, ?, 'claude-code', 'done', ?, 'web')").run(newId(), id, user, m)
  }
  ask(mia.id, 'How do I book the meeting room for the review?')
  ask(g.id, 'What is the secret price list for the client?')
  const texts = readQuestions(db, NOW).map((q) => q.content)
  // the member's question counts, the guest's never does
  expect(texts.some((t) => t.includes('meeting room'))).toBe(true)
  expect(texts.some((t) => t.includes('secret price'))).toBe(false)
  // the team audience holds members only
  const team = buildSnapshot(db, h.ctx.files.rules(), { now: NOW, random: () => 0.5 }).audiences.find((a) => a.key === 'team')!
  expect(team.members.has(mia.id)).toBe(true)
  expect(team.members.has(g.id)).toBe(false)
  // a guest gets no list, through the function and through the API (off their allow-list)
  expect(oftenAskedFor(db, g.id, NOW).items).toEqual([])
  expect((await g.client.try('GET', '/api/questions/often-asked')).status).toBe(403)
  expect((await mia.client.try('GET', '/api/questions/often-asked')).status).toBe(200)
})
