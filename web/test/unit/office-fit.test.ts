// A Word preview on a narrow panel (src/lib/officeFit.ts): docx-preview draws an A4 page about 794 px wide, so on a
// 390 px phone the right side was cut off (QA 2026-11-22 F14). The page is scaled to the panel's width, never up.
import { expect, test } from 'bun:test'
import { fitScale } from '../../src/lib/officeFit'

test('a page wider than the box: box / page; a narrower one: 1 (never scaled up)', () => {
  expect(fitScale(794, 358)).toBeCloseTo(0.45, 2)
  expect(fitScale(794, 1200)).toBe(1)
  expect(fitScale(794, 794)).toBe(1)
})

test('nothing known (not drawn yet, a hidden panel): 1', () => {
  expect(fitScale(0, 358)).toBe(1)
  expect(fitScale(794, 0)).toBe(1)
  expect(fitScale(Number.NaN, 358)).toBe(1)
})
