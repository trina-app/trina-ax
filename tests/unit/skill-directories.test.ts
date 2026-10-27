import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokedSkill, listSkills, parseSkill } from '../../server/src/chat/skills'
import { skillBlock, skillsSection, teamRules } from '../../server/src/chat/prompt'
import { SkillInfo } from '@mycel/shared/api'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4-skills-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const manifest = (name: string, description = 'Reports when asked.') => `---\nname: ${name}\ndescription: ${description}\n---\nRead references/guide.md only when needed.\n`
const files = { fx: { root, caseInsensitive: false }, rules: () => ({ canList: (_u: unknown, segs: string[]) => !segs.includes('private'), access: (_u: unknown, segs: string[]) => segs.includes('private') ? 'none' : 'read' }) } as unknown as Parameters<typeof listSkills>[0]
const user = { id: 'reader' } as Parameters<typeof listSkills>[1]
const parse = (header: string, name = 'weekly-report') => parseSkill(`---\n${header}\n---\nBody`, `skills/${name}/SKILL.md`)

put('skills/weekly-report/SKILL.md', manifest('weekly-report', '>\n  Summarizes weekly meetings\n  when a report is requested.'))
put('skills/weekly-report/references/guide.md', '---\nname: Accidental resource skill\n---\nRESOURCE_ONLY')
put('skills/weekly-report/assets/template.md', 'RESOURCE_TEMPLATE')
put('skills/weekly-report/scripts/run.sh', 'touch should-never-run')
put('skills/broken/SKILL.md', '---\nname: broken\n---\nINVALID_MANIFEST')
put('skills/broken/resource.md', '---\nname: Invalid package resource\n---\nNO_RESOURCE_SKILL')
put('skills/legacy.md', '---\nname: 주간 보고서\ndescription: 한국어 기존 형식\n---\nLegacy body')
put('skills/private/secret/SKILL.md', manifest('secret'))
put('skills/plain-rule.md', 'PLAIN_RULE')
put('skills/invalid-header.md', '---\nname: a/b\n---\nINVALID_AUTO_RULE')
put('skills/SKILL.md', '---\nname: skills\ndescription: invalid root entry\n---\nROOT_MANIFEST')

test('standard folders have one manifest entry, valid multiline YAML and no resource entries', () => {
  const skills = listSkills(files, user)
  expect(skills.map(s => s.path).sort()).toEqual(['skills/legacy.md', 'skills/weekly-report/SKILL.md'])
  expect(skills.find(s => s.name === 'weekly-report')?.description).toBe('Summarizes weekly meetings when a report is requested.')
  expect(SkillInfo.parse(skills.find(s => s.name === 'weekly-report')).name).toBe('weekly-report')
})

test('folder commands use their names; SKILL is not a shared command alias', () => {
  const skills = listSkills(files, user)
  expect(invokedSkill(skills, '/weekly-report now')?.skill.path).toBe('skills/weekly-report/SKILL.md')
  expect(invokedSkill(skills, '/SKILL')).toBeNull()
  expect(invokedSkill(skills, '/legacy')?.skill.name).toBe('주간 보고서')
})

test('standard metadata boundaries preserve 64 names and 1024 description characters', () => {
  const name = 'a'.repeat(64), description = '한'.repeat(1024)
  expect(parse(`name: ${name}\ndescription: ${description}`, name)).toMatchObject({ name, description })
  expect(parse(`name: ${name}a\ndescription: d`, name + 'a')).toBeNull()
  expect(parse(`name: weekly-report\ndescription: ${description}a`)).toBeNull()
})

test('standard YAML handles quotes, comments, literal blocks, and string metadata', () => {
  expect(parse('name: "weekly-report" # comment\ndescription: |-\n  One: part\n  Two # literal\nmetadata:\n  author: "team"\n  version: "1.0"\nlicense: MIT\ncompatibility: Team AX\nallowed-tools: Bash(*) Read')).toEqual({ name: 'weekly-report', description: 'One: part\nTwo # literal', body: 'Body' })
})

test('invalid standard names, missing fields, types and malformed YAML never become skills', () => {
  for (const header of [
    'name: another\ndescription: d', 'name: Weekly-report\ndescription: d', 'name: -weekly-report\ndescription: d',
    'name: weekly--report\ndescription: d', 'name: weekly-report', 'name: weekly-report\ndescription: " "',
    'name: weekly-report\ndescription: 123', 'name: [weekly-report]\ndescription: d',
    'name: weekly-report\ndescription: d\nname: weekly-report', 'name: weekly-report\ndescription: [broken',
    'name: weekly-report\ndescription: d\nmetadata: {author: [nested]}',
    'name: weekly-report\ndescription: d\nmetadata: {version: 1}',
    'name: weekly-report\ndescription: d\ncompatibility: ' + 'a'.repeat(501),
    'name: weekly-report\ndescription: d\nallowed-tools: [Read]',
  ]) expect(parse(header)).toBeNull()
})

test('aliases, recursive structures, custom tags and oversized YAML are refused without expansion', () => {
  for (const header of [
    'name: weekly-report\ndescription: &anchor d\nmetadata: {copy: *anchor}',
    'name: weekly-report\ndescription: d\nmetadata: &loop {loop: *loop}',
    'name: weekly-report\ndescription: !custom d',
    'name: weekly-report\ndescription: d\nextra: ' + '['.repeat(2000) + 'x' + ']'.repeat(2000),
    'name: weekly-report\ndescription: d\n#' + 'x'.repeat(20000),
  ]) expect(parse(header)).toBeNull()
})

test('metadata/resources stay out of automatic rules and prompt gives the permission-bound resource base', () => {
  const rules = teamRules(files, user)
  expect(rules).toContain('PLAIN_RULE')
  for (const hidden of ['RESOURCE_', 'INVALID_', 'ROOT_MANIFEST']) expect(rules).not.toContain(hidden)
  const section = skillsSection(files, user)
  expect(section).toContain('allowed-tools')
  expect(section).toContain('scripts')
  expect(section).not.toContain('RESOURCE_ONLY')
  const skill = listSkills(files, user).find(s => s.name === 'weekly-report')!
  const block = skillBlock(skill, 'now')
  expect(block).toContain('skills/weekly-report/')
  expect(block).toContain('read')
  expect(block).not.toContain('RESOURCE_ONLY')
})

test('oversize manifests and symlink/hardlink files and directory chains are not discovered', () => {
  put('skills/oversize/SKILL.md', manifest('oversize') + 'x'.repeat(140 * 1024))
  put('outside/SKILL.md', manifest('linked'))
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'skills/linked'))
  put('outside/hard.md', manifest('hard'))
  fs.mkdirSync(path.join(root, 'skills/hard'))
  fs.linkSync(path.join(root, 'outside/hard.md'), path.join(root, 'skills/hard/SKILL.md'))
  fs.mkdirSync(path.join(root, 'skills/symbolic'))
  fs.symlinkSync(path.join(root, 'outside/hard.md'), path.join(root, 'skills/symbolic/SKILL.md'))
  expect(listSkills(files, user).map(s => s.path).sort()).toEqual(['skills/legacy.md', 'skills/weekly-report/SKILL.md'])
})

test('a real skill name wins over a legacy filename alias regardless of list ordering', () => {
  const alias = { path: 'skills/weekly-report.md', name: 'AAA legacy', description: '', body: 'legacy' }
  const folder = { path: 'skills/weekly-report/SKILL.md', name: 'weekly-report', description: 'd', body: 'folder' }
  expect(invokedSkill([alias, folder], '/weekly-report')?.skill.path).toBe(folder.path)
  expect(invokedSkill([folder, alias], '/weekly-report')?.skill.path).toBe(folder.path)
})

test('standard description limits count Unicode characters, not UTF-16 code units', () => {
  const description = '😀'.repeat(1024)
  expect(parse(`name: weekly-report\ndescription: ${description}`)?.description).toBe(description)
  expect(parse(`name: weekly-report\ndescription: ${description}😀`)).toBeNull()
})
