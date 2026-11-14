// A stopped team's server starts in about a minute; meanwhile the relay answers a retryable 503 with the header
// x-relay-error: team_waking. The client marks it (params.reason) so the app can say "Starting your team".
import { describe, expect, test } from 'bun:test'
import { API, ApiClient, ApiError } from '../../shared/src/api'
import { isConnectionError, isTeamWaking } from '../../web/src/lib/api'

const fake = (status: number, relay: string | null, body: unknown) => (async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(relay ? { 'x-relay-error': relay } : {}) } })) as unknown as typeof fetch

const call = async (f: typeof fetch) => {
  try { await new ApiClient({ baseUrl: '', fetch: f }).call(API.me); return null } catch (e) { return e }
}

describe('team_waking answer of the relay', () => {
  test('is marked, and still counts as a connection error that passes by itself', async () => {
    const e = await call(fake(503, 'team_waking', { error: { code: 'unavailable', message: 'Starting your team…', reason: 'team_waking', retryAfter: 4 } }))
    expect(e).toBeInstanceOf(ApiError)
    expect(isTeamWaking(e)).toBe(true)
    expect(isConnectionError(e)).toBe(true)
    expect((e as ApiError).body.retryAfter).toBe(4)
  })
  test('also without a JSON body (an HTML page)', async () => {
    const f = (async () => new Response('<html></html>', { status: 503, headers: { 'x-relay-error': 'team_waking' } })) as unknown as typeof fetch
    const e = await call(f)
    expect(isTeamWaking(e)).toBe(true)
  })
  test('another 503 is not "waking"', async () => {
    const e = await call(fake(503, 'team_offline', { error: { code: 'unavailable', message: 'x' } }))
    expect(isTeamWaking(e)).toBe(false)
    expect(isConnectionError(e)).toBe(true)
    expect(isTeamWaking(await call(fake(503, null, { error: { code: 'unavailable', message: 'x' } })))).toBe(false)
  })
})
