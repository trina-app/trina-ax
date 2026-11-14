// Guests take no seat and are not the team's people (docs/DECISIONS.md "Guests: only what they were invited to"): the
// plan's seat count (system/limits.ts seatsUsed), the invited member's welcome head count (onboarding/member-welcome.ts),
// the relay heartbeat's and the hosting status's member counts leave them out, and a guest gets no welcome card. The
// plan cap and "convert to member" taking a seat: tests/unit/a-guests-invites.test.ts. Real guests.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { seatsUsed } from '../../server/src/system/limits'
import { welcomeOf } from '../../server/src/onboarding/member-welcome'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { addGuest, groupChat } from './guest-lib'

setDefaultTimeout(60_000)
let h: Harness
afterEach(async () => { await h?.close() })

test('seats and the welcome head count leave guests out; the guest has no welcome card; the invited member keeps theirs', async () => {
  h = await harness('a-guests-seats')
  const owner = await withOwner(h)
  const mia = await addMember(h, owner, { username: 'mia' })
  const nora = await addMember(h, owner, { username: 'nora' })
  // a member who joins with an invite has a welcome card with the team's head count
  const inv = await owner.call('POST', '/api/admin/invites', { role: 'member' })
  const nia = h.client({ ip: '10.0.0.8' })
  await nia.call('POST', `/api/invites/${String(inv.url).split('/invite/')[1]}/accept`, { username: 'nia', name: 'NIA', password: 'river stone lamp 8' })
  const before = seatsUsed(h.ctx.db)
  expect(before).toBe(4)
  const people = (await nia.call('GET', '/api/me/welcome')).welcome?.people
  expect(people).toBe(4)
  const room = await groupChat(owner, [mia.id, nora.id])
  const g = await addGuest(h, mia.client, { username: 'gus', place: { kind: 'room', id: room } })
  const g2 = await addGuest(h, owner, { username: 'gia', place: { kind: 'room', id: room } })
  expect(seatsUsed(h.ctx.db)).toBe(before)
  expect((await nia.call('GET', '/api/me/welcome')).welcome?.people).toBe(4)
  // the guest: no card (the endpoint is off their list, and the card itself is never made for them)
  expect((await g.client.try('GET', '/api/me/welcome')).status).toBe(403)
  h.ctx.db.query("INSERT OR IGNORE INTO member_welcome (user_id, joined_at, invited_by, via) VALUES (?, ?, ?, 'invite')").run(g2.id, new Date().toISOString(), 'olga')
  expect(welcomeOf(h.ctx, g2.id)).toBeNull()
  // the counts the hosting service and the relay read
  expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND guest = 0").get() as { n: number }).n).toBe(before)
})
