// The team link without its starter (docs/DECISIONS.md "DS3"; server/src/auth/team-links.ts): the starter (the lead's
// meeting notes and "내 할 일 정리해 줘" for 할 일 정리, docs/DECISIONS.md "M") went with that skill. A link names a skill
// at most; PATCH changes its skill and adds groups, keeping its address; a starter an older version stored on a link is
// never read (the column stays, no migration): someone who joins lands on the link's skill form as with any link.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { setPlanForTests } from '../../server/src/system/limits'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

const PW = 'tulip meadow 2026'
const DECK = 'skills/general/intro-deck/SKILL.md'
const tokenOf = (url: string) => new URL(url).hash.replace(/^#t=/, '')

let h: Harness
let owner: Client
let n = 0
let team: { id: string }
const join = (token: string) => h.client({ ip: `10.8.0.${(++n % 200) + 1}` }).try('POST', '/api/team-link/join', { token, username: `starter${n}`, name: '서준', password: PW })
const write = (rel: string, text = '회의록') => {
  const abs = path.join(h.ctx.config.teamRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

beforeAll(async () => {
  h = await harness('team-link-starter')
  owner = await withOwner(h)
  setPlanForTests(null)
  expect((await owner.try('POST', '/api/onboarding/packs/general/install')).status).toBe(200)
  team = await owner.call('POST', '/api/admin/groups', { name: 'Acme' })
  write('groups/Acme/회의록/11-03 주간회의.md', '# 주간회의\n- 서준: 배너 시안 금요일까지')
})
afterAll(async () => { await h.close() })
afterEach(() => setPlanForTests(undefined))

test('a link carries no starter: a starter in the body is not kept, the link and the join answer have none', async () => {
  setPlanForTests(null)
  const r = await owner.try('POST', '/api/admin/team-link', { groupIds: [team.id], skillPath: DECK, starter: { kind: 'tasks', files: ['groups/Acme/회의록/11-03 주간회의.md'] } })
  expect(r.status).toBe(201)
  expect(r.body.link.starter).toBeUndefined()
  expect(r.body.link.skill).toMatchObject({ path: DECK })
  const row = h.ctx.db.query('SELECT starter FROM team_links WHERE id = ?').get(r.body.link.id) as { starter: string | null }
  expect(row.starter).toBeNull()
  const j = await join(tokenOf(r.body.link.url))
  expect(j.status).toBe(201)
  expect(j.body.next).toBe(`/skills?run=${encodeURIComponent(DECK)}`)
  expect(j.body.starter).toBeUndefined()
})

test('a starter an older version stored on the open link is never read: not on the card, not at the join', async () => {
  setPlanForTests(null)
  const { link } = await owner.call('POST', '/api/admin/team-link', { groupIds: [team.id], skillPath: DECK })
  h.ctx.db.query('UPDATE team_links SET starter = ? WHERE id = ?').run(JSON.stringify({ kind: 'tasks', files: ['groups/Acme/회의록/11-03 주간회의.md'] }), link.id)
  expect((await owner.call('GET', '/api/admin/team-link')).link.starter).toBeUndefined()
  const j = await join(tokenOf(link.url))
  expect(j.status).toBe(201)
  expect(j.body.next).toBe(`/skills?run=${encodeURIComponent(DECK)}`)
  expect(j.body.starter).toBeUndefined()
})

test('PATCH changes the open link\'s skill and adds groups, keeping its address; a starter is refused; admins only', async () => {
  setPlanForTests(null)
  const { link } = await owner.call('POST', '/api/admin/team-link', {})
  const r = await owner.call('PATCH', '/api/admin/team-link', { skillPath: DECK, addGroupIds: [team.id] })
  expect(r.link).toMatchObject({ id: link.id, url: link.url, groupIds: [team.id], skill: { path: DECK, title: '회사 소개서' } })
  // adding the same group again keeps one; groups are never removed by PATCH
  const again = await owner.call('PATCH', '/api/admin/team-link', { addGroupIds: [team.id] })
  expect(again.link.groupIds).toEqual([team.id])
  const cleared = await owner.call('PATCH', '/api/admin/team-link', { skillPath: null })
  expect(cleared.link).toMatchObject({ skill: null })
  expect((await owner.try('PATCH', '/api/admin/team-link', { skillPath: DECK, starter: { kind: 'tasks', files: ['groups/Acme/회의록/11-03 주간회의.md'] } })).status).toBe(400)
  expect((await owner.try('PATCH', '/api/admin/team-link', { addGroupIds: ['0190a0a0-0000-7000-8000-000000000000'] })).status).toBe(400)
  expect((await owner.try('PATCH', '/api/admin/team-link', { groupIds: [] })).status).toBe(400)
  const audits = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'team_link.update' AND target = ?").all(link.id) as { detail: string }[]
  expect(audits.length).toBe(3)
  for (const a of audits) expect(JSON.parse(a.detail).starter).toBeUndefined()
  const member = await addMember(h, owner, { username: 'mia' })
  expect((await member.client.try('PATCH', '/api/admin/team-link', { skillPath: null })).status).toBe(403)
  // nothing open: 404
  await owner.call('DELETE', '/api/admin/team-link')
  expect((await owner.try('PATCH', '/api/admin/team-link', { skillPath: null })).status).toBe(404)
})
