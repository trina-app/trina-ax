import { expect, test } from 'bun:test'
import { usageShares } from '../../src/lib/usage-share'

const row = (n: number) => ({ inputTokens: n - 100, outputTokens: 100 })

test('shares are parts of the displayed token sum and add up to 100% (B-W44-3)', () => {
  // QA case: 133879 / 40198 / 34524 tokens gave bars of 100% / 30% / 26% (share of the largest row).
  const shares = usageShares([row(133879), row(40198), row(34524)])
  const sum = 133879 + 40198 + 34524
  expect(shares[0]).toBeCloseTo(133879 / sum * 100, 9)
  expect(shares[1]).toBeCloseTo(40198 / sum * 100, 9)
  expect(shares[2]).toBeCloseTo(34524 / sum * 100, 9)
  expect(shares[0]).toBeLessThan(100)
  expect(shares.reduce((sum, s) => sum + s, 0)).toBeCloseTo(100, 9)
})

test('zero usage gives finite zero shares', () => {
  expect(usageShares([{ inputTokens: 0, outputTokens: 0 }])).toEqual([0])
  expect(usageShares([])).toEqual([])
})
