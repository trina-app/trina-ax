import { expect, test } from 'bun:test'
import type { SkillIssue } from '@mycel/shared/api'
import { isSkillsPath, issuesIn, issueText } from '../../src/lib/skillIssues'
import { ko } from '../../src/i18n/ko'
import { en } from '../../src/i18n/en'
import { es } from '../../src/i18n/es'
import { id } from '../../src/i18n/id'
import { ja } from '../../src/i18n/ja'

const items: SkillIssue[] = [
  { path: 'skills/wrong-folder-qa/SKILL.md', problem: 'name_folder' },
  { path: 'skills/재무/broken.md', problem: 'header' },
]

test('R2-SKILL-03: the Files screen shows the issues in and below the open skills folder', () => {
  expect(isSkillsPath('skills')).toBe(true)
  expect(isSkillsPath('skills/재무')).toBe(true)
  expect(isSkillsPath('skillset')).toBe(false)
  expect(isSkillsPath('')).toBe(false)
  expect(issuesIn(items, 'skills')).toEqual(items)
  expect(issuesIn(items, 'skills/wrong-folder-qa').map(i => i.path)).toEqual(['skills/wrong-folder-qa/SKILL.md'])
  expect(issuesIn(items, 'skills/재무').map(i => i.problem)).toEqual(['header'])
  expect(issuesIn(items, 'skills/other')).toEqual([])
  expect(issuesIn(items)).toEqual(items)
})

test('R2-SKILL-03: a name that is not ASCII shows in its own folder, in skills/ and in a personal folder', () => {
  const name: SkillIssue[] = [
    { path: 'skills/jdr-견적/SKILL.md', problem: 'name' },
    { path: 'skills/jdr-quote/SKILL.md', problem: 'name' },
    { path: 'users/alice/skills/jdr-견적/SKILL.md', problem: 'name' },
  ]
  expect(issuesIn(name, 'skills').map(i => i.path)).toEqual(['skills/jdr-견적/SKILL.md', 'skills/jdr-quote/SKILL.md'])
  expect(issuesIn(name, 'skills/jdr-견적').map(i => i.path)).toEqual(['skills/jdr-견적/SKILL.md'])
  expect(isSkillsPath('skills/jdr-견적')).toBe(true)
  expect(isSkillsPath('users/alice/skills/jdr-견적')).toBe(true)
  expect(issuesIn(name, 'users/alice/skills').map(i => i.path)).toEqual(['users/alice/skills/jdr-견적/SKILL.md'])
  // a project folder is not a skill folder: the Files screen shows no skill warning there
  expect(isSkillsPath('projects/jdr-video/skills/jdr-견적')).toBe(false)
})

test('the name text of a SKILL.md gives the folder name; a legacy file has its own rule', () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}|${params?.folder}`
  expect(issueText(t, { path: 'skills/jdr-quote/SKILL.md', problem: 'name' })).toBe('skills.issues.name|jdr-quote')
  expect(issueText(t, { path: 'skills/report/notes.md', problem: 'name' }).split('|')[0]).toBe('skills.issues.name_legacy')
  expect(issueText(t, { path: 'skills/jdr-quote/SKILL.md', problem: 'name_folder' })).toBe('skills.issues.name_folder|jdr-quote')
})

test('every language names the rule of a SKILL.md name', () => {
  for (const m of [ko, en, es, id, ja]) {
    const text = m['skills.issues.name']
    for (const part of ['a', 'z', '0', '9', '64', '{folder}']) expect(text).toContain(part)
    expect(m['skills.issues.name_legacy']).toContain('60')
  }
})
