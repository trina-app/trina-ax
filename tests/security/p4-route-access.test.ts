// Actual HTTP auth/CSRF guards with synthetic local users, no engine or external provider.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { addMember, harness, withOwner, type Client, type Harness } from '../unit/a-lib'
import { P4_SPECS } from './lib/p4-cases'
import { CALLBACK_PATH } from '../../server/src/integrations/google-drive/config'
let h: Harness, owner: Client, mustChange: Client
beforeAll(async () => {
  h = await harness('p4-route-access'); owner = await withOwner(h)
  const member = await addMember(h, owner, { username: 'review-temp' })
  mustChange = member.client
  h.ctx.db.query('UPDATE users SET must_change_password=1 WHERE id=?').run(member.id)
})
afterAll(async () => { await h?.close() })
for (const key of Object.keys(P4_SPECS)) {
  const endpoint = (API as Record<string, { method: string; path: string }>)[key]!
  test(`${key} refuses anonymous and must-change-password sessions before request validation`, async () => {
    const url = endpoint.path.replace(/:id\b/, '00000000-0000-7000-8000-000000000000')
    const body = ['POST', 'PATCH'].includes(endpoint.method) ? {} : undefined
    expect((await h.client().raw(endpoint.method, url, body)).status).toBe(401)
    expect((await mustChange.raw(endpoint.method, url, body)).status).toBe(403)
  })
  if (!['GET', 'HEAD'].includes(endpoint.method)) test(`${key} requires CSRF protection before mutation`, async () => {
    const url = endpoint.path.replace(/:id\b/, '00000000-0000-7000-8000-000000000000')
    const response = await h.fetch(url, { method: endpoint.method, headers: { cookie: owner.cookie!, 'content-type': 'application/json', origin: 'https://outside.invalid' }, body: '{}' })
    expect(response.status).toBe(403)
  })
}
test('raw OAuth callback is explicitly covered: no state/code reflection and no-cache response', async () => {
  const marker = 'synthetic-secret-marker-DO-NOT-REFLECT'
  const response = await h.fetch(`${CALLBACK_PATH}?state=${marker}&code=${marker}`)
  expect(response.status).toBe(400)
  expect(await response.text()).not.toContain(marker)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
})
