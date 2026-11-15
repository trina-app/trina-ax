// Guest links that stopped working without anyone revoking them (their maker left the room), and what the invite page
// says about the AI choice (docs/DECISIONS.md "Guest states, round 3").
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

const tokenOf = (inv: { url: string }) => inv.url.split('/invite/')[1]!

test('Admin\'s invite list marks a link whose maker left the room as stopped; the others stay plain', async () => {
  h = await harness('a-guests-stopped-links')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const room = await groupChat(mia.client, [nora.id, otto.id])
  const place = { kind: 'room', id: room }
  const byNora = await nora.client.call('POST', '/api/guest-invites', { place, name: 'Left Lee' })
  const byMia = await mia.client.call('POST', '/api/guest-invites', { place, name: 'Stays Sam' })
  const listed = async () => ((await owner.call('GET', '/api/admin/invites')).items as any[])
  let rows = await listed()
  expect(rows.find((i) => i.guestName === 'Left Lee').stopped).toBeUndefined()
  await nora.client.call('POST', `/api/rooms/${room}/leave`)
  rows = await listed()
  expect(rows.find((i) => i.guestName === 'Left Lee').stopped).toBe('inviter_gone')
  expect(rows.find((i) => i.guestName === 'Stays Sam').stopped).toBeUndefined()
  // the invite page says the same reason, and the accept is refused
  const info = await h.client({ ip: '10.0.0.7' }).call('GET', `/api/invites/${tokenOf(byNora)}`)
  expect(info).toMatchObject({ valid: false, reason: 'inviter_gone' })
  expect(tokenOf(byMia)).toBeTruthy()
  // a used link, an expired one and a member's team invite never read as stopped
  const used = await mia.client.call('POST', '/api/guest-invites', { place, name: 'Used Uma' })
  await h.client({ ip: '10.0.0.9' }).call('POST', `/api/invites/${tokenOf(used)}/accept`, { username: 'uma', name: 'Uma', password: 'guest river lamp 77' })
  const old = await mia.client.call('POST', '/api/guest-invites', { place, name: 'Old Ola' })
  h.ctx.db.query('UPDATE invites SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 3600_000).toISOString(), old.invite.id)
  await owner.call('POST', '/api/admin/invites', { role: 'member' })
  rows = await listed()
  expect(rows.find((i) => i.guestName === 'Used Uma').stopped).toBeUndefined()
  expect(rows.find((i) => i.guestName === 'Old Ola').stopped).toBeUndefined()
  expect(rows.filter((i) => i.role === 'member').every((i) => i.stopped === undefined)).toBe(true)
})

test('the invite page tells the AI choice of a guest link while it works, and only then', async () => {
  h = await harness('a-guests-stopped-links-ai')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  const otto = await addMember(h, owner, { username: 'otto' })
  const room = await groupChat(mia.client, [nora.id, otto.id])
  const place = { kind: 'room', id: room }
  const none = await mia.client.call('POST', '/api/guest-invites', { place })
  const own = await mia.client.call('POST', '/api/guest-invites', { place, ai: { mode: 'own' } })
  const anon = h.client({ ip: '10.0.0.8' })
  expect((await anon.call('GET', `/api/invites/${tokenOf(none)}`)).guestAi).toBe('none')
  expect((await anon.call('GET', `/api/invites/${tokenOf(own)}`)).guestAi).toBe('own')
  await owner.call('DELETE', `/api/admin/invites/${own.invite.id}`)
  const dead = await anon.call('GET', `/api/invites/${tokenOf(own)}`)
  expect(dead.valid).toBe(false)
  expect(dead.guestAi).toBeUndefined()
})
