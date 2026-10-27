// Export only the administrator's aggregate report; no prompts, skill bodies or credential secrets.
import type { z } from 'zod'
import type { UsageResponse } from '@mycel/shared/api'

function cell(value: string | number): string {
  let s = String(value)
  // Quoting alone does not stop spreadsheets interpreting untrusted names/keys as formulas.
  if (typeof value === 'string' && (/^\s*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s))) s = "'" + s
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
}

export function usageCsv(report: z.output<typeof UsageResponse>, groupBy: string): string {
  const header = 'group_by,from,to,key,label,turns,input_tokens,output_tokens,cost_usd,attribution'
  const attribution = groupBy === 'skill' ? 'whole turn; skill rows may overlap' : 'turn totals'
  const rows = report.rows.map((r) => [groupBy, report.from, report.to, r.key, r.label, r.turns, r.inputTokens, r.outputTokens, r.costUsd, attribution].map(cell).join(','))
  return '\uFEFF' + [header, ...rows, ''].join('\r\n')
}
