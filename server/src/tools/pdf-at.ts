// stamp_pdf `at`: a seal or signature on the printed mark of a PDF (docs/decisions/20261123-signing-slots.md). The place is
// proved before anything is made and checked on what would be saved, by what the page really shows: pdftotext gives the words
// and their boxes, the office worker finds the mark and reads how the page draws it (files/pdf-marks-worker.ts), pdftoppm draws
// the page. All of them read the untrusted PDF isolated, with a clock, a memory cap and an output cap. Anything not proved is
// refused, nothing is saved, and for the rest of the turn no picture goes on any PDF by coordinates, so a refusal cannot be
// stepped around. The names come from the PDF's text layer: a file can state there something other than it draws.
import { which } from '../config'
import { decodeStampResult, encodeStampRequest, imageSize, mmToPt, PDF_STAMP_MODE, ptToMm, STAMP_DEFAULT_MARGIN_MM } from '../files/pdf-stamp'
import { officeWorkerWrite } from '../files/extract'
import { changed, glyphShows, MM_PER_PT, parsePpm, pixelsOf, probePng, type PBox, type Pixels, type PdfTarget } from '../files/pdf-marks'
import { decodeMarksResult, encodeMarksRequest, PDF_MARKS_MODE, type MarkGlyph } from '../files/pdf-marks-worker'
import { PDF_OUTPUT_MAX } from '../files/pdf-pages'
import type { ToolCtx } from '../files/service'
import { SEAL_TOLERANCE_MM } from '../files/sign-slots'
import { sha256 } from '../files/store'
import { CONVERT_RSS_MIB, imageSlot } from '../files/vision'
import { ToolError } from '../policy/errors'
import { runIsolated } from './isolate'

/** a seal's width on a mark when none is given */
const SEAL_WIDTH_MM = 15
const TOOL_MS = 45_000
const TEXT_OUT_MAX = 6 * 1024 * 1024
/** the page drawn to check the place: at most this many pixels at 150 dpi (an A2 page) */
const PAGE_PIXELS_MAX = 11_000_000
/** the whole document drawn small, to see that no other page changed */
const OVERVIEW_DPI = 24, OVERVIEW_PAGES_MAX = 60, OVERVIEW_PIXELS_MAX = 8_000_000
/** of the picture's area that must really show where it is put */
const VISIBLE_SHARE = 0.9

export interface PdfLanding { on: string; mm: number }
export interface PdfPlan {
  page: number; position: { x_mm: number; y_mm: number }; width_mm: number
  target: PdfTarget; xml: Uint8Array; before: Pixels; overview: Buffer[]; probe: PBox; mm: number
}

/** After a refused `at`, a picture on any PDF by coordinates in the same turn: refused. */
export function assertNoStampAfterRefusal(c: ToolCtx): void {
  if (c.files.signRefused) throw new ToolError('a signing place could not be proved earlier in this answer, so no picture goes on a PDF by coordinates in this answer, on this file or one made from it; ask the person which place. Nothing was saved', 'sign_place')
}

const refuse = (c: ToolCtx, why: string): never => {
  c.files.signRefused = true
  throw new ToolError(`${why}. Nothing was saved. Do not work out coordinates to get around this: ask the person which place`, 'sign_place')
}

async function tool(c: ToolCtx, pdf: Uint8Array, name: 'pdftotext' | 'pdftoppm', args: string[], maxStdout: number): Promise<Buffer> {
  const bin = which(name)
  if (!bin) throw new ToolError(`finding a printed mark needs ${name}, which is not on this server; give position instead. Nothing was saved`)
  const r = await imageSlot(() => runIsolated({ cmd: bin, args, stdin: pdf, timeoutMs: TOOL_MS, maxRssMiB: CONVERT_RSS_MIB, signal: c.signal, maxStdout, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } }), c.signal)
  if (r.killed === 'aborted') c.signal?.throwIfAborted()
  if (r.killed || r.code !== 0) return refuse(c, 'this PDF is too large or complex to check its text and page')
  return r.stdout
}
const textOf = (c: ToolCtx, pdf: Uint8Array) => tool(c, pdf, 'pdftotext', ['-bbox-layout', '-cropbox', '-enc', 'UTF-8', '-', '-'], TEXT_OUT_MAX)
async function draw(c: ToolCtx, pdf: Uint8Array, page: number, w: number, h: number): Promise<Pixels> {
  const n = String(page + 1)
  const out = await tool(c, pdf, 'pdftoppm', ['-r', '150', '-f', n, '-l', n, '-cropbox', '-singlefile', '-'], Math.ceil(w * h) * 3 + 64)
  try { return parsePpm(out) } catch { return refuse(c, 'this PDF\'s page could not be drawn') }
}
/** every page drawn small, each page's picture on its own */
async function overview(c: ToolCtx, pdf: Uint8Array, pixels: number, pages: number): Promise<Buffer[]> {
  const out = await tool(c, pdf, 'pdftoppm', ['-r', String(OVERVIEW_DPI), '-cropbox', '-'], pixels * 3 + pages * 64)
  const list: Buffer[] = []
  for (let p = 0; p < out.length;) {
    const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(out.subarray(p, p + 40).toString('latin1'))
    if (!m) return refuse(c, 'this PDF\'s pages could not be drawn')
    const end = p + m[0].length + Number(m[1]) * Number(m[2]) * 3
    list.push(out.subarray(p, end))
    p = end
  }
  if (list.length !== pages) return refuse(c, 'this PDF\'s pages could not be drawn')
  return list
}

/** The one proved place, the page as it is, and where a solid picture of this size really shows there. */
export async function planPdfAt(c: ToolCtx, rel: string, pdf: Uint8Array, picture: Uint8Array, kind: 'png' | 'jpg', o: { at: string; occurrence?: number; page?: number | 'last'; width_mm?: number }): Promise<PdfPlan> {
  // what the AI names must be what it read: these very bytes
  if (c.files.readHashes.get(rel) !== sha256(pdf)) throw new ToolError(`read '${rel}' first (with read) before putting a picture at a printed mark; nothing was saved`, 'not_read')
  const px = imageSize(picture, kind)
  if (!px || px.width < 1 || px.height < 1) throw new ToolError('the image could not be read (a damaged PNG or JPG); nothing was saved')
  const xml = await textOf(c, pdf)
  const pageCount = (xml.toString('latin1').match(/<page /g) ?? []).length
  if (!pageCount) return refuse(c, 'this PDF has no pages with text to find a mark on')
  const only = o.page === undefined ? undefined : o.page === 'last' ? pageCount - 1 : o.page - 1
  if (only !== undefined && (only < 0 || only >= pageCount)) throw new ToolError(`the PDF has ${pageCount} page${pageCount === 1 ? '' : 's'}, so there is no page ${o.page}; nothing was saved`)
  const found = decodeMarksResult(await officeWorkerWrite(PDF_MARKS_MODE, encodeMarksRequest({ kind: 'resolve', at: o.at, page: only, occurrence: o.occurrence, xmlLength: xml.length }, xml, pdf), c.signal))
  if (found.kind === 'ask') return refuse(c, found.ask)
  if (found.kind !== 'resolved') return refuse(c, 'the place could not be checked')
  const t = found.target
  // sizes first: a tiny file can declare a page that takes gigabytes to draw
  const size = found.pages[t.page]!
  const full = Math.ceil(size.w * (150 / 72)) * Math.ceil(size.h * (150 / 72))
  const small = found.pages.reduce((n, p) => n + Math.ceil((p.w * OVERVIEW_DPI) / 72 + 1) * Math.ceil((p.h * OVERVIEW_DPI) / 72 + 1), 0)
  if (!(full > 0) || full > PAGE_PIXELS_MAX) return refuse(c, 'this page is too large to check where a picture lands on it')
  if (found.pages.length > OVERVIEW_PAGES_MAX || small > OVERVIEW_PIXELS_MAX) return refuse(c, `this PDF has too many or too large pages (at most ${OVERVIEW_PAGES_MAX}) to check that nothing else changes`)
  const before = await draw(c, pdf, t.page, Math.ceil(size.w * (150 / 72)) + 2, Math.ceil(size.h * (150 / 72)) + 2)
  if (found.glyphs.some((g: MarkGlyph) => !glyphShows(before, g, g.small))) return refuse(c, `${t.on} does not show on page ${t.page + 1} (hidden, white, covered or cut off)`)
  const width_mm = o.width_mm ?? SEAL_WIDTH_MM
  const iw = mmToPt(width_mm), ih = iw * (px.height / px.width)
  const cx = (t.aim.x0 + t.aim.x1) / 2, cy = (t.aim.y0 + t.aim.y1) / 2
  const pageW = before.w * (72 / 150), pageH = before.h * (72 / 150)
  const u = Math.max(0, Math.min(cx - iw / 2, pageW - iw)), v = Math.max(0, Math.min(cy - ih / 2, pageH - ih))
  const position = { x_mm: ptToMm(u), y_mm: ptToMm(v) }
  // a solid picture of this size, drawn there first: it shows where a picture lands and how much of it can be seen, which a
  // see-through seal cannot (a layer that is off, something opaque drawn above it, a clip)
  const solid = await officeWorkerWrite(PDF_STAMP_MODE, encodeStampRequest({ page: t.page + 1, position, width_mm, margin_mm: STAMP_DEFAULT_MARGIN_MM, image: 'png' }, pdf, probePng(px.width, px.height)), c.signal, PDF_OUTPUT_MAX)
  let probeFile: Uint8Array
  try { probeFile = decodeStampResult(solid).file } catch { return refuse(c, 'the place could not be checked') }
  const seen = changed(before, await draw(c, probeFile, t.page, before.w + 2, before.h + 2))
  if (!seen || seen.count < VISIBLE_SHARE * pixelsOf(iw, ih)) return refuse(c, `a picture at ${t.on} would not show there (something on the page covers or cuts it off)`)
  const off = Math.max(Math.abs((seen.box.x0 + seen.box.x1) / 2 - cx), Math.abs((seen.box.y0 + seen.box.y1) / 2 - cy)) * MM_PER_PT
  if (off > SEAL_TOLERANCE_MM) return refuse(c, `a picture at ${t.on} would land ${off.toFixed(1)} mm off it`)
  return { page: t.page, position, width_mm, target: t, xml, before, overview: await overview(c, pdf, small, found.pages.length), probe: seen.box, mm: Math.round(off * 10) / 10 }
}

/** The file about to be saved: every page reads and looks as it did, and the picture is drawn inside its place. */
export async function verifyPdfAt(c: ToolCtx, p: PdfPlan, saved: Uint8Array): Promise<PdfLanding> {
  const after = await textOf(c, saved)
  const same = decodeMarksResult(await officeWorkerWrite(PDF_MARKS_MODE, encodeMarksRequest({ kind: 'same', xmlLength: p.xml.length }, p.xml, after), c.signal))
  if (same.kind !== 'same' || !same.same) return refuse(c, 'the stamped PDF does not read as the original did')
  const now = await overview(c, saved, p.overview.reduce((n, b) => n + b.length, 0), p.overview.length)
  if (now.some((b, i) => i !== p.page && !b.equals(p.overview[i]!))) return refuse(c, 'another page of the PDF would change')
  const drawn = changed(p.before, await draw(c, saved, p.page, p.before.w + 2, p.before.h + 2))
  if (!drawn) return refuse(c, `the picture does not show at ${p.target.on} on the saved page`)
  const e = 1
  if (drawn.box.x0 < p.probe.x0 - e || drawn.box.y0 < p.probe.y0 - e || drawn.box.x1 > p.probe.x1 + e || drawn.box.y1 > p.probe.y1 + e) return refuse(c, 'the saved page changed outside the picture\'s place')
  return { on: p.target.on, mm: p.mm }
}
