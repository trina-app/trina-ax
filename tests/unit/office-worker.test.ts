// Spreadsheets and Hangul files are read in the office worker (server/src/files/office-worker.ts), a bounded child
// process, never in the server process. Crafted files (zip bombs, a lying zip header, an oversized HWP body, a sheet
// that declares millions of cells) are refused quickly with the "too large or too complex" error; normal files keep
// the same text as the old in-process code. The bombs are built here and stay small in memory and on disk.
import { describe, expect, test } from 'bun:test'
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import { extractText } from '../../server/src/files/extract'
import { checkZip } from '../../server/src/files/zip-guard'
import { sheetText } from '../../server/src/files/office-parse'

const tools = { pandoc: null, pdftotext: null }
const MIB = 1024 * 1024
const TOO_COMPLEX = /too large or too complex to read safely/

// ---- a minimal zip writer: each entry deflated (or given as raw deflate data) with sizes we choose ----
interface ZipPart { name: string; data?: Uint8Array | string; deflated?: Uint8Array; usize?: number; stored?: boolean }
function zip(parts: ZipPart[]): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let off = 0
  for (const p of parts) {
    const name = Buffer.from(p.name, 'utf8')
    const raw = p.data === undefined ? undefined : typeof p.data === 'string' ? Buffer.from(p.data, 'utf8') : Buffer.from(p.data)
    const body = p.deflated ? Buffer.from(p.deflated) : p.stored ? raw! : zlib.deflateRawSync(raw!)
    const usize = p.usize ?? raw?.length ?? 0
    const crc = raw ? Bun.hash.crc32(raw) : 0
    const method = p.stored ? 0 : 8
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize >>> 0, 22); lh.writeUInt16LE(name.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10)
    ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize >>> 0, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42)
    locals.push(lh, name, body)
    centrals.push(ch, name)
    off += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16)
  return new Uint8Array(Buffer.concat([...locals, cd, end]))
}

/** The parts of a real one-sheet xlsx (SheetJS), so a bomb differs from a good file only where it should. */
function xlsxParts(cells: (string | number)[][]): ZipPart[] {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cells), 'S1')
  const c: { FullPaths: string[]; FileIndex: { content?: Uint8Array }[] } = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' })
  return c.FullPaths.map((p: string, i: number): ZipPart => ({ name: p.replace(/^Root Entry\//, ''), data: c.FileIndex[i]!.content }))
    .filter((p: ZipPart) => p.data && p.data.length && !p.name.endsWith('/'))
}
const withPart = (parts: ZipPart[], name: string, part: Omit<ZipPart, 'name'>) => parts.map((p) => (p.name === name ? { name, ...part } : p))
const SHEET = 'xl/worksheets/sheet1.xml'
const sheetXml = (dim: string, rows: string, pad = '') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dim}"/><sheetData>${rows}</sheetData>${pad}</worksheet>`

const zeros = (n: number) => zlib.deflateRawSync(Buffer.alloc(n))

describe('zip check (zip-guard.ts)', () => {
  test('a good xlsx passes and reads as before', async () => {
    const z = zip(xlsxParts([['이름', '금액'], ['a', 1234]]))
    expect(() => checkZip(z)).not.toThrow()
    expect(await extractText('a.xlsx', z, tools)).toBe('# sheet: S1 (tab-separated)\n이름\t금액\na\t1234')
  })
  test('one part that expands more than 100 times (and over 10 MB) is refused', async () => {
    const z = zip(withPart(xlsxParts([['x']]), SHEET, { data: sheetXml('A1', '', ' '.repeat(30 * MIB)) }))
    expect(z.length).toBeLessThan(200 * 1024)
    const t0 = Date.now()
    await expect(extractText('bomb.xlsx', z, tools)).rejects.toThrow(/expands more than 100 times/)
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
  test('parts that together expand past 200 MB are refused before any is inflated', () => {
    const nine = zeros(9 * MIB)
    const parts: ZipPart[] = Array.from({ length: 25 }, (_, i) => ({ name: `xl/media/p${i}.bin`, deflated: nine, usize: 9 * MIB }))
    const z = zip([...xlsxParts([['x']]), ...parts])
    const t0 = Date.now()
    expect(() => checkZip(z)).toThrow(/expands to more than 200 MB/)
    expect(Date.now() - t0).toBeLessThan(1000)
    // a header that claims 4 GB is refused the same way
    expect(() => checkZip(zip([{ name: SHEET, deflated: nine, usize: 0xfffffff0 }]))).toThrow(TOO_COMPLEX)
  })
  test('a part larger than its header says is refused (the real inflate is capped at the declared size)', async () => {
    const z = zip(withPart(xlsxParts([['x']]), SHEET, { deflated: zeros(50 * MIB), usize: 1000 }))
    expect(() => checkZip(z)).toThrow(/larger than its header says/)
    await expect(extractText('liar.xlsx', z, tools)).rejects.toThrow(/larger than its header says/)
  })
  test('too many parts, zip64 markers, a damaged directory', () => {
    expect(() => checkZip(zip(Array.from({ length: 10_001 }, (_, i) => ({ name: `p${i}`, data: '', stored: true }))))).toThrow(/more than 10000 parts/)
    const z = zip([{ name: 'a', data: 'x' }])
    expect(() => checkZip(z.subarray(0, z.length - 10))).toThrow(/damaged zip container/)
  })
})

describe('spreadsheets in the worker', () => {
  // a declared range larger than the data is common in real files, so it is cut to the real cells, not refused
  test('a sheet that declares A1:XFD1048576 (17 billion cells) with a few real ones: fast, the real cells only', async () => {
    const cell = (r: number, v: string) => `<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>${v}</t></is></c></row>`
    const near = zip(withPart(xlsxParts([['x']]), SHEET, { data: sheetXml('A1:XFD1048576', cell(1, 'hello') + '<row r="3"><c r="B3"><v>42</v></c></row>') }))
    const far = zip(withPart(xlsxParts([['x']]), SHEET, { data: sheetXml('A1:XFD1048576', cell(1, 'top') + cell(1048576, 'bottom')) }))
    const t0 = Date.now()
    // three rows of the declared 16384 columns stay as they were (empty fields, the old output)
    const t = await extractText('dim.xlsx', near, tools)
    expect(t).toMatch(/^# sheet: S1 \(tab-separated\)\nhello\t{16383}\n\t42\t{16382}$/)
    // a million rows of them would be 17 billion empty fields: the columns are cut to the real ones
    expect(await extractText('far.xlsx', far, tools)).toBe('# sheet: S1 (tab-separated)\ntop\nbottom')
    expect(Date.now() - t0).toBeLessThan(10_000)
  })
  test('an .ods that repeats a filled cell over a million rows and 16384 columns is refused within the limits', async () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:spreadsheet><table:table table:name="S1"><table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="16384" office:value-type="string"><text:p>boom</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`
    const z = zip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet', stored: true },
      { name: 'META-INF/manifest.xml', data: '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>' },
      { name: 'styles.xml', data: '<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"/>' },
      { name: 'content.xml', data: content },
    ])
    expect(z.length).toBeLessThan(4096)
    const heap0 = process.memoryUsage().heapUsed
    const t0 = Date.now()
    await expect(extractText("repeat.ods", z, tools)).rejects.toThrow(TOO_COMPLEX)
    expect(Date.now() - t0).toBeLessThan(65_000)
    // the expansion happened in the child: the server process did not grow with it
    expect(process.memoryUsage().heapUsed - heap0).toBeLessThan(64 * MIB)
  }, 90_000)
  test('normal workbooks (xlsx, xls, ods, xlsb): the same text as the old in-process code', async () => {
    const old = (b: Uint8Array) => { const wb = XLSX.read(b, { type: 'array', cellFormula: false, cellHTML: false }); return wb.SheetNames.map((s) => `# sheet: ${s} (tab-separated)\n` + XLSX.utils.sheet_to_csv(wb.Sheets[s]!, { FS: '\t', blankrows: false })).join('\n\n') }
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['이름', '금액', '날짜'], ['a', 1234.5, new Date(2024, 0, 2)], [], ['b', '007', null, 'far']], { cellDates: true, origin: 'C3' } as XLSX.AOA2SheetOpts)
    ws['!ref'] = 'A1:Z200'
    XLSX.utils.book_append_sheet(wb, ws, '매출')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'empty')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Array.from({ length: 200 }, (_, i) => ({ i, s: 'row ' + i, f: i / 7 }))), 'big')
    for (const [bookType, ext] of [['xlsx', 'xlsx'], ['biff8', 'xls'], ['ods', 'ods'], ['xlsb', 'xlsx']] as const) {
      const b = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType }))
      expect(sheetText(b), bookType).toBe(old(b))
      expect(await extractText(`a.${ext}`, b, tools), bookType).toBe(old(b))
    }
  })
  test('not a workbook: a clear error from the worker', async () => {
    await expect(extractText('a.xlsx', zip([{ name: 'x.txt', data: 'hi' }]), tools)).rejects.toThrow(/could not|spreadsheet/)
  })
})

describe('Hangul files in the worker', () => {
  const container = (files: Record<string, Uint8Array>) => {
    const c = XLSX.CFB.utils.cfb_new()
    for (const [p, v] of Object.entries(files)) XLSX.CFB.utils.cfb_add(c, p, Buffer.from(v))
    return new Uint8Array(XLSX.CFB.write(c, { type: 'buffer' }) as Buffer)
  }
  const header = () => { const b = Buffer.alloc(256); b.write('HWP Document File', 0, 'latin1'); b.writeUInt32LE(0x05010100, 32); b.writeUInt32LE(1, 36); return b }
  test('an .hwpx whose section expands more than 100 times is refused', async () => {
    const z = zip([{ name: 'mimetype', data: 'application/hwp+zip', stored: true }, { name: 'Contents/section0.xml', data: '<hs:sec>' + ' '.repeat(30 * MIB) + '</hs:sec>' }])
    await expect(extractText('bomb.hwpx', z, tools)).rejects.toThrow(/expands more than 100 times/)
  })
  test('an .hwp body stream over 64 MB is refused', async () => {
    const bomb = container({ FileHeader: header(), 'BodyText/Section0': zeros(80 * MIB) })
    await expect(extractText('bomb.hwp', bomb, tools)).rejects.toThrow(/damaged or too large/)
  })
  test('.hwp body streams that together expand past 200 MB are refused', async () => {
    const sixty = zeros(60 * MIB)
    const bomb = container({ FileHeader: header(), 'BodyText/Section0': sixty, 'BodyText/Section1': sixty, 'BodyText/Section2': sixty, 'BodyText/Section3': sixty })
    expect(bomb.length).toBeLessThan(2 * MIB)
    await expect(extractText('total.hwp', bomb, tools)).rejects.toThrow(/body expands to more than 200 MB/)
  })
})
