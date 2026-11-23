// stamp_pdf `at`: a seal or signature on the printed mark of a PDF (docs/decisions/20261123-signing-slots.md). The place is
// proved before anything is made and checked on what would be saved, by what the page really shows: pdftotext gives the words
// and their boxes (files/pdf-marks.ts), pdftoppm draws the page. Both read the untrusted PDF in the same isolation as a read,
// with a clock and an output cap. Anything not proved is refused, nothing is saved, and for the rest of the turn a stamp by
// coordinates on those same bytes is refused too, so a refusal cannot be stepped around.
import { which } from '../config'
import { decodeStampResult, encodeStampRequest, imageSize, mmToPt, PDF_STAMP_MODE, ptToMm, STAMP_DEFAULT_MARGIN_MM } from '../files/pdf-stamp'
import { officeWorkerWrite } from '../files/extract'
import { changed, MM_PER_PT, parsePpm, parseWordBoxes, pixelsOf, probePng, resolvePdfMark, sameWords, showsInk, type PBox, type Pixels, type PPage, type PdfTarget } from '../files/pdf-marks'
import { PDF_OUTPUT_MAX } from '../files/pdf-pages'
import type { ToolCtx } from '../files/service'
import { SEAL_TOLERANCE_MM } from '../files/sign-slots'
import { sha256 } from '../files/store'
import { ToolError } from '../policy/errors'
import { runIsolated } from './isolate'

/** a seal's width on a mark when none is given */
const SEAL_WIDTH_MM = 15
const TEXT_MS = 60_000, DRAW_MS = 60_000
const TEXT_OUT_MAX = 32 * 1024 * 1024, DRAW_OUT_MAX = 128 * 1024 * 1024
/** of the picture's area that must really show where it is put */
const VISIBLE_SHARE = 0.9

export interface PdfLanding { on: string; mm: number }
export interface PdfPlan {
  page: number; position: { x_mm: number; y_mm: number }; width_mm: number
  target: PdfTarget; words: PPage[]; before: Pixels; probe: PBox; mm: number
}

/** After a refused `at`, a picture on these bytes by coordinates in the same turn: refused. */
export function assertNoStampAfterRefusal(c: ToolCtx, pdf: Uint8Array): void {
  if (c.files.signRefused.has(sha256(pdf))) throw new ToolError('the place to sign on this PDF could not be proved earlier in this answer, so a picture is not put on it by coordinates; ask the person which place. Nothing was saved', 'sign_place')
}

const refuse = (c: ToolCtx, pdf: Uint8Array, why: string): never => {
  c.files.signRefused.add(sha256(pdf))
  throw new ToolError(`${why}. Nothing was saved. Do not work out coordinates to get around this: ask the person which place`, 'sign_place')
}

async function tool(c: ToolCtx, pdf: Uint8Array, name: 'pdftotext' | 'pdftoppm', args: string[], timeoutMs: number, maxStdout: number): Promise<Uint8Array> {
  const bin = which(name)
  if (!bin) throw new ToolError(`finding a printed mark needs ${name}, which is not on this server; give position instead. Nothing was saved`)
  const r = await runIsolated({ cmd: bin, args, stdin: pdf, timeoutMs, signal: c.signal, maxStdout, env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } })
  if (r.killed || r.code !== 0) return refuse(c, pdf, 'this PDF\'s text or page could not be measured')
  return r.stdout
}
const wordsOf = async (c: ToolCtx, pdf: Uint8Array): Promise<PPage[]> => {
  const out = await tool(c, pdf, 'pdftotext', ['-bbox-layout', '-cropbox', '-enc', 'UTF-8', '-', '-'], TEXT_MS, TEXT_OUT_MAX)
  try { return parseWordBoxes(Buffer.from(out).toString('utf8')) } catch { return refuse(c, pdf, 'this PDF\'s text could not be measured') }
}
const draw = async (c: ToolCtx, pdf: Uint8Array, page: number): Promise<Pixels> => {
  const n = String(page + 1)
  const out = await tool(c, pdf, 'pdftoppm', ['-r', '150', '-f', n, '-l', n, '-cropbox', '-singlefile', '-'], DRAW_MS, DRAW_OUT_MAX)
  try { return parsePpm(out) } catch { return refuse(c, pdf, 'this PDF\'s page could not be drawn') }
}

/** The one proved place, the page as it is, and where a solid picture of this size really shows there. */
export async function planPdfAt(c: ToolCtx, rel: string, pdf: Uint8Array, picture: Uint8Array, kind: 'png' | 'jpg', o: { at: string; occurrence?: number; page?: number | 'last'; width_mm?: number }): Promise<PdfPlan> {
  // what the AI names must be what it read: these very bytes
  if (c.files.readHashes.get(rel) !== sha256(pdf)) throw new ToolError(`read '${rel}' first (with read) before putting a picture at a printed mark; nothing was saved`, 'not_read')
  const px = imageSize(picture, kind)
  if (!px || px.width < 1 || px.height < 1) throw new ToolError('the image could not be read (a damaged PNG or JPG); nothing was saved')
  const words = await wordsOf(c, pdf)
  if (!words.length) return refuse(c, pdf, 'this PDF has no pages with text to find a mark on')
  const only = o.page === undefined ? undefined : o.page === 'last' ? words.length - 1 : o.page - 1
  if (only !== undefined && (only < 0 || only >= words.length)) throw new ToolError(`the PDF has ${words.length} page${words.length === 1 ? '' : 's'}, so there is no page ${o.page}; nothing was saved`)
  const r = resolvePdfMark(words, o.at, { page: only, occurrence: o.occurrence })
  if ('ask' in r) return refuse(c, pdf, r.ask)
  const t = r.target
  const before = await draw(c, pdf, t.page)
  if (t.words.some((w) => !showsInk(before, w))) return refuse(c, pdf, `${t.on} does not show on page ${t.page + 1} (hidden, white, covered or cut off)`)
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
  try { probeFile = decodeStampResult(solid).file } catch { return refuse(c, pdf, 'the place could not be checked') }
  const seen = changed(before, await draw(c, probeFile, t.page))
  if (!seen || seen.count < VISIBLE_SHARE * pixelsOf(iw, ih)) return refuse(c, pdf, `a picture at ${t.on} would not show there (something on the page covers or cuts it off)`)
  const off = Math.max(Math.abs((seen.box.x0 + seen.box.x1) / 2 - cx), Math.abs((seen.box.y0 + seen.box.y1) / 2 - cy)) * MM_PER_PT
  if (off > SEAL_TOLERANCE_MM) return refuse(c, pdf, `a picture at ${t.on} would land ${off.toFixed(1)} mm off it`)
  return { page: t.page, position, width_mm, target: t, words, before, probe: seen.box, mm: Math.round(off * 10) / 10 }
}

/** The file about to be saved: every page's words as they were, and the picture drawn inside its place. */
export async function verifyPdfAt(c: ToolCtx, pdf: Uint8Array, p: PdfPlan, saved: Uint8Array): Promise<PdfLanding> {
  if (!sameWords(p.words, await wordsOf(c, saved))) return refuse(c, pdf, 'the stamped PDF does not read as the original did')
  const drawn = changed(p.before, await draw(c, saved, p.page))
  if (!drawn) return refuse(c, pdf, `the picture does not show at ${p.target.on} on the saved page`)
  const e = 1
  if (drawn.box.x0 < p.probe.x0 - e || drawn.box.y0 < p.probe.y0 - e || drawn.box.x1 > p.probe.x1 + e || drawn.box.y1 > p.probe.y1 + e) return refuse(c, pdf, 'the saved page changed outside the picture\'s place')
  return { on: p.target.on, mm: p.mm }
}
