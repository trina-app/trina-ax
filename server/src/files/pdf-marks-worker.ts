// The office worker's part of stamp_pdf `at` (tools/pdf-at.ts): finding the printed mark in pdftotext's word boxes and reading
// how the page content draws those letters, so that this work on an untrusted PDF never runs on the server's event loop.
import { PDFDocument } from 'pdf-lib'
import { decodeHwpxRequest, encodeHwpxRequest } from './hwpx-check'
import { parseWordBoxes, resolvePdfMark, sameWords, type PBox, type PdfTarget } from './pdf-marks'
import { drawnGlyphs, type DrawnGlyph } from './pdf-text'
import { visibleBox } from './pdf-stamp'

export const PDF_MARKS_MODE = 'pdf-marks'
/** letters smaller than this (points) are not something a person reads as a signer's name or mark */
export const MIN_TEXT_PT = 5
const WHITE = 0.95

export type MarksRequest =
  | { kind: 'resolve'; at: string; page?: number; occurrence?: number; xmlLength: number }
  | { kind: 'same'; xmlLength: number }
export interface MarkGlyph extends PBox { small: boolean }
export type MarksResult =
  | { kind: 'resolved'; target: PdfTarget; glyphs: MarkGlyph[]; pages: { w: number; h: number }[] }
  | { kind: 'ask'; ask: string }
  | { kind: 'same'; same: boolean }

export const encodeMarksRequest = (o: MarksRequest, a: Uint8Array, b: Uint8Array) => encodeHwpxRequest(JSON.stringify(o), new Uint8Array(Buffer.concat([Buffer.from(a), Buffer.from(b)])))
export const decodeMarksResult = (b: Uint8Array) => JSON.parse(decodeHwpxRequest(b).astJson) as MarksResult
const answer = (r: MarksResult) => encodeHwpxRequest(JSON.stringify(r), new Uint8Array(1))
const norm = (s: string) => s.normalize('NFKC').replace(/[\s\p{Cf}]/gu, '')

/** Where a drawn letter is on the page as shown, from its top-left, in points: its advance and its height. */
function shownBox(g: DrawnGlyph, box: { x: number; y: number; width: number; height: number }, r: number): PBox {
  const W = box.width, H = box.height
  const at = (x: number, y: number) => {
    const px = x - box.x, py = y - box.y
    return r === 0 ? [px, H - py] : r === 90 ? [py, px] : r === 180 ? [W - px, py] : [H - py, W - px]
  }
  const pts = [[0, -0.2], [1, -0.2], [0, 0.85], [1, 0.85]].map(([a, b]) => at(g.x + a! * g.dx + b! * g.hx, g.y + a! * g.dy + b! * g.hy))
  return { x0: Math.min(...pts.map((p) => p[0]!)), y0: Math.min(...pts.map((p) => p[1]!)), x1: Math.max(...pts.map((p) => p[0]!)), y1: Math.max(...pts.map((p) => p[1]!)) }
}

/** The letters drawn in each word of the target, checked to be plain visible text that reads as that word: else why not. */
async function inspect(pdf: Uint8Array, t: PdfTarget): Promise<{ glyphs: MarkGlyph[] } | { ask: string }> {
  let doc: PDFDocument
  try { doc = await PDFDocument.load(pdf, { updateMetadata: false }) } catch { return { ask: 'this PDF could not be opened to check how its text is drawn' } }
  const page = doc.getPage(t.page)
  const box = visibleBox(page)
  const r = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360
  const all = drawnGlyphs(doc, t.page)
  if (!all) return { ask: 'this page\'s content could not be read to check how its text is drawn' }
  const placed = all.filter((g) => g.letters.trim()).map((g) => ({ g, b: shownBox(g, box, r) }))
  const out: MarkGlyph[] = []
  for (const w of t.words) {
    const inWord = placed.filter(({ b }) => { const x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2; return x >= w.x0 - 0.5 && x <= w.x1 + 0.5 && y >= w.y0 - 1 && y <= w.y1 + 1 }).sort((a, b) => a.b.x0 - b.b.x0)
    // text drawn twice for bold: each spot once
    const once = inWord.filter((x, i) => !inWord.slice(0, i).some((o) => o.g.letters === x.g.letters && Math.abs(o.b.x0 - x.b.x0) < 1))
    // (near the word's box too: letters this small can fall outside the box pdftotext gives)
    if (placed.some(({ g, b }) => Math.hypot(g.hx, g.hy) < MIN_TEXT_PT && b.x1 >= w.x0 - 2 && b.x0 <= w.x1 + 2 && b.y1 >= w.y0 - 2 && b.y0 <= w.y1 + 2)) return { ask: `${JSON.stringify(w.text.slice(0, 30))} is too small to be read on the page` }
    if (inWord.some((x) => x.g.actual)) return { ask: `${JSON.stringify(w.text.slice(0, 30))} carries a replacement text (ActualText), so what is drawn may differ from what it reads as` }
    if (norm(once.map((x) => x.g.letters).join('')) !== norm(w.text)) return { ask: `${JSON.stringify(w.text.slice(0, 30))} is not drawn as plain page text this tool can check (it may be inside an embedded drawing)` }
    for (const { g, b } of inWord) {
      if (g.tr > 2) return { ask: `${JSON.stringify(w.text.slice(0, 30))} does not show on the page (hidden text)` }
      if (g.fill !== null && g.fill >= WHITE && g.tr === 0) return { ask: `${JSON.stringify(w.text.slice(0, 30))} does not show on the page (white text)` }
      // two different letters of a font that read as the same letter: its letter map may not say what is drawn
      const twins = new Set(all.filter((o) => o.font === g.font && o.letters === g.letters).map((o) => o.code))
      if (g.mapped && twins.size > 1) return { ask: `${JSON.stringify(w.text.slice(0, 30))} is in a font whose letter map is not reliable, so what is drawn may differ from what it reads as` }
      out.push({ ...b, small: /^\p{P}+$/u.test(g.letters.trim()) })
    }
  }
  return { glyphs: out }
}

export async function pdfMarksRequest(input: Uint8Array): Promise<Uint8Array> {
  const r = decodeHwpxRequest(input)
  const o = JSON.parse(r.astJson) as MarksRequest
  const body = r.template ?? new Uint8Array()
  const xml = new TextDecoder().decode(body.subarray(0, o.xmlLength)), rest = body.subarray(o.xmlLength)
  let pages
  try { pages = parseWordBoxes(xml) } catch { return answer({ kind: 'ask', ask: 'this PDF has too much text to look for a signing place in it' }) }
  if (o.kind === 'same') {
    try { return answer({ kind: 'same', same: sameWords(pages, parseWordBoxes(new TextDecoder().decode(rest))) }) } catch { return answer({ kind: 'same', same: false }) }
  }
  const found = resolvePdfMark(pages, o.at, { page: o.page, occurrence: o.occurrence })
  if ('ask' in found) return answer({ kind: 'ask', ask: found.ask })
  const seen = await inspect(rest.slice(), found.target)
  if ('ask' in seen) return answer({ kind: 'ask', ask: seen.ask })
  return answer({ kind: 'resolved', target: found.target, glyphs: seen.glyphs, pages: pages.map((p) => ({ w: p.w ?? 0, h: p.h ?? 0 })) })
}
