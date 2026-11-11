// "Trina isn't ready yet" (chat error engine_missing, owner decision 2026-11-11): a member's [Tell an admin] is
// POST /api/me/ai-not-ready/tell. The owner(s) and admins each get one Inbox notice ("<name> tried to use Trina but it
// isn't set up yet", opening Admin › AI accounts), other members nothing; a second press within the hour sends nothing
// (the server's limit) and still says told; after the hour it comes back unread at the top; the owner and admins cannot
// press it (they connect the AI themselves). It lives beside the member's ask for an AI connection and changes nothing
// of it: that ask's "알렸어요" and its settling stay as they were, and a not-ready notice is never settled.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AI_NOT_READY_WINDOW_MS } from '../../shared/src/api'
import { notificationsOf } from '../../server/src/notifications/service'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, admin: Client, mia: { client: Client; id: string }, noa: { client: Client; id: string }
beforeAll(async () => {
  h = await harness('b-onb-ai-not-ready', { engine: { authMode: 'managed' } })
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  mia = await addMember(h, owner, { username: 'mia' })
  noa = await addMember(h, owner, { username: 'noa' })
})
afterAll(async () => { await h?.close() })

const tell = (c: Client) => c.call('POST', '/api/me/ai-not-ready/tell')
const notReady = async (c: Client) => ((await c.call('GET', '/api/notifications')).items as any[]).filter((i) => i.eventType === 'onboarding.ai_request' && i.notReady)

describe('telling an admin', () => {
  test('signed out: 401; the owner and an admin: 403 (they connect the AI themselves)', async () => {
    expect((await h.client().try('POST', '/api/me/ai-not-ready/tell')).status).toBe(401)
    expect((await owner.try('POST', '/api/me/ai-not-ready/tell')).status).toBe(403)
    expect((await admin.try('POST', '/api/me/ai-not-ready/tell')).status).toBe(403)
  })

  test('one notice to the owner and to the admin, with the name and the link; other members hear nothing', async () => {
    expect(await tell(mia.client)).toEqual({ told: true, already: false })
    for (const c of [owner, admin]) {
      const n = await notReady(c)
      expect(n).toHaveLength(1)
      expect(n[0]).toMatchObject({ code: 'onboarding.ai_request', link: 'admin_credentials', requester: { name: 'MIA' }, notReady: true, readAt: null })
      expect(JSON.stringify(n[0])).not.toContain('noa')
    }
    expect(((await noa.client.call('GET', '/api/notifications')).items as any[]).some((i) => i.eventType === 'onboarding.ai_request')).toBe(false)
    expect(((await mia.client.call('GET', '/api/notifications')).items as any[]).some((i) => i.eventType === 'onboarding.ai_request')).toBe(false)
  })

  test('a second press within the hour sends nothing, even once the notice is read; another member is told on their own', async () => {
    const before = (await notReady(owner))[0]
    expect((await owner.call('POST', `/api/notifications/${before.id}/read`)).readAt).not.toBeNull()
    expect(await tell(mia.client)).toEqual({ told: true, already: true })
    expect(await tell(mia.client)).toEqual({ told: true, already: true })
    const after = await notReady(owner)
    expect(after).toHaveLength(1)
    expect(after[0].createdAt).toBe(before.createdAt)
    expect(await tell(noa.client)).toEqual({ told: true, already: false })
    expect(await notReady(owner)).toHaveLength(2)
  })

  test('after the hour: told again, the same notice back unread with a new time (no second row)', async () => {
    const old = new Date(Date.now() - AI_NOT_READY_WINDOW_MS - 60_000).toISOString()
    h.ctx.db.query("UPDATE onboarding_notices SET created_at=?, read_at=? WHERE source_id=?").run(old, old, `not-ready:${mia.id}`)
    expect(await tell(mia.client)).toEqual({ told: true, already: false })
    const mine = (await notReady(owner)).filter((i) => i.requester?.name === 'MIA')
    expect(mine).toHaveLength(1)
    expect(mine[0].readAt).toBeNull()
    expect(mine[0].createdAt > old).toBe(true)
    expect((await notReady(admin)).filter((i) => i.requester?.name === 'MIA')).toHaveLength(1)
  })

  test('the ask for an AI connection is untouched: not "asked", and the not-ready notice is never settled', async () => {
    // mia told about not-ready, but never asked for a connection: GET /api/me/ai-access still says not requested
    expect((await mia.client.call('GET', '/api/me/ai-access')).requested).toBe(false)
    notificationsOf(h.ctx).reconcile()
    expect((await notReady(owner)).filter((i) => i.requester?.name === 'MIA')[0].readAt).toBeNull()
    // and asking for a connection is its own notice
    expect(await mia.client.call('POST', '/api/me/ai-access/request')).toEqual({ requested: true, already: false })
    const all = ((await owner.call('GET', '/api/notifications')).items as any[]).filter((i) => i.eventType === 'onboarding.ai_request' && i.requester?.name === 'MIA')
    expect(all.map((i) => !!i.notReady).sort()).toEqual([false, true])
  })
})
