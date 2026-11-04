// Onboarding stream A: the way out of "no AI". GET /api/me/ai-access says which button fits (owner connects for the
// team; a member connects their own while the team allows it; anyone else asks the owner), POST /api/me/ai-access/request
// tells the owner(s) once (a second click changes nothing), only someone without AI who is not the owner can ask, the
// owner's notice carries a name and nothing else, and it counts as read once the member can use AI.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { setSetting } from '../../server/src/admin/settings'
import { MEMBER_OWN_KEY } from '../../server/src/credentials/policy'
import { credentialsOf } from '../../server/src/credentials/store'
import { notificationsOf } from '../../server/src/notifications/service'
import { addCred } from '../lib/credentials'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client, admin: Client, mia: { client: Client; id: string }, noa: { client: Client; id: string }
beforeAll(async () => {
  h = await harness('b-onb-ai-access', { engine: { authMode: 'managed' } })
  owner = await withOwner(h)
  admin = (await addMember(h, owner, { username: 'adam', role: 'admin' })).client
  mia = await addMember(h, owner, { username: 'mia' })
  noa = await addMember(h, owner, { username: 'noa' })
})
afterAll(async () => { await h?.close() })

const access = (c: Client) => c.call('GET', '/api/me/ai-access')
const ownerNotices = async () => ((await owner.call('GET', '/api/notifications')).items as any[]).filter((i) => i.eventType === 'onboarding.ai_request')

describe('which button', () => {
  test('signed out: 401', async () => {
    expect((await h.client().try('GET', '/api/me/ai-access')).status).toBe(401)
    expect((await h.client().try('POST', '/api/me/ai-access/request')).status).toBe(401)
  })
  test('owner connects for the team; a member connects their own while allowed; otherwise asks; an admin cannot add a team connection', async () => {
    expect(await access(owner)).toEqual({ usable: false, action: 'connect_team', requested: false })
    expect(await access(mia.client)).toEqual({ usable: false, action: 'connect_own', requested: false })
    expect((await access(admin)).action).toBe('connect_own')
    setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
    expect((await access(mia.client)).action).toBe('ask_owner')
    expect((await access(admin)).action).toBe('ask_owner')
    expect((await access(owner)).action).toBe('connect_team')
  })
})

describe('asking the owner', () => {
  test('the owner cannot ask', async () => {
    expect((await owner.try('POST', '/api/me/ai-access/request')).status).toBe(403)
  })
  test('one notice per owner however often it is clicked; the owner sees a name and a link; others hear nothing', async () => {
    const a = await mia.client.call('POST', '/api/me/ai-access/request')
    expect(a).toEqual({ requested: true, already: false })
    const b = await mia.client.call('POST', '/api/me/ai-access/request')
    expect(b).toEqual({ requested: true, already: true })
    expect((await access(mia.client)).requested).toBe(true)
    expect((await access(noa.client)).requested).toBe(false)
    const n = await ownerNotices()
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ sourceId: mia.id, link: 'admin_credentials', requester: { name: 'MIA' }, readAt: null })
    expect(JSON.stringify(n[0])).not.toContain('noa')
    // an admin is not the owner: nothing in their inbox
    expect(((await admin.call('GET', '/api/notifications')).items as any[]).some((i) => i.eventType === 'onboarding.ai_request')).toBe(false)
    // another member asks on their own
    await noa.client.call('POST', '/api/me/ai-access/request')
    expect(await ownerNotices()).toHaveLength(2)
  })
  test('the notice counts as read once the member can use AI; and someone who can use AI cannot ask', async () => {
    addCred(credentialsOf(h.ctx), 'anthropic-api-key', 'sk-ant-api03-' + 'team'.padEnd(40, 'k'))
    expect((await access(mia.client)).usable).toBe(true)
    expect((await mia.client.try('POST', '/api/me/ai-access/request')).status).toBe(403)
    notificationsOf(h.ctx).reconcile()
    const n = await ownerNotices()
    expect(n.every((i) => i.readAt !== null)).toBe(true)
  })
})
