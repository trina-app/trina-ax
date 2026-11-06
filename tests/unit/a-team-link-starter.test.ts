// The team link's starter (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"; server/src/auth/team-links.ts):
// the lead's team files and a question for the link's skill. Kept on the link (only files someone joining with its groups
// could open), counted on the admin card, checked again with the new account at the join (a file they cannot read is left
// out silently, none left = no starter), and changed on the open link with PATCH without changing its address.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { setPlanForTests } from '../../server/src/system/limits'
import { addMember, harness, withOwner, type Client, type Harness } from './a-lib'

const PW = 'tulip meadow 2026'
const TASKS = 'skills/general/meeting-tasks/SKILL.md'
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
  // the team's own group: its folder groups/Acme/ is read and written by its members only
  team = await owner.call('POST', '/api/admin/groups', { name: 'Acme' })
  write('groups/Acme/회의록/11-03 주간회의.md', '# 주간회의\n- 서준: 배너 시안 금요일까지')
  write('groups/Acme/회의록/11-05 킥오프.md', '# 킥오프\n- 민지: 보도자료')
  write('shared/공지.md', '공지')
  write('users/olga-private.md', 'x')
})
afterAll(async () => { await h.close() })
afterEach(() => setPlanForTests(undefined))

test('made with a starter: only files a new member with the link\'s groups could open; joining lands on them with the skill', async () => {
  setPlanForTests(null)
  const files = ['groups/Acme/회의록/11-03 주간회의.md', 'groups/Acme/회의록/11-05 킥오프.md']
  // without the team group a new member could open none of the notes: no starter
  const none = await owner.call('POST', '/api/admin/team-link', { skillPath: TASKS, starter: { kind: 'tasks', files } })
  expect(none.link.starter).toBeNull()
  // a starter needs the skill it asks
  expect((await owner.try('POST', '/api/admin/team-link', { starter: { kind: 'tasks', files } })).status).toBe(400)
  // unknown keys and an empty list are refused
  expect((await owner.try('POST', '/api/admin/team-link', { skillPath: TASKS, starter: { kind: 'tasks', files: [] } })).status).toBe(400)
  expect((await owner.try('POST', '/api/admin/team-link', { skillPath: TASKS, starter: { kind: 'mine', files } })).status).toBe(400)

  const { link } = await owner.call('POST', '/api/admin/team-link', { groupIds: [team.id], skillPath: TASKS, starter: { kind: 'tasks', files: [...files, 'groups/Acme/회의록/없는 파일.md', '../etc/passwd'] } })
  expect(link.starter).toEqual({ kind: 'tasks', files: 2, paths: files })
  const stored = JSON.parse((h.ctx.db.query('SELECT starter FROM team_links WHERE id = ?').get(link.id) as { starter: string }).starter)
  expect(stored).toEqual({ kind: 'tasks', files })
  const audit = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'team_link.create' AND target = ?").get(link.id) as { detail: string }
  expect(JSON.parse(audit.detail).starter).toEqual({ kind: 'tasks', files })

  const r = await join(tokenOf(link.url))
  expect(r.status).toBe(201)
  // the skill form stays the fallback for older apps; the starter says what to open
  expect(r.body.next).toBe(`/skills?run=${encodeURIComponent(TASKS)}`)
  expect(r.body.starter).toEqual({
    kind: 'tasks',
    skill: { path: TASKS, name: 'meeting-tasks', title: '할 일 정리' },
    files: files.map((p) => ({ path: p, name: p.slice(p.lastIndexOf('/') + 1) })),
    by: 'Olga Owner',
  })
})

test('at the join each file is checked with the new account: one they cannot read is left out, none left is no starter', async () => {
  setPlanForTests(null)
  const files = ['groups/Acme/회의록/11-03 주간회의.md', 'shared/공지.md']
  const { link } = await owner.call('POST', '/api/admin/team-link', { groupIds: [team.id], skillPath: TASKS, starter: { kind: 'brief', files } })
  expect(link.starter).toEqual({ kind: 'brief', files: 2, paths: files })
  // the team folder's rules change after the link was made: the notes are kept from people who are not admins
  const folder = h.ctx.db.query("SELECT id FROM folders WHERE path = 'groups/Acme'").get() as { id: string }
  await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }] })
  expect((await owner.call('GET', '/api/admin/team-link')).link.starter).toEqual({ kind: 'brief', files: 1, paths: ['shared/공지.md'] })
  const r = await join(tokenOf(link.url))
  expect(r.status).toBe(201)
  expect(r.body.starter.files).toEqual([{ path: 'shared/공지.md', name: '공지.md' }])

  // nothing of it readable: the member lands on the skill as before, without a starter
  const only = await owner.call('POST', '/api/admin/team-link', { groupIds: [team.id], skillPath: TASKS, starter: { kind: 'tasks', files: ['shared/공지.md'] } })
  fs.rmSync(path.join(h.ctx.config.teamRoot, 'shared/공지.md'))
  const r2 = await join(tokenOf(only.link.url))
  expect(r2.status).toBe(201)
  expect(r2.body.starter).toBeNull()
  expect(r2.body.next).toBe(`/skills?run=${encodeURIComponent(TASKS)}`)
  // back as it was for the next test
  await owner.call('PUT', `/api/admin/folders/${folder.id}/rules`, { rules: [{ subjectType: 'group', subjectId: team.id, access: 'write' }] })
  write('shared/공지.md', '공지')
})

test('PATCH changes the open link\'s skill and starter and adds groups, keeping its address; admins only', async () => {
  setPlanForTests(null)
  const { link } = await owner.call('POST', '/api/admin/team-link', {})
  const notes = ['groups/Acme/회의록/11-03 주간회의.md']
  // the notes are in the team folder: a link without the team group gives them to nobody
  const lone = await owner.call('PATCH', '/api/admin/team-link', { skillPath: TASKS, starter: { kind: 'tasks', files: notes } })
  expect(lone.link.starter).toBeNull()
  const r = await owner.call('PATCH', '/api/admin/team-link', { skillPath: TASKS, starter: { kind: 'tasks', files: notes }, addGroupIds: [team.id] })
  expect(r.link).toMatchObject({ id: link.id, url: link.url, groupIds: [team.id], skill: { path: TASKS, title: '할 일 정리' }, starter: { kind: 'tasks', files: 1, paths: notes } })
  // adding the same group again keeps one; groups are never removed by PATCH
  const again = await owner.call('PATCH', '/api/admin/team-link', { addGroupIds: [team.id] })
  expect(again.link.groupIds).toEqual([team.id])
  expect(again.link.starter).toEqual({ kind: 'tasks', files: 1, paths: notes })
  // the member who joins gets the group and the notes
  const j = await join(tokenOf(link.url))
  expect(j.body.starter.files).toEqual([{ path: notes[0], name: '11-03 주간회의.md' }])
  // no skill, no starter
  const cleared = await owner.call('PATCH', '/api/admin/team-link', { skillPath: null })
  expect(cleared.link).toMatchObject({ skill: null, starter: null })
  expect((await owner.try('PATCH', '/api/admin/team-link', { starter: { kind: 'tasks', files: notes } })).status).toBe(400)
  expect((await owner.try('PATCH', '/api/admin/team-link', { addGroupIds: ['0190a0a0-0000-7000-8000-000000000000'] })).status).toBe(400)
  expect((await owner.try('PATCH', '/api/admin/team-link', { groupIds: [] })).status).toBe(400)
  const audits = h.ctx.db.query("SELECT detail FROM audit_log WHERE action = 'team_link.update' AND target = ?").all(link.id) as { detail: string }[]
  expect(audits.length).toBe(4)
  const member = await addMember(h, owner, { username: 'mia' })
  expect((await member.client.try('PATCH', '/api/admin/team-link', { skillPath: null })).status).toBe(403)
  // nothing open: 404
  await owner.call('DELETE', '/api/admin/team-link')
  expect((await owner.try('PATCH', '/api/admin/team-link', { skillPath: null })).status).toBe(404)
})
