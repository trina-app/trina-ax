// CI's unit test shards (scripts/ci/unit-shard.ts, .github/workflows/ci.yml "unit"): every test file runs in exactly
// one shard, the split is the same in every job, and the shards come out near the same length.
import { expect, test } from 'bun:test'
import { split, timesFromLog, unitFiles } from '../../scripts/ci/unit-shard'
import times from '../../scripts/ci/unit-times.json'

test('every unit test file is in exactly one of the 5 shards, and the split does not change between runs', () => {
  const files = unitFiles()
  expect(files.length).toBeGreaterThan(100)
  expect(files).toContain('tests/unit/ci-unit-shard.test.ts')
  const a = split(files, times, 5), b = split(files, times, 5)
  expect(a).toEqual(b)
  expect(a.flatMap((s) => s.files).sort()).toEqual(files)
  // the longest shard is at most a quarter longer than the shortest
  const secs = a.map((s) => s.seconds)
  expect(Math.max(...secs)).toBeLessThanOrEqual(Math.min(...secs) * 1.25)
})

test('a file without a time counts as the median; one shard takes everything', () => {
  const s = split(['a', 'b', 'c', 'new'], { a: 10, b: 1, c: 1 }, 2)
  expect(s.map((x) => x.files)).toEqual([['a'], ['b', 'c', 'new']])
  expect(split(['x', 'y'], {}, 1)[0]!.files).toEqual(['x', 'y'])
})

test("times come from a CI log: from one file's header to the next, the last to the summary line", () => {
  const log = [
    '2026-11-09T07:06:11.5000000Z ##[group]tests/unit/a.test.ts:',
    '2026-11-09T07:06:14.0000000Z ##[group]tests/unit/b.test.ts:',
    '2026-11-09T07:06:20.0000000Z  12 pass',
  ].join('\n')
  expect(timesFromLog(log)).toEqual({ 'tests/unit/a.test.ts': 2.5, 'tests/unit/b.test.ts': 6 })
})
