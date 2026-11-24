// The preview's floating pictures placed from their line (lib/docxFloat.ts, QA TC-8358).
import { describe, expect, test } from 'bun:test'
import { alignLineFloats } from '../../src/lib/docxFloat'

const boxes = (n: number) => Array.from({ length: n }, () => ({ style: { verticalAlign: '' } }))

describe('alignLineFloats', () => {
  test('only the pictures placed from their line move', () => {
    const b = boxes(3)
    expect(alignLineFloats(b, [true, false, true])).toBe(2)
    expect(b.map((x) => x.style.verticalAlign)).toEqual(['top', '', 'top'])
  })
  test('when the renderer drew another number of pictures, nothing moves', () => {
    const b = boxes(2)
    expect(alignLineFloats(b, [true, true, true])).toBe(0)
    expect(b.map((x) => x.style.verticalAlign)).toEqual(['', ''])
  })
})
