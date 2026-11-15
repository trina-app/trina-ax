// Speech to text is a team cost outside a guest's own limit (docs/DECISIONS.md "Guests: only what they were invited
// to"): a guest's upload session for transcription is refused (uploads/sessions.ts checkTarget), POST /api/transcribe
// is off their endpoint list, and their AI's reads never turn video sound into text (files/service.ts mediaTranscript).
// A member's transcription upload is not refused for being a member. Real guest.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })
const sha = 'a'.repeat(64)

test('a guest\'s upload for transcription is refused (403); a member\'s is not; a guest\'s plain upload into their own folder works', async () => {
  h = await harness('a-guests-speech')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const room = await groupChat(owner, [mia.id, nora.id])
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const body = { target: { kind: 'transcribe', name: 'voice.webm' }, size: 10, sha256: sha }
  const guest = await g.client.try('POST', '/api/upload-sessions', body)
  expect(guest.status).toBe(403)
  const member = await mia.client.try('POST', '/api/upload-sessions', body)
  expect(member.status).not.toBe(403)
  expect((await g.client.try('POST', '/api/transcribe', {})).status).toBe(403)
  // the guest's own folder is theirs (an upload session into it starts)
  const own = await g.client.try('POST', '/api/upload-sessions', { target: { kind: 'path', path: `users/${g.id}/notes.txt` }, size: 10, sha256: sha })
  expect(own.status).toBe(201)
})
