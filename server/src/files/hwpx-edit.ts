// edit_hwpx (stage 2 of Hangul documents): the text of an EXISTING .hwpx changed in place, everything else kept as it
// was. Runs ONLY in the office worker (files/office-worker.ts, isolated like the readers), never in the server
// process: the document is an untrusted zip. The server frames the request and reads the result back (tools/edit-hwpx.ts).
//
// Changes (hwpx-check.ts HwpxChange), all found in the document as it was read, never in each other's results:
// - { find, replace }: exact text inside one paragraph (a placeholder such as {{이름}} too); more than one match needs
//   `occurrence` or `all`. The new text goes into the text it replaces and takes its formatting.
// - { cell, value }: an empty table cell, found next to a label cell or by table / row / column, gets the text.
// - { add_rows }: rows added to a table, each a copy of one row's cells (borders, sizes, paragraph and character shape)
//   with new text; the rows below move down, the table's row count, height and cell zones follow.
// Paragraph text only: no new styles, the header is not touched.
//
// The patch: each section is tokenized with the offsets of every tag (after the XML parser of hwpx-write.ts has
// checked it), and only these bytes change: the text replaced, an empty cell's text, the rows put in, the cell
// addresses of the rows below and the table's counts, and the layout cache (hp:linesegarray) of each paragraph whose
// text changed, and of the paragraph holding a table that got rows: Hangul draws new text into stale cached lines
// (overlapping glyphs), and lays out a paragraph without one when it opens the file. Every other byte of a section
// stays, and every other part of the zip is copied with its compressed bytes as they were. When a change cannot be
// applied exactly, it is refused with the reason and nothing is written.
//
// The document is untrusted. Kept as data and passed through untouched: every element and part we do not change,
// known to us or not (pictures, fields, drawings, memos, unknown elements). Refused, so it never reaches a saved file:
// what can run or open something (scripts, OLE objects and other compound files, programs, links to local files,
// programs or network shares, a linked document), what a change would break (a digital signature, encryption), and
// what the parser cannot vouch for (a DTD, comments, CDATA, processing instructions, unknown namespaces on Hangul's
// prefixes). Limits as for templates, larger for a whole document.
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { hwpxOutline, hwpxText } from './hwp'
import {
  cleanText, decodeHwpxEditRequest, encodeHwpxEditResult, firstDifference, HWPX_EDIT_MAX, HWPX_TEXT_MAX, hwpxParagraphLines,
  hwpxReadLines, applyLineEdits, type HwpxChange, type HwpxEditNote, type HwpxEditReport, type LineEdit,
} from './hwpx-check'
import { NS_ATTRS } from './hwpx-template'
import { assertKnown, assertPlainPackage, escText, isCompoundFile, parseXml, type Refuse } from './hwpx-write'
import { checkZip, isZip } from './zip-guard'
import { readZip, writeZip, type ZipEntry, type ZipRead } from './zip-write'

const MIB = 1024 * 1024
export const HWPX_EDIT_LIMITS = {
  bytes: HWPX_EDIT_MAX,
  expanded: 200 * MIB,
  entries: 2000,
  /** one XML part, uncompressed */
  xmlBytes: 64 * MIB,
  sections: 500,
  /** elements of one section */
  nodes: 1_000_000,
  changes: 100,
  /** matches one change may replace (all: true) */
  matches: 10_000,
  newRows: 500,
  rowCells: 64,
  valueChars: 20_000,
}

const DOC_BAD = 'this .hwpx cannot be changed'
const docRefuse: Refuse = (part, why) => { throw new ToolError(`${DOC_BAD} (${part}: ${why}); nothing was saved`) }
function refuseDoc(why: string): never { throw new ToolError(`${DOC_BAD}: ${why}; nothing was saved`) }
function refuseChange(i: number, why: string): never { throw new ToolError(`change ${i + 1}: ${why}. Nothing was saved.`) }
const clip = (s: string, n = 80) => JSON.stringify(s.length > n ? s.slice(0, n) + '…' : s)
const strip = (s: string) => s.replace(/\s+/g, '')

// ---------------------------------------------------------------- the package
/** part names of programs and scripts, and the first bytes of programs (PE, ELF, Mach-O, Java, a script's #!) */
const PROGRAM_NAME = /\.(exe|dll|com|scr|pif|cpl|msi|msp|bat|cmd|vbs|vbe|js|jse|mjs|wsf|wsh|ps1|psm1|sh|bash|zsh|py|pl|rb|jar|class|hta|lnk|reg|dylib|so)$/i
function isProgram(b: Uint8Array): boolean {
  if (b.length < 4) return false
  const h = Buffer.from(b.subarray(0, 4)).toString('hex')
  return h.startsWith('4d5a') || h === '7f454c46' || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(h) || h.startsWith('2321')
}
/** A reference out of the document that Hangul could follow: a local or network file, a program, a script URL, any
 * scheme:// but the web's and mail, at the start of a value; a file:, script or network-share reference anywhere in
 * it. Format characters (zero-width spaces, direction marks) are taken out first, and Hangul's "\:" in a link's
 * command read as ":". */
const OUTSIDE = /^\s*(?:file\s*:|\\\\|\/\/|[a-z]\s*:\s*[\\/]|(?:javascript|vbscript|data|jar|smb|nfs|afp|shell|hcp|search-ms|ms-[a-z0-9-]+)\s*:|(?!(?:https?|ftp|mailto)\s*:)[a-z][a-z0-9+.-]*\s*:\s*\/\/)/i
const OUTSIDE_ANYWHERE = /(?:file|javascript|vbscript)\s*:|\\\\[^\\\s]/i
const plainValue = (v: string) => v.replace(/\p{Cf}/gu, '').replace(/\\:/g, ':')
const outside = (v: string) => { const s = plainValue(v); return OUTSIDE.test(s) || OUTSIDE_ANYWHERE.test(s) }
/** A hyperlink's target (the parameters of a HYPERLINK field) may only be a web or mail address, or a name inside the
 * document (no path, drive, scheme or environment variable): a relative path such as ..\\x.exe opens a program too. */
const badLinkTarget = (v: string) => { const s = plainValue(v).trim(); return !/^(?:https?|ftp):\/\/|^mailto:/i.test(s) && /[\\/:%]/.test(s) }
/** markup in an attribute value: a web page embedded in an object (a web video's tag) */
const MARKUP = /<\s*[a-z!/?]/i
const local = (name: string) => name.slice(name.indexOf(':') + 1)
/** bytes that read as XML: a byte order mark, or "<" after white space */
function looksXml(b: Uint8Array): boolean {
  if ((b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return true
  for (let i = 0; i < Math.min(b.length, 256); i++) { const c = b[i]!; if (c === 0x3c) return true; if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false }
  return false
}

interface Package { entries: ZipRead[]; parts: Map<string, Uint8Array>; xml: Map<string, string> }

function openPackage(bytes: Uint8Array): Package {
  const L = HWPX_EDIT_LIMITS
  if (bytes.length > L.bytes) refuseDoc(`it is larger than ${L.bytes / MIB} MB`)
  if (!isZip(bytes)) refuseDoc(isCompoundFile(bytes) ? 'it is a .hwp file; open it in Hangul and save it as .hwpx first' : 'it is not a .hwpx file')
  try { checkZip(bytes, { total: L.expanded, entries: L.entries }) } catch (e) {
    const m = String((e as Error).message)
    refuseDoc(/encrypted/.test(m) ? 'it is encrypted' : `it is damaged or too large (${m.replace(/^.*?\(/, '').replace(/\).*$/, '').slice(0, 120)})`)
  }
  let entries: ZipRead[]
  try { entries = readZip(bytes) } catch (e) { return refuseDoc(`its zip container is damaged (${String((e as Error).message).slice(0, 120)})`) }
  const parts = new Map(entries.map((e) => [e.name, e.data]))
  const xml = new Map<string, string>()
  const text = (n: string): string | null => {
    if (xml.has(n)) return xml.get(n)!
    const b = parts.get(n)
    if (!b) return null
    if (b.length > L.xmlBytes) refuseDoc(`${n} is larger than ${L.xmlBytes / MIB} MB`)
    let s: string
    // a byte order mark stays in the string, so that what is written again is the same bytes
    try { s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b) } catch { return refuseDoc(`${n} is not UTF-8`) }
    xml.set(n, s)
    return s
  }
  assertPlainPackage(parts, text, refuseDoc)
  for (const e of entries) {
    if (isCompoundFile(e.data)) refuseDoc(`${e.name} is an embedded compound file (an OLE object or a .hwp)`)
    if (PROGRAM_NAME.test(e.name) || isProgram(e.data)) refuseDoc(`${e.name} is a program or a script`)
    if (/^META-INF\/[^/]*signature/i.test(e.name)) refuseDoc('it is digitally signed, and a change would break the signature')
  }
  // every XML part, by its name or by its bytes (whatever its name, the manifest can point Hangul at it; the preview
  // text is plain text): well-formed, no DTD, comments, CDATA or processing instructions, Hangul's prefixes, no OLE
  // object; no reference out of the document in an attribute or a field's parameter (hp:stringParam), no markup in an
  // attribute, no linked document or picture, and every part the manifest or the container names is in the file
  const names = new Set(entries.map((e) => e.name))
  for (const e of entries) {
    if (!/\.(xml|hpf|rdf)$/i.test(e.name) && (e.name === 'Preview/PrvText.txt' || !looksXml(e.data))) continue
    const s = text(e.name)!
    if (/<(?:\w+:)?ole\b/i.test(s)) refuseDoc(`${e.name} contains an embedded OLE object`)
    const fields: string[] = []
    parseXml(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s, e.name, {
      refuse: docRefuse, maxNodes: L.nodes,
      visit: {
        open(el, a) {
          const l = local(el)
          if (l === 'fieldBegin') fields.push(a.get('type') ?? '')
          // a manifest item or a container's root file: a part of this file, embedded
          const ref = l === 'item' ? a.get('href') : l === 'rootfile' ? a.get('full-path') : undefined
          if (ref === undefined) return
          if (l === 'item' && a.get('isEmbeded')?.trim() === '0') docRefuse(e.name, 'it links a file outside the document')
          if (outside(ref) || /^[\\/]|(^|[\\/])\.\.([\\/]|$)/.test(ref.trim())) docRefuse(e.name, `it links a file outside the document (${clip(ref, 60)})`)
          if (ref.trim() && !names.has(ref.trim())) docRefuse(e.name, `it names a part that is not in the file (${clip(ref, 60)})`)
        },
        close(el) { if (local(el) === 'fieldBegin') fields.pop() },
        attr(el, k, v) {
          if (/^xmlns(:|$)/.test(k)) return
          const l = local(el)
          if (l === 'linkinfo' && k === 'path' && v.trim()) docRefuse(e.name, 'it is linked to another document')
          if (outside(v)) docRefuse(e.name, `${el} refers to a file, program or address outside the document (${k}=${clip(v, 60)})`)
          if (MARKUP.test(v)) docRefuse(e.name, `${el} holds markup in ${k} (an embedded web page)`)
        },
        text(el, t) {
          if (local(el) !== 'stringParam') return
          if (outside(t)) docRefuse(e.name, `a field refers to a file, program or address outside the document (${clip(t, 60)})`)
          if (fields.includes('HYPERLINK') && badLinkTarget(t)) docRefuse(e.name, `a link points at something that is not a web or mail address (${clip(t, 60)})`)
        },
      },
    })
  }
  return { entries, parts, xml }
}

// ---------------------------------------------------------------- a section, tokenized with offsets
interface El {
  name: string; local: string
  start: number; openEnd: number; closeStart: number; end: number
  self: boolean; parent: El | null; kids: (El | Txt)[]
}
interface Txt { start: number; end: number; parent: El }
const isEl = (k: El | Txt): k is El => 'name' in k
const kidEls = (e: El, name?: string) => e.kids.filter((k): k is El => isEl(k) && (!name || k.name === name))

/** The end (index after '>') of the tag that starts at `start`, quotes respected. */
function tagEnd(xml: string, start: number): number {
  let q = ''
  for (let i = start + 1; i < xml.length; i++) {
    const ch = xml[i]
    if (q) { if (ch === q) q = ''; continue }
    if (ch === '"' || ch === "'") q = ch
    else if (ch === '>') return i + 1
  }
  return refuseDoc('a section is damaged (an unfinished tag)')
}

/** The element tree of a section the XML parser has accepted, with the offset of every tag; text is kept only inside
 * elements named t (paragraph text, as hwp.ts reads it). */
function tokenize(xml: string): El {
  const root: El = { name: '#document', local: '#document', start: 0, openEnd: 0, closeStart: xml.length, end: xml.length, self: false, parent: null, kids: [] }
  const stack: El[] = [root]
  let inT = 0
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0
  for (;;) {
    const lt = xml.indexOf('<', i)
    const top = stack[stack.length - 1]!
    if (lt < 0) break
    if (lt > i && inT > 0) top.kids.push({ start: i, end: lt, parent: top })
    if (xml.startsWith('<?', lt)) { i = xml.indexOf('?>', lt) + 2; continue }
    if (xml.startsWith('<!', lt)) refuseDoc('a section has comments, CDATA or a DTD')
    if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt)
      const el = stack.pop()!
      if (xml.slice(lt + 2, gt).trim() !== el.name) refuseDoc('a section is damaged (a closing tag does not match)')
      el.closeStart = lt
      el.end = gt + 1
      if (el.local === 't') inT--
      i = gt + 1
      continue
    }
    const gt = tagEnd(xml, lt)
    const name = /^<([^\s/>]+)/.exec(xml.slice(lt, Math.min(gt, lt + 300)))?.[1] ?? refuseDoc('a section is damaged (a tag without a name)')
    const self = xml.charCodeAt(gt - 2) === 47
    const el: El = { name, local: local(name), start: lt, openEnd: gt, closeStart: self ? gt : -1, end: self ? gt : -1, self, parent: top, kids: [] }
    top.kids.push(el)
    if (!self) { stack.push(el); if (el.local === 't') inT++ }
    i = gt
  }
  if (stack.length !== 1) refuseDoc('a section is damaged (an element is not closed)')
  return root
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const ENTITY = /&(#x[0-9a-f]+|#\d+|\w+);/gi
/** what hp:t text reads as (the same decoding as hwp.ts) */
const unescape = (s: string) => s.replace(ENTITY, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m))
/** the offset in raw XML text of character `k` of what it reads as */
function rawIndex(raw: string, k: number): number {
  // text without entities (nearly all) reads as it is written
  if (!raw.includes('&')) return k
  let d = 0, i = 0
  while (i < raw.length && d < k) {
    if (raw[i] === '&') {
      const semi = raw.indexOf(';', i)
      const m = semi > i ? /^&(#x[0-9a-f]+|#\d+|\w+);$/i.exec(raw.slice(i, semi + 1)) : null
      if (m) { d += unescape(m[0]).length; i += m[0].length; continue }
    }
    d++; i++
  }
  if (d !== k) refuseDoc('a change would split a character written as an entity')
  return i
}

/** The attributes of an open tag in order, each with the range of its value inside the quotes (offsets in `tag`). One
 * scan from the start, so a name inside another attribute's quoted value is never taken for an attribute. */
function tagAttrs(tag: string): { name: string; value: string; start: number; end: number }[] {
  const out: { name: string; value: string; start: number; end: number }[] = []
  for (const m of tag.matchAll(/\s([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const raw = m[2] ?? m[3] ?? ''
    const end = m.index! + m[0].length - 1
    out.push({ name: m[1]!, value: unescape(raw), start: end - raw.length, end })
  }
  return out
}
function attrsOf(xml: string, el: El): Map<string, string> {
  return new Map(tagAttrs(xml.slice(el.start, el.openEnd)).map((a) => [a.name, a.value]))
}
/** the range of an attribute's value (inside its quotes) in the open tag of `el`, in the section */
function attrRange(xml: string, el: El, name: string): [number, number] | null {
  const a = tagAttrs(xml.slice(el.start, el.openEnd)).find((x) => x.name === name)
  return a ? [el.start + a.start, el.start + a.end] : null
}
/** an open tag with one attribute's value replaced (unchanged when it has none) */
function withAttr(tag: string, name: string, value: string): string {
  const a = tagAttrs(tag).find((x) => x.name === name)
  return a ? tag.slice(0, a.start) + value + tag.slice(a.end) : tag
}

// ---------------------------------------------------------------- paragraphs and tables
/** A piece of a paragraph's text: `text` is a text node directly in hp:p > hp:run > hp:t (the only kind a change may
 * write in), `locked` text elsewhere in the paragraph, `tab` / `br` what hwp.ts reads as a tab or a line break, and
 * `other` an element in the paragraph that holds no text of its own (a field, a picture, a table, a mark). */
interface Seg { kind: 'text' | 'locked' | 'tab' | 'br' | 'other'; at: number; len: number; text: string; node?: Txt; el?: El; run?: El; t?: El }
interface Para {
  i: number; sec: number; el: El; heading: number
  segs: Seg[]; text: string; lineseg: El | null
  /** characters so far, while the paragraph is read */
  len: number
  /** the table cell the paragraph is directly in */
  cell?: Cell
}
interface Cell { el: El; table: Table; row: number; col: number; rowSpan: number; colSpan: number; height: number; paras: Para[]; addr: El | null }
interface Table { i: number; sec: number; el: El; rows: El[]; cells: Cell[]; para: Para | null }
interface Section { name: string; xml: string; root: El }

class Doc {
  readonly sections: Section[] = []
  readonly paras: Para[] = []
  readonly tables: Table[] = []
  readonly byEl = new Map<El, Para>()
  readonly outline: Map<string, number>

  constructor(pkg: Package) {
    const names = [...pkg.parts.keys()].filter((n) => /^Contents\/section\d+\.xml$/i.test(n) && pkg.parts.get(n)!.length > 0)
      .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)![1]) - Number(/(\d+)\.xml$/i.exec(b)![1]))
    if (!names.length) refuseDoc('it has no sections (Contents/section0.xml)')
    if (names.length > HWPX_EDIT_LIMITS.sections) refuseDoc(`it has more than ${HWPX_EDIT_LIMITS.sections} sections`)
    const header = [...pkg.parts.keys()].find((n) => /^Contents\/header\.xml$/i.test(n))
    this.outline = header ? hwpxOutline(pkg.xml.get(header) ?? new TextDecoder().decode(pkg.parts.get(header))) : new Map()
    let chars = 0
    for (const name of names) {
      const xml = pkg.xml.get(name)!
      const sec: Section = { name, xml, root: tokenize(xml) }
      this.sections.push(sec)
      this.walk(sec, this.sections.length - 1, sec.root, null, null)
    }
    for (const p of this.paras) { p.text = p.segs.map((s) => s.text).join(''); chars += p.text.length }
    if (chars > HWPX_TEXT_MAX) refuseDoc(`its text is longer than ${HWPX_TEXT_MAX.toLocaleString('en')} characters`)
    for (const s of this.sections) this.findTables(s, this.sections.indexOf(s), s.root)
  }

  private walk(sec: Section, si: number, el: El, para: Para | null, inT: El | null) {
    const xml = sec.xml
    const push = (s: Omit<Seg, 'at'>) => { if (para) { para.segs.push({ ...s, at: para.len } as Seg); para.len += s.len } }
    for (const k of el.kids) {
      if (!isEl(k)) {
        if (para && inT) {
          const text = unescape(xml.slice(k.start, k.end))
          const direct = k.parent === inT && inT.name === 'hp:t' && inT.parent?.name === 'hp:run' && inT.parent.parent === para.el && para.el.name === 'hp:p'
          push({ kind: direct ? 'text' : 'locked', len: text.length, text, node: k, t: inT, run: inT.parent ?? undefined })
        }
        continue
      }
      if (k.local === 'p' && !k.self) {
        const tag = xml.slice(k.start, k.openEnd)
        const level = this.outline.get(/\sparaPrIDRef="([^"]*)"/.exec(tag)?.[1] ?? '')
        const p: Para = { i: this.paras.length, sec: si, el: k, heading: level ?? 0, segs: [], text: '', lineseg: null, len: 0 }
        this.paras.push(p)
        this.byEl.set(k, p)
        this.walk(sec, si, k, p, inT)
        continue
      }
      if (para && inT) {
        // inside hp:t: tab and line break read as characters (open and close tag each, as hwp.ts counts them)
        if (k.local === 'tab' || k.local === 'lineBreak') {
          const ch = k.local === 'tab' ? '\t' : '\n'
          const text = k.self ? ch : ch + ch
          push({ kind: k.local === 'tab' ? 'tab' : 'br', len: text.length, text, el: k })
        } else {
          push({ kind: 'other', len: 0, text: '', el: k })
          this.walk(sec, si, k, para, inT)
        }
        continue
      }
      if (para && k.local === 't') { this.walk(sec, si, k, para, k); continue }
      if (para && el === para.el && k.name === 'hp:linesegarray') { para.lineseg = k; continue }
      if (para && (el === para.el || (el.local === 'run' && el.parent === para.el)) && k.local !== 'run') push({ kind: 'other', len: 0, text: '', el: k })
      this.walk(sec, si, k, para, inT)
    }
  }

  private findTables(sec: Section, si: number, el: El) {
    for (const k of el.kids) {
      if (!isEl(k)) continue
      if (k.name === 'hp:tbl' && !k.self) {
        let up = k.parent
        while (up && up.local !== 'p') up = up.parent
        const t: Table = { i: this.tables.length, sec: si, el: k, rows: kidEls(k, 'hp:tr'), cells: [], para: up ? this.byEl.get(up) ?? null : null }
        this.tables.push(t)
        for (const tr of t.rows) {
          for (const tc of kidEls(tr, 'hp:tc')) {
            const a = (n: string) => { const e = kidEls(tc, n)[0]; return e ? attrsOf(sec.xml, e) : new Map<string, string>() }
            const addr = a('hp:cellAddr'), span = a('hp:cellSpan'), sz = a('hp:cellSz')
            const num = (m: Map<string, string>, k: string, d: number) => { const v = Number(m.get(k)); return Number.isInteger(v) ? v : d }
            const paras = kidEls(tc, 'hp:subList').flatMap((s) => kidEls(s, 'hp:p')).map((p) => this.byEl.get(p)).filter((p): p is Para => !!p)
            const cell: Cell = {
              el: tc, table: t, row: num(addr, 'rowAddr', -1), col: num(addr, 'colAddr', -1), rowSpan: Math.max(1, num(span, 'rowSpan', 1)),
              colSpan: Math.max(1, num(span, 'colSpan', 1)), height: num(sz, 'height', 0), paras, addr: kidEls(tc, 'hp:cellAddr')[0] ?? null,
            }
            for (const p of paras) p.cell = cell
            t.cells.push(cell)
          }
        }
      }
      this.findTables(sec, si, k)
    }
  }

  /** the lines of every paragraph as hwpxReadLines reads hwp.ts's text, and where each paragraph's lines start */
  lines(text: (p: Para) => string = (p) => p.text): { lines: string[]; start: number[]; count: number[] } {
    const lines: string[] = [], start: number[] = [], count: number[] = []
    for (const p of this.paras) {
      const l = hwpxParagraphLines(text(p), p.heading)
      start.push(lines.length); count.push(l.length)
      lines.push(...l)
    }
    return { lines, start, count }
  }

  where(p: Para): string {
    if (p.cell) return `table ${p.cell.table.i + 1}, row ${p.cell.row + 1}, column ${p.cell.col + 1}`
    return 'a paragraph'
  }
}

// ---------------------------------------------------------------- the changes
interface Edit { sec: number; start: number; end: number; text: string; change: number; seq: number }
/** a replaced range of a paragraph's text, in characters of what it reads as */
interface TextEdit { from: number; to: number; text: string; change: number }

const SEG_NAMES: Record<string, string> = {
  tab: 'a tab', br: 'a line break', locked: 'text inside a field or object', ctrl: 'a field, bookmark or other control', fieldBegin: 'a field',
  fieldEnd: 'a field', tbl: 'a table', pic: 'a picture', container: 'a drawing object', equation: 'an equation', nbSpace: 'a non-breaking space',
  fwSpace: 'a fixed-width space', hyphen: 'a hyphen mark', markpenBegin: 'highlighting', markpenEnd: 'highlighting', titleMark: 'a title mark',
  insertBegin: 'tracked changes', insertEnd: 'tracked changes', deleteBegin: 'tracked changes', deleteEnd: 'tracked changes',
}
const TRACKED = new Set(['insertBegin', 'insertEnd', 'deleteBegin', 'deleteEnd'])
/** what a copied row may hold (its text is replaced, its layout cache dropped) */
const ROW_NAMES = new Set(['hp:tc', 'hp:subList', 'hp:p', 'hp:run', 'hp:t', 'hp:linesegarray', 'hp:lineseg', 'hp:cellAddr', 'hp:cellSpan', 'hp:cellSz',
  'hp:cellMargin', 'hp:tab', 'hp:lineBreak', 'hp:nbSpace', 'hp:fwSpace', 'hp:hyphen'])

/** new text as it goes into hp:t: XML characters escaped, a line break as Hangul's element */
const textXml = (s: string) => s.split('\n').map(escText).join('<hp:lineBreak/>')
const cleanValue = (s: string) => cleanText(s.replace(/\r\n?/g, '\n'))

class Editor {
  readonly edits: Edit[] = []
  readonly textEdits = new Map<Para, TextEdit[]>()
  /** paragraphs whose layout cache goes */
  readonly dropCache = new Set<Para>()
  /** new paragraphs (a table's new rows) before the paragraph of this index (or at the end) */
  readonly inserts = new Map<number, { change: number; paras: { text: string; heading: number }[] }[]>()
  readonly notes: HwpxEditNote[] = []
  private rowsAdded = new Set<Table>()
  /** paragraphs of cells a change filled */
  private filled = new Set<Para>()
  private freshIds = new Map<number, () => string>()

  constructor(private doc: Doc) {}

  private edit(p: { sec: number }, start: number, end: number, text: string, change: number) {
    this.edits.push({ sec: p.sec, start, end, text, change, seq: this.edits.length })
  }
  note(change: number, where: string, before: string, after: string, also: number[] = []) {
    if (this.notes.length < 50) this.notes.push({ change, where, before: before.slice(0, 200), after: after.slice(0, 200), ...(also.length ? { also } : {}) })
  }

  apply(c: HwpxChange, i: number) {
    if ('find' in c) this.replace(c, i)
    else if ('cell' in c) this.fillCell(c, i)
    else this.addRows(c.add_rows, i)
  }

  // ---- find / replace
  private replace(c: Extract<HwpxChange, { find: string }>, i: number) {
    const find = c.find
    if (!find) refuseChange(i, 'find is empty')
    if (find === c.replace) refuseChange(i, 'find and replace are the same')
    const hits: { p: Para; at: number }[] = []
    for (const p of this.doc.paras) {
      for (let k = p.text.indexOf(find); k >= 0; k = p.text.indexOf(find, k + find.length)) hits.push({ p, at: k })
    }
    if (!hits.length) {
      const near = this.doc.paras.find((p) => strip(find) && strip(p.text).includes(strip(find)))
      const hint = near ? ` It is there with other spacing or line breaks, in ${this.doc.where(near)}: ${clip(near.text, 120)}; give the text exactly as it is, within one paragraph.`
        : find.includes('\n') ? ' Each paragraph is searched on its own: give text from one paragraph.' : ''
      refuseChange(i, `${clip(find)} is not in the document.${hint}`.replace(/\.$/, ''))
    }
    let chosen = hits
    if (c.all) {
      if (c.occurrence !== undefined) refuseChange(i, 'give occurrence or all, not both')
      if (hits.length > HWPX_EDIT_LIMITS.matches) refuseChange(i, `${clip(find)} appears more than ${HWPX_EDIT_LIMITS.matches.toLocaleString('en')} times; give a longer text`)
    }
    else if (c.occurrence !== undefined) {
      if (c.occurrence > hits.length) refuseChange(i, `${clip(find)} appears ${hits.length} time${hits.length > 1 ? 's' : ''}, so there is no occurrence ${c.occurrence}`)
      chosen = [hits[c.occurrence - 1]!]
    } else if (hits.length > 1) {
      const list = hits.slice(0, 5).map((h, n) => `${n + 1}: ${clip(h.p.text.slice(Math.max(0, h.at - 20), h.at + find.length + 20), 70)}`).join('; ')
      refuseChange(i, `${clip(find)} appears ${hits.length} times (${list}${hits.length > 5 ? '; …' : ''}). Give occurrence (1-${hits.length}) for one of them, or all: true for every one`)
    }
    const replacement = cleanValue(c.replace)
    for (const h of chosen) this.replaceAt(h.p, h.at, h.at + find.length, replacement, i)
  }

  private replaceAt(p: Para, from: number, to: number, text: string, i: number) {
    const xml = this.doc.sections[p.sec]!.xml
    if (p.el.name !== 'hp:p') refuseChange(i, `${clip(p.text.slice(from, to))} is not in an ordinary paragraph (${p.el.name})`)
    if (this.filled.has(p)) refuseChange(i, `it changes the same text as change ${this.textEdits.get(p)![0]!.change + 1}`)
    const tracked = p.segs.find((s) => s.kind === 'other' && TRACKED.has(s.el!.local))
    if (tracked) refuseChange(i, `the paragraph ${clip(p.text, 60)} has tracked changes; accept or reject them in Hangul first`)
    const covered = p.segs.filter((s) => (s.len > 0 ? s.at < to && s.at + s.len > from : s.at > from && s.at < to))
    const odd = covered.find((s) => s.kind !== 'text')
    if (odd) {
      const what = odd.kind === 'other' ? SEG_NAMES[odd.el!.local] ?? `an element (${odd.el!.name})` : SEG_NAMES[odd.kind]!
      refuseChange(i, `${clip(p.text.slice(from, to))} runs across ${what}, which a change cannot keep; change the text on each side of it separately`)
    }
    const shape = (s: Seg) => `${attrsOf(xml, s.run!).get('charPrIDRef') ?? ''}|${xml.slice(s.t!.start, s.t!.openEnd)}`
    const shapes = [...new Set(covered.map(shape))]
    if (shapes.length > 1) {
      refuseChange(i, `${clip(p.text.slice(from, to))} has more than one formatting (character shapes ${shapes.map((s) => s.split('|')[0]).join(' and ')}), so the new text's formatting is not clear; replace the differently formatted parts separately`)
    }
    covered.forEach((s, n) => {
      const raw = xml.slice(s.node!.start, s.node!.end)
      const a = s.node!.start + rawIndex(raw, Math.max(0, from - s.at))
      const b = s.node!.start + rawIndex(raw, Math.min(s.len, to - s.at))
      this.edit(p, a, b, n === 0 ? textXml(text) : '', i)
    })
    const list = this.textEdits.get(p) ?? []
    list.push({ from, to, text, change: i })
    this.textEdits.set(p, list)
    this.dropCache.add(p)
  }

  // ---- an empty cell
  private fillCell(c: Extract<HwpxChange, { cell: unknown }>, i: number) {
    const a = c.cell
    let cell: Cell
    if (a.next_to !== undefined) {
      if (a.table !== undefined || a.row !== undefined || a.col !== undefined) refuseChange(i, 'give next_to or table, row and col, not both')
      const label = strip(a.next_to)
      if (!label) refuseChange(i, 'next_to is empty')
      const all = this.doc.tables.flatMap((t) => t.cells).filter((x) => strip(x.paras.map((p) => p.text).join('')) === label)
      if (!all.length) refuseChange(i, `no table cell reads ${clip(a.next_to)}${this.cellsContaining(label)}`)
      if (all.length > 1 && a.occurrence === undefined) refuseChange(i, `${all.length} cells read ${clip(a.next_to)} (${all.slice(0, 5).map((x) => `table ${x.table.i + 1} row ${x.row + 1} column ${x.col + 1}`).join('; ')}); give occurrence (1-${all.length}) or table, row and col`)
      const o = a.occurrence ?? 1
      const lab = all[o - 1] ?? refuseChange(i, `${all.length} cell${all.length > 1 ? 's read' : ' reads'} ${clip(a.next_to)}, so there is no occurrence ${o}`)
      const below = a.direction === 'below'
      const row = below ? lab.row + lab.rowSpan : lab.row, col = below ? lab.col : lab.col + lab.colSpan
      cell = lab.table.cells.find((x) => x.row === row && x.col === col)
        ?? refuseChange(i, `there is no cell ${below ? 'below' : 'right of'} ${clip(a.next_to)} (table ${lab.table.i + 1}, row ${lab.row + 1}, column ${lab.col + 1})`)
    } else {
      if (a.table === undefined || a.row === undefined || a.col === undefined) refuseChange(i, 'a cell is given by next_to, or by table, row and col (all three)')
      const t = this.doc.tables[a.table - 1] ?? refuseChange(i, `there is no table ${a.table} (the document has ${this.doc.tables.length})`)
      cell = t.cells.find((x) => x.row === a.row! - 1 && x.col === a.col! - 1) ?? (() => {
        const over = t.cells.find((x) => x.row <= a.row! - 1 && a.row! - 1 < x.row + x.rowSpan && x.col <= a.col! - 1 && a.col! - 1 < x.col + x.colSpan)
        return refuseChange(i, over ? `row ${a.row} column ${a.col} of table ${a.table} is part of a merged cell that starts at row ${over.row + 1} column ${over.col + 1}`
          : `table ${a.table} has no cell at row ${a.row} column ${a.col}`)
      })()
    }
    const where = `table ${cell.table.i + 1}, row ${cell.row + 1}, column ${cell.col + 1}`
    // every paragraph inside the cell counts, those of a table or an object in it too
    const inside = this.doc.paras.filter((q) => q.sec === cell.table.sec && q.el.start > cell.el.start && q.el.end <= cell.el.end)
    const text = inside.map((q) => q.text).join('\n')
    if (text.trim()) refuseChange(i, `the cell at ${where} is not empty (it reads ${clip(text, 60)}); change its text with find and replace`)
    if (inside.some((q) => !cell.paras.includes(q))) refuseChange(i, `the cell at ${where} holds a table or an object, so it is not an empty cell to fill`)
    const p = cell.paras[0] ?? refuseChange(i, `the cell at ${where} has no paragraph to write in`)
    if (p.el.name !== 'hp:p') refuseChange(i, `the cell at ${where} has no ordinary paragraph`)
    // what an empty cell may hold besides white space: a field (누름틀) or a bookmark, a space mark
    const FIELD_PARTS = new Set(['hp:fieldBegin', 'hp:fieldEnd', 'hp:bookmark'])
    const allowed = (s: Seg) => s.kind === 'text' || (s.kind === 'other' && (
      (s.el!.name === 'hp:ctrl' && kidEls(s.el!).every((k) => FIELD_PARTS.has(k.name))) || s.el!.name === 'hp:nbSpace' || s.el!.name === 'hp:fwSpace'))
    const odd = cell.paras.flatMap((q) => q.segs).find((s) => !allowed(s))
    if (odd) refuseChange(i, `the cell at ${where} holds ${odd.kind === 'other' ? SEG_NAMES[odd.el!.local] ?? `an element (${odd.el!.name})` : SEG_NAMES[odd.kind]}, so it is not an empty cell to fill`)
    const other = this.textEdits.get(p)?.[0]
    if (other) refuseChange(i, `it changes the same text as change ${other.change + 1}`)
    const xml = this.doc.sections[p.sec]!.xml
    const value = cleanValue(c.value)
    const runs = kidEls(p.el, 'hp:run')
    let ts = runs.flatMap((r) => kidEls(r, 'hp:t'))
    // a field: the value goes inside it (after its start, before its end), where Hangul shows a filled field's text
    const ctrls = p.segs.filter((s) => s.kind === 'other' && s.el!.name === 'hp:ctrl').map((s) => s.el!)
    const begins = ctrls.filter((e) => kidEls(e, 'hp:fieldBegin').length)
    if (begins.length > 1) refuseChange(i, `the cell at ${where} holds more than one field; write in it with find and replace`)
    const begin = begins[0]
    if (begin) {
      const end = ctrls.find((e) => kidEls(e, 'hp:fieldEnd').length && e.start > begin.end)
      ts = ts.filter((t) => t.start >= begin.end && (!end || t.end <= end.start))
    }
    if (ts.length) {
      // the value goes at the start of the first hp:t; the paragraph's other text is white space and goes, so the cell
      // reads as its value (marks inside the hp:t, if any, stay where they are)
      const t = ts[0]!
      if (t.self) this.edit(p, t.start, t.end, `${xml.slice(t.start, t.openEnd - 2).trimEnd()}>${textXml(value)}</hp:t>`, i)
      else this.edit(p, t.openEnd, t.openEnd, textXml(value), i)
    } else if (begin) {
      // an empty field: the text right after the control that starts it, in the same run
      this.edit(p, begin.end, begin.end, `<hp:t>${textXml(value)}</hp:t>`, i)
    } else {
      const r = runs[0] ?? refuseChange(i, `the cell at ${where} has no text run to write in`)
      if (r.self) this.edit(p, r.start, r.end, `${xml.slice(r.start, r.openEnd - 2).trimEnd()}><hp:t>${textXml(value)}</hp:t></hp:run>`, i)
      else this.edit(p, r.closeStart, r.closeStart, `<hp:t>${textXml(value)}</hp:t>`, i)
    }
    for (const s of p.segs) if (s.kind === 'text' && s.len) this.edit(p, s.node!.start, s.node!.end, '', i)
    this.filled.add(p)
    const list = this.textEdits.get(p) ?? []
    list.push({ from: 0, to: p.text.length, text: value, change: i })
    this.textEdits.set(p, list)
    this.dropCache.add(p)
  }

  private cellsContaining(label: string): string {
    const near = this.doc.tables.flatMap((t) => t.cells).find((x) => strip(x.paras.map((p) => p.text).join('')).includes(label))
    return near ? ` (one reads ${clip(near.paras.map((p) => p.text).join(' '), 60)}; next_to must be the cell's whole text)` : ''
  }

  // ---- rows
  private addRows(a: Extract<HwpxChange, { add_rows: unknown }>['add_rows'], i: number) {
    let t: Table
    if ((a.table === undefined) === (a.table_with === undefined)) refuseChange(i, 'give the table by table (its number) or table_with (the text of one of its cells), one of them')
    if (a.table !== undefined) t = this.doc.tables[a.table - 1] ?? refuseChange(i, `there is no table ${a.table} (the document has ${this.doc.tables.length})`)
    else {
      const label = strip(a.table_with!)
      const found = [...new Set(this.doc.tables.flatMap((x) => x.cells).filter((x) => strip(x.paras.map((p) => p.text).join('')) === label).map((x) => x.table))]
      if (!found.length) refuseChange(i, `no table has a cell that reads ${clip(a.table_with!)}${this.cellsContaining(label)}`)
      if (found.length > 1) refuseChange(i, `tables ${found.map((x) => x.i + 1).join(', ')} all have a cell that reads ${clip(a.table_with!)}; give table (its number)`)
      t = found[0]!
    }
    const T = `table ${t.i + 1}`
    if (this.rowsAdded.has(t)) refuseChange(i, `rows are added to ${T} twice; put all of its new rows in one change`)
    this.rowsAdded.add(t)
    const sec = this.doc.sections[t.sec]!
    const xml = sec.xml
    const tbl = attrsOf(xml, t.el)
    const R = t.rows.length
    if (Number(tbl.get('rowCnt')) !== R) refuseChange(i, `${T} says it has ${tbl.get('rowCnt')} rows but has ${R}`)
    const colCnt = Number(tbl.get('colCnt'))
    const A = a.after_row ?? R
    const C = a.copy_row ?? A
    if (!(A >= 1 && A <= R)) refuseChange(i, `${T} has rows 1-${R}, so after_row ${A} is not one of them`)
    if (!(C >= 1 && C <= R)) refuseChange(i, `${T} has rows 1-${R}, so copy_row ${C} is not one of them`)
    if (!a.rows.length) refuseChange(i, 'rows is empty')
    if (a.rows.length > HWPX_EDIT_LIMITS.newRows) refuseChange(i, `more than ${HWPX_EDIT_LIMITS.newRows} new rows`)
    const byRow = new Map<El, Cell[]>()
    for (const c of t.cells) { const list = byRow.get(c.el.parent!); if (list) list.push(c); else byRow.set(c.el.parent!, [c]) }
    const rowOf = (el: El) => byRow.get(el) ?? []
    t.rows.forEach((tr, r) => { for (const c of rowOf(tr)) if (c.row !== r) refuseChange(i, `the cells of ${T} are not in row order (row ${r + 1} has a cell of row ${c.row + 1})`) })
    const tr = t.rows[C - 1]!
    const cells = rowOf(tr)
    if (cells.some((c) => c.rowSpan !== 1)) refuseChange(i, `row ${C} of ${T} has a cell merged with the row below, so it cannot be copied; copy another row (copy_row)`)
    if (cells.reduce((n, c) => n + c.colSpan, 0) !== colCnt) refuseChange(i, `row ${C} of ${T} does not have all of its ${colCnt} columns (a cell above reaches into it), so it cannot be copied; copy another row (copy_row)`)
    const across = t.cells.find((c) => c.row <= A - 1 && c.row + c.rowSpan - 1 >= A)
    if (across) refuseChange(i, `a merged cell of ${T} (row ${across.row + 1}, column ${across.col + 1}) reaches across the place after row ${A}, so rows cannot go there`)
    for (const [n, row] of a.rows.entries()) if (row.length > cells.length) refuseChange(i, `new row ${n + 1} has ${row.length} values, but row ${C} of ${T} has ${cells.length} cells`)
    // what a copied row may hold: text in paragraphs, nothing that points elsewhere (the allowlist of hwpx-write.ts)
    const rowXml = xml.slice(tr.start, tr.end)
    const refuseRow: Refuse = (_part, why) => refuseChange(i, `row ${C} of ${T} cannot be copied (${why}); copy a row with only text in its cells (copy_row)`)
    const tree = parseXml(`<hs:sec ${NS_ATTRS}>${rowXml}</hs:sec>`, `row ${C}`, { only: ['hp:tr'], refuse: refuseRow }).get('hp:tr')!
    assertKnown(tree, `row ${C}`, ROW_NAMES, new Set(['hp:t']), refuseRow)
    // the new rows: each cell's first paragraph with its shapes and a fresh id, its first run with the new text
    const fresh = this.ids(t.sec)
    const copies: string[] = []
    const newParas: { text: string; heading: number }[] = []
    for (const [n, values] of a.rows.entries()) {
      let out = ''
      let pos = tr.start
      for (const [ci, cell] of cells.entries()) {
        out += xml.slice(pos, cell.el.start)
        const value = cleanValue(values[ci] ?? '')
        if (value.length > HWPX_EDIT_LIMITS.valueChars) refuseChange(i, `a value is longer than ${HWPX_EDIT_LIMITS.valueChars.toLocaleString('en')} characters`)
        out += this.cellCopy(xml, cell, A + n, value, fresh, i, C, T)
        const p = cell.paras[0]!
        newParas.push({ text: value, heading: this.doc.outline.get(attrsOf(xml, p.el).get('paraPrIDRef') ?? '') ?? 0 })
        pos = cell.el.end
      }
      copies.push(out + xml.slice(pos, tr.end))
    }
    const after = t.rows[A - 1]!
    const k = a.rows.length
    this.edit(t, after.end, after.end, copies.join(''), i)
    // the rows below move down; the table's row count, height and cell zones follow
    for (const c of t.cells) {
      if (c.row < A) continue
      const r = c.addr && attrRange(xml, c.addr, 'rowAddr')
      if (!r) refuseChange(i, `a cell of ${T} has no row address`)
      this.edit(t, r[0], r[1], String(c.row + k), i)
    }
    const rc = attrRange(xml, t.el, 'rowCnt')!
    this.edit(t, rc[0], rc[1], String(R + k), i)
    const height = Math.max(0, ...cells.map((c) => c.height))
    const sz = kidEls(t.el, 'hp:sz')[0]
    const h = sz && attrRange(xml, sz, 'height')
    if (h && height && /^\d+$/.test(xml.slice(h[0], h[1]))) this.edit(t, h[0], h[1], String(Number(xml.slice(h[0], h[1])) + k * height), i)
    for (const list of kidEls(t.el, 'hp:cellzoneList')) {
      for (const z of kidEls(list, 'hp:cellzone')) {
        const at = attrsOf(xml, z)
        const s = Number(at.get('startRowAddr')), e = Number(at.get('endRowAddr'))
        if (!Number.isInteger(s) || !Number.isInteger(e)) refuseChange(i, `a cell zone of ${T} has no rows`)
        if (s >= A) { const r = attrRange(xml, z, 'startRowAddr')!; this.edit(t, r[0], r[1], String(s + k), i) }
        if (e >= A) { const r = attrRange(xml, z, 'endRowAddr')!; this.edit(t, r[0], r[1], String(e + k), i) }
      }
    }
    // the paragraph that holds the table, and those around it, are laid out again
    for (let p = t.para; p; p = p.cell ? p.cell.table.para : null) this.dropCache.add(p)
    // where the new paragraphs go in reading order: before the first paragraph that opens after the row they follow
    const next = this.doc.paras.find((p) => p.sec > t.sec || (p.sec === t.sec && p.el.start >= after.end))
    const key = next ? next.i : this.doc.paras.length
    this.inserts.set(key, [...(this.inserts.get(key) ?? []), { change: i, paras: newParas }])
    this.note(i, `${T}, after row ${A}`, '', `${k} row${k > 1 ? 's' : ''} like row ${C}: ${a.rows.map((r) => r.join(' | ')).join(' / ')}`)
  }

  /** a copy of `cell` for row `row` (0-based) with `value` */
  private cellCopy(xml: string, cell: Cell, row: number, value: string, fresh: () => string, i: number, C: number, T: string): string {
    const tc = cell.el
    let out = xml.slice(tc.start, tc.openEnd)
    for (const k of tc.kids) {
      if (!isEl(k)) { out += xml.slice(k.start, k.end); continue }
      if (k.name === 'hp:subList') {
        const p = kidEls(k, 'hp:p')[0]
        const run = p && kidEls(p, 'hp:run')[0]
        if (!p || !run) refuseChange(i, `a cell of row ${C} of ${T} has no text run to copy`)
        const pOpen = withAttr(xml.slice(p.start, p.openEnd), 'id', fresh())
        const rOpen = run.self ? xml.slice(run.start, run.openEnd - 2).trimEnd() + '>' : xml.slice(run.start, run.openEnd)
        // the text before the first paragraph (white space) as it was
        const lead = k.kids.length && !isEl(k.kids[0]!) ? xml.slice(k.kids[0].start, k.kids[0].end) : ''
        out += xml.slice(k.start, k.openEnd) + lead + pOpen + rOpen + (value ? `<hp:t>${textXml(value)}</hp:t>` : '<hp:t/>') + '</hp:run></hp:p>' + xml.slice(k.closeStart, k.end)
      } else if (k === cell.addr) out += withAttr(xml.slice(k.start, k.end), 'rowAddr', String(row))
      else out += xml.slice(k.start, k.end)
    }
    return out + xml.slice(tc.closeStart, tc.end)
  }

  /** paragraph ids no paragraph of the section has (Hangul's are 32-bit numbers) */
  private ids(sec: number): () => string {
    let f = this.freshIds.get(sec)
    if (!f) {
      const xml = this.doc.sections[sec]!.xml
      const used = new Set<number>()
      for (const p of this.doc.paras) if (p.sec === sec) { const v = Number(attrsOf(xml, p.el).get('id')); if (Number.isInteger(v)) used.add(v) }
      let next = used.size ? Math.max(...used) + 1 : 1
      f = () => {
        if (next > 0xffffffff) next = 1
        while (used.has(next)) next++
        used.add(next)
        return String(next++)
      }
      this.freshIds.set(sec, f)
    }
    return f
  }

  /** each paragraph's text after the changes (a cell's new text replaces all of it) */
  newText(p: Para): string {
    const list = this.textEdits.get(p)
    if (!list) return p.text
    const sorted = [...list].sort((a, b) => a.from - b.from || a.change - b.change)
    let out = '', pos = 0
    let last: TextEdit | null = null
    for (const e of sorted) {
      if (last && e.from < pos) refuseChange(e.change, `it changes the same text as change ${last.change + 1}`)
      out += p.text.slice(pos, e.from) + e.text
      pos = e.to
      last = e
    }
    return out + p.text.slice(pos)
  }
}

// ---------------------------------------------------------------- the whole edit
/** the parts of a zip as hwp.ts's reader (SheetJS) reads them */
function cfbParts(bytes: Uint8Array): Map<string, Uint8Array> {
  const c = XLSX.CFB.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { type: 'buffer' })
  const out = new Map<string, Uint8Array>()
  c.FullPaths.forEach((p: string, i: number) => {
    const content = c.FileIndex[i]?.content
    if (content && content.length) out.set(p.replace(/^Root Entry\//, ''), content instanceof Uint8Array ? content : Uint8Array.from(content))
  })
  return out
}

/** Changes the text of a .hwpx; the new file and what the read-back needs. ToolError for a change or a document it
 * refuses, and then nothing is written. */
export function editHwpx(bytes: Uint8Array, changes: HwpxChange[]): { file: Uint8Array; report: HwpxEditReport } {
  if (!changes.length) throw new ToolError('no changes given; nothing was saved')
  if (changes.length > HWPX_EDIT_LIMITS.changes) throw new ToolError(`more than ${HWPX_EDIT_LIMITS.changes} changes in one call; nothing was saved`)
  const pkg = openPackage(bytes)
  const doc = new Doc(pkg)
  // the model must read the document exactly as hwp.ts (read, grep and the read-back) does, or nothing is changed
  const before = doc.lines()
  const read = hwpxReadLines(hwpxText(bytes))
  const differs = firstDifference(read, before.lines)
  if (differs) refuseDoc(`its text could not be mapped exactly (${differs})`)
  const ed = new Editor(doc)
  changes.forEach((c, i) => ed.apply(c, i))

  // the expected text: each changed paragraph's new text, the new rows' paragraphs where they go
  const changed = new Map<Para, string>()
  for (const p of ed.textEdits.keys()) {
    const t = ed.newText(p)
    changed.set(p, t)
    const ch = [...new Set(ed.textEdits.get(p)!.map((e) => e.change))].sort((a, b) => a - b)
    ed.note(ch[0]!, doc.where(p), p.text, t, ch.slice(1))
  }
  // each line edit names the changes it comes from, for the server's read-back
  const lineEdits: LineEdit[] = []
  for (let i = 0; i <= doc.paras.length; i++) {
    const at = i < doc.paras.length ? before.start[i]! : before.lines.length
    for (const g of ed.inserts.get(i) ?? []) lineEdits.push({ at, remove: 0, insert: g.paras.flatMap((x) => hwpxParagraphLines(x.text, x.heading)), changes: [g.change] })
    const p = doc.paras[i]
    if (p && changed.has(p)) {
      const changes = [...new Set(ed.textEdits.get(p)!.map((e) => e.change))].sort((a, b) => a - b)
      lineEdits.push({ at, remove: before.count[i]!, insert: hwpxParagraphLines(changed.get(p)!, p.heading), changes })
    }
  }

  // the bytes: per section, the edits in order (none may overlap another), the dropped layout caches
  for (const p of ed.dropCache) if (p.lineseg) ed.edits.push({ sec: p.sec, start: p.lineseg.start, end: p.lineseg.end, text: '', change: -1, seq: ed.edits.length })
  const out = new Map<string, Uint8Array>()
  for (const [si, sec] of doc.sections.entries()) {
    const list = ed.edits.filter((e) => e.sec === si).sort((a, b) => a.start - b.start || a.end - b.end || a.seq - b.seq)
    if (!list.length) continue
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1]!, b = list[k]!
      if (b.start < a.end) refuseChange(Math.max(a.change, b.change), a.change >= 0 && b.change >= 0 && a.change !== b.change ? `it changes the same text as change ${Math.min(a.change, b.change) + 1}` : 'it changes the same text twice')
    }
    let xml = ''
    let pos = 0
    for (const e of list) { xml += sec.xml.slice(pos, e.start) + e.text; pos = e.end }
    xml += sec.xml.slice(pos)
    parseXml(xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml, sec.name, { refuse: (part, why) => { throw new ToolError(`the changed ${part} is not well-formed XML (${why}); nothing was saved`) }, maxNodes: HWPX_EDIT_LIMITS.nodes * 2 })
    out.set(sec.name, new TextEncoder().encode(xml))
  }
  const entries: ZipEntry[] = pkg.entries.map((e) => {
    const data = out.get(e.name)
    return data ? { name: e.name, data, utf8: e.utf8, time: e.time, date: e.date, store: e.raw.method === 0 } : e
  })
  let file: Uint8Array
  try { file = writeZip(entries) } catch (e) { throw new ToolError(`the changed document could not be written (${String((e as Error).message).slice(0, 120)}); nothing was saved`) }

  // read back: every part as hwp.ts's zip reader sees it is the old one, or the changed section; the text is the old
  // text with the changes, nothing else
  const got = cfbParts(file)
  for (const e of pkg.entries) {
    if (!e.data.length) continue
    const want = out.get(e.name) ?? e.data
    const have = got.get(e.name)
    if (!have || !Buffer.from(have).equals(Buffer.from(want))) throw new ToolError(`the changed document did not read back (${e.name}); nothing was saved`)
  }
  const want = applyLineEdits(before.lines, lineEdits)
  const after = hwpxReadLines(hwpxText(file))
  const diff = want ? firstDifference(want, after) : 'the changes do not fit the document'
  if (diff) throw new ToolError(`the changed document did not read back as expected (${diff}); nothing was saved`)

  const placeholders = [...new Set(after.join('\n').match(/\{\{[^{}\n]{1,40}\}\}/g) ?? [])].slice(0, 20)
  return { file, report: { lineEdits, notes: ed.notes.sort((a, b) => a.change - b.change), placeholders } }
}

/** The changes as the worker gets them: the server checked them with the tool's schema; checked again here. */
function asChanges(v: unknown): HwpxChange[] {
  const bad = (): never => { throw new ToolError('the .hwpx editor got a damaged request') }
  if (!Array.isArray(v)) return bad()
  const str = (x: unknown) => typeof x === 'string'
  const int = (x: unknown) => x === undefined || (Number.isInteger(x) && (x as number) >= 1)
  for (const c of v) {
    if (!c || typeof c !== 'object') bad()
    if ('find' in c) { if (!str(c.find) || !str(c.replace) || !int(c.occurrence) || (c.all !== undefined && typeof c.all !== 'boolean')) bad() }
    else if ('cell' in c) {
      const a = c.cell
      if (!a || typeof a !== 'object' || !str(c.value) || !(a.next_to === undefined || str(a.next_to)) || !int(a.table) || !int(a.row) || !int(a.col) || !int(a.occurrence)) bad()
      if (a.direction !== undefined && a.direction !== 'right' && a.direction !== 'below') bad()
    } else if ('add_rows' in c) {
      const a = c.add_rows
      if (!a || typeof a !== 'object' || !int(a.table) || !(a.table_with === undefined || str(a.table_with)) || !int(a.after_row) || !int(a.copy_row)) bad()
      if (!Array.isArray(a.rows) || a.rows.some((r: unknown) => !Array.isArray(r) || r.length > HWPX_EDIT_LIMITS.rowCells || r.some((x) => !str(x)))) bad()
    } else bad()
  }
  return v as HwpxChange[]
}

/** The office worker's `hwpx-verify` mode: a file the editor made goes through every check of a document to change
 * again, in a fresh worker (the server does not trust the one that made it): the package rules and the text model
 * agreeing with hwp.ts. "ok" out, or the refusal. */
export function hwpxVerifyRequest(input: Uint8Array): Uint8Array {
  const doc = new Doc(openPackage(input))
  const differs = firstDifference(hwpxReadLines(hwpxText(input)), doc.lines().lines)
  if (differs) refuseDoc(`its text could not be mapped exactly (${differs})`)
  return new TextEncoder().encode('ok')
}

/** The office worker's `hwpx-edit` mode: the framed request of hwpx-check.ts in, the framed report and file out. */
export function hwpxEditRequest(input: Uint8Array): Uint8Array {
  let req: ReturnType<typeof decodeHwpxEditRequest>
  try { req = decodeHwpxEditRequest(input) } catch { throw new ToolError('the .hwpx editor got a damaged request') }
  const { file, report } = editHwpx(req.doc, asChanges(req.changes))
  return encodeHwpxEditResult(report, file)
}
