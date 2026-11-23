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
import { decodePDFRawStream, degrees, PDFArray, PDFDict, PDFDocument, PDFFlateStream, PDFName, PDFNull, PDFObjectCopier, PDFPage, PDFPageLeaf, PDFPageTree, PDFRawStream, PDFRef, PDFStream, popGraphicsState, pushGraphicsState, rgb, StandardFonts, type PDFContext, type PDFFont, type PDFObject } from 'pdf-lib'
import { ToolError } from '../policy/errors'
import { decodeHwpxRequest, encodeHwpxRequest } from './hwpx-check'
import { dropUnreached, replaceOnPage, winAnsiCan, wordsElsewhere, writeStandardWidths, type FallbackFont, type FontStyle, type ReplaceOutcome } from './pdf-text'
import { fieldBoxesOnPage, fillForm, formReport, type FormReport } from './pdf-form'
import { imageKind, imageSize, mmToPt, ptToMm, shownRect, STAMP_DEFAULT_MARGIN_MM, STAMP_DEFAULT_WIDTH_MM, STAMP_IMAGE_SIDE_MAX, type StampPosition, visibleBox } from './pdf-stamp'

export const PDF_PAGES_MODE = 'pdf-pages'
/** all the PDFs (and images and the font) of one call together. Measured in the office worker (pdf-lib holds the
 * input, its parsed objects and the new file at once): a 100 MB scan peaks near 1.05 GB of its 2 GB, a 200 MB one at
 * 2 GB, so 100 MB leaves half for a PDF of many small objects (docs/decisions/20261118-audit2-file-caps.md) */
export const PDF_PAGES_INPUT_MAX = 100 * 1024 * 1024
/** the worker's answer for these tools: the new file(s) are about as large as what went in, plus added text and fonts
 * (split_pdf's parts may overlap); larger is refused with "the file would be larger than ..." */
export const PDF_OUTPUT_MAX = 160 * 1024 * 1024
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
  | { replace_text: { find: string; replace: string; pages?: string; match_case?: boolean } }
  /** the PDF's form fields by name (files/pdf-form.ts); flatten draws them into the pages */
  | { fill_form: { fields: Record<string, string | boolean>; flatten?: boolean } }

/** The request: which job, the names of the parts (for messages), and the parts' lengths; the body is the parts. */
export type PagesJob =
  | { kind: 'edit'; ops: PageOp[]; font: number | null }
  | { kind: 'merge'; files: { part: number; pages?: string }[] }
  | { kind: 'split'; parts: string[] }
  /** only the page count (split_pdf's `every`) */
  | { kind: 'count' }
  /** the page count and the form fields (a read of a PDF, files/service.ts) */
  | { kind: 'fields' }
export interface PagesRequest { job: PagesJob; names: string[]; lengths: number[] }
export interface PagesReport { files: { pages: number; length: number }[]; notes: string[]; signed: boolean; form?: FormReport }

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
  // a kid of the page tree that pdf-lib does not take for a page (no /Type): viewers show it, so page numbers here
  // would not be the numbers the person sees ("remove page 2" took out another page)
  const odd = (kids: PDFObject | undefined, depth: number): boolean => kids instanceof PDFArray && kids.asArray().some((k) => {
    const o = doc.context.lookup(k)
    return o instanceof PDFPageTree ? depth < 50 && odd(doc.context.lookup(o.get(PDFName.of('Kids'))), depth + 1) : !(o instanceof PDFPageLeaf)
  })
  let bad = false
  try { bad = odd(doc.context.lookup(doc.catalog.Pages().get(PDFName.of('Kids'))), 0) } catch { bad = true }
  if (bad) throw new ToolError(`'${name}' has a page list that cannot be read reliably (it may be damaged); nothing was saved`, 'pdf_invalid')
  if (doc.getPageCount() < 1) throw new ToolError(`'${name}' has no pages that can be read (it may be damaged); nothing was saved`, 'pdf_invalid')
  return doc
}

/** the page as shown: its visible box, its turn, and its shown width and height */
function shown(page: PDFPage) {
  const box = visibleBox(page)
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

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1')
const UNREADABLE = 'a page of this PDF is damaged (what it draws cannot be read), so pages cannot be taken out of it safely; nothing was saved'

/** What a content stream says. '' for what draws nothing (no object, null, not a stream); null for a stream that
 * cannot be decoded. */
function contentText(s: PDFObject | undefined): string | null {
  try {
    // a stream read from the file, or one drawn here (our q … Q, a stamp, text: not yet encoded)
    if (s instanceof PDFRawStream) {
      // pdf-lib's decoders do not apply /DecodeParms (a predictor): what they give is then not what the stream says
      if (s.dict.has(PDFName.of('DecodeParms')) || s.dict.has(PDFName.of('DP'))) return null
      return latin1(decodePDFRawStream(s).decode())
    }
    if (s instanceof PDFFlateStream) return latin1(s.getUnencodedContents())
  } catch { return null }
  return ''
}

const nameOf = (raw: string) => raw.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
const NAME = '\\/([^\\s\\0/<>\\[\\](){}%]+)'
/** between two tokens: white space (NUL is white space in a PDF) and comments */
const GAP = '(?:[\\s\\0]|%[^\\r\\n]*(?:[\\r\\n]|$))+'
const END = '(?![^\\s\\0/<>\\[\\](){}%])'
/** a name right before one of these operators */
const before = (ops: string) => new RegExp(`${NAME}${GAP}(?:${ops})${END}`, 'g')
const TF = new RegExp(`${NAME}${GAP}[-+\\d.]+${GAP}Tf${END}`, 'g')
const ANY = new RegExp(NAME, 'g')
/** the lists whose names are read by their operator; in the others (/ColorSpace, /Properties, …) a name counts when
 * the content writes it anywhere */
const BY_OPERATOR: Record<string, RegExp> = { XObject: before('Do'), Font: TF, ExtGState: before('gs'), Shading: before('sh'), Pattern: before('scn|SCN') }
/** colour spaces a page uses without naming them in its content */
const ALWAYS = ['DefaultGray', 'DefaultRGB', 'DefaultCMYK']
/** the resource names a content stream uses, for the list `key` */
function namesUsed(text: string, key: string): Set<string> {
  const out = new Set<string>(BY_OPERATOR[key] ? [] : ALWAYS)
  for (const m of text.matchAll(BY_OPERATOR[key] ?? ANY)) out.add(nameOf(m[1]!))
  return out
}

/** what the glyphs of a Type 3 font draw (its /CharProcs), or undefined when `o` is no Type 3 font; null: unreadable */
function glyphText(ctx: PDFContext, o: PDFObject | undefined): string | null | undefined {
  if (!(o instanceof PDFDict) || o.get(PDFName.of('Subtype')) !== PDFName.of('Type3')) return undefined
  const procs = ctx.lookup(o.get(PDFName.of('CharProcs')))
  if (!(procs instanceof PDFDict)) return ''
  const texts = procs.values().map((v) => contentText(ctx.lookup(v)))
  return texts.includes(null) ? null : texts.join('\n')
}

/** streams whose own /Resources were cut down already (a form shared by many pages, a document split into parts) */
const cut = new WeakSet<PDFStream>()
const cutDicts = new WeakSet<PDFDict>()

/**
 * A copy of `res` whose lists hold only the names `text` uses. A form the text draws, or a Type 3 font it writes
 * with, that has no /Resources of its own draws with these, so what it says counts too.
 */
function cutResources(ctx: PDFContext, res: PDFDict, text: string, strict: boolean): PDFDict {
  const list = (k: string) => { const d = ctx.lookup(res.get(PDFName.of(k))); return d instanceof PDFDict ? d : undefined }
  const xobjects = list('XObject'), fonts = list('Font')
  const seen = new Set<string>()
  for (let more = true; more;) {
    more = false
    const texts: (string | null | undefined)[] = []
    for (const n of namesUsed(text, 'XObject')) {
      if (seen.has(`x${n}`)) continue
      seen.add(`x${n}`)
      const x = ctx.lookup(xobjects?.get(PDFName.of(n)))
      if (x instanceof PDFStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Form') && !x.dict.has(PDFName.of('Resources'))) texts.push(contentText(x))
    }
    for (const n of namesUsed(text, 'Font')) {
      if (seen.has(`f${n}`)) continue
      seen.add(`f${n}`)
      const f = ctx.lookup(fonts?.get(PDFName.of(n)))
      if (f instanceof PDFDict && !f.has(PDFName.of('Resources'))) texts.push(glyphText(ctx, f))
    }
    for (const t of texts) {
      if (t === undefined) continue
      if (t === null) { if (strict) throw new ToolError(UNREADABLE, 'pdf_invalid'); continue }
      text += '\n' + t
      more = true
    }
  }
  const own = res.clone(ctx)
  for (const [key, value] of res.entries()) {
    const dict = ctx.lookup(value)
    if (!(dict instanceof PDFDict)) continue
    const names = namesUsed(text, key.decodeText())
    const kept = PDFDict.withContext(ctx)
    // pdf-lib reads a name as written (`I#6d1`) and would write its # as #23: the name is decoded here, so it is
    // compared, and written again, as the name it is (`Im1`)
    for (const [name, v] of dict.entries()) { const n = nameOf(name.decodeText()); if (names.has(n)) kept.set(PDFName.of(n), v) }
    own.set(key, kept)
  }
  return own
}

/**
 * Give each of these pages its own /Resources whose lists hold only the names its content streams use, before the
 * pages are copied into a new document: a /Resources shared by many pages (on the page tree, common in scanner and
 * generator output) would otherwise carry a removed page's pictures into the result (review of feat/edit-pdf). The
 * same for everything the page then still reaches that draws with a /Resources of its own (forms, tiling patterns,
 * soft masks, annotation appearances, Type 3 fonts): a generator may point those at the shared list too.
 *
 * A /Contents that is no stream (null, a reference to nothing) draws nothing and uses nothing (TC-3793: such a page
 * used to keep the whole shared list). A stream that cannot be decoded: with `strict` (pages are being taken out) the
 * job is refused, since nobody can say what the page uses; else its resources stay as they are.
 */
export function pruneResources(doc: PDFDocument, indices: number[], strict = true) {
  const ctx = doc.context
  const walked = new Set<PDFObject>()
  for (const i of new Set(indices)) {
    const node = doc.getPage(i).node
    const ref = node.get(PDFName.of('Contents'))
    const c = ref === undefined ? undefined : ctx.lookup(ref)
    const texts = (c instanceof PDFArray ? c.asArray().map((x) => ctx.lookup(x)) : [c]).map(contentText)
    const todo: (PDFObject | undefined)[] = []
    if (texts.includes(null)) {
      if (strict) throw new ToolError(UNREADABLE, 'pdf_invalid')
      todo.push(node.Resources())
    } else {
      const res = node.Resources()
      if (res) {
        const own = cutResources(ctx, res, texts.join('\n'), strict)
        node.set(PDFName.of('Resources'), own)
        todo.push(own)
      }
    }
    // everything the page still reaches (through any of its keys), other pages apart
    todo.push(...node.values())
    while (todo.length) {
      let o = todo.pop()
      if (o instanceof PDFRef) o = ctx.lookup(o)
      if (!o || walked.has(o) || o instanceof PDFPageLeaf || o instanceof PDFPageTree) continue
      walked.add(o)
      if (o instanceof PDFArray) todo.push(...o.asArray())
      else if (o instanceof PDFDict) {
        // a Type 3 font: its glyphs draw with its /Resources
        const res = ctx.lookup(o.get(PDFName.of('Resources')))
        const t = res instanceof PDFDict && !cutDicts.has(o) ? glyphText(ctx, o) : undefined
        if (t === null) { if (strict) throw new ToolError(UNREADABLE, 'pdf_invalid') } else if (t !== undefined) {
          o.set(PDFName.of('Resources'), cutResources(ctx, res as PDFDict, t, strict))
          cutDicts.add(o)
        }
        todo.push(...o.values())
      } else if (o instanceof PDFStream) {
        const res = ctx.lookup(o.dict.get(PDFName.of('Resources')))
        if (res instanceof PDFDict && !cut.has(o)) {
          const t = contentText(o)
          if (t === null) { if (strict) throw new ToolError(UNREADABLE, 'pdf_invalid') } else {
            o.dict.set(PDFName.of('Resources'), cutResources(ctx, res, t, strict))
            cut.add(o)
          }
        }
        todo.push(...o.dict.values())
      }
    }
  }
}

/**
 * Copies of these pages of `src` for `out` (to add or insert there). As pdf-lib's copyPages, but the copier is told
 * first where each of these pages goes: pdf-lib 1.17.1 does not remember a page it copied, so a link from one copied
 * page to another (and every annotation's /P, its own page) made a second, unseen copy of that page in the file, and
 * the link led to the copy (`traversedObjects` is a private field of that pinned version; checked by
 * tests/unit/pdf-pages-removed-content.test.ts, "page 3's link still leads to page 1").
 */
async function copiesOf(out: PDFDocument, src: PDFDocument, indices: number[]): Promise<PDFPage[]> {
  await src.flush()
  const copier = PDFObjectCopier.for(src.context, out.context)
  const seen = (copier as unknown as { traversedObjects: Map<PDFObject, PDFObject> }).traversedObjects
  const pages = indices.map((i) => src.getPage(i))
  const refs = pages.map((p) => { const r = (seen.get(p.ref) as PDFRef | undefined) ?? out.context.nextRef(); seen.set(p.ref, r); return r })
  return pages.map((p, k) => {
    const copied = copier.copy(p.node)
    out.context.assign(refs[k]!, copied)
    return PDFPage.of(copied, refs[k]!, out)
  })
}

/**
 * The document's pages become these of its pages (1-based), in this order. The page objects themselves are moved, not
 * copied, so links between them go on leading to them. What a page took from its place in the page tree (/Resources,
 * /MediaBox, /CropBox, /Rotate) is written onto it first.
 */
function arrange(doc: PDFDocument, pages: number[]) {
  const keep = pages.map((p) => doc.getPage(p - 1))
  for (const page of keep) {
    for (const k of PDFPageLeaf.InheritableEntries) {
      const key = PDFName.of(k)
      const v = page.node.getInheritableAttribute(key)
      if (!page.node.get(key) && v) page.node.set(key, v)
    }
  }
  for (let p = doc.getPageCount() - 1; p >= 0; p--) removePage(doc, p)
  for (const page of keep) doc.addPage(page)
}

const isType = (o: PDFObject | undefined, type: string): o is PDFDict => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of(type)

/**
 * After pages were copied into the new document `out`, and before it is saved: nothing of a page that is not one of
 * its pages stays. pdf-lib copies everything a page points at, so a link to a removed page, or a form field with
 * another part on a removed page, brought that whole page along (its text, pictures, notes, thumbnail), unseen but in
 * the file. Here:
 *  - a page object that is not in `out`'s page tree is cut loose, with its annotations and form-field parts;
 *  - a link on a kept page that led there is removed (it would lead nowhere); article threads (/B) are removed;
 *  - a form field left without any part is removed, up the field tree;
 *  - then every object that `out`'s own pages no longer reach is deleted, so save (always a full rewrite, never an
 *    appended update) writes only what the kept pages use.
 */
export function dropUnreachable(out: PDFDocument) {
  const ctx = out.context
  const K = (k: string) => PDFName.of(k)
  const treeRef = out.catalog.get(K('Pages'))
  const inTree = new Set<PDFObject | undefined>([treeRef])
  out.catalog.Pages().traverse((_, ref) => { inTree.add(ref) })
  const all = () => ctx.enumerateIndirectObjects()
  const dictOf = (o: PDFObject | undefined) => (o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : undefined)
  const annotsOf = (page: PDFDict) => { const a = ctx.lookup(page.get(K('Annots'))); return a instanceof PDFArray ? a.asArray() : [] }

  const strayPages = new Set<PDFObject>()
  const keptAnnots = new Set<PDFObject>()
  for (const [ref, o] of all()) {
    if (!(o instanceof PDFPageLeaf || o instanceof PDFPageTree || isType(o, 'Page') || isType(o, 'Pages'))) continue
    if (!inTree.has(ref)) strayPages.add(ref)
    else if (ref !== treeRef) {
      // threads and document parts are trees over the whole document
      o.delete(K('B')); o.delete(K('DPart'))
      for (const a of annotsOf(o)) {
        keptAnnots.add(a)
        const popup = dictOf(ctx.lookup(a))?.get(K('Popup'))
        if (popup) keptAnnots.add(popup)
      }
    }
  }
  /** what is cut loose: the stray pages and what belongs to them */
  const dead = new Set<PDFObject>(strayPages)
  for (const p of strayPages) for (const a of annotsOf(ctx.lookup(p) as PDFDict)) if (!keptAnnots.has(a)) dead.add(a)
  // and every annotation (a note, a link, a form-field part: something with a /Rect) that is on none of the kept
  // pages: /P is optional, so one of a removed page can arrive through a form field's /Kids or a note's /IRT with no
  // sign of its page (review of this change: a removed page's field value stayed that way)
  for (const [ref, o] of all()) {
    const d = dictOf(o)
    if (!d || keptAnnots.has(ref) || inTree.has(ref) || o instanceof PDFStream) continue
    if (strayPages.has(d.get(K('P'))!) || (d.has(K('Rect')) && (d.get(K('Type')) === K('Annot') || d.has(K('Subtype'))))) dead.add(ref)
  }
  // a link (or another annotation with an action) on a kept page that goes to a stray page
  const goes = (dest: PDFObject | undefined, depth = 0): boolean => {
    const d = ctx.lookup(dest)
    return d instanceof PDFArray ? strayPages.has(d.get(0)) : d instanceof PDFDict && depth < 8 ? goes(d.get(K('D')), depth + 1) : false
  }
  for (const a of keptAnnots) {
    const d = dictOf(ctx.lookup(a))
    if (!d) continue
    const act = ctx.lookup(d.get(K('A')))
    if (goes(d.get(K('Dest'))) || (act instanceof PDFDict && goes(act.get(K('D'))))) dead.add(a)
  }

  /** take every reference to something dead out of every object: a list loses the entry (a destination array keeps
   * its shape with null), a dictionary loses the key */
  const unlink = (o: PDFObject | undefined, seen: Set<PDFObject>) => {
    if (!o || seen.has(o)) return
    seen.add(o)
    if (o instanceof PDFArray) {
      for (let i = o.size() - 1; i >= 0; i--) {
        const v = o.get(i)
        if (strayPages.has(v)) o.set(i, PDFNull)
        else if (dead.has(v)) o.remove(i)
        else unlink(v, seen)
      }
    } else {
      const d = dictOf(o)
      if (!d) return
      // a structure destination and a thread action lead into trees over the whole document
      d.delete(K('SD'))
      if (d.get(K('S')) === K('Thread')) { d.delete(K('D')); d.delete(K('B')) }
      for (const [k, v] of d.entries()) { if (dead.has(v)) d.delete(k); else unlink(v, seen) }
    }
  }
  for (;;) {
    const seen = new Set<PDFObject>()
    for (const [ref, o] of all()) if (!dead.has(ref)) unlink(o, seen)
    // a form field whose parts are all gone
    let more = false
    for (const [ref, o] of all()) {
      if (dead.has(ref) || inTree.has(ref) || !(o instanceof PDFDict)) continue
      const kids = ctx.lookup(o.get(K('Kids')))
      if (kids instanceof PDFArray && kids.size() === 0 && (o.has(K('T')) || o.has(K('Parent')) || o.has(K('FT')))) { dead.add(ref); more = true }
    }
    if (!more) break
  }

  // what the document still reaches, from its trailer; the rest is not written
  const live = new Set<PDFObject>()
  const todo: (PDFObject | undefined)[] = Object.values(ctx.trailerInfo)
  while (todo.length) {
    const o = todo.pop()
    if (!o || live.has(o)) continue
    live.add(o)
    if (o instanceof PDFRef) todo.push(ctx.lookup(o))
    else if (o instanceof PDFArray) todo.push(...o.asArray())
    else if (o instanceof PDFDict) todo.push(...o.values())
    else if (o instanceof PDFStream) todo.push(...o.dict.values())
  }
  for (const [ref] of all()) if (!live.has(ref)) ctx.delete(ref)
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
    // the form fields' appearances are written by fill_form with the right font; pdf-lib's own pass at save would
    // write Helvetica ones, which cannot hold letters that are not Latin
    const b = await d.save({ updateFieldAppearances: false })
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
      pruneResources(src, pages.map((x) => x - 1), pages.length < src.getPageCount())
      for (const p of await copiesOf(out, src, pages.map((x) => x - 1))) out.addPage(p)
    }
    dropUnreachable(out)
    return finish([{ bytes: await save(out), pages: out.getPageCount() }], signed)
  }

  const main = parts[0]!
  const doc = await open(main, name(0))
  // a signature in any of the PDFs used (an inserted one too) no longer holds
  const signed = parts.some((b) => has(b, '/ByteRange'))

  if (job.kind === 'count' || job.kind === 'fields') {
    // the count in the report, and a one-page PDF as the file (the answer always carries one)
    const one = await PDFDocument.create()
    one.addPage([10, 10])
    const report: PagesReport = { files: [{ pages: doc.getPageCount(), length: 0 }], notes, signed }
    if (job.kind === 'fields') report.form = formReport(doc)
    const b = await one.save()
    report.files[0]!.length = b.length
    return encodeHwpxRequest(JSON.stringify(report), b)
  }

  if (job.kind === 'split') {
    if (!job.parts.length || job.parts.length > PDF_PAGES_PARTS_MAX) throw new ToolError(`give 1 to ${PDF_PAGES_PARTS_MAX} parts; nothing was saved`)
    const files: { bytes: Uint8Array; pages: number }[] = []
    for (const spec of job.parts) {
      const pages = parsePages(spec, doc.getPageCount())
      pruneResources(doc, pages.map((x) => x - 1), pages.length < doc.getPageCount())
      const part = await PDFDocument.create()
      for (const p of await copiesOf(part, doc, pages.map((x) => x - 1))) part.addPage(p)
      dropUnreachable(part)
      files.push({ bytes: await save(part), pages: part.getPageCount() })
    }
    return finish(files, signed)
  }

  // edit: the operations in order, on one document
  /** pages were taken out (remove, keep, reorder): the result is built fresh, see below */
  let dropped = false
  /** pages were left out (remove, a keep that is not every page): a page that cannot be read then stops the job */
  let leftOut = false
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
  // replace_text: a standard font close to the PDF's own for Latin letters, else the server's font
  const standard = new Map<StandardFonts, PDFFont>()
  const fallback: FallbackFont = async (text: string, style: FontStyle) => {
    if (!winAnsiCan(text)) return fontFor(text)
    const name = standardFont(style)
    let f = standard.get(name)
    if (!f) { f = await doc.embedFont(name); standard.set(name, f) }
    return f
  }
  /** the page text was rewritten: the old content streams are dropped before saving */
  let rewrote = false
  for (const [i, op] of job.ops.entries()) {
    const n = doc.getPageCount()
    const step = `operation ${i + 1}`
    try {
      if ('remove_pages' in op) {
        dropped = leftOut = true
        const pages = parsePages(op.remove_pages, n)
        if (pages.length >= n) throw new ToolError('that would remove every page; a PDF needs at least one page')
        for (const p of [...pages].sort((a, b) => b - a)) removePage(doc, p - 1)
      } else if ('keep_pages' in op) {
        dropped = true
        const pages = parsePages(op.keep_pages, n)
        if (pages.length < n) leftOut = true
        arrange(doc, pages)
      } else if ('reorder_pages' in op) {
        dropped = true
        const pages = parsePages(op.reorder_pages, n)
        if (pages.length !== n) throw new ToolError(`reorder_pages lists every page once (the PDF has ${n}); to leave pages out, use keep_pages or remove_pages`)
        arrange(doc, pages)
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
        // only some of its pages: the others' content must not come along (the result is then built fresh, see below)
        const some = pages.length < other.getPageCount()
        if (some) dropped = leftOut = true
        pruneResources(other, pages.map((x) => x - 1), some)
        const copies = await copiesOf(doc, other, pages.map((x) => x - 1))
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
          // a form field there is drawn on top of the page and hides the text, and the field stays empty (TC-5513)
          const under = fieldBoxesOnPage(doc, p - 1).find((b) => u < b.u + b.w - 0.5 && u + tw > b.u + 0.5 && v - size * 0.75 < b.v + b.h - 0.5 && v + size * 0.25 > b.v + 0.5)
          if (under) throw new ToolError(`the text would sit under the form field "${under.name}" on page ${p}, which is drawn on top of the page and hides it. Fill the form's fields with fill_form (read the PDF to see their names), or place the text outside the fields`)
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
      } else if ('replace_text' in op) {
        const rt = op.replace_text
        if (!rt.find.trim()) throw new ToolError('give the words to find')
        if (/[\r\n]/.test(rt.replace)) throw new ToolError('the new words are one line; replace each line with its own replace_text')
        const pages = parsePages(rt.pages ?? 'all', n)
        // fonts that earlier operations (add_text, an earlier replace_text) wrote with are put into the file first, so
        // their words can be read and found too
        await doc.flush()
        const outcome: Parameters<typeof replaceOnPage>[6] = { replaced: 0, hidden: 0, skipped: [], smaller: 0, overlap: 0, wider: 0, fonts: new Set(), actualText: 0, caveats: { forms: new Set(), annots: new Set(), unmapped: new Set() }, noMatch: new Map(), parsedBytes: 0, pagesWithout: { images: [], forms: [], noText: [], noMap: [] } }
        const changed: number[] = []
        for (const p of pages) {
          const before = outcome.replaced
          if (await replaceOnPage(doc, p - 1, rt.find, rt.replace, rt.match_case ?? true, fallback, outcome)) rewrote = true
          if (outcome.replaced > before) changed.push(p)
        }
        if (!outcome.replaced) throw new ToolError(notFound(rt.find, pages, outcome))
        notes.push(replacedNote(step, rt.find, changed, outcome, wordsElsewhere(doc, rt.find, rt.match_case ?? true, pages.map((x) => x - 1))))
      } else if ('fill_form' in op) {
        const ff = op.fill_form
        if (job.ops.some((o) => 'remove_pages' in o || 'keep_pages' in o || 'reorder_pages' in o || ('insert_pdf' in o)) && !ff.flatten) throw new ToolError('a form keeps its fields only when no pages are removed, kept, reordered or inserted in the same call; fill it in its own edit_pdf call, or give flatten: true')
        const r = await fillForm(doc, ff.fields, ff.flatten === true, fontFor, (page) => wrapOnce(doc, page))
        const list = (xs: string[]) => xs.slice(0, 60).map((x) => JSON.stringify(x)).join(', ') + (xs.length > 60 ? ` … and ${xs.length - 60} more` : '')
        notes.push(`${step} (fill_form): set the form field${r.set.length === 1 ? '' : 's'} ${r.set.length ? list(r.set) : '(none)'}${r.flattened ? '; the form was then flattened: the values are now part of the pages and can no longer be changed in a PDF reader' : '; the values are in the form fields themselves, so they show in every PDF viewer and can still be changed there'}.` +
          (r.empty.length ? ` Still empty: ${list(r.empty)}.` : '') + (r.xfa ? ' The PDF also held an Adobe XFA form, which was removed so that viewers show these fields.' : ''))
      } else throw new ToolError('an unknown operation')
    } catch (e) {
      if (e instanceof ToolError) throw new ToolError(`${step}: ${e.message.replace(/; nothing was saved$|\. Nothing was saved$/, '')}; nothing was saved`, e.code)
      throw e
    }
  }
  // pdf-lib's save writes every object the document holds, so a removed page's content would still be inside the file
  // (review of feat/edit-pdf: "remove the salary page" left its text in the result). After a removal the final pages
  // are copied into a new document, and what they do not use is taken out of it (pruneResources before the copy,
  // dropUnreachable after). Its outline, named destinations, attachments and form (AcroForm) are not carried over.
  if (standard.size) {
    // the standard fonts get their widths written, so every viewer places the words after them where they were
    // measured (a viewer that draws Helvetica with its own font otherwise uses that font's widths)
    await doc.flush()
    for (const [name, f] of standard) writeStandardWidths(doc.context, f.ref, name)
  }
  if (rewrote && !dropped) dropUnreached(doc)
  if (dropped) {
    const fresh = await PDFDocument.create()
    pruneResources(doc, doc.getPageIndices(), leftOut)
    for (const p of await copiesOf(fresh, doc, doc.getPageIndices())) fresh.addPage(p)
    dropUnreachable(fresh)
    return finish([{ bytes: await save(fresh), pages: fresh.getPageCount() }], signed)
  }
  return finish([{ bytes: await save(doc), pages: doc.getPageCount() }], signed)
}

// ---------------------------------------------------------------- replace_text's words

/** the standard font closest to a font's look */
function standardFont(s: FontStyle): StandardFonts {
  const F = StandardFonts
  if (s.family === 'serif') return s.bold && s.italic ? F.TimesRomanBoldItalic : s.bold ? F.TimesRomanBold : s.italic ? F.TimesRomanItalic : F.TimesRoman
  if (s.family === 'mono') return s.bold && s.italic ? F.CourierBoldOblique : s.bold ? F.CourierBold : s.italic ? F.CourierOblique : F.Courier
  return s.bold && s.italic ? F.HelveticaBoldOblique : s.bold ? F.HelveticaBold : s.italic ? F.HelveticaOblique : F.Helvetica
}
const pageList = (ps: number[]) => `page${ps.length === 1 ? '' : 's'} ${ps.join(', ')}`
const places = (k: number) => `${k} place${k === 1 ? '' : 's'}`
const quoted = (s: string) => JSON.stringify(s.length > 80 ? s.slice(0, 80) + '…' : s)

/** why nothing was changed, in plain words */
function notFound(find: string, pages: number[], o: ReplaceOutcome & { pagesWithout: { images: number[]; forms: number[]; noText: number[]; noMap: number[] } }): string {
  const w = o.pagesWithout
  const why: string[] = []
  if (o.hidden) why.push(`${quoted(find)} is only in the hidden text layer of a scanned page (${places(o.hidden)}): the page itself is a picture, so changing that layer would not change what the page shows, and the words in the picture cannot be removed or changed here`)
  if (w.images.length) why.push(`${pageList(w.images)} ${w.images.length === 1 ? 'is a picture' : 'are pictures'} (a scan or a photo) with no text in ${w.images.length === 1 ? 'it' : 'them'}; words that are part of a picture cannot be removed or changed here`)
  if (w.noMap.length) why.push(`${pageList(w.noMap)} ${w.noMap.length === 1 ? 'uses' : 'use'} a font that does not say which letters it draws, so its words cannot be found`)
  if (w.forms.length) why.push(`${pageList(w.forms)} ${w.forms.length === 1 ? 'draws' : 'draw'} part of ${w.forms.length === 1 ? 'its' : 'their'} content as a drawn block, which this tool does not change; the words may be there`)
  if (o.skipped.length) why.push(`${quoted(find)} was found but left as it is: it is ${[...new Set(o.skipped)].join(', ')}, which this tool cannot change`)
  if (!why.length) why.push(`${quoted(find)} was not found as text on ${pageList(pages.length > 20 ? [...pages.slice(0, 20)] : pages)}${pages.length > 20 ? ' …' : ''}; read the page to see how the words are written (spelling, spaces, upper and lower case)`)
  return why.join('. ')
}

/** what was changed, for the AI */
function replacedNote(step: string, find: string, changed: number[], o: ReplaceOutcome, elsewhere: string[]): string {
  const out = [`${step} (replace_text): changed ${places(o.replaced)} of ${quoted(find)} on ${pageList(changed)}; the old words are removed from the page text there, not covered.`]
  if (o.actualText) out.push(`The accessibility text (/ActualText) around ${o.actualText === 1 ? 'one of them was' : `${o.actualText} of them was`} removed too.`)
  // not a redaction tool: what it does not change is named, so the AI can say so (review of #1337)
  const c = o.caveats
  const parts = [
    c.forms.size ? `drawn blocks (form XObjects) on ${pageList([...c.forms])}` : '',
    c.annots.size ? `comments, links or form fields on ${pageList([...c.annots])}` : '',
    c.unmapped.size ? `text in fonts without a letter map on ${pageList([...c.unmapped])} (a viewer may read those letters differently, so a match there can be missed)` : '',
  ].filter(Boolean)
  if (parts.length) out.push(`Not changed by this tool: ${parts.join('; ')}.`)
  if (elsewhere.length) out.push(`${quoted(find)} is still in the file in: ${elsewhere.join(', ')}. This tool changes only page text; tell the user it is not a redaction tool and these places still hold the old words.`)
  const other = [...o.fonts].filter((f) => f !== 'the original')
  if (other.length) out.push(`The PDF's own font has no letters for some of the new words, so those are written in ${other.join(', ')}.`)
  if (o.fonts.size) out.push('The words after the new ones on the same line moved along with them; other lines did not change.')
  if (o.smaller) out.push(`${places(o.smaller)} ${o.smaller === 1 ? 'was' : 'were'} written a little smaller so that the line does not reach the next column or the page's edge.`)
  if (o.overlap) out.push(`${places(o.overlap)} ${o.overlap === 1 ? 'is' : 'are'} too long for ${o.overlap === 1 ? 'its' : 'their'} space and now ${o.overlap === 1 ? 'reaches' : 'reach'} the next column (a table cell's line, the next field) or the page's edge; look at the page, tell the user, and offer shorter words.`)
  if (o.wider) out.push(`${places(o.wider)} made ${o.wider === 1 ? 'its line' : 'their lines'} longer than the other lines of the text (into the right margin); a paragraph is not re-wrapped. Look at the page and tell the user.`)
  if (o.hidden) out.push(`${places(o.hidden)} in the hidden text layer of a scanned page ${o.hidden === 1 ? 'was' : 'were'} left as ${o.hidden === 1 ? 'it was' : 'they were'}: the page is a picture, and the words in it cannot be changed here. Tell the user.`)
  if (o.skipped.length) out.push(`${places(o.skipped.length)} ${o.skipped.length === 1 ? 'was' : 'were'} left as ${o.skipped.length === 1 ? 'it was' : 'they were'} (${[...new Set(o.skipped)].join(', ')}).`)
  return out.join(' ')
}
