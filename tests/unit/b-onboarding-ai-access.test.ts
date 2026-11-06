// Onboarding stream A: the way out of "no AI". GET /api/me/ai-access says which button fits (owner connects for the
// team, and so does an admin; a member connects their own while the team allows it; anyone else asks the owner),
// POST /api/me/ai-access/request tells the owner(s) and the admins once (a second click changes nothing), only someone
// without AI who is not the owner or an admin can ask, the notice carries a name and nothing else, and it counts as read once the member can use AI.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { setSetting } from '../../server/src/admin/settings'
import { MEMBER_OWN_KEY } from '../../server/src/credentials/policy'
import { credentialsOf } from '../../server/src/credentials/store'
import { chargeHostedChat, HOSTED_CHAT_USAGE_SETTING, writeHostedChatKey } from '../../server/src/credentials/hosted-chat'
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
  test('owner connects for the team; a member connects their own while allowed; otherwise asks; an admin connects for the team like the owner', async () => {
    expect(await access(owner)).toEqual({ usable: false, action: 'connect_team', requested: false })
    expect(await access(mia.client)).toEqual({ usable: false, action: 'connect_own', requested: false })
    expect((await access(admin)).action).toBe('connect_team')
    setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
    expect((await access(mia.client)).action).toBe('ask_owner')
    expect((await access(admin)).action).toBe('connect_team')
    expect((await access(owner)).action).toBe('connect_team')
  })
})

describe('asking the owner', () => {
  test('the owner and an admin cannot ask', async () => {
    expect((await owner.try('POST', '/api/me/ai-access/request')).status).toBe(403)
    expect((await admin.try('POST', '/api/me/ai-access/request')).status).toBe(403)
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
    // an admin can connect the team's AI too: the same notice, with the same name, in their inbox; other members hear nothing
    const adminNotices = ((await admin.call('GET', '/api/notifications')).items as any[]).filter((i) => i.eventType === 'onboarding.ai_request')
    expect(adminNotices).toHaveLength(1)
    expect(adminNotices[0]).toMatchObject({ sourceId: mia.id, link: 'admin_credentials', requester: { name: 'MIA' }, readAt: null })
    expect(((await noa.client.call('GET', '/api/notifications')).items as any[]).some((i) => i.eventType === 'onboarding.ai_request')).toBe(false)
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

describe('asking again', () => {
  test('ask, connect (settled), lose AI, ask again: the owner hears again', async () => {
    const before = (await ownerNotices()).filter((i) => i.sourceId === mia.id)
    expect(before[0].readAt).not.toBeNull()
    expect((await access(mia.client)).requested).toBe(false)
    h.ctx.db.query('DELETE FROM engine_credentials').run()
    expect((await access(mia.client)).usable).toBe(false)
    expect(await mia.client.call('POST', '/api/me/ai-access/request')).toEqual({ requested: true, already: false })
    const after = (await ownerNotices()).filter((i) => i.sourceId === mia.id)
    expect(after).toHaveLength(1)
    expect(after[0].readAt).toBeNull()
    expect(await mia.client.call('POST', '/api/me/ai-access/request')).toEqual({ requested: true, already: true })
  })
})

describe('the hosting service\'s trial AI credit (streams B and Z)', () => {
  test('usable while it is active; used up or over: the same buttons, and the reason first', async () => {
    const cc = credentialsOf(h.ctx)
    const grant = { key: 'sk-or-v1-TRIAL-' + 'x'.repeat(40), capUsd: 5, endsAt: new Date(Date.now() + 14 * 86400_000).toISOString(), enabled: true }
    h.ctx.db.query('DELETE FROM engine_credentials').run()
    writeHostedChatKey(cc, grant)
    try {
      // active: it answers everyone who has no connection, so no banner, and nobody needs to ask
      expect(await access(owner)).toEqual({ usable: true, action: 'connect_team', requested: false })
      expect((await access(noa.client)).usable).toBe(true)
      expect((await noa.client.try('POST', '/api/me/ai-access/request')).status).toBe(403)

      // used up: nothing answers; each person gets their button, and the line says why first
      chargeHostedChat(h.ctx.db, 5)
      expect(await access(owner)).toEqual({ usable: false, action: 'connect_team', requested: false, trial: 'used' })
      expect(await access(admin)).toMatchObject({ usable: false, action: 'connect_team', trial: 'used' })
      setSetting(h.ctx.db, MEMBER_OWN_KEY, true)
      expect(await access(noa.client)).toMatchObject({ usable: false, action: 'connect_own', trial: 'used' })
      setSetting(h.ctx.db, MEMBER_OWN_KEY, false)
      expect(await noa.client.call('POST', '/api/me/ai-access/request')).toEqual({ requested: true, already: false })
      expect(await access(noa.client)).toEqual({ usable: false, action: 'ask_owner', requested: true, trial: 'used' })

      // over: switched off, or past its end (a new grant with room left but off still says ended)
      h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_CHAT_USAGE_SETTING)
      writeHostedChatKey(cc, { ...grant, enabled: false })
      expect((await access(owner)).trial).toBe('ended')
      writeHostedChatKey(cc, { ...grant, endsAt: new Date(Date.now() - 60_000).toISOString() })
      expect((await access(mia.client)).trial).toBe('ended')

      // a connection of the team takes over: usable, no trial line
      addCred(cc, 'anthropic-api-key', 'sk-ant-api03-' + 'team2'.padEnd(40, 'k'))
      expect(await access(owner)).toEqual({ usable: true, action: 'connect_team', requested: false })
      expect((await access(noa.client)).trial).toBeUndefined()
    } finally {
      writeHostedChatKey(cc, null)
      h.ctx.db.query('DELETE FROM settings WHERE key = ?').run(HOSTED_CHAT_USAGE_SETTING)
      h.ctx.db.query('DELETE FROM engine_credentials').run()
    }
  })
})

describe('engines that sign in on their own', () => {
  test('usable is true and a request is refused', async () => {
    const h2 = await harness('b-onb-ai-access-local', { engine: { authMode: 'local-login' } })
    try {
      const o = await withOwner(h2)
      const m = await addMember(h2, o, { username: 'lia' })
      expect((await m.client.call('GET', '/api/me/ai-access')).usable).toBe(true)
      expect((await m.client.try('POST', '/api/me/ai-access/request')).status).toBe(403)
    } finally { await h2.close() }
  })
})
