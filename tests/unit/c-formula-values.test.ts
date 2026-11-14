// make_file stores the result of simple xlsx formulas (server/src/tools/formula-values.ts), so a preview shows numbers.
import { describe, expect, test } from 'bun:test'
import { addFormulaResults } from '../../server/src/tools/formula-values'
import { cellValue } from '../../server/src/tools/make-file'

const grid = (rows: string[][]) => rows.map((r) => r.map((v) => cellValue(v)))
const results = (rows: string[][]) => {
  const g = grid(rows) as any[][]
  addFormulaResults(g)
  return g.map((r) => r.map((c) => (typeof c === 'object' && c && 'formula' in c ? c.result : undefined)))
}

describe('formula results', () => {
  test('SUM, AVERAGE, MIN, MAX, COUNT, arithmetic and chains of formulas', () => {
    const r = results([
      ['a', 'b', 'c', 'd'],
      ['1200', '1350', '1,500', '=SUM(A2:C2)'],
      ['800', '760', '910', '=SUM(A3:C3)'],
      ['=SUM(A2:A3)', '=AVERAGE(B2:B3)', '=MAX(C2:C3)-MIN(C2:C3)', '=SUM(D2:D3)'],
      ['=A2*B2', '=(A2+A3)/2', '=COUNT(A2:D3)', '=ROUND(A2/7, 2)'],
    ])
    expect(r[1]![3]).toBe(4050)
    expect(r[2]![3]).toBe(2470)
    expect(r[3]).toEqual([2000, 1055, 590, 6520])
    expect(r[4]).toEqual([1620000, 1000, 8, 171.43])
  })
  test('text in a range is skipped; empty cells count as 0 in arithmetic; 0.1+0.2 is 0.3', () => {
    const r = results([['x', 'y'], ['n', '5'], ['', '=SUM(A2:B2)'], ['=A3+B2', '=0.1+0.2']])
    expect(r[2]![1]).toBe(5)
    expect(r[3]).toEqual([5, 0.3])
  })
  test('anything else gets no result: other sheets, text, divide by zero, a loop, text in arithmetic, other functions', () => {
    const r = results([['a'], ['1'], ['=Sheet2!A1+1'], ['=A2/0'], ['=IF(A2>0,1,2)'], ['=A6+1'], ['=A5+1'], ['=A2+"x"'], ['=VLOOKUP(1,A1:A2,1)'], ['=A1+1']])
    expect(r.slice(2).flat().every((x) => x === undefined)).toBe(true)
  })
})
