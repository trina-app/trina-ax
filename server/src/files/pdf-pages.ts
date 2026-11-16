// edit_pdf, merge_pdfs and split_pdf's worker part (tools/pdf-tools.ts): page work on existing PDFs with pdf-lib (MIT)
// and, for text that is not Latin, the Pretendard font through @pdf-lib/fontkit (MIT). pdf-lib parses untrusted PDFs
// and images in memory, so this parses only in the office worker (files/office-worker.ts, mode `pdf-pages`), never in
// the server process: office-parse.ts calls pdfPagesRequest there (the server process loads the module but runs only
// parsePages, the request encoding and the result decoding).
//
// Page numbers in an operation are the document's pages at that moment: operations run in the order given, so after
// { remove_pages: "2" } the old page 3 is page 2. Positions are said as the page is shown (its CropBox with /Rotate
// applied), from its top-left corner, in mm. A page's own drawing is wrapped in q … Q before anything is drawn on it.
import fontkit from '@pdf-lib/fontkit'
import { decodePDFRawStream, degrees, PDFArray, PDFDict, PDFDocument, PDFFlateStream, PDFName, PDFRawStream, popGraphicsState, pushGraphicsState, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib'
import { ToolError } from '../policy/errors'
import { decodeHwpxRequest, encodeHwpxRequest } from './hwpx-check'
import { imageKind, imageSize, mmToPt, ptToMm, shownRect, STAMP_DEFAULT_MARGIN_MM, STAMP_DEFAULT_WIDTH_MM, STAMP_IMAGE_SIDE_MAX, type StampPosition } from './pdf-stamp'

export const PDF_PAGES_MODE = 'pdf-pages'
/** all the PDFs (and images and the font) of one call together */
export const PDF_PAGES_INPUT_MAX = 40 * 1024 * 1024
export const PDF_PAGES_FILES_MAX = 20
export const PDF_PAGES_PARTS_MAX = 50
export const PDF_PAGES_OPS_MAX = 30
/** pages of one document at any time (a merge of many, an insert) */
export const PDF_PAGES_MAX = 3000

export type TextPosition = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'center' | { x_mm: number; y_mm: number }
export type TextColor = 'black' | 'gray' | 'red' | 'blue'
/** One operation of edit_pdf, as the worker gets it: a file an operation names is an index into `parts`. */
export type PageOp =
  | { remove_pages: string }
  | { keep_pages: string }
  | { reorder_pages: string }
  | { rotate_pages: { pages?: string; degrees: number } }
  | { insert_pdf: { file: number; pages?: string; after: number | 'last' } }
  | { stamp_image: { image: number; page?: number | 'last'; position?: StampPosition; width_mm?: number; margin_mm?: number } }
  | { add_text: { text: string; pages?: string; position?: TextPosition; size_pt?: number; color?: TextColor; opacity?: number } }
  | { watermark: { text: string; pages?: string; color?: TextColor; opacity?: number } }
  | { page_numbers: { format?: string; pages?: string; position?: TextPosition; start?: number; size_pt?: number } }

/** The request: which job, the names of the parts (for messages), and the parts' lengths; the body is the parts. */
export type PagesJob =
  | { kind: 'edit'; ops: PageOp[]; font: number | null }
  | { kind: 'merge'; files: { part: number; pages?: string }[] }
  | { kind: 'split'; parts: string[] }
  /** only the page count (split_pdf's `every`) */
  | { kind: 'count' }
export interface PagesRequest { job: PagesJob; names: string[]; lengths: number[] }
export interface PagesReport { files: { pages: number; length: number }[]; notes: string[]; signed: boolean }

// ---------------------------------------------------------------- page ranges

/**
 * "1,3-5,last", "2-last", "all", "last" into page numbers (1-based) of a document of `n` pages, in the order written,
 * each once. A ToolError names what is wrong ("page 9: the PDF has 5 pages").
 */
export function parsePages(spec: string, n: number): number[] {
  const s = spec.trim().toLowerCase().replace(/[–—~]/g, '-').replace(/\s+/g, '')
  if (!s) throw new ToolError('no pages given; write pages like "1,3-5,last"')
  if (s === 'all') return Array.from({ length: n }, (_, i) => i + 1)
  const num = (t: string): number => {
    if (t === 'last') return n
    if (!/^\d{1,6}$/.test(t)) throw new ToolError(`"${t}" is not a page; write pages like "1,3-5,last"`)
    const v = Number(t)
    if (v < 1) throw new ToolError('pages start at 1')
    if (v > n) throw new ToolError(`there is no page ${v}: the PDF has ${n} page${n === 1 ? '' : 's'}`)
    return v
  }
  const out: number[] = []
  const seen = new Set<number>()
  for (const part of s.split(',')) {
    if (!part) continue
    const m = part.match(/^([^-]+)-([^-]+)$/)
    const [a, b] = m ? [num(m[1]!), num(m[2]!)] : [num(part), num(part)]
    if (a > b) throw new ToolError(`"${part}" goes backwards; write the lower page first (to change the order, use reorder_pages)`)
    for (let p = a; p <= b; p++) if (!seen.has(p)) { seen.add(p); out.push(p) }
  }
  if (!out.length) throw new ToolError('no pages given; write pages like "1,3-5,last"')
  return out
}

/** A rotation the person asked for, in degrees clockwise: 90, 180, 270 or -90 (= 270); anything else is refused. */
export function rotationOf(d: number): 90 | 180 | 270 {
  const r = ((d % 360) + 360) % 360
  if (r !== 90 && r !== 180 && r !== 270) throw new ToolError(`pages turn by 90, 180 or 270 degrees (or -90), not ${d}`)
  return r
}

// ---------------------------------------------------------------- encoding

export function encodePagesRequest(job: PagesJob, parts: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.bytes.length, 0)
  const body = new Uint8Array(total)
  let at = 0
  for (const p of parts) { body.set(p.bytes, at); at += p.bytes.length }
  const req: PagesRequest = { job, names: parts.map((p) => p.name), lengths: parts.map((p) => p.bytes.length) }
  return encodeHwpxRequest(JSON.stringify(req), body)
}

export function decodePagesResult(b: Uint8Array): { report: PagesReport; files: Uint8Array[] } {
  const r = decodeHwpxRequest(b)
  const report = JSON.parse(r.astJson) as PagesReport
  if (!Array.isArray(report?.files) || !report.files.length || !Array.isArray(report.notes)) throw new Error('bad result')
  const body = r.template ?? new Uint8Array()
  const files: Uint8Array[] = []
  let at = 0
  for (const f of report.files) {
    if (!Number.isInteger(f.length) || f.length < 1 || at + f.length > body.length) throw new Error('bad result')
    files.push(body.slice(at, at + f.length))
    at += f.length
  }
  if (at !== body.length) throw new Error('bad result')
  return { report, files }
}

// ---------------------------------------------------------------- the worker

const COLORS: Record<TextColor, [number, number, number]> = { black: [0, 0, 0], gray: [0.45, 0.45, 0.45], red: [0.8, 0.1, 0.1], blue: [0.1, 0.25, 0.75] }
const has = (b: Uint8Array, s: string) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(s, 0, 'latin1')
/** text Helvetica (WinAnsi) can write: printable Latin-1 */
const latin = (t: string) => /^[\x20-\x7e\xa0-\xff]*$/.test(t)

async function open(bytes: Uint8Array, name: string): Promise<PDFDocument> {
  let doc: PDFDocument
  // opened even when encrypted, only to tell a locked PDF from a broken one; a locked one is refused right after
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }) } catch {
    throw new ToolError(`'${name}' could not be opened as a PDF (it is damaged or not a PDF); nothing was saved`, 'pdf_invalid')
  }
  if (doc.isEncrypted) throw new ToolError(`'${name}' is locked with a password or protected against changes, so it cannot be changed here; nothing was saved`, 'pdf_encrypted')
  if (doc.getPageCount() < 1) throw new ToolError(`'${name}' has no pages that can be read (it may be damaged); nothing was saved`, 'pdf_invalid')
  return doc
}

/** the page as shown: its visible box, its turn, and its shown width and height */
function shown(page: PDFPage) {
  const box = page.getCropBox()
  const r = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360
  const turned = r === 90 || r === 270
  return { box, r, w: turned ? box.height : box.width, h: turned ? box.width : box.height }
}

/** a point of the page as shown (from its top-left) in PDF space */
export function toUser(box: { x: number; y: number; width: number; height: number }, r: number, u: number, v: number): { x: number; y: number } {
  const W = box.width, H = box.height
  const [px, py] = r === 0 ? [u, H - v] : r === 90 ? [v, u] : r === 180 ? [W - u, v] : [W - v, H - u]
  return { x: box.x + px, y: box.y + py }
}

/** pdf-lib 1.17.1's removePage does not drop its page cache (insertPage does), so getPage and copyPages kept seeing
 * the removed pages afterwards: remove, then drop the cache (a private field of that pinned version; checked by
 * tests/unit/c-edit-pdf.test.ts "removed pages are gone"). */
function removePage(doc: PDFDocument, index: number) {
  doc.removePage(index)
  ;(doc as unknown as { pageCache: { invalidate(): void } }).pageCache.invalidate()
}

/**
 * Give each of these pages its own /Resources whose /XObject and /Font hold only the names its content streams use
 * (`/Name Do`, `/Name Tf`), before the pages are copied into a new document: a /Resources shared by many pages (on the
 * page tree, common in scanner and generator output) would otherwise carry a removed page's pictures into the result
 * (review of feat/edit-pdf). A page whose content cannot be decoded keeps its resources as they are.
 */
export function pruneResources(doc: PDFDocument, indices: number[]) {
  const ctx = doc.context
  for (const i of new Set(indices)) {
    const node = doc.getPage(i).node
    let text = ''
    try {
      const c = ctx.lookup(node.get(PDFName.of('Contents')))
      const streams = c instanceof PDFArray ? c.asArray().map((x) => ctx.lookup(x)) : [c]
      for (const s of streams) {
        // a stream read from the file, or one drawn here (our q … Q, a stamp, text: not yet encoded)
        if (s instanceof PDFRawStream) text += Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') + '\n'
        else if (s instanceof PDFFlateStream) text += Buffer.from(s.getUnencodedContents()).toString('latin1') + '\n'
        else throw new Error('not a stream')
      }
    } catch { continue }
    const res = node.Resources()
    if (!res) continue
    const own = res.clone(ctx)
    for (const [key, op] of [['XObject', 'Do'], ['Font', 'Tf']] as const) {
      const dict = own.lookupMaybe(PDFName.of(key), PDFDict)
      if (!dict) continue
      const used = new Set<string>()
      const re = key === 'XObject' ? /\/([^\s/<>\[\]()]+)\s+Do\b/g : /\/([^\s/<>\[\]()]+)\s+[-+\d.]+\s+Tf\b/g
      for (const m of text.matchAll(re)) used.add(m[1]!)
      const kept = PDFDict.withContext(ctx)
      for (const [name, v] of dict.entries()) if (used.has(name.decodeText())) kept.set(name, v)
      own.set(PDFName.of(key), kept)
    }
    node.set(PDFName.of('Resources'), own)
  }
}

const wrapped = new WeakSet<PDFPage>()
/** the page's own drawing in q … Q once, so coordinates it leaves changed do not move what is drawn after it */
function wrapOnce(doc: PDFDocument, page: PDFPage) {
  if (wrapped.has(page)) return
  page.node.normalize()
  const ctx = doc.context
  page.node.wrapContentStreams(ctx.register(ctx.contentStream([pushGraphicsState()])), ctx.register(ctx.contentStream([popGraphicsState()])))
  wrapped.add(page)
}

/** where a line of text `tw` wide and `size` high starts (its baseline's left end, as shown) */
function textAt(position: TextPosition, w: number, h: number, tw: number, size: number, marginMm: number): { u: number; v: number } {
  const m = mmToPt(marginMm)
  const asc = size * 0.75
  if (typeof position === 'object') return { u: mmToPt(position.x_mm), v: mmToPt(position.y_mm) + asc }
  const [vert, horiz] = position === 'center' ? ['center', 'center'] : position.split('-') as [string, string]
  const u = horiz === 'left' ? m : horiz === 'right' ? w - m - tw : (w - tw) / 2
  const v = vert === 'top' ? m + asc : vert === 'bottom' ? h - m : (h + asc) / 2
  return { u, v }
}

export async function pdfPagesRequest(input: Uint8Array): Promise<Uint8Array> {
  let req: PagesRequest, parts: Uint8Array[]
  try {
    const r = decodeHwpxRequest(input)
    req = JSON.parse(r.astJson) as PagesRequest
    const body = r.template ?? new Uint8Array()
    parts = []
    let at = 0
    // copies, never views into the request: pdf-lib's JPEG reader reads `bytes.buffer` from its start
    for (const n of req.lengths) { if (!Number.isInteger(n) || n < 1 || at + n > body.length) throw new Error('bad'); parts.push(body.slice(at, at + n)); at += n }
    if (at !== body.length || req.names.length !== parts.length) throw new Error('bad')
  } catch { throw new ToolError('the PDF tool got a damaged request; nothing was saved') }
  const name = (i: number) => req.names[i] ?? 'the PDF'
  const notes: string[] = []
  const save = async (d: PDFDocument) => {
    const b = await d.save()
    // read back: the result must open again with the same pages
    try { if ((await PDFDocument.load(b, { updateMetadata: false })).getPageCount() !== d.getPageCount()) throw new Error('pages') } catch {
      throw new ToolError('the changed PDF did not read back as expected; nothing was saved')
    }
    return b
  }
  const finish = (files: { bytes: Uint8Array; pages: number }[], signed: boolean) => {
    const total = files.reduce((n, f) => n + f.bytes.length, 0)
    const body = new Uint8Array(total)
    let at = 0
    for (const f of files) { body.set(f.bytes, at); at += f.bytes.length }
    const report: PagesReport = { files: files.map((f) => ({ pages: f.pages, length: f.bytes.length })), notes, signed }
    return encodeHwpxRequest(JSON.stringify(report), body)
  }
  const tooMany = (n: number) => { if (n > PDF_PAGES_MAX) throw new ToolError(`the result would have ${n} pages, more than ${PDF_PAGES_MAX}; nothing was saved`) }
  const job = req.job

  if (job.kind === 'merge') {
    const out = await PDFDocument.create()
    let signed = false
    for (const f of job.files) {
      const src = await open(parts[f.part]!, name(f.part))
      signed ||= has(parts[f.part]!, '/ByteRange')
      const pages = f.pages ? parsePages(f.pages, src.getPageCount()) : Array.from({ length: src.getPageCount() }, (_, i) => i + 1)
      tooMany(out.getPageCount() + pages.length)
      pruneResources(src, pages.map((x) => x - 1))
      for (const p of await out.copyPages(src, pages.map((x) => x - 1))) out.addPage(p)
    }
    return finish([{ bytes: await save(out), pages: out.getPageCount() }], signed)
  }

  const main = parts[0]!
  const doc = await open(main, name(0))
  // a signature in any of the PDFs used (an inserted one too) no longer holds
  const signed = parts.some((b) => has(b, '/ByteRange'))

  if (job.kind === 'count') {
    // the count in the report, and a one-page PDF as the file (the answer always carries one)
    const one = await PDFDocument.create()
    one.addPage([10, 10])
    const report: PagesReport = { files: [{ pages: doc.getPageCount(), length: 0 }], notes, signed }
    const b = await one.save()
    report.files[0]!.length = b.length
    return encodeHwpxRequest(JSON.stringify(report), b)
  }

  if (job.kind === 'split') {
    if (!job.parts.length || job.parts.length > PDF_PAGES_PARTS_MAX) throw new ToolError(`give 1 to ${PDF_PAGES_PARTS_MAX} parts; nothing was saved`)
    const files: { bytes: Uint8Array; pages: number }[] = []
    for (const spec of job.parts) {
      const pages = parsePages(spec, doc.getPageCount())
      pruneResources(doc, pages.map((x) => x - 1))
      const part = await PDFDocument.create()
      for (const p of await part.copyPages(doc, pages.map((x) => x - 1))) part.addPage(p)
      files.push({ bytes: await save(part), pages: part.getPageCount() })
    }
    return finish(files, signed)
  }

  // edit: the operations in order, on one document
  /** pages were taken out (remove, keep, reorder): the result is built fresh, see below */
  let dropped = false
  let font: PDFFont | null = null
  let cjk: PDFFont | null = null
  let cjkFont: ReturnType<typeof fontkit.create> | null = null
  const fontFor = async (text: string): Promise<PDFFont> => {
    if (latin(text)) return (font ??= await doc.embedFont(StandardFonts.Helvetica))
    if (job.font === null) throw new ToolError('this text has letters outside the Latin alphabet, and no font for them is installed on this server; write it in Latin letters, or ask an admin. Nothing was saved', 'pdf_font_missing')
    if (!cjk) {
      doc.registerFontkit(fontkit)
      cjkFont = fontkit.create(Buffer.from(parts[job.font]!))
      // the whole font (about 1.2 MB in the file): @pdf-lib/fontkit's subsetting leaves Pretendard's glyphs empty, so
      // the text was there for search but drew nothing (checked by drawing the page in tests/unit/c-edit-pdf.test.ts)
      cjk = await doc.embedFont(parts[job.font]!, { subset: false })
    }
    const missing = [...text].filter((ch) => ch.trim() && !cjkFont!.hasGlyphForCodePoint(ch.codePointAt(0)!))
    if (missing.length) throw new ToolError(`the font here cannot show ${[...new Set(missing)].slice(0, 5).join(' ')} in the text; write those another way. Nothing was saved`, 'pdf_font_glyphs')
    return cjk
  }
  for (const [i, op] of job.ops.entries()) {
    const n = doc.getPageCount()
    const step = `operation ${i + 1}`
    try {
      if ('remove_pages' in op) {
        dropped = true
        const pages = parsePages(op.remove_pages, n)
        if (pages.length >= n) throw new ToolError('that would remove every page; a PDF needs at least one page')
        for (const p of [...pages].sort((a, b) => b - a)) removePage(doc, p - 1)
      } else if ('keep_pages' in op) {
        dropped = true
        const pages = parsePages(op.keep_pages, n)
        const copies = await doc.copyPages(doc, pages.map((x) => x - 1))
        for (let p = n - 1; p >= 0; p--) removePage(doc, p)
        for (const c of copies) doc.addPage(c)
      } else if ('reorder_pages' in op) {
        dropped = true
        const pages = parsePages(op.reorder_pages, n)
        if (pages.length !== n) throw new ToolError(`reorder_pages lists every page once (the PDF has ${n}); to leave pages out, use keep_pages or remove_pages`)
        const copies = await doc.copyPages(doc, pages.map((x) => x - 1))
        for (let p = n - 1; p >= 0; p--) removePage(doc, p)
        for (const c of copies) doc.addPage(c)
      } else if ('rotate_pages' in op) {
        const by = rotationOf(op.rotate_pages.degrees)
        for (const p of parsePages(op.rotate_pages.pages ?? 'all', n)) {
          const page = doc.getPage(p - 1)
          page.setRotation(degrees((((page.getRotation().angle + by) % 360) + 360) % 360))
        }
      } else if ('insert_pdf' in op) {
        const f = op.insert_pdf
        const other = await open(parts[f.file]!, name(f.file))
        const pages = f.pages ? parsePages(f.pages, other.getPageCount()) : Array.from({ length: other.getPageCount() }, (_, k) => k + 1)
        const after = f.after === 'last' ? n : f.after
        if (!Number.isInteger(after) || after < 0 || after > n) throw new ToolError(`"after" is a page from 0 (before the first) to ${n} (the last), or "last"`)
        tooMany(n + pages.length)
        const copies = await doc.copyPages(other, pages.map((x) => x - 1))
        copies.forEach((c, k) => doc.insertPage(after + k, c))
      } else if ('stamp_image' in op) {
        const s = op.stamp_image
        const image = parts[s.image]!
        const kind = imageKind(image)
        const px = kind ? imageSize(image, kind) : null
        if (!kind || !px || px.width < 1 || px.height < 1) throw new ToolError(`'${name(s.image)}' is not a PNG or JPG picture that can be read`)
        if (Math.max(px.width, px.height) > STAMP_IMAGE_SIDE_MAX) throw new ToolError(`'${name(s.image)}' is larger than ${STAMP_IMAGE_SIDE_MAX} pixels on a side; use a smaller picture`)
        const pageNo = s.page === undefined || s.page === 'last' ? n : s.page
        if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > n) throw new ToolError(`there is no page ${s.page}: the PDF has ${n} page${n === 1 ? '' : 's'}`)
        const page = doc.getPage(pageNo - 1)
        let embedded
        try { embedded = kind === 'png' ? await doc.embedPng(image) : await doc.embedJpg(image) } catch { throw new ToolError(`'${name(s.image)}' could not be read (a damaged PNG or JPG)`) }
        const { box, r, w, h } = shown(page)
        const iw = mmToPt(s.width_mm ?? STAMP_DEFAULT_WIDTH_MM)
        const ih = iw * (embedded.height / embedded.width)
        const { u, v } = shownRect(s.position ?? 'bottom-right', w, h, iw, ih, s.margin_mm ?? STAMP_DEFAULT_MARGIN_MM)
        if (u < -0.5 || v < -0.5 || u + iw > w + 0.5 || v + ih > h + 0.5) throw new ToolError(`the image would not fit on page ${pageNo} there (the page is ${Math.round(ptToMm(w))} x ${Math.round(ptToMm(h))} mm); give a smaller width_mm or another position`)
        wrapOnce(doc, page)
        const at = toUser(box, r, u, v + ih)
        page.drawImage(embedded, { x: at.x, y: at.y, width: iw, height: ih, rotate: degrees(r) })
      } else if ('add_text' in op || 'page_numbers' in op) {
        const t = 'add_text' in op ? op.add_text : null
        const pn = 'page_numbers' in op ? op.page_numbers : null
        const pages = parsePages((t ?? pn)!.pages ?? 'all', n)
        const size = (t ?? pn)!.size_pt ?? (pn ? 10 : 12)
        const position = (t ?? pn)!.position ?? (pn ? 'bottom-center' : 'top-right')
        const format = pn?.format ?? '{n}'
        if (pn && !format.includes('{n}')) throw new ToolError('the page number format needs {n} where the number goes, e.g. "{n} / {total}"')
        const start = pn?.start ?? 1
        const total = pages.length + start - 1
        const [cr, cg, cb] = COLORS[t?.color ?? 'black']
        for (const [k, p] of pages.entries()) {
          const text = t ? t.text : format.replaceAll('{n}', String(k + start)).replaceAll('{total}', String(total))
          if (!text.trim()) throw new ToolError('the text is empty')
          if (/[\r\n]/.test(text)) throw new ToolError('the text is one line; add each line as its own add_text')
          const f = await fontFor(text)
          const page = doc.getPage(p - 1)
          const { box, r, w, h } = shown(page)
          const tw = f.widthOfTextAtSize(text, size)
          const { u, v } = textAt(position, w, h, tw, size, pn ? 10 : 15)
          if (u < -0.5 || u + tw > w + 0.5 || v - size * 0.75 < -0.5 || v > h + 0.5) throw new ToolError(`the text would not fit on page ${p} there (the page is ${Math.round(ptToMm(w))} x ${Math.round(ptToMm(h))} mm); give a smaller size_pt or another position`)
          wrapOnce(doc, page)
          const at = toUser(box, r, u, v)
          page.drawText(text, { x: at.x, y: at.y, size, font: f, color: rgb(cr, cg, cb), rotate: degrees(r), ...(t?.opacity !== undefined ? { opacity: t.opacity } : {}) })
        }
      } else if ('watermark' in op) {
        const wm = op.watermark
        if (!wm.text.trim() || /[\r\n]/.test(wm.text)) throw new ToolError('the watermark is one line of text')
        const f = await fontFor(wm.text)
        const [cr, cg, cb] = COLORS[wm.color ?? 'gray']
        for (const p of parsePages(wm.pages ?? 'all', n)) {
          const page = doc.getPage(p - 1)
          const { box, r, w, h } = shown(page)
          // across the page from bottom-left to top-right, about 70% of its diagonal
          const angle = Math.atan2(h, w)
          const size = Math.min(160, (0.7 * Math.hypot(w, h)) / Math.max(1, f.widthOfTextAtSize(wm.text, 1)))
          const tw = f.widthOfTextAtSize(wm.text, size)
          const asc = size * 0.35
          // the baseline's start, so that the text's middle is the page's middle
          const u = w / 2 - (tw / 2) * Math.cos(angle) + asc * Math.sin(angle)
          const v = h / 2 + (tw / 2) * Math.sin(angle) + asc * Math.cos(angle)
          wrapOnce(doc, page)
          const at = toUser(box, r, u, v)
          page.drawText(wm.text, { x: at.x, y: at.y, size, font: f, color: rgb(cr, cg, cb), opacity: wm.opacity ?? 0.2, rotate: degrees(r + (angle * 180) / Math.PI) })
        }
      } else throw new ToolError('an unknown operation')
    } catch (e) {
      if (e instanceof ToolError) throw new ToolError(`${step}: ${e.message.replace(/; nothing was saved$|\. Nothing was saved$/, '')}; nothing was saved`, e.code)
      throw e
    }
  }
  // pdf-lib's save writes every object the document holds, so a removed page's content would still be inside the file
  // (review of feat/edit-pdf: "remove the salary page" left its text in the result). After a removal the final pages
  // are copied into a new document, which holds only what they use. (Its outline and form fields are not carried over.)
  if (dropped) {
    const fresh = await PDFDocument.create()
    pruneResources(doc, doc.getPageIndices())
    for (const p of await fresh.copyPages(doc, doc.getPageIndices())) fresh.addPage(p)
    return finish([{ bytes: await save(fresh), pages: fresh.getPageCount() }], signed)
  }
  return finish([{ bytes: await save(doc), pages: doc.getPageCount() }], signed)
}
