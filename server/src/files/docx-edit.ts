// edit_office for a .docx (office-edit.ts holds what the three editors share). Changes, all found in the document as the
// AI read it, never in each other's results:
// - { find, replace }: exact text inside one paragraph (body, headers, footers, footnotes); the new text takes the
//   formatting of the first run it touches; `occurrence` or `all` when it is in several places.
// - { insert_paragraph: { after | before, text } }: new paragraphs next to the one holding the text, with its paragraph
//   properties (style, numbering, spacing) and its first run's formatting; one paragraph per line.
// - { delete_paragraph: { text } }
// - { table_cell: { table, row, column, value } }, { add_rows: { table, after_row, rows } }, { delete_rows: { table, rows } }
//   (1-based; tables in reading order, a table inside a table not counted).
// Kept: comments, tracked changes, headers, footers, pictures, fields, content controls and every other part. A change
// that would cut through a tracked change, a field, a comment's range or vertically merged cells is refused with the
// reason. Only the byte ranges of the edited elements change in word/document.xml (and the header / footer / notes part
// a find/replace hit); every other part keeps its compressed bytes.
import {
  find, findAll, kid, kidsNamed, matchesOf, paragraphs, pick, refuse, registerEditor, registerLister, slice, textSplices, W, without,
  applySplices, attrOf, escText, mainPart, type EditNote, type Para, type Pkg, type Splice, type XNode, xmlTree,
} from './office-edit'

export type DocxChange =
  | { find: string; replace: string; occurrence?: number; all?: boolean }
  | { insert_paragraph: { after?: string; before?: string; text: string; occurrence?: number } }
  | { delete_paragraph: { text: string; occurrence?: number } }
  | { table_cell: { table: number; row: number; column: number; value: string } }
  | { add_rows: { table: number; after_row: number; rows: string[][] } }
  | { delete_rows: { table: number; rows: number[] } }

/** what a new paragraph takes from the one it copies: its properties without a section break or a tracked change */
const PPR_DROP = new Set(['w:sectPr', 'w:pPrChange', 'w:ins', 'w:del', 'w:moveFrom', 'w:moveTo'])
const RPR_DROP = new Set(['w:rPrChange', 'w:ins', 'w:del', 'w:moveFrom', 'w:moveTo'])
const TRACKED = /<w:(ins|del|moveFrom|moveTo)[\s>/]/
const COMMENTED = /<w:(commentRangeStart|commentRangeEnd|commentReference)[\s>/]/

/** The parts whose paragraphs are read and searched, in reading order: the body, then headers, footers and notes. */
function textParts(pkg: Pkg, main: string): string[] {
  const dir = main.slice(0, main.lastIndexOf('/') + 1)
  const extra = pkg.names().filter((n) => n.startsWith(dir) && /^(header|footer)\d*\.xml$/.test(n.slice(dir.length))).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return [main, ...extra, ...['footnotes.xml', 'endnotes.xml'].map((n) => dir + n).filter((n) => pkg.has(n))]
}

/** a run's text element with new text: tabs and line breaks become <w:tab/> and <w:br/> in the same run. The element's
 * own attributes stay as they are (pandoc writes xml:space="preserve" on every run): only text with a space at either
 * end adds xml:space="preserve" when the element did not have it, so nothing but the text changes otherwise */
function wText(head: string, text: string): string {
  const preserved = /\sxml:space="preserve"/.test(head)
  const t = (s: string) => `<w:t${preserved || !/^\s|\s$/.test(s) ? head : `${head.replace(/\sxml:space="[^"]*"/, '')} xml:space="preserve"`}>${escText(s)}</w:t>`
  return text.split('\n').map((line) => line.split('\t').map(t).join('<w:tab/>')).join('<w:br/>')
}

/** A paragraph's properties and its first run's formatting, as new paragraphs copy them. */
function looks(xml: string, p: XNode): { pPr: string; rPr: string } {
  const pPr = kid(p, 'w:pPr')
  const run = findAll(p, 'w:r').find((r) => kid(r, 'w:rPr'))
  const rPr = run ? kid(run, 'w:rPr') : null
  return { pPr: pPr ? without(xml, pPr, PPR_DROP) : '', rPr: rPr ? without(xml, rPr, RPR_DROP) : '' }
}
/** a new paragraph; `pre` and `post` (kept bookmarks) go right after its properties and before its end */
function paragraphXml(l: { pPr: string; rPr: string }, text: string, pre = '', post = ''): string {
  return `<w:p>${l.pPr}${pre}${text ? `<w:r>${l.rPr}${wText('', text)}</w:r>` : ''}${post}</w:p>`
}

/** The top-level tables of the body in reading order (one inside another is part of that one). */
function tables(tree: XNode): XNode[] {
  const body = find(tree, 'w:body')
  return body ? findAll(body, 'w:tbl') : []
}
const rowsOf = (tbl: XNode) => kidsNamed(tbl, 'w:tr')
const cellsOf = (tr: XNode) => kidsNamed(tr, 'w:tc')

/** A cell's content set to `value`: its properties kept, one paragraph per line in the first paragraph's look; its
 * bookmarks kept around the new text. Refused when it holds a table, a picture, a comment or a tracked change. */
function cellXml(xml: string, tc: XNode, value: string, where: string): string {
  const s = slice(xml, tc)
  if (kid(tc, 'w:tbl') || find(tc, 'w:tbl')) refuse(`${where}: the cell holds a table; change its text with find and replace`)
  if (/<w:(drawing|pict|object)[\s>/]/.test(s)) refuse(`${where}: the cell holds a picture, which would be lost; change its text with find and replace`)
  if (TRACKED.test(s)) refuse(`${where}: the cell holds a tracked change (a suggested edit); accept or reject it in Word first`)
  if (COMMENTED.test(s)) refuse(`${where}: the cell has a comment on it; change its text with find and replace so the comment stays`)
  const tcPr = kid(tc, 'w:tcPr')
  const first = kid(tc, 'w:p')
  const look = first ? looks(xml, first) : { pPr: '', rPr: '' }
  const marks = findAll(tc, 'w:bookmarkStart').map((n) => slice(xml, n))
  const ends = findAll(tc, 'w:bookmarkEnd').map((n) => slice(xml, n))
  const lines = value.split(/\r?\n/)
  // built, never spliced in with a replace pattern ("$1" or "$&" in a bookmark's name stays as it is)
  const paras = lines.map((line, i) => paragraphXml(look, line, i === 0 ? marks.join('') : '', i === lines.length - 1 ? ends.join('') : ''))
  return `<w:tc${tc.head}>${tcPr ? slice(xml, tcPr) : ''}${paras.join('')}</w:tc>`
}
/** the open tag of an element without Word's ids for it (a copy must not repeat them) */
const openTag = (name: string, head: string) => `<${name}${head.replace(/\s(w14:paraId|w14:textId|w:rsidR|w:rsidTr)="[^"]*"/g, '')}>`

function vmerged(tr: XNode): boolean { return cellsOf(tr).some((tc) => { const p = kid(tc, 'w:tcPr'); return !!(p && kid(p, 'w:vMerge')) }) }

export function editDocx(pkg: Pkg, changes: unknown[]): { notes: EditNote[] } {
  const main = mainPart(pkg, 'word/document.xml')
  if (!pkg.has(main)) refuse('this file is not a Word document (no word/document.xml)')
  const parts = textParts(pkg, main)
  const xmls = new Map(parts.map((p) => [p, pkg.need(p)]))
  const trees = new Map(parts.map((p) => [p, xmlTree(xmls.get(p)!, p)]))
  const paras = new Map(parts.map((p) => [p, paragraphs(xmls.get(p)!, trees.get(p)!, p, W)]))
  const all = parts.flatMap((p) => paras.get(p)!)
  const body = paras.get(main)!
  const xml = xmls.get(main)!
  const tree = trees.get(main)!
  const tbls = tables(tree)
  const splices = new Map<string, Splice[]>(parts.map((p) => [p, []]))
  const notes: EditNote[] = []
  /** text edits per paragraph, made together at the end (two changes in one paragraph) */
  const textEdits = new Map<Para, { at: number; len: number; text: string; change: number }[]>()
  const label = (p: Para) => (p.part === main ? '' : ` (${p.part.split('/').pop()!.replace(/\.xml$/, '').replace(/\d+$/, '')})`)
  const table = (i: number, n: number) => tbls[n - 1] ?? refuse(`change ${i + 1}: there is no table ${n} (the document has ${tbls.length})`)
  const row = (i: number, tbl: XNode, t: number, n: number) => rowsOf(tbl)[n - 1] ?? refuse(`change ${i + 1}: table ${t} has no row ${n} (it has ${rowsOf(tbl).length})`)
  const anchor = (i: number, text: string, c: { occurrence?: number }) => pick(matchesOf(body.filter((p) => !p.box), text), c, i, ' of the body', text)[0]!.para

  changes.forEach((raw, i) => {
    const c = raw as Record<string, any>
    if (typeof c.find === 'string') {
      if (!c.find) refuse(`change ${i + 1}: find is empty`)
      if (typeof c.replace !== 'string') refuse(`change ${i + 1}: give replace`)
      for (const m of pick(matchesOf(all, c.find), c, i, '', c.find)) {
        const list = textEdits.get(m.para) ?? []
        list.push({ at: m.at, len: c.find.length, text: c.replace, change: i })
        textEdits.set(m.para, list)
      }
      return
    }
    if (c.insert_paragraph) {
      const x = c.insert_paragraph
      const at = x.after ?? x.before
      if (typeof at !== 'string' || !at || (x.after !== undefined && x.before !== undefined)) refuse(`change ${i + 1}: give after or before (text of the paragraph next to which the new one goes)`)
      const p = anchor(i, at, x)
      const lines = String(x.text).split(/\r?\n/)
      const look = looks(xml, p.node)
      splices.get(main)!.push({ from: x.after !== undefined ? p.node.end : p.node.start, to: x.after !== undefined ? p.node.end : p.node.start, text: lines.map((l: string) => paragraphXml(look, l)).join(''), change: i })
      notes.push({ change: i, where: `new paragraph ${x.after !== undefined ? 'after' : 'before'} ${JSON.stringify(p.text.slice(0, 60))}`, after: lines.filter((l: string) => l !== '') })
      // an empty line is an empty paragraph, which the read-back cannot tell from nothing
      if (lines.some((l: string) => l === '')) notes[notes.length - 1]!.after!.push('')
      return
    }
    if (c.delete_paragraph) {
      const p = anchor(i, c.delete_paragraph.text, c.delete_paragraph)
      const s = slice(xml, p.node)
      if (/<w:sectPr[\s>/]/.test(s)) refuse(`change ${i + 1}: that paragraph ends a section of the document (page size, margins, columns); delete its text with find and replace instead`)
      if (COMMENTED.test(s)) refuse(`change ${i + 1}: that paragraph has a comment on it; delete the comment in Word first, or change its text with find and replace`)
      if (p.node.parent?.name === 'w:tc' && kidsNamed(p.node.parent, 'w:p').length === 1) refuse(`change ${i + 1}: that is the only paragraph of a table cell; set the cell's text with table_cell instead`)
      // a field that starts here and ends in another paragraph (or the other way) would lose its other half
      const fields = findAll(p.node, 'w:fldChar').reduce((n, f) => n + (attrOf(f.head, 'w:fldCharType') === 'begin' ? 1 : attrOf(f.head, 'w:fldCharType') === 'end' ? -1 : 0), 0)
      if (fields !== 0) refuse(`change ${i + 1}: a field (a table of contents, a cross-reference) starts or ends in that paragraph and goes on outside it; change its text with find and replace instead`)
      const starts = findAll(p.node, 'w:bookmarkStart').length, ends = findAll(p.node, 'w:bookmarkEnd').length
      if (starts !== ends) refuse(`change ${i + 1}: a bookmark starts or ends in that paragraph and goes on outside it; change its text with find and replace instead`)
      splices.get(main)!.push({ from: p.node.start, to: p.node.end, text: '', change: i })
      notes.push({ change: i, where: 'paragraph deleted', before: p.text })
      return
    }
    if (c.table_cell) {
      const x = c.table_cell
      const tbl = table(i, x.table)
      const tr = row(i, tbl, x.table, x.row)
      const tc = cellsOf(tr)[x.column - 1] ?? refuse(`change ${i + 1}: row ${x.row} of table ${x.table} has no cell ${x.column} (it has ${cellsOf(tr).length})`)
      const where = `change ${i + 1}`
      const old = body.filter((p) => p.node.parent === tc)
      splices.get(main)!.push({ from: tc.start, to: tc.end, text: cellXml(xml, tc, String(x.value), where), change: i })
      const at = `table ${x.table}, row ${x.row}, cell ${x.column}`
      // every old paragraph of the cell goes (the read-back sees each one), the new lines come
      notes.push({ change: i, where: at, before: old[0]?.text ?? '', after: String(x.value).split(/\r?\n/) })
      for (const p of old.slice(1)) notes.push({ change: i, where: at, before: p.text })
      return
    }
    if (c.add_rows) {
      const x = c.add_rows
      const tbl = table(i, x.table)
      const tr = row(i, tbl, x.table, x.after_row)
      if (vmerged(tr)) refuse(`change ${i + 1}: row ${x.after_row} of table ${x.table} has cells merged with the row above or below; copy another row (after_row)`)
      const s = slice(xml, tr)
      if (TRACKED.test(s)) refuse(`change ${i + 1}: row ${x.after_row} of table ${x.table} holds a tracked change; accept or reject it in Word first`)
      const cells = cellsOf(tr)
      const trPr = kid(tr, 'w:trPr'), ex = kid(tr, 'w:tblPrEx')
      const made: string[] = []
      for (const [ri, values] of (x.rows as string[][]).entries()) {
        if (values.length > cells.length) refuse(`change ${i + 1}: new row ${ri + 1} has ${values.length} values, but row ${x.after_row} has ${cells.length} cells`)
        const tcs = cells.map((tc, ci) => {
          // a copy without the old cell's comments and bookmarks (they belong to the old row)
          const v = values[ci] ?? ''
          return cellXml(xml, tc, String(v), `change ${i + 1} (a copy of row ${x.after_row})`).replace(/<w:bookmark(Start|End)\b[^>]*\/>/g, '')
        })
        made.push(`${openTag('w:tr', tr.head)}${ex ? slice(xml, ex) : ''}${trPr ? without(xml, trPr, new Set(['w:ins', 'w:del', 'w:trPrChange'])) : ''}${tcs.join('')}</w:tr>`)
        notes.push({ change: i, where: `table ${x.table}, new row after row ${x.after_row + ri}`, after: values.flatMap((v) => String(v).split(/\r?\n/)).filter((v) => v !== '') })
      }
      splices.get(main)!.push({ from: tr.end, to: tr.end, text: made.join(''), change: i })
      // a new empty cell is an empty paragraph, which the read-back counts
      if ((x.rows as string[][]).some((v) => v.length < cells.length || v.some((t) => String(t).split(/\r?\n/).includes('')))) notes.push({ change: i, where: `table ${x.table}`, after: [''] })
      return
    }
    if (c.delete_rows) {
      const x = c.delete_rows
      const tbl = table(i, x.table)
      const rows = [...new Set(x.rows as number[])].sort((a, b) => a - b)
      if (rows.length >= rowsOf(tbl).length) refuse(`change ${i + 1}: that would delete every row of table ${x.table}; keep at least one`)
      for (const n of rows) {
        const tr = row(i, tbl, x.table, n)
        if (vmerged(tr)) refuse(`change ${i + 1}: row ${n} of table ${x.table} has cells merged with the row above or below`)
        if (COMMENTED.test(slice(xml, tr))) refuse(`change ${i + 1}: row ${n} of table ${x.table} has a comment on it; delete the comment in Word first`)
        splices.get(main)!.push({ from: tr.start, to: tr.end, text: '', change: i })
        for (const p of body.filter((q) => q.node.start >= tr.start && q.node.end <= tr.end)) notes.push({ change: i, where: `table ${x.table}, row ${n} deleted`, before: p.text })
      }
      return
    }
    refuse(`change ${i + 1} is not a change edit_office makes in a Word document (find/replace, insert_paragraph, delete_paragraph, table_cell, add_rows, delete_rows)`)
  })

  for (const [para, edits] of textEdits) {
    const pxml = xmls.get(para.part)!
    splices.get(para.part)!.push(...textSplices(pxml, para, edits, (piece, text) => wText(piece.node.head, text)))
    let after = para.text
    for (const e of [...edits].sort((a, b) => b.at - a.at)) after = after.slice(0, e.at) + e.text + after.slice(e.at + e.len)
    // one paragraph, one before and after (the read-back counts them); the other changes in it point at the first
    const w = `paragraph${label(para)}`
    edits.forEach((e, k) => notes.push(k === 0 ? { change: e.change, where: w, before: para.text, after: [after] } : { change: e.change, where: `${w}, the same paragraph as change ${edits[0]!.change + 1}` }))
  }
  for (const [part, list] of splices) if (list.length) pkg.set(part, applySplices(xmls.get(part)!, list, part))
  notes.sort((a, b) => a.change - b.change)
  return { notes }
}

/** The paragraphs of a .docx as the read-back compares them. */
export function docxParagraphTexts(pkg: Pkg): string[] {
  const main = mainPart(pkg, 'word/document.xml')
  return textParts(pkg, main).flatMap((p) => { const x = pkg.need(p); return paragraphs(x, xmlTree(x, p), p, W).map((q) => q.text) })
}

registerEditor('docx', (pkg, changes) => editDocx(pkg, changes))
registerLister('docx', docxParagraphTexts)
