// Every team's start (docs/DECISIONS.md "M — One meeting note, everyone's own tasks"; server/src/onboarding/welcome.ts
// setupWelcomeTeam, POST /api/onboarding/welcome/team): the general pack (할 일 정리, 핵심 정리) installed once like the
// marketing pack, and the team's own group named after the team with its folder groups/<name>/ (its members read and
// write) and the meeting notes folder in it, the owner in the group, made once. "자료 없이" ends the steps (finish).
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { addMember, harness, withOwner, type Harness } from './a-lib'
import { listSkills, skillIssues } from '../../server/src/chat/skills'
import { authorize } from '../../server/src/policy/authorize'
import { SKILL_PACKS } from '../../server/src/onboarding/skill-packs'
import { WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { packInstalled } from '../../server/src/onboarding/tenant-status'
import { getSetting } from '../../server/src/admin/settings'
import { GENERAL_BRIEF_SKILL, GENERAL_CARDNEWS_SKILL, GENERAL_PROMO_SKILL, GENERAL_TASKS_SKILL, WelcomeProgress } from '@mycel/shared/api'

let h: Harness
afterEach(async () => { await h?.close() })

async function setup() {
  h = await harness('b-onboarding-team-space')
  const owner = await withOwner(h)
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE username = 'olga'").get() as { id: string }).id
  const ada = await addMember(h, owner, { username: 'ada', role: 'admin' })
  const mia = await addMember(h, owner, { username: 'mia' })
  return { owner, ownerId, ada, mia, root: h.ctx.files.fx.root }
}
const count = (action: string) => (h.ctx.db.query('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n
const can = (userId: string, rel: string, op: 'read' | 'write') => {
  try { authorize(h.ctx.files.fx, h.ctx.files.rules(), h.ctx.files.principal(userId), rel, op, { mustExist: false }); return true } catch { return false }
}

test('the general pack and the team group with its folders, once; the owner in it; its members read and write it', async () => {
  const { owner, ownerId, ada, mia, root } = await setup()
  expect(packInstalled(root)).toBe(false)
  const r = await owner.call('POST', '/api/onboarding/welcome/team')
  // the operator's count sees the general pack too (TenantStatus.onboarding.packInstalled)
  expect(packInstalled(root)).toBe(true)
  expect(r.outcome).toBe('installed')
  expect(r.install.skills.map((s: any) => [s.path, s.status])).toEqual([[GENERAL_TASKS_SKILL, 'created'], [GENERAL_BRIEF_SKILL, 'created'], [GENERAL_CARDNEWS_SKILL, 'created'], [GENERAL_PROMO_SKILL, 'created']])
  expect(r.install.folders).toEqual([])
  expect(fs.readFileSync(path.join(root, GENERAL_TASKS_SKILL), 'utf8')).toBe(SKILL_PACKS.general.skills.ko!['meeting-tasks']!)
  // the first result's promo video and the card news (still installed) are recorded with the pack
  expect(r.progress.general).toMatchObject({ tasksPath: GENERAL_TASKS_SKILL, briefPath: GENERAL_BRIEF_SKILL, cardNewsPath: GENERAL_CARDNEWS_SKILL, promoVideoPath: GENERAL_PROMO_SKILL })
  // the group is named after the team; its folder and the meeting notes folder (in the team language) are there
  const g = r.progress.teamGroup
  expect(g).toMatchObject({ name: 'Acme', folder: 'groups/Acme', notesFolder: 'groups/Acme/회의록' })
  expect(fs.statSync(path.join(root, 'groups/Acme/회의록')).isDirectory()).toBe(true)
  const groups = await owner.call('GET', '/api/admin/groups')
  expect(groups.items.find((x: any) => x.id === g.id)).toMatchObject({ name: 'Acme', memberIds: [ownerId] })
  expect(count('group.create')).toBe(1)
  // the group writes its folder (the default for group folders); someone outside it does not even read it
  const rule = h.ctx.db.query("SELECT r.access FROM folder_rules r JOIN folders f ON f.id = r.folder_id WHERE f.path = 'groups/Acme' AND r.subject_type = 'group' AND r.subject_id = ?").get(g.id) as { access: string }
  expect(rule.access).toBe('write')
  expect(can(mia.id, 'groups/Acme/회의록/x.md', 'read')).toBe(false)
  await owner.call('PATCH', `/api/admin/groups/${g.id}`, { memberIds: [ownerId, mia.id] })
  expect(can(mia.id, 'groups/Acme/회의록/x.md', 'write')).toBe(true)

  // the skills load with their forms and titles for a member, and nobody gets a loader warning
  const member = h.ctx.files.principal(mia.id)
  const general = listSkills(h.ctx.files, member).filter((s) => s.path.startsWith('skills/general/'))
  expect(general.map((s) => [s.name, s.title, s.inputs?.map((i) => i.name)])).toEqual([
    ['card-news', '카드뉴스', ['topic', 'channel', 'files']],
    ['doc-brief', '핵심 정리', ['scope', 'files']],
    ['meeting-tasks', '할 일 정리', ['scope', 'files']],
    ['promo-video', '홍보 영상', ['topic', 'channel', 'files']],
  ])
  expect(skillIssues(h.ctx.files, member)).toEqual([])
  expect(skillIssues(h.ctx.files, h.ctx.files.principal(ownerId))).toEqual([])

  // again: nothing installed or made a second time, the same group
  const again = await owner.call('POST', '/api/onboarding/welcome/team')
  expect(again).toMatchObject({ outcome: 'already', install: null })
  expect(again.progress.teamGroup).toEqual(g)
  expect(count('onboarding.pack_install')).toBe(1)
  expect(count('group.create')).toBe(1)
  // the row holds it, read field by field like the rest
  expect(WelcomeProgress.parse(getSetting(h.ctx.db, WELCOME_SETTING)).teamGroup).toEqual(g)

  // only the owner sets it up
  expect((await ada.client.try('POST', '/api/onboarding/welcome/team')).status).toBe(403)
  expect((await mia.client.try('POST', '/api/onboarding/welcome/team')).status).toBe(403)
})

test('a deleted skill is not brought back; a team that has the general skills is recorded without installing', async () => {
  const { owner, root } = await setup()
  await owner.call('POST', '/api/onboarding/packs/general/install')
  fs.rmSync(path.join(root, 'skills/general/doc-brief'), { recursive: true })
  const r = await owner.call('POST', '/api/onboarding/welcome/team')
  expect(r).toMatchObject({ outcome: 'already', install: null })
  expect(r.progress.general).toMatchObject({ tasksPath: GENERAL_TASKS_SKILL, briefPath: null })
  expect(fs.existsSync(path.join(root, 'skills/general/doc-brief'))).toBe(false)
  expect(count('onboarding.pack_install')).toBe(1)
})

test('blocked "할 일 정리" records no pack but still makes the team folder; a group the steps did not make is never taken over', async () => {
  const { owner, ownerId, root } = await setup()
  // something in the way of the skill file: a folder named SKILL.md
  fs.mkdirSync(path.join(root, GENERAL_TASKS_SKILL), { recursive: true })
  // an admin made a group named like the team before, with a rule on another folder
  const made = await owner.call('POST', '/api/admin/groups', { name: 'acme', memberIds: [] })
  await owner.call('POST', '/api/admin/folders', { path: 'shared/finance', rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'group', subjectId: made.id, access: 'write' }] })
  const r = await owner.call('POST', '/api/onboarding/welcome/team')
  expect(r.outcome).toBe('blocked')
  expect(r.progress.general).toBeUndefined()
  // a group of its own beside it: "Acme 2", the owner in it; the admin's group keeps its members and rules
  const g = r.progress.teamGroup
  expect(g.id).not.toBe(made.id)
  expect(g).toMatchObject({ name: 'Acme 2', folder: 'groups/Acme 2', notesFolder: 'groups/Acme 2/회의록' })
  const groups = (await owner.call('GET', '/api/admin/groups')).items
  expect(groups.find((x: any) => x.id === made.id).memberIds).toEqual([])
  expect(groups.find((x: any) => x.id === g.id).memberIds).toEqual([ownerId])
  expect(count('group.create')).toBe(2)
  // the way cleared: the next call installs it, and keeps the recorded group
  fs.rmSync(path.join(root, GENERAL_TASKS_SKILL), { recursive: true })
  const again = await owner.call('POST', '/api/onboarding/welcome/team')
  expect(again.outcome).toBe('installed')
  expect(again.progress.teamGroup).toEqual(g)

  // the recorded group deleted later: a new one, in a new folder (never the old group's files), never the admin's
  await owner.call('DELETE', `/api/admin/groups/${g.id}`)
  const next = (await owner.call('POST', '/api/onboarding/welcome/team')).progress.teamGroup
  expect([made.id, g.id]).not.toContain(next.id)
  expect(next.folder).not.toBe(g.folder)
  expect((await owner.call('GET', '/api/admin/groups')).items.find((x: any) => x.id === next.id).memberIds).toEqual([ownerId])
})

test('"자료 없이" finishes the steps: what is open is put off, done stays done', async () => {
  const { owner } = await setup()
  await owner.call('PATCH', '/api/onboarding/welcome', { step: { id: 'profile', state: 'done' } })
  const p = (await owner.call('PATCH', '/api/onboarding/welcome', { finish: true })).progress
  expect(p.steps).toEqual({ profile: 'done', result: 'skipped', invite: 'skipped' })
  expect(p.finishedAt).toBeString()
  // the same again keeps the time
  expect((await owner.call('PATCH', '/api/onboarding/welcome', { finish: true })).progress.finishedAt).toBe(p.finishedAt)
  expect((await owner.try('PATCH', '/api/onboarding/welcome', { finish: false })).status).toBe(400)
})
