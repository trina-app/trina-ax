// Guest invites (docs/DECISIONS.md "Guests: only what they were invited to"): who may invite a guest into which one
// place, the inviter checked again at accept, the plan's guest cap (409 plan_limit reason guest_limit), exactly one
// place (409 guest_one_place through invite-accept), and "convert to member". Every guest here is a real account made
// through POST /api/guest-invites and the public accept.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { Plan, setPlanForTests } from '../../server/src/system/limits'
import { GUEST_ONE_PLACE_MSG } from '../../server/src/auth/guests'
import { ApiFail, addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { setPlanForTests(undefined); await h?.close() })

const plan = (o: { maxGuests?: number | null; maxActiveMembers?: number }) =>
  Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, maxActiveMembers: o.maxActiveMembers ?? 100, ...(o.maxGuests !== undefined ? { maxGuests: o.maxGuests } : {}) })

async function setup() {
  h = await harness('a-guests-invites')
  const owner = await withOwner(h)
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const room = await groupChat(mia.client, [nora.id, otto.id])
  const project = await mia.client.call('POST', '/api/projects', { name: 'Quote', scope: 'team' })
  return { owner, ada, mia, nora, otto, room, project }
}
const status = async (p: Promise<unknown>) => { try { await p; return 200 } catch (e) { return (e as ApiFail).status } }
const invite = (c: Client, place: { kind: 'room' | 'project'; id: string }, ai?: unknown) => c.call('POST', '/api/guest-invites', { place, ...(ai ? { ai } : {}) })
const accept = (c: Client, token: string, username: string) => c.call('POST', `/api/invites/${token}/accept`, { username, name: username, password: 'guest river lamp 77' })
const tokenOf = (inv: { url: string }) => inv.url.split('/invite/')[1]!

test('a member invites a guest into a group chat they are in; not into one they are not in, nor a guest', async () => {
  const { owner, ada, mia, room } = await setup()
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const me = await g.client.call('GET', '/api/me')
  expect(me.user.role).toBe('guest')
  // the guest is in the group chat
  expect((await g.client.call('GET', `/api/rooms/${room}`)).id).toBe(room)
  // the owner and an admin who are not in that group chat cannot open a guest into it; nobody can invent a room id
  expect(await status(invite(owner, { kind: 'room', id: room }))).toBe(403)
  expect(await status(invite(ada.client, { kind: 'room', id: room }))).toBe(403)
  expect(await status(invite(mia.client, { kind: 'room', id: 'no-such-room' }))).toBe(403)
  // a guest never invites (the endpoint is off their allow-list)
  expect(await status(invite(g.client, { kind: 'room', id: room }))).toBe(403)
  // the admin list shows the invite with its place, role guest
  const items = (await owner.call('GET', '/api/admin/invites')).items as any[]
  expect(items.find((i) => i.role === 'guest')).toMatchObject({ guestPlace: { kind: 'room', id: room } })
})

test('a project guest: its creator or an admin may invite, another member may not', async () => {
  const { owner, ada, nora, project } = await setup()
  expect(await status(invite(nora.client, { kind: 'project', id: project.id }))).toBe(403)
  const a = await addGuest(h, ada.client, { username: 'gia', place: { kind: 'project', id: project.id } })
  expect((await a.client.call('GET', '/api/me')).user.role).toBe('guest')
  // the guest reads the project's folder (a person rule write on it)
  const tree = await a.client.call('GET', `/api/files/tree?path=${encodeURIComponent(project.folderPath)}`)
  expect(tree).toBeTruthy()
  // the owner too
  expect((await invite(owner, { kind: 'project', id: project.id })).invite.role).toBe('guest')
})

test('the inviter is checked again at accept: a member who left the group chat no longer lets a guest in', async () => {
  const { mia, room } = await setup()
  const inv = await invite(mia.client, { kind: 'room', id: room })
  await mia.client.call('POST', `/api/rooms/${room}/leave`)
  const info = await h.client().call('GET', `/api/invites/${tokenOf(inv)}`)
  expect(info).toMatchObject({ role: 'guest', valid: false })
  expect(await status(accept(h.client(), tokenOf(inv), 'gus'))).toBe(410)
})

test('a project invite stops when the project goes to the trash; AI team needs an admin and a team connection', async () => {
  const { ada, mia, project } = await setup()
  const inv = await invite(mia.client, { kind: 'project', id: project.id })
  await mia.client.call('DELETE', `/api/projects/${project.id}`)
  expect(await status(accept(h.client(), tokenOf(inv), 'gus'))).toBe(410)
  const p2 = await mia.client.call('POST', '/api/projects', { name: 'Second', scope: 'team' })
  // a member cannot give a guest the team's AI; an admin cannot with a connection that does not exist
  expect(await status(invite(mia.client, { kind: 'project', id: p2.id }, { mode: 'team', credentialId: 'x', limitUsd: 5 }))).toBe(403)
  expect(await status(invite(ada.client, { kind: 'project', id: p2.id }, { mode: 'team', credentialId: 'x', limitUsd: 5 }))).toBe(403)
  // their own sign-in is fine from a member
  expect((await invite(mia.client, { kind: 'project', id: p2.id }, { mode: 'own' })).invite.role).toBe('guest')
})

test('the plan caps guests (409 plan_limit, reason guest_limit) at create and at accept; guests take no seat', async () => {
  const { owner, mia, room } = await setup()
  const seatsBefore = (await owner.call('GET', '/api/admin/users')).items.length
  setPlanForTests(plan({ maxGuests: 1, maxActiveMembers: seatsBefore }))
  // two links while one guest place is free; the second accept hits the cap
  const i1 = await invite(mia.client, { kind: 'room', id: room })
  const i2 = await invite(mia.client, { kind: 'room', id: room })
  // every seat is taken, yet a guest joins: guests take no seat
  await accept(h.client(), tokenOf(i1), 'gus')
  let err: ApiFail | null = null
  try { await accept(h.client(), tokenOf(i2), 'gia') } catch (e) { err = e as ApiFail }
  expect(err?.status).toBe(409)
  expect(err?.body.error).toMatchObject({ code: 'plan_limit', params: { reason: 'guest_limit', limit: 1 } })
  // and a new link is refused the same way
  try { await invite(mia.client, { kind: 'room', id: room }); err = null } catch (e) { err = e as ApiFail }
  expect(err?.body.error.params.reason).toBe('guest_limit')
  // the invite page says it is full instead of the form
  expect((await h.client().call('GET', `/api/invites/${tokenOf(i2)}`)).full).toBe(true)
  // a plan file without maxGuests (until the control plane writes it): 3; no plan (self-hosted): no cap
  setPlanForTests(plan({ maxActiveMembers: 100 }))
  await accept(h.client(), tokenOf(await invite(mia.client, { kind: 'room', id: room })), 'gib')
  setPlanForTests(null)
  await accept(h.client(), tokenOf(await invite(mia.client, { kind: 'room', id: room })), 'gil')
  await accept(h.client(), tokenOf(await invite(mia.client, { kind: 'room', id: room })), 'gim')
})

test('one place: an account never takes a second invite; the reason says to make them a team member', async () => {
  const { owner, mia, room } = await setup()
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  // a second guest invite cannot be accepted with the same account (the username is taken): one account, one place
  const inv2 = await invite(mia.client, { kind: 'room', id: room })
  expect(await status(accept(h.client(), tokenOf(inv2), 'gus'))).toBe(409)
  // an admin cannot give a guest a group (a second place) nor change their role
  const r = await owner.try('PATCH', `/api/admin/users/${g.id}`, { groupIds: [] })
  expect(r.status).toBe(403)
  expect(r.body.error.params.reason).toBe('guest_one_place')
  expect(r.body.error.message).toBe(GUEST_ONE_PLACE_MSG.ko)
  expect((await owner.try('PATCH', `/api/admin/users/${g.id}`, { role: 'member' })).status).toBe(403)
  // the member invite form cannot make a guest without a place, nor give a guest groups
  expect((await owner.try('POST', '/api/admin/invites', { role: 'guest' })).status).toBe(400)
  // an existing member is never made a guest: the members screen's roles do not include it
  expect((await owner.try('PATCH', `/api/admin/users/${(await addMember(h, owner, { username: 'max' })).id}`, { role: 'guest' })).status).toBe(400)
  // the owner's handover never goes to a guest
  expect((await owner.try('POST', '/api/admin/transfer-ownership', { userId: g.id, password: 'owner horse battery 42' })).status).toBeGreaterThanOrEqual(400)
  expect(GUEST_ONE_PLACE_MSG.en).toBe('A guest can be in one room or project only. To add them to more, make them a team member.')
  expect(GUEST_ONE_PLACE_MSG.ko).toBe('게스트는 방이나 프로젝트 한 곳에만 들어갈 수 있어요. 여러 곳에 넣으려면 팀원으로 초대해 주세요.')
})

test('convert to member: takes a seat (409 seat_limit when none is free), keeps the place, role member', async () => {
  const { owner, mia, room } = await setup()
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const seats = (await owner.call('GET', '/api/admin/users')).items.filter((u: any) => u.role !== 'guest').length
  setPlanForTests(plan({ maxActiveMembers: seats, maxGuests: 10 }))
  const full = await owner.try('POST', `/api/admin/users/${g.id}/convert-guest`)
  expect(full.status).toBe(409)
  expect(full.body.error.params.reason).toBe('seat_limit')
  // a member cannot convert
  expect((await mia.client.try('POST', `/api/admin/users/${g.id}/convert-guest`)).status).toBe(403)
  setPlanForTests(plan({ maxActiveMembers: seats + 1, maxGuests: 10 }))
  const u = await owner.call('POST', `/api/admin/users/${g.id}/convert-guest`)
  expect(u.role).toBe('member')
  expect((await g.client.call('GET', '/api/me')).user.role).toBe('member')
  expect((await g.client.call('GET', `/api/rooms/${room}`)).id).toBe(room)
  // a member now: the endpoints a member uses open
  expect((await g.client.try('GET', '/api/skills')).status).toBe(200)
  // converting twice: not a guest
  expect((await owner.try('POST', `/api/admin/users/${g.id}/convert-guest`)).status).toBe(409)
})
