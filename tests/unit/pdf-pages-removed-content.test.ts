// A page taken out of a PDF (edit_pdf remove/keep, split_pdf, merge_pdfs with a page list) takes its content out of the
// saved file too: its picture, form, font file, pattern, soft mask, thumbnail, notes, form-field value and appearance,
// and the document's outline, named destinations and attachments (TC-3793: a 480 KB picture of a removed page stayed in
// the file when a kept page had an odd /Contents). The worker function is called directly; the tool path is in
// tests/unit/c-edit-pdf.test.ts. Fixtures are written here.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, type PDFObject } from 'pdf-lib'
import { decodePagesResult, encodePagesRequest, pdfPagesRequest, type PagesJob } from '../../server/src/files/pdf-pages'
import { makePdf, writePdf } from '../lib/pdf'

type Part = string | Uint8Array
/** objects by name; `@name` in a body is that object's reference */
function build(defs: Record<string, Part | Part[]>): Uint8Array {
  const names = Object.keys(defs)
  const ref = (s: string) => s.replace(/@([A-Za-z0-9_]+)/g, (_, n: string) => {
    if (n === 'missing') return '999 0 R'
    const i = names.indexOf(n)
    if (i < 0) throw new Error(`no object ${n}`)
    return `${i + 1} 0 R`
  })
  return writePdf(names.map((n) => { const d = defs[n]!; return typeof d === 'string' ? ref(d) : d instanceof Uint8Array ? [d] : d.map((p) => (typeof p === 'string' ? ref(p) : p)) }))
}
const stream = (dict: string, body: Part): Part[] => [`<< ${dict} /Length ${body.length} >>\nstream\n`, body, '\nendstream']

/** 60 000 bytes that do not compress, with a marker in the middle: the picture of page 2 */
const PIXELS = (() => {
  const b = new Uint8Array(200 * 300)
  let x = 12345
  for (let i = 0; i < b.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x >> 16 }
  b.set(new TextEncoder().encode('IMG-SECRET-PIXELS'), 30000)
  return b
})()

/**
 * Three pages that share one /Resources on the page tree. Page 2 is the one to take out; everything that is only
 * its own says SECRET. Pages 1 and 3 say PUBLIC. `first`: page 1's /Contents.
 */
function secretPdf(first: 'stream' | 'dangling' | 'null' | 'broken' = 'stream'): Uint8Array {
  const contents = { stream: '@c1', dangling: '[@missing]', null: 'null', broken: '@cBroken' }[first]
  return build({
    catalog: '<< /Type /Catalog /Pages @pages /Outlines @outlines /AcroForm << /Fields [@form] >> /Names << /Dests << /Names [(secret) [@p2 /Fit]] >> /EmbeddedFiles << /Names [(a.txt) << /Type /Filespec /F (a.txt) /EF << /F @attach >> >>] >> >> >>',
    pages: '<< /Type /Pages /Kids [@p1 @p2 @p3] /Count 3 /Resources @res >>',
    p1: `<< /Type /Page /Parent @pages /MediaBox [0 0 595 842] /Contents ${contents} /Annots [@linkDest @linkAction @w1] /B [@bead1] >>`,
    p2: '<< /Type /Page /Parent @pages /MediaBox [0 0 595 842] /Contents @c2 /Annots [@w2 @w3 @note @popup] /Thumb @thumb /B [@bead2] >>',
    p3: '<< /Type /Page /Parent @pages /MediaBox [0 0 595 842] /Contents @c3 /Annots [@linkHome] >>',
    res: '<< /XObject << /Im1 @image /Fm1 @formPublic /Fm2 @formSecret >> /Font << /F1 @helv /F2 @fontSecret >> /ExtGState << /GS2 @gs >> /Pattern << /P2 @pattern >> >>',
    c1: stream('', 'BT /F1 12 Tf 72 780 Td (PUBLIC-ONE) Tj ET q /Fm1 Do Q'),
    cBroken: stream('/Filter /FlateDecode', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])),
    c2: stream('', '/GS2 gs /Pattern cs /P2 scn 0 0 50 50 re f q 200 0 0 300 72 400 cm /Im1 Do Q /Fm2 Do BT /F2 12 Tf 72 780 Td (PAGE-SECRET) Tj ET'),
    c3: stream('', 'BT /F1 12 Tf 72 780 Td (PUBLIC-THREE) Tj ET'),
    image: stream('/Type /XObject /Subtype /Image /Width 200 /Height 300 /ColorSpace /DeviceGray /BitsPerComponent 8', PIXELS),
    // a form without /Resources draws with the page's (its font is the page's /F1)
    formPublic: stream('/Type /XObject /Subtype /Form /BBox [0 0 595 842]', 'BT /F1 12 Tf 72 700 Td (PUBLIC-FORM) Tj ET'),
    // forms, patterns and soft masks that point at the shared list, as some generators write them
    formSecret: stream('/Type /XObject /Subtype /Form /BBox [0 0 300 50] /Resources @res', 'BT /F1 12 Tf 10 10 Td (FORM-SECRET) Tj ET'),
    pattern: stream('/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources @res', '0 0 5 5 re f % PATTERN-SECRET'),
    gs: '<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G @mask >> >>',
    mask: stream('/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources @res', '0 0 5 5 re f % SMASK-SECRET'),
    helv: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    fontSecret: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /FontDescriptor << /Type /FontDescriptor /FontName /Courier /FontFile @fontFile >> >>',
    fontFile: stream('', 'FONTFILE-SECRET'),
    linkDest: '<< /Type /Annot /Subtype /Link /Rect [72 760 300 790] /Dest [@p2 /Fit] >>',
    linkAction: '<< /Type /Annot /Subtype /Link /Rect [72 720 300 750] /A << /S /GoTo /D [@p2 /Fit] >> >>',
    linkHome: '<< /Type /Annot /Subtype /Link /Rect [72 760 300 790] /Dest [@p1 /Fit] >>',
    form: '<< /T (form) /Kids [@w1 @w2 @group] >>',
    w1: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (PUBLIC-FIELD) /Parent @form /P @p1 /Rect [72 600 300 620] >>',
    w2: '<< /Type /Annot /Subtype /Widget /FT /Tx /T (salary) /V (FIELD-SECRET) /Parent @form /P @p2 /Rect [72 600 300 620] /AP << /N @ap >> >>',
    // a field whose only part is on page 2 (no /P on the part: only the page's /Annots says where it is)
    group: '<< /T (group) /FT /Tx /V (GROUP-SECRET) /Parent @form /Kids [@w3] >>',
    w3: '<< /Type /Annot /Subtype /Widget /Parent @group /Rect [72 500 300 520] /MK << /CA (WIDGET-SECRET) >> >>',
    ap: stream('/Type /XObject /Subtype /Form /BBox [0 0 228 20] /Resources @res', 'BT /F1 12 Tf (AP-SECRET) Tj ET'),
    note: '<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (NOTE-SECRET) /P @p2 /Popup @popup >>',
    popup: '<< /Type /Annot /Subtype /Popup /Rect [40 10 200 100] /Parent @note /T (POPUP-SECRET) >>',
    thumb: stream('/Width 1 /Height 12 /ColorSpace /DeviceGray /BitsPerComponent 8', 'THUMB-SECRET'),
    thread: '<< /Type /Thread /F @bead1 /I << /Title (THREAD-SECRET) >> >>',
    bead1: '<< /Type /Bead /T @thread /N @bead2 /V @bead2 /P @p1 /R [0 0 100 100] >>',
    bead2: '<< /Type /Bead /T @thread /N @bead1 /V @bead1 /P @p2 /R [0 0 100 100] >>',
    outlines: '<< /Type /Outlines /First @item /Last @item /Count 1 >>',
    item: '<< /Title (OUTLINE-SECRET) /Parent @outlines /Dest [@p2 /Fit] >>',
    attach: stream('/Type /EmbeddedFile', 'ATTACH-SECRET'),
  })
}

async function run(job: PagesJob, parts: Uint8Array[]): Promise<Uint8Array[]> {
  return decodePagesResult(await pdfPagesRequest(encodePagesRequest(job, parts.map((bytes, i) => ({ name: `file-${i}.pdf`, bytes }))))).files
}

/** everything a reader of the file could get at: every object as written, and every stream decoded */
async function dump(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  let all = Buffer.from(bytes).toString('latin1')
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    all += `\n${ref.toString()} ${o instanceof PDFStream ? o.dict.toString() : o.toString()}\n`
    if (o instanceof PDFRawStream) { try { all += Buffer.from(decodePDFRawStream(o).decode()).toString('latin1') } catch { all += Buffer.from(o.contents).toString('latin1') } }
  }
  return all
}

/** the objects of the file, and those its trailer reaches */
async function objects(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const ctx = doc.context
  const live = new Set<PDFObject>()
  const todo: (PDFObject | undefined)[] = Object.values(ctx.trailerInfo)
  while (todo.length) {
    const o = todo.pop()
    if (!o || live.has(o)) continue
    live.add(o)
    if (o instanceof PDFRef) todo.push(ctx.lookup(o))
    else if (o instanceof PDFArray) todo.push(...o.asArray())
    else if (o instanceof PDFDict) todo.push(...o.values())
    else if (o instanceof PDFStream) todo.push(...o.dict.values())
  }
  const all = ctx.enumerateIndirectObjects()
  const isPage = (o: PDFObject) => o instanceof PDFDict && o.get(PDFName.of('Type')) === PDFName.of('Page')
  return { doc, total: all.length, unreached: all.filter(([ref]) => !live.has(ref)).length, pageObjects: all.filter(([, o]) => isPage(o)).length }
}

const pdftotext = Bun.which('pdftotext')
function shownText(bytes: Uint8Array): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-removed-')), 'out.pdf')
  fs.writeFileSync(f, bytes)
  try { return Bun.spawnSync([pdftotext!, f, '-']).stdout.toString() } finally { fs.rmSync(path.dirname(f), { recursive: true, force: true }) }
}

/** each way of leaving page 2 out, as [name, the job, the parts] */
const ways = (src: Uint8Array): [string, PagesJob, Uint8Array[]][] => [
  ['edit_pdf remove_pages', { kind: 'edit', ops: [{ remove_pages: '2' }], font: null }, [src]],
  ['edit_pdf keep_pages', { kind: 'edit', ops: [{ keep_pages: '1,3' }], font: null }, [src]],
  ['edit_pdf remove then reorder and rotate', { kind: 'edit', ops: [{ remove_pages: '2' }, { reorder_pages: '2,1' }, { rotate_pages: { degrees: 90 } }, { reorder_pages: '2,1' }], font: null }, [src]],
  ['split_pdf', { kind: 'split', parts: ['1,3'] }, [src]],
  ['merge_pdfs with a page list', { kind: 'merge', files: [{ part: 0, pages: '1,3' }] }, [src]],
]

describe('a page taken out of a PDF takes its content out of the file', () => {
  test('the fixture holds page 2\'s content, and it is large', async () => {
    const src = secretPdf()
    expect(src.length).toBeGreaterThan(60_000)
    const all = await dump(src)
    for (const s of ['IMG-SECRET-PIXELS', 'PAGE-SECRET', 'FORM-SECRET', 'FONTFILE-SECRET', 'PATTERN-SECRET', 'SMASK-SECRET', 'FIELD-SECRET', 'GROUP-SECRET', 'WIDGET-SECRET', 'AP-SECRET', 'NOTE-SECRET', 'POPUP-SECRET', 'THUMB-SECRET', 'THREAD-SECRET', 'OUTLINE-SECRET', 'ATTACH-SECRET']) expect(all, s).toContain(s)
    expect((await PDFDocument.load(src)).getPageCount()).toBe(3)
  })

  for (const first of ['stream', 'dangling', 'null'] as const) {
    test(`page 2 left out, page 1's /Contents: ${first} — nothing of page 2 in the saved file (remove, keep, split, merge)`, async () => {
      const src = secretPdf(first)
      for (const [name, job, parts] of ways(src)) {
        const [out] = await run(job, parts)
        const all = await dump(out!)
        // the picture's bytes, and every other thing only page 2 had
        expect(Buffer.from(out!).includes('IMG-SECRET-PIXELS'), name).toBe(false)
        expect(all.match(/[A-Z]+-SECRET/g) ?? [], name).toEqual([])
        expect(out!.length, name).toBeLessThan(4000)
        // what the kept pages have is still there
        expect(all, name).toContain('PUBLIC-THREE')
        expect(all, name).toContain('PUBLIC-FIELD')
        if (first === 'stream') { expect(all, name).toContain('PUBLIC-ONE'); expect(all, name).toContain('PUBLIC-FORM') }
        // only the two kept pages are page objects, and no object is written that the document does not reach
        const o = await objects(out!)
        expect(o.doc.getPageCount(), name).toBe(2)
        expect(o.pageObjects, name).toBe(2)
        expect(o.unreached, name).toBe(0)
        // the links to page 2 are gone from page 1 (its form-field part stays); page 3's link still leads to page 1
        const [p1, p3] = o.doc.getPages()
        const annots = (p: typeof p1) => (p!.node.Annots()?.asArray() ?? []).map((a) => o.doc.context.lookup(a, PDFDict))
        expect(annots(p1).map((a) => a.get(PDFName.of('Subtype'))?.toString()), name).toEqual(['/Widget'])
        const home = annots(p3)
        expect(home.length, name).toBe(1)
        expect(home[0]!.lookup(PDFName.of('Dest'), PDFArray).get(0), name).toBe(p1!.ref)
        expect(p1!.node.has(PDFName.of('B')), name).toBe(false)
        // and the kept pages still draw: page 1's form (which draws with the page's own font list) and page 3's text
        if (pdftotext && first === 'stream') {
          const t = shownText(out!)
          for (const s of ['PUBLIC-ONE', 'PUBLIC-FORM', 'PUBLIC-THREE']) expect(t, `${name}: ${s}`).toContain(s)
        }
      }
    })
  }

  test('split into parts: each part holds only its own pages\' content', async () => {
    const [a, b, c] = await run({ kind: 'split', parts: ['1', '2', '3'] }, [secretPdf()])
    for (const part of [a!, c!]) {
      expect((await dump(part)).match(/[A-Z]+-SECRET/g) ?? []).toEqual([])
      expect(part.length).toBeLessThan(4000)
      expect((await objects(part)).unreached).toBe(0)
    }
    // page 2's part keeps what page 2 draws and carries (not the document's outline or attachment)
    const two = await dump(b!)
    for (const s of ['IMG-SECRET-PIXELS', 'PAGE-SECRET', 'FORM-SECRET', 'FIELD-SECRET', 'NOTE-SECRET']) expect(two, s).toContain(s)
    for (const s of ['PUBLIC-ONE', 'PUBLIC-THREE', 'PUBLIC-FORM', 'OUTLINE-SECRET', 'ATTACH-SECRET']) expect(two, s).not.toContain(s)
    expect((await objects(b!)).pageObjects).toBe(1)
  })

  test('merge: a page list of one file leaves the other pages\' content out; whole files keep theirs', async () => {
    const [out] = await run({ kind: 'merge', files: [{ part: 0, pages: '3' }, { part: 1 }] }, [secretPdf(), secretPdf('dangling')])
    const o = await objects(out!)
    expect(o.doc.getPageCount()).toBe(4)
    expect(o.pageObjects).toBe(4)
    expect(o.unreached).toBe(0)
    const all = await dump(out!)
    // the second file is whole: its page 2 and its picture are in, once
    expect(all).toContain('PAGE-SECRET')
    expect(all.split('IMG-SECRET-PIXELS').length - 1).toBe(2) // the raw bytes and the decoded stream of one picture
    expect(all).not.toContain('OUTLINE-SECRET')
    expect(all).not.toContain('ATTACH-SECRET')
  })

  test('edit_pdf insert_pdf with a page list: the other pages of the inserted file stay out', async () => {
    const [out] = await run({ kind: 'edit', ops: [{ insert_pdf: { file: 1, pages: '1,3', after: 'last' } }], font: null }, [makePdf(['MAIN-PAGE']), secretPdf()])
    const all = await dump(out!)
    expect(all.match(/[A-Z]+-SECRET/g) ?? []).toEqual([])
    expect(out!.length).toBeLessThan(5000)
    for (const s of ['MAIN-PAGE', 'PUBLIC-ONE', 'PUBLIC-FORM', 'PUBLIC-THREE']) expect(all, s).toContain(s)
    const o = await objects(out!)
    expect([o.doc.getPageCount(), o.pageObjects, o.unreached]).toEqual([3, 3, 0])
    // the whole file inserted keeps its page 2
    const [whole] = await run({ kind: 'edit', ops: [{ insert_pdf: { file: 1, after: 0 } }], font: null }, [makePdf(['MAIN-PAGE']), secretPdf()])
    expect(await dump(whole!)).toContain('PAGE-SECRET')
    expect((await PDFDocument.load(whole!)).getPageCount()).toBe(4)
  })

  test('the saved file is one full rewrite: one %%EOF, no earlier version underneath', async () => {
    const src = secretPdf()
    for (const [name, job, parts] of ways(src)) {
      const [out] = await run(job, parts)
      const raw = Buffer.from(out!).toString('latin1')
      expect(raw.split('%%EOF').length - 1, name).toBe(1)
      expect(raw.split('startxref').length - 1, name).toBe(1)
    }
  })

  test('a kept page whose drawing cannot be decoded: taking pages out is refused; an edit that leaves no page out still works', async () => {
    const src = secretPdf('broken')
    for (const [name, job, parts] of ways(src)) {
      const err = await run(job, parts).then(() => null, (e: Error) => e)
      expect(err?.message ?? '', name).toContain('cannot be taken out of it safely; nothing was saved')
    }
    const [same] = await run({ kind: 'edit', ops: [{ reorder_pages: '3,2,1' }], font: null }, [src])
    expect((await PDFDocument.load(same!)).getPageCount()).toBe(3)
    const [merged] = await run({ kind: 'merge', files: [{ part: 0 }] }, [src])
    expect((await PDFDocument.load(merged!)).getPageCount()).toBe(3)
  })
})
