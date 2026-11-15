// A guest's account switched off or deleted (admin/users.ts, auth/status-messages.ts statusGoneWithAccount): the quiet
// "read the directory again" notice for their status goes only to the windows of people who may see them (the people of
// their place), never to members outside it. A member's account going still tells the team, but not a guest outside
// that member's places. The notice is empty, but its time would show that a guest was there.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { seenBy } from '../../server/src/auth/guests'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(90_000)
let h: Harness
afterEach(async () => { await h?.close() })

/** mia, nora and otto share a group chat with gus (mia's guest); pia is a member outside it. Every window "open": the
 * realtime hub's publishEach is asked for each of them, and what it would send is kept. */
async function setup(name: string) {
  h = await harness(name)
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id, otto.id])
  const gus = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const ownerId = (await owner.call('GET', '/api/me')).user.id as string
  const all = [ownerId, mia.id, nora.id, otto.id, pia.id, gus.id]
  const told: string[] = []
  const rt = h.ctx.services.realtime
  rt.publishEach = (build) => {
    for (const to of all) {
      const ev = build(to)
      if (ev && ev.type === 'notice' && ev.data.code === 'profile_changed') told.push(to)
    }
  }
  return { owner, ownerId, mia, nora, otto, pia, gus, told }
}

test('a guest switched off: only the people of their place are told; a member outside it is not', async () => {
  const { owner, ownerId, mia, nora, otto, pia, gus, told } = await setup('a-guests-status-gone-off')
  expect((await gus.client.try('PUT', '/api/me/status', { emoji: '📅', text: 'away', clear: 'never' })).status).toBe(200)
  told.length = 0
  expect((await owner.try('PATCH', `/api/admin/users/${gus.id}`, { status: 'disabled' })).status).toBe(200)
  expect(told.sort()).toEqual([mia.id, nora.id, otto.id, gus.id].sort())
  expect(told).not.toContain(pia.id)
  expect(told).not.toContain(ownerId)
})

test('a guest deleted: the same, the people of their place only', async () => {
  const { owner, ownerId, mia, nora, pia, gus, told } = await setup('a-guests-status-gone-delete')
  expect((await gus.client.try('PUT', '/api/me/status', { emoji: '📅', text: 'away', clear: 'never' })).status).toBe(200)
  told.length = 0
  expect((await owner.try('DELETE', `/api/admin/users/${gus.id}`)).status).toBe(204)
  expect(told).toEqual(expect.arrayContaining([mia.id, nora.id]))
  expect(told).not.toContain(pia.id)
  expect(told).not.toContain(ownerId)
})

test('a member switched off: the team is told, a guest outside their places is not; one inside is', async () => {
  const { owner, ownerId, mia, nora, pia, gus, told } = await setup('a-guests-status-gone-member')
  expect((await pia.client.try('PUT', '/api/me/status', { emoji: '🌴', text: 'off', clear: 'never' })).status).toBe(200)
  told.length = 0
  expect((await owner.try('PATCH', `/api/admin/users/${pia.id}`, { status: 'disabled' })).status).toBe(200)
  expect(told).toEqual(expect.arrayContaining([ownerId, mia.id, nora.id]))
  expect(told).not.toContain(gus.id)
  // mia shares the guest's place: her going reaches the guest
  expect(seenBy(h.ctx.db, mia.id)(gus.id)).toBe(true)
  expect(seenBy(h.ctx.db, pia.id)(gus.id)).toBe(false)
  expect(seenBy(h.ctx.db, gus.id)(pia.id)).toBe(false)
  expect(seenBy(h.ctx.db, gus.id)(nora.id)).toBe(true)
})

// (a guest switched off is out of their place, and switching them on again is refused: guest_no_place)
test('a member switched on again: the team is told, a guest outside their places is not', async () => {
  const { owner, ownerId, mia, pia, gus, told } = await setup('a-guests-status-gone-on')
  expect((await pia.client.try('PUT', '/api/me/status', { emoji: '🌴', text: 'off', clear: 'never' })).status).toBe(200)
  expect((await owner.try('PATCH', `/api/admin/users/${pia.id}`, { status: 'disabled' })).status).toBe(200)
  told.length = 0
  expect((await owner.try('PATCH', `/api/admin/users/${pia.id}`, { status: 'active' })).status).toBe(200)
  expect(told).toEqual(expect.arrayContaining([ownerId, mia.id]))
  expect(told).not.toContain(gus.id)
})

test('no status: switching an account off tells nobody', async () => {
  const { owner, gus, told } = await setup('a-guests-status-gone-none')
  told.length = 0
  expect((await owner.try('PATCH', `/api/admin/users/${gus.id}`, { status: 'disabled' })).status).toBe(200)
  expect(told).toEqual([])
})
