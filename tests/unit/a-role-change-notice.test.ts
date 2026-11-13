// A role change reaches the person's open windows at once (QA TC-1220): the owner makes an admin a member and that
// person's tabs read GET /api/me again (a "my_profile_changed" notice), so the Admin area closes without a reload. The
// API itself refuses admin calls from that moment on.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

describe('a role change', () => {
  let h: Harness
  let owner: Client
  let adam: { client: Client; id: string }
  beforeAll(async () => {
    h = await harness('role-change-notice')
    owner = await withOwner(h)
    adam = await addMember(h, owner, { username: 'adam', role: 'admin' })
  })
  afterAll(async () => { await h.close() })

  const told = (target: string, code: string) => h.hub.events.some((e) => e.kind === 'publish' && e.target === target && (e.data as { data?: { code?: string } }).data?.code === code)

  test('the person\'s windows are told to read their account again, and admin calls are refused', async () => {
    expect((await adam.client.try('GET', '/api/admin/users')).status).toBe(200)
    h.hub.events = []
    await owner.call('PATCH', `/api/admin/users/${adam.id}`, { role: 'member' })
    expect(told(adam.id, 'my_profile_changed')).toBe(true)
    expect((await adam.client.call('GET', '/api/me')).user.role).toBe('member')
    expect((await adam.client.try('GET', '/api/admin/users')).status).toBe(403)
  })

  test('a change that is not about the person\'s account tells nobody', async () => {
    h.hub.events = []
    await owner.call('PATCH', `/api/admin/users/${adam.id}`, { name: 'Adam Two' })
    expect(told(adam.id, 'my_profile_changed')).toBe(false)
  })

  test('new groups are told too (the sidebar and folders follow them)', async () => {
    const g = await owner.call('POST', '/api/admin/groups', { name: 'Ops', memberIds: [] })
    h.hub.events = []
    await owner.call('PATCH', `/api/admin/users/${adam.id}`, { groupIds: [g.id] })
    expect(told(adam.id, 'my_profile_changed')).toBe(true)
  })
})
