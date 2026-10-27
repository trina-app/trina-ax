import { afterAll, beforeAll, expect, test } from 'bun:test'
import { harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness, owner: Client
beforeAll(async () => { h = await harness('drive-api'); owner = await withOwner(h) })
afterAll(async () => { await h?.close() })

test('Drive is disabled without provider configuration and never pretends to connect', async () => {
  const r = await owner.try('GET', '/api/integrations/google-drive')
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ configured: false, status: 'disabled', account: null, scopes: [], expiresAt: null })
  expect((await owner.try('POST', '/api/integrations/google-drive/authorize', {})).status).toBe(503)
})
test('Drive settings require a session', async () => {
  expect((await h.client().try('GET', '/api/integrations/google-drive')).status).toBe(401)
})
