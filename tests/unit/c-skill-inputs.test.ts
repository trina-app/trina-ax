// Onboarding stream C: a skill's input form, declared in its header's metadata (`inputs`, a small JSON list,
// shared/src/api/skill-inputs.ts). A valid form is listed with the skill; one that does not parse never stops the
// skill from loading: it runs without its form, and the people who can read it see an `inputs` skill issue.
import { afterAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkSkill, listSkills, skillInfo, skillIssues, skillWriteNote } from '../../server/src/chat/skills'
import { parseSkillInputs, SkillInfo, SkillIssue } from '@mycel/shared/api'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c-skill-inputs-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}
const files = { fx: { root, caseInsensitive: false }, rules: () => ({ canList: () => true, access: () => 'read' }) } as unknown as Parameters<typeof listSkills>[0]
const user = { id: 'reader' } as Parameters<typeof listSkills>[1]

const manifest = (name: string, inputs: string | null, extra = '') =>
  `---\nname: ${name}\ndescription: A skill.\n${extra}${inputs === null ? '' : `metadata:\n  owner: marketing\n  inputs: |\n${inputs.split('\n').map((l) => `    ${l}`).join('\n')}\n`}---\nBody\n`
const FORM = JSON.stringify([
  { name: 'product', label: '알릴 제품', placeholder: '예: 구독 요금제', required: true, prefill: 'company.products' },
  { name: 'notes', label: 'Notes', multiline: true },
  { name: 'tone', label: 'Tone', prefill: 'company.tone' },
], null, 1)

put('skills/with-form/SKILL.md', manifest('with-form', FORM))
put('skills/no-form/SKILL.md', manifest('no-form', null))
put('skills/bad-json/SKILL.md', manifest('bad-json', '[{"name": "product", "label": "x",]'))
put('skills/bad-key/SKILL.md', manifest('bad-key', JSON.stringify([{ name: 'product', label: 'x', prefill: 'company.revenue' }])))
// JSON is YAML: a form without "|" is a YAML list, not one text
put('skills/json-line/SKILL.md', `---\nname: json-line\ndescription: A skill.\nmetadata:\n  inputs: [{"name": "product", "label": "제품"}]\n---\nBody\n`)
put('skills/yaml-list/SKILL.md', '---\nname: yaml-list\ndescription: A skill.\nmetadata:\n  inputs:\n    - name: product\n      label: 제품\n---\nBody\n')
// the largest form the rules allow, in Korean (3 bytes a letter), with a long Korean description: a valid header of
// more than 8 KB
const BIG = JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, label: '가'.repeat(60), placeholder: '나'.repeat(200), required: true, prefill: 'company.products', multiline: true })))
put('skills/big-form/SKILL.md', manifest('big-form', BIG).replace('description: A skill.', `description: ${'설명'.repeat(500)}`))
put('skills/legacy.md', '---\nname: 옛 스킬\ndescription: legacy\nmetadata: {"inputs": "[]"}\n---\nLegacy')

test('parseSkillInputs: a list of fields, or a short reason', () => {
  expect(parseSkillInputs(FORM)).toEqual({ ok: true, inputs: JSON.parse(FORM) })
  const bad = (raw: string) => { const r = parseSkillInputs(raw); return r.ok ? null : r.reason }
  expect(bad('[{"name": "a", "label": "A"')).toBe('not valid JSON')
  expect(bad('{"name": "a", "label": "A"}')).toBeTruthy() // not a list
  expect(bad('[]')).toBeTruthy() // an empty form is not a form
  expect(bad(JSON.stringify([{ name: 'a', label: 'A', colour: 'red' }]))).toBeTruthy() // unknown keys are typos
  expect(bad(JSON.stringify([{ name: 'a', label: 'A' }, { name: 'a', label: 'B' }]))).toContain('different')
  expect(bad(JSON.stringify([{ name: 'Product', label: 'A' }]))).toContain('0.name')
  expect(bad(JSON.stringify([{ name: 'a', label: 'line\nbreak' }]))).toBeTruthy()
  expect(bad(JSON.stringify([{ name: 'a', label: 'A', prefill: 'company.revenue' }]))).toContain('prefill')
  expect(bad(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, label: 'A' }))))).toBeTruthy()
})

test('a SKILL.md with a valid form lists it; without one, nothing changes', () => {
  const ok = checkSkill(fs.readFileSync(path.join(root, 'skills/with-form/SKILL.md'), 'utf8'), 'skills/with-form/SKILL.md')
  expect(ok).toMatchObject({ ok: true, name: 'with-form', inputs: JSON.parse(FORM) })
  // a skill without a form keeps exactly its old shape (callers compare it whole)
  expect(checkSkill(fs.readFileSync(path.join(root, 'skills/no-form/SKILL.md'), 'utf8'), 'skills/no-form/SKILL.md'))
    .toEqual({ ok: true, name: 'no-form', description: 'A skill.', body: 'Body\n' })
  const listed = listSkills(files, user)
  const info = listed.map(skillInfo)
  expect(info.find((s) => s.name === 'with-form')).toEqual({ path: 'skills/with-form/SKILL.md', name: 'with-form', description: 'A skill.', inputs: JSON.parse(FORM) })
  expect(info.find((s) => s.name === 'no-form')).toEqual({ path: 'skills/no-form/SKILL.md', name: 'no-form', description: 'A skill.' })
  for (const s of info) expect(SkillInfo.parse(s)).toEqual(s)
})

test('a form that does not parse: the skill still loads, without a form, and is a loader warning (not a crash)', () => {
  const listed = listSkills(files, user)
  for (const name of ['bad-json', 'bad-key', 'json-line', 'yaml-list', 'big-form']) {
    const s = listed.find((x) => x.name === name)
    expect(s, name).toBeDefined()
    expect(s!.inputs).toBeUndefined()
    expect(skillInfo(s!)).not.toHaveProperty('inputs')
  }
  const issues = skillIssues(files, user)
  expect(issues).toEqual([
    { path: 'skills/bad-json/SKILL.md', problem: 'inputs' },
    { path: 'skills/bad-key/SKILL.md', problem: 'inputs' },
    { path: 'skills/big-form/SKILL.md', problem: 'inputs' },
    { path: 'skills/json-line/SKILL.md', problem: 'inputs' },
    { path: 'skills/yaml-list/SKILL.md', problem: 'inputs' },
  ])
  for (const i of issues) expect(SkillIssue.parse(i)).toEqual(i)
  // a legacy file has no metadata map: its header is not a form, and it is no issue
  expect(listed.find((s) => s.name === '옛 스킬')?.inputs).toBeUndefined()
})

test('a form written as YAML (a list, or JSON without "|") loads the skill without it and says how to write it', () => {
  for (const name of ['json-line', 'yaml-list']) {
    const text = fs.readFileSync(path.join(root, `skills/${name}/SKILL.md`), 'utf8')
    const r = checkSkill(text, `skills/${name}/SKILL.md`)
    expect(r).toMatchObject({ ok: true, name, description: 'A skill.', body: 'Body\n' })
    expect(r.ok && r.badInputs).toContain('inputs: |')
    expect(skillWriteNote(root, `skills/${name}/SKILL.md`, Buffer.from(text))).toContain('write "inputs: |"')
  }
  // any other metadata value that is not text still breaks the header, as before
  expect(checkSkill('---\nname: x\ndescription: d\nmetadata:\n  tags: [a, b]\n---\n', 'skills/x/SKILL.md')).toEqual({ ok: false, problem: 'header' })
})

test('a form that makes the header larger than 8 KB: the skill loads without it and the issue says why', () => {
  const text = fs.readFileSync(path.join(root, 'skills/big-form/SKILL.md'), 'utf8')
  expect(parseSkillInputs(BIG).ok).toBe(true) // a valid form, only too large for the header
  const r = checkSkill(text, 'skills/big-form/SKILL.md')
  expect(Buffer.byteLength(text)).toBeGreaterThan(8 * 1024)
  expect(r).toMatchObject({ ok: true, name: 'big-form', description: '설명'.repeat(500), body: 'Body\n' })
  expect(r.ok && r.badInputs).toMatch(/header is \d+ bytes, over the 8 KB limit/)
  // without a form to leave out, an oversized header is a broken header, as before
  const long = `---\nname: long\ndescription: ${'다'.repeat(1000)}\nmetadata:\n${Array.from({ length: 60 }, (_, i) => `  k${i}: ${'라'.repeat(40)}`).join('\n')}\n---\nBody\n`
  expect(checkSkill(long, 'skills/long/SKILL.md')).toEqual({ ok: false, problem: 'header' })
})

test('the AI is told when a skill it saved loads without its form', () => {
  const bad = Buffer.from(manifest('bad-json', '[1, 2'))
  expect(skillWriteNote(root, 'skills/bad-json/SKILL.md', bad)).toContain('its form (metadata inputs) does not: not valid JSON')
  expect(skillWriteNote(root, 'skills/with-form/SKILL.md', Buffer.from(manifest('with-form', FORM)))).toBe('')
  // outside the skill roots a SKILL.md is another tool's file: no note
  expect(skillWriteNote(root, 'shared/x/bad-json/SKILL.md', bad)).toBe('')
})
