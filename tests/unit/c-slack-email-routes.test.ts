// The two ways an account's e-mail changes, through the real routes of a real server (real sign-in, sessions and
// groups; responses checked against the contract): an admin in Admin › Members and the person in Settings › Profile.
// Both answer 2xx with what they saved, and the Slack connector's e-mail proof reads who set it (docs/SLACK.md: an
// e-mail someone else set proves nothing for 7 days, until the person sets it again).
import { afterEach, expect, test } from 'bun:test'
import { addMember, harness, withOwner, type Harness } from './a-lib'

let h: Harness
afterEach(async () => { await h?.close() })

test('an admin changes a member\'s e-mail, then the member changes it: both 2xx, and the proof follows who set it', async () => {
  h = await harness('slack-email-routes')
  const owner = await withOwner(h)
  const group = await owner.call('POST', '/api/admin/groups', { name: 'Sales' })
  const m = await addMember(h, owner, { username: 'mina', groupIds: [group.id] })

  const byAdmin = await owner.try('PATCH', `/api/admin/users/${m.id}`, { email: 'mina@acme.example' })
  expect(byAdmin.status).toBe(200)
  expect(byAdmin.body).toMatchObject({ id: m.id, email: 'mina@acme.example', groupIds: [group.id] })
  expect((await m.client.call('GET', '/api/slack/me')).emailSetByOther).toBe(true)

  // the person's own change comes after the admin's (the admin's entry counts within a second of its change)
  await Bun.sleep(1100)
  const own = await m.client.try('PATCH', '/api/me', { email: 'Mina@acme.example' })
  expect(own.status).toBe(200)
  expect(own.body.user).toMatchObject({ id: m.id, email: 'Mina@acme.example' })
  expect(own.body.groups).toEqual([{ id: group.id, name: 'Sales' }])
  expect((await m.client.call('GET', '/api/slack/me')).emailSetByOther).toBe(false)
})
