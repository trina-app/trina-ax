// CI's unit test shards (scripts/ci/unit-shard.ts, .github/workflows/ci.yml "unit"): every test file runs in exactly
// one shard, the split is the same in every job, and the shards come out near the same length.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { CI_SKIPPED, split, timesFromLog, timesFromLogs, unitFiles } from '../../scripts/ci/unit-shard'
import times from '../../scripts/ci/unit-times.json'

// the shard count of .github/workflows/ci.yml's unit matrix
const SHARDS = 7

test(`every unit test file is in exactly one of the ${SHARDS} shards, and the split does not change between runs`, () => {
  const files = unitFiles()
  expect(files.length).toBeGreaterThan(100)
  expect(files).toContain('tests/unit/ci-unit-shard.test.ts')
  const a = split(files, times, SHARDS), b = split(files, times, SHARDS)
  expect(a).toEqual(b)
  expect(a.flatMap((s) => s.files).sort()).toEqual(files)
  // the longest shard is at most a quarter longer than the shortest
  const secs = a.map((s) => s.seconds)
  expect(Math.max(...secs)).toBeLessThanOrEqual(Math.min(...secs) * 1.25)
})

test('the security tests run in the shards too (TC-3846); a file left out is named with a reason and exists', () => {
  const files = unitFiles()
  expect(files).toContain('tests/security/permission-matrix.test.ts')
  expect(files).toContain('tests/security/r2-realtime-resume-revoked.test.ts')
  const root = path.resolve(import.meta.dir, '..', '..')
  for (const [f, why] of Object.entries(CI_SKIPPED)) {
    expect(fs.existsSync(path.join(root, f))).toBe(true)
    expect(why.length).toBeGreaterThan(10)
    expect(files).not.toContain(f)
  }
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
    '2026-11-09T07:06:15.0000000Z ##[group]tests/security/c.test.ts:',
    '2026-11-09T07:06:20.0000000Z  12 pass',
  ].join('\n')
  expect(timesFromLog(log)).toEqual({ 'tests/unit/a.test.ts': 2.5, 'tests/unit/b.test.ts': 1, 'tests/security/c.test.ts': 5 })
})

test('the times file knows nearly every file (a stale one leaves new files at the median and unbalances the shards)', () => {
  const files = unitFiles()
  const unknown = files.filter((f) => !(f in times))
  expect(unknown.length).toBeLessThanOrEqual(Math.ceil(files.length * 0.2))
})

test('several logs give each file its median time', () => {
  const log = (a: number, b: number) => [
    `2026-11-09T07:06:00.0000000Z ##[group]tests/unit/a.test.ts:`,
    `2026-11-09T07:06:${String(a).padStart(2, '0')}.0000000Z ##[group]tests/unit/b.test.ts:`,
    `2026-11-09T07:06:${String(a + b).padStart(2, '0')}.0000000Z  3 pass`,
  ].join('\n')
  expect(timesFromLogs([log(2, 1), log(10, 3), log(4, 2)])).toEqual({ 'tests/unit/a.test.ts': 4, 'tests/unit/b.test.ts': 2 })
  expect(timesFromLogs([log(2, 1), log(4, 3)])).toEqual({ 'tests/unit/a.test.ts': 3, 'tests/unit/b.test.ts': 2 })
})
