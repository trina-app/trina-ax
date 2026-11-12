// Where a line of a document's extracted text is (docs/DECISIONS.md "Sources under each answer"). The extractors
// (extract.ts, office-parse.ts, hwp.ts, native/ocr) leave structure in the text:
//   - PDF: a form feed before each page after the first (pdftotext; mycel-ocr since 0.2.17)
//   - spreadsheets: `# sheet: <name> · A1:F40 (tab-separated)` before each sheet, `# row N` where blank rows were left
//     out; a quoted cell may span lines (an odd number of quotes so far means the row goes on)
//   - PowerPoint: `=== Slide N ===` before each slide's text and each slide's notes and charts
//   - Word, OpenDocument, Hangul: Markdown headings (`## 환불 정책`); a body line that starts like one is indented
// From these this module tells the place of any line (grep results, a read by lines), cuts text into pieces that never
// cross a page, slide, sheet or section (chunkDoc), and writes the short labels the AI sees ("p.12", "시트 '매출' A1:F40",
// "슬라이드 3", "§ 환불 정책"). Text cached before the marks (an older text cache) gives what it can: pages always, sheet
// names without ranges, and no slides or sections.
import type { SourceLoc } from '@mycel/shared/api'
import { ext } from './extract'

export type Structure = 'pages' | 'sheets' | 'slides' | 'headings' | null

/** How the text of a file of this name is structured (null: plain text; its line numbers are the place). */
export function structureOf(name: string): Structure {
  switch (ext(name)) {
    case 'pdf': return 'pages'
    case 'xlsx': case 'xls': case 'ods': return 'sheets'
    case 'pptx': return 'slides'
    case 'docx': case 'odt': case 'hwp': case 'hwpx': return 'headings'
    default: return null
  }
}

const SLIDE = /^=== Slide (\d{1,6}) ===$/
const SECTION = /^=== .* ===$/
const HEADING = /^(#{1,6}) (.*\S)\s*$/
const SHEET = /^# sheet: (.*?)(?: · ([A-Z]{1,3})(\d{1,7}):([A-Z]{1,3})(\d{1,7}))? \(tab-separated\)$/
const ROW = /^# row (\d{1,7})$/

/** what a line is, for chunking: its place, whether it only marks structure (left out of a piece's text), and the
 * key a piece must not cross */
export interface LineAt { text: string; loc: SourceLoc | null; key: string; marker: boolean; row?: number }

/** Where walkLines is between two lines: all it carries from one line to the next. A large text's place index
 * (files/place-index.ts) keeps it at points of the text, so a later walk can start there instead of at line 1. */
export interface WalkState {
  page: number
  slide: number | null
  heading: string | null
  sheet: { name: string; c0: string; c1: string; ranged: boolean } | null
  row: number
  inQuote: boolean
}
export const walkStart = (): WalkState => ({ page: 1, slide: null, heading: null, sheet: null, row: 1, inQuote: false })

/**
 * One line of walkLines: `onLine` gets its place, and `s` moves past it. Returns false when `onLine` stopped.
 */
export function walkLine(s: WalkState, kind: Structure, raw: string, no: number, onLine: (l: LineAt, lineNo: number) => boolean | void): boolean {
  if (kind === 'pages') {
    // a form feed starts the next page; the empty parts around it (an empty page) are not lines of their own
    const parts = raw.split('\f')
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) s.page++
      if (parts.length > 1 && !parts[k]) continue
      if (onLine({ text: parts[k]!, loc: { kind: 'page', page: s.page }, key: String(s.page), marker: false }, no) === false) return false
    }
    return true
  }
  if (kind === 'slides') {
    const m = SLIDE.exec(raw)
    if (m) s.slide = Number(m[1])
    else if (SECTION.test(raw)) s.slide = null
    const marker = !!m || SECTION.test(raw)
    const slide = s.slide
    return onLine({ text: raw, loc: slide ? { kind: 'slide', slide } : null, key: slide ? String(slide) : '', marker }, no) !== false
  }
  if (kind === 'headings') {
    const h = HEADING.exec(raw)
    if (h) s.heading = cleanLabel(h[2]!, 120) || null
    else if (SECTION.test(raw)) s.heading = null
    const marker = !h && SECTION.test(raw)
    const heading = s.heading
    return onLine({ text: raw, loc: heading ? { kind: 'heading', heading } : null, key: heading ?? '', marker }, no) !== false
  }
  if (kind === 'sheets') {
    const m = s.inQuote ? null : SHEET.exec(raw)
    if (m) {
      // a new object (never changed in place): a state kept in a place index stays as it was
      s.sheet = { name: m[1]!, c0: m[2] ?? '', c1: m[4] ?? '', ranged: !!m[2] }
      s.row = m[3] ? Number(m[3]) : 1
      s.inQuote = false
      return onLine({ text: raw, loc: { kind: 'sheet', sheet: s.sheet.name }, key: 'sheet:' + s.sheet.name, marker: true }, no) !== false
    }
    const sheet = s.sheet
    const r = s.inQuote ? null : ROW.exec(raw)
    if (r && sheet) {
      s.row = Number(r[1])
      return onLine({ text: raw, loc: { kind: 'sheet', sheet: sheet.name }, key: 'sheet:' + sheet.name, marker: true }, no) !== false
    }
    const at = s.row
    let q = 0
    for (let p = raw.indexOf('"'); p >= 0; p = raw.indexOf('"', p + 1)) q++
    if (q % 2 === 1) s.inQuote = !s.inQuote
    if (!s.inQuote) s.row++
    const loc: SourceLoc | null = sheet ? { kind: 'sheet', sheet: sheet.name, ...(sheet.ranged && raw.trim() ? { range: `${sheet.c0}${at}:${sheet.c1}${at}` } : {}) } : null
    return onLine({ text: raw, loc, key: sheet ? 'sheet:' + sheet.name : '', marker: false, ...(sheet?.ranged && raw.trim() ? { row: at } : {}) }, no) !== false
  }
  return onLine({ text: raw, loc: null, key: '', marker: false }, no) !== false
}

/**
 * Walk the lines of `text` with their place. A PDF line with a form feed in it is given as its parts (each part on its
 * page). `onLine` returns false to stop.
 */
export function walkLines(text: string, kind: Structure, onLine: (l: LineAt, lineNo: number) => boolean | void): void {
  const lines = text.split('\n')
  const s = walkStart()
  for (let i = 0; i < lines.length; i++) if (!walkLine(s, kind, lines[i]!, i + 1, onLine)) return
}

/** The places of some lines (1-based line numbers of the text as read and grep number it). */
export function locsOfLines(text: string, name: string, lineNos: Iterable<number>): Map<number, SourceLoc> {
  const kind = structureOf(name)
  const want = new Set(lineNos)
  const out = new Map<number, SourceLoc>()
  if (!kind || !want.size) return out
  const last = Math.max(...want)
  walkLines(text, kind, (l, no) => {
    if (no > last) return false
    notePlace(out, want, l, no)
  })
  return out
}

/** The place of a wanted line, as locsOfLines takes it from walkLines (also files/place-index.ts placesOfLines). */
export function notePlace(out: Map<number, SourceLoc>, want: Set<number>, l: LineAt, no: number): void {
  // a PDF line split by a form feed: the place of its last part (the page the line's text goes on)
  if (want.has(no) && l.loc && (!l.marker || !out.has(no))) out.set(no, l.loc)
}

/** The places a range of lines covers (a read by offset/limit), in order, at most `max`. */
export function locsOfRange(text: string, name: string, from: number, to: number, max = 20): SourceLoc[] {
  const kind = structureOf(name)
  if (!kind) return []
  const seen = new Map<string, SourceLoc>()
  const sheetRows = new Map<string, { sheet: string; c0: string; c1: string; lo: number; hi: number }>()
  walkLines(text, kind, (l, no) => {
    if (no > to) return false
    if (no < from || !l.loc || l.marker && kind !== 'sheets') return
    if (l.loc.kind === 'sheet') {
      const cur = sheetRows.get(l.loc.sheet) ?? { sheet: l.loc.sheet, c0: '', c1: '', lo: Infinity, hi: -Infinity }
      if (l.row !== undefined && l.loc.range) {
        const m = /^([A-Z]+)\d+:([A-Z]+)\d+$/.exec(l.loc.range)
        if (m) { cur.c0 = m[1]!; cur.c1 = m[2]!; cur.lo = Math.min(cur.lo, l.row); cur.hi = Math.max(cur.hi, l.row) }
      }
      sheetRows.set(l.loc.sheet, cur)
      if (!seen.has('sheet:' + l.loc.sheet)) seen.set('sheet:' + l.loc.sheet, l.loc)
      return
    }
    const k = locKey(l.loc)
    if (seen.has(k)) return
    if (seen.size >= max) return false
    seen.set(k, l.loc)
  })
  return [...seen.values()].slice(0, max).map((loc) => {
    if (loc.kind !== 'sheet') return loc
    const r = sheetRows.get(loc.sheet)
    return r && r.c0 && r.lo <= r.hi ? { kind: 'sheet', sheet: loc.sheet, range: `${r.c0}${r.lo}:${r.c1}${r.hi}` } : { kind: 'sheet', sheet: loc.sheet }
  })
}

export const locKey = (l: SourceLoc) => l.kind === 'page' ? `p${l.page}` : l.kind === 'slide' ? `s${l.slide}` : l.kind === 'heading' ? `h${l.heading}` : `t${l.sheet}|${l.range ?? ''}`

const CHUNK = 800

export interface Piece { text: string; loc: SourceLoc | null }

/**
 * ~800-character pieces of a document along paragraph / line breaks, long lines cut, as before; a piece never goes
 * past a page, slide, sheet or section, and keeps its place (a sheet piece: the A1 range of its rows). Structure-only
 * lines (`=== Slide 3 ===`, `# sheet: …`, `# row 9`) are not part of the text. Tiny pieces are dropped. No search uses
 * it since the knowledge graph was removed (docs/DECISIONS.md, 2026-11-11); its tests check the places the extractors
 * leave in the text (tests/unit/sources-locations.test.ts).
 */
export function chunkDoc(text: string, name: string): Piece[] {
  const kind = structureOf(name)
  const out: Piece[] = []
  let cur = ''
  let key: string | null = null
  let loc: SourceLoc | null = null
  let rows: { lo: number; hi: number } | null = null
  const sheetLoc = (): SourceLoc | null => {
    if (!loc || loc.kind !== 'sheet') return loc
    const m = loc.range && /^([A-Z]+)\d+:([A-Z]+)\d+$/.exec(loc.range)
    return m && rows ? { kind: 'sheet', sheet: loc.sheet, range: `${m[1]}${rows.lo}:${m[2]}${rows.hi}` } : { kind: 'sheet', sheet: loc.sheet }
  }
  const push = () => {
    const c = cur.trim()
    if (c) out.push({ text: c, loc: sheetLoc() })
    cur = ''
    rows = null
  }
  const take = (l: LineAt) => {
    if (l.key !== key) { push(); key = l.key; loc = l.loc }
    else if (l.loc && (!loc || (loc.kind === 'sheet' && !loc.range && l.loc.kind === 'sheet' && l.loc.range))) loc = l.loc
    if (l.marker) return
    let line = l.text.replace(/[ \t\f\v]+/g, ' ').trimEnd()
    const addRow = () => { if (l.row !== undefined && line.trim()) rows = rows ? { lo: Math.min(rows.lo, l.row), hi: Math.max(rows.hi, l.row) } : { lo: l.row, hi: l.row } }
    while (line.length > CHUNK) {
      if (cur) push()
      addRow()
      out.push({ text: line.slice(0, CHUNK).trim(), loc: sheetLoc() })
      rows = null
      line = line.slice(CHUNK)
    }
    if (cur.length + line.length + 1 > CHUNK) push()
    addRow()
    cur += (cur ? '\n' : '') + line
  }
  walkLines(text, kind, (l) => { take(l) })
  push()
  return out.filter((c) => c.text.replace(/\s/g, '').length >= 10)
}

/** One line of file-provided text for a label: no line breaks or control characters, no '<' (so no block tag of the
 * prompt such as </turn_context> can be opened or closed, chat/prompt.ts neutralizeTags), at most `max` characters. */
export function cleanLabel(s: string, max = 80): string {
  const one = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/</g, '\u2039')
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

type Lang = 'ko' | 'en' | 'id' | 'ja' | 'es'
/** the words of the place labels (%s: the sheet name or the slide number) */
const WORDS: Record<Lang, { sheet: string; slide: string }> = {
  ko: { sheet: "시트 '%s'", slide: '슬라이드 %s' },
  en: { sheet: "sheet '%s'", slide: 'slide %s' },
  id: { sheet: "sheet '%s'", slide: 'slide %s' },
  ja: { sheet: 'シート「%s」', slide: 'スライド%s' },
  es: { sheet: "hoja '%s'", slide: 'diapositiva %s' },
}
const fill = (word: string, v: string | number) => word.replace('%s', () => String(v))

/** The short place label the AI sees and may copy into its answer: "p.12", "시트 '매출' A1:F40", "슬라이드 3", "§ 환불 정책". */
export function locLabel(l: SourceLoc, lang: Lang = 'en'): string {
  const w = WORDS[lang] ?? WORDS.en
  switch (l.kind) {
    case 'page': return `p.${l.page}`
    case 'slide': return fill(w.slide, l.slide)
    case 'sheet': return fill(w.sheet, cleanLabel(l.sheet, 60)) + (l.range ? ` ${l.range}` : '')
    case 'heading': return `§ ${cleanLabel(l.heading, 60)}`
  }
}
