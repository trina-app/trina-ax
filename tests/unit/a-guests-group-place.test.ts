// QA TC-4737: Admin > Members > Guests says "Group chat" for a guest's unnamed group chat (the server sends its name as '').
// The members are NOT sent: admins do not learn who talks to whom in group chats (docs/DECISIONS.md).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

type Place = { kind: string; id: string; name: string; out?: string }
const placesOf = async (c: { call: (m: string, p: string) => Promise<any> }, id: string): Promise<Place[]> =>
  ((await c.call('GET', '/api/admin/users')).items as { id: string; guest?: { places: Place[] } }[]).find((u) => u.id === id)!.guest!.places

test('an unnamed group chat: the guest row has an empty name and no member data at all', async () => {
  h = await harness('a-guests-group-place')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const rita = await addMember(h, owner, { username: 'rita' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const unnamed = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [rita.id, otto.id] })).id
  const g1 = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: unnamed } })
  const places = await placesOf(owner, g1.id)
  expect(places).toHaveLength(1)
  expect(places[0]).toEqual({ kind: 'room', id: unnamed, name: '' })
  const raw = JSON.stringify(places)
  for (const n of [mia, rita, otto]) expect(raw).not.toContain(n.id)
})
