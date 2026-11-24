// edit_hwp's changes, found the same way in a .hwpx (files/hwpx-edit.ts) and a .hwp (files/hwp-edit.ts). Each change
// is looked for in the document as it was read: its paragraphs' text exactly as hwp.ts reads it, its tables in reading
// order with their cells; never in another change's result. A change that cannot be applied exactly is refused with
// the reason, and nothing is written. The formats only say how a change that was found goes into their bytes, what an
// empty cell may hold, and which rows can be copied.
import { ToolError } from '../policy/errors'
import { cleanText, hwpxParagraphLines, isImageChange, type HwpChange, type HwpEditNote, type HwpImageChange, type LineEdit, type PictureRef } from './hwpx-check'
import {
  HU_PER_PX, MM_PER_PX, labelX, layoutLabelCells, layoutTextHits, placePicture, sanitizeImage, spotNote, PICTURE_LIMITS, type CleanImage, type HwpLayout, type LHit, type LLine, type HwpPictureNote, type ImagePlace,
  type PictureSpot,
} from './hwp-picture'

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
/** text as compared with what the renderer draws: no white space or format characters (a soft hyphen is drawn, not stored) */
const drawnText = (s: string) => s.replace(/[\s\p{Cf}]/gu, '')
/** the drawn table `t` of a page has exactly the cells of this table of the document, each with the same text */
function sameTable(table: CTable, pg: { lines: { cell: number; text: string }[]; cells: { table: number; row: number; col: number }[] }, t: number): boolean {
  const drawn = new Map<string, string>()
  pg.cells.forEach((c, k) => { if (c.table === t) drawn.set(`${c.row}:${c.col}`, drawnText(pg.lines.filter((l) => l.cell === k).map((l) => l.text).join(''))) })
  if (drawn.size !== table.cells.length) return false
  return table.cells.every((c) => drawn.get(`${c.row}:${c.col}`) === drawnText(c.paras.map((q) => q.text).join('')))
}
/** a change's new text as it is written: line ends as line breaks, characters a document cannot hold taken out */
export const cleanValue = (s: string) => cleanText(s.replace(/\r\n?/g, '\n'))

/** A paragraph as the changes see it: its text as hwp.ts reads it, its heading level, the table cell it is directly in. */
export interface CPara { i: number; sec: number; text: string; heading: number; cell?: CCell }
export interface CCell { table: CTable; row: number; col: number; rowSpan: number; colSpan: number; height: number; paras: CPara[] }
/** a table, numbered in reading order (`i`, 0-based), and the paragraph that holds it */
export interface CTable { i: number; cells: CCell[]; para: CPara | null }

/** why a table cannot continue on the next page (Hangul's names for the settings in brackets) */
export const FIXED_ON_PAGE = {
  asChar: 'it is placed as a character',
  noSplit: 'it is set not to split at a page boundary',
}
/** A page's body height in HWPUNIT: the paper's height (its width when the page is turned) less the top and bottom
 * margins and the header and footer margins, which Hangul keeps between those margins and the body; null when that
 * leaves nothing. */
export function pageBodyHeight(p: { width: number; height: number; top: number; bottom: number; header: number; footer: number; landscape: boolean }): number | null {
  const h = (p.landscape ? p.width : p.height) - p.top - p.bottom - p.header - p.footer
  return Number.isFinite(h) && h > 0 ? h : null
}

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
  /** new paragraphs (a table's new rows) before the paragraph of this index (or at the end); `depth`: how deep the
   * table is, so that rows of a table inside another's last cell read before that table's own new rows */
  readonly inserts = new Map<number, { change: number; depth: number; paras: { text: string; heading: number }[] }[]>()
  readonly notes: HwpEditNote[] = []
  private rowsAdded = new Set<T>()
  /** rows this call adds to a table: after which row (1-based) and how many */
  private rowsAfter = new Map<T, { after: number; count: number }>()
  /** paragraphs of cells a change filled */
  protected filled = new Set<P>()
  /** image changes: the page layout and each one's picture (by change index), set before apply; where each went */
  layout: HwpLayout | null = null
  images = new Map<number, CleanImage>()
  readonly pictures: HwpPictureNote[] = []

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
  /** writes the rows; returns the index of the paragraph the new ones go before in reading order (or paras.length) and
   * how deep the table is nested (rows put in at one place read deepest first) */
  protected abstract rowsAt(plan: RowPlan<C, T>, i: number): { before: number; depth: number }
  /** puts `image` at the end of body paragraph p (its anchor; p is on the page of `spot`), floating at `spot` on the
   * paper, behind or in front of the text; returns the part that holds the picture's bytes (a zip part, a stream) */
  protected abstract pictureAt(p: P, spot: PictureSpot, image: CleanImage, layer: 'behind' | 'front', i: number): string
  /** the body paragraph `index` (0-based, among the paragraphs directly in the section) of section `section`, or null */
  protected abstract topParagraph(section: number, index: number): P | null
  /** whether p keeps Hangul's layout cache (line segments) */
  protected abstract hasLayoutCache(p: P): boolean
  /** p's index among the body paragraphs of its section, or -1 (a paragraph in a table or an object) */
  protected abstract topIndex(p: P): number
  /** the table's height as the document states it (HWPUNIT), or null */
  protected abstract tableHeight(t: T): number | null
  /** the height one new row copied from `cells` adds to the table: the estimate rowsAt writes into the table's height */
  protected abstract rowHeight(t: T, cells: C[]): number
  /** why the table cannot continue on the next page (FIXED_ON_PAGE), or null when it can */
  protected abstract fixedOnPage(t: T): string | null
  /** the body height of the pages of the table's section (pageBodyHeight), or null when the section does not say it
   * plainly (no page setup, or more than one) */
  protected abstract pageBody(t: T): number | null
  /** the table is in a page header or footer: never drawn in the body the layout shows */
  protected abstract inHeaderOrFooter(t: T): boolean

  apply(c: HwpChange, i: number) {
    if (isImageChange(c)) this.placeImage(c, i)
    else if ('find' in c) this.replace(c, i)
    else if ('cell' in c) this.fillCell(c, i)
    else this.addRows(c.add_rows, i)
  }

  // ---- find / replace
  private replace(c: Extract<HwpChange, { find: string }>, i: number) {
    const find = c.find
    if (!find) refuseChange(i, 'find is empty')
    if (find === c.replace) refuseChange(i, 'find and replace are the same')
    const hits = this.textHits(find, i)
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

  /** where `find` is in the paragraphs' text, in reading order; refused (with a hint) when nowhere */
  private textHits(find: string, i: number): { p: P; at: number }[] {
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
    return hits
  }

  private addTextEdit(p: P, e: TextEdit) {
    const list = this.textEdits.get(p) ?? []
    list.push(e)
    this.textEdits.set(p, list)
  }

  // ---- an empty cell
  /** the cell a change names: next_to a label cell (right of it or below it; `labels` are every cell that reads the
   * label, `label` the one chosen) or by table, row and column */
  protected findCell(a: { next_to?: string; direction?: 'right' | 'below'; occurrence?: number; table?: number; row?: number; col?: number }, i: number): { cell: C; label?: C; labels?: C[] } {
    let cell: C
    let lab: C | undefined, labels: C[] | undefined
    const all = () => this.tables.flatMap((t) => t.cells as C[])
    if (a.next_to !== undefined) {
      if (a.table !== undefined || a.row !== undefined || a.col !== undefined) refuseChange(i, 'give next_to or table, row and col, not both')
      const label = strip(a.next_to)
      if (!label) refuseChange(i, 'next_to is empty')
      labels = all().filter((x) => strip(x.paras.map((p) => p.text).join('')) === label)
      if (!labels.length) refuseChange(i, `no table cell reads ${clip(a.next_to)}${this.cellsContaining(label)}`)
      if (labels.length > 1 && a.occurrence === undefined) refuseChange(i, `${labels.length} cells read ${clip(a.next_to)} (${labels.slice(0, 5).map((x) => `table ${x.table.i + 1} row ${x.row + 1} column ${x.col + 1}`).join('; ')}); give occurrence (1-${labels.length}) or table, row and col`)
      const o = a.occurrence ?? 1
      lab = labels[o - 1] ?? refuseChange(i, `${labels.length} cell${labels.length > 1 ? 's read' : ' reads'} ${clip(a.next_to)}, so there is no occurrence ${o}`)
      const below = a.direction === 'below'
      const row = below ? lab.row + lab.rowSpan : lab.row, col = below ? lab.col : lab.col + lab.colSpan
      const l = lab
      cell = (l.table.cells as C[]).find((x) => x.row === row && x.col === col)
        ?? refuseChange(i, `there is no cell ${below ? 'below' : 'right of'} ${clip(a.next_to)} (table ${l.table.i + 1}, row ${l.row + 1}, column ${l.col + 1})`)
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
    return { cell, label: lab, labels }
  }

  private fillCell(c: Extract<HwpChange, { value: string }>, i: number) {
    const cell = this.findCell(c.cell, i).cell
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

  // ---- a picture
  /**
   * An image change: at a text (`at`), in a table cell (`cell`, next to a label) or at x/y mm on a page. A text or a cell
   * is found in the document (several: the change must say which) and then on the pages as the renderer drew them. The
   * picture floats on the paper at that place, anchored at the end of a body paragraph on that page, so no text moves.
   * Where Hangul may lay the page out differently from the renderer, the note says the place was not verified: the AI
   * looks at the page and moves the picture if it is off.
   */
  private placeImage(c: HwpImageChange, i: number) {
    const img = this.images.get(i) ?? refuseChange(i, 'its picture did not arrive')
    const layout = this.layout ?? refuseChange(i, 'the page layout is missing')
    if (this.pictures.length >= PICTURE_LIMITS.images) refuseChange(i, `more than ${PICTURE_LIMITS.images} pictures in one call`)
    if ([c.at, c.cell, c.page].filter((x) => x !== undefined).length !== 1) refuseChange(i, 'give one of at (a text), cell (next to a label cell) or page with x_mm and y_mm')
    if (c.place !== undefined && c.at === undefined) refuseChange(i, 'place goes with at')
    if ((c.x_mm === undefined) !== (c.y_mm === undefined) || (c.x_mm !== undefined && c.page === undefined)) refuseChange(i, 'x_mm and y_mm go together, with page')
    /** the laid-out cell the place is in (-1: none) and the laid-out paragraph of the label's line */
    let cellIdx = -1, lineKey = ''
    let p: P | null, page: number, target: { x: number; y: number; w: number; h: number }, where: string
    let place: ImagePlace
    if (c.page !== undefined) {
      page = c.page - 1
      if (!layout.pages[page]) refuseChange(i, `the document has ${layout.pages.length} page${layout.pages.length === 1 ? '' : 's'}`)
      target = { x: c.x_mm! / MM_PER_PX, y: c.y_mm! / MM_PER_PX, w: 0, h: 0 }
      p = null; place = 'xy'
      where = `page ${c.page}`
    } else if (c.at !== undefined) {
      // the place was resolved on the document as read when other changes of this call came first
      const t = c.ref?.text ? this.placeFromRef(c.ref, i) : this.resolveText(c, i)
      const hits = this.textHits(t.find, i)
      const h = hits.find((x) => x.p === t.h.p && x.at === t.h.at) ?? refuseChange(i, `${clip(t.find)} could not be found at its place`)
      const L = this.drawnHit(h, t.find, hits, layoutTextHits(layout, t.find), layout) ?? refuseChange(i, `${clip(t.find)} is not on the pages as they are drawn (in a page header or footer, or hidden); give other text near it, a cell, or page with x_mm and y_mm`)
      const pg = layout.pages[L.page]!, line = pg.lines[L.line]!
      const [x0, x1] = labelX(line, L.at, [...t.find].length)
      target = { x: x0, y: line.y, w: Math.max(0, x1 - x0), h: line.h }
      cellIdx = line.cell; lineKey = line.para
      p = h.p; page = L.page; place = c.place ?? 'over'
      where = `${this.placedWhere(h.p, pg, line)}, ${place} ${clip(t.find, 40)}`
    } else {
      const f = c.ref?.cell ? this.cellFromRef(c.ref, c.cell!.next_to, i) : this.findCell({ next_to: c.cell!.next_to, direction: c.cell!.direction, occurrence: c.occurrence }, i)
      const cell = f.cell
      const laid = layoutLabelCells(layout, strip(c.cell!.next_to))
      // the drawn label cell: the one in the same row and column of a table in the same section, by its order among those
      const section = f.label!.paras[0]?.sec
      const same = laid.filter((l) => { const pg = layout.pages[l.page]!, x = pg.cells[l.cell]!; return pg.section === section && x.row === f.label!.row && x.col === f.label!.col })
      const k = f.labels!.filter((x) => x.paras[0]?.sec === section && x.row === f.label!.row && x.col === f.label!.col).indexOf(f.label!)
      const L = same[k] ?? same[0] ?? refuseChange(i, `the cell reading ${clip(c.cell!.next_to)} is not on the pages as they are drawn; give a text with at, or page with x_mm and y_mm`)
      const pg = layout.pages[L.page]!, lc = pg.cells[L.cell]!
      const ti = pg.cells.findIndex((x) => x.table === lc.table && x.row === cell.row && x.col === cell.col)
      if (ti < 0) refuseChange(i, `the cell ${c.cell!.direction === 'below' ? 'below' : 'right of'} ${clip(c.cell!.next_to)} is not on the same page as its label; give a text with at, or page with x_mm and y_mm`)
      target = pg.cells[ti]!
      cellIdx = ti
      p = (cell.paras[0] as P | undefined) ?? null
      page = L.page; place = 'cell'
      where = `table ${cell.table.i + 1}, row ${cell.row + 1}, column ${cell.col + 1}`
    }
    // The anchor: a body paragraph, the picture's control at its end (so no text and no layout cache of the paragraph
    // changes); a picture anchored in a cell would make the cell grow around it.
    // - Every paragraph of the section has Hangul's layout cache: the renderer draws the page where Hangul laid it out,
    //   so the picture is placed from the paper.
    // - Otherwise (Hancom Docs and other writers save no cache) Hangul lays the document out again with its own line
    //   breaks: the picture is placed from the top of the label's own body paragraph, which Hangul keeps next to the
    //   label, when it starts on that page; anywhere else it is placed from the paper and not verified.
    // A table's filled cells are drawn over what lies behind the text, so a place in a table is in front unless the
    // change says otherwise.
    const inTable = !!p?.cell
    const pg = layout.pages[page]!
    const section = p ? p.sec : pg.section
    const cached = this.paras.every((q) => q.sec !== section || this.hasLayoutCache(q))
    let fromPara: number | undefined
    let anchor: P | null = null
    const top = p && !p.cell ? this.topIndex(p) : -1
    const next = layout.pages[page + 1]
    const endsHere = (k: number) => k >= 0 && !(next && next.section === pg.section && next.continued.includes(k))
    if (!cached && p && !p.cell && top >= 0 && pg.starts.some((x) => x.para === top)) {
      anchor = p; fromPara = pg.lines.find((l) => l.para === lineKey)!.y
    } else if (!cached && inTable) {
      // the body paragraph right after the table, when it is on this page: it follows the table whatever Hangul wraps above
      const holder = p!.cell!.table.para as P | null
      const k = holder && !holder.cell ? this.topIndex(holder) : -1
      const t = cellIdx >= 0 ? pg.tables[pg.cells[cellIdx]!.table - 1] : undefined
      const after = k >= 0 && pg.starts.some((x) => x.para === k) ? this.topParagraph(holder!.sec, k + 1) : null
      const line = after && !after.cell && t ? pg.lines.find((l) => l.cell < 0 && l.para.endsWith(`:${k + 1}`) && l.y >= t.y + t.h - 1) : undefined
      if (after && line && pg.starts.some((x) => x.para === k + 1)) { anchor = after; fromPara = line.y }
    } else if (cached && p && !p.cell && endsHere(top)) anchor = p
    // otherwise a plain body paragraph that starts and ends on this page, never one that holds a table (a control added
    // there pushed a page-filling form or the picture onto another page); a page that is one table: the cell itself
    if (!anchor) {
      const flat = (x: string) => x.replace(/\s+/g, '')
      anchor = pg.starts.map((x) => ({ x, q: this.topParagraph(pg.section, x.para) })).find(({ x, q }) => q && !q.cell && !x.table && !this.tables.some((t) => t.para === q) &&
        endsHere(x.para) && (!flat(x.preview) || flat(q.text).startsWith(flat(x.preview).replace(/…$/, ''))))?.q ?? (inTable ? p : null)
    }
    if (!anchor) refuseChange(i, `page ${page + 1} has no paragraph that can hold a picture; give a text or a cell on it`)
    const spot = placePicture(pg, page, target, place, { width_mm: c.width_mm, height_mm: c.height_mm }, img.height / img.width)
    if (c.shift) { spot.box.x += Math.round((c.shift.x_mm / MM_PER_PX) * HU_PER_PX); spot.box.y += Math.round((c.shift.y_mm / MM_PER_PX) * HU_PER_PX) }
    if (fromPara !== undefined) spot.fromPara = spot.box.y - Math.round(fromPara * HU_PER_PX)
    const part = this.pictureAt(anchor!, spot, img, c.layer ?? (inTable ? 'front' : 'behind'), i)
    this.pictures.push({ ...spotNote(i, spot, where, part), ...(cached || fromPara !== undefined ? {} : { unverified: true }) })
  }

  /** The drawn line of one found text: the drawn hits whose line reads as the text around it in its own paragraph; when
   * that leaves several, the one in the same order as the document's (the AI looks at the page and moves it if off). */
  private drawnHit(h: { p: P; at: number }, find: string, hits: { p: P; at: number }[], laid: LHit[], layout: HwpLayout): LHit | null {
    const fits = (x: { p: P; at: number }, l: LHit) => {
      const pg = layout.pages[l.page]!, line = pg.lines[l.line]!, chars = [...line.text], n = [...find].length
      if (pg.section !== x.p.sec) return false
      if (x.p.cell ? line.cell < 0 : line.cell >= 0) return false
      return drawnText(x.p.text.slice(0, x.at)).endsWith(drawnText(chars.slice(0, l.at).join(''))) && drawnText(x.p.text.slice(x.at + find.length)).startsWith(drawnText(chars.slice(l.at + n).join('')))
    }
    const mine = laid.filter((l) => fits(h, l))
    if (mine.length === 1) return mine[0]!
    const k = hits.indexOf(h)
    return (laid.length === hits.length ? laid[k] : undefined) ?? mine[0] ?? null
  }

  /** Where a picture went for the result, from the line it was placed on. */
  private placedWhere(p: P, pg: HwpLayout['pages'][number], line: LLine): string {
    if (line.cell < 0) return this.where(p)
    const c = pg.cells[line.cell]!
    const t = this.tables.filter((x) => sameTable(x, pg, c.table))
    return `${t.length === 1 ? `table ${t[0]!.i + 1}` : 'a table'}, row ${c.row + 1}, column ${c.col + 1}`
  }

  // ---- a picture's target, fixed on the document as read
  /** The text target on this document as it is now: several places are never guessed, the refusal lists them. */
  private resolveText(c: HwpImageChange, i: number) {
    const label = c.at!
    const hits = this.textHits(label, i)
    if (hits.length > 1 && c.occurrence === undefined) {
      const list = hits.slice(0, 8).map((h, n) => `${n + 1}: ${clip(h.p.text.slice(Math.max(0, h.at - 20), h.at + label.length + 20), 70)}`).join('; ')
      refuseChange(i, `${clip(label)} appears ${hits.length} times (${list}${hits.length > 8 ? '; …' : ''}). Give occurrence (1-${hits.length}), or a longer text`)
    }
    const k = (c.occurrence ?? 1) - 1
    const chosen = hits[k] ?? refuseChange(i, `${clip(label)} appears ${hits.length} time${hits.length === 1 ? '' : 's'}, so there is no occurrence ${k + 1}`)
    return { find: label, h: { p: chosen.p, at: chosen.at } }
  }

  /** The targets of a call's pictures on this document as read, before its other changes. */
  resolveTargets(targets: HwpImageChange[], first: number) {
    return targets.map((c, k) => {
      const i = first + k
      if (c.at !== undefined) return { i, text: this.resolveText(c, i) }
      if (c.cell !== undefined) { const f = this.findCell({ next_to: c.cell.next_to, direction: c.cell.direction, occurrence: c.occurrence }, i); return { i, cell: { label: f.label!, target: f.cell } } }
      return { i }
    })
  }

  /** The same targets after this call's text and row changes: the same paragraph or cell, wherever it moved. A target whose
   * own text another change touches has no place to carry: refused. */
  carryTargets(pending: ReturnType<ChangeEditor<P, C, T>['resolveTargets']>): PictureRef[] {
    const fillFirst = 'another change of this call changes that text, so the place cannot be kept; make the other changes first, then put the picture in with a second call'
    const row = (c: CCell) => { const r = this.rowsAfter.get(c.table as T); return r && c.row >= r.after ? c.row + r.count : c.row }
    const at = (c: CCell) => ({ table: c.table.i, row: row(c), col: c.col })
    return pending.map((x) => {
      if (x.cell) {
        for (const c of [x.cell.label, x.cell.target]) if (c.paras.some((q) => this.textEdits.has(q as P))) refuseChange(x.i, fillFirst)
        return { tables: this.tables.length, cell: { label: at(x.cell.label), target: at(x.cell.target) } }
      }
      if (!x.text) return { tables: this.tables.length }
      const t = x.text, p = t.h.p as P
      const start = t.h.at, end = t.h.at + t.find.length
      const edits = this.textEdits.get(p) ?? []
      if (edits.some((e) => e.from < end && e.to > start)) refuseChange(x.i, fillFirst)
      const shift = edits.filter((e) => e.to <= start).reduce((n, e) => n + e.text.length - (e.to - e.from), 0)
      const cell = p.cell ? { ...at(p.cell), para: p.cell.paras.indexOf(p) } : undefined
      const top = p.cell ? -1 : this.topIndex(p)
      if (!p.cell && top < 0) refuseChange(x.i, 'that text is not in the body of the document')
      return { tables: this.tables.length, text: { sec: p.sec, top, ...(cell ? { cell } : {}), at: t.h.at + shift, find: t.find, expected: this.newText(p) } }
    })
  }

  /** The carried text target in this document, the same place: else refused. */
  private placeFromRef(ref: PictureRef, i: number) {
    const lost = (): never => refuseChange(i, 'its place could not be kept through the other changes of this call; make them first, then put the picture in with a second call')
    const r = ref.text!
    if (ref.tables !== this.tables.length) lost()
    const p = r.cell
      ? ((this.tables[r.cell.table]?.cells as C[] | undefined)?.find((x) => x.row === r.cell!.row && x.col === r.cell!.col)?.paras[r.cell.para] as P | undefined)
      : this.topParagraph(r.sec, r.top) ?? undefined
    if (!p || p.sec !== r.sec || p.text !== r.expected || p.text.slice(r.at, r.at + r.find.length) !== r.find) return lost()
    return { find: r.find, h: { p, at: r.at } }
  }

  /** The carried cell target in this document: the label cell, the cells that read like it, and the target. */
  private cellFromRef(ref: PictureRef, nextTo: string, i: number): { cell: C; label: C; labels: C[] } {
    const lost = (): never => refuseChange(i, 'its place could not be kept through the other changes of this call; make them first, then put the picture in with a second call')
    if (ref.tables !== this.tables.length) lost()
    const get = (a: { table: number; row: number; col: number }) => (this.tables[a.table]?.cells as C[] | undefined)?.find((x) => x.row === a.row && x.col === a.col)
    const label = get(ref.cell!.label) ?? lost(), cell = get(ref.cell!.target) ?? lost()
    const want = strip(nextTo)
    if (strip(label.paras.map((q) => q.text).join('')) !== want) lost()
    const labels = this.tables.flatMap((t) => t.cells as C[]).filter((x) => strip(x.paras.map((q) => q.text).join('')) === want)
    return { cell, label, labels }
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
    this.rowsAfter.set(t, { after: a.after_row ?? this.tableRows(t).rows.length, count: a.rows.length })
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
    const row = this.rowHeight(t, cells)
    this.checkPageFit(plan, row, i)
    const { before: key, depth } = this.rowsAt(plan, i)
    for (const [x, g] of this.growthOut(t, a.rows.length * row) ?? []) this.grown.set(x, g)
    const newParas = plan.rows.flatMap((r) => r.map((text, ci) => ({ text, heading: cells[ci]!.paras[0]?.heading ?? 0 })))
    this.inserts.set(key, [...(this.inserts.get(key) ?? []), { change: i, depth, paras: newParas }].sort((a, b) => b.depth - a.depth || a.change - b.change))
    const k = a.rows.length
    this.note(i, `${T}, after row ${A}`, '', `${k} row${k > 1 ? 's' : ''} like row ${C}: ${a.rows.map((r) => r.join(' | ')).join(' / ')}`)
  }

  // ---- a table that fills its page
  /** each table's estimated growth from the rows added so far in this call: its own, and what tables inside it pass on */
  private grown = new Map<T, number>()

  /** The estimated growth of `t` and of each table around it when `t` grows by `g`, from `t` outwards. A table inside a
   * cell grows the table around it only by what no longer fits in that cell's height as the document states it (the
   * cell holds at least the table, so this never counts more than the outer table must grow). Null when a height
   * needed is not known. */
  private growthOut(t: T, g: number): [T, number][] | null {
    const out: [T, number][] = []
    for (let cur = t; ;) {
      const before = this.grown.get(cur) ?? 0
      out.push([cur, before + g])
      const cell = cur.para?.cell
      if (!cell) return out
      const h = this.tableHeight(cur)
      if (h === null) return null
      const room = Math.max(0, cell.height - h)
      g = Math.max(0, before + g - room) - Math.max(0, before - room)
      cur = cell.table as T
    }
  }

  /**
   * Refuses rows that would make a table taller than its page's body when it cannot continue on the next page: placed
   * as a character, or set not to split at a page boundary. Hangul then cuts off what does not fit (a statutory form
   * whose front page is one such table lost its last line, and the edit had reported success). A table inside a cell
   * is checked by the outermost table around it, with that table's settings. Only the table's own estimated height
   * counts, not the paragraphs above it on the page or rows that wrapped text makes taller, so a fit is never refused
   * that the estimate does not show to be too tall.
   */
  private checkPageFit(plan: RowPlan<C, T>, row: number, i: number) {
    const k = plan.rows.length
    const outer = (n: number) => { const c = this.growthOut(plan.t, n * row); return c ? c[c.length - 1]! : null }
    const [o, growth] = outer(k) ?? []
    if (!o || !growth) return
    const why = this.fixedOnPage(o)
    const body = why ? this.pageBody(o) : null
    const h = body ? this.tableHeight(o) : null
    if (!why || !body || h === null || h + growth <= body) return
    // the rows that fit, by the same estimate
    let fit = 0
    while (fit + 1 < k && h + outer(fit + 1)![1] <= body) fit++
    const OT = `table ${o.i + 1}`
    const which = o === plan.t ? `${plan.T} fills its page` : `${plan.T} is inside ${OT}, which fills its page`
    const s = (n: number) => (n === 1 ? '' : 's')
    refuseChange(i, `${which} and cannot continue on the next page (${why}), so Hangul would cut off its end: ` +
      `${k} row${s(k)} ${k === 1 ? 'was' : 'were'} asked for and about ${fit} fit. ` +
      (fit ? `Add at most ${fit} row${s(fit)}` : 'Fill only the rows the table already has') + ', and write the rest on a separate sheet, as such forms usually ask')
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

/** What an edit's image changes need in the worker: the page layout and each one's picture, made clean. */
export interface PictureInput { layout: HwpLayout; images: Map<number, CleanImage> }
/** The image changes' layout and pictures from a worker request (after asChanges checked the changes): every image
 * change has its picture and only those; each picture is read again here (sanitizeImage: PNG or JPEG, its size,
 * only the parts that draw it); the layout is the shape the server's parse made (numbers checked again). */
export function pictureInput(req: { changes: unknown; layout: unknown; images: Map<number, Uint8Array> }, what: string): PictureInput | undefined {
  const bad = (): never => { throw new ToolError(`the ${what} editor got a damaged request`) }
  const changes = req.changes as HwpChange[]
  const wanted = changes.flatMap((c, i) => (isImageChange(c) ? [i] : []))
  if (!wanted.length) { if (req.images.size) bad(); return undefined }
  if (wanted.length !== req.images.size || wanted.some((i) => !req.images.has(i))) bad()
  // each picture once, however many changes use it (the same bytes of the request)
  const total = [...new Set(req.images.values())].reduce((n, b) => n + b.length, 0)
  if (total > PICTURE_LIMITS.totalBytes) bad()
  const images = new Map<number, CleanImage>()
  const once = new Map<Uint8Array, CleanImage>()
  for (const i of wanted) {
    const b = req.images.get(i)!
    let made = once.get(b)
    if (!made) { made = sanitizeImage(b, (changes[i] as HwpImageChange).image); once.set(b, made) }
    images.set(i, made)
  }
  return { layout: checkLayout(req.layout) ?? bad(), images }
}
function checkLayout(v: unknown): HwpLayout | null {
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1e6
  const box = (o: any) => o && num(o.x) && num(o.y) && num(o.w) && num(o.h) && o.w >= 0 && o.h >= 0
  const l = v as HwpLayout
  if (!l || !Array.isArray(l.pages) || l.pages.length > 200) return null
  for (const p of l.pages) {
    if (!p || !num(p.w) || !num(p.h) || !Array.isArray(p.lines) || !Array.isArray(p.cells) || p.lines.length > 20_000 || p.cells.length > 20_000) return null
    if (!Number.isInteger(p.section) || !Array.isArray(p.continued) || p.continued.some((x) => !Number.isInteger(x)) || !Array.isArray(p.starts) || p.starts.some((x) => !x || !Number.isInteger(x.para) || typeof x.table !== 'boolean' || typeof x.preview !== 'string')) return null
    for (const c of p.cells) if (!box(c) || !Number.isInteger(c.table) || !Number.isInteger(c.row) || !Number.isInteger(c.col)) return null
    for (const ln of p.lines) {
      if (!box(ln) || typeof ln.text !== 'string' || typeof ln.para !== 'string' || !Number.isInteger(ln.cell) || ln.cell < -1 || ln.cell >= p.cells.length || !Array.isArray(ln.runs)) return null
      if (ln.runs.some((r) => !r || !num(r.x) || !num(r.w) || typeof r.text !== 'string')) return null
    }
  }
  return l
}

/** The changes as a worker gets them: the server checked them with the tool's schema; checked again here. */
export function asChanges(v: unknown, what: string): HwpChange[] {
  const bad = (): never => { throw new ToolError(`the ${what} editor got a damaged request`) }
  if (!Array.isArray(v)) return bad()
  const str = (x: unknown) => typeof x === 'string'
  const int = (x: unknown) => x === undefined || (Number.isInteger(x) && (x as number) >= 1)
  const mm = (x: unknown) => x === undefined || (typeof x === 'number' && Number.isFinite(x) && x >= 2 && x <= 300)
  for (const c of v) {
    if (!c || typeof c !== 'object') bad()
    if ('image' in c) {
      if (!str(c.image) || !(c.at === undefined || str(c.at)) || !int(c.occurrence) || !mm(c.width_mm) || !mm(c.height_mm)) bad()
      if (c.ref !== undefined && (!c.ref || typeof c.ref !== 'object' || !Number.isInteger(c.ref.tables) || !(c.ref.text || c.ref.cell || c.page !== undefined))) bad()
      if (c.place !== undefined && !['over', 'after', 'before'].includes(c.place)) bad()
      const num = (x: unknown) => x === undefined || (typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 5000)
      if (!int(c.page) || !num(c.x_mm) || !num(c.y_mm)) bad()
      if (c.shift !== undefined && (!c.shift || typeof c.shift !== 'object' || typeof c.shift.x_mm !== 'number' || typeof c.shift.y_mm !== 'number' || !num(c.shift.x_mm) || !num(c.shift.y_mm))) bad()
      if (c.layer !== undefined && !['behind', 'front'].includes(c.layer)) bad()
      if (c.cell !== undefined && (!c.cell || typeof c.cell !== 'object' || !str(c.cell.next_to) || (c.cell.direction !== undefined && !['right', 'below'].includes(c.cell.direction)))) bad()
    } else if ('find' in c) { if (!str(c.find) || !str(c.replace) || !int(c.occurrence) || (c.all !== undefined && typeof c.all !== 'boolean')) bad() }
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
