import { expect, test } from 'bun:test'
import type { SkillIssue } from '@mycel/shared/api'
import { isSkillsPath, issuesIn } from '../../src/lib/skillIssues'

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
