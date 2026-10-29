// R2-SKILL-03 / R2-SKILL-04: entries that look like skills but do not load are reported with a reason code, a broken
// legacy header is neither a skill nor a team rule, and the header the server writes for a registered suggestion
// still loads.
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkSkill, listSkills, parseSkill, skillFileKind, skillIssues } from '../../server/src/chat/skills'
import { teamRules } from '../../server/src/chat/prompt'
import { registeredSkillText, skillFileText } from '../../server/src/skills/suggestions'
import { SkillIssue } from '@mycel/shared/api'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-issues-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const files = { fx: { root, caseInsensitive: false }, rules: () => ({ canList: (_u: unknown, segs: string[]) => !segs.includes('private'), access: (_u: unknown, segs: string[]) => segs.includes('private') ? 'none' : 'read' }) } as unknown as Parameters<typeof listSkills>[0]
const user = { id: 'reader' } as Parameters<typeof listSkills>[1]

put('skills/good/SKILL.md', '---\nname: good\ndescription: Works.\n---\nBody')
put('skills/wrong-folder-qa/SKILL.md', '---\nname: press-release-qa-other\ndescription: Name differs from folder.\n---\nBody')
put('skills/no-description/SKILL.md', '---\nname: no-description\n---\nBody')
put('skills/bad-yaml/SKILL.md', '---\nname: bad-yaml\ndescription: "open\n---\nBody')
put('skills/legacy.md', '---\nname: 주간 보고서\ndescription: 한국어 기존 형식\n---\nLegacy body')
put('skills/open-quote.md', '---\nname: 열린 따옴표\ndescription: "닫히지 않은 따옴표\n---\nOPEN_QUOTE')
put('skills/broken-dup.md', '---\nname: 깨진 머리말\nname: 두 번째 이름\n---\nBROKEN_DUP')
put('skills/broken-line.md', '---\nname: 깨진 머리말 2\n이 줄은 키가 없다\n---\nBROKEN_LINE')
put('skills/no-name.md', '---\ndescription: no name\n---\nNO_NAME')
put('skills/plain-rule.md', 'PLAIN_RULE')
put('skills/private/hidden/SKILL.md', '---\nname: other\ndescription: d\n---\nHIDDEN')
put('skills/good/references/broken.md', '---\nbroken: "\n---\nRESOURCE')

test('R2-SKILL-03: invalid manifests and broken headers are reported with a code, readable entries only', () => {
  const issues = skillIssues(files, user)
  expect(issues).toEqual([
    { path: 'skills/bad-yaml/SKILL.md', problem: 'header' },
    { path: 'skills/broken-dup.md', problem: 'header' },
    { path: 'skills/broken-line.md', problem: 'header' },
    { path: 'skills/no-description/SKILL.md', problem: 'description' },
    { path: 'skills/no-name.md', problem: 'name' },
    { path: 'skills/wrong-folder-qa/SKILL.md', problem: 'name_folder' },
  ])
  for (const i of issues) expect(SkillIssue.parse(i)).toEqual(i)
  // the hidden folder, the plain rule, the valid entries and resource files are never reported
  expect(JSON.stringify(issues)).not.toContain('private')
  expect(listSkills(files, user).map(s => s.path)).toEqual(['skills/good/SKILL.md', 'skills/open-quote.md', 'skills/legacy.md'])
})

test('R2-SKILL-04: a broken legacy header is not a skill and not a team rule', () => {
  for (const rel of ['skills/broken-dup.md', 'skills/broken-line.md']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8')
    expect(parseSkill(text, rel)).toBeNull()
    expect(checkSkill(text, rel)).toEqual({ ok: false, problem: 'header' })
    expect(skillFileKind(root, rel, text)).toBe('other')
  }
  const rules = teamRules(files, user)
  expect(rules).toContain('PLAIN_RULE')
  expect(rules).not.toContain('BROKEN_DUP')
  expect(rules).not.toContain('OPEN_QUOTE')
  expect(rules).not.toContain('BROKEN_LINE')
})

test('legacy headers keep their loose value format and valid YAML still loads', () => {
  expect(parseSkill('---\nname: 보고서\ndescription: 단계: 읽고 # 쓴다 - "인용" 포함\n---\nB')).toEqual({ name: '보고서', description: '단계: 읽고 # 쓴다 - "인용" 포함', body: 'B' })
  expect(parseSkill("---\nname: 'x y'\n# comment\n\ndescription:\n---\nB")).toEqual({ name: 'x y', description: '', body: 'B' })
  expect(parseSkill('---\nname: 블록\ndescription: >\n  여러 줄\n  설명\n---\nB')?.name).toBe('블록')
  expect(parseSkill('---\nname:주간\ndescription:설명\n---\nB')).toEqual({ name: '주간', description: '설명', body: 'B' })
  expect(parseSkill('---\nname: 보고서\n설명: 한국어 키는 무시\ndescription: [팀] 주간 {보고}\n---\nB')?.description).toBe('[팀] 주간 {보고}')
  expect(parseSkill('---\nname: a\nname: b\n---\nB')).toBeNull()
  expect(parseSkill('---\nname: a\n---\nB')).not.toBeNull()
})

test('a legacy value whose opening quote or bracket does not close is plain text and still loads', () => {
  for (const v of ['[긴급 처리용', '{broken', '"Draft mode', "'til month end, summarize sales"]) {
    expect(parseSkill(`---\nname: a\ndescription: ${v}\n---\nB`)).toEqual({ name: 'a', description: v, body: 'B' })
    expect(parseSkill(`---\nname: ${v}\ndescription: d\n---\nB`)?.name).toBe(v)
  }
  // only real breakage is rejected: a line without a colon, a duplicate key
  expect(checkSkill('---\nname: a\nno colon here\n---\nB')).toEqual({ ok: false, problem: 'header' })
  expect(checkSkill('---\nname: a\nNAME: b\n---\nB')).toEqual({ ok: false, problem: 'header' })
  // quoted legacy values follow the YAML rules
  expect(parseSkill(`---\nname: 'it''s'\ndescription: "say \\"hi\\""\n---\nB`)).toEqual({ name: "it's", description: 'say "hi"', body: 'B' })
  expect(parseSkill('---\nname: a\ndescription: "C:\\path"\n---\nB')?.description).toBe('C:\\path')
})

const REVIEW_VALUES = [
  ['주간: 보고서', 'Steps: read # then "write" it'], ['- 목록', "'quoted' start"], ['plain', ''],
  ['[팀 보고', "'til month end, summarize sales"], ['초안', '"Draft mode'], ['고객', '{고객명 placeholder'],
  ["'quoted'", '"both"'], ['back\\slash', 'tab\there'], ['  spaces  ', 'line\nbreak'], ['# hash', '| pipe > fold'],
]

test('the header written for a registered suggestion always loads with the typed text', () => {
  for (const [name, description] of REVIEW_VALUES) {
    const text = skillFileText(name!, description!, 'Steps')
    const check = checkSkill(text, 'skills/new.md')
    expect(check).toEqual({ ok: true, name: name!.trim(), description: description!.replace(/[\r\n]+/g, ' ').trim(), body: 'Steps\n' })
    expect(skillFileKind(root, 'skills/new.md', text)).toBe('skill')
    expect(registeredSkillText('skills/new.md', name!, description!, 'Steps')).toEqual({ ok: true, text })
  }
})

test('a registered suggestion that would not load is refused before the save', () => {
  // fileName "SKILL" makes a manifest: its name must be the folder name
  expect(registeredSkillText('skills/report/SKILL.md', '주간 보고서', 'd', 'Steps')).toEqual({ ok: false, problem: 'name', field: 'body.name' })
  expect(registeredSkillText('skills/report/SKILL.md', 'other', 'd', 'Steps')).toEqual({ ok: false, problem: 'name_folder', field: 'body.name' })
  expect(registeredSkillText('skills/report/SKILL.md', 'report', '', 'Steps')).toEqual({ ok: false, problem: 'description', field: 'body.description' })
  expect(registeredSkillText('skills/report/SKILL.md', 'report', 'Makes "reports": [weekly', 'Steps').ok).toBe(true)
})

test('a line break character in a typed value becomes a space, so the value reads back as one header line', () => {
  for (const sep of [' ', ' ', '\u0085', '\v', '\f', '\r\n']) {
    const text = skillFileText(`이름${sep}둘`, `line one${sep}line two`, 'Body')
    expect(checkSkill(text, 'skills/x.md')).toEqual({ ok: true, name: '이름 둘', description: 'line one line two', body: 'Body\n' })
    const r = registeredSkillText('skills/x.md', `a${sep}b`, `c${sep}d`, 'Body')
    expect(r.ok).toBe(true)
  }
})

test('a duplicate key in any case breaks a legacy header, also after a line that is not key: value', () => {
  for (const header of [
    'description: |\n  multi\nname: a\nNAME: b',
    'name: a\ndescription: >\n  folded\nName: b',
    'name: a\nNAME: b',
  ]) expect(checkSkill(`---\n${header}\n---\nBody`, 'skills/x.md')).toEqual({ ok: false, problem: 'header' })
  // an indented key inside a block scalar is text, not a duplicate (the legacy reader keeps the block marker)
  expect(checkSkill('---\nname: a\ndescription: |\n  name: b\n---\nBody', 'skills/x.md'))
    .toEqual({ ok: true, name: 'a', description: '|', body: 'Body' })
})
