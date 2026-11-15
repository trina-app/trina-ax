// A guest invite's name (who the link is for, CreateGuestInviteBody.name) comes back in the admin invite list as
// Invite.guestName, so Admin › Members & invites tells guest links apart (docs/DECISIONS.md "Guest invites, phase 2").
// A link without a name and a member invite have none.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('the invite list carries a guest link\'s name; none without one, none on a member invite', async () => {
  h = await harness('a-guests-invite-name')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const pia = await addMember(h, owner, { username: 'pia' })
  const room = await groupChat(mia.client, [nora.id, pia.id], 'Quote prep')
  const named = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room }, name: 'Kim from Acme' })
  expect(named.invite.guestName).toBe('Kim from Acme')
  const plain = await mia.client.call('POST', '/api/guest-invites', { place: { kind: 'room', id: room } })
  const member = await owner.call('POST', '/api/admin/invites', { role: 'member' })
  const items = (await owner.call('GET', '/api/admin/invites')).items as { id: string; guestName?: string }[]
  expect(items.find((i) => i.id === named.invite.id)?.guestName).toBe('Kim from Acme')
  expect('guestName' in items.find((i) => i.id === plain.invite.id)!).toBe(false)
  expect('guestName' in items.find((i) => i.id === member.invite.id)!).toBe(false)
})
