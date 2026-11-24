// One way to place a picture in Word and Hangul (plan docs/AGENTS/plan/20261124-0604-place-picture.md): at a text, in a
// table cell or at x/y mm on a page; a text in several places is refused with the places listed; a picture is moved by
// the call that placed it, done again with the new place (tools/placed-pictures.ts).
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import '../../server/src/files/docx-edit'
import { editHwp } from '../../server/src/files/hwp-edit'
import { NativeHwpEngine, localHwpAssets } from '../../server/src/files/hwp-engine'
import { sanitizeImage, type HwpLayout } from '../../server/src/files/hwp-picture'
import { editHwpx } from '../../server/src/files/hwpx-edit'
import type { HwpChange } from '../../server/src/files/hwpx-check'
import { frame, officeEditRequest, unframe, type EditReport } from '../../server/src/files/office-edit'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { sha256 } from '../../server/src/files/store'
import { mergeMove, rememberPlacement, replayPlacement } from '../../server/src/tools/placed-pictures'

setDefaultTimeout(60_000)
const FIX = path.join(import.meta.dir, '../fixtures/hwp')
const SEAL = new Uint8Array(fs.readFileSync(path.join(FIX, 'seal.png')))

describe('move by the call that placed the picture', () => {
  const base = new Uint8Array([1, 2, 3]), result = new Uint8Array([4, 5, 6])
  const changes = [{ find: 'a', replace: 'b' }, { image: 'logo.png', at: 'Name', width_mm: 20 }]
  test('the moved picture\'s change gets the new place; the other changes stay', () => {
    const [id] = rememberPlacement({ user: 'u1', file: 'a.hwpx', result: sha256(result), base, changes }, [1])
    const r = replayPlacement('u1', 'a.hwpx', result, [{ picture: id!, dx_mm: -5 }], (p, m) => mergeMove(p, m, ['at', 'page', 'x_mm', 'y_mm']))
    expect(r.base).toBe(base)
    expect(r.changes).toEqual([changes[0], { ...changes[1], shift: { x_mm: -5, y_mm: 0 } }])
    const again = replayPlacement('u1', 'a.hwpx', result, [{ picture: id!, page: 1, x_mm: 150, y_mm: 10, width_mm: 30 }], (p, m) => mergeMove(p, m, ['at', 'page', 'x_mm', 'y_mm']))
    expect(again.changes[1]).toEqual({ image: 'logo.png', page: 1, x_mm: 150, y_mm: 10, width_mm: 30 })
  })
  test('another person, another file, a changed file or an unknown id is refused, and says to place it again', () => {
    const [id] = rememberPlacement({ user: 'u1', file: 'a.hwpx', result: sha256(result), base, changes }, [1])
    const m = (p: Record<string, unknown>) => p
    expect(() => replayPlacement('u2', 'a.hwpx', result, [{ picture: id! }], m)).toThrow('not in')
    expect(() => replayPlacement('u1', 'b.hwpx', result, [{ picture: id! }], m)).toThrow('not in')
    expect(() => replayPlacement('u1', 'a.hwpx', base, [{ picture: id! }], m)).toThrow('changed after that picture was placed')
    expect(() => replayPlacement('u1', 'a.hwpx', result, [{ picture: 'pic-00000000' }], m)).toThrow('place it again')
  })
})

describe('Word', () => {
  const doc = (body: string) => writeZip([
    { name: '[Content_Types].xml', data: new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: '_rels/.rels', data: new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`) },
  ])
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
  const run = (file: Uint8Array, changes: unknown[]) => {
    const r = unframe<EditReport>(officeEditRequest(frame({ kind: 'docx', changes }, [file, SEAL])))
    return { report: r.json, xml: new TextDecoder().decode(readZip(r.blobs[0]!).find((e) => e.name === 'word/document.xml')!.data) }
  }
  test('x/y on the page of a text: anchored there, positioned from the page', () => {
    const r = run(doc(p('Contract') + p('Buyer: Example Co. (seal)')), [{ insert_picture: { image: 0, over: 'Contract', x_mm: 150, y_mm: 10, width_mm: 30 } }])
    expect(r.xml).toContain('<wp:positionH relativeFrom="page"><wp:posOffset>5400000</wp:posOffset>')
    expect(r.xml).toContain('<wp:positionV relativeFrom="page"><wp:posOffset>360000</wp:posOffset>')
    expect(r.report.notes[0]!.where).toContain('150, 10 mm from the top-left corner of the page')
  })
  test('over centres on the whole text it names, with no mark rules; a shift moves it', () => {
    const one = run(doc(p('갑: 김철수 (인)   을: 홍길동 (인)')), [{ insert_picture: { image: 0, over: '을: 홍길동 (인)', width_mm: 15 } }])
    expect(one.report.notes[0]!.where).toContain('picture over "을: 홍길동 (인)"')
    const dx = Number(/relativeFrom="character"><wp:posOffset>(-?\d+)</.exec(one.xml)![1])
    const two = run(doc(p('갑: 김철수 (인)   을: 홍길동 (인)')), [{ insert_picture: { image: 0, over: '을: 홍길동 (인)', width_mm: 15, shift: { x_mm: -3, y_mm: 0 } } }])
    expect(Number(/relativeFrom="character"><wp:posOffset>(-?\d+)</.exec(two.xml)![1])).toBe(dx - 3 * 36000)
  })
  test('the picture is in a run of its own, so a reader that takes a run with a picture for the picture keeps the text', () => {
    const r = run(doc(p('Contract') + p('Buyer: Example Co. (seal)')), [{ insert_picture: { image: 0, over: '(seal)', width_mm: 15 } }])
    expect(r.xml).toContain('<w:r><w:t xml:space="preserve">Buyer: Example Co. </w:t></w:r><w:r><w:drawing>')
    expect(r.xml).toMatch(/<\/w:drawing><\/w:r><w:r><w:t xml:space="preserve">\(seal\)<\/w:t><\/w:r>/)
  })
  test('a text in several places is refused with the places listed', () => {
    expect(() => run(doc(p('A (seal)') + p('B (seal)')), [{ insert_picture: { image: 0, over: '(seal)' } }])).toThrow(/2 places of the body \(1: "A \(seal\)"; 2: "B \(seal\)"\); give occurrence/)
  })
})

const RHWP = fs.existsSync(localHwpAssets().bin)
if (!RHWP) test('HWP Preview renderer not in this checkout: Hangul cases skipped', () => { console.log(`skipped: no ${localHwpAssets().bin}`) })
else describe('Hangul', () => {
  const engine = new NativeHwpEngine()
  const seal = sanitizeImage(SEAL, 'seal.png')
  const place = async (name: string, changes: HwpChange[]) => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, name)))
    const kind = name.endsWith('.hwpx') ? 'hwpx' : 'hwp'
    const layout: HwpLayout = await engine.layout(Buffer.from(bytes), kind)
    const edit = kind === 'hwpx' ? editHwpx : editHwp
    return { ...edit(bytes, changes, { layout, images: new Map(changes.map((_, i) => [i, seal])) }), layout }
  }
  for (const name of ['sign-form.hwp', 'sign-form.hwpx', 'sign-form-hancom.hwp', 'sign-form-hancom.hwpx']) {
    test(`${name}: x/y on a page, and a shift`, async () => {
      const r = await place(name, [{ image: 'seal.png', page: 1, x_mm: 150, y_mm: 20, width_mm: 20 }])
      expect(r.report.pictures![0]).toMatchObject({ page: 1, xMm: 150, yMm: 20, widthMm: 20 })
      const s = await place(name, [{ image: 'seal.png', page: 1, x_mm: 150, y_mm: 20, width_mm: 20, shift: { x_mm: -5, y_mm: 3 } }])
      expect(s.report.pictures![0]).toMatchObject({ xMm: 145, yMm: 23 })
    })
  }
  test('a page that is not there is refused with the page count', async () => {
    await expect(place('sign-form.hwpx', [{ image: 'seal.png', page: 9, x_mm: 1, y_mm: 1 }])).rejects.toThrow(/the document has \d+ page/)
  })
  test('a text in several places is refused with the places listed; with occurrence it goes in', async () => {
    await expect(place('sign-form.hwpx', [{ image: 'seal.png', at: '2027' }])).rejects.toThrow(/appears \d+ times \(1: .*\)\. Give occurrence/)
    const r = await place('sign-form.hwpx', [{ image: 'seal.png', at: '2027', occurrence: 2 }])
    expect(r.report.pictures![0]!.where).toContain('over "2027"')
    const c = await place('sign-form.hwp', [{ image: 'seal.png', cell: { next_to: '서명' } }])
    expect(c.report.pictures![0]!.where).toMatch(/^table \d+, row \d+, column \d+$/)
  })
})
