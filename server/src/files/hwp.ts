// Text of Hangul (한글) documents for read/grep: .hwp (HWP 5.x, an OLE compound file of zlib-compressed record
// streams) and .hwpx (OWPML, a zip of XML). Korean offices and public bodies send forms and notices in these, and
// pandoc / pdftotext don't read them. Pure TypeScript like SheetJS for xlsx (SheetJS's CFB reads both containers),
// run in the office worker (office-parse.ts), never in the server process, with caps against decompression bombs:
// a .hwpx zip is checked first (zip-guard.ts), a .hwp body stream inflates to at most STREAM_MAX and all of them
// together to at most INFLATE_TOTAL_MAX. Distribution (배포용) and password-protected .hwp keep
// their body encrypted: only the preview text (PrvText, the first page or so) comes out, with a note.
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { checkZip, isZip, tooComplex } from './zip-guard'

const TEXT_MAX = 8 * 1024 * 1024
const STREAM_MAX = 64 * 1024 * 1024
const INFLATE_TOTAL_MAX = 200 * 1024 * 1024
const SECTIONS_MAX = 500

interface Entry { path: string; content: Uint8Array }

const asBytes = (v: Uint8Array | number[] | undefined) => (v instanceof Uint8Array ? v : Uint8Array.from(v ?? []))

function entries(bytes: Uint8Array): Entry[] {
  if (isZip(bytes)) checkZip(bytes)
  let c: { FullPaths: string[]; FileIndex: { content?: Uint8Array | number[] }[] }
  try { c = XLSX.CFB.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { type: 'buffer' }) } catch { throw new ToolError('could not read this Hangul document (damaged or not a .hwp / .hwpx file)') }
  return c.FullPaths.map((p: string, i: number): Entry => ({ path: p.replace(/^Root Entry\//, ''), content: asBytes(c.FileIndex[i]?.content) }))
    .filter((e: Entry) => e.content.length > 0)
}

const sectionNo = (p: string) => Number(/(\d+)(?:\.xml)?$/.exec(p)?.[1] ?? 0)

// ---------------- .hwpx ----------------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))

/**
 * Paragraphs (<hp:p>) of the section XML files in order; text runs are <hp:t>, with tabs and line breaks inside them.
 * Paragraphs nest (a picture caption or table cell inside a paragraph): each gets its line where it opens, so the
 * text around a caption doesn't run into it (same order as the .hwp records).
 */
export function hwpxText(bytes: Uint8Array): string {
  const all = entries(bytes)
  const sections = all.filter((e) => /^Contents\/section\d+\.xml$/i.test(e.path)).sort((a, b) => sectionNo(a.path) - sectionNo(b.path))
  if (!sections.length) throw new ToolError('could not read this Hangul document (no sections found in the .hwpx)')
  const header = all.find((e) => /^Contents\/header\.xml$/i.test(e.path))
  const outline = header ? hwpxOutline(new TextDecoder('utf-8').decode(header.content)) : new Map<string, number>()
  const out: string[] = []
  /** line index -> heading level (1-7) of the paragraphs whose paragraph shape is an outline level (개요) */
  const heads = new Map<number, number>()
  let size = 0
  for (const s of sections.slice(0, SECTIONS_MAX)) {
    const xml = new TextDecoder('utf-8').decode(s.content)
    const open: number[] = [] // line index of each open paragraph
    let inText = false
    let last = 0
    for (const m of xml.matchAll(/<(\/?)(?:\w+:)?(p|t|tab|lineBreak)\b[^>]*?(\/?)>/g)) {
      const [tag, close, name, selfClose] = m as unknown as [string, string, string, string]
      if (inText && open.length) out[open.at(-1)!] += unescapeXml(xml.slice(last, m.index).replace(/<[^>]+>/g, ''))
      last = m.index! + tag.length
      if (name === 'p') {
        if (close) open.pop()
        else if (!selfClose) {
          const level = outline.get(attrOf(tag, 'paraPrIDRef') ?? '')
          if (level !== undefined) heads.set(out.length, level)
          open.push(out.length); out.push('')
        }
      } else if (name === 't') inText = !close && !selfClose
      else if (inText && open.length) out[open.at(-1)!] += name === 'tab' ? '\t' : '\n'
    }
    size = out.reduce((n, l) => n + l.length, 0)
    if (size > TEXT_MAX) break
  }
  return tidy(withHeadings(out, heads))
}

const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

/** Paragraph shapes of a .hwpx header that are outline levels: id -> heading level 1-7 (<hh:heading type="OUTLINE"
 * level="0"> is 개요 1). Linear: each shape is cut at its end tag before it is searched. */
export function hwpxOutline(xml: string): Map<string, number> {
  const out = new Map<string, number>()
  const open = /<(?:\w+:)?paraPr\b[^>]*>/g
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const id = attrOf(m[0], 'id')
    const end = xml.indexOf('paraPr>', m.index + m[0].length)
    const body = xml.slice(m.index + m[0].length, end < 0 ? xml.length : end)
    const h = /<(?:\w+:)?heading\b[^>]*>/.exec(body)
    if (id !== undefined && h && attrOf(h[0], 'type') === 'OUTLINE') {
      const level = Number(attrOf(h[0], 'level') ?? 0)
      if (Number.isInteger(level) && level >= 0 && level <= 9) out.set(id, Math.min(level + 1, 6))
    }
    if (end < 0) break
    open.lastIndex = end
  }
  return out
}

/** Markdown heading marks for the heading paragraphs (line index -> level); a body line that starts like one gets a
 * space in front (also through tidy's trim), so only headings start a line with `#` (files/locations.ts). That holds
 * for each line of a paragraph: text after a hard line break can start with `#` too. */
function withHeadings(lines: string[], heads: Map<number, number>): string {
  return lines.map((l, i) => {
    const level = heads.get(i)
    const text = l.replace(/\s+/g, ' ').trim()
    if (level !== undefined && text) return `${'#'.repeat(level)} ${text}`
    return l.split('\n').map((part) => (/^\s*#{1,6}(?:\s|$)/.test(part) ? QUOTED + part.trimStart() : part)).join('\n')
  }).join('\n')
}
/** a body line's mark until tidy() has run (its trim would take a leading space of the first line) */
const QUOTED = '\u0002'


// ---------------- .hwp (HWP 5.x) ----------------
const TAG_PARA_HEADER = 66
const TAG_PARA_TEXT = 67
// control characters inside PARA_TEXT (HWP 5.0 spec 4.3.10.1.1): "char" controls take one WCHAR, inline and extended
// controls take eight (the code, six WCHARs of data, the code again)
const ONE_WCHAR = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31])

function paraText(rec: Uint8Array): string {
  const v = new DataView(rec.buffer, rec.byteOffset, rec.byteLength)
  let s = ''
  for (let i = 0; i + 1 < rec.length;) {
    const c = v.getUint16(i, true)
    if (c >= 32) { s += String.fromCharCode(c); i += 2; continue }
    if (c === 9) s += '\t'
    else if (c === 10) s += '\n'
    i += ONE_WCHAR.has(c) ? 2 : 16
  }
  return s
}

function inflate(data: Uint8Array, left: number): Uint8Array {
  if (left <= 0) throw tooComplex(`the body expands to more than ${INFLATE_TOTAL_MAX / 1024 / 1024} MB`)
  try { return zlib.inflateRawSync(data, { maxOutputLength: Math.min(STREAM_MAX, left) }) } catch (e) {
    if (left < STREAM_MAX && (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw tooComplex(`the body expands to more than ${INFLATE_TOTAL_MAX / 1024 / 1024} MB`)
    throw new ToolError('could not read this Hangul document (a body section is damaged or too large)')
  }
}

const TAG_PARA_SHAPE = 25

/** The paragraph shapes of a DocInfo stream that are outline levels (개요): shape id (their order) -> level 1-7.
 * PARA_SHAPE attribute 1, bits 23-24: the paragraph head kind (1: outline), bits 25-27: its level (0-6). */
export function hwpOutline(docInfo: Uint8Array): Map<number, number> {
  const v = new DataView(docInfo.buffer, docInfo.byteOffset, docInfo.byteLength)
  const out = new Map<number, number>()
  let id = 0
  for (let i = 0; i + 4 <= docInfo.length;) {
    const h = v.getUint32(i, true)
    i += 4
    const tag = h & 0x3ff
    let len = h >>> 20
    if (len === 0xfff) { if (i + 4 > docInfo.length) break; len = v.getUint32(i, true); i += 4 }
    if (i + len > docInfo.length) break
    if (tag === TAG_PARA_SHAPE) {
      if (len >= 4) {
        const a = v.getUint32(i, true)
        if (((a >>> 23) & 3) === 1) out.set(id, Math.min(((a >>> 25) & 7) + 1, 6))
      }
      id++
    }
    i += len
  }
  return out
}

/** The text records of one BodyText/SectionN stream, a paragraph per line (heading paragraphs, by their paragraph
 * shape in `outline`, as Markdown headings). */
export function sectionText(stream: Uint8Array, outline: Map<number, number> = new Map()): string {
  const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const paras: string[] = []
  const heads = new Map<number, number>()
  let cur: string | null = null
  let size = 0
  for (let i = 0; i + 4 <= stream.length;) {
    const h = v.getUint32(i, true)
    i += 4
    const tag = h & 0x3ff
    let len = h >>> 20
    if (len === 0xfff) { if (i + 4 > stream.length) break; len = v.getUint32(i, true); i += 4 }
    if (i + len > stream.length) break
    if (tag === TAG_PARA_HEADER) {
      if (cur !== null) paras.push(cur)
      cur = ''
      const level = len >= 10 ? outline.get(v.getUint16(i + 8, true)) : undefined
      if (level !== undefined) heads.set(paras.length, level)
    }
    else if (tag === TAG_PARA_TEXT) { const t = paraText(stream.subarray(i, i + len)); cur = (cur ?? '') + t; size += t.length }
    i += len
    if (size > TEXT_MAX) break
  }
  if (cur !== null) paras.push(cur)
  return withHeadings(paras, heads)
}

export function hwpText(bytes: Uint8Array): string {
  const all = entries(bytes)
  const header = all.find((e) => e.path === 'FileHeader')?.content
  if (!header || header.length < 40 || new TextDecoder('latin1').decode(header.subarray(0, 17)) !== 'HWP Document File') {
    throw new ToolError('could not read this Hangul document (not an HWP 5 file; HWP 3 and older are not supported)')
  }
  const flags = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(36, true)
  const compressed = (flags & 1) !== 0
  const locked = (flags & 2) !== 0 || (flags & 4) !== 0
  const preview = () => {
    const p = all.find((e) => e.path === 'PrvText')?.content
    return p ? new TextDecoder('utf-16le').decode(p).replace(/\0+$/, '') : ''
  }
  if (locked) {
    const p = preview()
    return tidy(`[Only the preview text of this document can be read: it is a distribution-only or password-protected HWP file.]\n\n${p}`)
  }
  const sections = all.filter((e) => /^BodyText\/Section\d+$/.test(e.path)).sort((a, b) => sectionNo(a.path) - sectionNo(b.path))
  if (!sections.length) return tidy(preview())
  let left = INFLATE_TOTAL_MAX
  // the paragraph shapes that are outline levels (headings); a DocInfo that cannot be read only loses the headings
  let outline = new Map<number, number>()
  const docInfo = all.find((e) => e.path === 'DocInfo')?.content
  if (docInfo) {
    try {
      const d = compressed ? inflate(docInfo, left) : docInfo
      left -= d.byteLength
      outline = hwpOutline(d)
    } catch (e) { if (String((e as Error).message).startsWith('too large or too complex')) throw e }
  }
  const texts: string[] = []
  let size = 0
  for (const s of sections.slice(0, SECTIONS_MAX)) {
    const body = compressed ? inflate(s.content, left) : s.content
    left -= body.byteLength
    const t = sectionText(body, outline)
    texts.push(t)
    size += t.length
    if (size > TEXT_MAX) break
  }
  return tidy(texts.join('\n'))
}

/** No trailing spaces, at most one empty line in a row, capped. */
function tidy(s: string): string {
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, TEXT_MAX).replace(/^\u0002/gm, ' ')
}
