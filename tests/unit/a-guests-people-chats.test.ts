// Chats shared with people and groups (dev's people-shared chats) and guests (docs/DECISIONS.md "Guests: only what
// they were invited to"): such a chat is no place of a guest's: a guest is never shared one (the same answer as an
// unknown person), and never reads one; members share with each other as before. Real guest.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'
import { peopleAudience } from '../../server/src/chat/chat-audience'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('a member cannot share a chat with a guest; a guest named in the table still reads nothing; members share as before', async () => {
  h = await harness('a-guests-people-chats')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const room = await groupChat(mia.client, [nora.id, otto.id])
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const chat = await mia.client.call('POST', '/api/chats', {})
  const put = (subjects: unknown[]) => mia.client.try('PUT', `/api/chats/${chat.id}/audience`, { subjects })
  const refused = await put([{ subjectType: 'user', subjectId: g.id }])
  expect(refused.status).toBe(400)
  expect(refused.body.error.params.reason).toBe('unknown_subject')
  const ok = await put([{ subjectType: 'user', subjectId: nora.id }])
  expect(ok.status).toBe(200)
  expect((await nora.client.try('GET', `/api/chats/${chat.id}`)).status).toBe(200)
  // a row naming the guest written past the check (an older build, a restored backup): still no reader
  h.ctx.db.query("INSERT INTO chat_audience (chat_id, subject_type, subject_id, added_at) VALUES (?, 'user', ?, ?)").run(chat.id, g.id, new Date().toISOString())
  expect(peopleAudience(h.ctx.db, { id: chat.id, user_id: mia.id })).not.toContain(g.id)
  expect((await g.client.try('GET', `/api/chats/${chat.id}`)).status).toBe(404)
  expect(((await g.client.call('GET', '/api/chats')).items as any[]).some((c) => c.id === chat.id)).toBe(false)
})
