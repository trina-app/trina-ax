// Chats shared with people and groups (dev's people-shared chats) and guests (docs/DECISIONS.md "Guests: only what
// they were invited to"): such a chat is no place of a guest's: a guest is never shared one (the same answer as an
// unknown person), and never reads one; members share with each other as before. Real guest.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'
import { peopleAudience } from '../../server/src/chat/chat-audience'
import { tr } from '../../server/src/chat/i18n'

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
  const put = (subjects: unknown[], confirmKey?: string) => mia.client.try('PUT', `/api/chats/${chat.id}/audience`, { subjects, ...(confirmKey ? { confirmKey } : {}) })
  const preview = (subjects: unknown[]) => mia.client.try('POST', `/api/chats/${chat.id}/audience/preview`, { subjects })
  const guest = [{ subjectType: 'user', subjectId: g.id }]
  const noraOnly = [{ subjectType: 'user', subjectId: nora.id }]
  // the guest is refused before any key is looked at: by the save, by the preview, and with a key of another list
  const refused = await put(guest)
  expect(refused.status).toBe(400)
  expect(refused.body.error.params.reason).toBe('unknown_subject')
  // said plainly: a guest can't join a shared chat, never "no longer on the team" (QA TC-6961; the harness speaks Korean)
  expect(refused.body.error.message).toBe(tr('chatShareGuest', 'ko'))
  expect(refused.body.error.message).not.toBe(tr('chatShareUnknownPerson', 'ko'))
  expect(tr('chatShareGuest', 'en')).toBe("Guests can't be added to a shared chat. A guest works only in the project or conversation they were invited to.")
  const refusedPreview = await preview(guest)
  expect(refusedPreview.status).toBe(400)
  expect(refusedPreview.body.error.params.reason).toBe('unknown_subject')
  const noraKey = (await preview(noraOnly)).body.previewKey as string
  expect(noraKey).toBeTruthy()
  const keyed = await put(guest, noraKey)
  expect(keyed.status).toBe(400)
  expect(keyed.body.error.params.reason).toBe('unknown_subject')
  // members share as before, the way the app does it (docs/DECISIONS.md "Share in one press"): without the check's
  // key nothing is saved; the preview's key saves it
  const unchecked = await put(noraOnly)
  expect(unchecked.status).toBe(200)
  expect(unchecked.body).toMatchObject({ status: 'confirm', reason: 'unchecked' })
  expect((await nora.client.try('GET', `/api/chats/${chat.id}`)).status).toBe(404)
  const ok = await put(noraOnly, noraKey)
  expect(ok.status).toBe(200)
  expect(ok.body.status).toBe('saved')
  expect((await nora.client.try('GET', `/api/chats/${chat.id}`)).status).toBe(200)
  // a row naming the guest written past the check (an older build, a restored backup): still no reader
  h.ctx.db.query("INSERT INTO chat_audience (chat_id, subject_type, subject_id, added_at) VALUES (?, 'user', ?, ?)").run(chat.id, g.id, new Date().toISOString())
  expect(peopleAudience(h.ctx.db, { id: chat.id, user_id: mia.id })).not.toContain(g.id)
  expect((await g.client.try('GET', `/api/chats/${chat.id}`)).status).toBe(404)
  expect(((await g.client.call('GET', '/api/chats')).items as any[]).some((c) => c.id === chat.id)).toBe(false)
})
