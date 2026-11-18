// make_file xlsx `sheets` (second limits audit N3, QA TC-4915; docs/decisions/20261118-rich-office-output.md): number
// formats, column widths, frozen rows and columns, the filter, and conditional formatting on the sheets make_file
// writes, through exceljs (tools/make-file.ts). A rule's formula passes the same check as a cell's formula
// (make-file.ts formulaOf: only cells of this workbook). Anything that does not fit a sheet is refused before the file
// is written.
import type ExcelJS from 'exceljs'
import type { z } from 'zod'
import type { MakeFileConditional, MakeFileSheet } from '@mycel/shared'
import { ToolError } from '../policy/errors'
import { colorHex } from './docx-format'

export type SheetOptions = z.output<typeof MakeFileSheet>
type Conditional = z.output<typeof MakeFileConditional>
/** a sheet as make_file wrote it: its name in the file, the heading it came from, how many rows and columns */
export interface WrittenSheet { name: string; title?: string; rows: number; cols: number; ws: ExcelJS.Worksheet }

const MAX_COL = 16384, MAX_ROW = 1048576
const colNumber = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
const colName = (n: number): string => (n > 26 ? colName(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26))

export interface Area { c1: number; r1: number; c2: number; r2: number }

/** "B2", "B2:D50", "C:C" or "C:E" (whole columns: rows 2 to the sheet's last; the header stays as it is) as an area */
export function parseArea(s: string, lastRow: number): Area | null {
  const t = s.trim().replace(/\$/g, '')
  let m = /^([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?$/.exec(t)
  if (m) {
    const c1 = colNumber(m[1]!), r1 = Number(m[2]), c2 = m[3] ? colNumber(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1
    if (c1 < 1 || r1 < 1 || c2 > MAX_COL || r2 > MAX_ROW) return null
    return { c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) }
  }
  m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(t)
  if (m) {
    const a = colNumber(m[1]!), b = colNumber(m[2]!)
    if (b > MAX_COL || a > MAX_COL) return null
    return { c1: Math.min(a, b), r1: Math.min(2, Math.max(lastRow, 1)), c2: Math.max(a, b), r2: Math.max(lastRow, 1) }
  }
  return null
}
const ref = (a: Area) => `${colName(a.c1)}${a.r1}${a.c1 === a.c2 && a.r1 === a.r2 ? '' : `:${colName(a.c2)}${a.r2}`}`

const argb = (what: string, v: string) => {
  const h = colorHex(v)
  if (!h) throw new ToolError(`${what} "${v.slice(0, 40)}" is not a colour: give a name (red, green, yellow, blue, orange, gray, ...) or "#RRGGBB"; nothing was saved`)
  return { argb: 'FF' + h }
}

/** exceljs numbers the rules itself (priority) when it writes the sheet */
const rule = (r: object) => r as ExcelJS.ConditionalFormattingRule

const OPERATORS: Record<string, string> = {
  greater_than: 'greaterThan', less_than: 'lessThan', greater_or_equal: 'greaterThanOrEqual', less_or_equal: 'lessThanOrEqual',
  equal: 'equal', not_equal: 'notEqual', between: 'between',
}

/** a value of a rule as a formula operand: a number, or text in double quotes */
const operand = (v: number | string) => (typeof v === 'number' ? String(v) : `"${v.replace(/"/g, '""')}"`)

/** The exceljs rule of `c` over `area`; `formula` checks a formula as make_file checks a cell's (null: allowed). */
export function conditionalRule(c: Conditional, area: Area, formula: (f: string) => string | { error: string }): ExcelJS.ConditionalFormattingRule {
  const where = `conditional "${c.when}" on ${c.range}`
  const plainStyle = c.fill === undefined && c.font_color === undefined && c.bold === undefined
  const style: Partial<ExcelJS.Style> = {}
  // Excel's own default: light red fill with dark red text
  const fill = c.fill ?? (plainStyle ? '#FFC7CE' : undefined)
  const font = c.font_color ?? (plainStyle ? '#9C0006' : undefined)
  if (fill) style.fill = { type: 'pattern', pattern: 'solid', bgColor: argb('fill', fill) }
  if (font || c.bold) style.font = { ...(font ? { color: argb('font_color', font) } : {}), ...(c.bold ? { bold: true } : {}) }
  const first = `${colName(area.c1)}${area.r1}`
  const need = (v: unknown, what: string) => { if (v === undefined) throw new ToolError(`${where}: give ${what}; nothing was saved`); return v }
  switch (c.when) {
    case 'greater_than': case 'less_than': case 'greater_or_equal': case 'less_or_equal': case 'equal': case 'not_equal': case 'between': {
      const v = need(c.value, '`value`') as number | string
      const formulae = [operand(v)]
      if (c.when === 'between') formulae.push(String(need(c.value2, '`value2` (the upper bound)')))
      return rule({ type: 'cellIs', operator: OPERATORS[c.when] as ExcelJS.CellIsRuleType['operator'], formulae, style })
    }
    case 'contains': {
      const v = String(need(c.value, '`value` (the text to look for)'))
      return rule({ type: 'expression', formulae: [`NOT(ISERROR(SEARCH(${operand(v)},${first})))`], style })
    }
    case 'duplicates': {
      const abs = `$${colName(area.c1)}$${area.r1}:$${colName(area.c2)}$${area.r2}`
      return rule({ type: 'expression', formulae: [`COUNTIF(${abs},${first})>1`], style })
    }
    case 'top': case 'bottom': {
      const n = Number(c.value ?? 10)
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ToolError(`${where}: \`value\` must be how many cells (1 to 1000); nothing was saved`)
      return rule({ type: 'top10', rank: n, percent: false, bottom: c.when === 'bottom', style })
    }
    case 'above_average': case 'below_average':
      return rule({ type: 'aboveAverage', aboveAverage: c.when === 'above_average', style })
    case 'formula': {
      const f = String(need(c.formula, '`formula`, e.g. "=$E2<0"')).replace(/^\s*=/, '')
      const r = formula(f)
      if (typeof r !== 'string') throw new ToolError(`${where}: ${r.error}; nothing was saved`)
      return rule({ type: 'expression', formulae: [r], style })
    }
    case 'color_scale':
      return rule({ type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'max' }], color: [argb('low_fill', c.low_fill ?? 'white'), argb('fill', c.fill ?? '#63BE7B')] })
    case 'data_bar':
      return rule({ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: argb('fill', c.fill ?? '#638EC6') })
  }
}

/** The sheet an option names: by its name in the file or its heading (any case); the first without one. */
function sheetOf(o: SheetOptions, sheets: WrittenSheet[]): WrittenSheet {
  if (o.sheet === undefined) return sheets[0]!
  const k = o.sheet.trim().toLowerCase()
  const s = sheets.find((x) => x.name.toLowerCase() === k) ?? sheets.find((x) => x.title?.trim().toLowerCase() === k)
  if (!s) throw new ToolError(`sheets: there is no sheet "${o.sheet.slice(0, 100)}" (the sheets are ${sheets.map((x) => `"${x.name}"`).join(', ')}); nothing was saved`)
  return s
}

/** Applies every sheet option; throws (before anything is written) when one does not fit. Returns how many conditional
 * rules were added. */
export function applySheetOptions(opts: SheetOptions[], sheets: WrittenSheet[], formula: (f: string) => string | { error: string }): { conditional: number } {
  let conditional = 0
  for (const o of opts) {
    const s = sheetOf(o, sheets)
    const ws = s.ws
    const area = (r: string, what: string) => {
      const a = parseArea(r, s.rows)
      if (!a) throw new ToolError(`sheets "${s.name}" ${what}: "${r.slice(0, 40)}" is not a range like "C2:C50" or "C:C"; nothing was saved`)
      return a
    }
    if (o.freeze) {
      const rows = o.freeze.rows ?? 1, cols = o.freeze.columns ?? 0
      ws.views = rows || cols ? [{ state: 'frozen', xSplit: cols, ySplit: rows }] : []
    }
    if (o.filter === false) ws.autoFilter = undefined as unknown as ExcelJS.AutoFilter
    else if (o.filter === true && s.cols > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.cols } }
    for (const [col, w] of Object.entries(o.column_widths ?? {})) {
      const n = colNumber(col)
      if (n > MAX_COL) throw new ToolError(`sheets "${s.name}" column_widths: "${col}" is not a column; nothing was saved`)
      ws.getColumn(n).width = w
    }
    for (const nf of o.number_formats ?? []) {
      const a = area(nf.range, 'number_formats')
      // cells past the data get no format (a whole column ends at the last row written)
      const r2 = Math.min(a.r2, Math.max(s.rows, a.r1)), c2 = Math.min(a.c2, Math.max(s.cols, a.c1))
      if ((r2 - a.r1 + 1) * (c2 - a.c1 + 1) > 2_000_000) throw new ToolError(`sheets "${s.name}" number_formats: "${nf.range}" is too many cells; nothing was saved`)
      for (let r = a.r1; r <= r2; r++) for (let c = a.c1; c <= c2; c++) ws.getCell(r, c).numFmt = nf.format
    }
    for (const c of o.conditional ?? []) {
      const a = area(c.range, 'conditional')
      ws.addConditionalFormatting({ ref: ref(a), rules: [conditionalRule(c, a, formula)] })
      conditional++
    }
  }
  return { conditional }
}
