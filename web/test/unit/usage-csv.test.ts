import { expect, test } from 'bun:test'
import { usageCsv } from '../../src/lib/usage-csv'

const report = {
  from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z',
  rows: [{ key: 'alice', label: '한글, "이름"\n둘째 줄', turns: 2, inputTokens: 120, outputTokens: 30, costUsd: 0.125 }],
  totals: { turns: 2, inputTokens: 120, outputTokens: 30, costUsd: 0.125 },
}

test('CSV preserves report range, counts, numeric precision, Korean and quoted multiline labels', () => {
  const csv = usageCsv(report, 'user')
  expect(csv.startsWith('\uFEFFgroup_by,from,to,key,label,turns,input_tokens,output_tokens,cost_usd,attribution\r\n')).toBe(true)
  expect(csv).toContain('user,2026-10-01T00:00:00.000Z,2026-11-01T00:00:00.000Z,alice,"한글, ""이름""\n둘째 줄",2,120,30,0.125,turn totals\r\n')
})

test('untrusted labels and keys cannot become spreadsheet formulas', () => {
  for (const attack of ['=1+1', '  +1+1', '-1+1', '@SUM(1)', '\t1+1', '\r1+1', '\n1+1']) {
    const csv = usageCsv({ ...report, rows: [{ ...report.rows[0]!, key: attack, label: attack }] }, 'model')
    expect(csv).toContain("'" + attack)
  }
})

test('skill CSV explicitly labels whole-turn attribution and does not invent a total of overlapping rows', () => {
  const csv = usageCsv({ ...report, rows: [report.rows[0]!, { ...report.rows[0]!, key: 'second' }] }, 'skill')
  expect(csv.match(/whole turn; skill rows may overlap/g)).toHaveLength(2)
  expect(csv).not.toContain('\r\ntotal,')
})

test('empty report still has a usable CSV header', () => {
  expect(usageCsv({ ...report, rows: [] }, 'user').split('\r\n')).toHaveLength(2)
})
