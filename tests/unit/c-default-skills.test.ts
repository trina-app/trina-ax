// Default skills (server/src/onboarding/default-skills.ts, docs/DECISIONS.md "DS — Every skill pack is a default"):
// every skill of the general, marketing and work packs is added once, in the team's language, as the owner, without
// anyone installing it; the optional hr pack never is (an owner or admin adds it from Available skills). A skill already there is never replaced, one the team deleted never comes back, a team skill
// of the same name elsewhere blocks it, and a second run adds nothing.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { harness, withOwner, type Harness } from './a-lib'
import { checkSkill, listSkills, skillIssues } from '../../server/src/chat/skills'
import { setSetting } from '../../server/src/admin/settings'
import { DEFAULT_SKILLS_SETTING, defaultSkillKeys, seedDefaultSkills, startDefaultSkills } from '../../server/src/onboarding/default-skills'
import { RECURRING_PACK_SKILLS, SKILL_PACKS, installSkillPack, packSkillNames } from '../../server/src/onboarding/skill-packs'
import { setupWelcomeTeam } from '../../server/src/onboarding/welcome'
import { componentC } from '../../server/src/team-files/component'
import { DEFAULT_SKILL_PACKS, HR_PACK_SKILLS, OPTIONAL_SKILL_PACKS, SKILL_PACK_IDS } from '@mycel/shared/api'

let h: Harness
afterEach(async () => { await h?.close() })

const WORK = ['brand-brief', 'expense-review', 'humanizer', 'meeting-summary', 'new-hire-guide', 'sales-follow-up', 'weekly-team-report']
const HR = ['annual-leave', 'employment-certificate', 'labor-contract']
/** how many default skills: general 5, marketing 7, work 7 */
const N = 19
const ALL = defaultSkillKeys().map((s) => `skills/${s.key}/SKILL.md`)

async function setup() {
  h = await harness('c-default-skills')
  await withOwner(h)
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
  return { ownerId, root: h.ctx.files.fx.root }
}
const recorded = () => JSON.parse((h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(DEFAULT_SKILLS_SETTING) as { value: string }).value) as Record<string, { status: string }>
const put = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }

test('every pack is a default except the optional hr pack, and the packs\' skill names never repeat', () => {
  expect([...DEFAULT_SKILL_PACKS, ...OPTIONAL_SKILL_PACKS].sort()).toEqual([...SKILL_PACK_IDS].sort())
  expect(DEFAULT_SKILL_PACKS.some((id) => (OPTIONAL_SKILL_PACKS as readonly string[]).includes(id))).toBe(false)
  expect(Object.keys(SKILL_PACKS.hr.skills.en).sort()).toEqual(HR)
  expect(Object.keys(SKILL_PACKS.hr.skills.ko!).sort()).toEqual(HR)
  expect(HR_PACK_SKILLS).toBe(HR.length)
  expect(Object.keys(SKILL_PACKS.work.skills.en).sort()).toEqual(WORK)
  expect(Object.keys(SKILL_PACKS.work.skills.ko!).sort()).toEqual(WORK)
  const names = DEFAULT_SKILL_PACKS.flatMap((id) => Object.keys(SKILL_PACKS[id].skills.en))
  expect(new Set(names).size).toBe(names.length)
  expect(packSkillNames().sort()).toEqual([...names, ...HR].sort())
  expect(new Set([...names, ...HR]).size).toBe(names.length + HR.length)
  expect(defaultSkillKeys()).toHaveLength(N)
  expect(defaultSkillKeys().some((s) => s.id === 'hr')).toBe(false)
})

test('the work pack loads in both languages with its title and form, and every title and description is its own', () => {
  for (const l of ['ko', 'en'] as const) {
    const titles = new Set<string>(), lines = new Set<string>()
    for (const id of DEFAULT_SKILL_PACKS) {
      for (const [name, text] of Object.entries(SKILL_PACKS[id].skills[l]!)) {
        const c = checkSkill(text, `skills/${id}/${name}/SKILL.md`)
        expect(c.ok).toBe(true)
        if (!c.ok) continue
        expect(c.name).toBe(name)
        expect(c.badInputs).toBeUndefined()
        expect(c.title).toBeTruthy()
        titles.add(c.title!)
        lines.add(c.description)
        if (id === 'work') expect(c.inputs?.length).toBeGreaterThan(0)
      }
    }
    expect(titles.size).toBe(N)
    expect(lines.size).toBe(N)
  }
  expect(RECURRING_PACK_SKILLS.has('skills/work/weekly-team-report/SKILL.md')).toBe(true)
})

test('a team gets all 19 skills once, in its language, written as the owner and marked as the pack\'s', async () => {
  const { ownerId, root } = await setup()
  const r = seedDefaultSkills(h.ctx)!
  expect(r.created.sort()).toEqual([...ALL].sort())
  expect(r.pending).toBe(0)
  for (const s of defaultSkillKeys()) expect(fs.readFileSync(path.join(root, `skills/${s.key}/SKILL.md`), 'utf8')).toBe(SKILL_PACKS[s.id].skills.ko![s.name]!)
  const me = h.ctx.files.principal(ownerId)
  expect(listSkills(h.ctx.files, me).filter((s) => s.path.startsWith('skills/'))).toHaveLength(N)
  expect(skillIssues(h.ctx.files, me)).toEqual([])
  // the file events say the pack wrote them (the owner is not their maker)
  const events = h.ctx.db.query("SELECT user_id, detail FROM file_events WHERE path LIKE 'skills/%/SKILL.md'").all() as { user_id: string; detail: string }[]
  expect(events).toHaveLength(N)
  for (const e of events) { expect(e.user_id).toBe(ownerId); expect(JSON.parse(e.detail).tool).toBe('pack_install') }
  expect(Object.values(recorded()).every((v) => v.status === 'created')).toBe(true)
  const audit = h.ctx.db.query("SELECT actor_id, detail FROM audit_log WHERE action = 'onboarding.default_skills'").all() as { actor_id: string; detail: string }[]
  expect(audit).toHaveLength(1)
  expect(JSON.parse(audit[0]!.detail)).toEqual({ created: N, locale: 'ko' })

  // a second run adds nothing, writes nothing
  expect(seedDefaultSkills(h.ctx)).toEqual({ created: [], recorded: 0, pending: 0 })
  expect((h.ctx.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'onboarding.default_skills'").get() as { n: number }).n).toBe(1)
})

test('a team in a language the packs do not have gets the English text', async () => {
  const { root } = await setup()
  setSetting(h.ctx.db, 'defaultLocale', 'ja')
  seedDefaultSkills(h.ctx)
  expect(fs.readFileSync(path.join(root, 'skills/work/expense-review/SKILL.md'), 'utf8')).toBe(SKILL_PACKS.work.skills.en['expense-review']!)
})

test('a skill deleted after it was added never comes back', async () => {
  const { ownerId, root } = await setup()
  seedDefaultSkills(h.ctx)
  componentC(h.ctx).files.remove(ownerId, 'skills/work/sales-follow-up')
  componentC(h.ctx).files.remove(ownerId, 'skills/marketing')
  expect(seedDefaultSkills(h.ctx)!.created).toEqual([])
  expect(fs.existsSync(path.join(root, 'skills/work/sales-follow-up'))).toBe(false)
  expect(fs.existsSync(path.join(root, 'skills/marketing'))).toBe(false)
})

test('an existing team: what it has is kept as it is, a skill it deleted before is not brought back, a clash is not copied', async () => {
  const { ownerId, root } = await setup()
  // the general pack from the welcome steps, one of its skills edited since
  put(root, 'skills/general/doc-brief/SKILL.md', SKILL_PACKS.general.skills.ko!['doc-brief']!)
  const edited = SKILL_PACKS.general.skills.ko!['meeting-tasks']!.replace('# 할 일 정리', '# 할 일 정리 (우리 팀)')
  put(root, 'skills/general/meeting-tasks/SKILL.md', edited)
  // the marketing pack installed from the Skills page, then ad-copy deleted on purpose
  h.ctx.files.humanSave(ownerId, 'skills/marketing/ad-copy/SKILL.md', Buffer.from(SKILL_PACKS.marketing.skills.ko!['ad-copy']!), null, 'pack_install')
  componentC(h.ctx).files.remove(ownerId, 'skills/marketing/ad-copy')
  // the README example copied in by hand before it was a default
  put(root, 'skills/meeting-summary/SKILL.md', '---\nname: meeting-summary\ndescription: our own\n---\nOURS\n')
  const r = seedDefaultSkills(h.ctx)!
  const status = recorded()
  expect(status['general/doc-brief']!.status).toBe('present')
  expect(status['general/meeting-tasks']!.status).toBe('kept')
  expect(status['marketing/ad-copy']!.status).toBe('removed')
  expect(status['work/meeting-summary']!.status).toBe('blocked')
  expect(r.created).toHaveLength(N - 4)
  expect(fs.readFileSync(path.join(root, 'skills/general/meeting-tasks/SKILL.md'), 'utf8')).toBe(edited)
  expect(fs.existsSync(path.join(root, 'skills/marketing/ad-copy'))).toBe(false)
  expect(fs.existsSync(path.join(root, 'skills/work/meeting-summary'))).toBe(false)
  expect(fs.readFileSync(path.join(root, 'skills/meeting-summary/SKILL.md'), 'utf8')).toContain('OURS')
})

test('a write the folder rules refuse is tried again on the next run; nothing runs before the team has an owner', async () => {
  h = await harness('c-default-skills')
  expect(seedDefaultSkills(h.ctx)).toBeNull()
  await withOwner(h)
  const root = h.ctx.files.fx.root
  // something that is not a skill file sits at one path: blocked, not recorded
  fs.mkdirSync(path.join(root, 'skills/work/brand-brief/SKILL.md'), { recursive: true })
  const r = seedDefaultSkills(h.ctx)!
  expect(r.pending).toBe(1)
  expect(recorded()['work/brand-brief']).toBeUndefined()
  fs.rmSync(path.join(root, 'skills/work/brand-brief'), { recursive: true })
  expect(seedDefaultSkills(h.ctx)!.created).toEqual(['skills/work/brand-brief/SKILL.md'])
})

test('a row that does not read is left alone', async () => {
  const { root } = await setup()
  h.ctx.db.query('INSERT INTO settings (key, value) VALUES (?, ?)').run(DEFAULT_SKILLS_SETTING, 'not json')
  expect(seedDefaultSkills(h.ctx)).toBeNull()
  expect(fs.existsSync(path.join(root, 'skills/work'))).toBe(false)
})

test('the welcome steps add the default skills right away, and still record the general pack', async () => {
  const { ownerId, root } = await setup()
  const r = setupWelcomeTeam(h.ctx, ownerId, 'ko')
  expect(r.outcome).toBe('installed')
  expect(r.progress.general?.tasksPath).toBe('skills/general/meeting-tasks/SKILL.md')
  for (const rel of ALL) expect(fs.existsSync(path.join(root, rel))).toBe(true)
  expect(Object.values(recorded()).map((v) => v.status).sort()).toEqual([...Array(5).fill('present'), ...Array(N - 5).fill('created')].sort())
})

test('a running server adds them by itself on its timer, and stops with the server', async () => {
  const { root } = await setup()
  startDefaultSkills(h.ctx, 50)
  for (let i = 0; i < 40 && !fs.existsSync(path.join(root, 'skills/work/new-hire-guide/SKILL.md')); i++) await Bun.sleep(25)
  for (const rel of ALL) expect(fs.existsSync(path.join(root, rel))).toBe(true)
})

test('the optional hr pack loads in both languages and goes in only when an owner or admin adds it', async () => {
  for (const l of ['ko', 'en'] as const) {
    for (const [name, text] of Object.entries(SKILL_PACKS.hr.skills[l]!)) {
      const c = checkSkill(text, `skills/hr/${name}/SKILL.md`)
      expect(c.ok).toBe(true)
      if (!c.ok) continue
      expect(c.name).toBe(name)
      expect(c.badInputs).toBeUndefined()
      expect(c.title).toBeTruthy()
      expect(c.inputs?.length).toBeGreaterThan(0)
    }
  }
  const { ownerId, root } = await setup()
  seedDefaultSkills(h.ctx)
  expect(fs.existsSync(path.join(root, 'skills/hr'))).toBe(false)
  expect(Object.keys(recorded()).some((k) => k.startsWith('hr/'))).toBe(false)
  const r = installSkillPack(h.ctx, ownerId, 'hr')
  expect(r.skills.map((s) => s.status)).toEqual(Array(HR.length).fill('created'))
  for (const name of HR) expect(fs.readFileSync(path.join(root, `skills/hr/${name}/SKILL.md`), 'utf8')).toBe(SKILL_PACKS.hr.skills.ko![name]!)
  expect(skillIssues(h.ctx.files, h.ctx.files.principal(ownerId))).toEqual([])
  // the default run afterwards neither records nor touches them
  expect(seedDefaultSkills(h.ctx)!.created).toEqual([])
  expect(Object.keys(recorded()).some((k) => k.startsWith('hr/'))).toBe(false)
})

test('the natural-writing skill keeps its MIT notice in the text a team gets and next to it', () => {
  const en = SKILL_PACKS.work.skills.en.humanizer!
  expect(en).toContain('Copyright (c) 2025 Siqi Chen')
  expect(en).toContain('Permission is hereby granted, free of charge')
  expect(fs.readFileSync(path.join(import.meta.dir, '../../resources/skill-packs/work/en/humanizer/LICENSE'), 'utf8')).toContain('Copyright (c) 2025 Siqi Chen')
})
