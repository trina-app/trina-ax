// What the invite and admin screens read about guests (docs/DECISIONS.md "Guest invites: the admin and invite screens,
// simpler"): the people list names a guest's one place (only to someone who shares it), the invite page carries the
// name the inviter typed, a project guest link names its project (never a room), and GET /api/guest-invites/limit says
// whether the plan has room for one more guest (seats and the plan page for the owner and admins only; a guest: 403).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { Plan, setPlanForTests } from '../../server/src/system/limits'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat, teamProject } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { setPlanForTests(undefined); await h?.close() })

const plan = (o: { maxGuests?: number; maxActiveMembers: number; account?: string }) =>
  Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, maxActiveMembers: o.maxActiveMembers, ...(o.maxGuests !== undefined ? { maxGuests: o.maxGuests } : {}), ...(o.account ? { links: { account: o.account, status: 'https://status.example.com', support: 'help@example.com' } } : {}) })

test("the people list names a guest's place to the people who share it; nobody else sees the guest", async () => {
  h = await harness('a-guests-ux-people')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id, pia.id], 'Quote prep')
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const seen = ((await mia.client.call('GET', '/api/people')).people as { id: string; guest?: boolean; guestPlace?: unknown }[]).find((p) => p.id === g.id)
  expect(seen?.guest).toBe(true)
  expect(seen?.guestPlace).toEqual({ kind: 'room', id: room, name: 'Quote prep' })
  // the owner is not in that room: no guest at all, so no place name either
  expect(((await owner.call('GET', '/api/people')).people as { id: string }[]).some((p) => p.id === g.id)).toBe(false)
  // members carry no place
  expect(((await mia.client.call('GET', '/api/people')).people as { id: string; guestPlace?: unknown }[]).find((p) => p.id === nora.id)?.guestPlace).toBeUndefined()
})

test('the invite page carries the typed name; a project link names its project, a room link does not name the room', async () => {
  h = await harness('a-guests-ux-invite')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id, pia.id], 'Secret room')
  const p = await teamProject(owner, 'Quote prep')
  const named = await owner.call('POST', '/api/guest-invites', { place: { kind: 'project', id: p.id }, name: 'Kim from Acme' })
  const token = String(named.url).split('/invite/')[1]
  const info = await h.client().call('GET', `/api/invites/${token}`)
  expect(info.guestName).toBe('Kim from Acme')
  expect(info.guestPlace).toEqual({ kind: 'project', name: 'Quote prep' })
  const plain = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room } })
  expect('guestName' in (await h.client().call('GET', `/api/invites/${String(plain.url).split('/invite/')[1]}`))).toBe(false)
  const items = (await owner.call('GET', '/api/admin/invites')).items as { id: string; guestPlace?: { name?: string } }[]
  expect(items.find((i) => i.id === named.invite.id)?.guestPlace?.name).toBe('Quote prep')
  // the owner is not in the room: its name stays out of the list
  expect(items.find((i) => i.id === plain.invite.id)?.guestPlace).toEqual({ kind: 'room', id: room })
  // a used link no longer says the name
  await h.client().call('POST', `/api/invites/${token}/accept`, { username: 'kim', name: 'Kim', password: 'guest river lamp 77' })
  expect('guestName' in (await h.client().call('GET', `/api/invites/${token}`))).toBe(false)
})

test('the guest limit: full or not for anyone who may invite; seats and the plan page only for the owner and admins', async () => {
  h = await harness('a-guests-ux-limit')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id, pia.id])
  // no plan (self-hosted): no cap
  expect(await mia.client.call('GET', '/api/guest-invites/limit')).toEqual({ full: false, limit: null })
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const seats = (await owner.call('GET', '/api/admin/users')).items.filter((u: { role: string }) => u.role !== 'guest').length
  setPlanForTests(plan({ maxGuests: 1, maxActiveMembers: seats, account: 'https://plans.example.com/acme' }))
  expect(await mia.client.call('GET', '/api/guest-invites/limit')).toEqual({ full: true, limit: 1 })
  expect(await owner.call('GET', '/api/guest-invites/limit')).toEqual({ full: true, limit: 1, seatsFull: true, manageUrl: 'https://plans.example.com/acme' })
  setPlanForTests(plan({ maxGuests: 2, maxActiveMembers: seats + 1 }))
  expect(await owner.call('GET', '/api/guest-invites/limit')).toEqual({ full: false, limit: 2, seatsFull: false })
  // a guest never invites: the endpoint is off their list
  expect((await g.client.try('GET', '/api/guest-invites/limit')).status).toBe(403)
})
