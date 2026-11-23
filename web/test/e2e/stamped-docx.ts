// Word forms stamped by the real editor (server/src/files/docx-edit.ts), for the preview test: bun stamped-docx.ts <dir>
// writes stamp-over.docx, stamp-after.docx and stamp-next_to.docx. Fake names, a generated red seal.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import '../../../server/src/files/docx-edit' // registers the Word editor
import { frame, officeEditRequest, officeVerifyRequest, unframe, type EditReport } from '../../../server/src/files/office-edit'
import { writeZip } from '../../../server/src/files/zip-write'

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
    if (d < 58 && (d > 46 || (Math.abs(x - y) < 6 && d < 40))) { raw[at] = 214; raw[at + 1] = 40; raw[at + 2] = 40; raw[at + 3] = 255 }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 6
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', new Uint8Array())]))
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const para = (s: string) => `<w:p><w:r><w:t xml:space="preserve">${s}</w:t></w:r></w:p>`
const cell = (s: string) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${para(s)}</w:tc>`
const form = writeZip(Object.entries({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${para('신청서')}${para('신청인: 김가나테스트 (인)')}<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${cell('서명')}${cell('')}</w:tr></w:tbl>${para('끝')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
}).map(([name, v]) => ({ name, data: new TextEncoder().encode(v) })))

const dir = process.argv[2]!
const image = seal()
for (const [name, change] of Object.entries({
  over: { over: '(인)', width_mm: 15 },
  after: { after: '김가나테스트', height_mm: 12 },
  next_to: { next_to: '서명', height_mm: 12 },
})) {
  const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes: [{ insert_picture: { image: 0, ...change } }] }, [form, image])))
  officeVerifyRequest(frame({ kind: 'docx', changed: out.json.changed, added: out.json.added, notes: out.json.notes }, [form, out.blobs[0]!]))
  fs.writeFileSync(path.join(dir, `stamp-${name}.docx`), out.blobs[0]!)
}
