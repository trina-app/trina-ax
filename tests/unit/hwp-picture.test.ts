// edit_hwp's image change (a signature or seal put into a Hangul document), in the editors and the checks: the picture
// made clean, placed from the page layout at a label or a cell, written into a .hwpx (a zip part, a manifest item, an
// hp:pic) and a .hwp (a BinData stream, DocInfo's picture list, the gso control and its records), every other part
// kept byte for byte, and the server's and the fresh worker's read-back. With the pinned renderer in this checkout
// (native/bin/hwp), a made-up form is laid out, stamped and drawn before and after: only the pictures' boxes change.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { editHwp, hwpVerifyRequest, hwpEditModel } from '../../server/src/files/hwp-edit'
import { editHwpx, hwpxVerifyRequest } from '../../server/src/files/hwpx-edit'
import { cfbMismatch, readCfb, withStreams, writeCfb } from '../../server/src/files/cfb'
import {
  decodeHwpEditRequest, encodeHwpEditRequest, encodeVerifyPictures, hwpEditMismatch, hwpPartsMismatch, hwpxPartsMismatch, hwpxReadLines, type HwpChange,
} from '../../server/src/files/hwpx-check'
import { hwpText, hwpxText } from '../../server/src/files/hwp'
import { parsePagination, parseRenderTree, placePicture, sanitizeImage, type CleanImage, type HwpLayout, type LPage } from '../../server/src/files/hwp-picture'
import { pictureInput } from '../../server/src/files/hwp-changes'
import { NativeHwpEngine, localHwpAssets } from '../../server/src/files/hwp-engine'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { employmentForm, hwpxDoc, para as hwpxPara } from '../lib/hwpx'
import { defaultScript, hwpDoc, hwpEmploymentForm, hwpStreams, para, sectionDef, sectionRecords, table } from '../lib/hwp'
import { emptyScript } from '../../server/src/files/hwpx-write'

const FIX = path.join(import.meta.dir, '../fixtures/hwp')
const SEAL = new Uint8Array(fs.readFileSync(path.join(FIX, 'seal.png')))
const clean = (b: Uint8Array = SEAL) => sanitizeImage(b, 'seal.png')

/** a one-page layout: lines (text, box), cells (table, row, col, box), the body paragraphs that start on it */
function page(lines: { text: string; x?: number; y: number; cell?: number }[], cells: { table: number; row: number; col: number; x: number; y: number; w: number; h: number }[] = [], starts: { para: number; table?: boolean; preview?: string }[] = [{ para: 0 }]): LPage {
  return {
    w: 793.7, h: 1122.5, section: 0, continued: [], tables: [{ x: 117, y: 198, w: 300, h: 60 }], cells,
    starts: starts.map((s) => ({ para: s.para, table: !!s.table, preview: s.preview ?? '' })),
    lines: lines.map((l, k) => ({ x: l.x ?? 113.4, y: l.y, w: 566.9, h: 13.3, text: l.text, runs: [{ x: l.x ?? 113.4, w: l.text.length * 13.3, text: l.text }], para: `${l.cell ?? 0}:${k}`, cell: l.cell ?? -1 })),
  }
}
/** the made-up employment forms (tests/lib): the seal mark line and the name cell next to its label */
const EMPLOYMENT: HwpLayout = { pages: [page([
  { text: '성명', x: 124, y: 200, cell: 0 },
  { text: '', x: 290, y: 200, cell: 1 },
  { text: '주식회사 가나다상사  대표이사 {{대표자}} (인)', y: 400 },
], [
  { table: 1, row: 0, col: 0, x: 117, y: 198, w: 100, h: 17 },
  { table: 1, row: 0, col: 1, x: 217, y: 198, w: 200, h: 17 },
])] }
const pictures = (changes: HwpChange[], img = clean()) => ({ layout: EMPLOYMENT, images: new Map<number, CleanImage>(changes.flatMap((c, i) => ('image' in c ? [[i, img] as [number, CleanImage]] : []))) })
const SEAL_OVER: HwpChange = { image: 'users/alice/seal.png', at: '(인)' }
const SEAL_CELL: HwpChange = { image: 'users/alice/seal.png', cell: { next_to: '성명' }, width_mm: 20 }

describe('the picture made clean', () => {
  test('a PNG keeps only the chunks that draw it; text chunks and bytes after IEND go', () => {
    const iend = Buffer.from(SEAL).indexOf(Buffer.from('IEND')) - 4
    const text = Buffer.from('0000000d74455874436f6d6d656e740068656c6c6f', 'hex') // tEXt "Comment\0hello", CRC below
    const chunk = Buffer.concat([text, Buffer.alloc(4)])
    chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + 13)), 8 + 13)
    const dirty = Buffer.concat([Buffer.from(SEAL).subarray(0, iend), chunk, Buffer.from(SEAL).subarray(iend), Buffer.from('trailing secret')])
    const c = sanitizeImage(dirty, 'x.png')
    expect(c).toMatchObject({ kind: 'png', width: 120, height: 120 })
    expect(Buffer.from(c.bytes).equals(Buffer.from(SEAL))).toBe(true)
  })

  test('a JPEG loses EXIF (APP1) and comments and what follows its end', () => {
    const seg = (m: number, body: Buffer) => { const h = Buffer.from([0xff, m, 0, 0]); h.writeUInt16BE(body.length + 2, 2); return Buffer.concat([h, body]) }
    const sof = seg(0xc0, Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0]))
    const sos = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34])])
    const jpeg = (extra: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from('JFIF\0')), ...extra, sof, sos, Buffer.from([0xff, 0xd9])])
    const dirty = Buffer.concat([jpeg([seg(0xe1, Buffer.from('Exif\0\0GPS 37.5N')), seg(0xfe, Buffer.from('a comment'))]), Buffer.from('zip after')])
    const c = sanitizeImage(dirty, 'x.jpg')
    expect(c).toMatchObject({ kind: 'jpg', width: 3, height: 2 })
    expect(Buffer.from(c.bytes).equals(jpeg([]))).toBe(true)
  })

  test('not a picture, a damaged one or a huge one is refused', () => {
    expect(() => sanitizeImage(new TextEncoder().encode('<svg/>'), 'x.svg')).toThrow(/not a PNG or JPG/)
    const broken = Buffer.from(SEAL); broken[40] ^= 0xff
    expect(() => sanitizeImage(broken, 'x.png')).toThrow(/damaged/)
    const big = Buffer.from(SEAL); big.writeUInt32BE(9000, 16)
    expect(() => sanitizeImage(big, 'x.png')).toThrow(/9000 x 120 pixels/)
  })
})

describe('the page layout', () => {
  test('the render tree: body lines with their runs, cells of each table; headers and footers left out', () => {
    const tree = { type: 'Page', bbox: { x: 0, y: 0, w: 793.7, h: 1122.5 }, children: [
      { type: 'Header', bbox: { x: 0, y: 0, w: 1, h: 1 }, children: [{ type: 'TextLine', bbox: { x: 0, y: 0, w: 1, h: 1 }, children: [{ type: 'TextRun', bbox: { x: 0, y: 0, w: 1, h: 1 }, text: '(인)' }] }] },
      { type: 'Body', bbox: { x: 113, y: 132, w: 567, h: 877 }, children: [{ type: 'Column', bbox: { x: 113, y: 132, w: 567, h: 877 }, children: [
        { type: 'TextLine', bbox: { x: 113.4, y: 388.3, w: 566.9, h: 13.3 }, pi: 11, children: [{ type: 'TextRun', bbox: { x: 113.4, y: 388.3, w: 155.5, h: 13.3 }, text: '신청인: 김가나 (인)' }] },
        { type: 'Table', bbox: { x: 117, y: 409, w: 559, h: 51 }, pi: 12, children: [
          { type: 'Cell', bbox: { x: 117, y: 409, w: 168, h: 17 }, row: 0, col: 0, children: [{ type: 'TextLine', bbox: { x: 124, y: 411, w: 154, h: 13 }, pi: 0, children: [{ type: 'TextRun', bbox: { x: 124, y: 411, w: 26, h: 13 }, text: '서명' }] }] },
          { type: 'Cell', bbox: { x: 285, y: 409, w: 392, h: 17 }, row: 0, col: 1, children: [{ type: 'TextLine', bbox: { x: 292, y: 411, w: 378, h: 13 }, pi: 0, children: [] }] },
        ] },
      ] }] },
    ] }
    const p = parseRenderTree(tree)
    expect(p.lines.map((l) => [l.text, l.cell])).toEqual([['신청인: 김가나 (인)', -1], ['서명', 0], ['', 1]])
    expect(p.cells.map((c) => [c.table, c.row, c.col])).toEqual([[1, 0, 0], [1, 0, 1]])
    for (const bad of [{ ...tree, type: 'Other' }, { ...tree, bbox: { x: 0, y: 0, w: Infinity, h: 1 } }, { ...tree, children: [{ type: 'Body', bbox: { x: 0, y: 0, w: 1, h: 1 }, children: 'x' }] }]) expect(() => parseRenderTree(bad)).toThrow(/page layout/)
    const pag = parsePagination({ pages: [{ section: 0, columns: [{ items: [{ kind: 'fullParagraph', paraIndex: 3, textPreview: 'abc' }, { kind: 'partialTable', paraIndex: 4, isContinuation: true }] }] }] }, 1)
    expect(pag).toEqual([{ section: 0, starts: [{ para: 3, table: false, preview: 'abc' }], continued: [4] }])
  })

  test('placement: a seal centred over the label, a picture after it, one fitted in a cell; always on the paper', () => {
    const pg = page([])
    const over = placePicture(pg, 0, { x: 200, y: 400, w: 20, h: 13 }, 'over', {}, 1)
    expect(over.box.w).toBe(Math.round(15 * 7200 / 25.4))
    expect(Math.abs(over.box.x + over.box.w / 2 - 210 * 75)).toBeLessThan(2)
    const after = placePicture(pg, 0, { x: 200, y: 400, w: 20, h: 13 }, 'after', { width_mm: 30 }, 0.5)
    expect(after.box.x).toBeGreaterThan(220 * 75)
    expect(after.box.h).toBe(Math.round(after.box.w * 0.5))
    const edge = placePicture(pg, 0, { x: 790, y: 1120, w: 3, h: 2 }, 'over', { width_mm: 40 }, 1)
    expect(edge.box.x + edge.box.w).toBeLessThanOrEqual(Math.round(793.7 * 75) + 1)
    expect(edge.box.y + edge.box.h).toBeLessThanOrEqual(Math.round(1122.5 * 75) + 1)
  })
})

describe('.hwpx', () => {
  test('a seal over "(인)" and one in the cell next to 성명: a new part each, their manifest items, two hp:pic; the rest byte for byte', () => {
    const before = employmentForm({ cache: true })
    const changes = [SEAL_OVER, SEAL_CELL]
    const r = editHwpx(before, changes, pictures(changes))
    expect(r.report.pictures!.map((p) => [p.change, p.part, p.page])).toEqual([[0, 'BinData/image2.png', 1], [1, 'BinData/image2.png', 1]])
    expect(r.report.pictures![1]!.widthMm).toBe(20)
    expect(r.report.lineEdits).toEqual([])
    const parts = new Map(readZip(r.file).map((e) => [e.name, e.data]))
    const old = new Map(readZip(before).map((e) => [e.name, e.data]))
    for (const [n, d] of old) if (!/section0\.xml|content\.hpf/.test(n)) expect(Buffer.from(parts.get(n)!).equals(Buffer.from(d))).toBe(true)
    expect(Buffer.from(parts.get('BinData/image2.png')!).equals(Buffer.from(SEAL))).toBe(true)
    const hpf = new TextDecoder().decode(parts.get('Contents/content.hpf'))
    expect(hpf).toContain('<opf:item id="image2" href="BinData/image2.png" media-type="image/png" isEmbeded="1"/></opf:manifest>')
    const sec = new TextDecoder().decode(parts.get('Contents/section0.xml'))
    expect(sec.match(/binaryItemIDRef="image2"/g)).toHaveLength(2) // one part, shown twice
    expect(sec).toContain('textWrap="BEHIND_TEXT"')
    expect(sec).toContain('vertRelTo="PAPER" horzRelTo="PAPER"')
    // the text reads as before; the server's checks pass and the fresh worker's comparison too
    expect(hwpxReadLines(hwpxText(r.file))).toEqual(hwpxReadLines(hwpxText(before)))
    expect(hwpxPartsMismatch(before, r.file, ['BinData/image2.png'])).toBeNull()
    expect(hwpxPartsMismatch(before, r.file)).toMatch(/same parts/)
    expect(hwpEditMismatch(changes, hwpxReadLines(hwpxText(before)), hwpxReadLines(hwpxText(r.file)), r.report)).toBeNull()
    expect(new TextDecoder().decode(hwpxVerifyRequest(encodeVerifyPictures(before, r.file)))).toBe('ok')
  })

  test('the fresh worker refuses a file whose manifest or parts changed more than the pictures', () => {
    const before = employmentForm({ cache: true })
    const r = editHwpx(before, [SEAL_OVER], pictures([SEAL_OVER]))
    const entries = readZip(r.file)
    const tamper = (name: string, f: (s: string) => string) => writeZip(entries.map((e) => (e.name === name ? { name: e.name, data: new TextEncoder().encode(f(new TextDecoder().decode(e.data))) } : e)))
    expect(() => hwpxVerifyRequest(encodeVerifyPictures(before, tamper('Contents/content.hpf', (s) => s.replace('</opf:manifest>', '<opf:item id="x" href="settings.xml" media-type="application/xml"/></opf:manifest>'))))).toThrow(/content\.hpf changed more/)
    expect(() => hwpxVerifyRequest(encodeVerifyPictures(before, writeZip(entries.map((e) => (e.name === 'BinData/image2.png' ? { name: e.name, data: Buffer.concat([Buffer.from(e.data), Buffer.from('more')]) } : e)))))).toThrow(/not a clean png/)
  })
})

describe('.hwp', () => {
  test('a seal over "(인)" and one in the cell next to 성명: two BinData streams, DocInfo\'s list and count, the gso records; the rest byte for byte', () => {
    const before = hwpEmploymentForm()
    const changes = [SEAL_OVER, SEAL_CELL]
    const r = editHwp(before, changes, pictures(changes))
    expect(r.report.pictures!.map((p) => [p.change, p.part])).toEqual([[0, 'BinData/BIN0001.png'], [1, 'BinData/BIN0001.png']])
    const a = hwpStreams(before), b = hwpStreams(r.file)
    const x = (d: Buffer) => zlib.inflateRawSync(d)
    for (const [n, d] of a) if (!/^(DocInfo|BodyText\/Section0)$/.test(n)) expect(b.get(n)!.equals(d)).toBe(true)
    expect([...b.keys()].filter((k) => !a.has(k)).sort()).toEqual(['BinData/BIN0001.png'])
    expect(x(b.get('BinData/BIN0001.png')!).equals(Buffer.from(SEAL))).toBe(true)
    expect(hwpText(r.file)).toBe(hwpText(before))
    // the label paragraph ends with the control, its layout cache kept; ID_MAPPINGS counts two pictures
    const m = hwpEditModel(r.file)
    expect(m.paras.find((p) => p.text.includes("(인)"))!.header[5]! & (1 << 3)).toBe(1 << 3) // control mask bit 11 (byte 5 bit 3)
    const recs = (d: Buffer) => { const out: { tag: number; data: Buffer }[] = []; for (let i = 0; i < d.length;) { const h = d.readUInt32LE(i); let n = h >>> 20, o = i + 4; if (n === 0xfff) { n = d.readUInt32LE(i + 4); o += 4 } out.push({ tag: h & 0x3ff, data: d.subarray(o, o + n) }); i = o + n } return out }
    const was = recs(x(a.get('DocInfo')!)), now = recs(x(b.get('DocInfo')!))
    expect(now.find((x) => x.tag === 17)!.data.readUInt32LE(0)).toBe(1)
    expect(now.filter((x) => x.tag === 18).map((x) => [x.data.readUInt16LE(2), x.data.subarray(6).toString('utf16le')])).toEqual([[1, 'png']])
    expect(now.length).toBe(was.length + 1)
    // right after ID_MAPPINGS, before the face names and shapes its counts list next
    expect(now.map((r) => r.tag).slice(0, 4)).toEqual([...was.map((r) => r.tag).slice(0, 2), 18, was[2]!.tag])
    expect(hwpPartsMismatch(before, r.file, ['BinData/BIN0001.png'])).toBeNull()
    expect(hwpPartsMismatch(before, r.file)).toMatch(/directory|DocInfo/)
    expect(new TextDecoder().decode(hwpVerifyRequest(encodeVerifyPictures(before, r.file)))).toBe('ok')
  })

  test('the fresh worker refuses a DocInfo that changed more than its picture list', () => {
    const before = hwpEmploymentForm()
    const r = editHwp(before, [SEAL_OVER], pictures([SEAL_OVER]))
    const c = readCfb(r.file)
    const raw = zlib.inflateRawSync(c.streams.get('DocInfo')!.data)
    const changed = Buffer.from(raw); changed[changed.length - 1] ^= 1
    const bad = writeCfb(c, new Map([['DocInfo', new Uint8Array(zlib.deflateRawSync(changed))]]))
    expect(() => hwpVerifyRequest(encodeVerifyPictures(before, bad))).toThrow(/DocInfo changed more/)
  })

  test('refused: a label the layout does not show as often as the document, at and cell together, a label in a header only', () => {
    const before = hwpEmploymentForm()
    const twice: HwpLayout = { pages: [{ ...EMPLOYMENT.pages[0]!, lines: [...EMPLOYMENT.pages[0]!.lines, { ...EMPLOYMENT.pages[0]!.lines[2]!, para: 'x' }] }] }
    expect(() => editHwp(before, [SEAL_OVER], { layout: twice, images: new Map([[0, clean()]]) })).toThrow(/1 in the document's text but 2 on its pages/)
    const both = { ...SEAL_OVER, cell: { next_to: '성명' } } as HwpChange
    expect(() => editHwp(before, [both], pictures([both]))).toThrow(/give at .* or cell/)
    expect(() => editHwp(before, [{ image: 'x.png', at: '없는 글자' }], pictures([{ image: 'x.png', at: '없는 글자' }]))).toThrow(/is not in the document/)
  })
})

/** real code a comment-stripping check took for an empty script (review of #450) */
const ATTACKS = ['/* // */ globalThis.PWN=1; /*\n*/', '// x globalThis.PWN=2;']

describe('placing and checking, more cases', () => {
  const two = { ...EMPLOYMENT, pages: [{ ...EMPLOYMENT.pages[0]!, lines: [{ ...EMPLOYMENT.pages[0]!.lines[2]!, text: '갑 김가나 (인) 을 이다라 (인)', runs: [{ x: 200, w: 300, text: '갑 김가나 (인) 을 이다라 (인)' }] }] }] }
  const twoSeals: HwpChange[] = [{ image: 's.png', at: '(인)', occurrence: 1 }, { image: 's.png', at: '(인)', occurrence: 2 }]

  test('two seals in one paragraph: both controls and records go in', () => {
    const doc = hwpDoc([Buffer.concat([para([[0, sectionDef()]]), para('갑 김가나 (인) 을 이다라 (인)', { last: true })])])
    const r = editHwp(doc, twoSeals, { layout: two, images: new Map([[0, clean()], [1, clean()]]) })
    expect(new Set(r.report.pictures!.map((p) => p.part)).size).toBe(2)
    expect(sectionRecords(r.file).filter((x) => x.tag === 85)).toHaveLength(2)
    expect(hwpText(r.file)).toBe(hwpText(doc))
  })

  test('a document that already has a picture: the id goes on, its storage is reused, the count follows', () => {
    const before = hwpEmploymentForm({ pictures: [SEAL] })
    const r = editHwp(before, [SEAL_OVER], pictures([SEAL_OVER]))
    expect(r.report.pictures![0]!.part).toBe('BinData/BIN0002.png')
    const c = readCfb(r.file)
    expect(c.entries.filter((e) => e.type === 1 && e.path === 'BinData')).toHaveLength(1)
    const di = zlib.inflateRawSync(c.streams.get('DocInfo')!.data)
    let count = -1
    for (let i = 0; i < di.length;) { const h = di.readUInt32LE(i); const n = h >>> 20; if ((h & 0x3ff) === 17) count = di.readUInt32LE(i + 4); i += 4 + n }
    expect(count).toBe(2)
    expect(sectionRecords(r.file).find((x) => x.tag === 85)!.data.readUInt16LE(71)).toBe(2)
    expect(new TextDecoder().decode(hwpVerifyRequest(encodeVerifyPictures(before, r.file)))).toBe('ok')
  })

  test('the fresh worker refuses a new picture that shows an old entry (.hwp) or part (.hwpx)', () => {
    const before = hwpEmploymentForm({ pictures: [SEAL] })
    const r = editHwp(before, [SEAL_OVER], pictures([SEAL_OVER]))
    const c = readCfb(r.file)
    const raw = Buffer.from(zlib.inflateRawSync(c.streams.get('BodyText/Section0')!.data))
    for (let i = 0; i < raw.length;) { const h = raw.readUInt32LE(i); const n = h >>> 20; if ((h & 0x3ff) === 85) raw.writeUInt16LE(1, i + 4 + 71); i += 4 + n }
    const bad = writeCfb(c, new Map([['BodyText/Section0', new Uint8Array(zlib.deflateRawSync(raw))]]))
    expect(() => hwpVerifyRequest(encodeVerifyPictures(before, bad))).toThrow(/does not show a new picture entry/)
    const x0 = employmentForm({ cache: true })
    const x = editHwpx(x0, [SEAL_OVER], pictures([SEAL_OVER]))
    const entries = readZip(x.file)
    const tampered = writeZip(entries.map((e) => (e.name === 'Contents/section0.xml' ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('binaryItemIDRef="image2"', 'binaryItemIDRef="image1"')) } : e)))
    expect(() => hwpxVerifyRequest(encodeVerifyPictures(x0, tampered))).toThrow(/does not show a new picture part/)
  })

  test('no layout stored by Hangul: the picture is placed from its paragraph; with one, from the paper', () => {
    const bare = hwpDoc([Buffer.concat([para([[0, sectionDef()]], { lines: 0 }), para('대표이사 김가나 (인)', { lines: 0, last: true })])])
    const layout: HwpLayout = { pages: [page([{ text: '대표이사 김가나 (인)', y: 400 }], [], [{ para: 0 }, { para: 1 }])] }
    layout.pages[0]!.lines[0]!.para = '1:1'
    const none = editHwp(bare, [SEAL_OVER], { layout, images: new Map([[0, clean()]]) })
    expect(none.report.pictures![0]!.fromParagraph).toBe(true)
    const gso = sectionRecords(none.file).find((x) => x.tag === 71 && x.data.toString('latin1', 0, 4) === ' osg')!
    expect((gso.data.readUInt32LE(4) >>> 3) & 3).toBe(2) // vertical from the paragraph
    expect(gso.data.readInt32LE(8)).toBeLessThan(0) // a seal taller than its line starts above it
    const paper = editHwp(hwpEmploymentForm(), [SEAL_OVER], pictures([SEAL_OVER]))
    expect(paper.report.pictures![0]!.fromParagraph).toBeUndefined()
  })

  const gsos = (b: Uint8Array) => sectionRecords(b).filter((x) => x.tag === 71 && x.data.toString('latin1', 0, 4) === ' osg')
  test('a place in a table of a stored-layout document: anchored in a plain body paragraph, in front of the table', () => {
    const r = editHwp(hwpEmploymentForm(), [SEAL_CELL], { layout: { pages: [{ ...EMPLOYMENT.pages[0]!, starts: [{ para: 1, table: false, preview: '재직' }, { para: 2, table: true, preview: '' }] }] }, images: new Map([[0, clean()]]) })
    const g = gsos(r.file)[0]!
    expect(g.level).toBe(1) // a body paragraph's control, not a cell's
    expect((g.data.readUInt32LE(4) >>> 21) & 7).toBe(3) // in front: a filled cell would hide what is behind the text
    expect((g.data.readUInt32LE(4) >>> 3) & 3).toBe(0) // from the paper
  })

  test('a page that is one table: the picture is in the cell, never in the paragraph holding the table', () => {
    const doc = hwpDoc([Buffer.concat([para([[0, sectionDef()]]), table([[{ text: '서명', width: 8000 }, { text: '', width: 8000 }]]), para('끝', { last: true })])])
    const cells = [{ table: 1, row: 0, col: 0, x: 117, y: 198, w: 100, h: 17 }, { table: 1, row: 0, col: 1, x: 217, y: 198, w: 200, h: 17 }]
    const layout: HwpLayout = { pages: [page([{ text: '서명', x: 124, y: 200, cell: 0 }, { text: '', x: 290, y: 200, cell: 1 }], cells, [{ para: 1, table: true }])] }
    const c: HwpChange = { image: 's.png', cell: { next_to: '서명' } }
    const r = editHwp(doc, [c], { layout, images: new Map([[0, clean()]]) })
    expect(gsos(r.file)[0]!.level).toBeGreaterThan(1)
    expect(r.report.pictures![0]!.fromParagraph).toBeUndefined()
  })

  test('Hangul\'s empty script template passes, with a handler per check box; a statement in a handler does not', () => {
    const empty = 'function OnDocument_New()\r\n{\r\n\t//todo : \r\n}\r\nfunction OnCheckBox1_Click()\r\n{\r\n\t//todo : \r\n}\r\n'
    const head = 'var Documents = XHwpDocuments;var Document = Documents.Active_XHwpDocument;'
    expect(emptyScript(head, empty)).toBe(true)
    expect(emptyScript(head, 'function OnDocument_New(){ Run("x") }')).toBe(false)
    expect(emptyScript(head + 'Run();', empty)).toBe(false)
    expect(emptyScript(head, 'function a(){}b()')).toBe(false)
    for (const code of ATTACKS) {
      expect(emptyScript(head, code)).toBe(false)
      expect(emptyScript(code, empty)).toBe(false)
      const inHwp = hwpEmploymentForm({ extra: { 'Scripts/DefaultJScript': zlib.deflateRawSync(defaultScript(code)) } })
      expect(() => editHwp(inHwp, [{ find: '{{대표자}}', replace: '김예시' }])).toThrow(/scripts/)
      const part = (t: string) => new Uint8Array(Buffer.from(t, 'utf16le'))
      const inHwpx = hwpxDoc([hwpxPara('본문')], { extra: { 'Scripts/headerScripts': part(head), 'Scripts/sourceScripts': part(code) } })
      expect(() => editHwpx(inHwpx, [{ find: '본문', replace: '바뀐 글' }])).toThrow(/scripts/)
    }
  })
})

describe('the container and the request', () => {
  test('a stream added to a compound file hangs from one empty pointer; the read-back allows exactly it', () => {
    const before = hwpEmploymentForm()
    const c = readCfb(before)
    const out = writeCfb(withStreams(c, new Map([['BinData/BIN0001.png', SEAL]])))
    const again = readCfb(out)
    expect(Buffer.from(again.streams.get('BinData/BIN0001.png')!.data).equals(Buffer.from(SEAL))).toBe(true)
    expect(cfbMismatch(c, again, () => false, (p) => p === 'BinData' || p === 'BinData/BIN0001.png')).toBeNull()
    expect(cfbMismatch(c, again, () => false)).toMatch(/does not add/)
    expect(() => withStreams(c, new Map([['FileHeader', SEAL]]))).toThrow(/cannot add/)
  })

  test('the worker request carries the layout and each image change\'s picture; the worker reads them again', () => {
    const changes: HwpChange[] = [{ find: 'a', replace: 'b' }, SEAL_OVER]
    const req = decodeHwpEditRequest(encodeHwpEditRequest(changes, new Uint8Array([1, 2, 3]), { layout: EMPLOYMENT, images: [{ changes: [1], bytes: SEAL }] }))
    expect([...req.doc]).toEqual([1, 2, 3])
    expect(req.images.get(1)!.length).toBe(SEAL.length)
    const pi = pictureInput(req, '.hwp')!
    expect(pi.images.get(1)!.kind).toBe('png')
    expect(() => pictureInput({ ...req, images: new Map() }, '.hwp')).toThrow(/damaged request/)
    expect(() => pictureInput({ ...req, layout: { pages: [{ w: 'x' }] } }, '.hwp')).toThrow(/damaged request/)
    expect(decodeHwpEditRequest(encodeHwpEditRequest([{ find: 'a', replace: 'b' }], new Uint8Array([9]))).images.size).toBe(0)
  })
})

// ---------------------------------------------------------------- with the pinned renderer: before and after
const RHWP = fs.existsSync(localHwpAssets().bin)
if (!RHWP) test('HWP Preview renderer not in this checkout: placement rendering skipped', () => { console.log(`skipped: no ${localHwpAssets().bin}`) })
else describe('laid out, stamped and drawn by the pinned renderer', () => {
  const engine = new NativeHwpEngine()
  /** the rows of pixels that differ (any channel by more than 40) */
  const diffRows = (a: Buffer, b: Buffer) => {
    const pa = decodePng(a), pb = decodePng(b)
    const rows: number[] = []
    for (let y = 0; y < pa.h; y++) for (let x = 0; x < pa.w; x++) { const o = (y * pa.w + x) * 4; if ([0, 1, 2].some((k) => Math.abs(pa.d[o + k]! - pb.d[o + k]!) > 40)) { rows.push(y); break } }
    return rows
  }
  for (const ext of ['hwp', 'hwpx'] as const) test(`.${ext}: the seal lands on "(인)" and the signature in the 서명 cell, nothing else moves`, async () => {
    const before = fs.readFileSync(path.join(FIX, `sign-form.${ext}`))
    const layout = await engine.layout(before, ext)
    const changes: HwpChange[] = [{ image: 'seal.png', at: '(인)' }, { image: 'seal.png', cell: { next_to: '서명' } }]
    const images = new Map([[0, clean()], [1, clean()]])
    const r = ext === 'hwp' ? editHwp(new Uint8Array(before), changes, { layout, images }) : editHwpx(new Uint8Array(before), changes, { layout, images })
    const [seal, sign] = r.report.pictures!
    // "(인)" is drawn at about x 248-268, y 388-401 px; the empty 서명 cell at x 285-677, y 427-444 px (96 dpi)
    const px = (mm: number) => (mm * 96) / 25.4
    expect(Math.abs(px(seal!.xMm + seal!.widthMm / 2) - 258)).toBeLessThan(8)
    expect(Math.abs(px(seal!.yMm + seal!.heightMm / 2) - 395)).toBeLessThan(4)
    expect(Math.abs(px(sign!.xMm + sign!.widthMm / 2) - 481)).toBeLessThan(4)
    expect(Math.abs(px(sign!.yMm + sign!.heightMm / 2) - 435)).toBeLessThan(4)
    const a = await engine.render(before, ext, 1), b = await engine.render(Buffer.from(r.file), ext, 1)
    expect([a.meta.width, a.meta.height]).toEqual([b.meta.width, b.meta.height])
    // a document without Hangul's layout everywhere is tied to its paragraphs: right in Hangul, while this renderer draws
    // the line after such a paragraph too high, so only a fully cached one is compared pixel by pixel
    if (seal!.fromParagraph) return
    const rows = diffRows(a.bytes, b.bytes)
    const top = Math.floor(px(Math.min(seal!.yMm, sign!.yMm))) - 1, bottom = Math.ceil(px(Math.max(seal!.yMm + seal!.heightMm, sign!.yMm + sign!.heightMm))) + 1
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((y) => y < top || y > bottom)).toEqual([])
    // the new file is laid out again with the same text where it was
    const again = await engine.layout(Buffer.from(r.file), ext)
    expect(again.pages[0]!.lines.map((l) => [l.text, l.y])).toEqual(layout.pages[0]!.lines.map((l) => [l.text, l.y]))
  }, 60_000)
})

/** RGBA pixels of a PNG the renderer drew (8-bit, colour type 2 or 6, no interlace) */
function decodePng(b: Buffer): { w: number; h: number; d: Uint8Array } {
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), type = b[25]!
  const ch = type === 6 ? 4 : 3
  const idat: Buffer[] = []
  for (let p = 8; p < b.length;) { const n = b.readUInt32BE(p); const t = b.toString('ascii', p + 4, p + 8); if (t === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + n)); p += 12 + n }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const out = new Uint8Array(w * h * 4), stride = w * ch
  let prev = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!, line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= ch ? cur[x - ch]! : 0, up = prev[x]!, ul = x >= ch ? prev[x - ch]! : 0
      const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul)
      const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : pa <= pb && pa <= pc ? left : pb <= pc ? up : ul
      cur[x] = (line[x]! + pred) & 0xff
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) out[(y * w + x) * 4 + k] = k < ch ? cur[x * ch + k]! : 255
    prev = cur
  }
  return { w, h, d: out }
}
