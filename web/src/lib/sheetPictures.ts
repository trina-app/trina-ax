// Pictures in a spreadsheet for the sheet preview (QA TC-8833): SheetJS reads cells only, so the preview reads each
// sheet's drawing part itself (xl/drawings/drawingN.xml, found through the workbook's and the sheet's relationships)
// and draws its pictures over the cells they are anchored to, as the Word and PowerPoint previews draw theirs.
// - Anchors: two-cell (from and to a cell, the picture stretched between), one-cell (from a cell, a size) and absolute
//   (a place and a size from the sheet's top left). A picture in a group is placed inside the group's anchor by the
//   group's own coordinates.
// - Only pictures the file holds and a browser draws (PNG, JPEG, GIF, WebP, BMP): a linked picture (r:link, never
//   fetched), a hidden one, a Windows metafile or a missing part is skipped. Charts and shapes are not drawn.
// - The file is untrusted: the XML is read with caps (parts, tags, pictures, bytes) and never into the page as markup;
//   pictures are shown as blob: images (no script runs in an <img>).
// Pure and DOM-free (the unit tests run without a browser): the view (OfficeView SheetView) measures the table cells.

/** a point on the sheet: a cell (0-based column and row) and an offset into it in px (EMU / 9525) */
export interface SheetPoint { col: number; row: number; dx: number; dy: number }
export type SheetAnchor =
  | { kind: 'two'; from: SheetPoint; to: SheetPoint }
  | { kind: 'one'; from: SheetPoint; w: number; h: number }
  | { kind: 'abs'; x: number; y: number; w: number; h: number }
/** a part of an anchor's box (a picture in a group), as fractions of it */
export interface SheetPart { fx: number; fy: number; fw: number; fh: number }
export interface SheetPicture { anchor: SheetAnchor; part?: SheetPart; type: string; bytes: Uint8Array; name: string }

export const SHEET_PICTURE_LIMITS = { perSheet: 200, bytes: 20 * 1024 * 1024, total: 60 * 1024 * 1024, tags: 200_000 }
const EMU_PER_PX = 9525
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }

// ---------------------------------------------------------------- a small XML reader (tags, attributes, nesting)
export interface XEl { name: string; local: string; attrs: Record<string, string>; kids: XEl[]; text: string }
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!)
/** The element tree of an XML part (comments, declarations and CDATA skipped); null when it is not well nested or past
 * the tag cap. Attribute names keep their prefix ("r:embed"); `local` is the element name without it. */
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y
export function parseXmlTree(xml: string): XEl | null {
  const root: XEl = { name: '', local: '', attrs: {}, kids: [], text: '' }
  const stack: XEl[] = [root]
  let count = 0
  for (let i = xml.indexOf('<'); i >= 0;) {
    const top = stack[stack.length - 1]!
    if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i); if (e < 0) return null; i = xml.indexOf('<', e); continue }
    if (xml.startsWith('<![CDATA[', i)) { const e = xml.indexOf(']]>', i); if (e < 0) return null; top.text += xml.slice(i + 9, e); i = xml.indexOf('<', e); continue }
    if (xml[i + 1] === '?' || xml[i + 1] === '!') { const e = xml.indexOf('>', i); if (e < 0) return null; i = xml.indexOf('<', e); continue }
    TAG.lastIndex = i
    const m = TAG.exec(xml)
    if (!m) return null
    if (++count > SHEET_PICTURE_LIMITS.tags) return null
    const [all, close, name, attrText, self] = m as unknown as [string, string, string, string, string]
    if (close) {
      if (top.name !== name || stack.length < 2) return null
      stack.pop()
    } else {
      const attrs: Record<string, string> = {}
      for (const a of attrText.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = unescape(a[2] ?? a[3] ?? '')
      const el: XEl = { name, local: name.slice(name.indexOf(':') + 1), attrs, kids: [], text: '' }
      top.kids.push(el)
      if (!self) stack.push(el)
    }
    const next = xml.indexOf('<', i + all.length)
    if (!close && !self && next > i + all.length) stack[stack.length - 1]!.text += unescape(xml.slice(i + all.length, next))
    i = next
  }
  return stack.length === 1 ? root : null
}
const kid = (e: XEl | undefined, local: string) => e?.kids.find((k) => k.local === local)
const kids = (e: XEl | undefined, local: string) => e?.kids.filter((k) => k.local === local) ?? []
/** an attribute by its local name ("embed" finds "r:embed" whatever the prefix) */
const attr = (e: XEl | undefined, local: string) => {
  if (!e) return undefined
  for (const [k, v] of Object.entries(e.attrs)) if (k === local || k.endsWith(`:${local}`)) return v
  return undefined
}
const int = (s: string | undefined) => { const n = Number(s); return Number.isFinite(n) ? n : 0 }

// ---------------------------------------------------------------- the package
/** a zip's parts by path (SheetJS's CFB reads zips: `XLSX.CFB`) */
export type PartReader = (path: string) => Uint8Array | null
/** `target` of a relationship of `from` as a package path ("xl/worksheets/sheet1.xml" + "../drawings/drawing1.xml") */
export function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = from.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}
const relsOf = (part: string) => { const i = part.lastIndexOf('/'); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels` }
function relations(read: PartReader, part: string): Map<string, { target: string; external: boolean }> {
  const out = new Map<string, { target: string; external: boolean }>()
  const tree = xmlOf(read, relsOf(part))
  for (const r of kids(kid(tree ?? undefined, 'Relationships'), 'Relationship')) {
    const id = r.attrs.Id, target = r.attrs.Target
    if (id && target) out.set(id, { target: resolvePart(part, target), external: r.attrs.TargetMode === 'External' })
  }
  return out
}
function xmlOf(read: PartReader, path: string): XEl | null {
  const b = read(path)
  if (!b || b.length > SHEET_PICTURE_LIMITS.bytes) return null
  try { return parseXmlTree(new TextDecoder('utf-8').decode(b)) } catch { return null }
}

const point = (e: XEl | undefined): SheetPoint | null => {
  if (!e) return null
  const v = (n: string) => kid(e, n)?.text.trim()
  const col = int(v('col')), row = int(v('row'))
  if (col < 0 || row < 0 || col > 16383 || row > 1048575) return null
  return { col, row, dx: Math.max(0, int(v('colOff')) / EMU_PER_PX), dy: Math.max(0, int(v('rowOff')) / EMU_PER_PX) }
}
const extent = (e: XEl | undefined) => ({ w: Math.max(0, int(attr(e, 'cx')) / EMU_PER_PX), h: Math.max(0, int(attr(e, 'cy')) / EMU_PER_PX) })

/** a picture of a group drawn inside the group's anchor: the group's child coordinates (chOff, chExt) mapped onto
 * the anchor's box, given here as fractions of it */
interface Placed { pic: XEl; part?: SheetPart }
function picturesIn(e: XEl, frame?: { ox: number; oy: number; w: number; h: number; fx: number; fy: number; fw: number; fh: number }, depth = 0): Placed[] {
  if (depth > 8) return []
  const out: Placed[] = []
  for (const k of e.kids) {
    if (k.local === 'pic') {
      if (!frame) { out.push({ pic: k }); continue }
      const xfrm = kid(kid(k, 'spPr'), 'xfrm')
      const off = kid(xfrm, 'off'), ext = kid(xfrm, 'ext')
      if (!off || !ext || frame.w <= 0 || frame.h <= 0) continue
      out.push({ pic: k, part: {
        fx: frame.fx + ((int(attr(off, 'x')) - frame.ox) / frame.w) * frame.fw, fy: frame.fy + ((int(attr(off, 'y')) - frame.oy) / frame.h) * frame.fh,
        fw: (int(attr(ext, 'cx')) / frame.w) * frame.fw, fh: (int(attr(ext, 'cy')) / frame.h) * frame.fh,
      } })
    } else if (k.local === 'grpSp') {
      const x = kid(kid(k, 'grpSpPr'), 'xfrm')
      const chOff = kid(x, 'chOff'), chExt = kid(x, 'chExt'), off = kid(x, 'off'), ext = kid(x, 'ext')
      if (!chOff || !chExt) continue
      // the group's own box in its parent's child coordinates (the top group fills the anchor)
      const outer = frame && off && ext && frame.w > 0 && frame.h > 0
        ? { fx: frame.fx + ((int(attr(off, 'x')) - frame.ox) / frame.w) * frame.fw, fy: frame.fy + ((int(attr(off, 'y')) - frame.oy) / frame.h) * frame.fh, fw: (int(attr(ext, 'cx')) / frame.w) * frame.fw, fh: (int(attr(ext, 'cy')) / frame.h) * frame.fh }
        : { fx: 0, fy: 0, fw: 1, fh: 1 }
      out.push(...picturesIn(k, { ox: int(attr(chOff, 'x')), oy: int(attr(chOff, 'y')), w: int(attr(chExt, 'cx')), h: int(attr(chExt, 'cy')), ...outer }, depth + 1))
    }
  }
  return out
}

/**
 * The pictures of each sheet (by name, in the workbook's order), read from the file's parts. A sheet without a drawing
 * or with nothing drawable is left out. Never throws on a damaged or strange file: what cannot be read is skipped.
 */
export function readSheetPictures(read: PartReader): Map<string, SheetPicture[]> {
  const out = new Map<string, SheetPicture[]>()
  const book = 'xl/workbook.xml'
  const wb = xmlOf(read, book)
  if (!wb) return out
  const bookRels = relations(read, book)
  let total = 0
  for (const sheet of kids(kid(kid(wb, 'workbook'), 'sheets'), 'sheet')) {
    const name = sheet.attrs.name
    const rel = bookRels.get(attr(sheet, 'id') ?? '')
    if (!name || !rel || rel.external) continue
    const ws = xmlOf(read, rel.target)
    const sheetRels = relations(read, rel.target)
    const list: SheetPicture[] = []
    for (const d of kids(kid(ws ?? undefined, 'worksheet'), 'drawing')) {
      const dr = sheetRels.get(attr(d, 'id') ?? '')
      if (!dr || dr.external) continue
      const drawing = xmlOf(read, dr.target)
      const media = relations(read, dr.target)
      for (const a of kid(drawing ?? undefined, 'wsDr')?.kids ?? []) {
        let anchor: SheetAnchor | null = null
        if (a.local === 'twoCellAnchor') {
          const from = point(kid(a, 'from')), to = point(kid(a, 'to'))
          if (from && to) anchor = { kind: 'two', from, to }
        } else if (a.local === 'oneCellAnchor') {
          const from = point(kid(a, 'from'))
          if (from) anchor = { kind: 'one', from, ...extent(kid(a, 'ext')) }
        } else if (a.local === 'absoluteAnchor') {
          const pos = kid(a, 'pos')
          anchor = { kind: 'abs', x: int(attr(pos, 'x')) / EMU_PER_PX, y: int(attr(pos, 'y')) / EMU_PER_PX, ...extent(kid(a, 'ext')) }
        }
        if (!anchor) continue
        for (const { pic, part } of picturesIn(a)) {
          if (list.length >= SHEET_PICTURE_LIMITS.perSheet) break
          const nv = kid(kid(pic, 'nvPicPr'), 'cNvPr')
          if (attr(nv, 'hidden') === '1' || attr(nv, 'hidden') === 'true') continue
          const blip = kid(kid(pic, 'blipFill'), 'blip')
          const m = media.get(attr(blip, 'embed') ?? '')
          if (!m || m.external) continue
          const type = TYPES[m.target.slice(m.target.lastIndexOf('.') + 1).toLowerCase()]
          const bytes = type ? read(m.target) : null
          if (!type || !bytes || !bytes.length || bytes.length > SHEET_PICTURE_LIMITS.bytes || (total += bytes.length) > SHEET_PICTURE_LIMITS.total) continue
          list.push({ anchor, ...(part ? { part } : {}), type, bytes, name: attr(nv, 'descr') || attr(nv, 'name') || '' })
        }
      }
    }
    if (list.length) out.set(name, list)
  }
  return out
}

// ---------------------------------------------------------------- placing on the drawn table
/** The drawn grid: the left edge of each column and the top of each row (px, in the table's box), from `firstCol` and
 * `firstRow` on, and their right and bottom ends. Columns and rows past the drawn ones continue at 64 x 20 px. */
export interface SheetGrid { firstCol: number; firstRow: number; cols: number[]; rows: number[]; right: number; bottom: number }
const edge = (starts: number[], end: number, first: number, i: number, size: number) => {
  const k = i - first
  if (k < 0) return (starts[0] ?? 0) + k * size
  if (k < starts.length) return starts[k]!
  return end + (k - starts.length) * size
}
const span = (starts: number[], end: number, first: number, i: number, size: number) => edge(starts, end, first, i + 1, size) - edge(starts, end, first, i, size)
function at(p: SheetPoint, g: SheetGrid): { x: number; y: number } {
  // an offset never leaves its cell (the drawn column can be narrower than the spreadsheet's)
  return {
    x: edge(g.cols, g.right, g.firstCol, p.col, 64) + Math.min(p.dx, span(g.cols, g.right, g.firstCol, p.col, 64)),
    y: edge(g.rows, g.bottom, g.firstRow, p.row, 20) + Math.min(p.dy, span(g.rows, g.bottom, g.firstRow, p.row, 20)),
  }
}
/** Where a picture is drawn over the table (px in the table's box): its anchor's box, or the part of it a picture in
 * a group takes. */
export function placePicture(p: Pick<SheetPicture, 'anchor' | 'part'>, g: SheetGrid): { x: number; y: number; w: number; h: number } {
  const a = p.anchor
  let box: { x: number; y: number; w: number; h: number }
  if (a.kind === 'two') {
    const p = at(a.from, g), q = at(a.to, g)
    box = { x: p.x, y: p.y, w: Math.max(1, q.x - p.x), h: Math.max(1, q.y - p.y) }
  } else if (a.kind === 'one') {
    const p = at(a.from, g)
    box = { x: p.x, y: p.y, w: a.w, h: a.h }
  } else {
    const o = { x: edge(g.cols, g.right, g.firstCol, 0, 64), y: edge(g.rows, g.bottom, g.firstRow, 0, 20) }
    box = { x: o.x + a.x, y: o.y + a.y, w: a.w, h: a.h }
  }
  const f = p.part
  return f ? { x: box.x + f.fx * box.w, y: box.y + f.fy * box.h, w: f.fw * box.w, h: f.fh * box.h } : box
}

/** The cells the pictures are anchored in (0-based, inclusive), so the drawn table covers them, or null when none is
 * anchored to a cell. */
export function picturesReach(list: SheetPicture[]): { first: { col: number; row: number }; last: { col: number; row: number } } | null {
  const cells = list.flatMap((p) => p.anchor.kind === 'two' ? [p.anchor.from, p.anchor.to] : p.anchor.kind === 'one' ? [p.anchor.from] : [])
  if (!cells.length) return null
  return {
    first: { col: Math.min(...cells.map((c) => c.col)), row: Math.min(...cells.map((c) => c.row)) },
    last: { col: Math.max(...cells.map((c) => c.col)), row: Math.max(...cells.map((c) => c.row)) },
  }
}

/** A drawn cell of the table (sheet_to_html: id "sjs-B3", colspan and rowspan) with its box in the table's box. */
export interface DrawnCell { col: number; row: number; colSpan: number; rowSpan: number; x: number; y: number; w: number; h: number }
/** The grid from the drawn cells: each column's left edge where a cell starts there or one ends before it, each row's
 * top likewise; a column or row no cell starts in gets a share of the room between its neighbours. */
export function gridFromCells(cells: DrawnCell[], firstCol: number, firstRow: number, lastCol: number, lastRow: number): SheetGrid {
  const line = (first: number, last: number, starts: [number, number][]) => {
    const out: (number | undefined)[] = Array.from({ length: Math.max(0, last - first + 2) }, () => undefined)
    for (const [i, v] of starts) { const k = i - first; if (k >= 0 && k < out.length && out[k] === undefined) out[k] = v }
    // fill the gaps evenly between known edges (the end of the line too)
    let prev = -1
    for (let k = 0; k < out.length; k++) {
      if (out[k] === undefined) continue
      if (prev < 0 && k > 0) for (let j = 0; j < k; j++) out[j] = out[k]! - (k - j) * 20
      else for (let j = prev + 1; j < k; j++) out[j] = out[prev]! + ((out[k]! - out[prev]!) * (j - prev)) / (k - prev)
      prev = k
    }
    for (let j = prev + 1; j < out.length; j++) out[j] = prev < 0 ? j * 20 : out[prev]! + (j - prev) * 20
    return out as number[]
  }
  const cols = line(firstCol, lastCol, cells.flatMap((c) => [[c.col, c.x], [c.col + c.colSpan, c.x + c.w]] as [number, number][]))
  const rows = line(firstRow, lastRow, cells.flatMap((c) => [[c.row, c.y], [c.row + c.rowSpan, c.y + c.h]] as [number, number][]))
  return { firstCol, firstRow, cols: cols.slice(0, -1), rows: rows.slice(0, -1), right: cols[cols.length - 1]!, bottom: rows[rows.length - 1]! }
}
