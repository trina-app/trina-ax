// Guest walkthrough fixes (docs/DECISIONS.md "Guest walkthrough A"): open guest links hold a guest place (M4), a full
// guest link keeps who sent it (M3), a guest never renames their room (M2), Admin's invite list names a room (S8), and a
// guest's ended sign-in says whether they left or were taken out, with the team's name (S5, S6). Real guests.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { Plan, setPlanForTests } from '../../server/src/system/limits'
import { openGuestLinks } from '../../server/src/auth/guest-invites'
import { authOf } from '../../server/src/auth/service'
import { ApiFail, addMember, harness, withOwner, type Client, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { setPlanForTests(undefined); await h?.close() })

const plan = (maxGuests: number) =>
  Plan.parse({ format: 1, plan: 'team', maxConcurrency: 3, memoryMiB: 4096, cpuCores: 2, diskGiB: 50, maxActiveMembers: 100, maxGuests })
const invite = (c: Client, place: { kind: 'room' | 'project'; id: string }) => c.call('POST', '/api/guest-invites', { place })
const tokenOf = (inv: { url: string }) => String(inv.url).split('/invite/')[1]!
const refusal = async (p: Promise<unknown>): Promise<ApiFail | null> => { try { await p; return null } catch (e) { return e as ApiFail } }

async function setup() {
  h = await harness('a-guests-walkthrough')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id, pia.id], 'Quote prep')
  return { owner, mia, nora, room }
}

test('M4: open guest links count toward the cap, so the link that does not fit is refused when it is made', async () => {
  const { owner, mia, nora, room } = await setup()
  setPlanForTests(plan(2))
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  // one place left: one link takes it
  const open = await invite(mia.client, { kind: 'room', id: room })
  expect(openGuestLinks(h.ctx.db, authOf(h.ctx).now())).toBe(1)
  // the dialog's read says full before the form, and how many links hold a place
  expect(await owner.call('GET', '/api/guest-invites/limit')).toMatchObject({ full: true, limit: 2, pending: 1 })
  // a member reads only that it is full (how many links wait is the owner's and admins', as the guests count is)
  const forMember = await mia.client.call('GET', '/api/guest-invites/limit')
  expect(forMember).toMatchObject({ full: true, limit: 2 })
  expect(forMember.pending).toBeUndefined()
  // the next link: refused at Create link, with the links in the words and the count in params
  const err = await refusal(invite(mia.client, { kind: 'room', id: room }))
  expect(err?.status).toBe(409)
  expect(err?.body.error).toMatchObject({ code: 'plan_limit', params: { reason: 'guest_limit', limit: 2, pending: 1 } })
  expect(err?.body.error.message).toContain('아직 쓰지 않은 초대 링크')
  // Admin › Invite to team (role guest) is the same rule
  const project = await mia.client.call('POST', '/api/projects', { name: 'Plan', scope: 'team' })
  const viaAdmin = await owner.try('POST', '/api/admin/invites', { role: 'guest', guestPlace: { kind: 'project', id: project.id } })
  expect(viaAdmin.status).toBe(409)
  expect(viaAdmin.body.error.params).toMatchObject({ reason: 'guest_limit', pending: 1 })
  // the open link itself still works: its guest takes the place it held
  const c = h.client({ ip: '10.0.0.11' })
  await c.call('POST', `/api/invites/${tokenOf(open)}/accept`, { username: 'gia', name: 'GIA', password: 'guest river lamp 77' })
  expect(openGuestLinks(h.ctx.db, authOf(h.ctx).now())).toBe(0)
  expect((await owner.call('GET', '/api/guest-invites/limit')).pending).toBeUndefined()
  // a guest switched off frees their place; a cancelled link frees its hold
  await owner.call('PATCH', `/api/admin/users/${g.id}`, { status: 'disabled' })
  const again = await invite(mia.client, { kind: 'room', id: room })
  expect(await owner.call('GET', '/api/guest-invites/limit')).toMatchObject({ full: true, pending: 1 })
  await owner.call('DELETE', `/api/admin/invites/${again.invite.id}`)
  expect((await mia.client.call('GET', '/api/guest-invites/limit')).full).toBe(false)
  // a link that stopped working by itself (its maker left the room) holds nothing
  const held = await invite(nora.client, { kind: 'room', id: room })
  expect(openGuestLinks(h.ctx.db, authOf(h.ctx).now())).toBe(1)
  await nora.client.call('POST', `/api/rooms/${room}/leave`)
  expect(openGuestLinks(h.ctx.db, authOf(h.ctx).now())).toBe(0)
  expect(held.invite.id).toBeTruthy()
  // no plan (a self-hosted server): no cap, nothing counted
  setPlanForTests(null)
  expect((await mia.client.call('GET', '/api/guest-invites/limit')).full).toBe(false)
})

test('M3: a guest link opened while the guests are full keeps who sent it; the accept says it is full', async () => {
  const { mia, room } = await setup()
  // two links made before the plan's cap came down to one
  const i1 = await invite(mia.client, { kind: 'room', id: room })
  const i2 = await invite(mia.client, { kind: 'room', id: room })
  setPlanForTests(plan(1))
  await h.client({ ip: '10.0.0.12' }).call('POST', `/api/invites/${tokenOf(i1)}/accept`, { username: 'gus', name: 'GUS', password: 'guest river lamp 77' })
  const info = await h.client().call('GET', `/api/invites/${tokenOf(i2)}`)
  expect(info).toMatchObject({ valid: true, full: true, role: 'guest', inviterName: 'MIA' })
  const err = await refusal(h.client({ ip: '10.0.0.13' }).call('POST', `/api/invites/${tokenOf(i2)}/accept`, { username: 'gia', name: 'GIA', password: 'guest river lamp 77' }))
  expect(err?.body.error).toMatchObject({ code: 'plan_limit', params: { reason: 'guest_limit' } })
})

test('M2: a guest never gets the rename (Room.canRename false, PATCH name 403); its members still do', async () => {
  const { mia, room } = await setup()
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  expect((await g.client.call('GET', `/api/rooms/${room}`)).canRename).toBe(false)
  expect((await g.client.try('PATCH', `/api/rooms/${room}`, { name: 'Mine now' })).status).toBe(403)
  // their own notification level is still theirs
  expect((await g.client.try('PATCH', `/api/rooms/${room}`, { notifyLevel: 'mentions' })).status).toBe(200)
  expect((await mia.client.call('GET', `/api/rooms/${room}`)).canRename).toBe(true)
})

test('S8: Admin\'s invite list names the guest link\'s room', async () => {
  const { owner, mia, room } = await setup()
  const inv = await invite(mia.client, { kind: 'room', id: room })
  const items = (await owner.call('GET', '/api/admin/invites')).items as { id: string; guestPlace?: { kind: string; name?: string } }[]
  expect(items.find((i) => i.id === inv.invite.id)?.guestPlace).toMatchObject({ kind: 'room', name: 'Quote prep' })
})

test('S5/S6: a guest\'s ended sign-in says whether they left or were taken out, with the team, before any password', async () => {
  const { owner, mia, nora, room } = await setup()
  // left the room themselves
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  await g.client.call('POST', `/api/rooms/${room}/leave`)
  let r = await g.client.try('GET', '/api/me')
  expect(r.status).toBe(401)
  expect(r.body.error.params).toEqual({ reason: 'account_removed', guest: 'left', team: 'Acme' })
  // taken out by an admin (switched off), and the app opened days later: still said
  const g2 = await addGuest(h, nora.client, { username: 'gia', place: { kind: 'room', id: room } })
  await owner.call('PATCH', `/api/admin/users/${g2.id}`, { status: 'disabled' })
  const a = authOf(h.ctx)
  const real = a.now
  a.now = () => real.call(a) + 3 * 24 * 60 * 60 * 1000
  try {
    r = await g2.client.try('GET', '/api/chats')
    expect(r.body.error.params).toEqual({ reason: 'account_removed', guest: 'removed', team: 'Acme' })
  } finally { a.now = real }
  // taken out of the room by its people: removed, not left
  const g3 = await addGuest(h, mia.client, { username: 'gil', place: { kind: 'room', id: room } })
  await mia.client.call('DELETE', `/api/rooms/${room}/members/${g3.id}`)
  expect((await g3.client.try('GET', '/api/me')).body.error.params).toMatchObject({ guest: 'removed' })
  // switched on again (a new sign-in is needed): the old window gets the plain answer, not "no longer in"
  const g4 = await addGuest(h, mia.client, { username: 'gim', place: { kind: 'project', id: (await mia.client.call('POST', '/api/projects', { name: 'Plan', scope: 'team' })).id } })
  await owner.call('PATCH', `/api/admin/users/${g4.id}`, { status: 'disabled' })
  expect((await g4.client.try('GET', '/api/me')).body.error.params).toMatchObject({ guest: 'removed' })
  await owner.call('PATCH', `/api/admin/users/${g4.id}`, { status: 'active' })
  r = await g4.client.try('GET', '/api/me')
  expect(r.status).toBe(401)
  expect(r.body.error.params).toBeUndefined()
  // a member switched off: unchanged (the plain 401)
  const otto = await addMember(h, owner, { username: 'otto' })
  await owner.call('PATCH', `/api/admin/users/${otto.id}`, { status: 'disabled' })
  expect((await otto.client.try('GET', '/api/me')).body.error.params).toBeUndefined()
})
