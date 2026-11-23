// stamp_pdf's worker part (tools/stamp-pdf.ts): an image (a seal, a signature, a logo) drawn on one page of an existing
// PDF with pdf-lib (MIT), the rest of the document kept. pdf-lib parses an untrusted PDF and decodes an untrusted PNG
// in memory, so it parses only in the office worker (files/office-worker.ts, mode `pdf-stamp`), never in the server
// process: office-parse.ts calls stampPdfRequest there (the server process loads the module but runs only the header
// helpers and the result decoding). The server sends one request (encodeStampRequest: the JSON
// options, then the PDF's bytes, then the image's) and gets the new PDF and a report back (decodeStampResult).
//
// Where the image goes is said as the page is shown: from its top-left corner, in mm, in the page's visible box (the
// CropBox, else the MediaBox) and with its /Rotate applied, so "bottom-right" is the bottom-right a reader sees. The
// page's own drawing is wrapped in q … Q first, so a page that leaves its coordinates changed cannot move the image.
import { degrees, PDFDocument, popGraphicsState, pushGraphicsState, type PDFPage } from 'pdf-lib'
import { ToolError } from '../policy/errors'
import { decodeHwpxRequest, encodeHwpxRequest } from './hwpx-check'

export const PDF_STAMP_MODE = 'pdf-stamp'
/** the largest PDF stamp_pdf takes, and the largest image */
// (the PDF tools' limit, pdf-pages.ts PDF_PAGES_INPUT_MAX; the stamped PDF comes back under PDF_OUTPUT_MAX)
export const STAMP_PDF_MAX = 100 * 1024 * 1024
export const STAMP_IMAGE_MAX = 10 * 1024 * 1024
/** the longest side of an image in pixels (a PNG is decoded whole: 8000 x 8000 x 4 bytes is 256 MB) */
export const STAMP_IMAGE_SIDE_MAX = 8000
export const STAMP_DEFAULT_WIDTH_MM = 30
export const STAMP_DEFAULT_MARGIN_MM = 15

export type StampPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | { x_mm: number; y_mm: number }
export interface StampOptions { page: number | 'last'; position: StampPosition; width_mm: number; margin_mm: number; image: 'png' | 'jpg'; pdfLength: number }
export interface StampReport {
  pages: number
  page: number
  /** the page as it is shown, in mm */
  pageMm: { width: number; height: number }
  /** where the image went, in mm from the top-left of the page as it is shown */
  rectMm: { x: number; y: number; width: number; height: number }
  /** the document had a digital signature, which no longer matches after the change */
  signed: boolean
}

export const mmToPt = (mm: number) => (mm * 72) / 25.4
export const ptToMm = (pt: number) => (pt * 25.4) / 72
const round1 = (n: number) => Math.round(n * 10) / 10

/** The part of the page a reader sees: the CropBox within the MediaBox. A CropBox reaching past the MediaBox shows only
 * their overlap, so measuring from the CropBox alone put a picture off by the difference. */
export function visibleBox(page: PDFPage): { x: number; y: number; width: number; height: number } {
  const c = page.getCropBox(), m = page.getMediaBox()
  const x = Math.max(c.x, m.x), y = Math.max(c.y, m.y)
  const width = Math.min(c.x + c.width, m.x + m.width) - x, height = Math.min(c.y + c.height, m.y + m.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : m
}

/** What kind of image the bytes are (by their first bytes, never the name): png, jpg, or null. */
export function imageKind(b: Uint8Array): 'png' | 'jpg' | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  return null
}

/** An image's size in pixels from its header (PNG IHDR, JPEG SOF), or null when the header cannot be read. */
export function imageSize(b: Uint8Array, kind: 'png' | 'jpg'): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (kind === 'png') {
    // 8-byte signature, then the IHDR chunk: length, "IHDR", width, height
    if (b.length < 24 || String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return null
    return { width: v.getUint32(16), height: v.getUint32(20) }
  }
  for (let p = 2; p + 9 < b.length;) {
    if (b[p] !== 0xff) return null
    const m = b[p + 1]!
    if (m === 0xff) { p++; continue }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { p += 2; continue }
    const len = v.getUint16(p + 2)
    if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: v.getUint16(p + 5), width: v.getUint16(p + 7) }
    if (len < 2) return null
    p += 2 + len
  }
  return null
}

/**
 * Where the image goes on the page as it is shown (points from its top-left): a preset keeps `margin` to the edges,
 * { x_mm, y_mm } is the image's top-left corner. The page is `w` x `h` points as shown, the image `iw` x `ih`.
 */
export function shownRect(position: StampPosition, w: number, h: number, iw: number, ih: number, marginMm: number): { u: number; v: number } {
  const m = mmToPt(marginMm)
  if (typeof position === 'object') return { u: mmToPt(position.x_mm), v: mmToPt(position.y_mm) }
  switch (position) {
    case 'top-left': return { u: m, v: m }
    case 'top-right': return { u: w - m - iw, v: m }
    case 'bottom-left': return { u: m, v: h - m - ih }
    case 'bottom-right': return { u: w - m - iw, v: h - m - ih }
    case 'center': return { u: (w - iw) / 2, v: (h - ih) / 2 }
  }
}

/**
 * The drawImage arguments (PDF user space) that show an image upright at (`u`, `v`) from the top-left of the page as
 * shown, `iw` x `ih` points. `box`: the page's visible box in user space; `rotation`: its /Rotate (0, 90, 180, 270,
 * clockwise when shown). The image is turned by the same angle counter-clockwise, so it reads upright on screen.
 */
export function placeOnPage(box: { x: number; y: number; width: number; height: number }, rotation: number, u: number, v: number, iw: number, ih: number): { x: number; y: number; width: number; height: number; rotate: number } {
  const r = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360
  const W = box.width, H = box.height
  // the image's bottom-left corner as shown (u, v + ih), back in user space relative to the box
  const bu = u, bv = v + ih
  let px: number, py: number
  if (r === 0) { px = bu; py = H - bv }
  else if (r === 90) { px = bv; py = bu }
  else if (r === 180) { px = W - bu; py = bv }
  else { px = W - bv; py = H - bu }
  return { x: box.x + px, y: box.y + py, width: iw, height: ih, rotate: r }
}

/** The request the server sends the worker: the options as JSON, then the PDF, then the image. */
export function encodeStampRequest(o: Omit<StampOptions, 'pdfLength'>, pdf: Uint8Array, image: Uint8Array): Uint8Array {
  const body = new Uint8Array(pdf.length + image.length)
  body.set(pdf, 0)
  body.set(image, pdf.length)
  return encodeHwpxRequest(JSON.stringify({ ...o, pdfLength: pdf.length }), body)
}

export function decodeStampResult(b: Uint8Array): { report: StampReport; file: Uint8Array } {
  const r = decodeHwpxRequest(b)
  if (!r.template) throw new Error('bad result')
  const report = JSON.parse(r.astJson) as StampReport
  if (typeof report?.pages !== 'number' || typeof report.page !== 'number' || !report.rectMm || !report.pageMm) throw new Error('bad result')
  return { report, file: r.template }
}

const has = (b: Uint8Array, s: string) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(s, 0, 'latin1')

/** The worker's mode `pdf-stamp`: the request in, the new PDF and its report out (ToolError: a reason to tell the
 * person, nothing saved). */
export async function stampPdfRequest(input: Uint8Array): Promise<Uint8Array> {
  let o: StampOptions, pdf: Uint8Array, image: Uint8Array
  try {
    const r = decodeHwpxRequest(input)
    o = JSON.parse(r.astJson) as StampOptions
    if (!r.template || !Number.isInteger(o.pdfLength) || o.pdfLength <= 0 || o.pdfLength >= r.template.length) throw new Error('bad')
    // copies, never views into the request: pdf-lib's JPEG reader reads `bytes.buffer` from its start
    pdf = r.template.slice(0, o.pdfLength)
    image = r.template.slice(o.pdfLength)
  } catch { throw new ToolError('the PDF stamper got a damaged request; nothing was saved') }
  const kind = imageKind(image)
  if (!kind || kind !== o.image) throw new ToolError('the image is not a PNG or JPG file; nothing was saved')
  const px = imageSize(image, kind)
  if (!px || px.width < 1 || px.height < 1) throw new ToolError('the image could not be read (a damaged PNG or JPG); nothing was saved')
  if (Math.max(px.width, px.height) > STAMP_IMAGE_SIDE_MAX) throw new ToolError(`the image is ${px.width} x ${px.height} pixels, larger than ${STAMP_IMAGE_SIDE_MAX} pixels on a side; use a smaller picture. Nothing was saved`)

  let doc: PDFDocument
  // opened even when encrypted, only to tell a locked PDF from a broken one (pdf-lib's own EncryptedPDFError is not an
  // instanceof its class once compiled): a locked one is refused right after
  try { doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true }) } catch {
    throw new ToolError('the file could not be opened as a PDF (it is damaged or not a PDF); nothing was saved', 'pdf_invalid')
  }
  if (doc.isEncrypted) throw new ToolError('the PDF is locked with a password or protected against changes, so nothing can be put on it; nothing was saved', 'pdf_encrypted')
  const pages = doc.getPageCount()
  if (pages < 1) throw new ToolError('the PDF has no pages that can be read (it may be damaged); nothing was saved', 'pdf_invalid')
  const pageNo = o.page === 'last' ? pages : o.page
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > pages) throw new ToolError(`the PDF has ${pages} page${pages === 1 ? '' : 's'}, so there is no page ${o.page}; nothing was saved`)
  const page = doc.getPage(pageNo - 1)
  const box = visibleBox(page)
  const rot = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360
  const turned = rot === 90 || rot === 270
  const w = turned ? box.height : box.width
  const h = turned ? box.width : box.height

  let embedded
  try { embedded = kind === 'png' ? await doc.embedPng(image) : await doc.embedJpg(image) } catch {
    throw new ToolError('the image could not be read (a damaged PNG or JPG); nothing was saved')
  }
  const iw = mmToPt(o.width_mm)
  const ih = iw * (embedded.height / embedded.width)
  const { u, v } = shownRect(o.position, w, h, iw, ih, o.margin_mm)
  // a little give for rounding (0.5 pt is under 0.2 mm)
  const eps = 0.5
  if (u < -eps || v < -eps || u + iw > w + eps || v + ih > h + eps) {
    throw new ToolError(`the image would not fit on the page there: the page is ${round1(ptToMm(w))} x ${round1(ptToMm(h))} mm and the image ${round1(o.width_mm)} x ${round1(ptToMm(ih))} mm at ${round1(ptToMm(u))} mm from the left and ${round1(ptToMm(v))} mm from the top. Give a smaller width_mm, a smaller margin_mm or another position; nothing was saved`)
  }
  // the page's own drawing in q … Q, so coordinates it leaves changed do not move the image
  page.node.normalize()
  const ctx = doc.context
  page.node.wrapContentStreams(ctx.register(ctx.contentStream([pushGraphicsState()])), ctx.register(ctx.contentStream([popGraphicsState()])))
  const at = placeOnPage(box, rot, u, v, iw, ih)
  page.drawImage(embedded, { x: at.x, y: at.y, width: at.width, height: at.height, rotate: degrees(at.rotate) })
  const out = await doc.save()
  // read back: the result must open again with the same pages
  try {
    const again = await PDFDocument.load(out, { updateMetadata: false })
    if (again.getPageCount() !== pages) throw new Error('pages')
  } catch { throw new ToolError('the stamped PDF did not read back as expected; nothing was saved') }
  const report: StampReport = {
    pages, page: pageNo,
    pageMm: { width: round1(ptToMm(w)), height: round1(ptToMm(h)) },
    rectMm: { x: round1(ptToMm(u)), y: round1(ptToMm(v)), width: round1(o.width_mm), height: round1(ptToMm(ih)) },
    signed: has(pdf, '/ByteRange'),
  }
  return encodeHwpxRequest(JSON.stringify(report), out)
}
