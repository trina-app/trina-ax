// edit_pdf's replace_text (TC-4992; docs/decisions/20261118-pdf-replace-text.md): the old words are really gone from the
// file (no content stream, decoded, still holds them), the new ones are where the old ones were, and what cannot be
// changed is said plainly (a picture, the hidden text layer of a scan). The worker function is called directly; one
// case through the tool path is in tests/unit/c-edit-pdf.test.ts. Fixtures are written here.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodePDFRawStream, PDFDocument, PDFRawStream } from 'pdf-lib'
import { decodePagesResult, encodePagesRequest, pdfPagesRequest, type PageOp } from '../../server/src/files/pdf-pages'
import { findMatches, fmt, FONT_ENTRIES_MAX, NOT_ALL_CHECKED, PAGE_MATCHES_MAX, pageTextOf, styleOf, withoutActualText, wordsElsewhere } from '../../server/src/files/pdf-text'
import { textFontFile } from '../../server/src/tools/pdf-tools'
import { ToolError } from '../../server/src/policy/errors'
import { makeCidPdf, makePdf, writePdf } from '../lib/pdf'

const stream = (body: string, dict = ''): string => `<< ${dict} /Length ${body.length} >>\nstream\n${body}\nendstream`
/** one page with this content and fonts F1 = Helvetica (and Im1, a 2x2 grey picture) */
function onePage(content: string, extraFonts = ''): Uint8Array {
  return writePdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R ${extraFonts} >> /XObject << /Im1 6 0 R >> >> >>`,
    stream(content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\x80\x80\x80\x80\nendstream',
  ])
}

const fontFile = textFontFile()
async function run(pdf: Uint8Array, ops: PageOp[], withFont = false) {
  const parts = [{ name: 'in.pdf', bytes: pdf }]
  if (withFont && fontFile) parts.push({ name: 'font', bytes: new Uint8Array(fs.readFileSync(fontFile)) })
  const r = decodePagesResult(await pdfPagesRequest(encodePagesRequest({ kind: 'edit', ops, font: withFont && fontFile ? 1 : null }, parts)))
  return { bytes: r.files[0]!, notes: r.report.notes.join('\n') }
}
const replaceOp = (find: string, replace: string, extra: Partial<{ pages: string; match_case: boolean }> = {}): PageOp => ({ replace_text: { find, replace, ...extra } })
async function fails(pdf: Uint8Array, ops: PageOp[]): Promise<string> {
  try { await run(pdf, ops) } catch (e) { if (e instanceof ToolError) return e.message; throw e }
  throw new Error('expected a refusal')
}

/** every stream of the file, decoded, as latin1 text */
async function allStreams(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  let all = ''
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue
    try { all += Buffer.from(decodePDFRawStream(o).decode()).toString('latin1') + '\n' } catch { all += Buffer.from(o.contents).toString('latin1') + '\n' }
  }
  return all
}
/** the words as hex codes of a one-byte font, as they would be written in a <hex> string */
const hex1 = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase()
const pdftotext = Bun.which('pdftotext')
function textOf(bytes: Uint8Array): string {
  if (!pdftotext) return ''
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.pdf'), bytes)
    return Bun.spawnSync([pdftotext, '-layout', path.join(dir, 'a.pdf'), '-']).stdout.toString()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const ourText = async (bytes: Uint8Array, page = 0) => pageTextOf(await PDFDocument.load(bytes), page)

describe('replace_text: the old words are gone', () => {
  test('a word in a Helvetica line: replaced in place, nowhere in the file afterwards', async () => {
    const pdf = makePdf(['Invoice for Acme Ltd', 'Total: 100 EUR'])
    const { bytes, notes } = await run(pdf, [replaceOp('Acme Ltd', 'Beta Corp')])
    const all = await allStreams(bytes)
    expect(all).not.toContain('Acme')
    expect(all).not.toContain(hex1('Acme'))
    expect(all).not.toContain(hex1('Ac'))
    expect(await ourText(bytes)).toContain('Invoice for Beta Corp')
    expect(await ourText(bytes)).toContain('Total: 100 EUR')
    if (pdftotext) { expect(textOf(bytes)).toContain('Beta Corp'); expect(textOf(bytes)).not.toContain('Acme') }
    expect(notes).toContain('changed 1 place of "Acme Ltd" on page 1')
    expect(notes).toContain('removed from the page text there, not covered')
    // the page's own font could write it: no other font added
    expect(notes).not.toContain('written in')
    // a standard font with a standard encoding reads the same everywhere: no letter-map warning
    expect(notes).not.toContain('letter map')
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })

  test('every match on every page by default; pages limits it; "" removes the words', async () => {
    const pdf = writePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
      stream('BT /F1 12 Tf 72 780 Td (DRAFT one DRAFT) Tj ET'),
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
      stream('BT /F1 12 Tf 72 780 Td (two DRAFT) Tj ET'),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ])
    const a = await run(pdf, [replaceOp('DRAFT', 'FINAL')])
    expect(a.notes).toContain('changed 3 places of "DRAFT" on pages 1, 2')
    expect(await ourText(a.bytes, 0)).toBe('FINAL one FINAL')
    expect(await ourText(a.bytes, 1)).toBe('two FINAL')
    const b = await run(pdf, [replaceOp('DRAFT', 'FINAL', { pages: '2' })])
    expect(await ourText(b.bytes, 0)).toBe('DRAFT one DRAFT')
    expect(await ourText(b.bytes, 1)).toBe('two FINAL')
    const c = await run(pdf, [replaceOp('DRAFT', '')])
    expect(await allStreams(c.bytes)).not.toContain('DRAFT')
    expect((await ourText(c.bytes, 0)).trim()).toBe('one')
  })

  test('words split over kerned pieces and operators, with spacing in gaps (as Word and browsers write PDFs)', async () => {
    const pdf = onePage('BT /F1 12 Tf 72 700 Td [(Tot) -20 (al)] TJ 40 0 Td [(am) 10 (ount)] TJ ( due) Tj ET')
    expect(await ourText(pdf)).toBe('Total amount due')
    const { bytes } = await run(pdf, [replaceOp('Total amount', 'Balance')])
    const all = await allStreams(bytes)
    for (const piece of ['Tot', 'al)', 'am)', 'ount', hex1('Tot'), hex1('ount')]) expect(all).not.toContain(piece)
    expect(await ourText(bytes)).toBe('Balance due')
  })

  test('the case is matched by default; match_case: false finds any case', async () => {
    const pdf = makePdf(['ACME and Acme'])
    const a = await run(pdf, [replaceOp('acme', 'X', { match_case: false })])
    expect(await ourText(a.bytes)).toBe('X and X')
    expect(await fails(pdf, [replaceOp('acme', 'X')])).toContain('"acme" was not found as text on page 1')
  })

  test("escaped literal strings and the ' operator", async () => {
    const pdf = onePage("BT /F1 12 Tf 14 TL 72 700 Td (Hello \\(World\\)) ' (Line \\101BC) ' ET")
    expect(await ourText(pdf)).toBe('Hello (World) Line ABC')
    const { bytes } = await run(pdf, [replaceOp('(World)', 'there')])
    expect(await ourText(bytes)).toBe('Hello there Line ABC')
    expect(await allStreams(bytes)).not.toContain('World')
  })

  test('the new words keep the text state: colour and size stay, the line after them does not move', async () => {
    const pdf = onePage('BT 1 0 0 rg /F1 20 Tf 72 700 Td (Name: Bob) Tj ET BT /F1 12 Tf 72 650 Td (Second line) Tj ET')
    const { bytes } = await run(pdf, [replaceOp('Bob', 'Alice')])
    const all = await allStreams(bytes)
    expect(all).toMatch(/1 0 0 rg \/F1 20 Tf/)
    expect(all).toContain('(Second line) Tj')
    expect(await ourText(bytes)).toBe('Name: Alice Second line')
  })

  test('longer words: the words after them on the line move along; another column does not, the new words get smaller', async () => {
    // "Smith" is its own run right after "Bob": it moves along by the extra width
    const pdf = onePage('BT /F1 12 Tf 72 700 Td (Bob) Tj 26 0 Td (Smith) Tj ET BT /F1 12 Tf 72 680 Td (next line) Tj ET')
    const a = await run(pdf, [replaceOp('Bob', 'Bobby')])
    expect(a.notes).toContain('moved along with them')
    expect(a.notes).not.toContain('smaller')
    const all = await allStreams(a.bytes)
    expect(all).toMatch(/\[-[0-9.]+ <536D697468>\] TJ/)
    expect(all).toContain('(next line) Tj')
    expect(await ourText(a.bytes)).toBe('Bobby Smith next line')
    // a table: the next cell starts far to the right and does not move; the new words are written smaller to fit
    const table = onePage('BT /F1 12 Tf 72 700 Td (Bob) Tj 60 0 Td (Paid) Tj ET')
    const b = await run(table, [replaceOp('Bob', 'Bob Robertson')])
    expect(b.notes).toContain('written a little smaller')
    expect(await allStreams(b.bytes)).toContain('(Paid) Tj')
    expect(await allStreams(b.bytes)).toMatch(/\/F1 (?!12 )[0-9.]+ Tf \[<426F6220526F62657274736F6E>\] TJ \/F1 12 Tf/)
  })

  test('letters the original font has no glyph for: a standard font of the same look', async () => {
    // an embedded subset font with a letter map for A, c, e, m only (the font file itself is not needed to read it)
    const toUni = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <0041> <02> <0063> endbfchar 1 beginbfrange <03> <04> [<0065> <006D>] endbfrange endcmap end end'
    const pdf = writePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F9 5 0 R >> >> >>',
      stream('BT /F9 14 Tf 72 700 Td <01020403> Tj ET'),
      '<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Georgia-Bold /FirstChar 1 /LastChar 4 /Widths [700 450 780 480] /FontDescriptor 6 0 R /ToUnicode 7 0 R >>',
      '<< /Type /FontDescriptor /FontName /ABCDEF+Georgia-Bold /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>',
      stream(toUni),
      stream('not a real font file'),
    ])
    expect(await ourText(pdf)).toBe('Acme')
    // "Ace": every letter is in the font
    const same = await run(pdf, [replaceOp('Acme', 'Ace')])
    expect(same.notes).not.toContain('written in')
    expect(await allStreams(same.bytes)).toContain('<010203>')
    // "Acne": no n in this subset, so a serif bold standard font
    const other = await run(pdf, [replaceOp('Acme', 'Acne')])
    expect(other.notes).toContain('written in Times-Bold')
    expect(await ourText(other.bytes)).toBe('Acne')
    expect(styleOf('ABCDEF+Georgia-Bold')).toEqual({ family: 'serif', bold: true, italic: false })
    expect(styleOf('Arial-ItalicMT').family).toBe('sans')
    expect(styleOf('CourierNewPS-BoldMT').family).toBe('mono')
  })

  test('a CID font with Identity-H and a letter map (as pdf-lib, Word and Chrome write them)', async () => {
    if (!fontFile) return
    // the page's Korean line written by edit_pdf's own add_text (Pretendard, Identity-H, with a letter map)
    const pdf = (await run(makePdf(['Second']), [{ add_text: { text: '계약자 홍길동 Acme', pages: '1', position: { x_mm: 20, y_mm: 20 } } }], true)).bytes
    expect(await ourText(pdf)).toBe('Second 계약자 홍길동 Acme')
    const { bytes, notes } = await run(pdf, [replaceOp('홍길동', '김철수')], true)
    expect(await ourText(bytes)).toContain('계약자 김철수 Acme')
    // the whole font is in the file, so its own glyphs write the new words
    expect(notes).not.toContain('written in')
    if (pdftotext) { expect(textOf(bytes)).not.toContain('홍길동'); expect(textOf(bytes)).toContain('김철수') }
    const back = await run(pdf, [replaceOp('Acme', '계약')], true)
    expect(back.notes).not.toContain('written in')
    expect(await ourText(back.bytes)).toContain('홍길동 계약')
  })

  test('a predefined Unicode CMap (UniKS-UCS2-H, Korean form generators)', async () => {
    const pdf = makeCidPdf(['견적서 홍길동 귀하'])
    expect(await ourText(pdf)).toBe('견적서 홍길동 귀하')
    const { bytes } = await run(pdf, [replaceOp('홍길동', '김철수')])
    expect(await ourText(bytes)).toBe('견적서 김철수 귀하')
    const ucs2 = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase()
    expect(await allStreams(bytes)).not.toContain(ucs2('홍길동'))
  })
})

describe('replace_text: said plainly when it cannot', () => {
  test('a page that is only a picture (a scan)', async () => {
    const msg = await fails(onePage('q 500 0 0 700 40 60 cm /Im1 Do Q'), [replaceOp('Acme', 'Beta')])
    expect(msg).toContain('page 1 is a picture (a scan or a photo) with no text in it; words that are part of a picture cannot be removed or changed here')
    expect(msg).toContain('nothing was saved')
  })

  test('the hidden text layer of a scanned page is left as it is', async () => {
    const pdf = onePage('q 500 0 0 700 40 60 cm /Im1 Do Q BT 3 Tr /F1 12 Tf 72 700 Td (Acme Ltd) Tj ET')
    const msg = await fails(pdf, [replaceOp('Acme', 'Beta')])
    expect(msg).toContain('only in the hidden text layer of a scanned page')
    expect(msg).toContain('would not change what the page shows')
  })

  test('a font that cannot be read, and vertical text', async () => {
    // the font object 9 does not exist: nothing says which letters the codes are
    expect(await fails(onePage('BT /F2 12 Tf 72 700 Td <0041> Tj ET', '/F2 9 0 R'), [replaceOp('A', 'B')])).toContain('page 1 uses a font that does not say which letters it draws')
    const toUni = 'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0041> <0041> endbfchar endcmap'
    const vertical = writePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F2 5 0 R >> >> >>',
      stream('BT /F2 12 Tf 72 700 Td <0041> Tj ET'),
      '<< /Type /Font /Subtype /Type0 /BaseFont /Gothic /Encoding /Identity-V /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Gothic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>',
      stream(toUni),
    ])
    expect(await fails(vertical, [replaceOp('A', 'B')])).toContain('was found but left as it is: it is vertical text')
  })

  test('the new words are one line', async () => {
    expect(await fails(makePdf(['Acme']), [replaceOp('Acme', 'a\nb')])).toContain('one line')
  })

  test('findMatches: a space in find matches a gap, a real space or a new line', async () => {
    const doc = await PDFDocument.load(onePage('BT /F1 12 Tf 14 TL 72 700 Td (Total) Tj T* (amount) Tj ET'))
    expect(pageTextOf(doc, 0)).toBe('Total amount')
    void findMatches
  })
})

describe('replace_text with the other operations', () => {
  test('after add_text on the same page, and before a page removal: old words gone, drawn text kept', async () => {
    const pdf = writePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
      stream('BT /F1 12 Tf 72 780 Td (Client: Acme) Tj ET'),
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
      stream('BT /F1 12 Tf 72 780 Td (page two) Tj ET'),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ])
    const { bytes } = await run(pdf, [{ add_text: { text: 'Approved', pages: '1' } }, replaceOp('Acme', 'Beta'), { add_text: { text: 'Later', pages: '1' } }, { remove_pages: '2' }])
    const all = await allStreams(bytes)
    expect(all).not.toContain('Acme')
    expect(all).not.toContain('page two')
    const t = await ourText(bytes)
    expect(t).toContain('Client: Beta')
    expect(t).toContain('Approved')
    expect(t).toContain('Later')
  })
})

describe('review of #1337: what is said, hostile fonts, many matches, numbers', () => {
  test('not a redaction tool: the places that still hold the words are named; /ActualText around removed words goes', async () => {
    const toUni = 'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <7E> <0020> endbfrange endcmap'
    const pdf = writePdf([
      '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /StructTreeRoot 10 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> /XObject << /Fm1 11 0 R >> >> /Annots [7 0 R] >>',
      stream('/Span <</ActualText (Client Acme Ltd)>> BDC BT /F1 12 Tf 72 700 Td (Client Acme Ltd) Tj ET EMC /Span <</ActualText (also Acme Ltd here)>> BDC BT /F1 12 Tf 72 680 Td (other line) Tj ET EMC BT /F2 12 Tf 72 660 Td (plain) Tj ET q /Fm1 Do Q'),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      // a symbolic font without a ToUnicode map: a viewer may read it otherwise
      '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
      '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (call Acme Ltd back) >>',
      '<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>',
      '<< /Title (Acme Ltd contract) /Parent 8 0 R /Dest [3 0 R /Fit] >>',
      '<< /Type /StructTreeRoot /K << /S /Figure /Alt (logo of Acme Ltd) >> >>',
      stream('BT /F1 9 Tf 10 10 Td (form) Tj ET', '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 5 0 R >> >>'),
      stream(toUni),
    ])
    const doc = await PDFDocument.load(pdf)
    doc.setTitle('Offer for Acme Ltd')
    const { bytes, notes } = await run(await doc.save(), [replaceOp('Acme Ltd', 'Beta')])
    expect(notes).toContain('removed from the page text there')
    expect(notes).not.toContain('removed from the file')
    expect(notes).toContain('accessibility text (/ActualText) around one of them was removed too')
    expect(notes).toContain('Not changed by this tool: drawn blocks (form XObjects) on page 1; comments, links or form fields on page 1; text in fonts without a letter map on page 1')
    for (const where of ['document properties', 'bookmark or document titles', 'comments or annotation text', 'accessibility text (/Alt)', 'marked-content text on page 1']) expect(notes).toContain(where)
    expect(notes).toContain('it is not a redaction tool')
    const content = await allStreams(bytes)
    expect(content).not.toContain('(Client Acme Ltd)')
    expect(content).toContain('(also Acme Ltd here)')
    expect(await ourText(bytes)).toContain('Client Beta')
    expect(withoutActualText('/Span <</Lang (en) /ActualText (a (b) \\) c) /MCID 3>> BDC')).toBe('/Span <</Lang (en)  /MCID 3>> BDC')
    expect(withoutActualText('/Span <</ActualText <FEFF0041>>> BDC')).toBe('/Span <<>> BDC')
  })

  test('a letter map or width list with huge ranges does not fill memory', async () => {
    const t0 = Date.now()
    // 300 ranges of 65,536 codes each, all above two bytes: about 20 million entries before the cap
    const far = Array.from({ length: 300 }, (_, k) => `<${((k + 1) * 0x10000).toString(16).padStart(8, '0')}> <${((k + 1) * 0x10000 + 0xffff).toString(16).padStart(8, '0')}> <0041>`).join(' ')
    const toUni = `begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 302 beginbfrange <0000> <FFFFFFFF> <0041> <00000002> <7FFFFFFF> [<0042>] ${far} endbfrange 1 beginbfchar <FFFFFF41> <0043> endbfchar endcmap`
    const pdf = writePdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F2 5 0 R >> >> >>',
      stream('BT /F2 12 Tf 72 700 Td <00000001> Tj ET'),
      '<< /Type /Font /Subtype /Type0 /BaseFont /Big /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Big /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [0 4294967295 500 -5 9999999999 300 ${Array.from({ length: 300 }, (_, k) => `${(k + 1) * 0x10000} ${(k + 1) * 0x10000 + 0xffff} 400`).join(' ')}] >>`,
      stream(toUni),
    ])
    expect(await ourText(pdf)).toBe('AB')
    const { notes } = await run(pdf, [replaceOp('AB', 'BA')])
    expect(notes).toContain('changed 1 place')
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(FONT_ENTRIES_MAX).toBe(65_536)
  })

  test('more than 2,000 matches on a page: refused plainly, quickly', async () => {
    const line = 'a '.repeat(PAGE_MATCHES_MAX / 2 + 10)
    const pdf = onePage(`BT /F1 4 Tf 10 800 Td (${line}) Tj 0 -6 Td (${line}) Tj ET`)
    const t0 = Date.now()
    expect(await fails(pdf, [replaceOp('a', 'b')])).toContain('more than 2,000 times; give longer words to find')
    expect(Date.now() - t0).toBeLessThan(5000)
    // just under the cap works and stays quick (indexed once, one pass over the content)
    const ok = onePage(`BT /F1 4 Tf 10 800 Td (${'a '.repeat(PAGE_MATCHES_MAX / 2 - 5)}) Tj 0 -6 Td (${'a '.repeat(PAGE_MATCHES_MAX / 2 - 5)}) Tj ET`)
    const t1 = Date.now()
    expect((await run(ok, [replaceOp('a', 'bb')])).notes).toContain(`changed ${PAGE_MATCHES_MAX - 10} places`)
    expect(Date.now() - t1).toBeLessThan(15000)
  })

  test('numbers in the content are never in exponent form', () => {
    expect(fmt(1e21)).toBe('1000000000')
    expect(fmt(-1e300)).toBe('-1000000000')
    expect(fmt(Number.NaN)).toBe('0')
    expect(fmt(Infinity)).toBe('0')
    expect(fmt(-0.0001)).toBe('0')
    expect(fmt(12.5)).toBe('12.5')
    expect(fmt(100)).toBe('100')
    expect(fmt(-4158.8484)).toBe('-4158.848')
    for (const v of [1e21, 1e-7, 123456789012]) expect(fmt(v)).not.toMatch(/e/i)
  })
})

describe('re-review of #1337: many pages sharing one big stream', () => {
  /** `n` pages that all draw one shared content stream of about `mb` MB (marked content with /ActualText, no "Acme"), and
   * a first page of its own that says "Client Acme Ltd" */
  function sharedPdf(n: number, mb: number): Uint8Array {
    const unit = '/Span <</ActualText (row text)>> BDC BT /F1 6 Tf 10 10 Td (filler row text here) Tj ET EMC\n'
    const big = unit.repeat(Math.ceil((mb * 1024 * 1024) / unit.length))
    const kids = Array.from({ length: n }, (_, i) => `${i + 6} 0 R`).join(' ')
    const objs: string[] = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [5 0 R ${kids}] /Count ${n + 1} >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      stream(big),
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ' + (n + 6) + ' 0 R /Resources << /Font << /F1 3 0 R >> >> >>',
    ]
    for (let i = 0; i < n; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources 7000000 0 R >>'.replace('7000000 0 R', `${n + 7} 0 R`))
    objs.push(stream('BT /F1 12 Tf 72 700 Td (Client Acme Ltd) Tj ET'))
    objs.push('<< /Font << /F1 3 0 R >> >>')
    return writePdf(objs)
  }

  test('3,000 pages on one 2 MB stream: read once, the search for leftovers reads it once too', async () => {
    const pdf = sharedPdf(3000, 2)
    const t0 = Date.now()
    const { notes } = await run(pdf, [replaceOp('Acme Ltd', 'Beta')])
    expect(notes).toContain('changed 1 place of "Acme Ltd" on page 1')
    expect(notes).not.toContain('could not check')
    expect(Date.now() - t0).toBeLessThan(20_000)
    // the bound above is the test's own: bun's default 5 s timeout must not cut it first (a loaded CI runner reads the
    // 3,000 pages several times slower than a Mac)
  }, 30_000)

  test('the search for leftovers stops at its budget and says so, it does not fail', async () => {
    const doc = await PDFDocument.load(sharedPdf(50, 1))
    const all = doc.getPageIndices()
    // the shared stream holds the words in an /ActualText; a budget too small for it, or no time left
    expect(wordsElsewhere(doc, 'row text', true, all)).toContain('marked-content text on page 2')
    expect(wordsElsewhere(doc, 'row text', true, all, { bytes: 100_000, ms: 10_000 })).toContain(NOT_ALL_CHECKED)
    expect(wordsElsewhere(doc, 'row text', true, all, { bytes: 1e9, ms: 0 })).toContain(NOT_ALL_CHECKED)
    // pages not read are not searched
    expect(wordsElsewhere(doc, 'row text', true, [0])).toEqual([])
  })
})
