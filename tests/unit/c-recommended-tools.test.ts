// "팀 추천" (docs/decisions/20261120-team-vs-personal-onboarding.md, shared/src/api/team-tools.ts): the tools an owner or
// admin recommends to the team. Nothing recommended by default (also a team from before); owners and admins change it
// (PATCH /api/admin/settings, audited), members cannot; everyone reads it with their connections (GET /api/integrations
// `recommendedTools`). It gates nothing: a member connects a tool that is not recommended all the same.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { isRecommended, recommendedFirst, withRecommended } from '@mycel/shared/api'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

let h: Harness
let owner: Client
let admin: { client: Client; password: string }
let member: { client: Client; password: string }
beforeAll(async () => {
  h = await harness('recommended-tools')
  owner = await withOwner(h)
  admin = await addMember(h, owner, { username: 'adam', role: 'admin' })
  member = await addMember(h, owner, { username: 'mia', role: 'member' })
})
afterAll(async () => { await h?.close() })

describe('recommendedTools', () => {
  test('none by default; everyone reads it with their connections', async () => {
    expect((await owner.call('GET', '/api/admin/settings')).recommendedTools).toEqual([])
    expect((await member.client.call('GET', '/api/integrations')).recommendedTools).toEqual([])
  })
  test('an admin recommends (audited); members read it; a member cannot change it; a bad id is refused', async () => {
    const s = await admin.client.call('PATCH', '/api/admin/settings', { recommendedTools: ['google-drive', 'notion'] })
    expect(s.recommendedTools).toEqual(['google-drive', 'notion'])
    expect((await member.client.call('GET', '/api/integrations')).recommendedTools).toEqual(['google-drive', 'notion'])
    const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'settings.update' ORDER BY rowid DESC LIMIT 1").get() as { detail: string }
    expect(JSON.parse(audit.detail)).toEqual({ recommendedTools: ['google-drive', 'notion'] })
    expect((await member.client.try('PATCH', '/api/admin/settings', { recommendedTools: ['linear'] })).status).toBe(403)
    expect((await owner.try('PATCH', '/api/admin/settings', { recommendedTools: ['https://evil.example/mcp'] })).status).toBe(400)
    expect((await owner.try('PATCH', '/api/admin/settings', { recommendedTools: Array.from({ length: 51 }, (_, i) => `t${i}`) })).status).toBe(400)
  })
  test('it gates nothing: a member adds their own connection to a tool that is not recommended', async () => {
    const i = await member.client.call('POST', '/api/integrations', { kind: 'mcp', name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth', writePolicy: 'ask' })
    expect(i.scope).toBe('personal')
  })
})

describe('the shared helpers', () => {
  test('isRecommended, withRecommended (once, in order), recommendedFirst (stable for the rest)', () => {
    expect(isRecommended(undefined, 'notion')).toBe(false)
    expect(isRecommended(['notion'], 'notion')).toBe(true)
    expect(withRecommended(undefined, 'notion', true)).toEqual(['notion'])
    expect(withRecommended(['notion'], 'notion', true)).toEqual(['notion'])
    expect(withRecommended(['gmail', 'notion'], 'gmail', false)).toEqual(['notion'])
    const items = ['google-drive', 'gmail', 'linear', 'notion'].map((id) => ({ id }))
    expect(recommendedFirst(items, ['notion', 'gmail']).map((x) => x.id)).toEqual(['notion', 'gmail', 'google-drive', 'linear'])
    expect(recommendedFirst(items, []).map((x) => x.id)).toEqual(['google-drive', 'gmail', 'linear', 'notion'])
  })
})
