// The Activity line when a guest accepts their invite (notifications/service.ts team.joined): they joined their one
// room or project as a guest, not the team, so the notice names that place ("X joined 'Quote prep' as a guest").
// A member who joins keeps "X joined the team" (no guestPlace; web/test/unit/guest-leftovers.test.tsx has the words).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat, teamProject } from './guest-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })

const joinedOf = async (c: Client, id: string) => ((await c.call('GET', '/api/notifications')).items as { code: string; sourceId: string; joined?: unknown }[]).find((x) => x.code === 'team.joined' && x.sourceId === id)

test('a guest in a group chat: the inviter and the owner read the chat they joined as a guest', async () => {
  h = await harness('a-guests-joined-room')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const room = await groupChat(mia.client, [nora.id, otto.id], 'Quote prep')
  const gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  for (const c of [mia.client, owner]) expect(await joinedOf(c, gus.id)).toMatchObject({ joined: { name: 'GUS', guestPlace: { kind: 'room', name: 'Quote prep' } } })
})

test('a guest in a project: the project by name', async () => {
  h = await harness('a-guests-joined-project')
  const owner = await withOwner(h)
  const p = await teamProject(owner, 'Acme bid')
  const gus = await addGuest(h, owner, { username: 'gus', place: { kind: 'project', id: p.id } })
  expect(await joinedOf(owner, gus.id)).toMatchObject({ joined: { name: 'GUS', guestPlace: { kind: 'project', name: 'Acme bid' } } })
})
