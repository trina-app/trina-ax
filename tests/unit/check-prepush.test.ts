import { expect, test } from 'bun:test'
import { hintsFor, migrationHints, nextFree, sharedWithOpenPrs, takenOnBase } from '../../scripts/check-prepush'

const base = ['001_init.sql', '410_b_wiki.sql', '411_b_x.sql', '301_c_a.sql']

test('nextFree takes the number above the highest of the component, inside its range', () => {
  expect(nextFree('b', [410, 411, 210])).toBe(412)
  expect(nextFree('c', [301])).toBe(302)
  expect(nextFree('', [1, 2])).toBe(3)
  expect(nextFree('z', [])).toBeNull()
})

test('a new file with a number the base has for another file is reported with the number to take', () => {
  const mine = [...base, '410_b_mine.sql']
  expect(takenOnBase(mine, base)).toEqual([{ file: '410_b_mine.sql', number: 410, use: 412 }])
  expect(migrationHints(mine, base)).toEqual(['migration 410 is taken on dev (410_b_mine.sql), use 412'])
  expect(takenOnBase([...base, '412_b_mine.sql'], base)).toEqual([])
  expect(takenOnBase(base, base)).toEqual([])
})

test('two new files on a taken number get different numbers to take', () => {
  const r = takenOnBase([...base, '410_b_one.sql', '411_b_two.sql'], base)
  expect(r.map((x) => x.use)).toEqual([412, 413])
})

test('open PRs that add the same number are named; files already on the base are not', () => {
  const prs = [
    { number: 5, files: ['server/migrations/412_b_other.sql', 'web/x.ts'] },
    { number: 6, files: ['server/migrations/411_b_x.sql'] },
  ]
  expect(sharedWithOpenPrs([...base, '412_b_mine.sql'], prs, base)).toEqual([[412, [5]]])
})

test('hints name the usual fixes', () => {
  expect(hintsFor('check:i18n', 'id.some.key: "kamu" (say Anda)')[0]).toContain('Anda')
  expect(hintsFor('test ', 'no literal product name in user-facing source')[0]).toContain('<app>')
  expect(hintsFor('typecheck', 'error TS2322')).toEqual([])
})
