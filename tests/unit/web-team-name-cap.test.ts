import { expect, test } from 'bun:test'
import { capTeamName } from '../../web/src/lib/teamName'
import { TEAM_NAME_MAX, teamNameProblem } from '@mycel/shared/cloud-protocol/team-name'

test('plain text: kept up to 60 characters, cut after', () => {
  expect(capTeamName('A'.repeat(60))).toBe('A'.repeat(60))
  expect(capTeamName('A'.repeat(75))).toBe('A'.repeat(60))
  expect(capTeamName('포텐랩')).toBe('포텐랩')
})

test('emoji count one each, not two: 60 emoji stay, a 61st is cut, no split pair', () => {
  const e = '\u{1F642}'
  expect(capTeamName(e.repeat(60))).toBe(e.repeat(60))
  const cut = capTeamName(e.repeat(70))
  expect([...cut].length).toBe(60)
  expect(teamNameProblem(cut)).toBeNull()
})

test('a zero-width joiner sequence at the boundary leaves no dangling joiner or lone surrogate', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
  const text = 'A'.repeat(TEAM_NAME_MAX - 2) + family // the cut falls right after the first joiner (58 + 👨 ZWJ)
  const cut = capTeamName(text)
  expect(cut.endsWith('‍')).toBe(false)
  expect(cut).toBe('A'.repeat(TEAM_NAME_MAX - 2) + '\u{1F468}')
  expect(teamNameProblem(cut)).toBeNull()
  // a whole sequence that fits is kept
  const fits = 'A'.repeat(TEAM_NAME_MAX - 5) + family
  expect(capTeamName(fits)).toBe(fits)
  // a lone surrogate at the cut is dropped
  expect(capTeamName('A'.repeat(59) + '\uD83D' + 'B')).toBe('A'.repeat(59))
})
