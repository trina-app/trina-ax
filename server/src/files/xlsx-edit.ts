// edit_office for an .xlsx (office-edit.ts holds what the three editors share). Changes, all found in the workbook as
// the AI read it:
// - { cell: { sheet, ref, value } }: a number, text, true/false, empty (null or ""), or a formula (text that starts with
//   "="; "'=" keeps the text). The cell keeps its style (`s`: number format, font, fill, border). Text is an inline
//   string, so xl/sharedStrings.xml is not rewritten (Excel and LibreOffice turn it into a shared string when they save).
// - { append_rows: { sheet, rows } }: rows after the last row, starting in the column where the last row starts, each
//   cell styled like the cell above it; a table (ListObject) that ends at the last row grows to take them.
// Rows are never inserted in the middle (every reference below would have to move). Refused: a cell inside a merged
// area (not its top-left cell), an array formula's range, a shared formula's first cell when others use it, a table's
// header row, a cell holding a picture or a rich value. Every change sets fullCalcOnLoad in xl/workbook.xml (the app
// calculates every formula when it opens the file) and drops xl/calcChain.xml when a formula cell changes, as Excel
// does when it rebuilds the chain. The sheets' XML outside the edited rows, every other sheet, styles, charts, pivot
// tables, named ranges and every other part are kept byte for byte.
import {
  applySplices, attrOf, escAttr, escText, find, kid, kidsNamed, mainPart, readRels, refuse, registerEditor, relId, relsPartOf,
  slice, withAttr, xmlTree, type CellWrite, type EditNote, type Pkg, type Splice, type XNode,
} from './office-edit'
import { unescapeXml } from './ooxml'

export type XlsxValue = string | number | boolean | null
export type XlsxChange =
  | { cell: { sheet?: string; ref: string; value: XlsxValue } }
  | { append_rows: { sheet?: string; rows: XlsxValue[][] } }

const MAX_ROW = 1_048_576, MAX_COL = 16_384
/** formulas whose stored result is kept: they cannot be calculated again when the file opens (another workbook,
 * an OLAP cube, a real-time server, an add-in, the web) */
export const KEEP_RESULT = /\[\d+\]|(?:^|[^A-Za-z0-9_.])(?:_xlfn\.)?(?:CUBE[A-Z]*|RTD|WEBSERVICE|FILTERXML|STOCKHISTORY|IMAGE|INFO|CALL|REGISTER(?:\.ID)?|EUROCONVERT|SQL\.REQUEST|DDE)\s*\(|_xll\.|_xlws\.|\|/i
export const colName = (n: number): string => (n > 26 ? colName(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26))
export function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim())
  if (!m) return null
  let col = 0
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  const row = Number(m[2])
  return col >= 1 && col <= MAX_COL && row >= 1 && row <= MAX_ROW ? { col, row } : null
}
function parseRange(ref: string): { c1: number; r1: number; c2: number; r2: number } | null {
  const [a, b] = ref.split(':')
  const p = parseRef(a ?? ''), q = b ? parseRef(b) : p
  if (!p || !q) return null
  return { c1: Math.min(p.col, q.col), r1: Math.min(p.row, q.row), c2: Math.max(p.col, q.col), r2: Math.max(p.row, q.row) }
}
const inRange = (g: { c1: number; r1: number; c2: number; r2: number }, col: number, row: number) => col >= g.c1 && col <= g.c2 && row >= g.r1 && row <= g.r2

interface Sheet { name: string; part: string; xml: string; tree: XNode; data: XNode; rows: Map<number, XNode>; lastRow: number }

/** A cell's new XML: its address and style, the value (or formula without its "="). */
export function cellXml(ref: string, s: string | undefined, v: XlsxValue): { xml: string; write: Omit<CellWrite, 'sheet' | 'ref'> } {
  const sa = s !== undefined ? ` s="${escAttr(s)}"` : ''
  if (v === null || v === '') return { xml: `<c r="${ref}"${sa}/>`, write: { value: null } }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) refuse(`cell ${ref}: ${v} is not a number a spreadsheet can hold`)
    return { xml: `<c r="${ref}"${sa}><v>${String(v)}</v></c>`, write: { value: v } }
  }
  if (typeof v === 'boolean') return { xml: `<c r="${ref}"${sa} t="b"><v>${v ? 1 : 0}</v></c>`, write: { value: v } }
  if (v.startsWith('=')) {
    const f = v.slice(1)
    return { xml: `<c r="${ref}"${sa}><f>${escText(f)}</f></c>`, write: { value: null, formula: f } }
  }
  const text = v.startsWith("'=") ? v.slice(1) : v
  const sp = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : ''
  return { xml: `<c r="${ref}"${sa} t="inlineStr"><is><t${sp}>${escText(text)}</t></is></c>`, write: { value: text } }
}

/** What a cell shows in the report: its formula, its value, or (a shared string) the string. */
function shown(xml: string, c: XNode | undefined, shared: (i: number) => string): string {
  if (!c || c.self) return ''
  const f = kid(c, 'f'), v = kid(c, 'v'), is = kid(c, 'is')
  if (f && !f.self) return '=' + unescapeXml(xml.slice(f.openEnd, f.closeStart))
  if (is) return [...xml.slice(is.openEnd, is.closeStart).matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join('')
  if (!v || v.self) return ''
  const raw = unescapeXml(xml.slice(v.openEnd, v.closeStart))
  return attrOf(c.head, 't') === 's' ? shared(Number(raw)) : raw
}

export function editXlsx(pkg: Pkg, changes: unknown[]): { notes: EditNote[]; cells: CellWrite[]; recalc: boolean } {
  const wbPart = mainPart(pkg, 'xl/workbook.xml')
  const wbXml = pkg.need(wbPart)
  const wbTree = xmlTree(wbXml, wbPart)
  const wbRels = readRels(pkg, wbPart) ?? refuse('this file cannot be changed (the workbook has no relationships)')
  const sheetsEl = find(wbTree, 'sheets') ?? refuse('this file is not an Excel workbook (no sheets)')
  const list = kidsNamed(sheetsEl, 'sheet').map((n) => {
    const rid = relId(n.head)
    const rel = wbRels.rels.find((r) => r.id === rid)
    return { name: attrOf(n.head, 'name') ?? '', rel }
  })
  if (!list.length) refuse('this workbook has no sheets')
  // shared strings: only read (for the report), never rewritten
  const ssRel = wbRels.rels.find((r) => r.type === 'sharedStrings')
  let strings: string[] | null = null
  const shared = (i: number) => {
    if (strings === null) {
      const x = ssRel ? pkg.text(ssRel.target) : null
      strings = x ? [...x.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1]!.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((t) => unescapeXml(t[1]!)).join('')) : []
    }
    return strings[i] ?? ''
  }

  const opened = new Map<string, Sheet>()
  const sheetOf = (i: number, name: unknown): Sheet => {
    const want = typeof name === 'string' && name.trim() ? name.trim() : null
    const hit = want === null ? list[0]! : list.find((s) => s.name === want) ?? list.find((s) => s.name.toLowerCase() === want.toLowerCase())
    if (!hit) return refuse(`change ${i + 1}: there is no sheet ${JSON.stringify(want)} (the sheets are ${list.map((s) => JSON.stringify(s.name)).join(', ')})`)
    if (!hit.rel || hit.rel.type !== 'worksheet' || hit.rel.external) return refuse(`change ${i + 1}: ${JSON.stringify(hit.name)} is a chart sheet or a dialog sheet, not a sheet of cells`)
    const got = opened.get(hit.name)
    if (got) return got
    const xml = pkg.need(hit.rel.target)
    const tree = xmlTree(xml, hit.rel.target)
    const ws = kid(tree, 'worksheet') ?? refuse(`this file cannot be changed (${hit.rel.target} is not a worksheet)`)
    const data = kid(ws, 'sheetData') ?? refuse(`this file cannot be changed (${hit.rel.target} has no cells part)`)
    const rows = new Map<number, XNode>()
    let lastRow = 0
    for (const r of kidsNamed(data, 'row')) {
      const n = Number(attrOf(r.head, 'r'))
      if (!Number.isInteger(n) || n < 1) refuse(`this file cannot be changed (${hit.name} has rows without their numbers; open and save it in Excel or LibreOffice first)`)
      for (const c of kidsNamed(r, 'c')) if (!attrOf(c.head, 'r')) refuse(`this file cannot be changed (${hit.name} has cells without their addresses; open and save it in Excel or LibreOffice first)`)
      rows.set(n, r)
      lastRow = Math.max(lastRow, n)
    }
    const s: Sheet = { name: hit.name, part: hit.rel.target, xml, tree, data, rows, lastRow }
    opened.set(hit.name, s)
    return s
  }

  /** per sheet and row: the cells to write (col -> xml), and the rows to add at the end */
  const writes = new Map<Sheet, Map<number, Map<number, { xml: string; change: number }>>>()
  const appended = new Map<Sheet, { rows: string[]; first: number; last: number; c1: number; c2: number; change: number }>()
  const notes: EditNote[] = []
  const cells: CellWrite[] = []
  let formulaTouched = false
  /** a cell now reads differently: formulas that use it must be calculated again */
  let valuesChanged = false

  /** what stops a write to one cell (merged areas, array and shared formulas, a table's header, pictures in cells) */
  const blockers = new Map<Sheet, { merges: ReturnType<typeof parseRange>[]; arrays: ReturnType<typeof parseRange>[]; sharedMasters: Map<string, string>; headers: ReturnType<typeof parseRange>[]; tables: { part: string; xml: string; node: XNode; ref: ReturnType<typeof parseRange> }[] }>()
  const blockersOf = (s: Sheet) => {
    let b = blockers.get(s)
    if (b) return b
    const ws = kid(s.tree, 'worksheet')!
    const mc = kid(ws, 'mergeCells')
    const merges = mc ? kidsNamed(mc, 'mergeCell').map((m) => parseRange(attrOf(m.head, 'ref') ?? '')).filter(Boolean) : []
    const arrays: ReturnType<typeof parseRange>[] = []
    const sharedMasters = new Map<string, string>()
    for (const r of s.rows.values()) for (const c of kidsNamed(r, 'c')) {
      const f = kid(c, 'f')
      if (!f) continue
      const t = attrOf(f.head, 't'), ref = attrOf(f.head, 'ref')
      if ((t === 'array' || t === 'dataTable') && ref) arrays.push(parseRange(ref))
      if (t === 'shared' && ref) sharedMasters.set(attrOf(c.head, 'r')!.toUpperCase(), ref)
    }
    const rels = readRels(pkg, s.part)
    const tables = (rels?.rels ?? []).filter((r) => r.type === 'table' && !r.external).map((r) => {
      const xml = pkg.need(r.target)
      const node = kid(xmlTree(xml, r.target), 'table') ?? refuse(`this file cannot be changed (${r.target} is not a table)`)
      return { part: r.target, xml, node, ref: parseRange(attrOf(node.head, 'ref') ?? '') }
    })
    const headers = tables.filter((t) => attrOf(t.node.head, 'headerRowCount') !== '0' && t.ref).map((t) => ({ ...t.ref!, r2: t.ref!.r1 }))
    b = { merges, arrays, sharedMasters, headers, tables }
    blockers.set(s, b)
    return b
  }

  const put = (i: number, s: Sheet, col: number, row: number, v: XlsxValue, style: string | undefined, existing: XNode | undefined) => {
    const ref = `${colName(col)}${row}`
    const b = blockersOf(s)
    const where = `change ${i + 1}: ${s.name}!${ref}`
    const merge = b.merges.find((g) => g && inRange(g, col, row) && !(g.c1 === col && g.r1 === row))
    if (merge) refuse(`${where} is inside the merged cells ${colName(merge.c1)}${merge.r1}:${colName(merge.c2)}${merge.r2}; write to ${colName(merge.c1)}${merge.r1}`)
    const arr = b.arrays.find((g) => g && inRange(g, col, row) && !(g.c1 === g.c2 && g.r1 === g.r2))
    if (arr) refuse(`${where} is part of an array formula over ${colName(arr.c1)}${arr.r1}:${colName(arr.c2)}${arr.r2}, which is changed only as a whole in Excel`)
    const sm = b.sharedMasters.get(ref)
    if (sm && sm.includes(':') && sm.split(':')[0] !== sm.split(':')[1]) refuse(`${where} holds the formula that the cells ${sm} share; change those cells one by one, or the formula in Excel`)
    if (b.headers.some((g) => g && inRange(g, col, row))) refuse(`${where} is a header of a table; rename the column in Excel (the table's formulas refer to it)`)
    if (existing && (attrOf(existing.head, 'vm') !== undefined || attrOf(existing.head, 'cm') !== undefined)) refuse(`${where} holds a picture or a linked value in the cell, which is not changed here`)
    const out = cellXml(ref, style, v)
    if ((existing && kid(existing, 'f')) || out.write.formula !== undefined) formulaTouched = true
    const rows = writes.get(s) ?? new Map()
    writes.set(s, rows)
    const row1 = rows.get(row) ?? new Map()
    rows.set(row, row1)
    if (row1.has(col)) refuse(`changes ${row1.get(col).change + 1} and ${i + 1} both write ${s.name}!${ref}`)
    row1.set(col, { xml: out.xml, change: i })
    cells.push({ sheet: s.name, ref, ...out.write })
    const before = shown(s.xml, existing, shared)
    if (before !== (out.write.formula !== undefined ? `=${out.write.formula}` : v === null ? '' : String(out.write.value))) valuesChanged = true
    return { ref, before }
  }
  const cellAt = (s: Sheet, col: number, row: number) => {
    const r = s.rows.get(row)
    return r ? kidsNamed(r, 'c').find((c) => parseRef(attrOf(c.head, 'r')!)?.col === col) : undefined
  }
  /** the style a new cell takes: the row's style when it has one, else the column's */
  const newStyle = (s: Sheet, col: number, row: number): string | undefined => {
    const r = s.rows.get(row)
    if (r && attrOf(r.head, 'customFormat') === '1' && attrOf(r.head, 's') !== undefined) return attrOf(r.head, 's')
    const cols = kid(kid(s.tree, 'worksheet')!, 'cols')
    const c = cols ? kidsNamed(cols, 'col').find((x) => Number(attrOf(x.head, 'min')) <= col && col <= Number(attrOf(x.head, 'max'))) : undefined
    return c ? attrOf(c.head, 'style') : undefined
  }
  const value = (i: number, v: unknown): XlsxValue => {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    return refuse(`change ${i + 1}: a value is text, a number, true/false or null`)
  }

  changes.forEach((raw, i) => {
    const c = raw as Record<string, any>
    if (c.cell) {
      const s = sheetOf(i, c.cell.sheet)
      const p = parseRef(String(c.cell.ref ?? '')) ?? refuse(`change ${i + 1}: ${JSON.stringify(c.cell.ref)} is not a cell address such as B7`)
      const existing = cellAt(s, p.col, p.row)
      const style = existing ? attrOf(existing.head, 's') : newStyle(s, p.col, p.row)
      const v = value(i, c.cell.value)
      const r = put(i, s, p.col, p.row, v, style, existing)
      notes.push({ change: i, where: `${s.name}!${r.ref}`, before: r.before, after: [v === null ? '' : String(v)] })
      return
    }
    if (c.append_rows) {
      const s = sheetOf(i, c.append_rows.sheet)
      if (appended.has(s)) refuse(`change ${i + 1}: rows are already added to ${s.name} in change ${appended.get(s)!.change + 1}; give all new rows in one append_rows`)
      const rows = c.append_rows.rows as unknown[][]
      if (!Array.isArray(rows) || !rows.length) refuse(`change ${i + 1}: give the rows to add`)
      const last = s.lastRow ? s.rows.get(s.lastRow)! : null
      const lastCells = last ? kidsNamed(last, 'c') : []
      const c1 = lastCells.length ? Math.min(...lastCells.map((x) => parseRef(attrOf(x.head, 'r')!)!.col)) : 1
      const first = s.lastRow + 1
      if (first + rows.length - 1 > MAX_ROW) refuse(`change ${i + 1}: the sheet would have more rows than a spreadsheet can hold`)
      let c2 = c1
      const made: string[] = []
      rows.forEach((vals, k) => {
        if (!Array.isArray(vals)) refuse(`change ${i + 1}: each row is a list of values`)
        const row = first + k
        const parts: string[] = []
        vals.forEach((v0, j) => {
          const col = c1 + j
          if (col > MAX_COL) refuse(`change ${i + 1}: a row has more columns than a spreadsheet can hold`)
          const above = last ? kidsNamed(last, 'c').find((x) => parseRef(attrOf(x.head, 'r')!)!.col === col) : undefined
          const style = above ? attrOf(above.head, 's') : newStyle(s, col, row)
          const v = value(i, v0)
          const out = cellXml(`${colName(col)}${row}`, style, v)
          if (out.write.formula !== undefined) formulaTouched = true
          if (v !== null && v !== '') { cells.push({ sheet: s.name, ref: `${colName(col)}${row}`, ...out.write }); valuesChanged = true }
          parts.push(out.xml)
          c2 = Math.max(c2, col)
        })
        let head = ` r="${row}"`
        if (last) for (const a of ['s', 'customFormat', 'ht', 'customHeight']) { const x = attrOf(last.head, a); if (x !== undefined) head += ` ${a}="${escAttr(x)}"` }
        made.push(`<row${head}>${parts.join('')}</row>`)
        notes.push({ change: i, where: `${s.name}!row ${row} (new)`, after: vals.map((v) => (v === null ? '' : String(v))) })
      })
      appended.set(s, { rows: made, first, last: first + rows.length - 1, c1, c2, change: i })
      return
    }
    refuse(`change ${i + 1} is not a change edit_office makes in a workbook (cell, append_rows)`)
  })

  // the sheets: each changed row rebuilt from its own cells (untouched ones copied as they are), new rows in order
  for (const s of opened.values()) {
    const splices: Splice[] = []
    const rows = writes.get(s) ?? new Map<number, Map<number, { xml: string; change: number }>>()
    let minC = Infinity, minR = Infinity, maxC = 0, maxR = 0
    const grow = (c: number, r: number) => { minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r) }
    const newRows: { row: number; xml: string; change: number }[] = []
    for (const [rowN, cols] of rows) {
      for (const col of cols.keys()) grow(col, rowN)
      const change = Math.min(...[...cols.values()].map((x) => x.change))
      const r = s.rows.get(rowN)
      if (!r) {
        newRows.push({ row: rowN, xml: `<row r="${rowN}">${[...cols].sort((a, b) => a[0] - b[0]).map(([, x]) => x.xml).join('')}</row>`, change })
        continue
      }
      const out: { col: number; xml: string }[] = kidsNamed(r, 'c').map((c) => {
        const col = parseRef(attrOf(c.head, 'r')!)!.col
        const w = cols.get(col)
        return { col, xml: w ? w.xml : slice(s.xml, c) }
      })
      for (const [col, w] of cols) if (!out.some((o) => o.col === col)) out.push({ col, xml: w.xml })
      out.sort((a, b) => a.col - b.col)
      // a row's `spans` (a hint of its first and last column) is dropped: it may no longer be right
      const head = r.head.replace(/\sspans="[^"]*"/, '')
      const others = r.kids.filter((k) => k.name !== 'c').map((k) => slice(s.xml, k)).join('')
      splices.push({ from: r.start, to: r.end, text: `<row${head}>${out.map((o) => o.xml).join('')}${others}</row>`, change })
    }
    const ap = appended.get(s)
    if (ap) { grow(ap.c1, ap.first); grow(ap.c2, ap.last) }
    // new rows go before the first row with a higher number, appended ones at the end
    const ordered = [...s.rows.keys()].sort((a, b) => a - b)
    for (const nr of newRows.sort((a, b) => a.row - b.row)) {
      const next = ordered.find((n) => n > nr.row)
      const at = next !== undefined ? s.rows.get(next)!.start : s.data.self ? -1 : s.data.closeStart
      splices.push({ from: at, to: at, text: nr.xml, change: nr.change })
    }
    if (ap) {
      const at = s.data.self ? -1 : s.data.closeStart
      splices.push({ from: at, to: at, text: ap.rows.join(''), change: ap.change })
    }
    let xml: string
    if (s.data.self) {
      // <sheetData/>: opened with the new rows in it
      const body = splices.filter((x) => x.from === -1).sort((a, b) => a.change - b.change).map((x) => x.text).join('')
      xml = applySplices(s.xml, [...splices.filter((x) => x.from !== -1), { from: s.data.start, to: s.data.end, text: `<sheetData>${body}</sheetData>`, change: 0 }], s.part)
    } else xml = applySplices(s.xml, splices, s.part)
    // the used range grows to take the new cells
    const dim = kid(kid(s.tree, 'worksheet')!, 'dimension')
    if (dim && maxC) {
      const g = parseRange(attrOf(dim.head, 'ref') ?? '')
      const ref = g ? `${colName(Math.min(g.c1, minC))}${Math.min(g.r1, minR)}:${colName(Math.max(g.c2, maxC))}${Math.max(g.r2, maxR)}` : `${colName(minC)}${minR}:${colName(maxC)}${maxR}`
      const t2 = xmlTree(xml, s.part)
      const d2 = kid(kid(t2, 'worksheet')!, 'dimension')!
      xml = xml.slice(0, d2.start) + `<dimension${withAttr(d2.head, 'ref', ref)}/>` + xml.slice(d2.end)
    }
    pkg.set(s.part, xml)
    // a table that ends at the old last row takes the new rows (as Excel does when one types below it)
    if (ap) for (const t of blockersOf(s).tables) {
      if (!t.ref || t.ref.r2 !== ap.first - 1 || ap.c1 < t.ref.c1 || ap.c2 > t.ref.c2 || attrOf(t.node.head, 'totalsRowCount') && attrOf(t.node.head, 'totalsRowCount') !== '0') continue
      const ref = `${colName(t.ref.c1)}${t.ref.r1}:${colName(t.ref.c2)}${ap.last}`
      let tx = t.xml.slice(0, t.node.start) + `<table${withAttr(t.node.head, 'ref', ref)}${t.node.self ? '/>' : '>'}` + t.xml.slice(t.node.openEnd)
      const af = find(xmlTree(tx, t.part), 'autoFilter')
      if (af) tx = tx.slice(0, af.start) + `<autoFilter${withAttr(af.head, 'ref', ref)}${af.self ? '/>' : '>'}` + tx.slice(af.openEnd)
      pkg.set(t.part, tx)
      notes.push({ change: ap.change, where: `the table ${JSON.stringify(attrOf(t.node.head, 'displayName') ?? attrOf(t.node.head, 'name') ?? '')} now ends at row ${ap.last}` })
    }
  }

  // stored results of formulas would be the old ones (LibreOffice does not calculate a file from Excel again on open,
  // and previews show the stored results): every formula cell of the workbook's sheets loses its stored result, so the
  // app calculates it when it opens the file. The formulas themselves are not touched.
  // Only when a cell reads differently, and never for a formula whose result cannot be calculated again on open (a
  // link to another workbook, CUBE*, RTD, add-in and web functions): its stored result is the only value there is.
  let cleared = 0
  for (const sh of valuesChanged ? list : []) {
    if (!sh.rel || sh.rel.type !== 'worksheet' || sh.rel.external) continue
    const x = pkg.text(sh.rel.target)
    if (x === null || !x.includes('<f')) continue
    const t = xmlTree(x, sh.rel.target)
    const data = kid(kid(t, 'worksheet') ?? t, 'sheetData')
    if (!data) continue
    const cuts: Splice[] = []
    // a shared formula's text is on its first cell only; the others name it by `si`
    const sharedText = new Map<string, string>()
    for (const r of kidsNamed(data, 'row')) for (const c of kidsNamed(r, 'c')) {
      const f = kid(c, 'f')
      if (f && !f.self && attrOf(f.head, 't') === 'shared') sharedText.set(attrOf(f.head, 'si') ?? '', x.slice(f.openEnd, f.closeStart))
    }
    for (const r of kidsNamed(data, 'row')) for (const c of kidsNamed(r, 'c')) {
      const v = kid(c, 'v')
      const f = kid(c, 'f')
      if (!f || !v) continue
      const text = f.self || f.openEnd === f.closeStart ? sharedText.get(attrOf(f.head, 'si') ?? '') ?? '' : x.slice(f.openEnd, f.closeStart)
      if (KEEP_RESULT.test(unescapeXml(text))) continue
      // the result's type goes with it (t="str", "b", "e"); the cell's style stays
      cuts.push({ from: c.start, to: c.openEnd, text: `<c${c.head.replace(/\st="[^"]*"/, '')}>`, change: 0 })
      cuts.push({ from: v.start, to: v.end, text: '', change: 0 })
      cleared++
    }
    if (cuts.length) pkg.set(sh.rel.target, applySplices(x, cuts, sh.rel.target))
  }
  // and the app calculates every formula when it opens the file (Excel)
  {
    const calc = find(wbTree, 'calcPr')
    let x = wbXml
    if (calc) x = x.slice(0, calc.start) + `<calcPr${withAttr(calc.head, 'fullCalcOnLoad', '1')}${calc.self ? '/>' : '>'}` + x.slice(calc.openEnd)
    else {
      const wb = kid(wbTree, 'workbook')!
      const after = kid(wb, 'definedNames') ?? sheetsEl
      x = x.slice(0, after.end) + '<calcPr fullCalcOnLoad="1"/>' + x.slice(after.end)
    }
    pkg.set(wbPart, x)
  }
  // the calculation chain lists formula cells; a stale one makes Excel repair the file
  const chain = wbRels.rels.find((r) => r.type === 'calcChain')
  if (chain && formulaTouched) {
    pkg.remove(chain.target)
    const relsName = relsPartOf(wbPart)
    pkg.set(relsName, wbRels.xml.slice(0, chain.node.start) + wbRels.xml.slice(chain.node.end))
    const types = pkg.need('[Content_Types].xml')
    pkg.set('[Content_Types].xml', types.replace(new RegExp(`<Override\\b[^>]*PartName="/${chain.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`), ''))
  }
  if (cleared) notes.push({ change: 0, where: `${cleared} formula result${cleared === 1 ? '' : 's'} cleared, so Excel and LibreOffice calculate them when they open the file` })
  return { notes, cells, recalc: cleared > 0 }
}

registerEditor('xlsx', (pkg, changes) => editXlsx(pkg, changes))
