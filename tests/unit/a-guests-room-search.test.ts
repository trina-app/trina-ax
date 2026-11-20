// Guests and ⌘K message search with from:/in: (QA TC-5365, docs/decisions/20261119-message-search-slack-level.md): a
// filter never widens what anyone sees. A guest's from: names only the people of their place; a member's from: never
// names a guest outside theirs; in: a room the guest is not in reads as a name nobody has. Real guests (invite + accept).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })
const cm = () => 'cm-' + crypto.randomUUID()
const send = (c: Client, room: string, body: string) => c.call('POST', `/api/rooms/${room}/messages`, { body, clientMessageId: cm(), mentions: [], fileIds: [] })
const search = (c: Client, q: string) => c.call('GET', `/api/room-messages?q=${encodeURIComponent(q)}&sort=relevant`)
const files = (c: Client, q: string) => c.call('GET', `/api/room-files?q=${encodeURIComponent(q)}`)

test('a guest: from: and in: reach only their own chat and its people; others read as nobody', async () => {
  h = await harness('a-guests-room-search')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id], 'Client Room')
  const other = await groupChat(mia.client, [pia.id], 'Inside Room')
  const gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  await send(mia.client, room, 'GSEARCH-CANARY delivery date for the client')
  await send(mia.client, other, 'GSEARCH-CANARY internal pricing')
  await send(pia.client, other, 'GSEARCH-CANARY pia inside')

  // the guest: mia (in their chat) yes, only there; pia (not in their place) is nobody, as a made-up name
  const fromMia = await search(gus.client, 'from:mia GSEARCH-CANARY')
  expect(fromMia.items.map((i: { snippet: string }) => i.snippet)).toEqual(['GSEARCH-CANARY delivery date for the client'])
  const fromPia = await search(gus.client, 'from:pia GSEARCH-CANARY')
  const fromNobody = await search(gus.client, 'from:zzzz GSEARCH-CANARY')
  expect(fromPia).toEqual({ items: [], rooms: [], nextCursor: null, filters: { from: [], in: [], missing: ['from:pia'] } })
  expect(fromNobody.filters.missing).toEqual(['from:zzzz'])
  // a short part of many names lists only the people of their place
  const some = await search(gus.client, 'from:a GSEARCH-CANARY')
  for (const p of some.filters.from as { id: string }[]) expect([mia.id, nora.id, gus.id]).toContain(p.id)
  expect(JSON.stringify(some)).not.toContain(pia.id)
  // in: a room they are not in: nobody's, nothing found, its name not echoed as a room
  const inside = await search(gus.client, 'in:"Inside Room"')
  expect(inside).toEqual({ items: [], rooms: [], nextCursor: null, filters: { from: [], in: [], missing: ['in:Inside Room'] } })
  expect(JSON.stringify(await search(gus.client, 'internal pricing'))).not.toContain('internal pricing')
  expect(JSON.stringify(await search(gus.client, 'internl pricing'))).not.toContain('internal pricing')
  expect((await files(gus.client, 'in:"Inside Room"')).items).toEqual([])

  // a member outside the guest's place: the guest is nobody to them
  const pfrom = await search(pia.client, 'from:gus')
  expect(pfrom.filters.missing).toEqual(['from:gus'])
  // mia (who shares the chat with gus) can name them
  await send(gus.client, room, 'GSEARCH-CANARY guest says hi')
  expect((await search(mia.client, 'from:gus GSEARCH-CANARY')).items.map((i: { snippet: string }) => i.snippet)).toEqual(['GSEARCH-CANARY guest says hi'])
})
