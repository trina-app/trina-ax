// stamp_pdf `at` (docs/decisions/20261123-signing-slots.md): a seal lands on the printed mark of the right signer or the call
// is refused and nothing is saved. Made-up PDFs through the tool path; where the seal really is comes from drawing the saved
// page, and where the mark is from pdftotext on the saved file.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PDFDocument, rgb } from 'pdf-lib'
import fontkit from '../../server/node_modules/@pdf-lib/fontkit'
import { makeHandler } from '../../server/src/mcp/protocol'
import { lineBands, parseWordBoxes, PDF_WORDS_MAX, resolvePdfMark, sameWords, type PPage, type PWord } from '../../server/src/files/pdf-marks'
import { decodeMarksResult, encodeMarksRequest, pdfMarksRequest } from '../../server/src/files/pdf-marks-worker'
import { SEAL_TOLERANCE_MM } from '../../server/src/files/sign-slots'
import { STAMPED } from '../../server/src/tools/stamp-pdf'
import { teamDefaultLocale } from '../../server/src/admin/settings'
import { makeCApp, type CApp, type Person } from '../lib/c-app'
import { pngRgbaOf } from '../lib/images'
import { writePdf } from '../lib/pdf'

setDefaultTimeout(90_000)
const tools = Bun.which('pdftotext') && Bun.which('pdftoppm')
const t = tools ? test : test.skip
const SEAL = pngRgbaOf(100, 100, () => [230, 0, 0, 255])
const MM = 25.4 / 72

let A: CApp
beforeAll(async () => { A = await makeCApp('pdf-sign-corpus'); put('users/alice/seal.png', SEAL) })
afterAll(async () => { await A.close() })
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
function put(rel: string, b: Uint8Array) { fs.mkdirSync(path.dirname(file(rel)), { recursive: true }); fs.writeFileSync(file(rel), b) }
let rpc = 0
function turn(user: Person) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx(user, A.turn(user, A.chat(user))))
  return async (name: string, args: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }
}
const stampedName = (n: string) => `${n.replace(/\.pdf$/, '')} (${STAMPED[teamDefaultLocale(A.ctx.db)]}).pdf`

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
/** one line of Helvetica at x, y (PDF space) */
const T = (x: number, y: number, s: string, extra = '') => `BT ${extra} /F1 12 Tf ${x} ${y} Td (${esc(s)}) Tj ET\n`
interface Opt { media?: string; crop?: string; rotate?: number; res?: string; page?: string; objs?: string[] }
function doc(streams: string[], o: Opt = {}): Uint8Array {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const extra = o.objs ?? []
  const first = 4 + extra.length
  objs.push(...extra)
  const kids = streams.map((_, i) => `${first + i * 2} 0 R`)
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${streams.length} >>`
  streams.forEach((s, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox ${o.media ?? '[0 0 595 842]'}${o.crop ? ` /CropBox ${o.crop}` : ''}${o.rotate ? ` /Rotate ${o.rotate}` : ''} /Contents ${first + i * 2 + 1} 0 R /Resources << /Font << /F1 3 0 R >> ${o.res ?? ''} >> ${o.page ?? ''} >>`)
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`)
  })
  return writePdf(objs)
}

/** the file again with its cross-reference table made from where the objects now are */
function rebuildXref(s: string): Uint8Array {
  const body = s.slice(0, s.lastIndexOf('\nxref\n') + 1)
  const offs = [...body.matchAll(/(?:^|\n)(\d+) 0 obj\n/g)].map((m) => ({ n: Number(m[1]), at: m.index + (m[0].startsWith('\n') ? 1 : 0) })).sort((a, b) => a.n - b.n)
  const table = `xref\n0 ${offs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o.at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offs.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body + table, 'latin1'))
}
const run = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); return r }
const wordsOf = (rel: string) => parseWordBoxes(run(['pdftotext', '-bbox-layout', '-cropbox', file(rel), '-']).stdout.toString())
/** the centre of the red seal as drawn on a page, in points from the top-left of the page as shown */
function sealCentre(rel: string, page: number) {
  const b = Buffer.from(run(['pdftoppm', '-r', '72', '-f', String(page), '-l', String(page), '-cropbox', '-singlefile', file(rel)]).stdout)
  const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(b.subarray(0, 40).toString('latin1'))!
  const w = Number(m[1]), h = Number(m[2]), at = m[0].length
  let x0 = w, x1 = -1, y0 = h, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = at + (y * w + x) * 3; if (b[o]! > 200 && b[o + 1]! < 60 && b[o + 2]! < 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) } }
  expect(x1).toBeGreaterThan(0)
  return { x: (x0 + x1 + 1) / 2, y: (y0 + y1 + 1) / 2 }
}
const centre = (w: PWord) => ({ x: (w.x0 + w.x1) / 2, y: (w.y0 + w.y1) / 2 })
/** the seal is on the nth word reading `word` of that page (left to right, top to bottom), on both axes */
function onWord(rel: string, page: number, word: string, nth = 0, share?: [number, number]) {
  const words = lineBands(wordsOf(rel)[page - 1]!).flat().filter((w) => w.text === word)
  const w = words[nth]!
  const c = centre(w)
  if (share) c.x = w.x0 + (w.x1 - w.x0) * ((share[0] + share[1]) / 2)
  const s = sealCentre(rel, page)
  expect(Math.abs(s.x - c.x) * MM).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
  expect(Math.abs(s.y - c.y) * MM).toBeLessThanOrEqual(SEAL_TOLERANCE_MM)
}

let n = 0
/** stamps a new file: the result, the saved file's path, and whether anything was saved */
async function stamp(pdf: Uint8Array, args: Record<string, unknown>) {
  const rel = `users/alice/f${++n}.pdf`
  put(rel, pdf)
  const call = turn('alice')
  expect((await call('read', { file_path: rel })).isError).toBe(false)
  const r = await call('stamp_pdf', { file_path: rel, image: 'users/alice/seal.png', ...args })
  const out = stampedName(rel)
  return { ...r, rel, out, saved: fs.existsSync(file(out)), call }
}
const refused = async (pdf: Uint8Array, args: Record<string, unknown>, says?: string) => {
  const r = await stamp(pdf, args)
  expect(r.isError).toBe(true)
  expect(r.saved).toBe(false)
  if (says) expect(r.text).toContain(says)
  return r
}

describe('stamp_pdf at: on the right mark', () => {
  t('a whole line: on the mark, and the result says what it landed on and that it was measured', async () => {
    const r = await stamp(doc([T(100, 600, 'Applicant: Hong Gildong (Seal)')]), { at: 'Applicant: Hong Gildong (Seal)' })
    expect(r.isError).toBe(false)
    onWord(r.out, 1, '(Seal)')
    expect(r.text).toContain('"(seal)"'.replace('seal', 'Seal'))
    expect(r.text).toContain('measured on the saved file')
    expect(r.text).toContain('matched from the PDF\'s text layer')
  })
  t('one signer of two on a line lands on that signer', async () => {
    const pdf = doc([T(80, 600, 'A: Kim Cheolsu (Seal)') + T(330, 600, 'B: Hong Gildong (Seal)')])
    const b = await stamp(pdf, { at: 'B: Hong Gildong (Seal)' })
    expect(b.isError).toBe(false)
    onWord(b.out, 1, '(Seal)', 1)
    const a = await stamp(pdf, { at: 'A: Kim Cheolsu (Seal)' })
    onWord(a.out, 1, '(Seal)', 0)
  })
  t('a whole line with two marks is refused; occurrence picks one', async () => {
    const pdf = doc([T(80, 600, 'A: Kim (Seal)   B: Hong (Seal)')])
    await refused(pdf, { at: 'A: Kim (Seal) B: Hong (Seal)' }, '2 sign marks')
    const r = await stamp(pdf, { at: 'A: Kim (Seal) B: Hong (Seal)', occurrence: 2 })
    expect(r.isError).toBe(false)
    onWord(r.out, 1, '(Seal)', 1)
  })
  t('a repeated mark: refused, then occurrence counts by reading order, not drawing order', async () => {
    // the lower line is drawn first
    const pdf = doc([T(100, 300, 'Lower (Seal)') + T(100, 600, 'Upper (Seal)')])
    await refused(pdf, { at: '(Seal)' }, '2 places')
    const r = await stamp(pdf, { at: '(Seal)', occurrence: 1 })
    expect(r.isError).toBe(false)
    const s = sealCentre(r.out, 1)
    expect(Math.abs(s.y - (842 - 600 - 4))).toBeLessThan(6)
  })
  t('several pages: page limits the search, occurrence counts across pages', async () => {
    const pdf = doc([T(100, 600, 'One (Seal)'), T(100, 500, 'Two (Seal)'), T(100, 400, 'Three (Seal)')])
    const p = await stamp(pdf, { at: '(Seal)', page: 2 })
    expect(p.isError).toBe(false)
    onWord(p.out, 2, '(Seal)')
    const o = await stamp(pdf, { at: '(Seal)', occurrence: 3 })
    onWord(o.out, 3, '(Seal)')
    const last = await stamp(pdf, { at: '(Seal)', page: 'last' })
    onWord(last.out, 3, '(Seal)')
  })
  const upright: Record<number, string> = { 0: '1 0 0 1', 90: '0 1 -1 0', 180: '-1 0 0 -1', 270: '0 -1 1 0' }
  for (const rotate of [0, 90, 180, 270]) t(`a page turned ${rotate}: on the mark`, async () => {
    const s = `BT /F1 12 Tf ${upright[rotate]} 300 420 Tm (Hong Gildong \\(Seal\\)) Tj ET\n`
    const r = await stamp(doc([s], { rotate }), { at: 'Hong Gildong (Seal)' })
    expect(r.isError).toBe(false)
    onWord(r.out, 1, '(Seal)')
  })
  t('a CropBox inside the page, and one reaching past it', async () => {
    const inside = await stamp(doc([T(150, 500, 'Hong (Seal)')], { crop: '[50 100 500 700]' }), { at: 'Hong (Seal)' })
    expect(inside.isError).toBe(false)
    onWord(inside.out, 1, '(Seal)')
    const past = await stamp(doc([T(150, 500, 'Hong (Seal)')], { media: '[0 0 595 842]', crop: '[-100 -100 700 900]' }), { at: 'Hong (Seal)' })
    expect(past.isError).toBe(false)
    onWord(past.out, 1, '(Seal)')
  })
  t('text drawn twice for bold is one place', async () => {
    const r = await stamp(doc([T(100, 600, 'Hong (Seal)') + T(100.2, 600, 'Hong (Seal)')]), { at: 'Hong (Seal)' })
    expect(r.isError).toBe(false)
    onWord(r.out, 1, '(Seal)')
  })
  t('a mark joined to a signing rule and a comma is measured from its drawn letters', async () => {
    const r = await stamp(doc([T(100, 600, 'Agent ________(Seal), done')]), { at: '(Seal)' })
    expect([r.isError, r.isError ? r.text : '']).toEqual([false, ''])
    const w = lineBands(wordsOf(r.out)[0]!).flat().find((x) => x.text.includes('(Seal)'))!
    const s = sealCentre(r.out, 1)
    // the mark is the last 6 of the word's letters but one, right of the rule
    expect(s.x).toBeGreaterThan((w.x0 + w.x1) / 2)
    expect(s.x).toBeLessThan(w.x1)
  })
  t('a mark in spaced brackets with a rule and a comma stuck to them lands on the words inside', async () => {
    const r = await stamp(doc([T(100, 600, 'Agent ________( Seal ), done')]), { at: '( Seal )' })
    expect([r.isError, r.isError ? r.text : '']).toEqual([false, ''])
    onWord(r.out, 1, 'Seal')
  })
  t('two signers at slightly different heights keep their left-to-right order', async () => {
    const pdf = doc([T(80, 600, 'Kim (Seal)') + T(350, 600.6, 'Hong (Seal)')])
    const r = await stamp(pdf, { at: '(Seal)', occurrence: 1 })
    expect(r.isError).toBe(false)
    expect(Math.abs(sealCentre(r.out, 1).x - 130)).toBeLessThan(25)
  })
  t('Korean in an embedded font: a whole line, and the seal word of a signature-or-seal mark', async () => {
    const d = await PDFDocument.create()
    d.registerFontkit(fontkit)
    const f = await d.embedFont(fs.readFileSync(path.join(import.meta.dir, '../../resources/hwp/fonts/NotoSansKR-Regular.ttf')), { subset: false })
    const p = d.addPage([595, 842])
    p.drawText('갑: 김철수 (인)', { x: 80, y: 600, size: 12, font: f, color: rgb(0, 0, 0) })
    p.drawText('을: 홍길동 (서명 또는 인)', { x: 320, y: 600, size: 12, font: f, color: rgb(0, 0, 0) })
    const pdf = await d.save()
    const a = await stamp(pdf, { at: '갑: 김철수 (인)' })
    expect(a.isError).toBe(false)
    onWord(a.out, 1, '(인)')
    const b = await stamp(pdf, { at: '을: 홍길동 (서명 또는 인)' })
    expect(b.isError).toBe(false)
    onWord(b.out, 1, '인)')
  })
})

describe('stamp_pdf at: refused, nothing saved', () => {
  t('a name hidden next to someone else\'s visible mark', async () => {
    await refused(doc([T(100, 600, 'Guarantor:') + T(170, 600, 'Alice', '3 Tr') + T(215, 600, '(Seal)')]), { at: 'Alice (Seal)' })
    await refused(doc([T(100, 600, 'Guarantor:') + `1 1 1 rg\n` + T(170, 600, 'Alice') + `0 0 0 rg\n` + T(215, 600, '(Seal)')]), { at: 'Alice (Seal)' })
  })
  t('a mark covered by a box', async () => {
    await refused(doc([T(100, 600, 'Hong (Seal)') + '1 1 1 rg 90 590 200 30 re f\n']), { at: 'Hong (Seal)' }, 'does not show')
  })
  t('columns: a name is never paired with the mark on the next line', async () => {
    await refused(doc([T(100, 600, 'Alice') + T(140, 600, 'Bob') + T(100, 586, '(Seal)') + T(145, 586, '(Seal)')]), { at: 'Bob (Seal)' })
  })
  t('text after the mark, an unknown mark, no mark, and a mark glued to a name', async () => {
    await refused(doc([T(100, 600, 'A: Kim (Seal)   B: Hong (Stamp)')]), { at: '(Seal)   B: Hong' }, 'after its sign mark')
    await refused(doc([T(100, 600, 'Hong (Sign here please)')]), { at: 'Hong (Sign here please)' })
    await refused(doc([T(100, 600, 'Hong Gildong')]), { at: 'Hong Gildong' }, 'no printed sign mark')
    await refused(doc([T(100, 600, 'Hong(Seal)')]), { at: 'Hong(Seal)' }, 'joined')
  })
  t('text inside a Form XObject: how it is drawn cannot be checked', async () => {
    const form = T(100, 600, 'Hong Gildong (Seal)')
    const pdf = doc(['/X1 Do\n'], { objs: [`<< /Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Length ${form.length} >>\nstream\n${form}\nendstream`], res: '/XObject << /X1 4 0 R >>' })
    await refused(pdf, { at: 'Hong Gildong (Seal)' }, 'embedded drawing')
  })
  t('a name at the left and another person\'s mark across the page are not one label', async () => {
    await refused(doc([T(40, 600, 'Hong') + T(346, 600, '(Seal)') + T(300, 600, 'Lee')]), { at: 'Hong (Seal)' }, 'not on one line')
    await refused(doc([T(40, 600, 'Hong') + T(346, 600, '(Seal)')]), { at: 'Hong (Seal)' }, 'not on one line')
  })
  t('replacement text, hidden text over stripes, white text crossed by a rule, tiny text, a mostly covered mark', async () => {
    await refused(doc(['/Span << /ActualText (Hong) >> BDC\n' + T(100, 600, 'Kims') + 'EMC\n' + T(132, 600, '(Seal)')]), { at: 'Hong (Seal)' }, 'ActualText')
    const stripes = Array.from({ length: 16 }, (_, i) => `${95 + i * 8} 590 3 30 re f\n`).join('')
    await refused(doc([stripes + T(100, 600, 'Hong (Seal)', '3 Tr')]), { at: 'Hong (Seal)' }, 'hidden text')
    await refused(doc(['1 1 1 rg\n' + T(100, 600, 'Hong (Seal)') + '0 0 0 RG 1 w 90 604 m 260 604 l S\n']), { at: 'Hong (Seal)' }, 'does not show')
    await refused(doc(['BT /F1 1 Tf 100 600 Td (Hong \\(Seal\\)) Tj ET\n']), { at: 'Hong (Seal)' }, 'too small')
    await refused(doc([T(100, 600, 'Hong (Seal)') + '1 1 1 rg 132 590 30 30 re f\n']), { at: 'Hong (Seal)' }, 'does not show')
  })
  t('hidden ways that are not a render mode: no opacity, a white stroke, a white spot colour, a picture over the text', async () => {
    await refused(doc(['/G0 gs\n' + T(100, 600, 'Hong (Seal)')], { res: '/ExtGState << /G0 << /ca 0 /CA 0 >> >>' }), { at: 'Hong (Seal)' }, 'does not show')
    await refused(doc(['1 1 1 RG 0.3 w\n' + T(100, 600, 'Hong (Seal)', '1 Tr')]), { at: 'Hong (Seal)' }, 'does not show')
    await refused(doc(['/CS0 cs 0 scn\n' + T(100, 600, 'Hong (Seal)')], { res: '/ColorSpace << /CS0 [/Separation /White /DeviceGray << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [1] /N 1 >>] >>' }), { at: 'Hong (Seal)' }, 'does not show')
    // the text layer says Hong, and an opaque picture of other letters is what shows
    const img = 'q 110 0 0 16 98 596 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x00\xff\xff\x00 EI Q\n'
    await refused(doc([T(100, 600, 'Hong (Seal)') + img]), { at: 'Hong (Seal)' }, 'does not show')
  })
  t('replacement text that says what the letters say is fine, and a seal mark in a circle works', async () => {
    const same = await stamp(doc(['/Span << /ActualText (Hong) >> BDC\n' + T(100, 600, 'Hong') + 'EMC\n' + T(132, 600, '(Seal)')]), { at: 'Hong (Seal)' })
    expect(same.isError).toBe(false)
    // (the circled seal: the repository's font has no glyph for it, so the word boxes are given here)
    const words: PWord[] = [{ text: '담당', x0: 100, x1: 122, y0: 200, y1: 217, line: 1 }, { text: '오민수', x0: 134, x1: 167, y0: 200, y1: 217, line: 2 }, { text: '㊞', x0: 170, x1: 182, y0: 200, y1: 217, line: 2 }]
    const got = resolvePdfMark([{ words }], '담당 오민수 ㊞', {})
    expect('target' in got && got.target.aim.x0).toBe(170)
  })
  t('a worker that fails on the way counts as a refusal: coordinates are blocked after it too', async () => {
    const r = await stamp(doc([T(100, 600, 'Hong (Seal)')]), { at: 'Hong (Seal)', width_mm: 900 })
    expect(r.isError).toBe(true)
    const xy = await r.call('stamp_pdf', { file_path: r.rel, image: 'users/alice/seal.png', position: { x_mm: 10, y_mm: 10 } })
    expect(xy.isError).toBe(true)
    expect(xy.text).toContain('by coordinates')
  })
  t('text drawn thousands of times at one spot is checked once, within the caps', async () => {
    const many = Array.from({ length: 6000 }, () => '1 0 0 1 100 600 Tm (\\(Seal\\)) Tj').join(' ')
    const t0 = performance.now()
    const r = await stamp(doc([`BT /F1 12 Tf ${many} ET\n`]), { at: '(Seal)' })
    expect(performance.now() - t0).toBeLessThan(30_000)
    expect(typeof r.isError).toBe('boolean')
  })
  t('two different letters that read as one in a font\'s map are refused', async () => {
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <48> <0048> <4C> <0048> endbfchar endcmap end end'
    const pdf = doc([T(100, 600, 'HLng (Seal)')], { objs: [`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`] })
    const s = Buffer.from(pdf).toString('latin1').replace('/BaseFont /Helvetica >>', '/BaseFont /Helvetica /ToUnicode 4 0 R >>')
    const fixed = rebuildXref(s)
    await refused(fixed, { at: 'HHng (Seal)' }, 'letter map')
  })
  t('a huge page is refused before it is drawn', async () => {
    await refused(doc([T(100, 600, 'Hong (Seal)')], { media: '[0 0 6000 6000]' }), { at: 'Hong (Seal)' }, 'too large')
  })
  test('too many words: refused in the worker; a page at the cap is handled in near-linear time', async () => {
    const word = (i: number) => `<word xMin="${(i % 190) * 3}" yMin="${Math.floor(i / 190) * 5}" xMax="${(i % 190) * 3 + 2}" yMax="${Math.floor(i / 190) * 5 + 4}">w${i}</word>`
    const xml = (n: number) => Buffer.from(`<page width="595" height="842"><line>${Array.from({ length: n }, (_, i) => word(i)).join('')}</line></page>`)
    const over = xml(PDF_WORDS_MAX + 1)
    const r = decodeMarksResult(await pdfMarksRequest(encodeMarksRequest({ kind: 'resolve', at: '(Seal)', xmlLength: over.length }, over, new Uint8Array(1))))
    expect(r).toMatchObject({ kind: 'ask' })
    expect((r as { ask: string }).ask).toContain('too much text')
    const pages = parseWordBoxes(xml(PDF_WORDS_MAX).toString())
    const t0 = performance.now()
    expect(lineBands(pages[0]!).flat()).toHaveLength(PDF_WORDS_MAX)
    expect(performance.now() - t0).toBeLessThan(3000)
  })
  t('another page that differs between two PDF readers is refused', async () => {
    const a = T(100, 600, 'One (Seal)'), other = '0 0 1 rg 100 100 200 200 re f\n', twin = '1 0 0 rg 300 300 100 100 re f\n'
    const base = Buffer.from(doc([a, other])).toString('latin1')
    const obj = `7 0 obj\n<< /Length ${twin.length} >>\nstream\n${twin}\nendstream\nendobj\n`
    const at = base.lastIndexOf('\nxref\n') + 1
    const shifted = base.slice(0, at) + obj + base.slice(at).replace(/startxref\s+(\d+)/, (_m, x: string) => `startxref\n${Number(x) + obj.length}`)
    await refused(new Uint8Array(Buffer.from(shifted, 'latin1')), { at: 'One (Seal)' }, 'another page')
  })
  t('text turned upright', async () => {
    await refused(doc(['BT /F1 12 Tf 0 1 -1 0 300 400 Tm (Hong Gildong \\(Seal\\)) Tj ET\n']), { at: 'Hong Gildong (Seal)' }, 'not on one line')
    await refused(doc(['BT /F1 12 Tf 0 1 -1 0 300 400 Tm (Hong Gildong \\(Seal\\)) Tj ET\n']), { at: '(Seal)' }, 'turned')
  })
  t('something opaque above where the seal would be', async () => {
    const ap = '1 1 1 rg 0 0 200 60 re f\n'
    const pdf = doc([T(100, 600, 'Hong (Seal)')], {
      objs: [`<< /Type /XObject /Subtype /Form /BBox [0 0 200 60] /Length ${ap.length} >>\nstream\n${ap}\nendstream`, '<< /Type /Annot /Subtype /Stamp /Rect [100 612 300 672] /F 4 /AP << /N 4 0 R >> >>'],
      page: '/Annots [5 0 R]',
    })
    await refused(pdf, { at: 'Hong (Seal)', width_mm: 30 }, 'would not show')
  })
  t('a file whose objects read differently in two readers', async () => {
    const a = T(100, 600, 'Alice (Seal)'), b = T(100, 600, 'Bobby (Seal)')
    const base = Buffer.from(doc([a])).toString('latin1')
    const twin = `5 0 obj\n<< /Length ${b.length} >>\nstream\n${b}\nendstream\nendobj\n`
    const at = base.lastIndexOf('\nxref\n') + 1
    const shifted = base.slice(0, at) + twin + base.slice(at).replace(/startxref\s+(\d+)/, (_m, x: string) => `startxref\n${Number(x) + twin.length}`)
    await refused(new Uint8Array(Buffer.from(shifted, 'latin1')), { at: 'Alice (Seal)' })
  })
  t('a PDF not read in this chat', async () => {
    const rel = 'users/alice/unread.pdf'
    put(rel, doc([T(100, 600, 'Hong (Seal)')]))
    const r = await turn('alice')('stamp_pdf', { file_path: rel, image: 'users/alice/seal.png', at: 'Hong (Seal)' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('read')
  })
  t('at with position, and occurrence without at', async () => {
    await refused(doc([T(100, 600, 'Hong (Seal)')]), { at: 'Hong (Seal)', position: 'center' }, 'not both')
    await refused(doc([T(100, 600, 'Hong (Seal)')]), { occurrence: 1 }, 'goes with at')
  })
  t('after a refusal, coordinates on that PDF are refused for the rest of the turn, in both tools', async () => {
    const r = await refused(doc([T(100, 300, 'Lower (Seal)') + T(100, 600, 'Upper (Seal)')]), { at: '(Seal)' })
    const xy = await r.call('stamp_pdf', { file_path: r.rel, image: 'users/alice/seal.png', position: { x_mm: 50, y_mm: 50 } })
    expect(xy.isError).toBe(true)
    expect(xy.text).toContain('ask the person')
    const corner = await r.call('stamp_pdf', { file_path: r.rel, image: 'users/alice/seal.png' })
    expect(corner.isError).toBe(true)
    const edit = await r.call('edit_pdf', { file_path: r.rel, operations: [{ stamp_image: { image: 'users/alice/seal.png' } }] })
    expect(edit.isError).toBe(true)
    expect(edit.text).toContain('ask the person')
    // the AI can still answer with the right mark in that turn
    const right = await r.call('stamp_pdf', { file_path: r.rel, image: 'users/alice/seal.png', at: 'Upper (Seal)' })
    expect(right.isError).toBe(false)
    // also on a new file made from it, or any other PDF in that answer
    const split = await r.call('split_pdf', { file_path: r.rel, parts: ['1'], output: 'users/alice/split-after.pdf' })
    const made = (/users\/alice\/[^'"\s)]*\.pdf/.exec(split.text) ?? ['users/alice/other.pdf'])[0]
    if (!fs.existsSync(file(made))) put(made, doc([T(100, 600, 'Other')]))
    const onNew = await r.call('stamp_pdf', { file_path: made, image: 'users/alice/seal.png', position: 'center', output: 'users/alice/split-stamped.pdf' })
    expect(onNew.isError).toBe(true)
    expect(onNew.text).toContain('by coordinates')
    // and a later turn is a new question
    const later = await turn('alice')('stamp_pdf', { file_path: r.rel, image: 'users/alice/seal.png', position: 'center', output: 'users/alice/later.pdf' })
    expect(later.isError).toBe(false)
  })
})

describe('stamp_pdf without at is as it was', () => {
  t('a corner and x/y', async () => {
    const c = await stamp(doc([T(100, 600, 'Hong (Seal)')]), { position: 'top-left', width_mm: 20 })
    expect(c.isError).toBe(false)
    const s = sealCentre(c.out, 1)
    expect(Math.abs(s.x - (15 + 10) / MM)).toBeLessThan(2)
    const xy = await stamp(doc([T(100, 600, 'Hong (Seal)')]), { position: { x_mm: 40, y_mm: 60 }, width_mm: 20 })
    const q = sealCentre(xy.out, 1)
    expect(Math.abs(q.y - (60 + 10) / MM)).toBeLessThan(2)
  })
})

// The invariant on generated pages: words drawn in shuffled order, repeated names and marks, side by side and skewed.
describe('the true place or a refusal, never another', () => {
  const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296 }
  test('2000 generated documents', () => {
    let placed = 0, asked = 0
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed)
      const names = ['Kim', 'Hong', 'Lee']
      const truth: { page: number; x: number; y: number; name: string }[] = []
      const pages: PPage[] = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({ words: [] }))
      let line = 0
      pages.forEach((p, page) => {
        for (let row = 0, rows = 1 + Math.floor(r() * 4); row < rows; row++) {
          const y = 100 + row * 40 + r() * 0.8
          for (let col = 0, cols = 1 + Math.floor(r() * 3); col < cols; col++) {
            const x = 60 + col * 170, name = names[Math.floor(r() * names.length)]!, skew = r() * 0.6
            line++
            p.words.push({ text: name, x0: x, x1: x + 30, y0: y + skew, y1: y + 12 + skew, line })
            p.words.push({ text: '(Seal)', x0: x + 36, x1: x + 70, y0: y + skew, y1: y + 12 + skew, line })
            truth.push({ page, x: x + 53, y: y + skew + 6, name })
          }
        }
        for (let k = p.words.length - 1; k > 0; k -= 2) { const j = Math.floor(r() * ((k + 1) / 2)) * 2 + 1; const [a, b] = [p.words.slice(k - 1, k + 1), p.words.slice(j - 1, j + 1)]; p.words.splice(k - 1, 2, ...b); p.words.splice(j - 1, 2, ...a) }
      })
      // reading order, which the tool's occurrence means
      const order = [...truth].sort((a, b) => a.page - b.page || (Math.abs(a.y - b.y) < 6 ? a.x - b.x : a.y - b.y))
      const name = names[Math.floor(r() * names.length)]!
      const mine = order.filter((x) => x.name === name)
      if (!mine.length) continue
      const k = 1 + Math.floor(r() * mine.length)
      const got = resolvePdfMark(pages, `${name} (Seal)`, { occurrence: k })
      if ('ask' in got) { asked++; continue }
      placed++
      const want = mine[k - 1]!
      const c = { x: (got.target.aim.x0 + got.target.aim.x1) / 2, y: (got.target.aim.y0 + got.target.aim.y1) / 2 }
      expect([seed, got.target.page, Math.abs(c.x - want.x) < 1, Math.abs(c.y - want.y) < 1]).toEqual([seed, want.page, true, true])
    }
    expect(placed).toBeGreaterThan(500)
    expect(asked + placed).toBeGreaterThan(1000)
  })
  test('sameWords: a moved or changed word is not the same', () => {
    const w = (x: number, text = 'a'): PPage[] => [{ words: [{ text, x0: x, x1: x + 5, y0: 1, y1: 2, line: 1 }] }]
    expect(sameWords(w(1), w(1))).toBe(true)
    expect(sameWords(w(1), w(2))).toBe(false)
    expect(sameWords(w(1), w(1, 'b'))).toBe(false)
  })
})
