// edit_hwp's changes, found the same way in a .hwpx (files/hwpx-edit.ts) and a .hwp (files/hwp-edit.ts). Each change
// is looked for in the document as it was read: its paragraphs' text exactly as hwp.ts reads it, its tables in reading
// order with their cells; never in another change's result. A change that cannot be applied exactly is refused with
// the reason, and nothing is written. The formats only say how a change that was found goes into their bytes, what an
// empty cell may hold, and which rows can be copied.
import { ToolError } from '../policy/errors'
import { cleanText, hwpxParagraphLines, type HwpChange, type HwpEditNote, type LineEdit } from './hwpx-check'

export const HWP_CHANGE_LIMITS = {
  changes: 100,
  /** matches one change may replace (all: true) */
  matches: 10_000,
  newRows: 500,
  rowCells: 64,
  valueChars: 20_000,
}

export function refuseChange(i: number, why: string): never { throw new ToolError(`change ${i + 1}: ${why}. Nothing was saved.`) }
export const clip = (s: string, n = 80) => JSON.stringify(s.length > n ? s.slice(0, n) + '…' : s)
export const strip = (s: string) => s.replace(/\s+/g, '')
/** a change's new text as it is written: line ends as line breaks, characters a document cannot hold taken out */
export const cleanValue = (s: string) => cleanText(s.replace(/\r\n?/g, '\n'))

/** A paragraph as the changes see it: its text as hwp.ts reads it, its heading level, the table cell it is directly in. */
export interface CPara { i: number; text: string; heading: number; cell?: CCell }
export interface CCell { table: CTable; row: number; col: number; rowSpan: number; colSpan: number; height: number; paras: CPara[] }
/** a table, numbered in reading order (`i`, 0-based) */
export interface CTable { i: number; cells: CCell[] }

/** a replaced range of a paragraph's text, in characters of what it reads as */
export interface TextEdit { from: number; to: number; text: string; change: number }
/** rows to add: after row A, copies of row C (1-based) of table `t`, whose cells are `cells` */
export interface RowPlan<C, T> { t: T; T: string; A: number; C: number; cells: C[]; rows: string[][] }

/** the lines of every paragraph as hwpxReadLines reads hwp.ts's text, and where each paragraph's lines start */
export function docLines(paras: { text: string; heading: number }[], text: (i: number) => string = (i) => paras[i]!.text): { lines: string[]; start: number[]; count: number[] } {
  const lines: string[] = [], start: number[] = [], count: number[] = []
  paras.forEach((p, i) => {
    const l = hwpxParagraphLines(text(i), p.heading)
    start.push(lines.length); count.push(l.length)
    lines.push(...l)
  })
  return { lines, start, count }
}

/**
 * The changes of one call against one document. A format's editor extends this with how its bytes change: replaceAt
 * (a found text), fillAt (an empty cell found by the rules here), rowsAt (rows checked here) and what it keeps for the
 * read-back; this class keeps which paragraph's text becomes what, where new paragraphs go, and the notes for the AI.
 */
export abstract class ChangeEditor<P extends CPara, C extends CCell, T extends CTable> {
  readonly textEdits = new Map<P, TextEdit[]>()
  /** new paragraphs (a table's new rows) before the paragraph of this index (or at the end) */
  readonly inserts = new Map<number, { change: number; paras: { text: string; heading: number }[] }[]>()
  readonly notes: HwpEditNote[] = []
  private rowsAdded = new Set<T>()
  /** paragraphs of cells a change filled */
  protected filled = new Set<P>()

  constructor(protected readonly paras: P[], protected readonly tables: T[]) {}

  /** where a paragraph is, for the AI */
  where(p: P): string {
    const c = p.cell
    if (c) return `table ${c.table.i + 1}, row ${c.row + 1}, column ${c.col + 1}`
    return 'a paragraph'
  }
  note(change: number, where: string, before: string, after: string, also: number[] = []) {
    if (this.notes.length < 50) this.notes.push({ change, where, before: before.slice(0, 200), after: after.slice(0, 200), ...(also.length ? { also } : {}) })
  }

  /** writes text [from, to) of p as `text` (the checks of the format: what the range may hold, one formatting) */
  protected abstract replaceAt(p: P, from: number, to: number, text: string, i: number): void
  /** every paragraph inside a cell, those of a table or an object in it too */
  protected abstract inside(cell: C): P[]
  /** writes `value` into the empty cell (its first paragraph p): what the cell may hold besides white space is the
   * format's to say; it calls notChanged(p, i) before it writes */
  protected abstract fillAt(cell: C, p: P, value: string, where: string, i: number): void
  /** refuses a change to a table this format cannot change (by default every table can be) */
  protected checkTable(_t: T, _i: number): void {}
  /** the table's rows as its cells say, the row count it states and its column count */
  protected abstract tableRows(t: T): { rows: C[][]; declared: string; cols: number }
  /** refuses a row whose cells cannot be copied (the format's allowlist) */
  protected abstract checkCopyRow(plan: RowPlan<C, T>, i: number): void
  /** writes the rows; returns the index of the paragraph the new ones go before in reading order (or paras.length) */
  protected abstract rowsAt(plan: RowPlan<C, T>, i: number): number

  apply(c: HwpChange, i: number) {
    if ('find' in c) this.replace(c, i)
    else if ('cell' in c) this.fillCell(c, i)
    else this.addRows(c.add_rows, i)
  }

  // ---- find / replace
  private replace(c: Extract<HwpChange, { find: string }>, i: number) {
    const find = c.find
    if (!find) refuseChange(i, 'find is empty')
    if (find === c.replace) refuseChange(i, 'find and replace are the same')
    const hits: { p: P; at: number }[] = []
    for (const p of this.paras) {
      for (let k = p.text.indexOf(find); k >= 0; k = p.text.indexOf(find, k + find.length)) hits.push({ p, at: k })
    }
    if (!hits.length) {
      const near = this.paras.find((p) => strip(find) && strip(p.text).includes(strip(find)))
      const hint = near ? ` It is there with other spacing or line breaks, in ${this.where(near)}: ${clip(near.text, 120)}; give the text exactly as it is, within one paragraph.`
        : find.includes('\n') ? ' Each paragraph is searched on its own: give text from one paragraph.' : ''
      refuseChange(i, `${clip(find)} is not in the document.${hint}`.replace(/\.$/, ''))
    }
    let chosen = hits
    if (c.all) {
      if (c.occurrence !== undefined) refuseChange(i, 'give occurrence or all, not both')
      if (hits.length > HWP_CHANGE_LIMITS.matches) refuseChange(i, `${clip(find)} appears more than ${HWP_CHANGE_LIMITS.matches.toLocaleString('en')} times; give a longer text`)
    }
    else if (c.occurrence !== undefined) {
      if (c.occurrence > hits.length) refuseChange(i, `${clip(find)} appears ${hits.length} time${hits.length > 1 ? 's' : ''}, so there is no occurrence ${c.occurrence}`)
      chosen = [hits[c.occurrence - 1]!]
    } else if (hits.length > 1) {
      const list = hits.slice(0, 5).map((h, n) => `${n + 1}: ${clip(h.p.text.slice(Math.max(0, h.at - 20), h.at + find.length + 20), 70)}`).join('; ')
      refuseChange(i, `${clip(find)} appears ${hits.length} times (${list}${hits.length > 5 ? '; …' : ''}). Give occurrence (1-${hits.length}) for one of them, or all: true for every one`)
    }
    const replacement = cleanValue(c.replace)
    for (const h of chosen) {
      if (this.filled.has(h.p)) refuseChange(i, `it changes the same text as change ${this.textEdits.get(h.p)![0]!.change + 1}`)
      this.replaceAt(h.p, h.at, h.at + find.length, replacement, i)
      this.addTextEdit(h.p, { from: h.at, to: h.at + find.length, text: replacement, change: i })
    }
  }

  private addTextEdit(p: P, e: TextEdit) {
    const list = this.textEdits.get(p) ?? []
    list.push(e)
    this.textEdits.set(p, list)
  }

  // ---- an empty cell
  private fillCell(c: Extract<HwpChange, { cell: unknown }>, i: number) {
    const a = c.cell
    let cell: C
    const all = () => this.tables.flatMap((t) => t.cells as C[])
    if (a.next_to !== undefined) {
      if (a.table !== undefined || a.row !== undefined || a.col !== undefined) refuseChange(i, 'give next_to or table, row and col, not both')
      const label = strip(a.next_to)
      if (!label) refuseChange(i, 'next_to is empty')
      const labels = all().filter((x) => strip(x.paras.map((p) => p.text).join('')) === label)
      if (!labels.length) refuseChange(i, `no table cell reads ${clip(a.next_to)}${this.cellsContaining(label)}`)
      if (labels.length > 1 && a.occurrence === undefined) refuseChange(i, `${labels.length} cells read ${clip(a.next_to)} (${labels.slice(0, 5).map((x) => `table ${x.table.i + 1} row ${x.row + 1} column ${x.col + 1}`).join('; ')}); give occurrence (1-${labels.length}) or table, row and col`)
      const o = a.occurrence ?? 1
      const lab = labels[o - 1] ?? refuseChange(i, `${labels.length} cell${labels.length > 1 ? 's read' : ' reads'} ${clip(a.next_to)}, so there is no occurrence ${o}`)
      const below = a.direction === 'below'
      const row = below ? lab.row + lab.rowSpan : lab.row, col = below ? lab.col : lab.col + lab.colSpan
      cell = (lab.table.cells as C[]).find((x) => x.row === row && x.col === col)
        ?? refuseChange(i, `there is no cell ${below ? 'below' : 'right of'} ${clip(a.next_to)} (table ${lab.table.i + 1}, row ${lab.row + 1}, column ${lab.col + 1})`)
    } else {
      if (a.table === undefined || a.row === undefined || a.col === undefined) refuseChange(i, 'a cell is given by next_to, or by table, row and col (all three)')
      const t = this.tables[a.table - 1] ?? refuseChange(i, `there is no table ${a.table} (the document has ${this.tables.length})`)
      this.checkTable(t, i)
      cell = (t.cells as C[]).find((x) => x.row === a.row! - 1 && x.col === a.col! - 1) ?? (() => {
        const over = t.cells.find((x) => x.row <= a.row! - 1 && a.row! - 1 < x.row + x.rowSpan && x.col <= a.col! - 1 && a.col! - 1 < x.col + x.colSpan)
        return refuseChange(i, over ? `row ${a.row} column ${a.col} of table ${a.table} is part of a merged cell that starts at row ${over.row + 1} column ${over.col + 1}`
          : `table ${a.table} has no cell at row ${a.row} column ${a.col}`)
      })()
    }
    const where = `table ${cell.table.i + 1}, row ${cell.row + 1}, column ${cell.col + 1}`
    // every paragraph inside the cell counts, those of a table or an object in it too
    const inside = this.inside(cell)
    const text = inside.map((q) => q.text).join('\n')
    if (text.trim()) refuseChange(i, `the cell at ${where} is not empty (it reads ${clip(text, 60)}); change its text with find and replace`)
    if (inside.some((q) => !cell.paras.includes(q))) refuseChange(i, `the cell at ${where} holds a table or an object, so it is not an empty cell to fill`)
    const p = (cell.paras[0] as P | undefined) ?? refuseChange(i, `the cell at ${where} has no paragraph to write in`)
    const value = cleanValue(c.value)
    this.fillAt(cell, p, value, where, i)
    this.filled.add(p)
    this.addTextEdit(p, { from: 0, to: p.text.length, text: value, change: i })
  }

  /** refuses a fill of p when another change already changes its text */
  protected notChanged(p: P, i: number) {
    const other = this.textEdits.get(p)?.[0]
    if (other) refuseChange(i, `it changes the same text as change ${other.change + 1}`)
  }

  protected cellsContaining(label: string): string {
    const near = this.tables.flatMap((t) => t.cells).find((x) => strip(x.paras.map((p) => p.text).join('')).includes(label))
    return near ? ` (one reads ${clip(near.paras.map((p) => p.text).join(' '), 60)}; next_to must be the cell's whole text)` : ''
  }

  // ---- rows
  private addRows(a: Extract<HwpChange, { add_rows: unknown }>['add_rows'], i: number) {
    let t: T
    if ((a.table === undefined) === (a.table_with === undefined)) refuseChange(i, 'give the table by table (its number) or table_with (the text of one of its cells), one of them')
    if (a.table !== undefined) t = this.tables[a.table - 1] ?? refuseChange(i, `there is no table ${a.table} (the document has ${this.tables.length})`)
    else {
      const label = strip(a.table_with!)
      const found = [...new Set(this.tables.flatMap((x) => x.cells).filter((x) => strip(x.paras.map((p) => p.text).join('')) === label).map((x) => x.table as T))]
      if (!found.length) refuseChange(i, `no table has a cell that reads ${clip(a.table_with!)}${this.cellsContaining(label)}`)
      if (found.length > 1) refuseChange(i, `tables ${found.map((x) => x.i + 1).join(', ')} all have a cell that reads ${clip(a.table_with!)}; give table (its number)`)
      t = found[0]!
    }
    const T = `table ${t.i + 1}`
    this.checkTable(t, i)
    if (this.rowsAdded.has(t)) refuseChange(i, `rows are added to ${T} twice; put all of its new rows in one change`)
    this.rowsAdded.add(t)
    const { rows, declared, cols } = this.tableRows(t)
    const R = rows.length
    if (Number(declared) !== R) refuseChange(i, `${T} says it has ${declared} rows but has ${R}`)
    const A = a.after_row ?? R
    const C = a.copy_row ?? A
    if (!(A >= 1 && A <= R)) refuseChange(i, `${T} has rows 1-${R}, so after_row ${A} is not one of them`)
    if (!(C >= 1 && C <= R)) refuseChange(i, `${T} has rows 1-${R}, so copy_row ${C} is not one of them`)
    if (!a.rows.length) refuseChange(i, 'rows is empty')
    if (a.rows.length > HWP_CHANGE_LIMITS.newRows) refuseChange(i, `more than ${HWP_CHANGE_LIMITS.newRows} new rows`)
    rows.forEach((cs, r) => { for (const c of cs) if (c.row !== r) refuseChange(i, `the cells of ${T} are not in row order (row ${r + 1} has a cell of row ${c.row + 1})`) })
    const cells = rows[C - 1]!
    if (cells.some((c) => c.rowSpan !== 1)) refuseChange(i, `row ${C} of ${T} has a cell merged with the row below, so it cannot be copied; copy another row (copy_row)`)
    if (cells.reduce((n, c) => n + c.colSpan, 0) !== cols) refuseChange(i, `row ${C} of ${T} does not have all of its ${cols} columns (a cell above reaches into it), so it cannot be copied; copy another row (copy_row)`)
    const across = t.cells.find((c) => c.row <= A - 1 && c.row + c.rowSpan - 1 >= A)
    if (across) refuseChange(i, `a merged cell of ${T} (row ${across.row + 1}, column ${across.col + 1}) reaches across the place after row ${A}, so rows cannot go there`)
    for (const [n, row] of a.rows.entries()) if (row.length > cells.length) refuseChange(i, `new row ${n + 1} has ${row.length} values, but row ${C} of ${T} has ${cells.length} cells`)
    const plan: RowPlan<C, T> = { t, T, A, C, cells, rows: a.rows.map((r) => cells.map((_, ci) => cleanValue(r[ci] ?? ''))) }
    this.checkCopyRow(plan, i)
    for (const r of plan.rows) for (const v of r) if (v.length > HWP_CHANGE_LIMITS.valueChars) refuseChange(i, `a value is longer than ${HWP_CHANGE_LIMITS.valueChars.toLocaleString('en')} characters`)
    const key = this.rowsAt(plan, i)
    const newParas = plan.rows.flatMap((r) => r.map((text, ci) => ({ text, heading: cells[ci]!.paras[0]?.heading ?? 0 })))
    this.inserts.set(key, [...(this.inserts.get(key) ?? []), { change: i, paras: newParas }])
    const k = a.rows.length
    this.note(i, `${T}, after row ${A}`, '', `${k} row${k > 1 ? 's' : ''} like row ${C}: ${a.rows.map((r) => r.join(' | ')).join(' / ')}`)
  }

  /** each paragraph's text after the changes (a cell's new text replaces all of it) */
  newText(p: P): string {
    const list = this.textEdits.get(p)
    if (!list) return p.text
    const sorted = [...list].sort((a, b) => a.from - b.from || a.change - b.change)
    let out = '', pos = 0
    let last: TextEdit | null = null
    for (const e of sorted) {
      if (last && e.from < pos) refuseChange(e.change, `it changes the same text as change ${last.change + 1}`)
      out += p.text.slice(pos, e.from) + e.text
      pos = e.to
      last = e
    }
    return out + p.text.slice(pos)
  }

  /** The line edits the read-back checks (each naming the changes it comes from), with a note per changed paragraph. */
  lineEdits(): LineEdit[] {
    const before = docLines(this.paras)
    const changed = new Map<P, string>()
    for (const p of this.textEdits.keys()) {
      const t = this.newText(p)
      changed.set(p, t)
      const ch = [...new Set(this.textEdits.get(p)!.map((e) => e.change))].sort((a, b) => a - b)
      this.note(ch[0]!, this.where(p), p.text, t, ch.slice(1))
    }
    const out: LineEdit[] = []
    for (let i = 0; i <= this.paras.length; i++) {
      const at = i < this.paras.length ? before.start[i]! : before.lines.length
      for (const g of this.inserts.get(i) ?? []) out.push({ at, remove: 0, insert: g.paras.flatMap((x) => hwpxParagraphLines(x.text, x.heading)), changes: [g.change] })
      const p = this.paras[i]
      if (p && changed.has(p)) {
        const changes = [...new Set(this.textEdits.get(p)!.map((e) => e.change))].sort((a, b) => a - b)
        out.push({ at, remove: before.count[i]!, insert: hwpxParagraphLines(changed.get(p)!, p.heading), changes })
      }
    }
    this.notes.sort((a, b) => a.change - b.change)
    return out
  }
}

/** the {{…}} placeholders a document still has, from its lines as read back */
export const placeholdersIn = (lines: string[]) => [...new Set(lines.join('\n').match(/\{\{[^{}\n]{1,40}\}\}/g) ?? [])].slice(0, 20)

/** The changes as a worker gets them: the server checked them with the tool's schema; checked again here. */
export function asChanges(v: unknown, what: string): HwpChange[] {
  const bad = (): never => { throw new ToolError(`the ${what} editor got a damaged request`) }
  if (!Array.isArray(v)) return bad()
  const str = (x: unknown) => typeof x === 'string'
  const int = (x: unknown) => x === undefined || (Number.isInteger(x) && (x as number) >= 1)
  for (const c of v) {
    if (!c || typeof c !== 'object') bad()
    if ('find' in c) { if (!str(c.find) || !str(c.replace) || !int(c.occurrence) || (c.all !== undefined && typeof c.all !== 'boolean')) bad() }
    else if ('cell' in c) {
      const a = c.cell
      if (!a || typeof a !== 'object' || !str(c.value) || !(a.next_to === undefined || str(a.next_to)) || !int(a.table) || !int(a.row) || !int(a.col) || !int(a.occurrence)) bad()
      if (a.direction !== undefined && a.direction !== 'right' && a.direction !== 'below') bad()
    } else if ('add_rows' in c) {
      const a = c.add_rows
      if (!a || typeof a !== 'object' || !int(a.table) || !(a.table_with === undefined || str(a.table_with)) || !int(a.after_row) || !int(a.copy_row)) bad()
      if (!Array.isArray(a.rows) || a.rows.some((r: unknown) => !Array.isArray(r) || r.length > HWP_CHANGE_LIMITS.rowCells || r.some((x) => !str(x)))) bad()
    } else bad()
  }
  return v as HwpChange[]
}
