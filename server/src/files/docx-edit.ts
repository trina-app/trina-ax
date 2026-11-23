// edit_office for a .docx (office-edit.ts holds what the three editors share). Changes, all found in the document as the
// AI read it, never in each other's results:
// - { find, replace }: exact text inside one paragraph (body, headers, footers, footnotes); the new text takes the
//   formatting of the first run it touches; `occurrence` or `all` when it is in several places.
// - { insert_paragraph: { after | before, text } }: new paragraphs next to the one holding the text, with its paragraph
//   properties (style, numbering, spacing) and its first run's formatting; one paragraph per line.
// - { delete_paragraph: { text } }
// - { table_cell: { table, row, column, value } }, { add_rows: { table, after_row, rows } }, { delete_rows: { table, rows } }
//   (1-based; tables in reading order, a table inside a table not counted).
// - { insert_picture: { image, after | over | next_to, width_mm?, height_mm?, behind_text? } } (plan
//   docs/AGENTS/plan/20261123-0840-docx-insert-picture.md): a new picture (a signature, a seal) right after a label's
//   text, floating behind the text centred on it ("(인)"), or in the table cell right of the cell holding it. The
//   paragraph's text does not change: a run's w:t is split where the picture goes. A new word/media part, one image
//   relationship, a content type Default when the extension has none, a fresh wp:docPr id.
// Kept: comments, tracked changes, headers, footers, pictures, fields, content controls and every other part. A change
// that would cut through a tracked change, a field, a comment's range or vertically merged cells is refused with the
// reason. Only the byte ranges of the edited elements change in word/document.xml (and the header / footer / notes part
// a find/replace hit); every other part keeps its compressed bytes.
import {
  find, findAll, kid, kidsNamed, matchesOf, paragraphs, pick, refuse, registerEditor, registerLister, slice, textSplices, W, without,
  addRel, ancestor, applySplices, attrOf, docPrIds, ensureContentType, escText, mainPart, type EditNote, type Para, type Piece, type Pkg, type Splice,
  type XNode, xmlTree,
} from './office-edit'
import { imageInfo } from './pptx-edit'
import { pickSignMark, placedOn } from './sign-slots'

export type DocxChange =
  | { find: string; replace: string; occurrence?: number; all?: boolean }
  | { insert_paragraph: { after?: string; before?: string; text: string; occurrence?: number } }
  | { delete_paragraph: { text: string; occurrence?: number } }
  | { table_cell: { table: number; row: number; column: number; value: string } }
  | { add_rows: { table: number; after_row: number; rows: string[][] } }
  | { delete_rows: { table: number; rows: number[] } }
  | { insert_picture: InsertPicture }

/** A new picture (a signature, a seal) put at a label: `image` is the index of the call's re-encoded PNG / JPEG. */
export interface InsertPicture {
  image: number
  after?: string; over?: string; next_to?: string
  occurrence?: number
  width_mm?: number; height_mm?: number
  behind_text?: boolean
}

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

// ---------------------------------------------------------------- insert_picture

const NS = {
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
} as const
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image'
/** EMU per millimetre and per point */
export const EMU_MM = 36_000
const EMU_PT = 12_700
/** a picture's side without a size given, and the sizes one may give */
export const PICTURE_DEFAULT_MM = 20
export const PICTURE_MM = { min: 1, max: 300 } as const

/** The picture's size in EMU: width and/or height in mm keeping its shape (both: fitted inside that box); neither:
 * PICTURE_DEFAULT_MM wide and at most that high. */
export function pictureSize(w: number, h: number, o: { width_mm?: number; height_mm?: number }, where: string): { cx: number; cy: number } {
  for (const v of [o.width_mm, o.height_mm]) if (v !== undefined && !(Number.isFinite(v) && v >= PICTURE_MM.min && v <= PICTURE_MM.max)) refuse(`${where}: give width_mm and height_mm from ${PICTURE_MM.min} to ${PICTURE_MM.max}`)
  let W: number, H: number
  if (o.width_mm !== undefined && o.height_mm !== undefined) { const k = Math.min(o.width_mm / w, o.height_mm / h); W = w * k; H = h * k }
  else if (o.width_mm !== undefined) { W = o.width_mm; H = (W * h) / w }
  else if (o.height_mm !== undefined) { H = o.height_mm; W = (H * w) / h }
  else { W = PICTURE_DEFAULT_MM; H = (W * h) / w; if (H > PICTURE_DEFAULT_MM) { H = PICTURE_DEFAULT_MM; W = (H * w) / h } }
  if (W > PICTURE_MM.max * 2 || H > PICTURE_MM.max * 2) refuse(`${where}: with its shape the picture would be ${Math.round(W)} x ${Math.round(H)} mm; give a smaller size`)
  return { cx: Math.max(1, Math.round(W * EMU_MM)), cy: Math.max(1, Math.round(H * EMU_MM)) }
}

/** The run's font size in points (w:sz is in half points), or `fallback` (the document's default) */
function runPt(run: XNode | null, fallback: number): number {
  const rPr = run ? kid(run, 'w:rPr') : null
  const sz = rPr ? kid(rPr, 'w:sz') : null
  const v = sz ? Number(attrOf(sz.head, 'w:val')) : NaN
  return Number.isFinite(v) && v >= 2 && v <= 3276 ? v / 2 : fallback
}
/** an estimate of the text's width in EMU at `pt` (no layout engine here): wide (Hangul, CJK, full-width) characters 1 em, brackets and spaces about a third, others about half */
export function textWidthEmu(text: string, pt: number): number {
  let em = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    em += (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 1 : c === 0x28 || c === 0x29 ? 0.35 : c === 0x20 ? 0.3 : 0.55
  }
  return Math.round(em * pt * EMU_PT)
}

/** prefix declarations a new drawing needs: none for a prefix the document's root binds to the same namespace */
function nsDecls(rootHead: string, where: string): Record<keyof typeof NS, string> {
  const out = {} as Record<keyof typeof NS, string>
  for (const [p, uri] of Object.entries(NS) as [keyof typeof NS, string][]) {
    const bound = attrOf(rootHead, `xmlns:${p}`)
    if (bound !== undefined && bound !== uri) refuse(`${where}: this document uses the name ${p} for something else, so a picture cannot be added here`)
    out[p] = bound === uri ? '' : ` xmlns:${p}="${uri}"`
  }
  return out
}

interface Drawing { rid: string; id: number; cx: number; cy: number; ns: Record<keyof typeof NS, string>; float?: { dx: number; dy: number } }
/** a w:drawing with one picture: inline in the line, or floating behind the text (wrapNone, behindDoc) at an offset
 * from the character where it is anchored and from the top of its line */
function drawingXml(d: Drawing): string {
  const graphic = `<wp:extent cx="${d.cx}" cy="${d.cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    (d.float ? '<wp:wrapNone/>' : '') +
    `<wp:docPr id="${d.id}" name="Picture ${d.id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks${d.ns.a} noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic${d.ns.a}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic${d.ns.pic}><pic:nvPicPr><pic:cNvPr id="${d.id}" name="Picture ${d.id}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr>` +
    `<pic:blipFill><a:blip${d.ns.r} r:embed="${d.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="${d.cx}" cy="${d.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic>'
  if (!d.float) return `<w:drawing><wp:inline${d.ns.wp} distT="0" distB="0" distL="0" distR="0">${graphic}</wp:inline></w:drawing>`
  return `<w:drawing><wp:anchor${d.ns.wp} distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${251_658_240 + (d.id % 1_000_000)}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="character"><wp:posOffset>${d.float.dx}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="line"><wp:posOffset>${d.float.dy}</wp:posOffset></wp:positionV>` +
    `${graphic}</wp:anchor></w:drawing>`
}

/** Where a picture goes in a paragraph's text: the piece holding that position, and the splice that puts `drawing` there
 * (before the text at `pos`, or after it when `end`): a zero-width insertion at the piece's edge, or its w:t split. */
function splitAt(para: Para, pos: number, end: boolean, drawing: string, where: string, change: number): Splice {
  const ch = end ? pos - 1 : pos
  const piece = para.pieces.find((p) => p.at <= ch && ch < p.at + p.text.length)
  if (!piece) return refuse(`${where}: that place cannot hold a picture`)
  if (!piece.editable || !piece.run) refuse(`${where}: the text is ${piece.why ?? 'outside a run'}, where a picture cannot go; give text next to it`)
  if (piece.tracked) refuse(`${where}: the text is inside a tracked change (a suggested edit); accept or reject it in Word first`)
  const at = pos - piece.at
  if (at <= 0) return { from: piece.node.start, to: piece.node.start, text: drawing, change }
  if (at >= piece.text.length) return { from: piece.node.end, to: piece.node.end, text: drawing, change }
  return { from: piece.node.start, to: piece.node.end, text: wText(piece.node.head, piece.text.slice(0, at)) + drawing + wText(piece.node.head, piece.text.slice(at)), change }
}

/** the w:t piece a position is in (for its run's font size) */
const pieceAt = (para: Para, pos: number): Piece | undefined => para.pieces.find((p) => p.at <= pos && pos < p.at + p.text.length)

function vmerged(tr: XNode): boolean { return cellsOf(tr).some((tc) => { const p = kid(tc, 'w:tcPr'); return !!(p && kid(p, 'w:vMerge')) }) }

export function editDocx(pkg: Pkg, changes: unknown[], images: Uint8Array[] = []): { notes: EditNote[] } {
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
  // insert_picture: one media part and relationship per picture of the call (a picture named by several changes is
  // stored once), ids above every wp:docPr id of the document
  const dir = main.slice(0, main.lastIndexOf('/') + 1)
  let nextId = 0
  let freeIds: Set<number> | null = null
  /** where each picture goes in a paragraph's text, checked against text edits of the same call at the end */
  const picAt: { change: number; para?: Para; from?: number; to?: number; at?: number; drawing?: string; splice?: Splice }[] = []
  const media = new Map<number, { rid: string; w: number; h: number }>()
  const rootHead = (() => { const r = tree.kids.find((k) => !k.name.startsWith('?')); return r ? r.head : '' })()
  const defaultPt = (() => {
    const st = pkg.has(`${dir}styles.xml`) ? pkg.text(`${dir}styles.xml`) : null
    const m = st ? /<w:docDefaults\b[\s\S]*?<\/w:docDefaults>/.exec(st) : null
    const sz = m ? /<w:sz\s+w:val="(\d+)"/.exec(m[0]) : null
    return sz ? Number(sz[1]) / 2 : 11
  })()
  const picture = (i: number, x: InsertPicture): Drawing & { size: string } => {
    const where = `change ${i + 1}`
    let m = media.get(Number(x.image))
    if (!m) {
      const img = images[Number(x.image)] ?? refuse(`${where}: the picture could not be read`)
      const info = imageInfo(img)
      if (!info || info.ext === 'gif') return refuse(`${where}: the picture is not a PNG or JPEG`)
      if (!info.w || !info.h) refuse(`${where}: the picture has no size`)
      const part = pkg.free(`${dir}media/image`, `.${info.ext}`, 1)
      pkg.add(part, img)
      ensureContentType(pkg, { ext: info.ext, type: info.type })
      const pointed = [...xml.matchAll(/\s[A-Za-z_][\w.-]*:(?:embed|link|id)\s*=\s*["']([^"']*)["']/g)].map((q) => q[1]!)
      m = { rid: addRel(pkg, main, IMAGE_REL, `media/${part.slice(dir.length + 'media/'.length)}`, pointed), w: info.w, h: info.h }
      media.set(Number(x.image), m)
    }
    if (!nextId) {
      const used = docPrIds(pkg, dir)
      nextId = Math.max(0, ...used) + 1
      // docPr ids are 32-bit: past a safe bound, the lowest free ids
      if (nextId > 2_000_000_000) { const taken = new Set(used); nextId = 1; while (taken.has(nextId)) nextId++; freeIds = taken }
    }
    const id = nextId++
    if (freeIds) { freeIds.add(id); while (freeIds.has(nextId)) nextId++ }
    const { cx, cy } = pictureSize(m.w, m.h, x, where)
    const size = `${(cx / EMU_MM).toFixed(1).replace(/\.0$/, '')} x ${(cy / EMU_MM).toFixed(1).replace(/\.0$/, '')} mm`
    picAt.push({ change: i })
    return { rid: m.rid, id, cx, cy, ns: nsDecls(rootHead, where), size }
  }
  /** a floating picture's offset from the top of its line: centred on the line's text */
  const lineDy = (pt: number, cy: number, para?: Para) => {
    const L = linePt(para, pt)
    // in a line taller than its text the text sits low (the baseline at about 80% of the line, measured in LibreOffice)
    const middle = L > pt * 1.2 ? L * 0.8 - pt * 0.3 : L / 2
    return Math.round(middle * EMU_PT - cy / 2)
  }
  const stylesXml = (pkg.has(`${dir}styles.xml`) ? pkg.text(`${dir}styles.xml`) : null) ?? ''
  const spacingOf = (x: string): { line: number; rule: string } | null => {
    const m = /<w:spacing\b[^>]*>/.exec(/<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(x)?.[0] ?? '')
    const line = m ? Number(attrOf(m[0].replace(/\/?>$/, ''), 'w:line')) : NaN
    return m && Number.isFinite(line) && line > 0 ? { line, rule: attrOf(m[0].replace(/\/?>$/, ''), 'w:lineRule') ?? 'auto' } : null
  }
  /** the line's height in points: the paragraph's own spacing, else its style's (and what that is based on), else the
   * document's default; a line of single spacing is 1.2 times the text */
  const linePt = (para: Para | undefined, pt: number): number => {
    let sp: { line: number; rule: string } | null = null
    if (para) {
      const pPr = kid(para.node, 'w:pPr')
      const own = pPr ? slice(xml, pPr) : ''
      sp = spacingOf(own)
      let id = own ? /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(own)?.[1] : undefined
      for (let n = 0; !sp && id && n < 8; n++) {
        const key: string = id
        const st = [...stylesXml.matchAll(/<w:style\b[^>]*>[\s\S]*?<\/w:style>/g)].map((m) => m[0]).find((x) => attrOf(/<w:style\b[^>]*/.exec(x)![0], 'w:styleId') === key)
        if (!st) break
        sp = spacingOf(st)
        id = /<w:basedOn\b[^>]*w:val="([^"]+)"/.exec(st)?.[1]
      }
    }
    sp ??= spacingOf(/<w:docDefaults\b[\s\S]*?<\/w:docDefaults>/.exec(stylesXml)?.[0] ?? '')
    if (!sp) return pt * 1.2
    if (sp.rule === 'exact') return sp.line / 20
    if (sp.rule === 'atLeast') return Math.max(sp.line / 20, pt * 1.2)
    return pt * 1.2 * (sp.line / 240)
  }

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
    if (c.insert_picture) {
      const x = c.insert_picture as InsertPicture
      const where = `change ${i + 1}`
      const at = [x.after, x.over, x.next_to].filter((v) => v !== undefined)
      if (at.length !== 1 || typeof at[0] !== 'string' || !at[0]) refuse(`${where}: give one of after, over or next_to (exact text of one paragraph: the label the picture goes at)`)
      const label = at[0] as string
      const q = JSON.stringify(label.length > 60 ? label.slice(0, 60) + '…' : label)
      const hits = matchesOf(body.filter((p) => !p.box), label)
      // one picture per change: "all" is not offered here
      // over: a label that holds a sign mark means that mark (files/sign-slots.ts); several marks are never guessed
      const signed = x.over !== undefined && hits.length ? pickSignMark(label, x.occurrence, hits.length) : null
      if (signed && 'ask' in signed) return refuse(`${where}: ${signed.ask}`)
      const at1 = signed ? { ...x, occurrence: signed.occurrence } : x
      if (hits.length > 1 && at1.occurrence === undefined) refuse(`${where}: ${q} is in ${hits.length} places of the body; give occurrence (1 to ${hits.length}) or longer text`)
      const hit = pick(hits, at1, i, ' of the body (pictures go into the body, not headers, footers or text boxes)', label)[0]!
      if (x.over !== undefined) {
        // behind the text, centred on the mark (or the label without one): anchored at its first character
        const mark = signed?.mark ?? null
        const aimAt = hit.at + (mark?.aimFrom ?? 0)
        const aim = mark ? label.slice(mark.aimFrom, mark.aimTo) : label
        const atPiece = pieceAt(hit.para, aimAt)
        if (atPiece?.run && kid(atPiece.run, 'w:rPr') && kid(kid(atPiece.run, 'w:rPr')!, 'w:vanish')) refuse(`${where}: that mark is hidden text, which nobody sees on the page; give a mark that shows`)
        const d = picture(i, x)
        const pt = runPt(atPiece?.run ?? null, defaultPt)
        d.float = { dx: Math.round(textWidthEmu(aim, pt) / 2 - d.cx / 2), dy: lineDy(pt, d.cy, hit.para) }
        const drawing = drawingXml(d)
        const splice = splitAt(hit.para, aimAt, false, drawing, where, i)
        Object.assign(picAt[picAt.length - 1]!, { para: hit.para, from: hit.at + (mark?.from ?? 0), to: hit.at + (mark?.to ?? label.length), at: aimAt, drawing, splice })
        splices.get(main)!.push(splice)
        notes.push({ change: i, where: `picture over ${placedOn(label, mark)}, behind the text (${d.size}), tied to that text; its place on the page was not rendered` })
        return
      }
      if (x.after !== undefined) {
        const d = picture(i, x)
        if (x.behind_text) d.float = { dx: 0, dy: lineDy(runPt(pieceAt(hit.para, hit.at + label.length - 1)?.run ?? null, defaultPt), d.cy) }
        Object.assign(picAt[picAt.length - 1]!, { para: hit.para, from: hit.at + label.length, to: hit.at + label.length })
        splices.get(main)!.push(splitAt(hit.para, hit.at + label.length, true, drawingXml(d), where, i))
        notes.push({ change: i, where: `picture after ${q}${x.behind_text ? ', behind the text' : ''} (${d.size})` })
        return
      }
      // next_to: the first paragraph of the table cell right of the label's cell
      const tc = ancestor(hit.para.node, 'w:tc') ?? refuse(`${where}: ${q} is not in a table cell; use after or over for text outside a table`)
      const tr = tc.parent
      if (!tr || tr.name !== 'w:tr') return refuse(`${where}: the cell holding ${q} is inside a content control; use after or over`)
      const cells = cellsOf(tr)
      const next = cells[cells.indexOf(tc) + 1] ?? refuse(`${where}: there is no cell to the right of the one holding ${q}; use after or over`)
      const tcPr = kid(next, 'w:tcPr')
      const vm = tcPr ? kid(tcPr, 'w:vMerge') : null
      if (vm && attrOf(vm.head, 'w:val') !== 'restart') refuse(`${where}: the cell right of ${q} is merged with the cell above it; use after or over`)
      if (kid(next, 'w:sdt') || find(next, 'w:tbl')) refuse(`${where}: the cell right of ${q} holds a table or a content control; use after or over`)
      const p = kid(next, 'w:p') ?? refuse(`${where}: the cell right of ${q} has no paragraph`)
      const ps = slice(xml, p)
      if (TRACKED.test(ps)) refuse(`${where}: the cell right of ${q} holds a tracked change; accept or reject it in Word first`)
      const d = picture(i, x)
      // an inline picture wider than the cell's set width would be cut off: made smaller to fit, keeping its shape
      const tcW = tcPr ? kid(tcPr, 'w:tcW') : null
      const room = tcW && (attrOf(tcW.head, 'w:type') ?? 'dxa') === 'dxa' ? (Number(attrOf(tcW.head, 'w:w')) - 2 * 115) * 635 : NaN
      if (!x.behind_text && Number.isFinite(room) && room > EMU_MM && d.cx > room) {
        d.cy = Math.max(1, Math.round((d.cy * room) / d.cx)); d.cx = Math.round(room)
        d.size = `${(d.cx / EMU_MM).toFixed(1).replace(/\.0$/, '')} x ${(d.cy / EMU_MM).toFixed(1).replace(/\.0$/, '')} mm, made smaller to fit the cell`
      }
      if (x.behind_text) d.float = { dx: 0, dy: lineDy(defaultPt, d.cy) }
      const run = `<w:r>${drawingXml(d)}</w:r>`
      splices.get(main)!.push(p.self
        ? { from: p.start, to: p.end, text: `<w:p${p.head.replace(/\s*\/$/, '')}>${run}</w:p>`, change: i }
        : { from: p.closeStart, to: p.closeStart, text: run, change: i })
      notes.push({ change: i, where: `picture in the cell right of ${q}${x.behind_text ? ', behind the text' : ''} (${d.size})` })
      return
    }
    refuse(`change ${i + 1} is not a change edit_office makes in a Word document (find/replace, insert_paragraph, delete_paragraph, table_cell, add_rows, delete_rows, insert_picture)`)
  })

  // a picture at text that a find/replace of the same call changes would land next to text that is gone
  for (const p of picAt) {
    if (!p.para) continue
    // the whole label of `over` (it is centred on it), the point of `after`; touching edges count
    const e = (textEdits.get(p.para) ?? []).find((x) => x.at <= p.to! && p.from! <= x.at + x.len)
    if (e) refuse(`changes ${Math.min(e.change, p.change) + 1} and ${Math.max(e.change, p.change) + 1} touch the same text; put the picture in a separate call`)
  }
  // a seal inside a run whose text a fill of the same call also changes ("Name: ____ (seal)" in one w:t): the two rewrite
  // the same element, so the picture goes in with the new text, at a stand-in character that marks its place
  const standIn = new Map<Para, { at: number; len: number; text: string; change: number }[]>()
  const drawn = new Map<string, string>()
  for (const p of picAt) {
    if (!p.para || !p.splice || p.splice.to === p.splice.from || !textEdits.has(p.para)) continue
    const piece = pieceAt(p.para, p.at!)!
    if (!textEdits.get(p.para)!.some((e) => e.at < piece.at + piece.text.length && e.at + e.len > piece.at)) continue
    if (/[\u{F0000}-\u{F00FF}]/u.test(p.para.text)) continue
    const mark = String.fromCodePoint(0xf0000 + drawn.size)
    drawn.set(mark, p.drawing!)
    const list = splices.get(main)!
    list.splice(list.indexOf(p.splice), 1)
    standIn.set(p.para, [...(standIn.get(p.para) ?? []), { at: p.at!, len: 0, text: mark, change: p.change }])
  }
  const withDrawings = (head: string, text: string) => text.split(/([\u{F0000}-\u{F00FF}])/u).map((t) => drawn.get(t) ?? (t ? wText(head, t) : '')).join('')
  for (const [para, edits] of textEdits) {
    const pxml = xmls.get(para.part)!
    splices.get(para.part)!.push(...textSplices(pxml, para, [...edits, ...(standIn.get(para) ?? [])], (piece, text) => withDrawings(piece.node.head, text)))
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

registerEditor('docx', (pkg, changes, images) => editDocx(pkg, changes, images))
registerLister('docx', docxParagraphTexts)
