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
  const endpoint = (API as Record<string, { method: string; path: string; auth: string }>)[key]!
  // public by contract (removePushDevice: the phone app leaves a team without that team's session; labelPushDevice: the
  // iPhone's notification extension, with its label key): who calls does not change the answer
  if (endpoint.auth === 'public') test(`${key} is public by contract: anonymous and must-change-password callers get the same answer`, async () => {
    const url = endpoint.path.replace(/:id\b/, '00000000-0000-7000-8000-000000000000')
    const body = ['POST', 'PATCH'].includes(endpoint.method) ? {} : undefined
    const anonymous = (await h.client().raw(endpoint.method, url, body)).status
    expect(anonymous).toBeLessThan(500)
    expect((await mustChange.raw(endpoint.method, url, body)).status).toBe(anonymous)
  })
  else test(`${key} refuses anonymous and must-change-password sessions before request validation`, async () => {
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
  // a browser not signed in here with a state nobody knows: the Sign in with Google return (its sign-in page and words,
  // docs/decisions/20261124-google-signin-security.md), a bare redirect that carries neither value
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe('/login?google=expired')
  expect(await response.text()).not.toContain(marker)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('referrer-policy')).toBe('no-referrer')

  // a signed-in browser: Drive's own page, as before
  const drive = await h.fetch(`${CALLBACK_PATH}?state=${marker}&code=${marker}`, { headers: { cookie: owner.cookie! } })
  expect(drive.status).toBe(400)
  expect(await drive.text()).not.toContain(marker)
  expect(drive.headers.get('cache-control')).toBe('no-store')
  expect(drive.headers.get('referrer-policy')).toBe('no-referrer')
  expect(drive.headers.get('content-security-policy')).toContain("default-src 'none'")
})
