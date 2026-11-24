// A quote sheet stamped by the real editor (server/src/files/xlsx-edit.ts), for the sheet preview test (QA TC-8833):
// bun tests/lib/stamped-xlsx.ts <dir> writes stamp.xlsx, a seal placed at D6. Made-up company and numbers.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import * as XLSX from 'xlsx'
import '../../server/src/files/xlsx-edit' // registers the Excel editor
import { frame, officeEditRequest, unframe, type EditReport } from '../../server/src/files/office-edit'

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const end = Buffer.alloc(4); end.writeUInt32BE(crc(body))
  return Buffer.concat([head, body, end])
}
/** a red ring on transparent, 120 px */
function seal(): Uint8Array {
  const n = 120
  const raw = Buffer.alloc((n * 4 + 1) * n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = Math.hypot(x - n / 2, y - n / 2), at = y * (n * 4 + 1) + 1 + x * 4
    if (d < 58 && d > 46) { raw[at] = 214; raw[at + 1] = 40; raw[at + 2] = 40; raw[at + 3] = 255 }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', new Uint8Array())]))
}

const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['견적서', '', '', ''], ['품목', '수량', '단가', '금액'], ['노트북', 2, 1200000, 2400000], ['모니터', 3, 300000, 900000],
  ['합계', '', '', 3300000], ['공급자', '가나다테스트 주식회사', '대표', '(인)'],
]), '견적')
const book = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'xlsx', changes: [{ insert_picture: { image: 0, sheet: '견적', cell: 'D6', width_mm: 15 } }] }, [book, seal()])))
fs.writeFileSync(path.join(process.argv[2]!, 'stamp.xlsx'), out.blobs[0]!)
