// Test helpers for edit_hwp's .hwp (HWP 5.x): documents built here, record by record, as Hangul writes them (no
// third-party documents in the repo; every name, company and address in them is made up), and readers of a file's
// streams and records. The layouts follow Hancom's public HWP 5.0 document and files Hangul saved.
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'

const CFB = XLSX.CFB
export const TAG = { DOC_PROPS: 16, ID_MAPPINGS: 17, BIN_DATA: 18, CHAR_SHAPE: 21, PARA_SHAPE: 25, TRACK_CHANGE: 96, PARA_HEADER: 66, PARA_TEXT: 67, PARA_CHAR_SHAPE: 68, PARA_LINE_SEG: 69, PARA_RANGE_TAG: 70, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77, SHAPE_COMPONENT: 76, SHAPE_OLE: 84, SHAPE_PICTURE: 85, CTRL_DATA: 87, VIDEO_DATA: 98 }

/** A record: tag, level, data (the extended size form from 0xFFF bytes on, or always with `ext`). */
export function rec(tag: number, level: number, data: Uint8Array, ext = false): Buffer {
  const big = ext || data.length >= 0xfff
  const h = Buffer.alloc(big ? 8 : 4)
  h.writeUInt32LE(((tag & 0x3ff) | ((level & 0x3ff) << 10) | ((big ? 0xfff : data.length) << 20)) >>> 0, 0)
  if (big) h.writeUInt32LE(data.length, 4)
  return Buffer.concat([h, data])
}
/** a 4-character control id as Hangul stores it (MAKE_4CHID, little-endian: 'tbl ' is the bytes " lbt") */
export const chid = (id: string) => Buffer.from([...id].reverse().join(''), 'latin1')

// ---------------------------------------------------------------- paragraph text
/** a piece of paragraph text: characters, or a control's WCHARs (and the CTRL_HEADER record it needs, if any) */
export interface Piece { w: Buffer; ctrl?: Buffer[] }
const u16s = (codes: number[]) => { const b = Buffer.alloc(codes.length * 2); codes.forEach((c, i) => b.writeUInt16LE(c, i * 2)); return b }
/** an 8-WCHAR control: the code, the id, 4 WCHARs of 0, the code again */
const ctrl8 = (code: number, id = '\0\0\0\0') => { const b = Buffer.alloc(16); b.writeUInt16LE(code, 0); chid(id).copy(b, 2); b.writeUInt16LE(code, 14); return b }
export const tab = (): Piece => ({ w: (() => { const b = Buffer.alloc(16); b.writeUInt16LE(9, 0); b.writeUInt16LE(4000, 2); b.writeUInt16LE(9, 14); return b })() })
export const br = (): Piece => ({ w: u16s([10]) })
export const nbsp = (): Piece => ({ w: u16s([30]) })
export const hyphen = (): Piece => ({ w: u16s([24]) })
/** a field's command record: id, attribute, extra attribute, command (WORD length, WCHARs), field id */
export function fieldHeader(id: string, command: string, level: number): Buffer {
  const cmd = Buffer.from(command, 'utf16le')
  const d = Buffer.alloc(4 + 4 + 1 + 2 + cmd.length + 4)
  chid(id).copy(d, 0); d.writeUInt32LE(0x8001, 4); d[8] = 9; d.writeUInt16LE(command.length, 9); cmd.copy(d, 11); d.writeUInt32LE(0x2a2f2c27, 11 + cmd.length)
  return rec(TAG.CTRL_HEADER, level, d)
}
/** a click-here field (누름틀) start, or a hyperlink start, with its CTRL_HEADER at the paragraph's child level */
export const fieldBegin = (id = '%clk', command = 'Clickhere:set:66:Direction:wstring:7:여기를 누르세요 HelpState:wstring:0: ', level = 1): Piece =>
  ({ w: ctrl8(3, id), ctrl: [fieldHeader(id, command, level)] })
export const fieldEnd = (id = '%clk'): Piece => ({ w: ctrl8(4, id) })
export const bookmark = (level = 1): Piece => ({ w: ctrl8(22, 'bokm'), ctrl: [rec(TAG.CTRL_HEADER, level, Buffer.concat([chid('bokm'), Buffer.alloc(4)]))] })
/** an automatic number (atno) */
export const autoNumber = (level = 1): Piece => ({ w: ctrl8(18, 'atno'), ctrl: [rec(TAG.CTRL_HEADER, level, Buffer.concat([chid('atno'), Buffer.alloc(8)]))] })
/** the section and column definitions Hangul puts first in a section (secd, cold), with their records */
export const sectionDef = (): Piece => ({
  w: Buffer.concat([ctrl8(2, 'secd'), ctrl8(2, 'cold')]),
  ctrl: [
    Buffer.concat([
      rec(TAG.CTRL_HEADER, 1, Buffer.concat([chid('secd'), Buffer.from('000000006e0400000000401f00000100000000000000000000000000000000000000000000000000000000', 'hex').subarray(0, 43)])),
      rec(73, 2, Buffer.from('88e80000dc4801003821000038210000241600009c1000009c1000009c1000000000000000000000', 'hex')),
    ]),
    rec(TAG.CTRL_HEADER, 1, Buffer.concat([chid('cold'), Buffer.from('1000000000000000', 'hex')])),
  ],
})

export interface ParaOpts {
  /** paragraph shape (DocInfo PARA_SHAPE index) */
  paraShape?: number
  level?: number
  /** cached layout lines (PARA_LINE_SEG); default 1 */
  lines?: number
  /** the "last in list" bit of the character count */
  last?: boolean
  /** range tags (highlighting): [start, end, tag] */
  ranges?: [number, number, number][]
  /** records put under the paragraph after its own (unknown ones too) */
  extra?: Buffer[]
  /** the PARA_TEXT written in the extended size form even when small */
  extText?: boolean
}
/** A paragraph: runs of [character shape, text or pieces]; a string is one run in shape 0. */
export function para(runs: string | [number, string | Piece | (string | Piece)[]][], o: ParaOpts = {}): Buffer {
  const L = o.level ?? 0
  const list = typeof runs === 'string' ? [[0, runs] as [number, string]] : runs
  const parts: Buffer[] = []
  const ctrls: Buffer[] = []
  const shapes: [number, number][] = []
  let pos = 0
  let mask = 0
  for (const [shape, content] of list) {
    if (!shapes.length || shapes[shapes.length - 1]![1] !== shape) shapes.push([pos, shape])
    for (const x of Array.isArray(content) ? content : [content]) {
      const w = typeof x === 'string' ? Buffer.from(x, 'utf16le') : x.w
      if (typeof x !== 'string') {
        for (let k = 0; k < w.length; k += 2) { const c = w.readUInt16LE(k); if (c < 32) { mask |= 1 << c; if (![0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31].includes(c)) k += 14 } }
        ctrls.push(...(x.ctrl ?? []).map((r) => relevel(r, L + 1)))
      }
      parts.push(w)
      pos += w.length / 2
    }
  }
  const text = Buffer.concat([...parts, u16s([13])])
  const n = text.length / 2
  const h = Buffer.alloc(24)
  h.writeUInt32LE(((o.last ? 0x80000000 : 0) | n) >>> 0, 0)
  h.writeUInt32LE(mask >>> 0, 4)
  h.writeUInt16LE(o.paraShape ?? 0, 8)
  h.writeUInt16LE(shapes.length || 1, 12)
  h.writeUInt16LE(o.ranges?.length ?? 0, 14)
  h.writeUInt16LE(o.lines ?? 1, 16)
  const cs = Buffer.alloc(8 * (shapes.length || 1))
  ;(shapes.length ? shapes : [[0, 0] as [number, number]]).forEach(([p, s], k) => { cs.writeUInt32LE(p, k * 8); cs.writeUInt32LE(s, k * 8 + 4) })
  const segs = Buffer.alloc(36 * (o.lines ?? 1))
  for (let k = 0; k < (o.lines ?? 1); k++) {
    const s = k * 36
    segs.writeUInt32LE(Math.floor((n * k) / (o.lines ?? 1)), s); segs.writeInt32LE(1600 * k, s + 4); segs.writeInt32LE(1000, s + 8); segs.writeInt32LE(1000, s + 12)
    segs.writeInt32LE(850, s + 16); segs.writeInt32LE(600, s + 20); segs.writeInt32LE(42520, s + 28); segs.writeUInt32LE(0x60000, s + 32)
  }
  const rt = Buffer.alloc(12 * (o.ranges?.length ?? 0))
  o.ranges?.forEach(([a, b, t], k) => { rt.writeUInt32LE(a, k * 12); rt.writeUInt32LE(b, k * 12 + 4); rt.writeUInt32LE(t, k * 12 + 8) })
  return Buffer.concat([
    rec(TAG.PARA_HEADER, L, h),
    ...(n > 1 ? [rec(TAG.PARA_TEXT, L + 1, text, o.extText)] : []),
    rec(TAG.PARA_CHAR_SHAPE, L + 1, cs),
    ...(o.lines === 0 ? [] : [rec(TAG.PARA_LINE_SEG, L + 1, segs)]),
    ...(o.ranges?.length ? [rec(TAG.PARA_RANGE_TAG, L + 1, rt)] : []),
    ...ctrls,
    ...(o.extra ?? []),
  ])
}
/** a record (or records) moved to another level, keeping their relative levels */
function relevel(b: Buffer, level: number): Buffer {
  const out: Buffer[] = []
  let base = -1
  for (let i = 0; i < b.length;) {
    const h = b.readUInt32LE(i)
    let size = h >>> 20, d = i + 4
    if (size === 0xfff) { size = b.readUInt32LE(i + 4); d = i + 8 }
    const l = (h >>> 10) & 0x3ff
    if (base < 0) base = l
    out.push(rec(h & 0x3ff, level + (l - base), b.subarray(d, d + size)))
    i = d + size
  }
  return Buffer.concat(out)
}

// ---------------------------------------------------------------- tables
export interface CellSpec { text?: string | [number, string | Piece | (string | Piece)[]][]; colSpan?: number; rowSpan?: number; width: number; height?: number; paras?: Buffer; nParas?: number; shaded?: boolean }
/** A table in its own paragraph, as Hangul writes one: the paragraph with the table control, CTRL_HEADER 'tbl ' (with
 * the table's size), TABLE (rows, columns, cells per row, zones), then each cell's LIST_HEADER and paragraphs. */
export function table(rows: CellSpec[][], o: { level?: number; zones?: [number, number, number, number, number][]; caption?: string; tableHeight?: number; tail?: Buffer } = {}): Buffer {
  const L = o.level ?? 0
  const occupied = new Set<string>()
  const cells: Buffer[] = []
  let width = 0
  rows.forEach((cs, r) => {
    let c = 0, w = 0
    for (const cell of cs) {
      while (occupied.has(`${r}:${c}`)) c++
      const csp = cell.colSpan ?? 1, rsp = cell.rowSpan ?? 1
      for (let i = 0; i < rsp; i++) for (let j = 0; j < csp; j++) occupied.add(`${r + i}:${c + j}`)
      const lh = Buffer.alloc(47)
      lh.writeUInt16LE(cell.nParas ?? 1, 0); lh.writeUInt32LE(0x20, 4)
      lh.writeUInt16LE(c, 8); lh.writeUInt16LE(r, 10); lh.writeUInt16LE(csp, 12); lh.writeUInt16LE(rsp, 14)
      lh.writeUInt32LE(cell.width, 16); lh.writeUInt32LE(cell.height ?? 1282, 20)
      for (const [k, v] of [510, 510, 141, 141].entries()) lh.writeUInt16LE(v, 24 + k * 2)
      lh.writeUInt16LE(cell.shaded ? 4 : 3, 32); lh.writeUInt32LE(cell.width - 1020, 34)
      cells.push(rec(TAG.LIST_HEADER, L + 2, lh), cell.paras ?? para(cell.text ?? '', { level: L + 2, paraShape: 2, last: true }))
      c += csp; w += cell.width
    }
    width = Math.max(width, w)
  })
  const cols = Math.max(...[...occupied].map((k) => Number(k.split(':')[1]) + 1))
  const height = o.tableHeight ?? rows.reduce((h, cs) => h + Math.max(...cs.map((c) => ((c.rowSpan ?? 1) === 1 ? c.height ?? 1282 : 0)), 0), 0)
  const ch = Buffer.alloc(46)
  chid('tbl ').copy(ch, 0); ch.writeUInt32LE(0x082a2210, 4); ch.writeUInt32LE(width, 16); ch.writeUInt32LE(height, 20)
  for (let k = 0; k < 4; k++) ch.writeUInt16LE(283, 28 + k * 2)
  ch.writeUInt32LE(0x5bb840e2, 36)
  const zones = o.zones ?? []
  const t = Buffer.alloc(18 + 2 * rows.length + 4 + 10 * zones.length)
  t.writeUInt32LE(0x4000006, 0); t.writeUInt16LE(rows.length, 4); t.writeUInt16LE(cols, 6)
  for (let k = 0; k < 4; k++) t.writeUInt16LE(510, 10 + k * 2)
  rows.forEach((cs, r) => t.writeUInt16LE(cs.length, 18 + 2 * r))
  const z = 18 + 2 * rows.length
  t.writeUInt16LE(3, z); t.writeUInt16LE(zones.length, z + 2)
  zones.forEach(([sc, sr, ec, er, bf], k) => { const o2 = z + 4 + 10 * k; t.writeUInt16LE(sc, o2); t.writeUInt16LE(sr, o2 + 2); t.writeUInt16LE(ec, o2 + 4); t.writeUInt16LE(er, o2 + 6); t.writeUInt16LE(bf, o2 + 8) })
  const caption = o.caption === undefined ? [] : [rec(TAG.LIST_HEADER, L + 2, Buffer.from('010000000000000003000000382100005203e0a300000000000000000000', 'hex')), para(o.caption, { level: L + 2, last: true })]
  return para([[0, { w: ctrl8(11, 'tbl '), ctrl: [Buffer.concat([rec(TAG.CTRL_HEADER, 1, ch), ...caption.map((b) => relevel(b, 2)), rec(TAG.TABLE, 2, o.tail ? Buffer.concat([t, o.tail]) : t), ...cells.map((b) => relevel(b, 2))])] }]], { level: L })
}

// ---------------------------------------------------------------- the document
export interface DocOpts {
  /** FileHeader attribute flags (bit 0: compressed); default 1 */
  flags?: number
  /** DocInfo records after the default ones */
  docInfo?: Buffer[]
  /** more streams, by path */
  extra?: Record<string, Uint8Array | string>
  /** Hangul's default script streams (Scripts/), and DocOptions/_LinkDoc with an empty path; default true */
  hangulStreams?: boolean
  /** a version other than 5.1.0.1 */
  version?: [number, number, number, number]
  /** streams written under another name (path -> path) */
  rename?: Record<string, string>
}
/** paragraph shapes of the default DocInfo: 0 body, 1 centred, 2 cell, 3 outline level 1 (개요 1), 4 outline level 2 */
export const SHAPE = { body: 0, center: 1, cell: 2, h1: 3, h2: 4 }
/** character shapes: 0 body, 1 bold, 2 title, 3 small */
export const CHAR = { body: 0, bold: 1, title: 2, small: 3 }

export function fileHeader(flags = 1, version: [number, number, number, number] = [5, 1, 0, 1]): Buffer {
  const b = Buffer.alloc(256)
  b.write('HWP Document File', 0, 'latin1')
  b.writeUInt32LE(((version[0] << 24) | (version[1] << 16) | (version[2] << 8) | version[3]) >>> 0, 32)
  b.writeUInt32LE(flags >>> 0, 36)
  return b
}
export function defaultDocInfo(extra: Buffer[] = []): Buffer {
  const paraShape = (outline: number | null) => { const d = Buffer.alloc(54); if (outline !== null) d.writeUInt32LE(((1 << 23) | (outline << 25)) >>> 0, 0); return rec(TAG.PARA_SHAPE, 1, d) }
  return Buffer.concat([
    rec(TAG.DOC_PROPS, 0, Buffer.from('0100010001000100010001000100000000000000000000000000', 'hex')),
    rec(TAG.ID_MAPPINGS, 0, Buffer.alloc(72)),
    ...[0, 1, 2, 3].map(() => rec(TAG.CHAR_SHAPE, 1, Buffer.alloc(72))),
    paraShape(null), paraShape(null), paraShape(null), paraShape(0), paraShape(1),
    ...extra,
  ])
}
/** Hangul's default script (Scripts/DefaultJScript, before compression): header, source, pre and post script */
export function defaultScript(source = 'function OnDocument_New()\r\n{\r\n\t//todo : \r\n}\r\n\r\n', header = 'var Documents = XHwpDocuments;\r\nvar Document = Documents.Active_XHwpDocument;\r\n'): Buffer {
  const part = (s: string) => { const b = Buffer.from(s, 'utf16le'); const n = Buffer.alloc(4); n.writeUInt32LE(s.length, 0); return Buffer.concat([n, b]) }
  return Buffer.concat([part(header), part(source), part(''), part(''), Buffer.from('ffffffff', 'hex')])
}
/** DocOptions/_LinkDoc: a WCHAR path of 260 and two flags; Hangul leaves the path empty, with old bytes after it */
export const linkDoc = (path = '') => { const b = Buffer.alloc(524); Buffer.from(':\\Users\\x\\AppData\\Local\\Temp\\prv0000.gif', 'utf16le').copy(b, 0); Buffer.from(path + '\0', 'utf16le').copy(b, 0); if (!path) b.writeUInt16LE(0, 0); return b }

/** A .hwp: the sections' records (each a section stream), compressed when flags say so, in a compound file. */
export function hwpDoc(sections: Buffer[], o: DocOpts = {}): Uint8Array {
  const flags = o.flags ?? 1
  const z = (b: Buffer) => (flags & 1 ? zlib.deflateRawSync(b) : b)
  const files: Record<string, Uint8Array> = {
    FileHeader: fileHeader(flags, o.version),
    DocInfo: z(defaultDocInfo(o.docInfo)),
    '\u0005HwpSummaryInformation': Buffer.from('feff000006020000', 'hex'),
    ...Object.fromEntries(sections.map((s, i) => [`BodyText/Section${i}`, z(s)])),
    PrvText: Buffer.from('미리보기\0', 'utf16le'),
  }
  if (o.hangulStreams !== false) {
    files['Scripts/JScriptVersion'] = z(Buffer.from('0100000000000000', 'hex'))
    files['Scripts/DefaultJScript'] = z(defaultScript())
    files['DocOptions/_LinkDoc'] = linkDoc()
  }
  for (const [k, v] of Object.entries(o.extra ?? {})) files[k] = typeof v === 'string' ? Buffer.from(v, 'utf8') : v
  for (const [from, to] of Object.entries(o.rename ?? {})) { files[to] = files[from]!; delete files[from] }
  const c = CFB.utils.cfb_new()
  for (const [p, v] of Object.entries(files)) CFB.utils.cfb_add(c, p, Buffer.from(v))
  return new Uint8Array(CFB.write(c, { type: 'buffer' }) as Buffer)
}

// ---------------------------------------------------------------- reading a file back
/** the streams of a compound file (SheetJS, as hwp.ts reads it) */
export function hwpStreams(bytes: Uint8Array): Map<string, Buffer> {
  const c = CFB.read(Buffer.from(bytes), { type: 'buffer' })
  const out = new Map<string, Buffer>()
  c.FullPaths.forEach((p: string, i: number) => { const e = c.FileIndex[i]; if (e?.type === 2) out.set(p.replace(/^Root Entry\//, ''), Buffer.from(e.content ?? [])) })
  return out
}
export interface Rec { tag: number; level: number; data: Buffer; ext: boolean }
/** the records of a section (inflated when the document is compressed) */
export function sectionRecords(bytes: Uint8Array, n = 0): Rec[] {
  const s = hwpStreams(bytes)
  const flags = s.get('FileHeader')!.readUInt32LE(36)
  const raw = flags & 1 ? zlib.inflateRawSync(s.get(`BodyText/Section${n}`)!) : s.get(`BodyText/Section${n}`)!
  const out: Rec[] = []
  for (let i = 0; i < raw.length;) {
    const h = raw.readUInt32LE(i)
    let size = h >>> 20, d = i + 4
    const ext = size === 0xfff
    if (ext) { size = raw.readUInt32LE(i + 4); d = i + 8 }
    out.push({ tag: h & 0x3ff, level: (h >>> 10) & 0x3ff, data: raw.subarray(d, d + size), ext })
    i = d + size
  }
  return out
}
/** a PARA_TEXT's WCHARs as a string, controls as <code> */
export const textOf = (r: Rec) => { let s = ''; for (let k = 0; k < r.data.length; k += 2) { const c = r.data.readUInt16LE(k); if (c >= 32) s += String.fromCharCode(c); else { s += `<${c}>`; if (![0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31].includes(c)) k += 14 } } return s }
/** the PARA_HEADER fields */
export const headerOf = (r: Rec) => ({ chars: r.data.readUInt32LE(0) & 0x7fffffff, last: (r.data.readUInt32LE(0) & 0x80000000) !== 0, mask: r.data.readUInt32LE(4), paraShape: r.data.readUInt16LE(8), shapes: r.data.readUInt16LE(12), ranges: r.data.readUInt16LE(14), lines: r.data.readUInt16LE(16) })
export const shapesOf = (r: Rec) => { const out: [number, number][] = []; for (let k = 0; k < r.data.length; k += 8) out.push([r.data.readUInt32LE(k), r.data.readUInt32LE(k + 4)]); return out }
/** each paragraph of a section: its header record, its own records (text, shapes, lines) and their places */
export function paragraphs(bytes: Uint8Array, n = 0) {
  const recs = sectionRecords(bytes, n)
  const out: { at: number; level: number; header: ReturnType<typeof headerOf>; text: string | null; shapes: [number, number][]; lines: number; textExt: boolean }[] = []
  recs.forEach((r, i) => {
    if (r.tag !== TAG.PARA_HEADER) return
    const kids: Rec[] = []
    for (let j = i + 1; j < recs.length && recs[j]!.level > r.level; j++) if (recs[j]!.level === r.level + 1) kids.push(recs[j]!)
    const t = kids.find((k) => k.tag === TAG.PARA_TEXT), cs = kids.find((k) => k.tag === TAG.PARA_CHAR_SHAPE), ls = kids.find((k) => k.tag === TAG.PARA_LINE_SEG)
    out.push({ at: i, level: r.level, header: headerOf(r), text: t ? textOf(t) : null, shapes: cs ? shapesOf(cs) : [], lines: ls ? ls.data.length / 36 : 0, textExt: !!t?.ext })
  })
  return out
}

// ---------------------------------------------------------------- forms
/**
 * A made-up certificate of employment (재직증명서) of a made-up company, as a Hangul form looks in .hwp: the section
 * definition, a title, a table of label cells and empty cells (two merged across columns), placeholders in the body, a
 * paragraph with bold and normal text, a click-here field, a bookmark and a record no reader here knows.
 */
export function hwpEmploymentForm(o: DocOpts = {}): Uint8Array {
  const L = (text: string, width = 8000): CellSpec => ({ text, width, shaded: true })
  const E = (width: number, colSpan = 1): CellSpec => ({ text: '', width, colSpan })
  return hwpDoc([Buffer.concat([
    para([[0, sectionDef()]]),
    para([[CHAR.title, '재 직 증 명 서']], { paraShape: SHAPE.center }),
    table([
      [L('성명'), E(13260), L('생년월일'), E(13260)],
      [L('주소'), E(34520, 3)],
      [L('소속'), E(13260), L('직위'), E(13260)],
      [L('재직기간'), { text: '{{입사일}} ~ 현재', width: 34520, colSpan: 3 }],
      [L('용도'), E(34520, 3)],
    ]),
    para('위 사람은 당사에 재직하고 있음을 증명합니다.'),
    para([[0, '발급일: '], [CHAR.bold, '{{발급일}}']], { paraShape: SHAPE.center }),
    para([[CHAR.bold, '주식회사 가나다상사'], [0, '  대표이사 {{대표자}} (인)']], { paraShape: SHAPE.center }),
    para([[0, [fieldBegin(), fieldEnd(), ' (담당 부서 연락처)']]]),
    para([[CHAR.small, ['문서번호 제2026-0412호', bookmark()]]], { extra: [rec(120, 1, Buffer.from('미래 레코드', 'utf16le'))], last: true }),
  ])], o)
}

/**
 * A made-up purchase request (물품 구매 요청서): a table of items with a title row, two item rows and a total row (its
 * first cell merged across four columns), shaded by cell zones on the title and total rows.
 */
export function hwpPurchaseForm(o: DocOpts & { zones?: boolean } = {}): Uint8Array {
  const W = [12000, 9000, 5000, 7000, 9000]
  const H = (t: string, i: number): CellSpec => ({ text: [[CHAR.bold, t]], width: W[i]!, shaded: true, height: 1500 })
  const C = (t: string, i: number): CellSpec => ({ text: t, width: W[i]!, height: 1500 })
  return hwpDoc([Buffer.concat([
    para([[0, sectionDef()]]),
    para([[CHAR.title, '물품 구매 요청서']], { paraShape: SHAPE.center }),
    para('요청 부서: 경영지원팀    요청일: 2026년 11월 3일'),
    table([
      ['품명', '규격', '수량', '단가', '금액'].map(H),
      ['복사용지', 'A4 80g', '10', '25,000', '250,000'].map(C),
      ['토너', '검정', '2', '89,000', '178,000'].map(C),
      [{ text: '합계', width: W[0]! + W[1]! + W[2]! + W[3]!, colSpan: 4, shaded: true, height: 1500 }, C('428,000', 4)],
    ], { zones: o.zones === false ? [] : [[0, 0, 4, 0, 4], [0, 3, 4, 3, 3]] }),
    para('위와 같이 구매를 요청합니다.', { last: true }),
  ])], o)
}
