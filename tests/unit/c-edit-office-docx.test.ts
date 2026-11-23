// edit_office for Word (server/src/files/docx-edit.ts in the office worker; plan
// docs/AGENTS/plan/20261118-1041-office-edit-in-place.md, QA TC-4906): text replaced inside a run keeps the run's
// formatting, paragraphs and table rows are added and removed, cells set; comments, tracked changes and every part
// outside the edit are kept byte for byte; what cannot be changed exactly is refused with the reason. The files are
// made the way people's files are made: pandoc's Word writer, then saved again by LibreOffice when it is installed.
import fs from 'node:fs'
import zlib from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { which } from '../../server/src/config'
import { addDocxComments } from '../../server/src/files/docx-comment'
import { docxParagraphTexts, editDocx } from '../../server/src/files/docx-edit'
import { officeEditRequest, officeVerifyRequest, frame, unframe, Pkg, type EditReport } from '../../server/src/files/office-edit'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { readCentral, entryData } from '../../server/src/files/zip-guard'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const soffice = which('soffice') ?? which('libreoffice')
const withPandoc = pandoc ? test : test.skip
const withOffice = pandoc && soffice ? test : test.skip

const CONTRACT = [
  '# Supply Contract', '',
  'Article 1 (Purpose) This contract covers **office supplies** for 2026.', '',
  'Article 3 (Payment) Paid on the 25th of each month.', '',
  '| Item | Qty | Price |', '|------|-----|-------|', '| Paper | 10 | 5,000 |', '| Pens | 20 | 1,000 |', '',
  '- first point', '- second point', '',
].join('\n')

function docx(md: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'docx', '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
/** the file as LibreOffice saves it (its own XML: rsids, w14 ids, its styles), or the same file without LibreOffice */
function viaOffice(b: Uint8Array, ext = 'docx'): Uint8Array {
  if (!soffice) return b
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-'))
  try {
    fs.writeFileSync(path.join(dir, `in.${ext}`), b)
    const filter = ext === 'docx' ? 'docx:MS Word 2007 XML' : ext === 'xlsx' ? 'xlsx:Calc MS Excel 2007 XML' : 'pptx:Impress MS PowerPoint 2007 XML'
    const r = Bun.spawnSync([soffice, `-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', filter, '--outdir', path.join(dir, 'out'), path.join(dir, `in.${ext}`)])
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return new Uint8Array(fs.readFileSync(path.join(dir, 'out', `in.${ext}`)))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
/** LibreOffice opens the file and makes a PDF of it (and the PDF's text, when pdftotext is there) */
function opensInOffice(b: Uint8Array, ext: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-open-'))
  try {
    fs.writeFileSync(path.join(dir, `x.${ext}`), b)
    const r = Bun.spawnSync([soffice!, `-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, `x.${ext}`)])
    const pdf = path.join(dir, 'x.pdf')
    if (r.exitCode !== 0 || !fs.existsSync(pdf) || fs.statSync(pdf).size < 500) throw new Error(`LibreOffice could not open it: ${r.stderr.toString().slice(0, 300)}`)
    const t = which('pdftotext') ? Bun.spawnSync([which('pdftotext')!, pdf, '-']).stdout.toString() : ''
    return t
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

const part = (b: Uint8Array, name: string) => { const e = readZip(b).find((x) => x.name === name); return e ? new TextDecoder().decode(e.data) : null }
const withPart = (b: Uint8Array, name: string, f: (x: string) => string) => writeZip(readZip(b).map((e) => (e.name === name ? { name: e.name, data: new TextEncoder().encode(f(new TextDecoder().decode(e.data))) } : e)))
/** the parts whose compressed bytes differ (or that are only in one of the files) */
function changedParts(a: Uint8Array, b: Uint8Array): string[] {
  const ra = new Map(readCentral(a).map((e) => [new TextDecoder().decode(e.nameBytes), Buffer.from(entryData(a, e))]))
  const rb = new Map(readCentral(b).map((e) => [new TextDecoder().decode(e.nameBytes), Buffer.from(entryData(b, e))]))
  return [...new Set([...ra.keys(), ...rb.keys()])].filter((n) => !ra.get(n) || !rb.get(n) || !ra.get(n)!.equals(rb.get(n)!)).sort()
}
/** the whole worker path: edit, then the fresh verify on old and new */
function run(b: Uint8Array, changes: unknown[]): { file: Uint8Array; report: EditReport } {
  const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes }, [b])))
  const file = out.blobs[0]!
  officeVerifyRequest(frame({ kind: 'docx', changed: out.json.changed, added: out.json.added, notes: out.json.notes }, [b, file]))
  return { file, report: out.json }
}
const texts = (b: Uint8Array) => docxParagraphTexts(new Pkg(b, 'docx')).filter((t) => t !== '')

describe('edit_office: Word documents', () => {
  withPandoc('find/replace keeps the run formatting; only document.xml changes and nothing else in it', () => {
    const before = viaOffice(docx(CONTRACT))
    const { file, report } = run(before, [{ find: 'office supplies', replace: 'printer paper' }, { find: '25th', replace: 'last day' }])
    expect(changedParts(before, file)).toEqual(['word/document.xml'])
    expect(report.changed).toEqual(['word/document.xml'])
    const doc = part(file, 'word/document.xml')!
    // the bold run is still bold, with the new text in it
    expect(doc).toMatch(/<w:b\b[^>]*\/>(?:(?!<\/w:r>)[\s\S])*printer paper/)
    expect(doc).not.toContain('office supplies')
    expect(texts(file)).toContain('Article 3 (Payment) Paid on the last day of each month.')
    expect(report.notes.map((n) => n.after?.[0])).toContain('Article 1 (Purpose) This contract covers printer paper for 2026.')
    // only the bytes of the two text elements differ
    const a = part(before, 'word/document.xml')!
    expect(doc.length - a.length).toBe('printer paper'.length - 'office supplies'.length + 'last day'.length - '25th'.length)
    if (soffice) { const pdf = opensInOffice(file, 'docx'); if (pdf) expect(pdf).toContain('printer paper') }
  })

  withPandoc('text across runs: the new text goes into the first run, the rest is cut out of the next ones', () => {
    const before = docx(CONTRACT)
    const { file } = run(before, [{ find: 'covers office', replace: 'is about' }])
    expect(texts(file)).toContain('Article 1 (Purpose) This contract is about supplies for 2026.')
  })

  withPandoc('several places: refused without occurrence; all: true changes each', () => {
    const b = docx('# T\n\nprice A\n\nprice B\n')
    expect(() => run(b, [{ find: 'price', replace: 'cost' }])).toThrow(/is in 2 places; give occurrence/)
    expect(texts(run(b, [{ find: 'price', replace: 'cost', occurrence: 2 }]).file)).toEqual(['T', 'price A', 'cost B'])
    expect(texts(run(b, [{ find: 'price', replace: 'cost', all: true }]).file)).toEqual(['T', 'cost A', 'cost B'])
    expect(() => run(b, [{ find: 'nowhere', replace: 'x' }])).toThrow(/is not in the text of any one paragraph/)
  })

  withPandoc('insert and delete paragraphs: the copy takes the list style of the paragraph next to it', () => {
    const before = viaOffice(docx(CONTRACT))
    const { file } = run(before, [
      { insert_paragraph: { after: 'second point', text: 'third point' } },
      { delete_paragraph: { text: 'Article 3' } },
    ])
    const t = texts(file)
    expect(t).not.toContain('Article 3 (Payment) Paid on the 25th of each month.')
    expect(t.indexOf('third point')).toBe(t.indexOf('second point') + 1)
    const doc = part(file, 'word/document.xml')!
    // numbering properties copied: the new paragraph is a list item too
    const third = doc.slice(doc.lastIndexOf('<w:p>', doc.indexOf('third point')), doc.indexOf('third point'))
    expect(third).toContain('<w:numPr>')
    if (soffice) opensInOffice(file, 'docx')
  })

  withPandoc('tables: a cell set, a row added in the look of the row it copies, a row deleted', () => {
    const before = viaOffice(docx(CONTRACT))
    const { file } = run(before, [
      { table_cell: { table: 1, row: 2, column: 3, value: '5,500' } },
      { add_rows: { table: 1, after_row: 3, rows: [['Stapler', '2', '8,000']] } },
      { delete_rows: { table: 1, rows: [3] } },
    ])
    const t = texts(file)
    expect(t).toContain('5,500')
    expect(t).not.toContain('5,000')
    expect(t).toContain('Stapler')
    expect(t).not.toContain('Pens')
    expect(t.indexOf('Stapler')).toBeGreaterThan(t.indexOf('5,500'))
    if (soffice) {
      const pdf = opensInOffice(file, 'docx')
      if (pdf) expect(pdf).toContain('Stapler')
    }
  })

  withPandoc('comments and tracked changes stay; a change that cuts through a tracked change is refused', () => {
    const commented = addDocxComments(docx(CONTRACT), [{ on: 'Article 1', text: 'check the year' }], 'Dana', '2026-11-18T09:00:00Z').file
    const tracked = withPart(commented, 'word/document.xml', (x) => x.replace('Paid on the 25th', 'Paid on the </w:t></w:r><w:ins w:id="90" w:author="Bob" w:date="2026-11-18T00:00:00Z"><w:r><w:t>25th</w:t></w:r></w:ins><w:r><w:t xml:space="preserve">'))
    const { file } = run(tracked, [{ find: '2026', replace: '2027' }])
    expect(changedParts(tracked, file)).toEqual(['word/document.xml'])
    const doc = part(file, 'word/document.xml')!
    expect(doc).toContain('<w:commentRangeStart w:id="0"/>')
    expect(doc).toContain('<w:ins w:id="90" w:author="Bob"')
    expect(part(file, 'word/comments.xml')).toBe(part(tracked, 'word/comments.xml'))
    expect(() => run(tracked, [{ find: 'the 25th', replace: 'the 1st' }])).toThrow(/tracked change/)
    expect(() => run(tracked, [{ delete_paragraph: { text: 'Article 1' } }])).toThrow(/comment/)
  })

  withPandoc('a line break in the new text is a break in the same run; a tab across a match is refused', () => {
    const { file } = run(docx(CONTRACT), [{ find: 'Paid on the 25th of each month.', replace: 'Paid monthly.\nLate fees apply.' }])
    expect(texts(file)).toContain('Article 3 (Payment) Paid monthly.\nLate fees apply.')
    const tabbed = withPart(docx(CONTRACT), 'word/document.xml', (x) => x.replace('Paid on the', 'Paid on</w:t><w:tab/><w:t xml:space="preserve">the'))
    expect(() => run(tabbed, [{ find: 'on\tthe', replace: 'x' }])).toThrow(/a tab/)
  })

  withPandoc('refused: a signed file, a file with a DTD, not a Word file; the editor alone gives notes', () => {
    const signed = writeZip([...readZip(docx(CONTRACT)), { name: '_xmlsignatures/sig1.xml', data: new TextEncoder().encode('<x/>') }])
    expect(() => run(signed, [{ find: 'Article', replace: 'A' }])).toThrow(/digitally signed/)
    const dtd = withPart(docx(CONTRACT), 'word/document.xml', (x) => x.replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE x [<!ENTITY a "b">]>'))
    expect(() => run(dtd, [{ find: 'Article', replace: 'A' }])).toThrow(/DTD/)
    expect(() => run(new TextEncoder().encode('hello'), [{ find: 'a', replace: 'b' }])).toThrow(/not a zip/)
    const pkg = new Pkg(docx(CONTRACT), 'docx')
    expect(editDocx(pkg, [{ find: 'Supply', replace: 'Service' }]).notes[0]).toMatchObject({ change: 0, before: 'Supply Contract', after: ['Service Contract'] })
  })

  withPandoc('edit_office never writes a field (QA TC-4948): field-looking text stays text; a new paragraph or row copies no field', () => {
    const field = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>'
    const b = withPart(docx(CONTRACT), 'word/document.xml', (x) => x.replace('Paid on the 25th', `Paid on the 25th</w:t></w:r>${field}<w:r><w:t xml:space="preserve">`))
    const before = (part(b, 'word/document.xml')!.match(/<w:instrText|<w:fldSimple/g) ?? []).length
    const { file } = run(b, [
      { find: 'Supply', replace: '{ DDEAUTO cmd "/c calc" } <w:instrText>DDE</w:instrText>' },
      { insert_paragraph: { after: 'Article 3', text: 'new line' } },
      { add_rows: { table: 1, after_row: 2, rows: [['DDEAUTO x', '1', '2']] } },
    ])
    const doc = part(file, 'word/document.xml')!
    expect((doc.match(/<w:instrText|<w:fldSimple/g) ?? []).length).toBe(before)
    expect(doc).toContain('&lt;w:instrText&gt;DDE&lt;/w:instrText&gt;')
  })

  withPandoc('control characters in the AI\'s text are left out before it is matched and reported (no false refusal)', () => {
    const { file, report } = run(docx(CONTRACT), [{ find: 'Supply', replace: 'Ser\u0001vice\u000b' }])
    expect(texts(file)).toContain('Service Contract')
    expect(report.notes[0]!.after).toEqual(['Service Contract'])
  })

  withPandoc('a bookmark named with $ patterns stays as it is; deleting a paragraph where a field starts but does not end is refused', () => {
    const b = withPart(docx(CONTRACT), 'word/document.xml', (x) => x.replace('<w:t xml:space="preserve">5,000</w:t>', () => '<w:t xml:space="preserve">5,000</w:t></w:r><w:bookmarkStart w:id="7" w:name="price$1$&amp;"/><w:bookmarkEnd w:id="7"/><w:r><w:t></w:t>'))
    const { file } = run(b, [{ table_cell: { table: 1, row: 2, column: 3, value: '6,000' } }])
    expect(part(file, 'word/document.xml')).toContain('w:name="price$1$&amp;"')
    const open = withPart(docx(CONTRACT), 'word/document.xml', (x) => x.replace('Paid on the 25th', 'Paid on the 25th</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC</w:instrText></w:r><w:r><w:t xml:space="preserve">'))
    expect(() => run(open, [{ delete_paragraph: { text: 'Article 3' } }])).toThrow(/a field .* starts or ends in that paragraph/)
  })

  withPandoc('the verifier counts: one note for a paragraph does not cover a second paragraph with the same text', () => {
    const b = docx('# T\n\nsame\n\nsame\n\nother\n')
    const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes: [{ delete_paragraph: { text: 'same', occurrence: 1 } }] }, [b])))
    const both = withPart(out.blobs[0]!, 'word/document.xml', (x) => x.replace(/<w:p>(?:(?!<w:p>)[\s\S])*?>same<\/w:t>(?:(?!<w:p>)[\s\S])*?<\/w:p>/, ''))
    expect(texts(both)).not.toContain('same')
    expect(() => officeVerifyRequest(frame({ kind: 'docx', changed: out.json.changed, added: [], notes: out.json.notes }, [b, both]))).toThrow(/changed, but no change named it/)
  })

  withPandoc('the verifier catches a paragraph changed that no change named', () => {
    const before = docx(CONTRACT)
    const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes: [{ find: 'Supply', replace: 'Service' }] }, [before])))
    const sneaky = withPart(out.blobs[0]!, 'word/document.xml', (x) => x.replace('Paid on the 25th', 'Paid never'))
    expect(() => officeVerifyRequest(frame({ kind: 'docx', changed: out.json.changed, added: [], notes: out.json.notes }, [before, sneaky]))).toThrow(/changed, but no change named it/)
  })
})

// insert_picture (plan docs/AGENTS/plan/20261123-0840-docx-insert-picture.md, QA TC-8170..8175): a signature or a seal
// put at a label of a Word form. The pictures here are made in the test (the tool's own re-encoding is in
// c-edit-office-tool.test.ts); fake names only.
const FORM = [
  '# Supply Contract', '',
  'Signed on 23 November 2026.', '',
  'Buyer: Example Trading Co. (seal)', '',
  'Seller: Hong Gildong (seal)', '',
  'Signature:', '',
  '| Item | Value |', '|------|-------|', '| Name | Hong Gildong |', '| Sign | |', '',
].join('\n')
function png(w: number, h: number): Uint8Array {
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => [200, 20, 20]).flat()])))
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
function runPics(b: Uint8Array, changes: unknown[], images: Uint8Array[]): { file: Uint8Array; report: EditReport } {
  const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes }, [b, ...images])))
  const file = out.blobs[0]!
  officeVerifyRequest(frame({ kind: 'docx', changed: out.json.changed, added: out.json.added, notes: out.json.notes }, [b, file]))
  return { file, report: out.json }
}
const ids = (xml: string) => [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => Number(m[1]))

describe('edit_office: insert_picture (a signature or seal in a Word form)', () => {
  withPandoc('over, after and next_to: the pictures are there, the text is not changed, only the parts a picture needs change', () => {
    const before = viaOffice(docx(FORM))
    const seal = png(40, 40), sign = png(90, 30)
    const { file, report } = runPics(before, [
      { insert_picture: { image: 0, over: '(seal)', occurrence: 1, width_mm: 15 } },
      { insert_picture: { image: 0, over: '(seal)', occurrence: 2, width_mm: 15 } },
      { insert_picture: { image: 1, after: 'Signature:', height_mm: 10 } },
      { insert_picture: { image: 1, next_to: 'Sign', occurrence: 3 } },
    ], [seal, sign])
    expect(texts(file)).toEqual(texts(before))
    // one media part per picture (the seal is used twice), the relationships, maybe the content types; nothing else
    const media = report.added.filter((n) => /^word\/media\/image\d+\.png$/.test(n))
    expect(media.length).toBe(2)
    expect(changedParts(before, file).filter((n) => !media.includes(n))).toEqual(expect.arrayContaining(['word/_rels/document.xml.rels', 'word/document.xml']))
    expect(changedParts(before, file).every((n) => media.includes(n) || ['word/_rels/document.xml.rels', 'word/document.xml', '[Content_Types].xml'].includes(n))).toBe(true)
    const doc = part(file, 'word/document.xml')!
    // two floating seals behind the text, two inline pictures; sizes in EMU (1 mm = 36000), shape kept
    expect(doc.match(/<wp:anchor\b[^>]*behindDoc="1"/g)?.length).toBe(2)
    expect(doc.match(/<wp:inline\b/g)?.length).toBe(2)
    expect(doc).toContain('<wp:extent cx="540000" cy="540000"/>')
    expect(doc).toContain('<wp:extent cx="1080000" cy="360000"/>')
    expect(doc).toContain('<wp:extent cx="720000" cy="240000"/>')
    expect(doc).toMatch(/<wp:positionH relativeFrom="character"><wp:posOffset>-?\d+<\/wp:posOffset><\/wp:positionH><wp:positionV relativeFrom="line">/)
    // ids: four new ones, each once, above the document's own
    const old = ids(part(before, 'word/document.xml')!)
    const neu = ids(doc).filter((n) => !old.includes(n))
    expect(neu.length).toBe(4)
    expect(new Set(neu).size).toBe(4)
    expect(Math.min(...neu)).toBeGreaterThan(Math.max(0, ...old))
    // every new r:embed names an image relationship to an added part with a content type
    const rels = part(file, 'word/_rels/document.xml.rels')!
    for (const id of new Set([...doc.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]!))) expect(rels).toMatch(new RegExp(`Id="${id}" Type="[^"]+/image" Target="media/image\\d+\\.png"`))
    expect(part(file, '[Content_Types].xml')!).toMatch(/Extension="png"/i)
    // the sign row's cell holds the picture
    expect(doc).toMatch(/<w:t[^>]*>Sign<\/w:t>[\s\S]*?<\/w:tc><w:tc>[\s\S]*?<wp:inline/)
    expect(report.notes.map((n) => n.where)).toEqual([
      'picture over "(seal)", behind the text (15 x 15 mm)', 'picture over "(seal)", behind the text (15 x 15 mm)',
      'picture after "Signature:" (30 x 10 mm)', expect.stringMatching(/^picture in the cell right of "Sign" \(/),
    ])
    if (soffice) opensInOffice(file, 'docx')
  })

  withPandoc('a label inside a run: the text element is split, the paragraph reads the same; the default size is 20 mm', () => {
    const before = docx(FORM)
    const { file, report } = runPics(before, [{ insert_picture: { image: 0, after: 'Buyer:' } }], [png(30, 60)])
    expect(texts(file)).toEqual(texts(before))
    expect(report.notes[0]!.where).toBe('picture after "Buyer:" (10 x 20 mm)')
    expect(part(file, 'word/document.xml')!).toMatch(/Buyer:<\/w:t><w:drawing>[\s\S]*?<\/w:drawing><w:t xml:space="preserve"> Example/)
  })

  withPandoc('a document whose root does not name the drawing namespaces: they are declared on the picture', () => {
    const before = withPart(docx(FORM), 'word/document.xml', (x) => x.replace(/\sxmlns:(wp|a|pic)="[^"]*"/g, ''))
    expect(part(before, 'word/document.xml')!).not.toContain('xmlns:wp=')
    const { file } = runPics(before, [{ insert_picture: { image: 0, over: '(seal)', occurrence: 2 } }], [png(10, 10)])
    expect(part(file, 'word/document.xml')!).toContain('<wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"')
  })

  withPandoc('refused with the reason, nothing saved: no label, two places, no place given, not a table, no cell to the right, not a picture, a size out of range', () => {
    const before = docx(FORM)
    const pic = [png(10, 10)]
    const no = (c: Record<string, unknown>, images = pic) => () => runPics(before, [{ insert_picture: { image: 0, ...c } }], images)
    expect(no({ over: '(stamp)' })).toThrow(/is not in the text of any one paragraph/)
    expect(no({ over: '(seal)' })).toThrow(/is in 2 places/)
    expect(no({})).toThrow(/give one of after, over or next_to/)
    expect(no({ over: '(seal)', after: 'Buyer:' })).toThrow(/give one of after, over or next_to/)
    expect(no({ next_to: 'Signature:' })).toThrow(/is not in a table cell/)
    expect(no({ next_to: 'Hong Gildong', occurrence: 2 })).toThrow(/no cell to the right/)
    expect(no({ after: 'Buyer:' }, [new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0])])).toThrow(/not a PNG or JPEG/)
    expect(no({ after: 'Buyer:' }, [new TextEncoder().encode('<script>x</script>')])).toThrow(/not a PNG or JPEG/)
    expect(no({ after: 'Buyer:', width_mm: 0.2 })).toThrow(/from 1 to 300/)
    expect(no({ after: 'Buyer:', height_mm: 300 }, [png(400, 10)])).toThrow(/give a smaller size/)
  })

  withPandoc('the label in a tracked change is refused', () => {
    const before = withPart(docx(FORM), 'word/document.xml', (x) => x.replace(/(<w:r>(?:(?!<w:r>)[\s\S])*?Buyer:[\s\S]*?<\/w:r>)/, '<w:ins w:id="90" w:author="A" w:date="2026-11-23T00:00:00Z">$1</w:ins>'))
    expect(() => runPics(before, [{ insert_picture: { image: 0, after: 'Buyer:' } }], [png(10, 10)])).toThrow(/tracked change/)
  })

  withPandoc('the read-back: a new picture id used twice, or a new picture pointing at no added image, is refused', () => {
    const before = docx(FORM)
    const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes: [{ insert_picture: { image: 0, over: '(seal)', occurrence: 1 } }, { insert_picture: { image: 0, over: '(seal)', occurrence: 2 } }] }, [before, png(10, 10)])))
    const verify = (b: Uint8Array) => () => officeVerifyRequest(frame({ kind: 'docx', changed: out.json.changed, added: out.json.added, notes: out.json.notes }, [before, b]))
    expect(verify(out.blobs[0]!)).not.toThrow()
    const twice = withPart(out.blobs[0]!, 'word/document.xml', (x) => { const [a, b] = ids(x).slice(-2); return x.replace(`<wp:docPr id="${b}"`, `<wp:docPr id="${a}"`) })
    expect(verify(twice)).toThrow(/picture id \d+ is used twice/)
    const elsewhere = withPart(out.blobs[0]!, 'word/document.xml', (x) => x.replace(/r:embed="[^"]+"/, 'r:embed="rId999"'))
    expect(verify(elsewhere)).toThrow(/not a picture added here/)
    const external = withPart(out.blobs[0]!, 'word/_rels/document.xml.rels', (x) => x.replace('</Relationships>', '<Relationship Id="rId998" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>'))
    expect(verify(external)).toThrow(/new relationship "rId998" is not a picture added here/)
    const ct = withPart(out.blobs[0]!, '[Content_Types].xml', (x) => x.replace('</Types>', '<Override PartName="/word/x.xml" ContentType="application/xml"/></Types>'))
    expect(verify(ct)).toThrow(/content types changed/)
  })

  withPandoc('a picture at text that a find/replace of the same call changes is refused; next to other text both go through', () => {
    const before = docx(FORM)
    expect(() => runPics(before, [{ find: 'Buyer:', replace: 'Client:' }, { insert_picture: { image: 0, after: 'Buyer:' } }], [png(10, 10)])).toThrow(/changes 1 and 2 touch the same text/)
    const { file } = runPics(before, [{ find: 'Signed on', replace: 'Made on' }, { insert_picture: { image: 0, over: '(seal)', occurrence: 2 } }], [png(10, 10)])
    expect(texts(file)).toContain('Made on 23 November 2026.')
    // over: the whole label counts, not only where it starts
    expect(() => runPics(before, [{ find: 'Gildong (seal', replace: 'Gil-dong (seal' }, { insert_picture: { image: 0, over: '(seal)', occurrence: 2 } }], [png(10, 10)])).toThrow(/touch the same text/)
    expect(() => runPics(before, [{ find: 'seal)', replace: 'stamp)', occurrence: 2 }, { insert_picture: { image: 0, over: '(seal)', occurrence: 2 } }], [png(10, 10)])).toThrow(/touch the same text/)
  })
})
