// edit_office for Word (server/src/files/docx-edit.ts in the office worker; plan
// docs/AGENTS/plan/20261118-1041-office-edit-in-place.md, QA TC-4906): text replaced inside a run keeps the run's
// formatting, paragraphs and table rows are added and removed, cells set; comments, tracked changes and every part
// outside the edit are kept byte for byte; what cannot be changed exactly is refused with the reason. The files are
// made the way people's files are made: pandoc's Word writer, then saved again by LibreOffice when it is installed.
import fs from 'node:fs'
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

  withPandoc('the verifier catches a paragraph changed that no change named', () => {
    const before = docx(CONTRACT)
    const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes: [{ find: 'Supply', replace: 'Service' }] }, [before])))
    const sneaky = withPart(out.blobs[0]!, 'word/document.xml', (x) => x.replace('Paid on the 25th', 'Paid never'))
    expect(() => officeVerifyRequest(frame({ kind: 'docx', changed: out.json.changed, added: [], notes: out.json.notes }, [before, sneaky]))).toThrow(/changed, but no change named it/)
  })
})
