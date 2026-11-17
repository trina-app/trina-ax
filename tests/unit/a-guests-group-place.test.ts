// QA TC-4737: Admin > Members > Guests names a guest's unnamed group chat. The server sends the room's name as '' (a group
// DM has none) and now also the other members, so the row reads "Group chat · Rita, Otto" instead of leaving the place out.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest } from './guest-lib'

setDefaultTimeout(120_000)
let h: Harness
afterEach(async () => { await h?.close() })

type Place = { kind: string; id: string; name: string; out?: string; peers?: { id: string; name: string }[]; memberCount?: number }
const placesOf = async (c: { call: (m: string, p: string) => Promise<any> }, id: string): Promise<Place[]> =>
  ((await c.call('GET', '/api/admin/users')).items as { id: string; guest?: { places: Place[] } }[]).find((u) => u.id === id)!.guest!.places

test('an unnamed group chat: the guest row carries its other members; a named one carries none; the guest is left out', async () => {
  h = await harness('a-guests-group-place')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const rita = await addMember(h, owner, { username: 'rita' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const unnamed = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [rita.id, otto.id] })).id
  const named = (await mia.client.call('POST', '/api/rooms', { kind: 'group', userIds: [rita.id], name: 'Quote prep' })).id
  const g1 = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: unnamed } })
  const g2 = await addGuest(h, mia.client, { username: 'gia', place: { kind: 'room', id: named } })

  const [p1] = await placesOf(owner, g1.id)
  expect(p1!.name).toBe('')
  expect(p1!.peers!.map((p) => p.id).sort()).toEqual([mia.id, otto.id, rita.id].sort())
  expect(p1!.peers!.some((p) => p.id === g1.id)).toBe(false)
  expect(p1!.memberCount).toBe(4)

  const [p2] = await placesOf(owner, g2.id)
  expect(p2!.name).toBe('Quote prep')
  expect(p2!.peers).toBeUndefined()
})
