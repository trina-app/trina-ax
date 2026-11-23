// Where a seal goes on a PDF (stamp_pdf `at`; docs/decisions/20261123-signing-slots.md). The words and their boxes come from
// pdftotext on the exact bytes, in the page as it is shown, from its top-left, in points: the coordinates stamp_pdf places in.
// The invariant is the one of Word and Hangul: a placement is accepted only if the target maps to exactly one drawn place,
// proved from the document; anything else is an `ask`, and nothing is saved. So: one line only, the name next to its mark, a
// known mark as whole words, reading order by line bands and never drawing order, and nothing overlapping the words.
import zlib from 'node:zlib'
import { partX } from './hwp-picture'
import { bareMarkAsk, pickSignMark, placedOn, type SignMark } from './sign-slots'

export interface PBox { x0: number; y0: number; x1: number; y1: number }
export interface PWord extends PBox { text: string; /** pdftotext's own line, to see a line drawn backwards */ line: number }
export interface PPage { words: PWord[]; /** its size as pdftotext reports it, in points (not turned with /Rotate) */ w?: number; h?: number }

/** words of one PDF a signing place is looked for in: a long contract fits, and the work stays small */
export const PDF_WORDS_MAX = 30_000
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[n]!)

/** pdftotext -bbox-layout's output: the pages and their words. Throws when it is not that. */
export function parseWordBoxes(xml: string): PPage[] {
  const pages: PPage[] = []
  let line = 0, n = 0
  for (const m of xml.matchAll(/<page width="([\d.]+)" height="([\d.]+)"|<line\b|<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g)) {
    if (m[1] !== undefined) { pages.push({ words: [], w: Number(m[1]), h: Number(m[2]) }); continue }
    if (m[0] === '<line') { line++; continue }
    if (!pages.length || ++n > PDF_WORDS_MAX) throw new Error('word boxes')
    const [x0, y0, x1, y1] = [m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number]
    if (![x0, y0, x1, y1].every(Number.isFinite)) throw new Error('word boxes')
    pages[pages.length - 1]!.words.push({ text: unescape(m[7]!), x0, y0, x1, y1, line })
  }
  return pages
}

/** The same words at the same places on every page (a stamp adds no text and moves none). */
export function sameWords(a: PPage[], b: PPage[]): boolean {
  if (a.length !== b.length) return false
  const key = (w: PWord) => `${w.x0.toFixed(1)},${w.y0.toFixed(1)},${w.x1.toFixed(1)},${w.y1.toFixed(1)},${w.text}`
  return a.every((p, i) => {
    const x = p.words.map(key).sort(), y = b[i]!.words.map(key).sort()
    return x.length === y.length && x.every((k, j) => k === y[j])
  })
}

const norm = (s: string) => s.normalize('NFKC')
const compact = (s: string) => s.replace(/[\s\p{Cf}]/gu, '')
const shown = (s: string, max = 50) => { const t = s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' '); return JSON.stringify(t.length > max ? `${t.slice(0, max)}…` : t) }
const overlapY = (a: PBox, b: PBox) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
const area = (a: PBox) => Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0)
const meet = (a: PBox, b: PBox) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, overlapY(a, b))
const union = (w: PBox[]): PBox => ({ x0: Math.min(...w.map((x) => x.x0)), y0: Math.min(...w.map((x) => x.y0)), x1: Math.max(...w.map((x) => x.x1)), y1: Math.max(...w.map((x) => x.y1)) })

/** The page's lines in reading order: words whose heights overlap by half or more of the smaller, measured against the
 * line's first word so that a slope cannot chain lines together; left to right in each. A word drawn twice at one spot
 * (fake bold) is one word. Close to linear in the words: nearby words are found by a grid, open lines by a sliding list. */
export function lineBands(p: PPage): PWord[][] {
  const cell = 4, grid = new Map<string, PWord[]>(), seen: PWord[] = []
  const key = (t: string, x: number, y: number) => `${t}|${x}|${y}`
  for (const w of p.words) {
    const gx = Math.floor(w.x0 / cell), gy = Math.floor(w.y0 / cell)
    let twin = false
    for (let i = -1; i <= 1 && !twin; i++) for (let j = -1; j <= 1 && !twin; j++) twin = (grid.get(key(w.text, gx + i, gy + j)) ?? []).some((o) => meet(o, w) > 0.8 * Math.min(area(o), area(w)))
    if (twin) continue
    seen.push(w)
    const k = key(w.text, gx, gy)
    const list = grid.get(k)
    if (list) list.push(w); else grid.set(k, [w])
  }
  const bands: { head: PWord; words: PWord[] }[] = []
  let open: typeof bands = []
  for (const w of seen.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    open = open.filter((x) => x.head.y1 > w.y0)
    const b = open.find((x) => overlapY(x.head, w) >= 0.5 * Math.min(x.head.y1 - x.head.y0, w.y1 - w.y0))
    if (b) b.words.push(w)
    else { const made = { head: w, words: [w] }; bands.push(made); open.push(made) }
  }
  return bands.map((b) => b.words.sort((x, y) => x.x0 - y.x0))
}

/** Runs of one printed line: at most one font height between words. Words that only share a height (a name at the left and
 * another person's mark across the page) are never one label. */
function runsOf(band: PWord[]): PWord[][] {
  const runs: PWord[][] = []
  for (const w of band) {
    const last = runs.at(-1)?.at(-1)
    if (last && w.x0 - last.x1 <= Math.max(last.y1 - last.y0, w.y1 - w.y0)) runs.at(-1)!.push(w)
    else runs.push([w])
  }
  return runs
}

interface Hit { page: number; band: PWord[]; whole: PWord[]; at: number; map: { w: number; k: number }[]; letters: string }
function hitsOf(pages: PPage[], q: string, only: number | undefined): Hit[] {
  const out: Hit[] = []
  pages.forEach((p, page) => {
    if (only !== undefined && only !== page) return
    for (const whole of lineBands(p)) for (const band of runsOf(whole)) {
      const parts: string[] = []
      const map: { w: number; k: number }[] = []
      band.forEach((w, i) => { const t = compact(norm(w.text)); for (let k = 0; k < t.length; k++) map.push({ w: i, k }); parts.push(t) })
      const letters = parts.join('')
      for (let at = letters.indexOf(q); at >= 0; at = letters.indexOf(q, at + q.length)) out.push({ page, band, whole, at, map, letters })
    }
  })
  return out
}

export interface PdfTarget {
  /** 0-based */
  page: number
  /** what the seal is centred on */
  aim: PBox
  /** every word of the label and the mark, which must show on the page */
  words: (PBox & { text: string })[]
  /** the text it lands on, for the result */
  on: string
}
export type PdfResolve = { target: PdfTarget } | { ask: string }

/** The one place a text names on the PDF, or what to give instead. `page`: 0-based, to search one page. */
export function resolvePdfMark(pages: PPage[], at: string, o: { page?: number; occurrence?: number }): PdfResolve {
  const label = norm(at).trim()
  const q = compact(label)
  if (!q) return { ask: 'at is empty; give the printed mark or the signer\'s name and its mark' }
  const hits = hitsOf(pages, q, o.page)
  if (!hits.length) return { ask: `${shown(at)} is not on one line of ${o.page === undefined ? 'this PDF' : `page ${o.page + 1}`} as its text reads. Give the signer's name and its mark exactly as they are on one line, or only the mark` }
  const signed = pickSignMark(label, o.occurrence, hits.length)
  if ('ask' in signed) return { ask: signed.ask }
  if (!signed.mark) return { ask: `${shown(at)} holds no printed sign mark this tool knows, such as a seal or signature mark in brackets, so the place is not proved. Give the mark's text, or ask the person where it goes` }
  const list = () => hits.slice(0, 5).map((h, i) => `${i + 1}: page ${h.page + 1}, ${shown(h.band.map((w) => norm(w.text)).join(' '), 40)}`).join('; ')
  if (hits.length > 1 && signed.occurrence === undefined) return { ask: `${shown(at)} is in ${hits.length} places (${list()}${hits.length > 5 ? '; …' : ''}). Give the signer's name with the mark, or occurrence (1-${hits.length}), counted by page, then top to bottom, then left to right` }
  const n = (signed.occurrence ?? 1) - 1
  const h = hits[n]
  if (!h) return { ask: `${shown(at)} is in ${hits.length} place${hits.length > 1 ? 's' : ''}, so there is no occurrence ${n + 1}` }
  const line = h.whole.map((w) => norm(w.text)).join(' ')
  const bare = bareMarkAsk(label, signed.mark, line, o.occurrence)
  if (bare) return { ask: bare }
  return placeOf(pages, h, hits, label, signed.mark, at)
}

function placeOf(pages: PPage[], h: Hit, hits: Hit[], label: string, mark: SignMark, at: string): PdfResolve {
  const inCompact = (i: number) => compact(label.slice(0, i)).length
  const from = h.at + inCompact(mark.from), to = h.at + inCompact(mark.to)
  const first = h.map[from]!, last = h.map[to - 1]!
  const wordLen = (i: number) => compact(norm(h.band[i]!.text)).length
  if (first.k !== 0 || last.k !== wordLen(last.w) - 1) return { ask: `the mark in ${shown(at)} is joined to other letters in the PDF's text, so its place cannot be measured. Ask the person where it goes` }
  const labelWords = [...new Set(h.map.slice(h.at, h.at + compact(label).length).map((x) => x.w))].map((i) => h.band[i]!)
  const markWords = h.band.slice(first.w, last.w + 1)
  // the name and its mark are one printed line for pdftotext too. Only inside a known mark may it break ("(sign or seal)" set
  // with wide spaces), since those words cannot belong to two people
  for (let i = 1; i < labelWords.length; i++) {
    const a = labelWords[i - 1]!, b = labelWords[i]!
    if (a.line !== b.line && !(markWords.includes(a) && markWords.includes(b))) return { ask: `${shown(at)} is not on one printed line of the PDF, so the name and the mark are not proved to belong together. Give the signer's name and its mark as they are on one line, or ask the person` }
  }
  // text turned upright or drawn backwards: its order on the page is not its reading order, so whose mark it is is not proved
  // (a word's box is as tall as its font's whole height, so a short upright word of wide letters is taller than wide)
  const turned = (w: PWord) => [...compact(w.text)].length >= 3 && w.y1 - w.y0 > 1.5 * (w.x1 - w.x0)
  if ([...labelWords, ...markWords].some(turned)) return { ask: `${shown(at)} is on turned text, so whose mark it is cannot be proved. Ask the person where it goes` }
  for (const id of new Set(labelWords.map((w) => w.line))) {
    const drawn = pages[h.page]!.words.filter((w) => w.line === id)
    if (drawn.some((w, i) => i > 0 && w.x0 < drawn[i - 1]!.x0 - 0.5)) return { ask: `${shown(at)} is on text drawn in another direction, so whose mark it is cannot be proved. Ask the person where it goes` }
  }
  // another word over any of them: what shows there is not proved to be this text
  const others = pages[h.page]!.words.filter((w) => !labelWords.some((l) => l === w || (l.text === w.text && meet(l, w) > 0.8 * Math.min(area(l), area(w)))))
  if (others.some((w) => labelWords.some((l) => meet(l, w) > 0.15 * Math.min(area(l), area(w))))) return { ask: `other text overlaps ${shown(at)} on page ${h.page + 1}, so what shows there is not proved. Ask the person where it goes` }
  // two places on different lines whose heights overlap cannot be put in a sure order
  const box = union(markWords)
  for (const x of hits) {
    if (x === h || x.page !== h.page || x.whole === h.whole) continue
    const b = x.band[x.map[x.at]!.w]!
    if (overlapY(box, b) > 0) return { ask: `${shown(at)} is in places side by side at slightly different heights on page ${h.page + 1}, so their order is not sure. Give the signer's name with the mark` }
  }
  // the seal word of a "signature or seal" mark, inside its measured word
  const aFrom = h.at + inCompact(mark.aimFrom), aTo = h.at + inCompact(mark.aimTo)
  const aw = h.map[aFrom]!, az = h.map[aTo - 1]!
  let aim: PBox
  if (aw.w === az.w && (aw.k !== 0 || az.k !== wordLen(az.w) - 1)) {
    const w = h.band[aw.w]!, t = compact(norm(w.text))
    const [x0, x1] = partX(w.x0, w.x1, t, aw.k, az.k + 1)
    aim = { x0, x1, y0: w.y0, y1: w.y1 }
  } else aim = union(h.band.slice(aw.w, az.w + 1))
  return { target: { page: h.page, aim, words: labelWords, on: placedOn(label, mark) } }
}

// ---------------------------------------------------------------- what the page really shows
export const RENDER_DPI = 150
const PX = RENDER_DPI / 72
export const MM_PER_PT = 25.4 / 72
export interface Pixels { w: number; h: number; rgb: Uint8Array }

/** pdftoppm's output (P6, 8 bits). Throws when it is not that. */
export function parsePpm(b: Uint8Array): Pixels {
  let p = 0
  const token = () => {
    while (b[p] === 0x20 || b[p] === 0x0a || b[p] === 0x0d || b[p] === 0x09) p++
    const s = p
    while (p < b.length && b[p]! > 0x20) p++
    return Buffer.from(b.subarray(s, p)).toString('latin1')
  }
  if (token() !== 'P6') throw new Error('ppm')
  const w = Number(token()), h = Number(token()), max = Number(token())
  p++
  if (!(w > 0 && h > 0) || max !== 255 || b.length - p < w * h * 3) throw new Error('ppm')
  return { w, h, rgb: b.subarray(p, p + w * h * 3) }
}

const gray = (i: Pixels, x: number, y: number) => { const o = (y * i.w + x) * 3; return (i.rgb[o]! * 3 + i.rgb[o + 1]! * 6 + i.rgb[o + 2]!) / 10 }
const pxBox = (i: Pixels, b: PBox) => ({
  x0: Math.max(0, Math.floor(b.x0 * PX)), y0: Math.max(0, Math.floor(b.y0 * PX)),
  x1: Math.min(i.w, Math.ceil(b.x1 * PX)), y1: Math.min(i.h, Math.ceil(b.y1 * PX)),
})

/** One letter's box shows that letter: enough pixels stand apart from the colour most of it has, over enough of its height
 * (a rule crossing white text covers a few rows). `small`: a punctuation mark, which only has to show something. */
export function glyphShows(i: Pixels, b: PBox, small: boolean): boolean {
  const r = pxBox(i, b)
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return false
  const hist = new Uint32Array(52)
  const total = (r.x1 - r.x0) * (r.y1 - r.y0)
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) hist[Math.floor(gray(i, x, y) / 5)]!++
  const back = hist.indexOf(Math.max(...hist)) * 5 + 2
  let ink = 0, rows = 0
  for (let y = r.y0; y < r.y1; y++) {
    let here = 0
    for (let x = r.x0; x < r.x1; x++) if (Math.abs(gray(i, x, y) - back) > 48) here++
    ink += here
    if (here) rows++
  }
  if (small) return ink > 0
  return ink / total >= 0.05 && rows / (r.y1 - r.y0) >= 0.35
}

/** The pixels that differ between two drawings of one page: their box (in points) and how many. */
export function changed(a: Pixels, b: Pixels): { box: PBox; count: number } | null {
  if (a.w !== b.w || a.h !== b.h) return null
  let x0 = a.w, y0 = a.h, x1 = -1, y1 = -1, count = 0
  for (let y = 0, o = 0; y < a.h; y++) for (let x = 0; x < a.w; x++, o += 3) {
    if (Math.abs(a.rgb[o]! - b.rgb[o]!) > 16 || Math.abs(a.rgb[o + 1]! - b.rgb[o + 1]!) > 16 || Math.abs(a.rgb[o + 2]! - b.rgb[o + 2]!) > 16) {
      count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
  }
  return count ? { box: { x0: x0 / PX, y0: y0 / PX, x1: (x1 + 1) / PX, y1: (y1 + 1) / PX }, count } : null
}
/** how many pixels a box of this many points covers */
export const pixelsOf = (wPt: number, hPt: number) => wPt * PX * hPt * PX

/** A solid picture of the seal's shape: drawn in its place first, it shows where a picture there really lands and how much
 * of it can be seen, which a see-through seal cannot. */
export function probePng(w: number, h: number): Uint8Array {
  const W = Math.max(1, Math.min(200, w)), H = Math.max(1, Math.round((W * h) / w))
  const row = Buffer.alloc(1 + W * 3)
  for (let i = 0; i < W; i++) { row[1 + i * 3] = 255; row[2 + i * 3] = 0; row[3 + i * 3] = 255 }
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length)
    const body = Buffer.concat([Buffer.from(t, 'latin1'), d])
    const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(body) >>> 0)
    return Buffer.concat([l, body, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: H }, () => row)))), chunk('IEND', Buffer.alloc(0))]))
}
