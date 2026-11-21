// edit_pdf, merge_pdfs and split_pdf through the tool path (the MCP handler, as an engine calls it): each operation,
// page lists ("1,3-5,last"), merge order, rotation values, text that is not Latin, the results as new files next to the
// originals (never over them unless replace: true after a read), locked and broken PDFs refused plainly, and the folder
// rules (a read-only folder, someone else's file). A shared chat's read card for them:
// tests/unit/b-shared-chat-pdf.test.ts.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { decodePDFRawStream, PDFDocument, PDFRawStream } from 'pdf-lib'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { makePagedPdf, writePdf } from '../lib/pdf'
import { pngRgbaOf } from '../lib/images'
import { namedPaths, ROOM_FILE_TOOLS, SHARED_TOOLS, WRITE_TARGET_ARGS } from '../../server/src/rooms/ai-tools'
import { parsePages, rotationOf, toUser } from '../../server/src/files/pdf-pages'
import { PDF_WORDS, textFontFile } from '../../server/src/tools/pdf-tools'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { ToolError } from '../../server/src/policy/errors'

setDefaultTimeout(60_000)

let A: CApp
beforeAll(async () => { A = await makeCApp('c-edit-pdf') })
afterAll(async () => { await A.close() })

const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const put = (rel: string, bytes: Uint8Array | string) => { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), bytes) }
let rpcId = 0
function turn(user: Person) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, A.turn(user, A.chat(user))))
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }
}
const word = (w: keyof typeof PDF_WORDS) => PDF_WORDS[w][teamDefaultLocale(A.ctx.db)]
/** A PDF whose page i says "PAGE-<tag>-<i>" (1-based), so the order of pages can be read back. */
const pdf = (tag: string, n: number) => makePagedPdf(Array.from({ length: n }, (_, i) => [`PAGE-${tag}-${i + 1}`]))
const pdftotext = Bun.which('pdftotext')
/** each page's marker, in order (pdftotext when there is one; else the page count as "?") */
async function pages(rel: string): Promise<string[]> {
  const doc = await PDFDocument.load(fs.readFileSync(file(rel)))
  const n = doc.getPageCount()
  if (!pdftotext) return Array.from({ length: n }, () => '?')
  const out: string[] = []
  for (let p = 1; p <= n; p++) {
    const r = Bun.spawnSync([pdftotext, '-f', String(p), '-l', String(p), file(rel), '-'])
    out.push(r.stdout.toString().match(/PAGE-[A-Z]+-\d+/)?.[0] ?? '')
  }
  return out
}
const rotations = async (rel: string) => (await PDFDocument.load(fs.readFileSync(file(rel)))).getPages().map((p) => p.getRotation().angle)
/** a page's text with every space and line break taken out (pdftotext breaks drawn lines its own way) */
const text = (rel: string, page: number) => (pdftotext ? Bun.spawnSync([pdftotext, '-f', String(page), '-l', String(page), file(rel), '-']).stdout.toString().replace(/\s+/g, '') : '')
const D = 'groups/marketing/pdfs'
/** every stream of the file, decoded */
const streams = async (rel: string) => {
  const doc = await PDFDocument.load(fs.readFileSync(file(rel)))
  let all = ''
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) { try { all += Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1') } catch { all += Buffer.from(obj.contents).toString('latin1') } }
  }
  return all
}
const pdftoppm = Bun.which('pdftoppm')
/** how many pixels of a page drawn at 36 dpi are not white (a light watermark counts) */
function dark(rel: string, page: number): number {
  const b = Buffer.from(Bun.spawnSync([pdftoppm!, '-r', '36', '-f', String(page), '-l', String(page), '-singlefile', '-gray', file(rel)]).stdout)
  const head = b.subarray(0, 40).toString('latin1').match(/^P5\s+\d+\s+\d+\s+\d+\s/)!
  let n = 0
  for (let i = head[0].length; i < b.length; i++) if (b[i]! < 245) n++
  return n
}

describe('page lists and rotation values', () => {
  test('"1,3-5,last", "2-last", "all", spaces and dashes; in the order written, each once', () => {
    expect(parsePages('1,3-5,last', 8)).toEqual([1, 3, 4, 5, 8])
    expect(parsePages(' 2 - last ', 4)).toEqual([2, 3, 4])
    expect(parsePages('all', 3)).toEqual([1, 2, 3])
    expect(parsePages('last', 6)).toEqual([6])
    expect(parsePages('3,1,3,2–2', 5)).toEqual([3, 1, 2])
  })
  test('plain refusals: past the end, zero, backwards, words', () => {
    const msg = (s: string, n: number) => { try { parsePages(s, n); return '' } catch (e) { expect(e).toBeInstanceOf(ToolError); return (e as Error).message } }
    expect(msg('9', 5)).toBe('there is no page 9: the PDF has 5 pages')
    expect(msg('0', 5)).toBe('pages start at 1')
    expect(msg('5-2', 5)).toContain('goes backwards')
    expect(msg('first', 5)).toContain('"first" is not a page')
    expect(msg(' , ', 5)).toContain('no pages given')
  })
  test('rotation: 90, 180, 270 and -90 (= 270); nothing else', () => {
    expect([90, 180, 270, -90, 450].map(rotationOf)).toEqual([90, 180, 270, 270, 90])
    for (const d of [0, 45, 360, -180 + 1]) expect(() => rotationOf(d)).toThrow(ToolError)
  })
  test('a point of the page as shown, in PDF space, for each turn', () => {
    const box = { x: 0, y: 0, width: 600, height: 800 }
    expect(toUser(box, 0, 10, 20)).toEqual({ x: 10, y: 780 })
    expect(toUser(box, 90, 10, 20)).toEqual({ x: 20, y: 10 })
    expect(toUser(box, 180, 10, 20)).toEqual({ x: 590, y: 20 })
    expect(toUser(box, 270, 10, 20)).toEqual({ x: 580, y: 790 })
  })
})

describe('edit_pdf: each operation, as a new file next to the original', () => {
  test('remove pages 2 and 4; the original unchanged', async () => {
    put(`${D}/quote.pdf`, pdf('Q', 5))
    const before = fs.readFileSync(file(`${D}/quote.pdf`))
    const r = await turn('alice')('edit_pdf', { file_path: `${D}/quote.pdf`, operations: [{ remove_pages: '2,4' }] })
    expect(r.isError, r.text).toBe(false)
    const out = `${D}/quote (${word('edited')}).pdf`
    expect(r.text).toContain(`Saved ${out} (3 pages).`)
    expect(r.text).toContain(`${D}/quote.pdf is unchanged.`)
    expect(fs.readFileSync(file(`${D}/quote.pdf`)).equals(before)).toBe(true)
    if (pdftotext) expect(await pages(out)).toEqual(['PAGE-Q-1', 'PAGE-Q-3', 'PAGE-Q-5'])
    const ev = A.ctx.db.query('SELECT action, detail FROM file_events WHERE path = ? ORDER BY id DESC LIMIT 1').get(out) as { action: string; detail: string }
    expect([ev.action, JSON.parse(ev.detail).tool]).toEqual(['create', 'edit_pdf'])
  })

  test('removed pages are gone from the file, not only from the page list (remove, keep, reorder)', async () => {
    put(`${D}/salary.pdf`, makePagedPdf([['PUBLIC-ONE'], ['SECRETSALARY'], ['PUBLIC-THREE']]))
    const call = turn('alice')
    for (const [i, ops] of [[{ remove_pages: '2' }], [{ keep_pages: '1,3' }], [{ remove_pages: '2' }, { reorder_pages: '2,1' }]].entries()) {
      const out = `${D}/salary-out-${i}.pdf`
      const r = await call('edit_pdf', { file_path: `${D}/salary.pdf`, operations: ops, output: out })
      expect(r.isError, r.text).toBe(false)
      const s = await streams(out)
      expect(s).toContain('PUBLIC-ONE')
      expect(s, JSON.stringify(ops)).not.toContain('SECRETSALARY')
    }
  })

  test('pictures of a removed page are gone too when every page shares one resource list (remove, split, merge)', async () => {
    // a /Resources on the page tree, as scanners write it: three form XObjects, each drawn by one page only
    const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /Resources << /XObject << /X1 6 0 R /X2 7 0 R /X3 8 0 R >> /Font << /F1 9 0 R >> >> >>']
    for (let i = 1; i <= 3; i++) objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${9 + i} 0 R >>`)
    for (let i = 1; i <= 3; i++) { const s = `BT /F1 12 Tf 10 10 Td (XOBJ-SECRET-${i}) Tj ET`; objs.push(`<< /Type /XObject /Subtype /Form /BBox [0 0 300 50] /Resources << /Font << /F1 9 0 R >> >> /Length ${s.length} >>\nstream\n${s}\nendstream`) }
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    for (let i = 1; i <= 3; i++) { const s = `q 1 0 0 1 72 700 cm /X${i} Do Q BT /F1 12 Tf 72 780 Td (PAGE-S-${i}) Tj ET`; objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`) }
    put(`${D}/shared-res.pdf`, writePdf(objs))
    const call = turn('alice')
    const runs: [string, Record<string, unknown>, string][] = [
      ['edit_pdf', { file_path: `${D}/shared-res.pdf`, operations: [{ remove_pages: '2' }], output: `${D}/sr-remove.pdf` }, `${D}/sr-remove.pdf`],
      ['split_pdf', { file_path: `${D}/shared-res.pdf`, parts: ['1'], output_folder: `${D}/sr-split` }, `${D}/sr-split/shared-res (${word('part')} 1).pdf`],
      ['merge_pdfs', { files: [{ path: `${D}/shared-res.pdf`, pages: '1' }, `${D}/quote.pdf`], output: `${D}/sr-merge.pdf` }, `${D}/sr-merge.pdf`],
    ]
    for (const [tool, args, out] of runs) {
      const r = await call(tool, args)
      expect(r.isError, r.text).toBe(false)
      const s = await streams(out)
      expect(s, tool).toContain('XOBJ-SECRET-1')
      expect(s, tool).not.toContain('XOBJ-SECRET-2')
      if (tool === 'edit_pdf') expect(s).toContain('XOBJ-SECRET-3')
      else expect(s, tool).not.toContain('XOBJ-SECRET-3')
      // still drawn: the picture of page 1 is on page 1
      if (pdftotext) expect(text(out, 1)).toContain('XOBJ-SECRET-1')
    }
    // a blank kept page (no /Contents, as scanned separator pages are) keeps none of the shared pictures
    put(`${D}/shared-blank.pdf`, writePdf(objs.map((o, i) => (i === 2 ? '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>' : o))))
    const blank = await call('edit_pdf', { file_path: `${D}/shared-blank.pdf`, operations: [{ keep_pages: '1' }], output: `${D}/sr-blank.pdf` })
    expect(blank.isError, blank.text).toBe(false)
    expect(await streams(`${D}/sr-blank.pdf`)).not.toContain('XOBJ-SECRET')
    // the same for a kept page whose /Contents points at nothing, or is null (TC-3793: such a page kept the whole list);
    // more in tests/unit/pdf-pages-removed-content.test.ts
    for (const [k, contents] of ['[99 0 R]', 'null'].entries()) {
      put(`${D}/shared-odd-${k}.pdf`, writePdf(objs.map((o, i) => (i === 2 ? `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contents} >>` : o))))
      const odd = await call('edit_pdf', { file_path: `${D}/shared-odd-${k}.pdf`, operations: [{ remove_pages: '2' }], output: `${D}/sr-odd-${k}.pdf` })
      expect(odd.isError, odd.text).toBe(false)
      const s = await streams(`${D}/sr-odd-${k}.pdf`)
      expect(s, contents).toContain('XOBJ-SECRET-3')
      expect(s, contents).not.toContain('XOBJ-SECRET-2')
      expect(s, contents).not.toContain('XOBJ-SECRET-1')
    }
  })

  test('keep (extract), reorder, rotate, insert: in order, each on the pages as they are then', async () => {
    put(`${D}/doc.pdf`, pdf('D', 4))
    put(`${D}/annex.pdf`, pdf('X', 3))
    const call = turn('alice')
    const keep = await call('edit_pdf', { file_path: `${D}/doc.pdf`, operations: [{ keep_pages: '4,1-2' }], output: `${D}/extract.pdf` })
    expect(keep.isError, keep.text).toBe(false)
    if (pdftotext) expect(await pages(`${D}/extract.pdf`)).toEqual(['PAGE-D-4', 'PAGE-D-1', 'PAGE-D-2'])
    const re = await call('edit_pdf', { file_path: `${D}/doc.pdf`, operations: [{ reorder_pages: '3,1,4,2' }], output: `${D}/reordered` })
    expect(re.isError, re.text).toBe(false)
    expect(re.text).toContain(`Saved ${D}/reordered.pdf (4 pages)`)
    if (pdftotext) expect(await pages(`${D}/reordered.pdf`)).toEqual(['PAGE-D-3', 'PAGE-D-1', 'PAGE-D-4', 'PAGE-D-2'])
    const rot = await call('edit_pdf', { file_path: `${D}/doc.pdf`, operations: [{ rotate_pages: { pages: '1,3', degrees: 90 } }, { rotate_pages: { pages: '3-last', degrees: -90 } }, { rotate_pages: { pages: '2', degrees: 180 } }], output: `${D}/rotated.pdf` })
    expect(rot.isError, rot.text).toBe(false)
    expect(await rotations(`${D}/rotated.pdf`)).toEqual([90, 180, 0, 270])
    // insert pages 2-3 of the annex after page 1, then remove the (new) page 2: operations see the pages as they are
    const ins = await call('edit_pdf', { file_path: `${D}/doc.pdf`, operations: [{ insert_pdf: { file: `${D}/annex.pdf`, pages: '2-last', after: 1 } }, { remove_pages: '2' }, { insert_pdf: { file: `${D}/annex.pdf`, pages: '1', after: 0 } }], output: `${D}/inserted.pdf` })
    expect(ins.isError, ins.text).toBe(false)
    expect(ins.text).toContain(`${D}/doc.pdf, ${D}/annex.pdf are unchanged.`)
    if (pdftotext) expect(await pages(`${D}/inserted.pdf`)).toEqual(['PAGE-X-1', 'PAGE-D-1', 'PAGE-X-3', 'PAGE-D-2', 'PAGE-D-3', 'PAGE-D-4'])
  })

  test('refused with the operation named: reorder that leaves pages out, removing every page, a page past the end, a bad rotation', async () => {
    const call = turn('alice')
    const bad = async (operations: unknown[]) => { const r = await call('edit_pdf', { file_path: `${D}/doc.pdf`, operations }); expect(r.isError).toBe(true); return r.text }
    expect(await bad([{ reorder_pages: '2,1' }])).toContain('operation 1: reorder_pages lists every page once (the PDF has 4)')
    expect(await bad([{ remove_pages: '1-2' }, { remove_pages: 'all' }])).toContain('operation 2: that would remove every page')
    expect(await bad([{ remove_pages: '7' }])).toContain('operation 1: there is no page 7: the PDF has 4 pages; nothing was saved')
    expect(await bad([{ rotate_pages: { degrees: 45 } }])).toContain('operation 1: pages turn by 90, 180 or 270 degrees (or -90), not 45')
    expect(fs.readdirSync(file(D)).filter((n) => n.startsWith('doc ('))).toEqual([])
  })

  test('stamp, a line of text, a watermark and page numbers; Korean text with the server\'s font', async () => {
    put(`${D}/report.pdf`, pdf('R', 3))
    put(`${D}/seal.png`, pngRgbaOf(60, 60, (x, y) => ((x - 29.5) ** 2 + (y - 29.5) ** 2 < 27 ** 2 ? [200, 0, 0, 255] : [0, 0, 0, 0])))
    const call = turn('alice')
    const r = await call('edit_pdf', { file_path: `${D}/report.pdf`, operations: [
      { stamp_image: { image: `${D}/seal.png`, page: 'last' } },
      { add_text: { text: 'Approved 2026-11-16', pages: '1', position: { x_mm: 20, y_mm: 20 } } },
      { watermark: { text: 'DRAFT' } },
      { page_numbers: { format: '{n} / {total}' } },
    ] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('read the new file with pages and as_images: true')
    const out = `${D}/report (${word('edited')}).pdf`
    if (pdftotext) {
      expect(text(out, 1)).toContain('Approved2026-11-16')
      expect(text(out, 1)).toContain('DRAFT')
      expect(text(out, 2)).toContain('2/3')
      expect(text(out, 3)).toContain('3/3')
    }
    // page numbers on pages 2-last starting at 1 ("the cover is not counted")
    const pn = await call('edit_pdf', { file_path: `${D}/report.pdf`, operations: [{ page_numbers: { pages: '2-last', format: 'Page {n} of {total}' } }], output: `${D}/numbered.pdf` })
    expect(pn.isError, pn.text).toBe(false)
    if (pdftotext) { expect(text(`${D}/numbered.pdf`, 2)).toContain('Page1of2'); expect(text(`${D}/numbered.pdf`, 1)).not.toContain('Page') }
    const noN = await call('edit_pdf', { file_path: `${D}/report.pdf`, operations: [{ page_numbers: { format: 'page' } }] })
    expect(noN.text).toContain('needs {n}')
    // Korean: the server's Pretendard (a repository checkout has it)
    if (textFontFile()) {
      const ko = await call('edit_pdf', { file_path: `${D}/report.pdf`, operations: [{ watermark: { text: '초안' } }, { add_text: { text: '2026년 11월 16일', position: 'bottom-right' } }], output: `${D}/ko.pdf` })
      expect(ko.isError, ko.text).toBe(false)
      if (pdftotext) expect(text(`${D}/ko.pdf`, 1)).toContain('2026년11월16일')
      // drawn, not only there for search: the page has many more dark pixels than the same page without the text
      if (pdftoppm) expect(dark(`${D}/ko.pdf`, 3)).toBeGreaterThan(dark(`${D}/report.pdf`, 3) + 300)
    }
  })

  test('replace_text: words inside the PDF changed, the old ones gone from the file; a scan said plainly (TC-4992)', async () => {
    put(`${D}/offer-acme.pdf`, makePagedPdf([['Quote for Acme Ltd', 'Total 1,200 EUR'], ['Acme Ltd thanks you']]))
    const call = turn('alice')
    const r = await call('edit_pdf', { file_path: `${D}/offer-acme.pdf`, operations: [{ replace_text: { find: 'Acme Ltd', replace: 'Northwind Traders' } }, { replace_text: { find: '1,200', replace: '950' } }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('changed 2 places of "Acme Ltd" on pages 1, 2')
    expect(r.text).toContain('the old words are removed from the page text there, not covered')
    expect(r.text).toContain('read the new file with pages and as_images: true')
    const out = `${D}/offer-acme (${word('edited')}).pdf`
    const all = await streams(out)
    expect(all).not.toContain('Acme')
    expect(all).not.toContain('1,200')
    if (pdftotext) { expect(text(out, 1)).toContain('QuoteforNorthwindTraders'); expect(text(out, 1)).toContain('Total950EUR'); expect(text(out, 2)).toContain('NorthwindTradersthanksyou') }
    // the original is as it was
    expect(await streams(`${D}/offer-acme.pdf`)).toContain('Acme Ltd')
    // a page that is only a picture: nothing saved, the reason in plain words
    const img = pngRgbaOf(20, 20, () => [120, 120, 120, 255])
    const doc = await PDFDocument.create()
    doc.addPage([595, 842]).drawImage(await doc.embedPng(img), { x: 0, y: 0, width: 595, height: 842 })
    put(`${D}/scan1.pdf`, await doc.save())
    const scan = await call('edit_pdf', { file_path: `${D}/scan1.pdf`, operations: [{ replace_text: { find: 'Acme', replace: 'Beta' } }] })
    expect(scan.isError).toBe(true)
    expect(scan.text).toContain('words that are part of a picture cannot be removed or changed here')
    expect(fs.existsSync(file(`${D}/scan1 (${word('edited')}).pdf`))).toBe(false)
  })

  test('a scanned PDF (pages that are only pictures) works the same', async () => {
    const img = pngRgbaOf(20, 20, () => [120, 120, 120, 255])
    const doc = await PDFDocument.create()
    const png = await doc.embedPng(img)
    for (let i = 0; i < 3; i++) doc.addPage([595, 842]).drawImage(png, { x: 0, y: 0, width: 595, height: 842 })
    put(`${D}/scan.pdf`, await doc.save())
    const r = await turn('alice')('edit_pdf', { file_path: `${D}/scan.pdf`, operations: [{ remove_pages: '2' }, { page_numbers: {} }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('(2 pages)')
  })

  test('replace the original only with replace: true after a read: a new version, the old one in its history', async () => {
    put(`${D}/replace-me.pdf`, pdf('P', 3))
    const call = turn('alice')
    const no = await call('edit_pdf', { file_path: `${D}/replace-me.pdf`, operations: [{ remove_pages: '3' }], replace: true })
    expect(no.isError).toBe(true)
    expect(no.text).toContain('read it in this chat first')
    const over = await call('edit_pdf', { file_path: `${D}/replace-me.pdf`, operations: [{ remove_pages: '3' }], output: `${D}/replace-me.pdf` })
    expect(over.isError).toBe(true)
    expect(over.text).toContain('use replace: true, only when the user asked for that')
    await call('read', { file_path: `${D}/replace-me.pdf`, pages: '1' })
    const yes = await call('edit_pdf', { file_path: `${D}/replace-me.pdf`, operations: [{ remove_pages: '3' }], replace: true })
    expect(yes.isError, yes.text).toBe(false)
    expect(yes.text).toContain('the previous version is in its file history')
    expect((await PDFDocument.load(fs.readFileSync(file(`${D}/replace-me.pdf`)))).getPageCount()).toBe(2)
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(`${D}/replace-me.pdf`) as { n: number }).n).toBe(1)
  })
})

describe('edit_pdf on a PDF the AI made in this turn', () => {
  test('changed in place without output (a new version); a file it only read gets a copy next to it', async () => {
    put(`${D}/fresh-src.pdf`, pdf('F', 3))
    const call = turn('alice')
    expect((await call('edit_pdf', { file_path: `${D}/fresh-src.pdf`, operations: [{ keep_pages: 'all' }], output: `${D}/fresh.pdf` })).isError).toBe(false)
    const r = await call('edit_pdf', { file_path: `${D}/fresh.pdf`, operations: [{ remove_pages: '3' }] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`This is a new version of ${D}/fresh.pdf; the previous version is in its file history.`)
    expect((await PDFDocument.load(fs.readFileSync(file(`${D}/fresh.pdf`)))).getPageCount()).toBe(2)
    expect(fs.readdirSync(file(D)).filter((n) => n.startsWith('fresh ('))).toEqual([])
    expect((A.ctx.db.query('SELECT COUNT(*) AS n FROM file_versions WHERE path = ?').get(`${D}/fresh.pdf`) as { n: number }).n).toBe(1)
    const ev = A.ctx.db.query('SELECT action FROM file_events WHERE path = ? ORDER BY id DESC LIMIT 1').get(`${D}/fresh.pdf`) as { action: string }
    expect(ev.action).toBe('update')
    // the person's file, only read: a copy, as before
    await call('read', { file_path: `${D}/fresh-src.pdf`, pages: '1' })
    const theirs = await call('edit_pdf', { file_path: `${D}/fresh-src.pdf`, operations: [{ remove_pages: '3' }] })
    expect(theirs.text).toContain(`Saved ${D}/fresh-src (${word('edited')}).pdf (2 pages).`)
    expect((await PDFDocument.load(fs.readFileSync(file(`${D}/fresh-src.pdf`)))).getPageCount()).toBe(3)
  })
})

describe('merge_pdfs and split_pdf', () => {
  test('merge in the order given, with pages of one; a free name next to the first', async () => {
    put(`${D}/quote-a.pdf`, pdf('A', 2))
    put(`${D}/quote-b.pdf`, pdf('B', 3))
    const call = turn('alice')
    const r = await call('merge_pdfs', { files: [`${D}/quote-b.pdf`, { path: `${D}/quote-a.pdf`, pages: '2' }, `${D}/quote-a.pdf`] })
    expect(r.isError, r.text).toBe(false)
    const out = `${D}/quote-b (${word('merged')}).pdf`
    expect(r.text).toContain(`Saved ${out} (6 pages).`)
    if (pdftotext) expect(await pages(out)).toEqual(['PAGE-B-1', 'PAGE-B-2', 'PAGE-B-3', 'PAGE-A-2', 'PAGE-A-1', 'PAGE-A-2'])
    const again = await call('merge_pdfs', { files: [`${D}/quote-b.pdf`, `${D}/quote-a.pdf`] })
    expect(again.text).toContain(`Saved ${D}/quote-b (${word('merged')}) (2).pdf (5 pages).`)
    const self = await call('merge_pdfs', { files: [`${D}/quote-a.pdf`, `${D}/quote-b.pdf`], output: `${D}/quote-a.pdf` })
    expect(self.isError).toBe(true)
    expect(self.text).toContain('is one of the files being joined')
  })

  test('split by parts and every N pages, into a folder', async () => {
    put(`${D}/long.pdf`, pdf('L', 5))
    const call = turn('alice')
    const r = await call('split_pdf', { file_path: `${D}/long.pdf`, parts: ['1-2', '3-last'] })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain(`Saved ${D}/long (${word('part')} 1).pdf (2 pages).`)
    expect(r.text).toContain(`Saved ${D}/long (${word('part')} 2).pdf (3 pages).`)
    const e = await call('split_pdf', { file_path: `${D}/long.pdf`, every: 2, output_folder: `${D}/parts` })
    expect(e.isError, e.text).toBe(false)
    expect(fs.readdirSync(file(`${D}/parts`)).sort()).toEqual([1, 2, 3].map((i) => `long (${word('part')} ${i}).pdf`))
    if (pdftotext) expect(await pages(`${D}/parts/long (${word('part')} 3).pdf`)).toEqual(['PAGE-L-5'])
  })
})

describe('locked and broken PDFs, and the folder rules', () => {
  const locked = () => {
    const s = Buffer.from(pdf('K', 1)).toString('latin1')
    return writePdf([...s.matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj/g)].map((m) => m[1]!), '/Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>')
  }
  test('a locked or broken PDF, in any of the tools: a plain reason naming the file, nothing saved', async () => {
    put(`${D}/locked.pdf`, locked())
    put(`${D}/broken.pdf`, 'not a pdf\n')
    const call = turn('alice')
    const before = fs.readdirSync(file(D)).length
    for (const [tool, args] of [
      ['edit_pdf', { file_path: `${D}/locked.pdf`, operations: [{ remove_pages: '1' }] }],
      ['merge_pdfs', { files: [`${D}/quote-a.pdf`, `${D}/locked.pdf`] }],
      ['split_pdf', { file_path: `${D}/broken.pdf`, parts: ['1'] }],
      ['edit_pdf', { file_path: `${D}/quote-a.pdf`, operations: [{ insert_pdf: { file: `${D}/broken.pdf`, after: 0 } }] }],
    ] as const) {
      const r = await call(tool, args as Record<string, unknown>)
      expect(r.isError, tool).toBe(true)
      expect(r.text).toMatch(/'groups\/marketing\/pdfs\/(locked|broken)\.pdf' (is locked with a password or protected against changes|could not be opened as a PDF \(it is damaged or not a PDF\))/)
      expect(r.text).not.toMatch(/pdf-lib|at .*\.ts/)
    }
    expect(fs.readdirSync(file(D)).length).toBe(before)
  })

  test('a folder the person may only read: refused; their own folder works; someone else\'s file: not found', async () => {
    put('projects/falcon/plan-scan.pdf', pdf('F', 3))
    const bob = turn('bob')
    const ro = await bob('edit_pdf', { file_path: 'projects/falcon/plan-scan.pdf', operations: [{ remove_pages: '2' }] })
    expect(ro.isError).toBe(true)
    expect(ro.text).toContain('read-only')
    const own = await bob('split_pdf', { file_path: 'projects/falcon/plan-scan.pdf', parts: ['1'], output_folder: 'users/bob/split' })
    expect(own.isError, own.text).toBe(false)
    put('users/bob/private.pdf', pdf('B', 2))
    const alice = turn('alice')
    for (const [tool, args] of [
      ['edit_pdf', { file_path: 'users/bob/private.pdf', operations: [{ remove_pages: '1' }] }],
      ['merge_pdfs', { files: [`${D}/quote-a.pdf`, 'users/bob/private.pdf'] }],
      ['edit_pdf', { file_path: `${D}/quote-a.pdf`, operations: [{ insert_pdf: { file: 'users/bob/private.pdf', after: 0 } }] }],
    ] as const) {
      const r = await alice(tool, args as Record<string, unknown>)
      expect(r.isError, tool).toBe(true)
      expect(r.text).toContain('not found or no access')
    }
    expect(fs.readdirSync(file('users/bob')).filter((n) => n.startsWith('private'))).toEqual(['private.pdf'])
    const skill = await turn('carol')('edit_pdf', { file_path: `${D}/quote-a.pdf`, operations: [{ remove_pages: '1' }], output: 'skills/x/out.pdf' })
    expect(skill.isError).toBe(true)
    expect(skill.text).toContain('not saved in a skill folder')
  })

  test('the lists: shared chats and rooms may use them; where they write; the files named inside a list', () => {
    for (const t of ['edit_pdf', 'merge_pdfs', 'split_pdf']) { expect(SHARED_TOOLS.has(t)).toBe(true); expect(ROOM_FILE_TOOLS.has(t)).toBe(true) }
    expect([WRITE_TARGET_ARGS.edit_pdf, WRITE_TARGET_ARGS.merge_pdfs, WRITE_TARGET_ARGS.split_pdf]).toEqual([['output'], ['output'], ['output_folder']])
    expect(namedPaths('split_pdf', { file_path: 'a.pdf', output_folder: 'x/parts' }).map((x) => x.value)).toEqual(['a.pdf', 'x/parts'])
    expect(namedPaths('edit_pdf', { file_path: 'a.pdf', operations: [{ insert_pdf: { file: 'b.pdf', after: 0 } }, { stamp_image: { image: 'c.png' } }] }).map((x) => x.value)).toEqual(['a.pdf', 'b.pdf', 'c.png'])
    expect(namedPaths('merge_pdfs', { files: ['a.pdf', { path: 'b.pdf', pages: '1' }] }).map((x) => x.value)).toEqual(['a.pdf', 'b.pdf'])
  })
})
