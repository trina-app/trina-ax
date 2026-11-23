// The office worker's part of stamp_pdf `at` (tools/pdf-at.ts): finding the printed mark in pdftotext's word boxes, reading how
// the page content draws those letters, and comparing drawings of a page, so that this work on an untrusted PDF never runs on
// the server's event loop.
import { PDFDocument } from 'pdf-lib'
import { decodeHwpxRequest, encodeHwpxRequest } from './hwpx-check'
import { changed, letterDrawn, norm, parsePpm, parseWordBoxes, resolvePdfMark, sameWords, type PBox, type PdfTarget } from './pdf-marks'
import { hideShows, drawnGlyphs, type DrawnGlyph } from './pdf-text'
import { visibleBox } from './pdf-stamp'

export const PDF_MARKS_MODE = 'pdf-marks'
/** letters smaller than this (points) are not something a person reads as a signer's name or mark */
export const MIN_TEXT_PT = 5
/** letters drawn on one page, and distinct letters of one target, this check goes through */
const PAGE_GLYPHS_MAX = 200_000, TARGET_GLYPHS_MAX = 200

export type MarksRequest =
  | { kind: 'resolve'; at: string; page?: number; occurrence?: number; xmlLength: number }
  | { kind: 'same'; xmlLength: number }
  /** two drawings of a page: what changed, and whether each of `glyphs` is really drawn by what was taken away */
  | { kind: 'diff'; xmlLength: number; glyphs?: MarkGlyph[] }
export interface MarkGlyph extends PBox { small: boolean }
export type MarksResult =
  | { kind: 'resolved'; target: PdfTarget; glyphs: MarkGlyph[]; pages: { w: number; h: number }[] }
  | { kind: 'ask'; ask: string }
  | { kind: 'same'; same: boolean }
  | { kind: 'diff'; box: PBox | null; count: number; drawn: boolean }

export const encodeMarksRequest = (o: MarksRequest, a: Uint8Array, b: Uint8Array) => encodeHwpxRequest(JSON.stringify(o), new Uint8Array(Buffer.concat([Buffer.from(a), Buffer.from(b)])))
/** the result, and for a resolved place the PDF with the target's letters taken away */
export function decodeMarksResult(b: Uint8Array): MarksResult & { without?: Uint8Array } {
  const r = decodeHwpxRequest(b)
  const o = JSON.parse(r.astJson) as MarksResult
  return o.kind === 'resolved' ? { ...o, without: r.template! } : o
}
const answer = (r: MarksResult, file: Uint8Array = new Uint8Array(1)) => encodeHwpxRequest(JSON.stringify(r), file)
const letters = (s: string) => norm(s).replace(/[\s\p{Cf}]/gu, '')
const name = (w: { text: string }) => JSON.stringify(w.text.slice(0, 30))

/** a point of user space on the page as shown, from its top-left */
function toShown(box: { x: number; y: number; width: number; height: number }, r: number, x: number, y: number): [number, number] {
  const px = x - box.x, py = y - box.y, W = box.width, H = box.height
  return r === 0 ? [px, H - py] : r === 90 ? [py, px] : r === 180 ? [W - px, py] : [H - py, W - px]
}
function shownBox(g: DrawnGlyph, box: { x: number; y: number; width: number; height: number }, r: number): PBox {
  const pts = [[0, -0.2], [1, -0.2], [0, 0.85], [1, 0.85]].map(([a, b]) => toShown(box, r, g.x + a! * g.dx + b! * g.hx, g.y + a! * g.dy + b! * g.hy))
  return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) }
}
/** the letter's direction on the page as shown is left to right, level */
function level(g: DrawnGlyph, box: { x: number; y: number; width: number; height: number }, r: number): boolean {
  const [ax, ay] = toShown(box, r, g.x, g.y), [bx, by] = toShown(box, r, g.x + g.dx, g.y + g.dy)
  const vx = bx - ax, vy = by - ay
  return (vx === 0 && vy === 0) || (vx > 0 && Math.abs(vy) <= 0.1 * vx)
}

/** The letters drawn in each word of the target, checked to read as that word, and the PDF with them taken away. */
async function inspect(pdf: Uint8Array, t: PdfTarget): Promise<{ glyphs: MarkGlyph[]; without: Uint8Array } | { ask: string }> {
  let doc: PDFDocument
  try { doc = await PDFDocument.load(pdf, { updateMetadata: false }) } catch { return { ask: 'this PDF could not be opened to check how its text is drawn' } }
  const page = doc.getPage(t.page)
  const box = visibleBox(page)
  const r = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360
  const all = drawnGlyphs(doc, t.page)
  if (!all) return { ask: 'this page\'s content could not be read to check how its text is drawn' }
  if (all.length > PAGE_GLYPHS_MAX) return { ask: 'this page draws too much text to check a signing place on it' }
  // what each stretch of replacement text covers, and which codes of a font read as the same letter: once for the page
  const spans = new Map<number, string>(), codes = new Map<unknown, Map<string, Set<number>>>()
  for (const g of all) {
    if (g.actual) spans.set(g.actual.id, (spans.get(g.actual.id) ?? '') + g.letters)
    const byLetter = codes.get(g.font) ?? new Map<string, Set<number>>()
    codes.set(g.font, byLetter)
    const set = byLetter.get(g.letters) ?? new Set<number>()
    byLetter.set(g.letters, set)
    if (set.size < 3) set.add(g.code)
  }
  const placed = all.filter((g) => g.letters.trim() || g.actual).map((g) => ({ g, b: shownBox(g, box, r) }))
  const out = new Map<string, MarkGlyph>(), shows: number[] = []
  for (const w of t.words) {
    const inWord = placed.filter(({ b }) => { const x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2; return x >= w.x0 - 0.5 && x <= w.x1 + 0.5 && y >= w.y0 - 1 && y <= w.y1 + 1 }).sort((a, b) => a.b.x0 - b.b.x0)
    // (near the word's box too: letters this small can fall outside the box pdftotext gives)
    if (placed.some(({ g, b }) => Math.hypot(g.hx, g.hy) < MIN_TEXT_PT && b.x1 >= w.x0 - 2 && b.x0 <= w.x1 + 2 && b.y1 >= w.y0 - 2 && b.y0 <= w.y1 + 2)) return { ask: `${name(w)} is too small to be read on the page` }
    // replacement text is fine only where it says what the font's own letters say
    for (const { g } of inWord) if (g.actual && (g.actual.text === null || letters(g.actual.text) !== letters(spans.get(g.actual.id) ?? ''))) return { ask: `${name(w)} carries a replacement text (ActualText) that differs from the letters drawn, so what shows may differ from what it reads as` }
    // text drawn twice for bold: each spot once
    const lastAt = new Map<string, number>(), once = inWord.filter((x) => { const was = lastAt.get(x.g.letters); if (was !== undefined && x.b.x0 - was < 1) return false; lastAt.set(x.g.letters, x.b.x0); return true })
    if (letters(once.map((x) => x.g.letters).join('')) !== letters(w.text)) return { ask: `${name(w)} is not drawn as plain page text this tool can check (it may be inside an embedded drawing)` }
    // a mark inside a longer word: its place from the letters as drawn
    if (t.sub && t.sub.word.x0 === w.x0 && t.sub.word.y0 === w.y0 && t.sub.word.text === w.text) {
      let at = 0
      const mine: PBox[] = []
      for (const { g, b } of once) { const n = letters(g.letters).length; if (at < t.sub.to && at + n > t.sub.from) mine.push(b); at += n }
      if (!mine.length) return { ask: `the mark in ${name(w)} could not be measured from its letters` }
      t.aim = { x0: Math.min(...mine.map((b) => b.x0)), x1: Math.max(...mine.map((b) => b.x1)), y0: w.y0, y1: w.y1 }
    }
    for (const { g, b } of inWord) {
      if (!level(g, box, r)) return { ask: `${name(w)} is on turned text, so whose mark it is cannot be proved` }
      if (g.tr > 2) return { ask: `${name(w)} does not show on the page (hidden text)` }
      // two different letters of a font that read as the same letter: its letter map may not say what is drawn
      if (g.mapped && (codes.get(g.font)?.get(g.letters)?.size ?? 0) > 1) return { ask: `${name(w)} is in a font whose letter map is not reliable, so what is drawn may differ from what it reads as` }
      shows.push(g.show)
      const k = `${Math.round(b.x0 * 2)},${Math.round(b.y0 * 2)}`
      if (!out.has(k)) out.set(k, { ...b, small: /^\p{P}+$/u.test(g.letters.trim()) })
      if (out.size > TARGET_GLYPHS_MAX) return { ask: `${name(w)} is drawn too many times to check` }
    }
  }
  if (!hideShows(doc, t.page, shows)) return { ask: 'this page\'s content could not be read to check how its text is drawn' }
  return { glyphs: [...out.values()], without: await doc.save() }
}

export async function pdfMarksRequest(input: Uint8Array): Promise<Uint8Array> {
  const r = decodeHwpxRequest(input)
  const o = JSON.parse(r.astJson) as MarksRequest
  const body = r.template ?? new Uint8Array()
  const first = body.subarray(0, o.xmlLength), rest = body.subarray(o.xmlLength)
  if (o.kind === 'diff') {
    let a, b
    try { a = parsePpm(first); b = parsePpm(rest) } catch { return answer({ kind: 'diff', box: null, count: 0, drawn: false }) }
    const c = changed(a, b)
    return answer({ kind: 'diff', box: c?.box ?? null, count: c?.count ?? 0, drawn: !!o.glyphs?.length && o.glyphs.every((g) => letterDrawn(a, b, g, g.small)) })
  }
  const xml = new TextDecoder().decode(first)
  let pages
  try { pages = parseWordBoxes(xml) } catch { return answer({ kind: 'ask', ask: 'this PDF has too much text to look for a signing place in it' }) }
  if (o.kind === 'same') {
    try { return answer({ kind: 'same', same: sameWords(pages, parseWordBoxes(new TextDecoder().decode(rest))) }) } catch { return answer({ kind: 'same', same: false }) }
  }
  const found = resolvePdfMark(pages, o.at, { page: o.page, occurrence: o.occurrence })
  if ('ask' in found) return answer({ kind: 'ask', ask: found.ask })
  const seen = await inspect(rest.slice(), found.target)
  if ('ask' in seen) return answer({ kind: 'ask', ask: seen.ask })
  return answer({ kind: 'resolved', target: found.target, glyphs: seen.glyphs, pages: pages.map((p) => ({ w: p.w ?? 0, h: p.h ?? 0 })) }, seen.without)
}
