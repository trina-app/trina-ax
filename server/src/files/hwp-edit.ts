// edit_hwp for a .hwp (HWP 5.x binary; stage 3 of Hangul documents): the text of an EXISTING .hwp changed in place,
// the result still a .hwp and everything else kept as it was (a .hwpx: files/hwpx-edit.ts). Runs ONLY in the office
// worker (files/office-worker.ts), never in the server process: the document is an untrusted compound file of zlib
// record streams. Written from Hancom's public HWP 5.0 document ("한글 문서 파일 형식 5.0") and the layout of files
// Hangul saved; the changes are found exactly as for a .hwpx (files/hwp-changes.ts).
//
// The patch, record by record: only the BodyText/SectionN streams that hold a change are written again (inflated,
// patched, deflated again when the FileHeader says the document is compressed). Every other stream (FileHeader,
// DocInfo, BinData, PrvText, PrvImage, the summary, scripts, options) and every other record of a section keeps its
// bytes, and the compound file keeps its storage tree, names, CLSIDs, state bits and times (files/cfb.ts). No shape or
// style is added, so DocInfo never changes. In a changed paragraph:
// - PARA_TEXT: only the replaced characters change. Controls (8-WCHAR inline and extended ones, 1-WCHAR character
//   controls) are never split or moved against the text around them: an edit across one is refused. A paragraph that
//   ends up with no text has no PARA_TEXT, as Hangul writes an empty paragraph; an empty one that gets text gets one.
// - PARA_CHAR_SHAPE: positions after an edit move with it; the new text takes the shape of the text it replaces (an
//   edit across two shapes is refused). An inserted text (a filled cell) takes the shape at the place it goes.
// - PARA_LINE_SEG, the layout cache, is taken out and its count set to 0, so Hangul lays the paragraph out when it
//   opens the file: a stale cache draws the new text into the old line breaks (stage 2's overlapping glyphs).
// - PARA_HEADER: the character count (its "last in list" bit kept), character shape count, line count and control
//   mask (a line break added) follow.
// Rows (add_rows): the TABLE record (row count, cells per row, cell zones), the LIST_HEADER row address of the cells
// below, new cells copied from one row's LIST_HEADER, first paragraph header and first character shape with the new
// text, the table's height in its CTRL_HEADER (an estimate; Hangul lays the table out again) and the layout cache of
// the paragraph holding the table.
//
// Refused, writing nothing: distribution-only (배포용), password, DRM, certificate-encrypted, signed, privacy-protected
// and change-tracking documents (FileHeader flags, their streams and records), scripts other than Hangul's empty
// default, an XML form template, OLE objects (BinData storages, .OLE streams, compound-file bytes, SHAPE_COMPONENT_OLE),
// pictures or files linked from outside, a linked document (DocOptions/_LinkDoc with a path), links or fields that
// point at local files, programs or shares, programs in BinData, videos; and in a paragraph a change touches, anything
// this editor does not understand (an unknown record, counts that do not agree, range tags: highlighting or tracked
// changes). Unknown records elsewhere pass through untouched. The document must also read exactly as hwp.ts reads it
// (read, grep and the read-back), so a change never lands elsewhere than where the AI saw the text.
//
// 본 제품은 한컴의 HWP 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다. (Hancom's attribution for the HWP 5.0 document)
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import { ToolError } from '../policy/errors'
import { CfbError, cfbMismatch, isCfb, readCfb, writeCfb, type Cfb } from './cfb'
import { hwpOutline, hwpText, INFLATE_TOTAL_MAX, ONE_WCHAR, SECTIONS_MAX, STREAM_MAX } from './hwp'
import { asChanges, ChangeEditor, clip, docLines, HWP_CHANGE_LIMITS, placeholdersIn, refuseChange, type CCell, type CPara, type CTable, type RowPlan } from './hwp-changes'
import {
  applyLineEdits, decodeHwpEditRequest, encodeHwpEditResult, firstDifference, HWP_EDIT_MAX, HWPX_TEXT_MAX, hwpxReadLines,
  type HwpChange, type HwpEditReport,
} from './hwpx-check'
import { badLinkTarget, isProgram, outside, PROGRAM_NAME } from './hwpx-edit'
import { isZip } from './zip-guard'

export const HWP_EDIT_LIMITS = {
  bytes: HWP_EDIT_MAX,
  /** one stream inflated, and all of them together (hwp.ts's caps) */
  stream: STREAM_MAX,
  inflated: INFLATE_TOTAL_MAX,
  sections: SECTIONS_MAX,
  /** records of all sections together */
  records: 4_000_000,
  ...HWP_CHANGE_LIMITS,
}

const DOC_BAD = 'this .hwp cannot be changed'
function refuseDoc(why: string): never { throw new ToolError(`${DOC_BAD}: ${why}; nothing was saved`) }

/** record tags (HWPTAG_BEGIN 0x10 + n) */
const TAG = {
  BIN_DATA: 18, DIST_DOC_DATA: 28, PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, PARA_LINE_SEG: 69, PARA_RANGE_TAG: 70,
  CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77, SHAPE_OLE: 84, TRACK_CHANGE: 96, TRACK_CHANGE_AUTHOR: 97, VIDEO_DATA: 98,
}
/** a paragraph's own records; anything else directly under PARA_HEADER is unknown to this editor */
const PARA_KIDS = new Set([TAG.PARA_TEXT, TAG.PARA_CHAR_SHAPE, TAG.PARA_LINE_SEG, TAG.PARA_RANGE_TAG, TAG.CTRL_HEADER])
/** 8-WCHAR controls that have a CTRL_HEADER (extended); the other 8-WCHAR ones are inline (tab, field end, ...) */
const EXTENDED = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23])
const LINE_BREAK = 10, PARA_END = 13

/** FileHeader flags (attribute 1) that refuse a document */
const FLAGS_REFUSED: [number, string][] = [
  [1 << 1, 'it is password-protected'],
  [1 << 2, 'it is a distribution-only document (배포용)'],
  [1 << 3, 'it contains scripts (Scripts/)'],
  [1 << 4, 'it is DRM-protected'],
  [1 << 5, 'it holds an XML form template (XMLTemplate)'],
  [1 << 7, 'it is digitally signed, and a change would break the signature'],
  [1 << 8, 'it is encrypted with a certificate'],
  [1 << 9, 'it is digitally signed, and a change would break the signature'],
  [1 << 10, 'it is DRM-protected'],
  [1 << 13, 'it is a privacy-protected document (개인 정보 보안)'],
  [1 << 14, 'it tracks changes (변경 추적); accept or reject them and turn tracking off in Hangul first'],
  [1 << 16, 'it contains a video'],
]
/** streams that refuse a document, whatever the flags say */
const STREAMS_REFUSED: [RegExp, string][] = [
  [/^ViewText\//i, 'it is a distribution-only document (배포용)'],
  [/^DocOptions\/(DrmLicense|DrmRootSect|CertDrmHeader|CertDrmInfo)$/i, 'it is DRM-protected'],
  [/^DocOptions\/(DigitalSignature|PublicKeyInfo)$/i, 'it is digitally signed, and a change would break the signature'],
  [/^XMLTemplate(\/|$)/i, 'it holds an XML form template (XMLTemplate)'],
  [/^Scripts\/(?!(DefaultJScript|JScriptVersion)$)/i, 'it contains scripts (Scripts/)'],
  [/\.ole$/i, 'it contains an embedded OLE object'],
]

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8)
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0
const put16 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff }
const put32 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff }
/** a control's id as text (the UINT32 MAKE_4CHID: 'tbl ' is stored " lbt") */
const ctrlId = (b: Uint8Array, o: number) => String.fromCharCode(b[o + 3]!, b[o + 2]!, b[o + 1]!, b[o]!)

/** A record of `tag` and `level` with `data` (the extended size form from 0xFFF bytes on). */
export function hwpRecord(tag: number, level: number, data: Uint8Array): Uint8Array {
  const big = data.length >= 0xfff
  const out = new Uint8Array((big ? 8 : 4) + data.length)
  put32(out, 0, ((tag & 0x3ff) | ((level & 0x3ff) << 10) | ((big ? 0xfff : data.length) << 20)) >>> 0)
  if (big) put32(out, 4, data.length)
  out.set(data, big ? 8 : 4)
  return out
}
/** WCHARs of new text: a line break as the control character 10 */
const wchars = (s: string) => Uint16Array.from(s, (ch) => (ch === '\n' ? LINE_BREAK : ch.charCodeAt(0)))
const wbytes = (w: Uint16Array) => { const b = new Uint8Array(w.length * 2); w.forEach((c, k) => put16(b, k * 2, c)); return b }

// ---------------------------------------------------------------- inflating, with hwp.ts's caps
class Budget {
  left: number = HWP_EDIT_LIMITS.inflated
  inflate(data: Uint8Array, what: string): Uint8Array {
    if (this.left <= 0) refuseDoc(`it expands to more than ${HWP_EDIT_LIMITS.inflated / 1024 / 1024} MB`)
    let out: Uint8Array
    try { out = zlib.inflateRawSync(data, { maxOutputLength: Math.min(HWP_EDIT_LIMITS.stream, this.left) }) } catch (e) {
      if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') refuseDoc(`${what} expands to more than ${Math.min(HWP_EDIT_LIMITS.stream, this.left) / 1024 / 1024 | 0} MB`)
      return refuseDoc(`${what} is damaged (it does not expand)`)
    }
    this.left -= out.length
    return plain(out)
  }
}
/** a Uint8Array view, not a Buffer: Buffer's slice() is a view too, and a slice of a record must be a copy */
const plain = (b: Uint8Array) => (Buffer.isBuffer(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : b)
/** the first bytes of a BinData stream as raw-deflated data, when it is that (a prefix only: nothing is expanded whole) */
function inflatedHead(data: Uint8Array): Uint8Array | null {
  try { return zlib.inflateRawSync(data.subarray(0, 4096), { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 8 * 1024 * 1024 }) } catch { return null }
}

// ---------------------------------------------------------------- records of a stream
/** The records of a stream as typed arrays (offsets in the stream): tag, level, header start, data start, size. */
class Recs {
  readonly n: number
  readonly tag: Uint16Array; readonly level: Uint16Array; readonly start: Uint32Array; readonly data: Uint32Array; readonly size: Uint32Array
  readonly bytes: Uint8Array
  constructor(bytes: Uint8Array, what: string, budget: { left: number }) {
    this.bytes = bytes = plain(bytes)
    let n = 0
    for (let i = 0; i < bytes.length;) {
      if (i + 4 > bytes.length) refuseDoc(`${what} is damaged (a record is cut short)`)
      let size = u32(bytes, i) >>> 20
      let d = i + 4
      if (size === 0xfff) { if (i + 8 > bytes.length) refuseDoc(`${what} is damaged (a record is cut short)`); size = u32(bytes, i + 4); d = i + 8 }
      if (d + size > bytes.length) refuseDoc(`${what} is damaged (a record is cut short)`)
      i = d + size
      if (++n > budget.left) refuseDoc(`it has more than ${HWP_EDIT_LIMITS.records.toLocaleString('en')} records`)
    }
    budget.left -= n
    this.n = n
    this.tag = new Uint16Array(n); this.level = new Uint16Array(n); this.start = new Uint32Array(n); this.data = new Uint32Array(n); this.size = new Uint32Array(n)
    for (let i = 0, r = 0; r < n; r++) {
      const h = u32(bytes, i)
      let size = h >>> 20
      let d = i + 4
      if (size === 0xfff) { size = u32(bytes, i + 4); d = i + 8 }
      this.tag[r] = h & 0x3ff; this.level[r] = (h >>> 10) & 0x3ff; this.start[r] = i; this.data[r] = d; this.size[r] = size
      i = d + size
    }
  }
  end(r: number) { return this.data[r]! + this.size[r]! }
  body(r: number) { return this.bytes.subarray(this.data[r]!, this.end(r)) }
  /** the index after the records under r (those of a higher level that follow it) */
  subtreeEnd(r: number) { let j = r + 1; while (j < this.n && this.level[j]! > this.level[r]!) j++; return j }
  /** the byte offset of record r, or the stream's end */
  offset(r: number) { return r < this.n ? this.start[r]! : this.bytes.length }
}

// ---------------------------------------------------------------- the document
/** what a paragraph's text holds besides characters: a tab or line break (they read as text), a control, its end */
interface Unit { kind: 'tab' | 'br' | 'ctrl' | 'char-ctrl' | 'end'; at: number; len: number; w: number; code: number; id: string }
interface Para extends CPara {
  sec: number
  /** its PARA_HEADER, and the index after its records */
  rec: number; end: number; level: number
  cell?: Cell
  texts: number[]; shapes: number[]; lines: number[]; ranges: number[]; ctrls: number[]; others: number[]
  /** its WCHARs (PARA_TEXT, or the paragraph end alone when it has none) and what is not plain text in them */
  w: Uint16Array; units: Unit[]
}
interface Cell extends CCell { table: Table; paras: Para[]; lh: number; end: number }
interface Table extends CTable {
  sec: number; ctrl: number; rec: number; cells: Cell[]; para: Para | null
  /** why the table cannot be changed here, when it cannot */
  bad: string | null
  rowSizes: number[]; cols: number
}
interface Section { name: string; stream: Uint8Array; raw: Uint8Array; recs: Recs }

const CODE_NAMES: Record<number, string> = {
  2: 'a section or column setting', 3: 'a field', 4: 'a field', 8: 'a title mark', 11: 'a table or object', 15: 'a hidden comment',
  16: 'a header or footer', 17: 'a footnote or endnote', 18: 'an automatic number', 21: 'a page control', 22: 'a bookmark',
  23: 'overlapping characters or ruby text', 24: 'a hyphen mark', 30: 'a non-breaking space', 31: 'a fixed-width space',
}
const ID_NAMES: Record<string, string> = {
  'tbl ': 'a table', 'gso ': 'a picture or drawing object', 'eqed': 'an equation', '%hlk': 'a link', 'bokm': 'a bookmark', 'atno': 'an automatic number',
  'head': 'a header', 'foot': 'a footer', 'fn  ': 'a footnote', 'en  ': 'an endnote', 'tcmt': 'a hidden comment', 'tdut': 'ruby text',
  'tcps': 'overlapping characters', 'idxm': 'an index mark', 'form': 'a form object',
}
const unitName = (u: Unit) => u.kind === 'tab' ? 'a tab' : u.kind === 'br' ? 'a line break'
  : ID_NAMES[u.id] ?? (u.id.startsWith('%') ? 'a field' : CODE_NAMES[u.code] ?? 'a control')

/** The hwp.ts reading of a paragraph's PARA_TEXT records (hwp.ts paraText): characters from 32 up as they are, 9 a tab,
 * 10 a line break, other controls nothing; 1-WCHAR and 8-WCHAR controls as ONE_WCHAR says. */
function readText(p: Para, recs: Recs) {
  let text = ''
  const units: Unit[] = []
  const parts: Uint16Array[] = []
  let base = 0
  for (const r of p.texts) {
    const b = recs.body(r)
    const n = b.length >> 1
    const w = new Uint16Array(n)
    for (let k = 0; k < n; k++) w[k] = u16(b, k * 2)
    for (let k = 0; k < n;) {
      const c = w[k]!
      if (c >= 32) { text += String.fromCharCode(c); k++; continue }
      const one = ONE_WCHAR.has(c)
      const id = !one && k + 2 < n ? String.fromCharCode(w[k + 2]! >> 8, w[k + 2]! & 0xff, w[k + 1]! >> 8, w[k + 1]! & 0xff) : ''
      const s = c === 9 ? '\t' : c === LINE_BREAK ? '\n' : ''
      units.push({ kind: c === 9 ? 'tab' : c === LINE_BREAK ? 'br' : c === PARA_END ? 'end' : one ? 'char-ctrl' : 'ctrl', at: text.length, len: s.length, w: base + k, code: c, id })
      text += s
      k += one ? 1 : 8
    }
    parts.push(w)
    base += n
  }
  p.text = text
  p.units = units
  if (!parts.length) { p.w = Uint16Array.of(PARA_END); p.units.push({ kind: 'end', at: 0, len: 0, w: 0, code: PARA_END, id: '' }) }
  else if (parts.length === 1) p.w = parts[0]!
  else { p.w = new Uint16Array(base); let o = 0; for (const w of parts) { p.w.set(w, o); o += w.length } }
}

/** the WCHAR of each character of a paragraph's text (characters, tabs and line breaks each come from one control) */
function charWchars(p: Para): Int32Array {
  const out = new Int32Array(p.text.length + 1)
  let k = 0
  for (let i = 0; i < p.w.length && k < p.text.length;) {
    const c = p.w[i]!
    if (c >= 32) { out[k++] = i; i++; continue }
    if (c === 9 || c === LINE_BREAK) out[k++] = i
    i += ONE_WCHAR.has(c) ? 1 : 8
  }
  out[p.text.length] = p.w.length
  return out
}

class Doc {
  readonly sections: Section[] = []
  readonly paras: Para[] = []
  readonly tables: Table[] = []
  readonly byRec: Map<number, Para>[] = []
  readonly compressed: boolean
  constructor(readonly bytes: Uint8Array, readonly cfb: Cfb) {
    const budget = new Budget()
    const header = cfb.streams.get('FileHeader')?.data
    if (!header || header.length < 40 || Buffer.from(header.subarray(0, 17)).toString('latin1') !== 'HWP Document File') refuseDoc('it is not an HWP 5 document')
    if (header[35] !== 5) refuseDoc(`it is an HWP ${header[35]} document (only HWP 5 is changed)`)
    const flags = u32(header, 36)
    for (const [bit, why] of FLAGS_REFUSED) if (flags & bit) refuseDoc(why)
    this.compressed = (flags & 1) !== 0
    const stream = (p: string) => cfb.streams.get(p)?.data
    for (const p of cfb.streams.keys()) {
      for (const [re, why] of STREAMS_REFUSED) if (re.test(p)) refuseDoc(why)
      if (/^BinData\//i.test(p)) {
        const d = stream(p)!
        const heads = [d, inflatedHead(d)].filter((x): x is Uint8Array => !!x)
        if (heads.some((h) => isCfb(h) || isCfb(h.subarray(4)))) refuseDoc(`${p} is an embedded compound file (an OLE object)`)
        if (PROGRAM_NAME.test(p) || heads.some((h) => isProgram(h) || isProgram(h.subarray(4)))) refuseDoc(`${p} is a program or a script`)
      }
    }
    for (const e of cfb.entries) if (e.type === 1 && /^(XMLTemplate|ViewText)$/i.test(e.path)) refuseDoc(e.path === 'ViewText' ? 'it is a distribution-only document (배포용)' : 'it holds an XML form template (XMLTemplate)')
    // DocOptions/_LinkDoc: a WCHAR path (to the end of 260) and two flags; Hangul leaves the path empty unless the
    // document is linked to another one (the bytes after the first NUL are left over from Hangul's memory)
    const link = stream('DocOptions/_LinkDoc')
    if (link && link.length >= 2 && u16(link, 0) !== 0) refuseDoc('it is linked to another document (문서 연결)')
    const script = stream('Scripts/DefaultJScript')
    if (script && !defaultScript(this.compressed ? budget.inflate(script, 'Scripts/DefaultJScript') : script)) refuseDoc('it contains scripts (Scripts/)')

    // DocInfo: pictures and objects (BIN_DATA), distribution data, tracked changes; the outline levels for headings
    let outline = new Map<number, number>()
    const recBudget = { left: HWP_EDIT_LIMITS.records }
    const docInfo = stream('DocInfo')
    if (docInfo) {
      const d = this.compressed ? budget.inflate(docInfo, 'DocInfo') : docInfo
      const recs = new Recs(d, 'DocInfo', recBudget)
      for (let r = 0; r < recs.n; r++) {
        const t = recs.tag[r]!
        if (t === TAG.DIST_DOC_DATA) refuseDoc('it is a distribution-only document (배포용)')
        if (t === TAG.TRACK_CHANGE || t === TAG.TRACK_CHANGE_AUTHOR) refuseDoc('it has tracked changes (변경 추적); accept or reject them in Hangul first')
        if (t === TAG.BIN_DATA) {
          const b = recs.body(r)
          if (b.length < 2) refuseDoc('a picture or object entry (BIN_DATA) is damaged')
          const kind = u16(b, 0) & 0xf
          if (kind === 0) refuseDoc('it links a picture or file outside the document')
          if (kind === 2) refuseDoc('it contains an embedded OLE object')
          if (kind !== 1) refuseDoc('it holds a picture or object of a kind this editor does not know')
          const n = b.length >= 6 ? u16(b, 4) : 0
          const ext = b.length >= 6 + n * 2 ? Buffer.from(b.subarray(6, 6 + n * 2)).toString('utf16le') : ''
          if (/^ole$/i.test(ext)) refuseDoc('it contains an embedded OLE object')
          if (PROGRAM_NAME.test(`x.${ext}`)) refuseDoc(`it embeds a program or a script (.${ext})`)
        }
      }
      outline = hwpOutline(d)
    }

    // the sections in hwp.ts's order (by number)
    const names = [...cfb.streams.keys()].filter((p) => /^BodyText\/Section\d+$/.test(p))
      .sort((a, b) => Number(/\d+$/.exec(a)![0]) - Number(/\d+$/.exec(b)![0]))
    if (!names.length) refuseDoc('it has no body sections (BodyText/Section0)')
    if (names.length > HWP_EDIT_LIMITS.sections) refuseDoc(`it has more than ${HWP_EDIT_LIMITS.sections} sections`)
    let chars = 0
    for (const name of names) {
      const s = stream(name)!
      const raw = this.compressed ? budget.inflate(s, name) : s
      const recs = new Recs(raw, name, recBudget)
      const si = this.sections.length
      this.sections.push({ name, stream: s, raw, recs })
      if (recs.n && recs.level[0] !== 0) refuseDoc(`${name} is damaged (it does not start with a paragraph)`)
      for (let r = 1; r < recs.n; r++) if (recs.level[r]! > recs.level[r - 1]! + 1) refuseDoc(`${name} is damaged (a record is not under the one before it)`)
      const byRec = new Map<number, Para>()
      this.byRec.push(byRec)
      for (let r = 0; r < recs.n; r++) {
        const t = recs.tag[r]!
        if (t === TAG.SHAPE_OLE) refuseDoc('it contains an embedded OLE object')
        if (t === TAG.VIDEO_DATA) refuseDoc('it contains a video')
        if (t === TAG.TRACK_CHANGE || t === TAG.TRACK_CHANGE_AUTHOR) refuseDoc('it has tracked changes (변경 추적); accept or reject them in Hangul first')
        if (t === TAG.CTRL_HEADER) this.checkControl(recs, r)
        if (t !== TAG.PARA_HEADER) continue
        const L = recs.level[r]!
        const p: Para = { i: this.paras.length, sec: si, rec: r, end: recs.subtreeEnd(r), level: L, text: '', heading: 0, texts: [], shapes: [], lines: [], ranges: [], ctrls: [], others: [], w: new Uint16Array(0), units: [] }
        for (let j = r + 1; j < p.end; j++) {
          if (recs.level[j] !== L + 1) continue
          const k = recs.tag[j]!
          ;(k === TAG.PARA_TEXT ? p.texts : k === TAG.PARA_CHAR_SHAPE ? p.shapes : k === TAG.PARA_LINE_SEG ? p.lines : k === TAG.PARA_RANGE_TAG ? p.ranges : k === TAG.CTRL_HEADER ? p.ctrls : p.others).push(j)
        }
        // the heading level, as hwp.ts takes it (the paragraph shape at byte 8)
        p.heading = recs.size[r]! >= 10 ? outline.get(u16(recs.bytes, recs.data[r]! + 8)) ?? 0 : 0
        readText(p, recs)
        chars += p.text.length
        if (chars > HWPX_TEXT_MAX) refuseDoc(`its text is longer than ${HWPX_TEXT_MAX.toLocaleString('en')} characters`)
        this.paras.push(p)
        byRec.set(r, p)
      }
    }
    for (const [si, s] of this.sections.entries()) {
      for (let r = 0; r < s.recs.n; r++) if (s.recs.tag[r] === TAG.CTRL_HEADER && s.recs.size[r]! >= 4 && ctrlId(s.recs.bytes, s.recs.data[r]!) === 'tbl ') this.readTable(si, r)
    }
  }

  /** a field's command must not point outside the document (a link only at the web or mail) */
  private checkControl(recs: Recs, r: number) {
    const b = recs.body(r)
    if (b.length < 4) return
    const id = ctrlId(b, 0)
    if (!id.startsWith('%')) return
    // field: id, attribute (4), extra attribute (1), command length (WORD), command (WCHARs), ...
    const n = b.length >= 11 ? u16(b, 9) : -1
    if (n < 0 || 11 + n * 2 > b.length) {
      if (id === '%hlk') refuseDoc('a link could not be read')
      return
    }
    const command = Buffer.from(b.subarray(11, 11 + n * 2)).toString('utf16le')
    if (outside(command)) refuseDoc(`a field refers to a file, program or address outside the document (${clip(command, 60)})`)
    if (id === '%hlk' && badLinkTarget(command.split(';')[0] ?? '')) refuseDoc(`a link points at something that is not a web or mail address (${clip(command, 60)})`)
  }

  private readTable(si: number, ctrl: number) {
    const recs = this.sections[si]!.recs
    const L = recs.level[ctrl]!
    const end = recs.subtreeEnd(ctrl)
    let owner: Para | null = null
    for (let j = ctrl - 1; j >= 0; j--) if (recs.level[j]! < L) { owner = recs.tag[j] === TAG.PARA_HEADER ? this.byRec[si]!.get(j) ?? null : null; break }
    const t: Table = { i: this.tables.length, sec: si, ctrl, rec: -1, cells: [], para: owner, bad: null, rowSizes: [], cols: 0 }
    this.tables.push(t)
    const fail = (why: string) => { t.bad = why; t.cells = [] }
    const cells: Cell[] = []
    for (let j = ctrl + 1; j < end;) {
      if (recs.level[j] !== L + 1) { j++; continue }
      const tag = recs.tag[j]!
      if (tag === TAG.TABLE) { if (t.rec >= 0) return fail('it has two table records'); t.rec = j; j++; continue }
      if (tag === TAG.LIST_HEADER) {
        // a list (a cell after the TABLE record, the caption before it) and its paragraphs, at the same level
        const lh = recs.body(j)
        const paras: Para[] = []
        let k = j + 1
        while (k < end && recs.level[k] === L + 1 && recs.tag[k] === TAG.PARA_HEADER) { paras.push(this.byRec[si]!.get(k)!); k = recs.subtreeEnd(k) }
        if (lh.length < 2 || u16(lh, 0) !== paras.length) return fail('a list of its paragraphs does not say how many it has')
        if (t.rec >= 0) {
          if (lh.length < 24) return fail('a cell record is shorter than a cell')
          const cell: Cell = { table: t, row: u16(lh, 10), col: u16(lh, 8), colSpan: Math.max(1, u16(lh, 12)), rowSpan: Math.max(1, u16(lh, 14)), height: u32(lh, 20), paras, lh: j, end: k }
          for (const p of paras) p.cell = cell
          cells.push(cell)
        }
        j = k
        continue
      }
      if (tag === TAG.PARA_HEADER) return fail('it has a paragraph outside its cells')
      j = recs.subtreeEnd(j)
    }
    if (t.rec < 0) return fail('it has no table record')
    const tb = recs.body(t.rec)
    const R = tb.length >= 8 ? u16(tb, 4) : -1
    if (R < 0 || tb.length < 20 + 2 * R) return fail('its table record is damaged')
    t.cols = u16(tb, 6)
    for (let r = 0; r < R; r++) t.rowSizes.push(u16(tb, 18 + 2 * r))
    if (t.rowSizes.reduce((a, b) => a + b, 0) !== cells.length) return fail('its rows do not have the cells its table record says')
    t.cells = cells
  }

  lines() { return docLines(this.paras) }
}

/**
 * Hangul's default script, which every document it saves carries (Scripts/DefaultJScript): four WCHAR strings, each
 * after its DWORD length (header, source, pre and post script), then 0xFFFFFFFF. Only the empty one and the template
 * Hangul writes (var Documents = XHwpDocuments; ... function OnDocument_New() { //todo }) pass; any other code is a
 * script.
 */
function defaultScript(b: Uint8Array): boolean {
  const parts: string[] = []
  let at = 0
  for (let k = 0; k < 4; k++) {
    if (at + 4 > b.length) return false
    const n = u32(b, at)
    at += 4
    if (n > (b.length - at) / 2) return false
    parts.push(Buffer.from(b.subarray(at, at + n * 2)).toString('utf16le'))
    at += n * 2
  }
  const rest = b.subarray(at)
  if (rest.length && !(rest.length === 4 && u32(rest, 0) === 0xffffffff)) return false
  const flat = (s: string) => s.replace(/\/\/[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '').replace(/\0+$/, '')
  const [head, source, pre, post] = parts.map(flat)
  return ['', 'varDocuments=XHwpDocuments;varDocument=Documents.Active_XHwpDocument;'].includes(head!)
    && ['', 'functionOnDocument_New(){}'].includes(source!) && pre === '' && post === ''
}

/** Why a paragraph's records do not agree with each other (counts in its header, its text and character shapes), or
 * null. A paragraph is changed only when they agree. */
function paraIssue(p: Para, recs: Recs): string | null {
  const h = recs.body(p.rec)
  if (h.length < 22) return 'its header is short'
  if (p.others.length) return `it holds a record this editor does not know (tag ${recs.tag[p.others[0]!]})`
  if (p.texts.length > 1) return 'its text is split over records'
  if (p.shapes.length !== 1 || p.lines.length > 1 || p.ranges.length > 1) return 'its records are not one of each'
  if (p.texts.length && recs.size[p.texts[0]!]! % 2) return 'its text record is damaged'
  if ((u32(h, 0) & 0x7fffffff) !== p.w.length) return 'its character count does not match its text'
  if (p.w[p.w.length - 1] !== PARA_END) return 'its text does not end the paragraph'
  for (const u of p.units) {
    if (u.kind === 'end' && u.w !== p.w.length - 1) return 'it ends the paragraph twice'
    if (u.kind === 'tab' || u.kind === 'ctrl') if (u.w + 8 > p.w.length || p.w[u.w + 7] !== u.code) return 'a control in its text is damaged'
  }
  if (p.ctrls.length !== p.units.filter((u) => u.kind === 'ctrl' && EXTENDED.has(u.code)).length) return 'its controls do not match its text'
  const cs = recs.body(p.shapes[0]!)
  if (u16(h, 12) !== cs.length / 8 || cs.length % 8 || !cs.length) return 'its character shapes do not match its header'
  let last = -1
  for (let o = 0; o < cs.length; o += 8) {
    const pos = u32(cs, o)
    if ((o === 0 && pos !== 0) || pos <= last || pos >= p.w.length) return 'its character shape positions are damaged'
    last = pos
  }
  const ls = p.lines.length ? recs.size[p.lines[0]!]! : 0
  if (ls % 36 || u16(h, 16) !== ls / 36) return 'its line layout does not match its header'
  if (u16(h, 14) !== (p.ranges.length ? recs.size[p.ranges[0]!]! / 12 : 0)) return 'its range tags do not match its header'
  return null
}

// ---------------------------------------------------------------- the changes
/** a paragraph's WCHARs [wfrom, wto) replaced by `text` */
interface WEdit { wfrom: number; wto: number; text: string; change: number }
/** bytes [start, end) of a section's records replaced */
interface Splice { sec: number; start: number; end: number; bytes: Uint8Array; change: number; seq: number }

class Editor extends ChangeEditor<Para, Cell, Table> {
  /** paragraphs written again: their text edits, and whether their layout cache goes (always, when they change) */
  readonly pending = new Map<Para, { edits: WEdit[]; lines: boolean }>()
  readonly splices: Splice[] = []

  constructor(private doc: Doc) { super(doc.paras, doc.tables) }

  private touch(p: Para) {
    let x = this.pending.get(p)
    if (!x) { x = { edits: [], lines: true }; this.pending.set(p, x) }
    return x
  }
  private splice(sec: number, start: number, end: number, bytes: Uint8Array, change: number) {
    this.splices.push({ sec, start, end, bytes, change, seq: this.splices.length })
  }
  private recs(p: { sec: number }) { return this.doc.sections[p.sec]!.recs }

  /** refuses a change to a paragraph whose records this editor would not write again exactly */
  private checkPara(p: Para, i: number) {
    const recs = this.recs(p)
    if (p.ranges.length) refuseChange(i, `the paragraph ${clip(p.text, 60)} has highlighting or tracked changes (range tags), which a change cannot keep; change it in Hangul`)
    const why = paraIssue(p, recs)
    if (why) refuseChange(i, `the paragraph ${clip(p.text, 60)} cannot be changed here (${why})`)
  }

  // ---- find / replace
  protected replaceAt(p: Para, from: number, to: number, text: string, i: number) {
    this.checkPara(p, i)
    const odd = p.units.find((u) => (u.len > 0 ? u.at < to && u.at + u.len > from : u.at > from && u.at < to))
    if (odd) refuseChange(i, `${clip(p.text.slice(from, to))} runs across ${unitName(odd)}, which a change cannot keep; change the text on each side of it separately`)
    const cw = charWchars(p)
    const wfrom = cw[from]!, wto = cw[to - 1]! + 1
    if (wto - wfrom !== to - from) refuseChange(i, `${clip(p.text.slice(from, to))} is not plain text in its paragraph`)
    const shapes = this.shapesIn(p, wfrom, wto)
    if (shapes.length > 1) refuseChange(i, `${clip(p.text.slice(from, to))} has more than one formatting (character shapes ${shapes.join(' and ')}), so the new text's formatting is not clear; replace the differently formatted parts separately`)
    this.touch(p).edits.push({ wfrom, wto, text, change: i })
  }

  /** the character shapes of WCHARs [wfrom, wto) */
  private shapesIn(p: Para, wfrom: number, wto: number): number[] {
    const cs = this.recs(p).body(p.shapes[0]!)
    const out = new Set<number>()
    for (let o = 0; o < cs.length; o += 8) {
      const pos = u32(cs, o), next = o + 8 < cs.length ? u32(cs, o + 8) : Infinity
      if (pos < wto && next > wfrom) out.add(u32(cs, o + 4))
    }
    return [...out]
  }

  // ---- an empty cell
  protected inside(cell: Cell): Para[] {
    return this.doc.paras.filter((q) => q.sec === cell.table.sec && q.rec > cell.lh && q.rec < cell.end)
  }

  protected fillAt(cell: Cell, p: Para, value: string, where: string, i: number) {
    // what an empty cell may hold besides white space: a field (누름틀) and its end, a bookmark, a space mark
    const allowed = (u: Unit) => u.kind === 'end' || (u.kind === 'ctrl' && (u.code === 3 || u.code === 4 || u.code === 22)) || (u.kind === 'char-ctrl' && (u.code === 30 || u.code === 31))
    const odd = cell.paras.flatMap((q) => q.units).find((u) => !allowed(u))
    if (odd) refuseChange(i, `the cell at ${where} holds ${unitName(odd)}, so it is not an empty cell to fill`)
    this.checkPara(p, i)
    this.notChanged(p, i)
    const begins = p.units.filter((u) => u.kind === 'ctrl' && u.code === 3)
    if (begins.length > 1) refuseChange(i, `the cell at ${where} holds more than one field; write in it with find and replace`)
    // the white space goes; the value goes inside the field (after its start), where Hangul shows a filled field's
    // text, or where the white space began, or before the paragraph's end
    const cw = charWchars(p)
    const runs: [number, number][] = []
    for (let k = 0; k < p.text.length; k++) {
      const w = cw[k]!
      const last = runs[runs.length - 1]
      if (last && last[1] === w) last[1] = w + 1
      else runs.push([w, w + 1])
    }
    const at = begins[0] ? begins[0].w + 8 : runs[0]?.[0] ?? p.w.length - 1
    const edits = runs.map(([s, e]) => ({ wfrom: s, wto: e, text: s === at ? value : '', change: i }))
    if (!edits.some((e) => e.wfrom === at)) edits.push({ wfrom: at, wto: at, text: value, change: i })
    this.touch(p).edits.push(...edits)
  }

  // ---- rows
  protected checkTable(t: Table, i: number) {
    if (t.bad) refuseChange(i, `table ${t.i + 1} cannot be changed here (${t.bad})`)
  }

  protected tableRows(t: Table) {
    const rows: Cell[][] = []
    let k = 0
    for (const n of t.rowSizes) { rows.push(t.cells.slice(k, k + n)); k += n }
    return { rows, declared: String(t.rowSizes.length), cols: t.cols }
  }

  protected checkCopyRow(plan: RowPlan<Cell, Table>, i: number) {
    const { C, T } = plan
    const cannot = (why: string): never => refuseChange(i, `row ${C} of ${T} cannot be copied (${why}); copy a row with only text in its cells (copy_row)`)
    for (const cell of plan.cells) {
      const p = cell.paras[0] ?? refuseChange(i, `a cell of row ${C} of ${T} has no text run to copy`)
      if (this.inside(cell).some((q) => !cell.paras.includes(q))) cannot('holds a table or an object')
      const odd = cell.paras.flatMap((q) => q.units).find((u) => u.kind === 'ctrl' || (u.kind === 'char-ctrl' && ![24, 30, 31].includes(u.code)))
      if (odd) cannot(`holds ${unitName(odd)}`)
      const recs = this.recs(p)
      if (recs.size[p.rec]! < 22 || p.shapes.length !== 1 || recs.size[p.shapes[0]!]! < 8) cannot('its paragraph records are not ones this editor knows')
    }
  }

  protected rowsAt(plan: RowPlan<Cell, Table>, i: number): number {
    const { t, A, cells, T } = plan
    const recs = this.recs(t)
    const k = plan.rows.length
    // the new rows go after the last cell of row A
    const rows = this.tableRows(t).rows
    const last = rows[A - 1]![rows[A - 1]!.length - 1]!
    const at = recs.offset(last.end)
    const out: Uint8Array[] = []
    for (const [n, values] of plan.rows.entries()) for (const [ci, cell] of cells.entries()) out.push(...this.cellCopy(cell, A + n, values[ci]!))
    this.splice(t.sec, at, at, Buffer.concat(out), i)
    // the TABLE record: row count, cells per row, the cell zones' rows (5.0.1.0 and later)
    const tb = recs.body(t.rec)
    const R = t.rowSizes.length
    const tail = tb.subarray(18 + 2 * R)
    const zones = tail.length >= 4 ? u16(tail, 2) : 0
    if (!(tail.length === 2 || tail.length === 4 + 10 * zones)) refuseChange(i, `the table record of ${T} is not one this editor knows`)
    const sizes = [...t.rowSizes.slice(0, A), ...Array<number>(k).fill(t.rowSizes[plan.C - 1]!), ...t.rowSizes.slice(A)]
    const nb = new Uint8Array(18 + 2 * sizes.length + tail.length)
    nb.set(tb.subarray(0, 18))
    put16(nb, 4, R + k)
    sizes.forEach((s, r) => put16(nb, 18 + 2 * r, s))
    nb.set(tail, 18 + 2 * sizes.length)
    for (let z = 0; z < zones; z++) {
      const o = 18 + 2 * sizes.length + 4 + 10 * z
      for (const f of [2, 6]) { const row = u16(nb, o + f); if (row >= A) put16(nb, o + f, row + k) }
    }
    this.splice(t.sec, recs.start[t.rec]!, recs.end(t.rec), hwpRecord(TAG.TABLE, recs.level[t.rec]!, nb), i)
    // the rows below move down
    for (const c of t.cells) {
      if (c.row < A) continue
      const o = recs.data[c.lh]! + 10
      const b = new Uint8Array(2); put16(b, 0, c.row + k)
      this.splice(t.sec, o, o + 2, b, i)
    }
    // the table's height (its object properties in CTRL_HEADER: id, attribute, offsets, width, height): an estimate,
    // the copied row's height as the table's height per row says it or its cells, whichever is larger
    if (recs.size[t.ctrl]! >= 24) {
      const o = recs.data[t.ctrl]! + 20
      const h = u32(recs.bytes, o)
      const row = Math.max(Math.round(h / R), ...cells.map((c) => c.height))
      const b = new Uint8Array(4); put32(b, 0, Math.min(0x7fffffff, h + k * row))
      this.splice(t.sec, o, o + 4, b, i)
    }
    // the paragraph that holds the table, and those around it, are laid out again
    for (let p = t.para; p; p = p.cell ? p.cell.table.para : null) {
      const why = paraIssue(p, this.recs(p))
      if (why) refuseChange(i, `the paragraph that holds ${T} cannot be changed here (${why})`)
      this.touch(p)
    }
    // the new paragraphs go before the first paragraph after the place in reading order
    const next = this.doc.paras.find((p) => p.sec > t.sec || (p.sec === t.sec && p.rec >= last.end))
    return next ? next.i : this.doc.paras.length
  }

  /** the records of a copy of `cell` for row `row` (0-based) with `value`: its LIST_HEADER with one paragraph, a copy of
   * its first paragraph's header with the new counts, the text, its first character shape */
  private cellCopy(cell: Cell, row: number, value: string): Uint8Array[] {
    const recs = this.recs(cell.table)
    const lh = recs.body(cell.lh).slice()
    put16(lh, 0, 1)
    put16(lh, 10, row)
    const p = cell.paras[0]!
    const h = recs.body(p.rec).slice()
    const w = wchars(value)
    const text = new Uint16Array(w.length + 1); text.set(w); text[w.length] = PARA_END
    put32(h, 0, (text.length | 0x80000000) >>> 0)
    put32(h, 4, w.includes(LINE_BREAK) ? 1 << LINE_BREAK : 0)
    put16(h, 12, 1)
    put16(h, 14, 0)
    put16(h, 16, 0)
    const cs = new Uint8Array(8); put32(cs, 4, u32(recs.body(p.shapes[0]!), 4))
    const L = recs.level[p.rec]!
    return [hwpRecord(TAG.LIST_HEADER, recs.level[cell.lh]!, lh), hwpRecord(TAG.PARA_HEADER, L, h), ...(w.length ? [hwpRecord(TAG.PARA_TEXT, L + 1, wbytes(text))] : []), hwpRecord(TAG.PARA_CHAR_SHAPE, L + 1, cs)]
  }

  /** each pending paragraph's records written again: header, text, character shapes; its layout cache taken out */
  finish() {
    for (const [p, x] of this.pending) {
      const recs = this.recs(p)
      const h = recs.body(p.rec).slice()
      const edits = x.edits.sort((a, b) => a.wfrom - b.wfrom || a.wto - b.wto)
      for (let k = 1; k < edits.length; k++) {
        const a = edits[k - 1]!, b = edits[k]!
        if (b.wfrom < a.wto || (b.wfrom === a.wfrom && b.wto === a.wto)) refuseChange(Math.max(a.change, b.change), a.change !== b.change ? `it changes the same text as change ${Math.min(a.change, b.change) + 1}` : 'it changes the same text twice')
      }
      if (edits.length) {
        // the text, and the character shape positions moved with it (a run emptied by the change goes)
        const parts: Uint16Array[] = []
        let pos = 0
        for (const e of edits) { parts.push(p.w.subarray(pos, e.wfrom), wchars(e.text)); pos = e.wto }
        parts.push(p.w.subarray(pos))
        const w = new Uint16Array(parts.reduce((n, a) => n + a.length, 0))
        let o = 0
        for (const a of parts) { w.set(a, o); o += a.length }
        const move = (at: number): number | null => {
          let d = 0
          for (const e of edits) {
            if (at <= e.wfrom) break
            if (at >= e.wto) d += e.text.length - (e.wto - e.wfrom)
            else return null
          }
          return at + d
        }
        const cs = recs.body(p.shapes[0]!)
        const pairs: [number, number][] = []
        for (let k = 0; k < cs.length; k += 8) {
          const at = move(u32(cs, k))
          if (at === null) continue
          if (pairs.length && pairs[pairs.length - 1]![0] === at) pairs.pop()
          if (pairs.length && pairs[pairs.length - 1]![1] === u32(cs, k + 4)) continue
          pairs.push([at, u32(cs, k + 4)])
        }
        const nb = new Uint8Array(pairs.length * 8)
        pairs.forEach(([a, s], k) => { put32(nb, k * 8, a); put32(nb, k * 8 + 4, s) })
        put32(h, 0, ((u32(h, 0) & 0x80000000) | w.length) >>> 0)
        if (w.includes(LINE_BREAK)) put32(h, 4, (u32(h, 4) | (1 << LINE_BREAK)) >>> 0)
        put16(h, 12, pairs.length)
        const L = recs.level[p.rec]!
        const change = edits[0]!.change
        const textRec = p.texts[0]
        if (textRec !== undefined) this.splice(p.sec, recs.start[textRec]!, recs.end(textRec), w.length > 1 ? hwpRecord(TAG.PARA_TEXT, L + 1, wbytes(w)) : new Uint8Array(0), change)
        else if (w.length > 1) this.splice(p.sec, recs.end(p.rec), recs.end(p.rec), hwpRecord(TAG.PARA_TEXT, L + 1, wbytes(w)), change)
        this.splice(p.sec, recs.start[p.shapes[0]!]!, recs.end(p.shapes[0]!), hwpRecord(TAG.PARA_CHAR_SHAPE, L + 1, nb), change)
      }
      put16(h, 16, 0)
      const change = edits[0]?.change ?? -1
      this.splice(p.sec, recs.start[p.rec]!, recs.end(p.rec), hwpRecord(TAG.PARA_HEADER, recs.level[p.rec]!, h), change)
      for (const r of p.lines) this.splice(p.sec, recs.start[r]!, recs.end(r), new Uint8Array(0), change)
    }
  }
}

// ---------------------------------------------------------------- the whole edit
/** the streams of a compound file as hwp.ts's reader (SheetJS) reads them */
function sheetStreams(bytes: Uint8Array): Map<string, Uint8Array> {
  const c = XLSX.CFB.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { type: 'buffer' })
  const out = new Map<string, Uint8Array>()
  c.FullPaths.forEach((p: string, i: number) => {
    const e = c.FileIndex[i]
    if (e?.type === 2) out.set(p.replace(/^Root Entry\//, ''), e.content instanceof Uint8Array ? e.content : Uint8Array.from(e.content ?? []))
  })
  return out
}

/** The document's container read twice (our reader and hwp.ts's), and the two must agree on every stream. */
function openCfb(bytes: Uint8Array): Cfb {
  if (bytes.length > HWP_EDIT_LIMITS.bytes) refuseDoc(`it is larger than ${HWP_EDIT_LIMITS.bytes / 1024 / 1024} MB`)
  if (isZip(bytes)) refuseDoc('it is a zip, not a .hwp (a .hwpx under another name?)')
  if (!isCfb(bytes)) refuseDoc('it is not a .hwp file')
  let c: Cfb
  try { c = readCfb(bytes) } catch (e) { return refuseDoc(e instanceof CfbError ? `its container is damaged or unusual (${e.message})` : 'its container could not be read') }
  let s: Map<string, Uint8Array>
  try { s = sheetStreams(bytes) } catch { return refuseDoc('its container could not be read') }
  const ours = [...c.streams.values()]
  if (ours.length !== s.size || ours.some((e) => { const x = s.get(e.path); return !x || !Buffer.from(x).equals(Buffer.from(e.data)) })) refuseDoc('its container does not read the same way with both readers')
  return c
}

/** The document opened with every check, its text model agreeing with hwp.ts's reading. */
function openDoc(bytes: Uint8Array): Doc {
  const doc = new Doc(bytes, openCfb(bytes))
  const differs = firstDifference(hwpxReadLines(hwpText(bytes)), doc.lines().lines)
  if (differs) refuseDoc(`its text could not be mapped exactly (${differs})`)
  return doc
}

/** Changes the text of a .hwp; the new file and what the read-back needs. ToolError for a change or a document it
 * refuses, and then nothing is written. */
export function editHwp(bytes: Uint8Array, changes: HwpChange[]): { file: Uint8Array; report: HwpEditReport } {
  if (!changes.length) throw new ToolError('no changes given; nothing was saved')
  if (changes.length > HWP_EDIT_LIMITS.changes) throw new ToolError(`more than ${HWP_EDIT_LIMITS.changes} changes in one call; nothing was saved`)
  const doc = openDoc(bytes)
  const before = doc.lines()
  const ed = new Editor(doc)
  changes.forEach((c, i) => ed.apply(c, i))
  const lineEdits = ed.lineEdits()
  ed.finish()

  // the bytes: per section, the splices in order (none may overlap another), deflated again when the document is
  const replace = new Map<string, Uint8Array>()
  const raws = new Map<string, Uint8Array>()
  for (const [si, sec] of doc.sections.entries()) {
    const list = ed.splices.filter((e) => e.sec === si).sort((a, b) => a.start - b.start || a.end - b.end || a.seq - b.seq)
    if (!list.length) continue
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1]!, b = list[k]!
      if (b.start < a.end) refuseChange(Math.max(a.change, b.change, 0), a.change >= 0 && b.change >= 0 && a.change !== b.change ? `it changes the same text as change ${Math.min(a.change, b.change) + 1}` : 'it changes the same text twice')
    }
    const parts: Uint8Array[] = []
    let pos = 0
    for (const e of list) { parts.push(sec.raw.subarray(pos, e.start), e.bytes); pos = e.end }
    parts.push(sec.raw.subarray(pos))
    const raw = new Uint8Array(Buffer.concat(parts))
    if (raw.length > HWP_EDIT_LIMITS.stream) throw new ToolError(`the changed ${sec.name} would be larger than ${HWP_EDIT_LIMITS.stream / 1024 / 1024} MB; nothing was saved`)
    raws.set(sec.name, raw)
    replace.set(sec.name, doc.compressed ? new Uint8Array(zlib.deflateRawSync(raw)) : raw)
  }
  let file: Uint8Array
  try { file = writeCfb(doc.cfb, replace) } catch (e) { throw new ToolError(`the changed document could not be written (${String((e as Error).message).slice(0, 120)}); nothing was saved`) }
  if (file.length > HWP_EDIT_LIMITS.bytes) throw new ToolError(`the changed document would be larger than ${HWP_EDIT_LIMITS.bytes / 1024 / 1024} MB; nothing was saved`)

  // read back: the container has the old directory and every stream but the changed sections byte for byte (as both
  // readers see it); each changed section expands to what was written; the document passes every check again and its
  // text is the old text with the changes, nothing else; and no paragraph's records disagree that agreed before
  const back = (why: string): never => { throw new ToolError(`the changed document did not read back as expected (${why}); nothing was saved`) }
  let again: Cfb
  try { again = readCfb(file) } catch (e) { return back(String((e as Error).message)) }
  const parts = cfbMismatch(doc.cfb, again, (p) => replace.has(p))
  if (parts) back(parts)
  for (const [name, raw] of raws) {
    const got = again.streams.get(name)!.data
    const expanded = doc.compressed ? zlib.inflateRawSync(got, { maxOutputLength: HWP_EDIT_LIMITS.stream }) : got
    if (!Buffer.from(expanded).equals(Buffer.from(raw))) back(name)
  }
  const now = openDoc(file)
  const issues = (d: Doc) => d.paras.map((p) => paraIssue(p, d.sections[p.sec]!.recs)).filter((x) => x !== null).sort()
  if (issues(doc).join('\n') !== issues(now).join('\n')) back('a paragraph\'s records no longer agree')
  const want = applyLineEdits(before.lines, lineEdits)
  const after = hwpxReadLines(hwpText(file))
  const diff = want ? firstDifference(want, after) : 'the changes do not fit the document'
  if (diff) back(diff)
  return { file, report: { lineEdits, notes: ed.notes, placeholders: placeholdersIn(after) } }
}

/** What the editor sees in a .hwp (tests and checks): each paragraph's text, heading, character shapes (position, id),
 * line count and cell; each table's rows and cells. Every document check runs first, as for an edit. */
export function hwpEditModel(bytes: Uint8Array) {
  const doc = openDoc(bytes)
  const shapes = (p: Para) => { const b = doc.sections[p.sec]!.recs.body(p.shapes[0] ?? p.rec); const out: [number, number][] = []; if (p.shapes.length) for (let o = 0; o + 8 <= b.length; o += 8) out.push([u32(b, o), u32(b, o + 4)]); return out }
  return {
    compressed: doc.compressed,
    paras: doc.paras.map((p) => ({
      text: p.text, heading: p.heading, shapes: shapes(p), lines: p.lines.length ? doc.sections[p.sec]!.recs.size[p.lines[0]!]! / 36 : 0,
      header: Array.from(doc.sections[p.sec]!.recs.body(p.rec)), cell: p.cell ? { table: p.cell.table.i + 1, row: p.cell.row + 1, col: p.cell.col + 1 } : null,
    })),
    tables: doc.tables.map((t) => ({
      bad: t.bad, rowSizes: t.rowSizes, cols: t.cols,
      height: doc.sections[t.sec]!.recs.size[t.ctrl]! >= 24 ? u32(doc.sections[t.sec]!.recs.body(t.ctrl), 20) : null,
      cells: t.cells.map((c) => ({ row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, height: c.height, text: c.paras.map((p) => p.text).join('\n') })),
    })),
  }
}

/** The office worker's `hwp-verify` mode: a file the editor made goes through every check of a document to change
 * again, in a fresh worker (the server does not trust the one that made it): the container read the same by both
 * readers, the document rules, and the text model agreeing with hwp.ts. "ok" out, or the refusal. */
export function hwpVerifyRequest(input: Uint8Array): Uint8Array {
  openDoc(input)
  return new TextEncoder().encode('ok')
}

/** The office worker's `hwp-edit` mode: the framed request of hwpx-check.ts in, the framed report and file out. */
export function hwpEditRequest(input: Uint8Array): Uint8Array {
  let req: ReturnType<typeof decodeHwpEditRequest>
  try { req = decodeHwpEditRequest(input) } catch { throw new ToolError('the .hwp editor got a damaged request') }
  const { file, report } = editHwp(req.doc, asChanges(req.changes, '.hwp'))
  return encodeHwpEditResult(report, file)
}
