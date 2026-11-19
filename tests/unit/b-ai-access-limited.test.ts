// GET /api/me/ai-access while the only AI account is connected but at a usage limit that ends by itself (QA TC-5192):
// it says until when (limitedUntil), so the screens do not show "No AI is connected yet" beside the answer's own
// "the AI usage has run out until …". A short limit is usable (the person only waits); nothing connected, or a
// refused account, has no limitedUntil (a wait does not fix it).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { credentialsOf } from '../../server/src/credentials/store'
import { addCred } from '../lib/credentials'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, mia: Client
beforeAll(async () => {
  h = await harness('b-ai-access-limited', { engine: { authMode: 'managed' } })
  owner = await withOwner(h)
  mia = (await addMember(h, owner, { username: 'mia' })).client
})
afterAll(async () => { await h?.close() })

const access = (c: Client) => c.call('GET', '/api/me/ai-access')
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

test('nothing connected: not usable, no limitedUntil', async () => {
  const r = await access(mia)
  expect(r.usable).toBe(false)
  expect(r.limitedUntil).toBeUndefined()
})

test('the team account at a two-day limit: not usable, limitedUntil is when it is back, for the owner and a member', async () => {
  const id = addCred(credentialsOf(h.ctx), 'anthropic-oauth', 'sk-ant-oat01-' + 'weekly'.padEnd(40, 's'))
  const end = iso(2 * 86400_000)
  h.ctx.db.query("UPDATE engine_credentials SET limited_until = ?, status_code = 'rate_limited' WHERE id = ?").run(end, id)
  for (const c of [owner, mia]) {
    const r = await access(c)
    expect(r.usable).toBe(false)
    expect(Date.parse(r.limitedUntil)).toBe(Date.parse(end))
  }
  // a short limit: usable, nothing to say
  h.ctx.db.query('UPDATE engine_credentials SET limited_until = ? WHERE id = ?').run(iso(10 * 60_000), id)
  const short = await access(mia)
  expect(short.usable).toBe(true)
  expect(short.limitedUntil).toBeUndefined()
  // refused: no wait fixes it
  h.ctx.db.query("UPDATE engine_credentials SET limited_until = NULL, status = 'invalid', status_code = 'upstream_401' WHERE id = ?").run(id)
  const refused = await access(mia)
  expect(refused.usable).toBe(false)
  expect(refused.limitedUntil).toBeUndefined()
})
