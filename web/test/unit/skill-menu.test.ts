import { describe, expect, test } from 'bun:test'
import { matchSkills, scrollToShow } from '../../src/components/chat/SkillMenu'

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
  // App review 2026-11-01: the 6th skill was cut off, and the 9th onwards were never listed
  test('every skill that fits is listed, not only the first eight', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ path: `skills/s${i + 1}.md`, name: `skill ${String(i + 1).padStart(2, '0')}`, description: '' }))
    expect(matchSkills(many, '/')).toHaveLength(20)
    expect(matchSkills(many, '/skill 1')?.map((s) => s.name)).toEqual(['skill 10', 'skill 11', 'skill 12', 'skill 13', 'skill 14', 'skill 15', 'skill 16', 'skill 17', 'skill 18', 'skill 19'])
  })
})

describe('the chosen row stays in sight', () => {
  const view = { scrollTop: 0, height: 256 }
  test('a row already in sight: the list does not move', () => {
    expect(scrollToShow({ top: 48, height: 48 }, view)).toBe(0)
    expect(scrollToShow({ top: 208, height: 48 }, view)).toBe(0)
  })
  test('a row below: its bottom comes to the bottom; above: its top to the top', () => {
    // the 6th row (rows of 48 px) is cut at 256 px: the list moves by the part that was hidden
    expect(scrollToShow({ top: 240, height: 48 }, view)).toBe(32)
    expect(scrollToShow({ top: 912, height: 48 }, view)).toBe(704)
    expect(scrollToShow({ top: 0, height: 48 }, { scrollTop: 704, height: 256 })).toBe(0)
    expect(scrollToShow({ top: 480, height: 48 }, { scrollTop: 600, height: 256 })).toBe(480)
  })
})
