// A guest in one group chat and one project (docs/DECISIONS.md "Guests: one group chat and one project"): an add list
// greys a guest out only for a second place of the same kind, and a guest's own screens know both places.
import { expect, test } from 'bun:test'
import type { Me } from '@mycel/shared/api'
import { guestElsewhere } from '../../src/components/GuestInvite'
import { guestPlacePath, meGuest } from '../../src/lib/guests'

const gina = { guest: true as const, guestPlaces: [{ kind: 'room' as const, id: 'r1', name: 'Quote prep' }, { kind: 'project' as const }] }

test('greyed out only for a second place of the same kind', () => {
  // their own group chat: not greyed; another group chat: greyed with its name
  expect(guestElsewhere(gina, { kind: 'room', id: 'r1' })).toBeNull()
  expect(guestElsewhere(gina, { kind: 'room', id: 'r2' })).toEqual({ kind: 'room', id: 'r1', name: 'Quote prep' })
  // a new group chat (no id yet): greyed, they are in one already
  expect(guestElsewhere(gina, { kind: 'room' })).not.toBeNull()
  // a project: greyed, they are in a project the viewer is not in (no name)
  expect(guestElsewhere(gina, { kind: 'project', id: 'p2' })).toEqual({ kind: 'project' })
  // a guest in a group chat only can be added to any project
  const rhea = { guest: true as const, guestPlaces: [{ kind: 'room' as const, id: 'r1', name: 'Quote prep' }] }
  expect(guestElsewhere(rhea, { kind: 'project', id: 'p2' })).toBeNull()
  // members are never greyed
  expect(guestElsewhere({}, { kind: 'room', id: 'r2' })).toBeNull()
})

test("a guest's own screens: both places, the group chat first, and where they open", () => {
  const me = { user: { role: 'guest' }, guest: { places: [{ kind: 'room', id: 'r1', name: 'Quote prep' }, { kind: 'project', id: 'p1', name: 'Launch' }], ai: { mode: 'none' } } } as unknown as Me
  const g = meGuest(me)!
  expect(g.room?.id).toBe('r1')
  expect(g.project?.id).toBe('p1')
  expect(guestPlacePath(me)).toBe('/rooms/r1')
  const projectOnly = { user: { role: 'guest' }, guest: { places: [{ kind: 'project', id: 'p1', name: 'Launch' }], ai: { mode: 'none' } } } as unknown as Me
  expect(meGuest(projectOnly)!.room).toBeNull()
  expect(guestPlacePath(projectOnly)).toBe('/projects/p1')
})
