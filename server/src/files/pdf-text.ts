// edit_pdf's replace_text (tools/pdf-tools.ts; docs/decisions/20261118-pdf-replace-text.md): change words inside an
// existing PDF so that the old words are really gone, not covered: what PyMuPDF's search_for + apply_redactions +
// insert_text do, with pdf-lib (already bundled everywhere). Runs only in the office worker (files/pdf-pages.ts).
//
// A page's content is read operator by operator, with the text state (font, size, matrices, spacing, render mode) and
// the font's widths and its map to letters (ToUnicode, else its encoding), so every glyph has its letters and its spot.
// For each match:
//  - its glyphs are taken out of their text operators (the old character codes are nowhere in the page's content after);
//  - the new words are written at the first glyph's spot, inside the same text object, so they get its colour, size,
//    position and turn: in the original font when that font has a glyph for every letter, else the closest standard font
//    (sans, serif or mono; bold, italic; with its widths written) or, for other letters, the server's Pretendard;
//  - the rest of the line follows the new words: the rest of their run, and the runs after it on the line that are part
//    of the same text (each starts within about a letter's height of the one before). A larger gap, or an upright rule
//    the line crosses (a table's column line), is another column: it does not move. When the line would reach it or the
//    page's edge, the new words are written smaller (down to 60%), or, when even that does not fit, left at their size
//    and the AI is told. A paragraph is not re-wrapped.
// The page gets one new content stream; the old streams are left unreachable and pdf-pages.ts drops them before saving.
// What cannot be changed is said plainly: words in a picture (a scan), the hidden text layer of a scanned page (it would
// not change what the page shows), text in a drawn block (a form XObject), vertical text, fonts without a letter map.
import { decodePDFRawStream, PDFArray, PDFDict, PDFFlateStream, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, StandardFontEmbedder, StandardFonts, type PDFContext, type PDFDocument, type PDFFont, type PDFObject, type PDFPage } from 'pdf-lib'
import { ToolError } from '../policy/errors'

// ---------------------------------------------------------------- lexing a content stream (bytes as latin1 text)

type Val = number | boolean | null | { name: string } | { str: string } | Val[] | { dict: true }
interface Lexed { kind: 'val' | '[' | ']' | '<<' | '>>' | 'op'; v?: Val; op?: string; start: number; end: number; raw?: string }

/** pdf-lib's standard-font metrics (its StandardFonts names are the same strings as the metrics package's) */
const embedderFor = (name: StandardFonts) => StandardFontEmbedder.for(name as unknown as Parameters<typeof StandardFontEmbedder.for>[0])

const WS = new Set(['\0', '\t', '\n', '\f', '\r', ' '])
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

class Lexer {
  i = 0
  constructor(readonly s: string) {}
  next(): Lexed | null {
    const s = this.s
    for (;;) {
      while (this.i < s.length && WS.has(s[this.i]!)) this.i++
      if (this.i >= s.length) return null
      if (s[this.i] === '%') { while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++; continue }
      break
    }
    const start = this.i
    const c = s[this.i]!
    if (c === '(') return { kind: 'val', v: { str: this.literal() }, start, end: this.i }
    if (c === '<') {
      if (s[this.i + 1] === '<') { this.i += 2; return { kind: '<<', start, end: this.i } }
      const close = s.indexOf('>', this.i)
      const body = (close < 0 ? s.slice(this.i + 1) : s.slice(this.i + 1, close)).replace(/[^0-9a-fA-F]/g, '')
      this.i = close < 0 ? s.length : close + 1
      const hex = body.length % 2 ? body + '0' : body
      let str = ''
      for (let k = 0; k < hex.length; k += 2) str += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16))
      return { kind: 'val', v: { str }, start, end: this.i }
    }
    if (c === '>') { this.i += s[this.i + 1] === '>' ? 2 : 1; return { kind: '>>', start, end: this.i } }
    if (c === '[' || c === ']') { this.i++; return { kind: c, start, end: this.i } }
    if (c === '{' || c === '}') { this.i++; return { kind: 'op', op: c, start, end: this.i } }
    if (c === '/') {
      this.i++
      while (this.i < s.length && !WS.has(s[this.i]!) && !DELIM.has(s[this.i]!)) this.i++
      const raw = s.slice(start, this.i)
      const name = raw.slice(1).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      return { kind: 'val', v: { name }, start, end: this.i, raw }
    }
    while (this.i < s.length && !WS.has(s[this.i]!) && !DELIM.has(s[this.i]!)) this.i++
    if (this.i === start) { this.i++; return { kind: 'op', op: c, start, end: this.i } }
    const w = s.slice(start, this.i)
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) return { kind: 'val', v: Number(w), start, end: this.i }
    if (w === 'true' || w === 'false') return { kind: 'val', v: w === 'true', start, end: this.i }
    if (w === 'null') return { kind: 'val', v: null, start, end: this.i }
    return { kind: 'op', op: w, start, end: this.i }
  }
  /** a (literal string), with its escapes and nested parentheses */
  private literal(): string {
    const s = this.s
    let depth = 0, out = ''
    this.i++
    while (this.i < s.length) {
      const c = s[this.i++]!
      if (c === '\\') {
        const e = s[this.i++]
        if (e === undefined) break
        const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
        if (map[e] !== undefined) out += map[e]
        else if (/[0-7]/.test(e)) {
          let oct = e
          while (oct.length < 3 && /[0-7]/.test(s[this.i] ?? '')) oct += s[this.i++]
          out += String.fromCharCode(parseInt(oct, 8) & 0xff)
        } else if (e === '\r') { if (s[this.i] === '\n') this.i++ } else if (e !== '\n') out += e
        continue
      }
      if (c === '(') depth++
      else if (c === ')') { if (depth === 0) break; depth-- }
      if (c === '\r') { if (s[this.i] === '\n') this.i++; out += '\n'; continue }
      out += c
    }
    return out
  }
  /** after the ID operator: skip an inline image's data up to its EI */
  skipInlineImage() {
    const re = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ]|$)/g
    re.lastIndex = this.i + 1
    const m = re.exec(this.s)
    this.i = m ? m.index + 3 : this.s.length
  }
}

/** Every operator of a content stream with its operands and where it starts and ends (operands included). */
export interface Instr { op: string; args: Val[]; start: number; end: number; raws: (string | undefined)[] }
export function* instructions(s: string): Generator<Instr> {
  const lx = new Lexer(s)
  let args: Val[] = [], raws: (string | undefined)[] = []
  let first = -1
  const stack: { arr: Val[]; dict: boolean }[] = []
  for (let t = lx.next(); t; t = lx.next()) {
    if (first < 0) first = t.start
    if (t.kind === '[' || t.kind === '<<') { stack.push({ arr: [], dict: t.kind === '<<' }); continue }
    if (t.kind === ']' || t.kind === '>>') {
      const top = stack.pop()
      const v: Val = !top ? null : top.dict ? { dict: true } : top.arr
      if (stack.length) stack[stack.length - 1]!.arr.push(v)
      else { args.push(v); raws.push(undefined) }
      continue
    }
    if (t.kind === 'val') {
      if (stack.length) stack[stack.length - 1]!.arr.push(t.v!)
      else { args.push(t.v!); raws.push(t.raw) }
      continue
    }
    if (stack.length) continue // an operator-like word inside an array or dictionary (broken content): skipped
    yield { op: t.op!, args, start: first, end: t.end, raws }
    if (t.op === 'ID') lx.skipInlineImage()
    args = []; raws = []; first = -1
  }
}

// ---------------------------------------------------------------- fonts

const K = (k: string) => PDFName.of(k)
const num = (o: PDFObject | undefined): number | undefined => (o instanceof PDFNumber ? o.asNumber() : undefined)
const nameStr = (o: PDFObject | undefined): string | undefined => (o instanceof PDFName ? o.decodeText() : undefined)
const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1')

/** a stream's decoded bytes as latin1 text, or null when it cannot be decoded */
export function streamText(o: PDFObject | undefined): string | null {
  try {
    if (o instanceof PDFRawStream) {
      if (o.dict.has(K('DecodeParms')) || o.dict.has(K('DP'))) return null
      return latin1(decodePDFRawStream(o).decode())
    }
    if (o instanceof PDFFlateStream) return latin1(o.getUnencodedContents())
  } catch { return null }
  return o === undefined ? '' : null
}

/** WinAnsi from pdf-lib's standard fonts: code -> [glyph name, letter], and glyph name -> letter */
let winAnsi: { byCode: Map<number, [string, string]>; byName: Map<string, string> } | null = null
function winAnsiTable() {
  if (winAnsi) return winAnsi
  const enc = embedderFor(StandardFonts.Helvetica).encoding
  const byCode = new Map<number, [string, string]>(), byName = new Map<string, string>()
  for (const cp of enc.supportedCodePoints) {
    const g = enc.encodeUnicodeCodePoint(cp)
    if (!byCode.has(g.code)) byCode.set(g.code, [g.name, String.fromCodePoint(cp)])
    if (!byName.has(g.name)) byName.set(g.name, String.fromCodePoint(cp))
  }
  winAnsi = { byCode, byName }
  return winAnsi
}
/** a glyph name's letters (the Adobe names WinAnsi uses, uniXXXX, uXXXX, a one-letter name), or '' */
function glyphLetters(name: string): string {
  const t = winAnsiTable()
  const base = name.split('.')[0]!
  if (t.byName.has(base)) return t.byName.get(base)!
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(base)
  if (m) return m[1]!.match(/.{4}/g)!.map((h) => String.fromCharCode(parseInt(h, 16))).join('')
  m = /^u([0-9A-F]{4,6})$/.exec(base)
  if (m) { const cp = parseInt(m[1]!, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : '' }
  return base.length === 1 ? base : ''
}

const STANDARD: Record<string, string> = {
  Helvetica: 'Helvetica', 'Helvetica-Bold': 'Helvetica-Bold', 'Helvetica-Oblique': 'Helvetica-Oblique', 'Helvetica-BoldOblique': 'Helvetica-BoldOblique',
  'Times-Roman': 'Times-Roman', 'Times-Bold': 'Times-Bold', 'Times-Italic': 'Times-Italic', 'Times-BoldItalic': 'Times-BoldItalic',
  Courier: 'Courier', 'Courier-Bold': 'Courier-Bold', 'Courier-Oblique': 'Courier-Oblique', 'Courier-BoldOblique': 'Courier-BoldOblique',
  Arial: 'Helvetica', 'Arial,Bold': 'Helvetica-Bold', 'Arial,Italic': 'Helvetica-Oblique', 'Arial,BoldItalic': 'Helvetica-BoldOblique',
  TimesNewRoman: 'Times-Roman', 'TimesNewRoman,Bold': 'Times-Bold', 'TimesNewRoman,Italic': 'Times-Italic', 'TimesNewRoman,BoldItalic': 'Times-BoldItalic',
  CourierNew: 'Courier', 'CourierNew,Bold': 'Courier-Bold', 'CourierNew,Italic': 'Courier-Oblique', 'CourierNew,BoldItalic': 'Courier-BoldOblique',
}

/** whether every letter of `text` is in WinAnsi (what the standard fonts draw) */
export function winAnsiCan(text: string): boolean {
  const enc = embedderFor(StandardFonts.Helvetica).encoding
  return [...text].every((ch) => enc.canEncodeUnicodeCodePoint(ch.codePointAt(0)!))
}

/** /FirstChar, /LastChar and /Widths for a standard font pdf-lib wrote without them (WinAnsi codes 32-255) */
export function writeStandardWidths(ctx: PDFContext, ref: PDFRef, name: StandardFonts) {
  const dict = ctx.lookup(ref)
  if (!(dict instanceof PDFDict) || dict.has(K('Widths'))) return
  const afm = embedderFor(name).font
  const names = winAnsiTable().byCode
  const widths: number[] = []
  for (let c = 32; c <= 255; c++) { const g = names.get(c); const w = g ? afm.getWidthOfGlyph(g[0]) : undefined; widths.push(typeof w === 'number' ? w : 0) }
  dict.set(K('FirstChar'), ctx.obj(32))
  dict.set(K('LastChar'), ctx.obj(255))
  dict.set(K('Widths'), ctx.obj(widths))
}

/** the look of a font, to choose a standard font close to it */
export interface FontStyle { family: 'sans' | 'serif' | 'mono'; bold: boolean; italic: boolean }
export function styleOf(baseFont: string): FontStyle {
  const n = baseFont.replace(/^[A-Z]{6}\+/, '')
  return {
    family: /courier|mono|consol|menlo|code/i.test(n) ? 'mono' : /times|(?<!sans)serif|roman|georgia|garamond|cambria|book|batang|myeongjo|mincho|song|ming/i.test(n) ? 'serif' : 'sans',
    bold: /bold|black|heavy|semibold|demi/i.test(n),
    italic: /italic|oblique/i.test(n),
  }
}

interface FontInfo {
  /** a reason the text in this font cannot be changed (vertical, an unknown encoding), or null */
  unsupported: string | null
  codeLen: 1 | 2
  /** width of a code in thousandths of the size */
  width(code: number): number
  /** a code's letters ('' when unknown) */
  letters(code: number): string
  /** a letter's code in this font (undefined: none) */
  encode(letter: string): number | undefined
  /** codes seen drawn on the page (an embedded font without a letter map can draw those) */
  seen: Set<number>
  /** whether the font holds a glyph for this code (an embedded subset holds only some) */
  canDraw(code: number): boolean
  embedded: boolean
  /** the font has a ToUnicode map (else its letters come from its encoding, and a viewer may read them differently) */
  mapped: boolean
  style: FontStyle
}

/** a ToUnicode CMap: code -> letters */
/** page content one replace_text reads at most (decoded bytes, all its pages together) */
export const PARSE_BYTES_MAX = 256 * 1024 * 1024

/** what reading one page found, kept for pages that draw the same content */
interface PageSummary { forms: boolean; unmapped: boolean; without: 'images' | 'forms' | 'noText' | null; noMap: boolean; formsNoMatch: boolean }
const ids = new WeakMap<object, number>()
let nextId = 1
const objectId = (o: object) => { let i = ids.get(o); if (i === undefined) { i = nextId++; ids.set(o, i) } return i }

/** strokes a page keeps as possible column lines */
export const RULES_MAX = 5000

/** matches on one page that one replace_text changes; more is refused (a one-letter find on a long page) */
export const PAGE_MATCHES_MAX = 2000

/** codes a font can have (two bytes) and the entries one font's letter map or widths may hold: a hostile bfrange or /W
 * range of 0 to 2^32 would otherwise fill memory (review of #1337) */
export const FONT_CODE_MAX = 0xffff
export const FONT_ENTRIES_MAX = 65_536

function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>()
  const put = (c: number, l: string) => { if (c >= 0 && c <= FONT_CODE_MAX && (map.size < FONT_ENTRIES_MAX || map.has(c))) map.set(c, l) }
  const utf16 = (s: string) => { let out = ''; for (let k = 0; k + 1 < s.length; k += 2) out += String.fromCharCode((s.charCodeAt(k) << 8) | s.charCodeAt(k + 1)); return out }
  const code = (s: string) => { let n = 0; for (const ch of s) n = n * 256 + ch.charCodeAt(0); return n }
  const lx = new Lexer(text)
  const vals: Lexed[] = []
  let mode: 'char' | 'range' | null = null
  for (let t = lx.next(); t; t = lx.next()) {
    if (t.kind === 'op' && (t.op === 'beginbfchar' || t.op === 'beginbfrange')) { mode = t.op === 'beginbfchar' ? 'char' : 'range'; vals.length = 0; continue }
    if (t.kind === 'op' && (t.op === 'endbfchar' || t.op === 'endbfrange')) {
      if (mode === 'char') {
        for (let k = 0; k + 1 < vals.length; k += 2) {
          const a = vals[k]!.v, b = vals[k + 1]!.v
          if (a && typeof a === 'object' && 'str' in a && b && typeof b === 'object' && 'str' in b) put(code(a.str), utf16(b.str))
        }
      } else if (mode === 'range') {
        for (let k = 0; k + 2 < vals.length;) {
          const lo = vals[k]!.v, hi = vals[k + 1]!.v
          if (!(lo && typeof lo === 'object' && 'str' in lo && hi && typeof hi === 'object' && 'str' in hi)) { k++; continue }
          const a = code(lo.str), b = Math.min(code(hi.str), FONT_CODE_MAX)
          if (vals[k + 2]!.kind === '[') {
            // [ <d1> <d2> … ]: one letter string per code
            let j = k + 3, c = a
            for (; j < vals.length && vals[j]!.kind !== ']'; j++, c++) { const d = vals[j]!.v; if (d && typeof d === 'object' && 'str' in d && c <= b) put(c, utf16(d.str)) }
            k = j + 1
          } else {
            const d = vals[k + 2]!.v
            if (d && typeof d === 'object' && 'str' in d) {
              const first = utf16(d.str)
              for (let c = a; c <= b && map.size < FONT_ENTRIES_MAX; c++) {
                const off = c - a
                put(c, first.slice(0, -1) + String.fromCharCode((first.charCodeAt(first.length - 1) + off) & 0xffff))
              }
            }
            k += 3
          }
        }
      }
      mode = null
      continue
    }
    if (mode) vals.push(t)
  }
  return map
}

function loadFont(ctx: PDFContext, dict: PDFDict): FontInfo {
  const sub = nameStr(dict.get(K('Subtype')))
  const base = nameStr(dict.get(K('BaseFont'))) ?? ''
  const style = styleOf(base)
  const toUniObj = ctx.lookup(dict.get(K('ToUnicode')))
  const toUniText = toUniObj instanceof PDFStream ? streamText(toUniObj) : null
  const toUni = toUniText ? parseToUnicode(toUniText) : null
  const seen = new Set<number>()
  if (sub === 'Type0') {
    const enc = nameStr(dict.get(K('Encoding')))
    const kids = ctx.lookup(dict.get(K('DescendantFonts')))
    const cid = kids instanceof PDFArray ? ctx.lookup(kids.get(0)) : undefined
    const desc = cid instanceof PDFDict ? ctx.lookup(cid.get(K('FontDescriptor'))) : undefined
    const embedded = desc instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => desc.has(K(k)))
    const dw = (cid instanceof PDFDict ? num(ctx.lookup(cid.get(K('DW')))) : undefined) ?? 1000
    const widths = new Map<number, number>()
    const setWidth = (c: number, v: number) => { if (Number.isInteger(c) && c >= 0 && c <= FONT_CODE_MAX && (widths.size < FONT_ENTRIES_MAX || widths.has(c))) widths.set(c, v) }
    const w = cid instanceof PDFDict ? ctx.lookup(cid.get(K('W'))) : undefined
    if (w instanceof PDFArray) {
      const a = w.asArray().map((x) => ctx.lookup(x))
      for (let k = 0; k < a.length;) {
        const c0 = num(a[k])
        if (c0 === undefined) break
        const nx = a[k + 1]
        if (nx instanceof PDFArray) {
          nx.asArray().forEach((x, j) => { const v = num(ctx.lookup(x)); if (v !== undefined) setWidth(c0 + j, v) })
          k += 2
        } else {
          const c1 = num(nx), v = num(a[k + 2])
          if (c1 === undefined || v === undefined) break
          for (let c = Math.max(0, c0); c <= Math.min(c1, FONT_CODE_MAX) && widths.size < FONT_ENTRIES_MAX; c++) setWidth(c, v)
          k += 3
        }
      }
    }
    const encode = new Map<string, number>()
    if (toUni) for (const [c, l] of toUni) if ([...l].length === 1 && !encode.has(l)) encode.set(l, c)
    // a predefined Unicode CMap (UniKS-UCS2-H, UniJIS-UCS2-H, …, as Korean and Japanese form generators write): the
    // code is the letter; the widths are by CID, which this tool does not map, so they are estimated
    if (enc && /^Uni\w+-UCS2-H$/.test(enc)) {
      const letters = (c: number) => toUni?.get(c) ?? (c >= 0xd800 && c < 0xe000 ? '' : String.fromCharCode(c))
      const code = (l: string) => encode.get(l) ?? (l.length === 1 && l >= ' ' && (l < '\ud800' || l >= '\ue000') ? l.charCodeAt(0) : undefined)
      return { unsupported: null, codeLen: 2, width: (c) => (c < 0x80 ? 500 : dw), letters, encode: code, seen, embedded, mapped: !!toUni, style, canDraw: (c) => !embedded || seen.has(c) }
    }
    return {
      unsupported: enc === 'Identity-V' ? 'vertical text' : enc === 'Identity-H' ? null : 'a font encoding this tool does not read',
      codeLen: 2, width: (c) => widths.get(c) ?? dw, letters: (c) => toUni?.get(c) ?? '', encode: (l) => encode.get(l), seen, embedded, mapped: !!toUni, style,
      canDraw: (c) => !embedded || !!toUni?.has(c) || seen.has(c),
    }
  }
  // a simple font: one byte per code
  const desc = ctx.lookup(dict.get(K('FontDescriptor')))
  const embedded = sub === 'Type3' || (desc instanceof PDFDict && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => desc.has(K(k))))
  const first = num(ctx.lookup(dict.get(K('FirstChar')))) ?? 0
  const wArr = ctx.lookup(dict.get(K('Widths')))
  const widthList = wArr instanceof PDFArray ? wArr.asArray().map((x) => num(ctx.lookup(x)) ?? 0) : null
  let scale = 1
  if (sub === 'Type3') {
    const fm = ctx.lookup(dict.get(K('FontMatrix')))
    scale = fm instanceof PDFArray ? (num(ctx.lookup(fm.get(0))) ?? 0.001) * 1000 : 1
  }
  const missing = (desc instanceof PDFDict ? num(ctx.lookup(desc.get(K('MissingWidth')))) : undefined) ?? 0
  // the glyph name of each code: the base encoding, then /Differences
  const names = new Map<number, string>()
  const t = winAnsiTable()
  const encObj = ctx.lookup(dict.get(K('Encoding')))
  const baseEnc = encObj instanceof PDFName ? encObj.decodeText() : encObj instanceof PDFDict ? nameStr(encObj.get(K('BaseEncoding'))) : undefined
  const symbolic = sub === 'Type3' || /Symbol|Dingbats/i.test(base)
  if (!symbolic || baseEnc) {
    for (const [c, [n]] of t.byCode) names.set(c, n)
    if (baseEnc === 'StandardEncoding' || (!baseEnc && !embedded)) { names.set(0x27, 'quoteright'); names.set(0x60, 'quoteleft') }
  }
  if (encObj instanceof PDFDict) {
    const diff = ctx.lookup(encObj.get(K('Differences')))
    if (diff instanceof PDFArray) {
      let c = 0
      for (const x of diff.asArray()) {
        const o = ctx.lookup(x)
        if (o instanceof PDFNumber) c = o.asNumber()
        else if (o instanceof PDFName) names.set(c++, o.decodeText())
      }
    }
  }
  const std = STANDARD[base.replace(/^[A-Z]{6}\+/, '').replace(/-(?=Bold|Italic)/, ',').replace(/PSMT$|MT$/, '')] ?? STANDARD[base]
  const afm = std && !widthList ? embedderFor(std as StandardFonts).font : null
  const width = (c: number): number => {
    if (widthList) { const v = widthList[c - first]; return (v ?? missing) * scale }
    if (afm) { const n = names.get(c); const v = n ? afm.getWidthOfGlyph(n) : undefined; return typeof v === 'number' ? v : 0 }
    return 500
  }
  const letters = (c: number): string => {
    const m = toUni?.get(c)
    if (m !== undefined) return m
    const n = names.get(c)
    if (n) return glyphLetters(n)
    return symbolic ? '' : c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ''
  }
  const encode = new Map<string, number>()
  for (let c = 0; c < 256; c++) {
    const l = letters(c)
    if ([...l].length === 1 && !encode.has(l) && (width(c) > 0 || l === ' ')) encode.set(l, c)
  }
  // an embedded font draws only the glyphs it holds: its letter map's, or the codes the page draws with it
  // a standard, not embedded font with a standard encoding reads the same everywhere: only an embedded or symbolic font
  // without ToUnicode may be read otherwise by a viewer
  return { unsupported: null, codeLen: 1, width, letters, encode: (l) => encode.get(l), seen, embedded, mapped: !!toUni || (!embedded && !symbolic), style, canDraw: (c) => !embedded || !!toUni?.has(c) || seen.has(c) }
}

// ---------------------------------------------------------------- reading a page

type M = [number, number, number, number, number, number]
const ID: M = [1, 0, 0, 1, 0, 0]
const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]]
const apply = (m: M, x: number, y: number) => ({ x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] })
const lin = (m: M, x: number, y: number) => ({ x: x * m[0] + y * m[2], y: x * m[1] + y * m[3] })

interface TextState { ctm: M; tc: number; tw: number; tz: number; tl: number; font: string | null; fontRaw: string; size: number; tr: number; ts: number; /** the fill's lightness, 0 black to 1 white; null: not a plain colour */ fill: number | null }
interface Glyph {
  code: number; bytes: string; letters: string
  /** the advance in text space (size, Tc, Tw), before horizontal scaling */
  adv: number
  /** start and advance vector of the glyph, and its height vector, in user space */
  x: number; y: number; dx: number; dy: number; hx: number; hy: number
  /** user-space length of one unit along the text line (text space x, scaled by Tz) */
  unit: number
  show: number; hidden: boolean; font: FontInfo | null
}
/** one text operator. `group`: the operators drawn one after the other from one placed start (no Td, Tm, T* or BT
 * between them) share it: moving the first moves them all */
/** a marked-content start (BDC) and where it is in the content; `actual`: its property list has /ActualText */
interface Marked { start: number; end: number; actual: boolean }
interface Show { start: number; end: number; op: string; group: number; marked: number[]; items: ({ n: number } | { glyphs: number[] })[]; st: TextState; aw?: number; ac?: number }

/** a straight upright stroke or box edge the page draws (a table's column rule), in user space */
interface Rule { x1: number; y1: number; x2: number; y2: number }
export interface PageText { glyphs: Glyph[]; shows: Show[]; marks: Marked[]; images: boolean; forms: boolean; rules: Rule[]; unmapped: boolean; text: string }

function readPage(ctx: PDFContext, res: PDFDict | undefined, content: string): PageText {
  const fonts = new Map<string, FontInfo | null>()
  const fontDict = res ? ctx.lookup(res.get(K('Font'))) : undefined
  const xobjects = res ? ctx.lookup(res.get(K('XObject'))) : undefined
  const fontOf = (name: string | null): FontInfo | null => {
    if (name === null) return null
    if (!fonts.has(name)) {
      const d = fontDict instanceof PDFDict ? ctx.lookup(fontDict.get(K(name))) : undefined
      let f: FontInfo | null = null
      try { f = d instanceof PDFDict ? loadFont(ctx, d) : null } catch { f = null }
      fonts.set(name, f)
    }
    return fonts.get(name)!
  }
  const glyphs: Glyph[] = [], shows: Show[] = []
  let images = false, forms = false, unmapped = false
  const marks: Marked[] = []
  /** the marked-content sections open now (indices into marks; -1 for a BMC) */
  const open: number[] = []
  const rules: Rule[] = []
  let cur: { x: number; y: number } | null = null
  const segment = (x0: number, y0: number, x1: number, y1: number) => {
    const a = apply(st.ctm, x0, y0), b = apply(st.ctm, x1, y1)
    // upright or level strokes only (a table's lines), at most RULES_MAX a page: a page of hatching is not a table
    if (rules.length < RULES_MAX && Math.hypot(b.x - a.x, b.y - a.y) > 2 && (Math.abs(b.x - a.x) < 0.5 || Math.abs(b.y - a.y) < 0.5)) rules.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
  }
  let st: TextState = { ctm: ID, tc: 0, tw: 0, tz: 100, tl: 0, font: null, fontRaw: '', size: 0, tr: 0, ts: 0, fill: 0 }
  const stack: TextState[] = []
  let tm: M = ID, tlm: M = ID
  let group = 0
  const n = (v: Val | undefined) => (typeof v === 'number' ? v : 0)
  const showStrings = (ins: Instr, items: (string | number)[]) => {
    const font = fontOf(st.font)
    const th = st.tz / 100
    const show: Show = { start: ins.start, end: ins.end, op: ins.op, group, marked: open.filter((x) => x >= 0), items: [], st: { ...st } }
    if (font && !font.mapped) unmapped = true
    const index = shows.push(show) - 1
    for (const it of items) {
      if (typeof it === 'number') {
        show.items.push({ n: it })
        tm = mul([1, 0, 0, 1, (-it / 1000) * st.size * th, 0], tm)
        continue
      }
      const list: number[] = []
      const len = font?.codeLen ?? 1
      for (let k = 0; k + len <= it.length; k += len) {
        const bytes = it.slice(k, k + len)
        const code = len === 1 ? bytes.charCodeAt(0) : (bytes.charCodeAt(0) << 8) | bytes.charCodeAt(1)
        const w0 = font ? font.width(code) : 0
        const adv = (w0 / 1000) * st.size + st.tc + (len === 1 && code === 32 ? st.tw : 0)
        const m = mul(tm, st.ctm)
        const o = apply(m, 0, st.ts)
        const a = lin(m, adv * th, 0)
        const h = lin(m, 0, st.size)
        const u = lin(m, th, 0)
        font?.seen.add(code)
        list.push(glyphs.push({ code, bytes, letters: font ? font.letters(code) : '', adv, x: o.x, y: o.y, dx: a.x, dy: a.y, hx: h.x, hy: h.y, unit: Math.hypot(u.x, u.y), show: index, hidden: st.tr === 3 || st.tr === 7, font }) - 1)
        tm = mul([1, 0, 0, 1, adv * th, 0], tm)
      }
      show.items.push({ glyphs: list })
    }
    return show
  }
  const strOf = (v: Val | undefined) => (v && typeof v === 'object' && 'str' in v ? v.str : '')
  for (const ins of instructions(content)) {
    const a = ins.args
    switch (ins.op) {
      case 'q': stack.push({ ...st }); break
      case 'Q': if (stack.length) st = stack.pop()!; break
      case 'cm': if (a.length >= 6) st.ctm = mul(a.slice(-6).map(n) as M, st.ctm); break
      case 'BT': tm = tlm = ID; group++; break
      case 'g': st.fill = n(a[0]); break
      case 'rg': st.fill = 0.3 * n(a[0]) + 0.59 * n(a[1]) + 0.11 * n(a[2]); break
      case 'k': st.fill = (1 - n(a[3])) * (1 - (0.3 * n(a[0]) + 0.59 * n(a[1]) + 0.11 * n(a[2]))); break
      case 'cs': st.fill = null; break
      case 'sc': case 'scn': st.fill = a.length === 1 && typeof a[0] === 'number' ? a[0] : a.length === 3 && a.every((x) => typeof x === 'number') ? 0.3 * n(a[0]) + 0.59 * n(a[1]) + 0.11 * n(a[2]) : null; break
      case 'Tc': st.tc = n(a[0]); break
      case 'Tw': st.tw = n(a[0]); break
      case 'Tz': st.tz = n(a[0]); break
      case 'TL': st.tl = n(a[0]); break
      case 'Tr': st.tr = n(a[0]); break
      case 'Ts': st.ts = n(a[0]); break
      case 'Tf': {
        const f = a[0]
        st.font = f && typeof f === 'object' && 'name' in f ? f.name : null
        st.fontRaw = ins.raws[0] ?? ''
        st.size = n(a[1])
        break
      }
      case 'Td': tlm = mul([1, 0, 0, 1, n(a[0]), n(a[1])], tlm); tm = tlm; group++; break
      case 'TD': st.tl = -n(a[1]); tlm = mul([1, 0, 0, 1, n(a[0]), n(a[1])], tlm); tm = tlm; group++; break
      case 'Tm': if (a.length >= 6) { tlm = tm = a.slice(-6).map(n) as M } group++; break
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm); tm = tlm; group++; break
      case 'Tj': showStrings(ins, [strOf(a[0])]); break
      case "'": tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm); tm = tlm; group++; showStrings(ins, [strOf(a[0])]); break
      case '"': {
        st.tw = n(a[0]); st.tc = n(a[1])
        tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm); tm = tlm; group++
        const s = showStrings(ins, [strOf(a[2])])
        s.aw = n(a[0]); s.ac = n(a[1])
        break
      }
      case 'TJ': {
        const arr = Array.isArray(a[0]) ? a[0] : []
        showStrings(ins, arr.map((x) => (typeof x === 'number' ? x : strOf(x))))
        break
      }
      case 'm': cur = { x: n(a[0]), y: n(a[1]) }; break
      case 'l': if (cur) segment(cur.x, cur.y, n(a[0]), n(a[1])); cur = { x: n(a[0]), y: n(a[1]) }; break
      case 're': {
        const [x, y, w, hh] = [n(a[0]), n(a[1]), n(a[2]), n(a[3])]
        segment(x, y, x, y + hh); segment(x + w, y, x + w, y + hh); segment(x, y, x + w, y); segment(x, y + hh, x + w, y + hh)
        break
      }
      case 'BDC': case 'BMC': {
        // only a BDC has properties; a BMC is kept on the stack (-1) so that EMC pops the right one
        if (ins.op === 'BDC') open.push(marks.push({ start: ins.start, end: ins.end, actual: /\/ActualText\b/.test(content.slice(ins.start, ins.end)) }) - 1)
        else open.push(-1)
        break
      }
      case 'EMC': open.pop(); break
      case 'BI': case 'ID': images = true; break
      case 'Do': {
        const nm = a[0] && typeof a[0] === 'object' && 'name' in a[0] ? a[0].name : ''
        const x = xobjects instanceof PDFDict ? ctx.lookup(xobjects.get(K(nm))) : undefined
        const subtype = x instanceof PDFStream ? nameStr(x.dict.get(K('Subtype'))) : undefined
        if (subtype === 'Image') images = true
        else if (subtype === 'Form') forms = true
        break
      }
    }
  }
  return { glyphs, shows, marks, images, forms, rules, unmapped, text: content }
}

// ---------------------------------------------------------------- finding words

const fold = (s: string, matchCase: boolean) => {
  const n = s.normalize('NFKC')
  if (matchCase) return n
  // lower case letter by letter, keeping the length (a few letters change length when lowered)
  return [...n].map((ch) => { const l = ch.toLowerCase(); return l.length === ch.length ? l : ch }).join('')
}

/** the page's letters in drawing order, with a space where the drawing leaves a gap or starts a new line; each letter
 * says which glyph it came from (-1: an inferred space) */
function pageLetters(p: PageText, matchCase: boolean): { text: string; from: number[] } {
  let text = ''
  const from: number[] = []
  let prev: Glyph | null = null
  // the last letter is kept apart: text.endsWith on a string grown with += flattens it at every call, which made a page
  // of a 2 MB stream take seconds (CI, re-review of #1337)
  let last = ''
  const space = () => { if (text && last !== ' ') { text += ' '; last = ' '; from.push(-1) } }
  for (const [i, g] of p.glyphs.entries()) {
    if (prev) {
      const ex = prev.x + prev.dx, ey = prev.y + prev.dy
      const len = Math.hypot(prev.dx, prev.dy) || 1
      const ux = prev.dx / len, uy = prev.dy / len
      const along = (g.x - ex) * ux + (g.y - ey) * uy
      const perp = Math.abs((g.x - ex) * uy - (g.y - ey) * ux)
      const h = Math.hypot(prev.hx, prev.hy) || 1
      if (perp > 0.5 * h || along > 0.25 * h || along < -0.5 * h) space()
    }
    const l = fold(g.letters, matchCase).replace(/\s+/g, ' ')
    for (let k = 0; k < l.length; k++) {
      if (l[k] === ' ') { space(); if (from[from.length - 1] === -1) from[from.length - 1] = i; continue }
      text += l[k]; last = l[k]!; from.push(i)
    }
    prev = g
  }
  return { text, from }
}

/** the glyphs of each match of `find` on the page, in order, not overlapping */
export function findMatches(p: PageText, find: string, matchCase: boolean): number[][] {
  const q = fold(find, matchCase).replace(/\s+/g, ' ').trim()
  if (!q) return []
  const { text, from } = pageLetters(p, matchCase)
  const out: number[][] = []
  for (let at = text.indexOf(q); at >= 0; at = text.indexOf(q, at + q.length)) {
    const g = [...new Set(from.slice(at, at + q.length).filter((x) => x >= 0))].sort((a, b) => a - b)
    if (g.length) out.push(g)
  }
  return out
}

/** One drawn letter for checking a signing place (files/pdf-marks-worker.ts): where it is in user space and how it is drawn. */
export interface DrawnGlyph {
  letters: string; code: number; font: unknown; mapped: boolean
  x: number; y: number; dx: number; dy: number; hx: number; hy: number
  /** text render mode; the fill's lightness (null: not a plain colour); inside marked content with /ActualText */
  tr: number; fill: number | null; actual: boolean
}
/** The letters page content draws directly (not those inside a Form XObject). Null when its content cannot be decoded. */
export function drawnGlyphs(doc: PDFDocument, pageIndex: number): DrawnGlyph[] | null {
  const page = doc.getPage(pageIndex)
  const content = contentOf(doc.context, page)
  if (content === null) return null
  const p = readPage(doc.context, resourcesOf(doc.context, page), content)
  return p.glyphs.map((g) => {
    const show = p.shows[g.show]!
    return { letters: g.letters, code: g.code, font: g.font, mapped: !!g.font?.mapped, x: g.x, y: g.y, dx: g.dx, dy: g.dy, hx: g.hx, hy: g.hy, tr: show.st.tr, fill: show.st.fill, actual: show.marked.some((i) => p.marks[i]?.actual) }
  })
}

/** a page's text as this tool reads it (for tests and messages) */
export function pageTextOf(doc: PDFDocument, pageIndex: number): string {
  const page = doc.getPage(pageIndex)
  const content = contentOf(doc.context, page)
  if (content === null) return ''
  return pageLetters(readPage(doc.context, resourcesOf(doc.context, page), content), true).text
}

// ---------------------------------------------------------------- changing a page

function resourcesOf(ctx: PDFContext, page: PDFPage): PDFDict | undefined {
  const r = ctx.lookup(page.node.getInheritableAttribute(K('Resources')))
  return r instanceof PDFDict ? r : undefined
}
/** the page's content streams joined (a token never spans two of them), or null when one cannot be decoded */
function contentOf(ctx: PDFContext, page: PDFPage): string | null {
  const c = ctx.lookup(page.node.get(K('Contents')))
  const list = c instanceof PDFArray ? c.asArray().map((x) => ctx.lookup(x)) : c === undefined ? [] : [c]
  const texts = list.map((s) => streamText(s))
  return texts.includes(null) ? null : texts.join('\n')
}

/** a number as a content stream writes it: never exponent form (1e+21), never NaN; clamped to what readers take */
export const fmt = (v: number) => {
  const c = Number.isFinite(v) ? Math.max(-1e9, Math.min(1e9, v)) : 0
  const t = c.toFixed(3).replace(/\.?0+$/, '')
  return t === '-0' || t === '-' || t === '' ? '0' : t
}
const hex = (bytes: string) => '<' + [...bytes].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase() + '>'

/** What to write for the new words at one spot. */
interface Insert {
  /** the font resource token to switch to ('' = the original font at the original size: no switch) */
  fontTok: string
  size: number
  /** the new words' codes (bytes as latin1) */
  bytes: string
  /** their advance in text space before horizontal scaling */
  adv: number
}

export interface ReplaceOutcome {
  replaced: number; hidden: number; skipped: string[]; smaller: number; overlap: number; wider: number; fonts: Set<string>
  /** /ActualText entries taken out of marked-content sections around removed words */
  actualText: number
  /** pages read whose other content this tool does not change: drawn blocks (form XObjects), annotations (comments,
   * form fields, links), fonts without a ToUnicode map (a viewer may read their letters otherwise) */
  caveats: { forms: Set<number>; annots: Set<number>; unmapped: Set<number> }
  /** pages read with no match, by what they draw (see replaceOnPage) */
  noMatch: Map<string, PageSummary>
  /** page content read so far, decoded bytes */
  parsedBytes: number
}

/** a BDC's operands and operator without the /ActualText entry of its property list */
export function withoutActualText(bdc: string): string {
  const lit = '\\((?:\\\\[\\s\\S]|[^\\\\()]|\\((?:\\\\[\\s\\S]|[^\\\\()]|\\((?:\\\\[\\s\\S]|[^\\\\()])*\\))*\\))*\\)'
  return bdc.replace(new RegExp(`/ActualText(?![^\\s\\0/<>\\[\\](){}%])\\s*(?:${lit}|<[0-9A-Fa-f\\s]*>)`, 'g'), '')
}
/** a standard font, or the server's font for other letters, for new words the page's own font cannot draw */
export type FallbackFont = (text: string, style: FontStyle) => Promise<PDFFont>

/**
 * Replace every match of `find` on page `pageIndex` (0-based) with `replace`. Returns what was done; the page's
 * Contents is a new stream when anything changed.
 */
export async function replaceOnPage(doc: PDFDocument, pageIndex: number, find: string, replace: string, matchCase: boolean, fallback: FallbackFont, out: ReplaceOutcome & { pagesWithout: { images: number[]; forms: number[]; noText: number[]; noMap: number[] } }): Promise<number> {
  const ctx = doc.context
  const page = doc.getPage(pageIndex)
  // pdf-lib's own wrap of the page (q … Q), once, before its content is read; new fonts are added to the page later
  page.node.normalize()
  const res = resourcesOf(ctx, page)
  const annots = ctx.lookup(page.node.get(K('Annots')))
  if (annots instanceof PDFArray && annots.size() > 0) out.caveats.annots.add(pageIndex + 1)
  // pages that draw the very same content with the same resources (a template, a scan of the same form) read the same:
  // one with no match is not read again (review of #1337: 3,000 pages sharing one 28 MB stream)
  const c = ctx.lookup(page.node.get(K('Contents')))
  const parts = (c instanceof PDFArray ? c.asArray().map((x) => ctx.lookup(x)) : [c]).filter((x): x is PDFObject => !!x)
  const key = [...parts.map(objectId), res ? objectId(res) : 0].join(',')
  const apply = (sum: PageSummary) => {
    const n = pageIndex + 1
    if (sum.forms) out.caveats.forms.add(n)
    if (sum.unmapped) out.caveats.unmapped.add(n)
    if (sum.without) out.pagesWithout[sum.without].push(n)
    if (sum.noMap) out.pagesWithout.noMap.push(n)
    if (sum.formsNoMatch && !out.pagesWithout.forms.includes(n)) out.pagesWithout.forms.push(n)
  }
  const known = out.noMatch.get(key)
  if (known) { apply(known); return 0 }
  const content = contentOf(ctx, page)
  if (content === null) throw new ToolError(`what page ${pageIndex + 1} draws cannot be read (it may be damaged), so its text cannot be changed`, 'pdf_invalid')
  out.parsedBytes += content.length
  if (out.parsedBytes > PARSE_BYTES_MAX) throw new ToolError(`these pages draw more than ${PARSE_BYTES_MAX / 1024 / 1024} MB of content, too much to read in one replace_text; give fewer pages (pages: "1-50"), one call each`)
  const p = readPage(ctx, res, content)
  const visible = p.glyphs.some((g) => g.letters.trim() && !g.hidden)
  const summary: PageSummary = {
    forms: p.forms, unmapped: p.unmapped,
    without: visible || p.glyphs.some((g) => g.hidden) ? null : p.images ? 'images' : p.forms ? 'forms' : 'noText',
    noMap: p.glyphs.length > 0 && p.glyphs.every((g) => !g.letters),
    formsNoMatch: false,
  }
  const matches = findMatches(p, find, matchCase)
  if (matches.length > PAGE_MATCHES_MAX) throw new ToolError(`${JSON.stringify(find.slice(0, 40))} is on page ${pageIndex + 1} more than ${PAGE_MATCHES_MAX.toLocaleString('en')} times; give longer words to find, so that only the places meant are changed`)
  if (!matches.length) {
    summary.formsNoMatch = p.forms
    out.noMatch.set(key, summary)
    apply(summary)
    return 0
  }
  apply(summary)
  // first every match that can be changed, so the room for each new text knows all that goes
  const removed = new Set<number>()
  const todo: number[][] = []
  for (const m of matches) {
    const glyphs = m.map((i) => p.glyphs[i]!)
    if (glyphs.some((g) => g.hidden)) { out.hidden++; continue }
    const bad = glyphs.find((g) => !g.font || g.font.unsupported)
    if (bad) { out.skipped.push(bad.font?.unsupported ?? 'a font this tool cannot read'); continue }
    if (p.shows[glyphs[0]!.show]!.st.size === 0) { out.skipped.push('text of size 0'); continue }
    for (const i of m) removed.add(i)
    todo.push(m)
    out.replaced++
  }
  if (!removed.size) return 0
  // a run (one text operator) closes up over what is taken out of it: each kept glyph moves back by the width
  // removed before it in its run (user space, along the line)
  const width = (g: Glyph) => Math.hypot(g.dx, g.dy)
  const shift = new Map<number, number>()
  // indexed once: each glyph's group, each group's glyphs and first operator (review of #1337: per-match scans of
  // every glyph made a page with many matches quadratic)
  const groupIx = p.glyphs.map((g) => p.shows[g.show]!.group)
  const groupOf = (gi: number) => groupIx[gi]!
  const groupGlyphs = new Map<number, number[]>()
  groupIx.forEach((gr, i) => { const l = groupGlyphs.get(gr); if (l) l.push(i); else groupGlyphs.set(gr, [i]) })
  /** groups that draw some visible letter */
  const groupShown = new Set(groupIx.filter((_, i) => !p.glyphs[i]!.hidden && p.glyphs[i]!.letters.trim()))
  /** the first operator of each group (where a move of the whole group goes) */
  const groupStart = new Map<number, number>()
  p.shows.forEach((sh, i) => { if (!groupStart.has(sh.group)) groupStart.set(sh.group, i) })
  let gone = 0
  for (const [si, show] of p.shows.entries()) {
    if (si === groupStart.get(show.group)) gone = 0
    for (const it of show.items) if ('glyphs' in it) for (const gi of it.glyphs) { if (removed.has(gi)) gone += width(p.glyphs[gi]!); else shift.set(gi, gone) }
  }
  const inserts = new Map<number, Insert>()
  /** runs after new words on their line, moved along it by this much (user space) */
  const pushes = new Map<number, number>()
  const keys = new Map<PDFFont, string>()
  const newWords = replace.normalize('NFC')
  for (const m of newWords ? todo : []) {
    const first = p.glyphs[m[0]!]!
    const st = p.shows[first.show]!.st
    const len = Math.hypot(first.dx, first.dy) || 1
    const ux = first.dx / len || 1, uy = first.dy / len
    const h = Math.hypot(first.hx, first.hy) || 1
    const along = (g: Glyph) => (g.x - first.x) * ux + (g.y - first.y) * uy
    const sameLine = (g: Glyph) => Math.abs((g.x - first.x) * uy - (g.y - first.y) * ux) < 0.5 * h
    // The new words go where the first old glyph was and the rest of its run follows them (it closes up over what was
    // taken out). The words after them on the line that are drawn on their own (a run of their own, placed where it
    // is) follow too when they are part of the same text: each run that starts within about a letter's height of the
    // one before. A larger gap is another column (a table, a form): it does not move, and the line must not reach it.
    let oldEnd = 0
    for (const i of m) { const g = p.glyphs[i]!; if (sameLine(g)) oldEnd = Math.max(oldEnd, along(g) + width(g)) }
    const runs = new Map<number, { start: number; end: number; firstKept: number }>()
    let ownEnd = oldEnd, textRight = -Infinity
    for (const [gr, list] of groupGlyphs) {
      // a group is one placed run: on one line. Its ends say where it is; only a group on this line is read glyph by glyph
      const g0 = p.glyphs[list[0]!]!, g1 = p.glyphs[list[list.length - 1]!]!
      if (!sameLine(g0) && !sameLine(g1)) {
        if (groupShown.has(gr)) textRight = Math.max(textRight, along(g0) + width(g0), along(g1) + width(g1))
        continue
      }
      for (const i of list) {
        const g = p.glyphs[i]!
        if (g.hidden || !g.letters.trim() || !sameLine(g)) continue
        const a = along(g)
        if (gr === groupOf(m[0]!)) { ownEnd = Math.max(ownEnd, a + width(g)); continue }
        if (a < 0.1 * h) continue
        const r = runs.get(groupOf(i)) ?? { start: Infinity, end: -Infinity, firstKept: -1 }
        r.start = Math.min(r.start, a); r.end = Math.max(r.end, a + width(g))
        if (r.firstKept < 0 && !removed.has(i)) r.firstKept = i
        runs.set(groupOf(i), r)
      }
    }
    const chain: number[] = []
    let lineEnd = ownEnd, column = Infinity
    for (const [si, r] of [...runs.entries()].sort((x, y) => x[1].start - y[1].start)) {
      if (r.start - lineEnd > 1.0 * h) { column = r.start; break }
      chain.push(si)
      lineEnd = Math.max(lineEnd, r.end)
    }
    // a rule the line crosses after the old words (a table's column line) is a column too
    for (const r of p.rules) {
      const a1 = (r.x1 - first.x) * ux + (r.y1 - first.y) * uy, a2 = (r.x2 - first.x) * ux + (r.y2 - first.y) * uy
      const p1 = (r.x1 - first.x) * uy - (r.y1 - first.y) * ux, p2 = (r.x2 - first.x) * uy - (r.y2 - first.y) * ux
      // across the line (it spans the text's height there), and after the old words' run
      if (Math.abs(a1 - a2) > 0.2 * h || Math.min(p1, p2) > -0.5 * h || Math.max(p1, p2) < 0.05 * h) continue
      const at = (a1 + a2) / 2
      if (at > lineEnd - 0.05 * h && at < column) column = at
    }
    // the page's edge (its visible box), less a small margin, along the line
    const box = page.getCropBox()
    const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]] as const
    const edge = Math.max(...corners.map(([cx, cy]) => (cx - first.x) * ux + (cy - first.y) * uy)) - Math.max(0.5 * h, 10)
    const limit = Math.min(edge, column === Infinity ? Infinity : column - Math.max(0, Math.min(column - lineEnd, 0.3 * h)))
    // the original font, when it can draw every letter
    const font = first.font!
    const codes: number[] = []
    for (const ch of newWords) {
      const c = font.encode(ch)
      if (c === undefined || !font.canDraw(c)) { codes.length = 0; break }
      codes.push(c)
    }
    const spaceTw = (c: number) => (font.codeLen === 1 && c === 32 ? st.tw : 0)
    let ins: Insert
    let full: (size: number) => number
    if (codes.length === [...newWords].length) {
      const bytes = codes.map((c) => (font.codeLen === 1 ? String.fromCharCode(c) : String.fromCharCode(c >> 8, c & 0xff))).join('')
      full = (sz) => codes.reduce((t, c) => t + (font.width(c) / 1000) * sz + st.tc + spaceTw(c), 0)
      ins = { fontTok: '', size: st.size, bytes, adv: full(st.size) }
      out.fonts.add('the original')
    } else {
      const f = await fallback(newWords, font.style)
      let key = keys.get(f)
      if (!key) { key = page.node.newFontDictionary('Fr', f.ref).toString(); keys.set(f, key) }
      const encoded = f.encodeText(newWords).toString()
      const bytes = encoded.slice(1, -1).match(/../g)?.map((h2) => String.fromCharCode(parseInt(h2, 16))).join('') ?? ''
      const single = /^(Helvetica|Times|Courier)/.test(f.name)
      const spaces = single ? [...newWords].filter((ch) => ch === ' ').length : 0
      const count = [...newWords].length
      // letter by letter: pdf-lib's width of a whole text adds kerning, which a plain show does not
      const perSize = [...newWords].reduce((t, ch) => t + f.widthOfTextAtSize(ch, 1), 0)
      full = (sz) => perSize * sz + count * st.tc + spaces * st.tw
      ins = { fontTok: key, size: st.size, bytes, adv: full(st.size) }
      out.fonts.add(f.name)
    }
    // a line that would reach the next column or the page's edge: the new words smaller, down to 60%; when even that
    // does not fit, they keep their size (half-size words that still overlap help nobody) and the AI is told
    const userW = (sz: number) => full(sz) * first.unit
    const reach = (sz: number) => lineEnd + userW(sz) - oldEnd
    if (reach(st.size) > limit + 0.05 * h && userW(st.size) > oldEnd) {
      if (reach(st.size * 0.6) > limit + 0.05 * h) out.overlap++
      else {
        let lo = st.size * 0.6, hi = st.size
        for (let k = 0; k < 20; k++) { const mid = (lo + hi) / 2; if (reach(mid) > limit) hi = mid; else lo = mid }
        out.smaller++
        ins = { ...ins, fontTok: ins.fontTok || st.fontRaw, size: lo, adv: full(lo) }
      }
    }
    const moved = userW(ins.size) - oldEnd
    if (moved > 0.05 * h && textRight > -Infinity && reach(ins.size) > textRight + 0.5 * h) out.wider++
    for (const si of chain) {
      const r = runs.get(si)!
      if (r.firstKept < 0) continue
      // a run that starts with the end of these old words closes up over them: it moves that much further
      const ownGone = m.filter((i) => groupOf(i) === si && i < r.firstKept).reduce((t, i) => t + width(p.glyphs[i]!), 0)
      const at = groupStart.get(si)!
      pushes.set(at, (pushes.get(at) ?? 0) + moved + ownGone)
    }
    inserts.set(m[0]!, ins)
  }
  // rewrite each text operator that has a removed glyph, an insert or a move; the new content is built in one pass
  const affected = [...new Set([...[...removed].map((i) => p.glyphs[i]!.show), ...pushes.keys()])].sort((a, b) => a - b)
  const edits: { start: number; end: number; text: string }[] = []
  // a marked-content section around removed words whose /ActualText says what it reads (a copy, a screen reader):
  // that text goes too, else the old words are still there for anyone who copies the line
  const stripMarks = new Set<number>()
  for (const i of removed) for (const k of p.shows[p.glyphs[i]!.show]!.marked) if (p.marks[k]!.actual) stripMarks.add(k)
  for (const k of stripMarks) {
    const mk = p.marks[k]!
    edits.push({ start: mk.start, end: mk.end, text: withoutActualText(content.slice(mk.start, mk.end)) })
  }
  out.actualText += stripMarks.size
  for (const si of affected) {
    const show = p.shows[si]!
    const st = show.st
    const parts: string[] = []
    let arr: string[] = []
    let pendingHex = '', pendingNum = 0
    const flushHex = () => { if (pendingHex) { arr.push(hex(pendingHex)); pendingHex = '' } }
    const flushNum = () => { if (Math.abs(pendingNum) > 1e-9) { arr.push(fmt(pendingNum)); pendingNum = 0 } }
    const pushNum = (v: number) => { flushHex(); pendingNum += v }
    const pushBytes = (b: string) => { flushNum(); pendingHex += b }
    const closeArr = () => { flushHex(); flushNum(); if (arr.length) parts.push(`[${arr.join(' ')}] TJ`); arr = [] }
    // the glyphs of the run in order, so a kerning number between two removed glyphs goes with them
    const order = show.items.flatMap((it) => ('glyphs' in it ? it.glyphs : []))
    let seen = 0
    const push = pushes.get(si)
    // the group's first glyph says how long one unit along the line is (the same for the whole group)
    const unit = p.glyphs[groupGlyphs.get(show.group)?.[0] ?? -1]?.unit ?? 0
    if (push && unit && st.size) pushNum((-push * 1000) / (st.size * unit))
    for (const it of show.items) {
      if ('n' in it) {
        const before = order[seen - 1], after = order[seen]
        if (!(before !== undefined && after !== undefined && removed.has(before) && removed.has(after))) pushNum(it.n)
        continue
      }
      for (const gi of it.glyphs) {
        seen++
        const ins = inserts.get(gi)
        if (ins) {
          if (!ins.fontTok) pushBytes(ins.bytes)
          else {
            closeArr()
            parts.push(`${ins.fontTok} ${fmt(ins.size)} Tf [${hex(ins.bytes)}] TJ ${st.fontRaw} ${fmt(st.size)} Tf`)
          }
        }
        // a removed glyph is left out: the rest of the run closes up behind the new words
        if (!removed.has(gi)) pushBytes(p.glyphs[gi]!.bytes)
      }
    }
    closeArr()
    const prefix = show.op === "'" ? 'T* ' : show.op === '"' ? `${fmt(show.aw ?? 0)} Tw ${fmt(show.ac ?? 0)} Tc T* ` : ''
    // a show with nothing left still writes an empty array, so the operator count and positions stay simple
    const body = parts.length ? parts.join(' ') : '[] TJ'
    edits.push({ start: show.start, end: show.end, text: prefix + body })
  }
  edits.sort((a, b) => a.start - b.start)
  const pieces: string[] = []
  let at = 0
  for (const e of edits) { pieces.push(content.slice(at, e.start), e.text); at = e.end }
  pieces.push(content.slice(at))
  const text = pieces.join('')
  const stream = ctx.flateStream(Buffer.from(text, 'latin1'))
  page.node.set(K('Contents'), ctx.obj([ctx.register(stream)]))
  // pdf-lib's page keeps the stream it draws into (add_text, a stamp): it is in the new stream now, so a later drawing
  // starts a new one (private fields of the pinned pdf-lib 1.17.1)
  const drawn = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown }
  drawn.contentStream = undefined
  drawn.contentStreamRef = undefined
  return removed.size
}

/** after the pages were rewritten: every object the document no longer reaches (the old content streams) is deleted,
 * so a save (a full rewrite) does not carry the old words */
export function dropUnreached(doc: PDFDocument) {
  const ctx = doc.context
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
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!live.has(ref)) ctx.delete(ref)
}

/** what the search for leftover words may read: decoded bytes and time. Past either it says so instead of failing
 * (review of #1337: 3,000 pages sharing one 28 MB stream were parsed once per page) */
export const ELSEWHERE_BYTES_MAX = 64 * 1024 * 1024
export const ELSEWHERE_MS_MAX = 3000
/** the words for a search that ran out of its budget */
export const NOT_ALL_CHECKED = 'could not check the whole file (it is large), so the old words may be in more places'

/**
 * Where else in the file the words still are, after replace_text changed the page text: this is not a redaction tool,
 * so the AI is told and tells the person (review of #1337). Read: the document properties (Info) and XMP metadata,
 * bookmark titles, comments and form-field values (annotation /Contents, /V and field /V), accessibility text (/Alt,
 * /ActualText of the structure tree and of marked content), and any other text string. Marked content in the page
 * content is read only on `pages` (0-based, the pages replace_text read), each content stream once, and parsed only when
 * its bytes name /ActualText or hold the words. Within a byte and time budget; past it, NOT_ALL_CHECKED is in the list.
 */
export function wordsElsewhere(doc: PDFDocument, find: string, matchCase: boolean, pages: number[], budget = { bytes: ELSEWHERE_BYTES_MAX, ms: ELSEWHERE_MS_MAX }): string[] {
  const ctx = doc.context
  const q = fold(find, matchCase).replace(/\s+/g, ' ').trim()
  if (!q) return []
  const has = (t: string) => fold(t, matchCase).replace(/\s+/g, ' ').includes(q)
  const where = new Set<string>()
  const t0 = Date.now()
  let bytes = 0, out = false
  /** charge n bytes; false (and the note) once the budget is gone */
  const spend = (n: number) => {
    if (out) return false
    bytes += n
    if (bytes > budget.bytes || Date.now() - t0 > budget.ms) { out = true; where.add(NOT_ALL_CHECKED); return false }
    return true
  }
  const KIND: Record<string, string> = {
    Title: 'bookmark or document titles', Contents: 'comments or annotation text', V: 'form field values', DV: 'form field values',
    Alt: 'accessibility text (/Alt)', ActualText: 'accessibility text (/ActualText)', E: 'accessibility text', T: 'form field names',
    Subject: 'document properties', Keywords: 'document properties', Author: 'document properties', Creator: 'document properties', Producer: 'document properties',
  }
  const info = ctx.lookup(ctx.trailerInfo.Info)
  const textOf = (o: PDFObject | undefined): string | null => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : null)
  const seen = new Set<PDFObject>()
  const walk = (o: PDFObject | undefined, key: string, depth: number, inInfo: boolean) => {
    if (!o || depth > 40 || out) return
    if (o instanceof PDFRef) { const l = ctx.lookup(o); if (l && !seen.has(l)) { seen.add(l); walk(l, key, depth + 1, l === info) } return }
    const t = textOf(o)
    if (t !== null) { if (spend(t.length) && has(t)) where.add(inInfo ? 'document properties' : KIND[key] ?? 'other text in the file'); return }
    if (o instanceof PDFArray) { for (const x of o.asArray()) walk(x, key, depth + 1, inInfo); return }
    const d = o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : null
    if (!d || !spend(16)) return
    if (o instanceof PDFStream && (d.get(K('Type')) === K('Metadata') || d.get(K('Subtype')) === K('XML'))) {
      const x = spend(o instanceof PDFRawStream ? o.contents.length : 0) ? streamText(o) : null
      if (x !== null && spend(x.length) && has(Buffer.from(x, 'latin1').toString('utf8'))) where.add('XMP metadata')
    }
    for (const [k, v] of d.entries()) {
      if (k === K('Parent') || k === K('P') || k === K('Pg')) continue
      walk(v, k.decodeText(), depth + 1, inInfo)
    }
  }
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    if (out) break
    if (!seen.has(o)) { seen.add(o); walk(o, '', 0, o === info) }
  }
  // marked-content property lists written in the page content (BDC <</ActualText (...)>>): the pages read, each stream once
  const latinFind = /^[\x20-\x7e]+$/.test(find) ? find : null
  const streams = new Set<PDFObject>()
  for (const i of pages) {
    if (out || i < 0 || i >= doc.getPageCount()) continue
    const c = ctx.lookup(doc.getPage(i).node.get(K('Contents')))
    for (const s of c instanceof PDFArray ? c.asArray().map((x) => ctx.lookup(x)) : [c]) {
      if (!s || streams.has(s) || out) continue
      streams.add(s)
      if (!spend(s instanceof PDFRawStream ? s.contents.length : 0)) break
      const content = streamText(s)
      if (!content || !spend(content.length)) continue
      // parse only when a marked-content property could hold the words
      if (!content.includes('BDC') || !(content.includes('ActualText') || (latinFind !== null && content.includes(latinFind)) || content.includes('\xfe\xff'))) continue
      for (const ins of instructions(content)) {
        if (ins.op !== 'BDC') continue
        const lx = new Lexer(content.slice(ins.start, ins.end))
        for (let t = lx.next(); t; t = lx.next()) {
          const v = t.v
          if (!(v && typeof v === 'object' && 'str' in v)) continue
          const be = Buffer.from(v.str.slice(2), 'latin1')
          const str = v.str.startsWith('\xfe\xff') ? Buffer.from(be.subarray(0, be.length - (be.length % 2))).swap16().toString('utf16le') : v.str
          if (has(str)) where.add(`marked-content text on page ${i + 1}`)
        }
        if (Date.now() - t0 > budget.ms) { out = true; where.add(NOT_ALL_CHECKED); break }
      }
    }
  }
  return [...where]
}
