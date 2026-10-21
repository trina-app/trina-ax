// Text of Hangul (한글) documents for read/grep: .hwp (HWP 5.x, an OLE compound file of zlib-compressed record
// streams) and .hwpx (OWPML, a zip of XML). Korean offices and public bodies send forms and notices in these, and
// pandoc / pdftotext don't read them. Pure TypeScript in-process like SheetJS for xlsx (SheetJS's CFB reads both
// containers), with output caps against decompression bombs. Distribution (배포용) and password-protected .hwp keep
// their body encrypted: only the preview text (PrvText, the first page or so) comes out, with a note.
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'

const TEXT_MAX = 8 * 1024 * 1024
const STREAM_MAX = 64 * 1024 * 1024
const SECTIONS_MAX = 500

interface Entry { path: string; content: Uint8Array }

const asBytes = (v: Uint8Array | number[] | undefined) => (v instanceof Uint8Array ? v : Uint8Array.from(v ?? []))

function entries(bytes: Uint8Array): Entry[] {
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
  const sections = entries(bytes).filter((e) => /^Contents\/section\d+\.xml$/i.test(e.path)).sort((a, b) => sectionNo(a.path) - sectionNo(b.path))
  if (!sections.length) throw new ToolError('could not read this Hangul document (no sections found in the .hwpx)')
  const out: string[] = []
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
        else if (!selfClose) { open.push(out.length); out.push('') }
      } else if (name === 't') inText = !close && !selfClose
      else if (inText && open.length) out[open.at(-1)!] += name === 'tab' ? '\t' : '\n'
    }
    size = out.reduce((n, l) => n + l.length, 0)
    if (size > TEXT_MAX) break
  }
  return tidy(out.join('\n'))
}

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

function inflate(data: Uint8Array): Uint8Array {
  try { return zlib.inflateRawSync(data, { maxOutputLength: STREAM_MAX }) } catch { throw new ToolError('could not read this Hangul document (a body section is damaged or too large)') }
}

/** The text records of one BodyText/SectionN stream, a paragraph per line. */
export function sectionText(stream: Uint8Array): string {
  const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const paras: string[] = []
  let cur: string | null = null
  let size = 0
  for (let i = 0; i + 4 <= stream.length;) {
    const h = v.getUint32(i, true)
    i += 4
    const tag = h & 0x3ff
    let len = h >>> 20
    if (len === 0xfff) { if (i + 4 > stream.length) break; len = v.getUint32(i, true); i += 4 }
    if (i + len > stream.length) break
    if (tag === TAG_PARA_HEADER) { if (cur !== null) paras.push(cur); cur = '' }
    else if (tag === TAG_PARA_TEXT) { const t = paraText(stream.subarray(i, i + len)); cur = (cur ?? '') + t; size += t.length }
    i += len
    if (size > TEXT_MAX) break
  }
  if (cur !== null) paras.push(cur)
  return paras.join('\n')
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
    return tidy(`[Only the preview text of this document can be read: it is a distribution or password-protected HWP file.]\n\n${p}`)
  }
  const sections = all.filter((e) => /^BodyText\/Section\d+$/.test(e.path)).sort((a, b) => sectionNo(a.path) - sectionNo(b.path))
  if (!sections.length) return tidy(preview())
  return tidy(sections.slice(0, SECTIONS_MAX).map((s) => sectionText(compressed ? inflate(s.content) : s.content)).join('\n'))
}

/** No trailing spaces, at most one empty line in a row, capped. */
function tidy(s: string): string {
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, TEXT_MAX)
}
