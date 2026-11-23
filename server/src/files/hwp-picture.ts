// edit_hwp's image change (a signature, a seal, a logo put into a Hangul document), the parts both formats share:
// - the image: PNG or JPEG only (by its bytes), at most PICTURE_LIMITS, and written into the document as a clean copy
//   (sanitizeImage): a PNG keeps only the chunks that draw it, a JPEG only the segments that decode it, nothing after
//   the end marker (no text, EXIF or GPS, no data of another kind behind the picture);
// - the page layout: where the renderer (hwp-engine.ts layout(), rhwp's render tree, run isolated like a preview)
//   draws each line of text and each table cell, page by page (parseRenderTree: the renderer's output is data, read
//   with caps, numbers checked);
// - where the picture goes: the label the change names, found in the document model (hwp-changes.ts) and paired with
//   the same occurrence in the layout; the picture floats over the page at the label's place on the paper (anchored in
//   the label's paragraph, so on its page), behind or in front of the text, so the text around it does not move. For a
//   document Hangul saved, the renderer takes the vertical layout from Hangul's own layout cache.
// Runs in the office worker (the editors) and the server (the limits, the engine's parse); nothing here writes a file.
import { ToolError } from '../policy/errors'
import { imageKind, imageSize, STAMP_IMAGE_MAX, STAMP_IMAGE_SIDE_MAX } from './pdf-stamp'

export const PICTURE_LIMITS = {
  /** image changes in one call */
  images: 10,
  /** one file as read; every picture of a call once, as read and as the image helper wrote it (the worker's limit) */
  imageBytes: STAMP_IMAGE_MAX,
  totalBytes: 20 * 1024 * 1024,
  /** the longest side in pixels */
  side: STAMP_IMAGE_SIDE_MAX,
}

/** HWPUNIT (1/7200 inch) per millimetre, per renderer pixel (96 dpi) */
export const HU_PER_MM = 7200 / 25.4
export const HU_PER_PX = 75
const MM_PER_PX = 25.4 / 96
const round1 = (n: number) => Math.round(n * 10) / 10

export type ImageKind = 'png' | 'jpg'
export interface CleanImage { kind: ImageKind; bytes: Uint8Array; width: number; height: number }

// ---------------------------------------------------------------- the image
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD'])
/** JPEG markers that carry no picture data and are left out: APP1-APP13, APP15 (EXIF, XMP, ...), COM */
const jpegDrop = (m: number) => (m >= 0xe1 && m <= 0xed) || m === 0xef || m === 0xfe

/**
 * The image as it goes into a document: PNG or JPEG by its first bytes, its size from its header (each side 1 to
 * PICTURE_LIMITS.side pixels), and only what draws it: a PNG's critical and colour chunks up to IEND (each chunk's
 * CRC checked), a JPEG's segments up to the end of its scan with APP0 (JFIF) and APP14 (Adobe colour) kept. ToolError
 * when it is not one of those or is damaged.
 */
export function sanitizeImage(b: Uint8Array, name: string): CleanImage {
  const kind = imageKind(b)
  if (!kind) throw new ToolError(`'${name}' is not a PNG or JPG picture; use a .png or .jpg file (a PNG keeps a transparent background)`)
  const size = imageSize(b, kind)
  if (!size || size.width < 1 || size.height < 1) throw new ToolError(`'${name}' is a damaged ${kind === 'png' ? 'PNG' : 'JPG'} picture`)
  if (size.width > PICTURE_LIMITS.side || size.height > PICTURE_LIMITS.side) throw new ToolError(`'${name}' is ${size.width} x ${size.height} pixels; use a picture at most ${PICTURE_LIMITS.side} pixels on each side (resize_images makes a smaller copy)`)
  const damaged = (): never => { throw new ToolError(`'${name}' is a damaged ${kind === 'png' ? 'PNG' : 'JPG'} picture`) }
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const parts: Uint8Array[] = []
  if (kind === 'png') {
    parts.push(b.subarray(0, 8))
    let end = false, data = false
    for (let p = 8; !end;) {
      if (p + 12 > b.length) damaged()
      const len = v.getUint32(p)
      const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!)
      if (len > b.length - p - 12) damaged()
      const chunk = b.subarray(p, p + 12 + len)
      if (crc32(b.subarray(p + 4, p + 8 + len)) !== v.getUint32(p + 8 + len)) damaged()
      if (p === 8 && type !== 'IHDR') damaged()
      if (type === 'IDAT') data = true
      if (PNG_KEEP.has(type)) parts.push(chunk)
      else if (!/^[a-z]/.test(type)) damaged() // an unknown critical chunk: no decoder could draw it
      end = type === 'IEND'
      p += 12 + len
    }
    if (!data) damaged()
  } else {
    parts.push(b.subarray(0, 2))
    let p = 2, sof = false
    for (;;) {
      if (p + 4 > b.length || b[p] !== 0xff) damaged()
      const m = b[p + 1]!
      if (m === 0xff) { p++; continue }
      const len = v.getUint16(p + 2)
      if (len < 2 || p + 2 + len > b.length) damaged()
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) sof = true
      if (!jpegDrop(m)) parts.push(b.subarray(p, p + 2 + len))
      p += 2 + len
      if (m !== 0xda) continue
      // the scan: entropy-coded data up to the next marker that is not a stuffed byte or a restart, then EOI
      if (!sof) damaged()
      let q = p
      for (;;) {
        if (q + 1 >= b.length) damaged()
        if (b[q] === 0xff && b[q + 1] !== 0 && !(b[q + 1]! >= 0xd0 && b[q + 1]! <= 0xd7) && b[q + 1] !== 0xff) break
        q++
      }
      parts.push(b.subarray(p, q))
      p = q
      if (b[p + 1] === 0xd9) { parts.push(b.subarray(p, p + 2)); break }
    }
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of parts) { out.set(x, o); o += x.length }
  return { kind, bytes: out, width: size.width, height: size.height }
}

let CRC: Uint32Array | null = null
export function crc32(b: Uint8Array): number {
  if (!CRC) {
    CRC = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0 }
  }
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------- the page layout
/** A run of text as drawn: its left edge and width (px at 96 dpi) and its characters. */
export interface LRun { x: number; w: number; text: string }
/** A line of text as drawn: its box, its runs, the paragraph it belongs to on this page (`para`: lines of one
 * paragraph share it) and the table cell it is in (an index into the page's cells, or -1). */
export interface LLine { x: number; y: number; w: number; h: number; text: string; runs: LRun[]; para: string; cell: number }
export interface LCell { table: number; row: number; col: number; x: number; y: number; w: number; h: number }
/** a paragraph of the body that starts on a page (index among its section's body paragraphs), with the start of its
 * text as the renderer shows it, or that holds a table starting there */
export interface LStart { para: number; table: boolean; preview: string }
/** a table as drawn (its id is LCell.table) */
export interface LTable { x: number; y: number; w: number; h: number }
export interface LPage { w: number; h: number; lines: LLine[]; cells: LCell[]; tables: LTable[]; section: number; starts: LStart[]; continued: number[]; /** pictures the renderer drew */ images?: { x: number; y: number; w: number; h: number }[] }
export interface HwpLayout { pages: LPage[] }

export const LAYOUT_LIMITS = { pages: 200, lines: 20_000, runs: 100_000, cells: 20_000, chars: 400_000, depth: 64, nodes: 400_000 }
const LAYOUT_BAD = 'the page layout could not be read'

/**
 * One page of rhwp's render tree (export-render-tree) as lines and cells: the body only (no page header or footer,
 * which the document model does not read as body text), tables and their cells with their boxes, every text line in
 * reading order. The tree is the renderer's output, so every field is checked: known shapes only, finite numbers in a
 * sane range, caps on nodes, depth, lines and characters. Throws when it is not such a tree.
 */
export function parseRenderTree(tree: unknown): LPage {
  const bad = (): never => { throw new ToolError(LAYOUT_BAD) }
  const L = LAYOUT_LIMITS
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e6 ? v : bad())
  const box = (n: Record<string, unknown>) => {
    const b = n.bbox as Record<string, unknown> | undefined
    if (!b || typeof b !== 'object') return bad()
    const r = { x: num(b.x), y: num(b.y), w: num(b.w), h: num(b.h) }
    if (r.w < 0 || r.h < 0) bad()
    return r
  }
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad())
  const root = obj(tree)
  if (root.type !== 'Page') bad()
  const pb = box(root)
  const page: LPage = { w: pb.w, h: pb.h, lines: [], cells: [], tables: [], section: 0, starts: [], continued: [] }
  let nodes = 0, chars = 0, runs = 0, tables = 0, containers = 0
  const walk = (v: unknown, depth: number, cell: number, container: number, table: number) => {
    if (++nodes > L.nodes || depth > L.depth) bad()
    const n = obj(v)
    const type = typeof n.type === 'string' ? n.type : bad()
    const kids = n.children === undefined ? [] : Array.isArray(n.children) ? n.children : bad()
    if (type === 'Header' || type === 'Footer' || type === 'PageBg') return
    if (type === 'TextLine') {
      const b = box(n)
      const line: LLine = { ...b, text: '', runs: [], para: `${container}:${Number.isInteger(n.pi) ? n.pi : -1}`, cell }
      for (const k of kids) {
        const r = obj(k)
        if (r.type !== 'TextRun') continue
        const rb = box(r)
        const text = typeof r.text === 'string' ? r.text : bad()
        chars += text.length
        if (++runs > L.runs || chars > L.chars) bad()
        line.runs.push({ x: rb.x, w: rb.w, text })
        line.text += text
      }
      if (page.lines.push(line) > L.lines) bad()
      return
    }
    if (type === 'Image') (page.images ??= []).push(box(n))
    let inCell = cell, inContainer = container, inTable = table
    if (type === 'Table') { inTable = ++tables; inContainer = ++containers; if (page.tables.push(box(n)) > L.cells) bad() }
    if (type === 'Cell') {
      const b = box(n)
      const row = Number.isInteger(n.row) ? n.row as number : bad(), col = Number.isInteger(n.col) ? n.col as number : bad()
      if (table < 1) bad()
      if (page.cells.push({ table, row, col, ...b }) > L.cells) bad()
      inCell = page.cells.length - 1
      inContainer = ++containers
    }
    if (type === 'Column') inContainer = ++containers
    for (const k of kids) walk(k, depth + 1, inCell, inContainer, inTable)
  }
  for (const k of Array.isArray(root.children) ? root.children : []) walk(k, 1, -1, 0, 0)
  return page
}

/**
 * rhwp's pagination (dump-pages --json): for each page its section and the body paragraphs that start on it (a whole
 * paragraph, a table that is not continued from the page before, or the first part of a split paragraph) and those
 * continued from the page before. Checked
 * like the render tree: the renderer's output is data.
 */
export function parsePagination(v: unknown, pages: number): { section: number; starts: LStart[]; continued: number[] }[] {
  const bad = (): never => { throw new ToolError(LAYOUT_BAD) }
  const o = v && typeof v === 'object' ? v as { pages?: unknown } : bad()
  if (!Array.isArray(o.pages) || o.pages.length !== pages) bad()
  let n = 0
  return (o.pages as unknown[]).map((pg) => {
    const p = pg && typeof pg === 'object' ? pg as { section?: unknown; columns?: unknown } : bad()
    const section = Number.isInteger(p.section) && (p.section as number) >= 0 && (p.section as number) < 10_000 ? p.section as number : bad()
    const starts: LStart[] = [], continued: number[] = []
    for (const col of Array.isArray(p.columns) ? p.columns : bad()) {
      const items = col && typeof col === 'object' && Array.isArray((col as { items?: unknown }).items) ? (col as { items: unknown[] }).items : bad()
      for (const x of items) {
        if (++n > LAYOUT_LIMITS.nodes) bad()
        const it = x && typeof x === 'object' ? x as Record<string, unknown> : bad()
        if (!Number.isInteger(it.paraIndex) || (it.paraIndex as number) < 0) continue
        const kind = it.kind
        if (it.isContinuation === true) continued.push(it.paraIndex as number)
        const first = kind === 'fullParagraph' || kind === 'table' || (typeof kind === 'string' && kind.startsWith('partial') && it.isContinuation === false)
        if (!first) continue
        starts.push({ para: it.paraIndex as number, table: kind === 'table' || kind === 'partialTable', preview: typeof it.textPreview === 'string' ? it.textPreview.slice(0, 200) : '' })
      }
    }
    return { section, starts, continued }
  })
}

/** a character's share of a run's width: full-width scripts (Hangul, CJK, full-width forms) one, others a half */
function units(s: string): number[] {
  return [...s].map((ch) => {
    const c = ch.codePointAt(0)!
    if (c === 0x20) return 0.5
    if (c === 0x28 || c === 0x29) return 0.4
    return (c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 1 : 0.55
  })
}
/** The x of character `k` of a line's text (its left edge; k = text.length: the right edge of the last one), from
 * the runs' boxes, characters spread in each run by their share of its width. */
export function charX(line: LLine, k: number): number {
  return charX2(line, k)
}
/** a label's left and right edge on its line (px): exact at a run's edge (the renderer measured the run), else by the
 * characters' shares; a label that ends (or starts) a run is measured back (forward) from that edge with its own
 * characters at the line's text size, so a long run's estimate does not move it */
export function labelX(line: LLine, k: number, n: number): [number, number] {
  let at = 0
  for (const r of line.runs) {
    const len = [...r.text].length
    if (k >= at && k + n <= at + len && len) {
      const em = line.h, w = units([...r.text].slice(k - at, k - at + n).join('')).reduce((a, b) => a + b, 0) * em
      if (k + n === at + len) return [r.x + r.w - w, r.x + r.w]
      if (k === at) return [r.x, r.x + w]
      break
    }
    at += len
  }
  return [charX2(line, k), charX2(line, k + n)]
}
/** the part `from`..`to` (string indexes) of a measured text's box [x0, x1], by the characters' shares */
export function partX(x0: number, x1: number, text: string, from: number, to: number): [number, number] {
  const share = (s: string) => units(s).reduce((a, b) => a + b, 0)
  const all = share(text) || 1
  return [x0 + ((x1 - x0) * share(text.slice(0, from))) / all, x0 + ((x1 - x0) * share(text.slice(0, to))) / all]
}
function charX2(line: LLine, k: number): number {
  let at = 0
  for (const r of line.runs) {
    const n = [...r.text].length
    if (k <= at + n && n) {
      const u = units(r.text)
      const total = u.reduce((a, b) => a + b, 0) || 1
      const before = u.slice(0, k - at).reduce((a, b) => a + b, 0)
      return r.x + (r.w * before) / total
    }
    at += n
  }
  const last = line.runs[line.runs.length - 1]
  return last ? last.x + last.w : line.x
}

/** where a text appears on the pages, in reading order: page, line and the character it starts at (code points) */
export interface LHit { page: number; line: number; at: number }
export function layoutTextHits(layout: HwpLayout, text: string): LHit[] {
  const out: LHit[] = []
  layout.pages.forEach((p, pi) => p.lines.forEach((l, li) => {
    for (let k = l.text.indexOf(text); k >= 0; k = l.text.indexOf(text, k + text.length)) out.push({ page: pi, line: li, at: [...l.text.slice(0, k)].length })
  }))
  return out
}
/** the cells whose text (their lines together, white space aside) is `label`, in reading order */
export function layoutLabelCells(layout: HwpLayout, label: string): { page: number; cell: number }[] {
  const out: { page: number; cell: number }[] = []
  layout.pages.forEach((p, pi) => p.cells.forEach((_, ci) => {
    const text = p.lines.filter((l) => l.cell === ci).map((l) => l.text).join('').replace(/\s+/g, '')
    if (text === label) out.push({ page: pi, cell: ci })
  }))
  return out
}

// ---------------------------------------------------------------- where the picture goes
export type ImagePlace = 'over' | 'after' | 'before' | 'cell'
export interface PictureSpot {
  /** 0-based page and the picture's box on it (HWPUNIT from the paper's top-left) */
  page: number
  box: { x: number; y: number; w: number; h: number }
  /** set when the picture is placed vertically from its anchor paragraph's top (HWPUNIT, may be negative) instead of
   * from the paper: a document without Hangul's layout cache, which Hangul lays out again its own way */
  fromPara?: number
}
export interface PictureSize { width_mm?: number; height_mm?: number }

/**
 * The picture's box on the page from the layout: `target` is the label's box (or the cell's); `aspect` the image's
 * height over its width. Sizes: as given (one side: the other follows the image); else a seal's 15 mm over a label,
 * 12 mm high next to one, and in a cell its height less 2 mm (10 to 20 mm) and no wider than it. The box is kept on
 * the paper.
 */
export function placePicture(page: LPage, pageIndex: number, target: { x: number; y: number; w: number; h: number }, place: ImagePlace, size: PictureSize, aspect: number): PictureSpot {
  let w: number, h: number
  if (size.width_mm !== undefined && size.height_mm !== undefined) { w = size.width_mm; h = size.height_mm }
  else if (size.width_mm !== undefined) { w = size.width_mm; h = w * aspect }
  else if (size.height_mm !== undefined) { h = size.height_mm; w = h / aspect }
  else if (place === 'cell') {
    // the cell's height less 1 mm on each side, at least 10 mm (a low row: the picture reaches over its borders, as a
    // signature on paper does) and at most 20 mm; no wider than the cell less 2 mm, at most 40 mm
    h = Math.min(20, Math.max(10, target.h * MM_PER_PX - 2)); w = h / aspect
    const cw = Math.max(2, Math.min(40, target.w * MM_PER_PX - 2))
    if (w > cw) { w = cw; h = w * aspect }
  } else if (place === 'over') { const s = 15; if (aspect >= 1) { h = s; w = s / aspect } else { w = s; h = s * aspect } }
  else { h = 12; w = h / aspect }
  // px from here on
  w /= MM_PER_PX; h /= MM_PER_PX
  const gap = 1 / MM_PER_PX
  const cx = target.x + target.w / 2, cy = target.y + target.h / 2
  let x = place === 'after' ? target.x + target.w + gap : place === 'before' ? target.x - gap - w : cx - w / 2
  let y = cy - h / 2
  x = Math.max(0, Math.min(x, page.w - w))
  y = Math.max(0, Math.min(y, page.h - h))
  const hu = (px: number) => Math.round(px * HU_PER_PX)
  return { page: pageIndex, box: { x: hu(x), y: hu(y), w: Math.max(1, hu(w)), h: Math.max(1, hu(h)) } }
}

export const aimOf = (t: { x: number; y: number; w: number; h: number }, exact: boolean) => ({ xMm: round1((t.x + t.w / 2) * MM_PER_PX), yMm: round1((t.y + t.h / 2) * MM_PER_PX), exact })

/** Where a picture really landed, from the layout of the saved file. */
export type HwpLanding = { change: number; state: 'checked'; mm: number } | { change: number; state: 'missed'; mm: number | null } | { change: number; state: 'not-checked' }
/** Each aimed picture against the pictures that are new in `after`: the nearest on its page, its centre to the aim, the
 * larger of the two axes. An anchor the renderer does not draw as Hangul does is reported as not checked, never as a miss. */
export function landings(before: HwpLayout, after: HwpLayout, notes: readonly HwpPictureNote[], toleranceMm: number): HwpLanding[] {
  const same = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5
  return notes.flatMap((n): HwpLanding[] => {
    if (!n.aim) return []
    if (!n.aim.exact) return [{ change: n.change, state: 'not-checked' }]
    const old = before.pages[n.page - 1]?.images ?? []
    const fresh = (after.pages[n.page - 1]?.images ?? []).filter((b) => !old.some((o) => same(o, b)))
    const off = fresh.map((b) => Math.max(Math.abs((b.x + b.w / 2) * MM_PER_PX - n.aim!.xMm), Math.abs((b.y + b.h / 2) * MM_PER_PX - n.aim!.yMm)))
    if (!off.length) {
      // on another page it is a miss; drawn nowhere, the renderer shows nothing to measure
      const elsewhere = after.pages.some((pg, i) => i !== n.page - 1 && (pg.images ?? []).some((b) => !(before.pages[i]?.images ?? []).some((o) => same(o, b))))
      return [elsewhere ? { change: n.change, state: 'missed', mm: null } : { change: n.change, state: 'not-checked' }]
    }
    const mm = round1(Math.min(...off))
    return [mm <= toleranceMm ? { change: n.change, state: 'checked', mm } : { change: n.change, state: 'missed', mm }]
  })
}

/** A picture's place for the AI, in mm from the page's top-left. */
export interface HwpPictureNote {
  change: number; page: number; xMm: number; yMm: number; widthMm: number; heightMm: number; where: string; part: string; fromParagraph?: boolean
  /** a picture over a text: the centre of what it is aimed at, in mm on the page; `exact`: the renderer draws this
   * anchor where Hangul does (a stored layout and a body paragraph), so a measured miss is a real one */
  aim?: { xMm: number; yMm: number; exact: boolean }
}
export const spotNote = (change: number, s: PictureSpot, where: string, part: string): HwpPictureNote => ({
  change, page: s.page + 1, xMm: round1(s.box.x / HU_PER_MM), yMm: round1(s.box.y / HU_PER_MM), widthMm: round1(s.box.w / HU_PER_MM), heightMm: round1(s.box.h / HU_PER_MM), where, part,
  ...(s.fromPara !== undefined ? { fromParagraph: true } : {}),
})
