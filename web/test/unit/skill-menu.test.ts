import { describe, expect, test } from 'bun:test'
import { matchSkills } from '../../src/components/chat/SkillMenu'

const skills = [
  { path: 'skills/weekly.md', name: '주간 보고서', description: '이번 주 보고서' },
  { path: 'skills/minutes.md', name: '회의록 정리', description: '' },
  { path: 'skills/재무/close.md', name: '월말 결산', description: '' },
]

describe('"/" skill menu', () => {
  test('opens on a leading "/" and filters by name or path', () => {
    expect(matchSkills(skills, '/')?.map((s) => s.name)).toEqual(['주간 보고서', '회의록 정리', '월말 결산'])
    expect(matchSkills(skills, '/보고')?.map((s) => s.name)).toEqual(['주간 보고서'])
    expect(matchSkills(skills, '/재무')?.map((s) => s.name)).toEqual(['월말 결산'])
  })
  test('names that start with the query come first', () => {
    const r = matchSkills([{ path: 'a', name: '보고서 요약', description: '' }, { path: 'b', name: '주간 보고서', description: '' }], '/보고')
    expect(r?.map((s) => s.name)).toEqual(['보고서 요약', '주간 보고서'])
  })
  test('closed: no leading slash, a new line, or a chosen skill followed by its input', () => {
    expect(matchSkills(skills, '주간')).toBeNull()
    expect(matchSkills(skills, '/주간\n')).toBeNull()
    expect(matchSkills(skills, '/주간 보고서 이번 주')).toBeNull()
    expect(matchSkills(skills, '/없는것')).toEqual([])
  })
})
