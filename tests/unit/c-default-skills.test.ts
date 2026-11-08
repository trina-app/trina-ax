// Only skills with a known origin ship, and nothing adds them by itself (docs/DECISIONS.md "DS3", which replaced "DS"
// and "DS2"): the general pack (the intro deck, the card news, the promo video) and the work pack (natural writing),
// four skills in Korean and English. No seeder and no timer: the welcome steps install the general pack once, the empty
// Team skills page installs both on an admin's press. An older build's seeder, run again after a rollback, finds every
// skill it knew recorded (`retired`) in its settings row and adds nothing. Existing teams keep their files.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { harness, withOwner, type Harness } from './a-lib'
import { checkSkill, listSkills, skillIssues } from '../../server/src/chat/skills'
import { setSetting } from '../../server/src/admin/settings'
import { SKILL_PACKS, installSkillPack, packSkillNames } from '../../server/src/onboarding/skill-packs'
import { LEGACY_DEFAULT_SKILL_KEYS, LEGACY_DEFAULT_SKILLS_SETTING, LEGACY_PACK_SKILL_NAMES, retireLegacyDefaultSkills } from '../../server/src/onboarding/retired-skills'
import { landingSkill, setupWelcomeTeam, WELCOME_SETTING } from '../../server/src/onboarding/welcome'
import { GENERAL_CARDNEWS_SKILL, GENERAL_DECK_SKILL, GENERAL_PROMO_SKILL, RECOMMENDED_PACK_SKILLS, RECOMMENDED_SKILL_PACKS, SKILL_PACK_IDS } from '@mycel/shared/api'

let h: Harness
afterEach(async () => { await h?.close() })

const ROOT = path.join(import.meta.dir, '..', '..')
/** the four skills that ship, by pack */
const KEPT = { general: ['card-news', 'intro-deck', 'promo-video'], work: ['humanizer'] } as const
const KEPT_PATHS = Object.entries(KEPT).flatMap(([id, names]) => names.map((n) => `skills/${id}/${n}/SKILL.md`)).sort()
/** the 18 that went: no known origin */
const GONE = {
  general: ['meeting-tasks', 'doc-brief'],
  marketing: ['ad-copy', 'content-draft', 'campaign-plan', 'seo-brief', 'competitor-brief', 'brand-review', 'weekly-report'],
  work: ['meeting-summary', 'weekly-team-report', 'sales-follow-up', 'brand-brief', 'expense-review', 'new-hire-guide'],
  hr: ['labor-contract', 'employment-certificate', 'annual-leave'],
} as const

async function setup() {
  h = await harness('c-default-skills')
  await withOwner(h)
  const ownerId = (h.ctx.db.query("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id
  return { ownerId, root: h.ctx.files.fx.root }
}
const teamSkillFiles = (root: string) => {
  const dir = path.join(root, 'skills')
  if (!fs.existsSync(dir)) return []
  return (fs.readdirSync(dir, { recursive: true }) as string[]).map((p) => `skills/${p.split(path.sep).join('/')}`).filter((p) => p.endsWith('/SKILL.md')).sort()
}
const legacyRow = () => JSON.parse((h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(LEGACY_DEFAULT_SKILLS_SETTING) as { value: string }).value) as Record<string, { at: string; status: string }>
const put = (root: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text) }

test('the packs ship the four skills with a known origin, in Korean and English, each loading with its title; the 18 others are gone', () => {
  expect([...SKILL_PACK_IDS]).toEqual(['general', 'work'])
  expect([...RECOMMENDED_SKILL_PACKS]).toEqual(['general', 'work'])
  for (const [id, names] of Object.entries(KEPT) as [keyof typeof KEPT, readonly string[]][]) {
    for (const l of ['ko', 'en'] as const) {
      expect(Object.keys(SKILL_PACKS[id].skills[l]!).sort()).toEqual([...names].sort())
      for (const [name, text] of Object.entries(SKILL_PACKS[id].skills[l]!)) {
        const c = checkSkill(text, `skills/${id}/${name}/SKILL.md`)
        expect(c.ok && c.name === name && !!c.title).toBe(true)
      }
    }
  }
  expect(packSkillNames().sort()).toEqual(['card-news', 'humanizer', 'intro-deck', 'promo-video'])
  expect(RECOMMENDED_PACK_SKILLS).toBe(RECOMMENDED_SKILL_PACKS.reduce((n, id) => n + Object.keys(SKILL_PACKS[id].skills.en).length, 0))
  // nothing of the deleted skills is left in the repository's packs
  for (const [id, names] of Object.entries(GONE)) for (const n of names) for (const l of ['ko', 'en']) expect(fs.existsSync(path.join(ROOT, 'resources/skill-packs', id, l, n))).toBe(false)
  expect(fs.readdirSync(path.join(ROOT, 'resources/skill-packs')).sort()).toEqual(['general', 'work'])
})

test('the natural-writing skill keeps its MIT notice in the text a team gets and next to it', () => {
  const en = SKILL_PACKS.work.skills.en.humanizer!
  expect(en).toContain('Copyright (c) 2025 Siqi Chen')
  expect(en).toContain('Permission is hereby granted, free of charge')
  expect(fs.readFileSync(path.join(ROOT, 'resources/skill-packs/work/en/humanizer/LICENSE'), 'utf8')).toContain('Copyright (c) 2025 Siqi Chen')
})

test('no seeder and no timer: the module is gone and the server starts none', () => {
  expect(fs.existsSync(path.join(ROOT, 'server/src/onboarding/default-skills.ts'))).toBe(false)
  const main = fs.readFileSync(path.join(ROOT, 'server/src/main.ts'), 'utf8')
  expect(main).not.toMatch(/onboarding\/default-skills|startDefaultSkills|seedDefaultSkills/)
  // the rollback guard runs at the start instead: a settings write only
  expect(main).toMatch(/retireLegacyDefaultSkills\(ctx\.db\)/)
  const welcome = fs.readFileSync(path.join(ROOT, 'server/src/onboarding/welcome.ts'), 'utf8')
  expect(welcome).not.toMatch(/seedDefaultSkills|'.\/default-skills'/)
})

test('a team gets no skill by itself: an owner and time pass, the skills folder stays empty', async () => {
  const { root } = await setup()
  await Bun.sleep(100)
  expect(teamSkillFiles(root)).toEqual([])
})

test('the four kept skills install (general + work, the empty page\'s one button), in the team\'s language, as the pack\'s', async () => {
  const { ownerId, root } = await setup()
  for (const id of RECOMMENDED_SKILL_PACKS) {
    const r = installSkillPack(h.ctx, ownerId, id)
    expect(r.skills.every((s) => s.status === 'created')).toBe(true)
  }
  expect(teamSkillFiles(root)).toEqual(KEPT_PATHS)
  for (const [id, names] of Object.entries(KEPT) as [keyof typeof KEPT, readonly string[]][]) {
    for (const n of names) expect(fs.readFileSync(path.join(root, `skills/${id}/${n}/SKILL.md`), 'utf8')).toBe(SKILL_PACKS[id].skills.ko![n]!)
  }
  const me = h.ctx.files.principal(ownerId)
  expect(listSkills(h.ctx.files, me).filter((s) => s.path.startsWith('skills/')).map((s) => s.path).sort()).toEqual(KEPT_PATHS)
  expect(skillIssues(h.ctx.files, me)).toEqual([])
  const events = h.ctx.db.query("SELECT user_id, detail FROM file_events WHERE path LIKE 'skills/%/SKILL.md'").all() as { user_id: string; detail: string }[]
  expect(events).toHaveLength(RECOMMENDED_PACK_SKILLS)
  for (const e of events) { expect(e.user_id).toBe(ownerId); expect(JSON.parse(e.detail).tool).toBe('pack_install') }
  // pressed again: nothing new, nothing replaced
  for (const id of RECOMMENDED_SKILL_PACKS) expect(installSkillPack(h.ctx, ownerId, id).skills.every((s) => s.status === 'present')).toBe(true)
})

test('a team in a language the packs do not have gets the English text', async () => {
  const { ownerId, root } = await setup()
  setSetting(h.ctx.db, 'defaultLocale', 'ja')
  installSkillPack(h.ctx, ownerId, 'work')
  expect(fs.readFileSync(path.join(root, 'skills/work/humanizer/SKILL.md'), 'utf8')).toBe(SKILL_PACKS.work.skills.en.humanizer!)
})

test('the welcome steps install the general pack (three skills) and nothing else, recorded without 할 일 정리; no landing skill', async () => {
  const { ownerId, root } = await setup()
  const r = setupWelcomeTeam(h.ctx, ownerId, 'ko')
  expect(r.outcome).toBe('installed')
  expect(r.progress.general).toMatchObject({ cardNewsPath: GENERAL_CARDNEWS_SKILL, promoVideoPath: GENERAL_PROMO_SKILL, introDeckPath: GENERAL_DECK_SKILL })
  expect(teamSkillFiles(root)).toEqual(KEPT_PATHS.filter((p) => p.startsWith('skills/general/')))
  // nothing to land on: the invite link lands on Home
  expect(landingSkill(h.ctx)).toBeNull()
  // again: nothing runs, no loop
  expect(setupWelcomeTeam(h.ctx, ownerId, 'ko').outcome).toBe('already')
})

test('an existing team: its files stay as they are, its old 할 일 정리 records nothing new and is never the landing skill', async () => {
  const { ownerId, root } = await setup()
  // an older version's general pack: 할 일 정리 and the card news, the row recorded with the old paths
  const old = '---\nname: meeting-tasks\ndescription: 할 일 정리 — 회의록에서 할 일을 정리해요\n---\n# 할 일 정리\n'
  put(root, 'skills/general/meeting-tasks/SKILL.md', old)
  put(root, 'skills/marketing/ad-copy/SKILL.md', '---\nname: ad-copy\ndescription: 광고 문구\n---\n# 광고 문구\n')
  setSetting(h.ctx.db, WELCOME_SETTING, { startedAt: 'x', updatedAt: 'x', teamType: 'marketing', steps: {}, pack: { id: 'marketing', at: 'x', skillPath: 'skills/marketing/ad-copy/SKILL.md' },
    general: { at: 'x', tasksPath: 'skills/general/meeting-tasks/SKILL.md', briefPath: null } })
  const r = setupWelcomeTeam(h.ctx, ownerId, 'ko')
  expect(r.outcome).toBe('already')
  expect(r.install).toBeNull()
  expect(fs.readFileSync(path.join(root, 'skills/general/meeting-tasks/SKILL.md'), 'utf8')).toBe(old)
  expect(fs.existsSync(path.join(root, 'skills/marketing/ad-copy/SKILL.md'))).toBe(true)
  expect(landingSkill(h.ctx)).toBeNull()
})

test('a team with some of the general pack from the Skills page, and none of 할 일 정리: recorded as it is, never blocked', async () => {
  const { ownerId, root } = await setup()
  installSkillPack(h.ctx, ownerId, 'general')
  fs.rmSync(path.join(root, 'skills/general/promo-video'), { recursive: true })
  const r = setupWelcomeTeam(h.ctx, ownerId, 'ko')
  expect(r.outcome).toBe('already')
  expect(r.progress.general).toMatchObject({ cardNewsPath: GENERAL_CARDNEWS_SKILL, introDeckPath: GENERAL_DECK_SKILL })
  expect(r.progress.general?.promoVideoPath).toBeUndefined()
  expect(fs.existsSync(path.join(root, 'skills/general/promo-video'))).toBe(false)
})

test('the general pack kept out by the folder rules is blocked, and tried again when asked again (never a loop of its own)', async () => {
  const { ownerId, root } = await setup()
  // something that is not a skill file sits at every path: nothing can be written
  for (const n of KEPT.general) fs.mkdirSync(path.join(root, `skills/general/${n}/SKILL.md`), { recursive: true })
  const r = setupWelcomeTeam(h.ctx, ownerId, 'ko')
  expect(r.outcome).toBe('blocked')
  expect(r.progress.general).toBeUndefined()
  for (const n of KEPT.general) fs.rmSync(path.join(root, `skills/general/${n}`), { recursive: true })
  expect(setupWelcomeTeam(h.ctx, ownerId, 'ko').outcome).toBe('installed')
})

test('rollback guard: a fresh team\'s row holds all 19 keys of the old seeder as retired, so an older build adds nothing', async () => {
  const { ownerId } = await setup()
  expect([...LEGACY_DEFAULT_SKILL_KEYS]).toHaveLength(19)
  expect(Object.isFrozen(LEGACY_DEFAULT_SKILL_KEYS)).toBe(true)
  expect(LEGACY_DEFAULT_SKILL_KEYS.filter((k) => k.startsWith('general/'))).toHaveLength(5)
  expect(LEGACY_DEFAULT_SKILL_KEYS.filter((k) => k.startsWith('marketing/'))).toHaveLength(7)
  expect(LEGACY_DEFAULT_SKILL_KEYS.filter((k) => k.startsWith('work/'))).toHaveLength(7)
  // every name a pack ever shipped (the 22, hr included): an old copy installed before the install mark stays the pack's
  expect([...LEGACY_PACK_SKILL_NAMES].sort()).toEqual([...Object.values(GONE).flat(), ...Object.values(KEPT).flat()].sort())
  expect(Object.isFrozen(LEGACY_PACK_SKILL_NAMES)).toBe(true)
  setupWelcomeTeam(h.ctx, ownerId, 'ko')
  const row = legacyRow()
  expect(Object.keys(row).sort()).toEqual([...LEGACY_DEFAULT_SKILL_KEYS].sort())
  expect(Object.values(row).every((v) => v.status === 'retired' && !!v.at)).toBe(true)
  // a second run (the next start) writes nothing
  const before = JSON.stringify(row)
  expect(retireLegacyDefaultSkills(h.ctx.db)).toBe(0)
  expect(JSON.stringify(legacyRow())).toBe(before)
})

test('rollback guard: only missing keys are added; what the old seeder recorded stays as it was; a row that does not read is left alone', async () => {
  await setup()
  const old = { 'general/meeting-tasks': { at: '2026-11-06T00:00:00.000Z', status: 'kept' }, 'marketing/ad-copy': { at: '2026-11-06T00:00:00.000Z', status: 'removed' }, 'work/humanizer': { at: '2026-11-07T00:00:00.000Z', status: 'created' } }
  setSetting(h.ctx.db, LEGACY_DEFAULT_SKILLS_SETTING, old)
  expect(retireLegacyDefaultSkills(h.ctx.db, new Date('2026-11-08T00:00:00.000Z'))).toBe(16)
  const row = legacyRow()
  for (const [k, v] of Object.entries(old)) expect(row[k]).toEqual(v)
  expect(Object.keys(row)).toHaveLength(19)
  expect(Object.entries(row).filter(([k]) => !(k in old)).every(([, v]) => v.status === 'retired' && v.at === '2026-11-08T00:00:00.000Z')).toBe(true)
  // not an object: an old seeder does nothing with it, and it is never replaced
  h.ctx.db.query('UPDATE settings SET value = ? WHERE key = ?').run('not json', LEGACY_DEFAULT_SKILLS_SETTING)
  expect(retireLegacyDefaultSkills(h.ctx.db)).toBe(0)
  expect((h.ctx.db.query('SELECT value FROM settings WHERE key = ?').get(LEGACY_DEFAULT_SKILLS_SETTING) as { value: string }).value).toBe('not json')
  // a write only: no file under skills/
  expect(teamSkillFiles(h.ctx.files.fx.root)).toEqual([])
})
