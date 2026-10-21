// Hangul documents (server/src/files/hwp.ts): .hwp 5.x records and .hwpx sections become text for read/grep. The
// fixtures are built here (SheetJS CFB writes both containers), so no third-party documents live in the repo.
import { describe, expect, test } from 'bun:test'
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import { extractText } from '../../server/src/files/extract'
import { hwpText, hwpxText, sectionText } from '../../server/src/files/hwp'

const CFB = XLSX.CFB
const tools = { pandoc: null, pdftotext: null }

function container(files: Record<string, Uint8Array | string>, fileType?: 'zip'): Uint8Array {
  const c = CFB.utils.cfb_new()
  for (const [p, v] of Object.entries(files)) CFB.utils.cfb_add(c, p, typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v))
  return new Uint8Array(CFB.write(c, { type: 'buffer', ...(fileType ? { fileType } : {}) }) as Buffer)
}

// ---- .hwp records ----
const u16 = (s: string) => Buffer.from(s, 'utf16le')
function record(tag: number, body: Uint8Array): Buffer {
  const big = body.length >= 0xfff
  const h = Buffer.alloc(big ? 8 : 4)
  h.writeUInt32LE(((tag & 0x3ff) | ((big ? 0xfff : body.length) << 20)) >>> 0, 0)
  if (big) h.writeUInt32LE(body.length, 4)
  return Buffer.concat([h, body])
}
/** An 8-WCHAR extended control (e.g. a table, code 11) as it sits in PARA_TEXT. */
const extended = (code: number) => { const b = Buffer.alloc(16); b.writeUInt16LE(code, 0); b.writeUInt16LE(code, 14); return b }
const para = (...parts: Buffer[]) => Buffer.concat([record(66, Buffer.alloc(22)), record(67, Buffer.concat(parts))])
function fileHeader(flags: number) {
  const b = Buffer.alloc(256)
  b.write('HWP Document File', 0, 'latin1')
  b.writeUInt32LE(0x05010100, 32)
  b.writeUInt32LE(flags, 36)
  return b
}
const hwp = (section: Buffer, flags = 1, extra: Record<string, Uint8Array> = {}) =>
  container({ FileHeader: fileHeader(flags), 'BodyText/Section0': flags & 1 ? zlib.deflateRawSync(section) : section, ...extra })

describe('.hwp (HWP 5.x)', () => {
  test('paragraph text, tab and line break; control characters dropped', () => {
    const tab = Buffer.alloc(16); tab.writeUInt16LE(9, 0)
    const s = Buffer.concat([
      para(u16('진료 안내'), Buffer.from([13, 0])),
      para(u16('예약'), tab, u16('오전 9시'), Buffer.from([10, 0]), u16('둘째 줄'), Buffer.from([13, 0])),
      para(extended(11), u16('표 앞 글'), Buffer.from([13, 0])),
    ])
    expect(hwpText(hwp(s))).toBe('진료 안내\n예약\t오전 9시\n둘째 줄\n표 앞 글')
  })
  test('uncompressed body and a long record (size 0xFFF + length word)', () => {
    const long = '가'.repeat(3000)
    expect(hwpText(hwp(para(u16(long)), 0))).toBe(long)
    expect(sectionText(record(67, u16('x')))).toBe('x')
  })
  test('distribution / password files: only the preview text, with a note', () => {
    const t = hwpText(hwp(para(u16('secret')), 1 | 4, { PrvText: u16('미리보기 첫 쪽') }))
    expect(t).toContain('preview text')
    expect(t).toContain('미리보기 첫 쪽')
    expect(t).not.toContain('secret')
  })
  test('not HWP 5: a clear error', () => {
    expect(() => hwpText(container({ Other: 'x' }))).toThrow(/not an HWP 5 file/)
    expect(() => hwpText(new Uint8Array([1, 2, 3]))).toThrow(/could not read/)
  })
  test('a decompression bomb is refused', () => {
    const bomb = container({ FileHeader: fileHeader(1), 'BodyText/Section0': zlib.deflateRawSync(Buffer.alloc(80 * 1024 * 1024)) })
    expect(() => hwpText(bomb)).toThrow(/damaged or too large/)
  })
})

describe('.hwpx (OWPML)', () => {
  const sec = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="s" xmlns:hp="p">${body}</hs:sec>`
  test('sections in order, runs joined, tab / line break / entities', () => {
    const z = container({
      'Contents/section1.xml': sec('<hp:p><hp:run><hp:t>둘째 구역</hp:t></hp:run></hp:p>'),
      'Contents/section0.xml': sec('<hp:p><hp:run><hp:t>환자 &amp; 보호자</hp:t></hp:run><hp:run><hp:t>안내<hp:tab/>1층<hp:lineBreak/>2층</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t/></hp:run></hp:p>'),
      'mimetype': 'application/hwp+zip',
    }, 'zip')
    expect(hwpxText(z)).toBe('환자 & 보호자안내\t1층\n2층\n\n둘째 구역')
  })
  test('a caption paragraph inside a paragraph keeps its own line', () => {
    const z = container({ 'Contents/section0.xml': sec('<hp:p><hp:run><hp:pic><hp:caption><hp:subList><hp:p><hp:run><hp:t>그림 1. 대기실</hp:t></hp:run></hp:p></hp:subList></hp:caption></hp:pic><hp:t>본문 글</hp:t></hp:run></hp:p>') }, 'zip')
    expect(hwpxText(z)).toBe('본문 글\n그림 1. 대기실')
  })
  test('extractText picks the format by extension', async () => {
    const z = container({ 'Contents/section0.xml': sec('<hp:p><hp:run><hp:t>hwpx 본문</hp:t></hp:run></hp:p>') }, 'zip')
    expect(await extractText('공지.hwpx', z, tools)).toBe('hwpx 본문')
    expect(await extractText('공지.HWP', hwp(para(u16('hwp 본문'))), tools)).toBe('hwp 본문')
  })
})
