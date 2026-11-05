// A skill's display title (onboarding polish): a SKILL.md may name itself for people in its metadata (`title`,
// "광고 문구"), while the folder name stays its name and "/<name>" still runs it. Every screen and notice shows the
// title, falling back to the name; a title that is not one line of at most 60 characters is left out, never a reason
// for the skill not to load.
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkSkill, listSkills, parseSkill, skillInfo, skillIssues } from '../../server/src/chat/skills'
import { readSkillTitle, SKILL_TITLE_MAX, SkillInfo, skillSummary, skillTitle } from '@mycel/shared/api'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c-skill-title-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const files = { fx: { root, caseInsensitive: false }, rules: () => ({ canList: () => true, access: () => 'read' }) } as unknown as Parameters<typeof listSkills>[0]
const user = { id: 'reader' } as Parameters<typeof listSkills>[1]
const skill = (name: string, metadata: string) => `---\nname: ${name}\ndescription: 광고 문구 — 광고 문구 3안을 써요.\n${metadata}---\nBody\n`

put('skills/ad-copy/SKILL.md', skill('ad-copy', 'metadata:\n  title: 광고 문구\n  owner: marketing\n'))
put('skills/no-title/SKILL.md', skill('no-title', ''))
put('skills/long-title/SKILL.md', skill('long-title', `metadata:\n  title: ${'가'.repeat(SKILL_TITLE_MAX + 1)}\n`))
put('skills/two-lines/SKILL.md', skill('two-lines', 'metadata:\n  title: "광고\\n문구"\n'))
put('skills/blank/SKILL.md', skill('blank', 'metadata:\n  title: "  "\n'))
// a title that is not text (left empty, a number, a list) is no title; the skill loads all the same
put('skills/list-title/SKILL.md', skill('list-title', 'metadata:\n  title:\n    - 광고\n'))
put('skills/empty-title/SKILL.md', skill('empty-title', 'metadata:\n  title:\n'))
put('skills/number-title/SKILL.md', skill('number-title', 'metadata:\n  title: 2026\n'))
// a direction override would turn the join page's text around
put('skills/bidi-title/SKILL.md', skill('bidi-title', 'metadata:\n  title: "광고\u202e문구"\n'))
// a legacy file's own name is already what people read: no metadata map, no title
put('skills/주간-보고.md', '---\nname: 주간 보고\ndescription: 매주\n---\nLegacy')

test('readSkillTitle: one line of at most 60 characters, trimmed; anything else is no title', () => {
  expect(readSkillTitle(' 광고 문구 ')).toBe('광고 문구')
  expect(readSkillTitle('가'.repeat(SKILL_TITLE_MAX))).toBe('가'.repeat(SKILL_TITLE_MAX))
  for (const bad of [undefined, '', '   ', '가'.repeat(SKILL_TITLE_MAX + 1), 'a\nb', 'a\rb', 'a\tb', 'a\u2028b', 'a\u0085b', 'a\u202eb', 'a\u2066b', 'a\u0000b']) expect(readSkillTitle(bad)).toBeNull()
})

test('a SKILL.md with a title lists it; the name, the folder rule and "/<name>" are unchanged', () => {
  const r = checkSkill(fs.readFileSync(path.join(root, 'skills/ad-copy/SKILL.md'), 'utf8'), 'skills/ad-copy/SKILL.md')
  expect(r).toMatchObject({ ok: true, name: 'ad-copy', title: '광고 문구' })
  expect(parseSkill(fs.readFileSync(path.join(root, 'skills/ad-copy/SKILL.md'), 'utf8'), 'skills/ad-copy/SKILL.md')?.title).toBe('광고 문구')
  const listed = Object.fromEntries(listSkills(files, user).map((s) => [s.path, skillInfo(s)]))
  expect(listed['skills/ad-copy/SKILL.md']).toEqual({ path: 'skills/ad-copy/SKILL.md', name: 'ad-copy', description: '광고 문구 — 광고 문구 3안을 써요.', title: '광고 문구' })
  // without a valid title the listing keeps exactly its old shape, and the skill loads all the same
  for (const name of ['no-title', 'long-title', 'two-lines', 'blank', 'list-title', 'empty-title', 'number-title', 'bidi-title']) expect(listed[`skills/${name}/SKILL.md`]).toEqual({ path: `skills/${name}/SKILL.md`, name, description: '광고 문구 — 광고 문구 3안을 써요.' })
  expect(listed['skills/주간-보고.md']).toEqual({ path: 'skills/주간-보고.md', name: '주간 보고', description: '매주' })
  for (const s of Object.values(listed)) expect(SkillInfo.safeParse(s).success).toBe(true)
  // a title that is too long or not one line is no skill issue: the skill works and shows its name
  expect(skillIssues(files, user).map((i) => i.path).filter((p) => /title|two-lines|blank|ad-copy/.test(p))).toEqual([])
})

test('skillTitle falls back to the name; skillSummary drops a lead that repeats the title', () => {
  expect(skillTitle({ name: 'ad-copy', title: '광고 문구' })).toBe('광고 문구')
  expect(skillTitle({ name: 'ad-copy' })).toBe('ad-copy')
  expect(skillTitle({ name: 'ad-copy', title: null })).toBe('ad-copy')
  expect(skillSummary({ name: 'ad-copy', title: '광고 문구', description: '광고 문구 — 알릴 제품과 실을 곳을 받아 3안을 써요.' })).toBe('알릴 제품과 실을 곳을 받아 3안을 써요.')
  expect(skillSummary({ name: 'ad-copy', title: 'Ad copy', description: 'ad copy — three options.' })).toBe('Three options.')
  // a lead that is not the title, or no title at all: the whole description
  expect(skillSummary({ name: 'ad-copy', title: '광고 문구', description: '배너 문구 — 짧게 써요.' })).toBe('배너 문구 — 짧게 써요.')
  expect(skillSummary({ name: 'ad-copy', description: '광고 문구 — 짧게 써요.' })).toBe('광고 문구 — 짧게 써요.')
  expect(skillSummary({ name: 'x', title: 'X', description: '' })).toBe('')
  // a hyphen or an en dash with spaces is a lead too; a hyphen inside a word is not
  expect(skillSummary({ name: 'ad-copy', title: 'Ad copy', description: 'Ad copy - three options.' })).toBe('Three options.')
  expect(skillSummary({ name: 'ad-copy', title: 'Ad copy', description: 'Ad copy – three options.' })).toBe('Three options.')
  expect(skillSummary({ name: 'e-mail', title: 'E-mail', description: 'E-mail drafts.' })).toBe('E-mail drafts.')
  // the rest starts as a sentence (the English pack writes "Ad copy — takes …"); other scripts and a capital stay
  expect(skillSummary({ name: 'meeting-tasks', title: 'Tasks from notes', description: "Tasks from notes — reads the team's meeting notes." })).toBe("Reads the team's meeting notes.")
  expect(skillSummary({ name: 'x', title: 'Weekly meeting tasks', description: 'Weekly meeting tasks — Turns the notes into tasks.' })).toBe('Turns the notes into tasks.')
  expect(skillSummary({ name: 'x', title: 'Key points', description: 'Key points — 3–7 points with sources.' })).toBe('3–7 points with sources.')
})
