// edit_office insert_picture and move_picture in PowerPoint and Excel: one op that adds a picture and one that moves or
// resizes it, on real files of this repository; every other part stays byte for byte and the package reads back.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, test } from 'bun:test'
import * as XLSX from 'xlsx'
import { frame, officeEditRequest, officeVerifyRequest, unframe, type EditReport, type OfficeKind } from '../../server/src/files/office-edit'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { officePartsMismatch } from '../../server/src/tools/edit-office'

const root = path.join(import.meta.dir, '..', '..')
const deck = () => new Uint8Array(fs.readFileSync(path.join(root, 'server/assets/safe-reference.pptx')))
const book = () => new Uint8Array(fs.readFileSync(path.join(root, 'scripts/demo/acme/files/shared/budget/2026-Q4-company-budget.xlsx')))

function png(w: number, h: number): Uint8Array {
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => [200, 0, 0]).flat()])))
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(Bun.hash.crc32(td)); return Buffer.concat([len, td, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
function edit(kind: OfficeKind, file: Uint8Array, changes: unknown[], images: Uint8Array[] = [png(40, 20)]) {
  const r = unframe<EditReport>(officeEditRequest(frame({ kind, changes }, [file, ...images])))
  const out = r.blobs[0]!
  expect(officePartsMismatch(kind, file, out, r.json, true)).toBeNull()
  officeVerifyRequest(frame({ kind, changed: r.json.changed, added: r.json.added, notes: r.json.notes, cells: r.json.cells ?? [], placed: r.json.placed ?? [] }, [file, out]))
  return { file: out, report: r.json }
}
const part = (f: Uint8Array, n: string) => new TextDecoder().decode(readZip(f).find((e) => e.name === n)!.data)
const untouched = (a: Uint8Array, b: Uint8Array, r: EditReport) => {
  const after = new Map(readZip(b).map((e) => [e.name, e.data]))
  for (const e of readZip(a)) if (!r.changed.includes(e.name)) expect(Buffer.from(after.get(e.name)!).equals(Buffer.from(e.data))).toBe(true)
}

describe('PowerPoint', () => {
  test('adds a picture at slide + x/y, then moves and resizes the same picture', () => {
    const a = deck()
    const one = edit('pptx', a, [{ insert_picture: { image: 0, slide: 1, x_mm: 10, y_mm: 20, width_mm: 40 } }])
    untouched(a, one.file, one.report)
    const name = /picture "([^"]+)"/.exec(one.report.notes[0]!.where)![1]!
    expect(one.report.notes[0]!.where).toContain('at 10, 20 mm, 40 x 20 mm')
    const two = edit('pptx', one.file, [{ move_picture: { slide: 1, picture: name, x_mm: 50, width_mm: 80 } }], [])
    expect(two.report.notes[0]!.where).toContain('at 50, 20 mm, 80 x 40 mm')
    const xml = part(two.file, 'ppt/slides/slide1.xml')
    expect(xml).toContain(`<a:off x="${50 * 36000}" y="${20 * 36000}"/>`)
    expect(xml).toContain(`<a:ext cx="${80 * 36000}" cy="${40 * 36000}"/>`)
  })
  test('no position is the centre, and a picture in a group moves in slide millimetres', () => {
    const one = edit('pptx', deck(), [{ insert_picture: { image: 0, slide: 1, width_mm: 40 } }])
    expect(/at ([\d.]+), ([\d.]+) mm, 40 x 20 mm \(the slide is ([\d.]+) x ([\d.]+) mm\)/.exec(one.report.notes[0]!.where)!.slice(1).map(Number)).toSatisfy(([x, y, w, h]: number[]) => Math.abs(x! - (w! - 40) / 2) < 0.2 && Math.abs(y! - (h! - 20) / 2) < 0.2)
    const x = part(one.file, 'ppt/slides/slide1.xml').replace(/<p:pic\b[\s\S]*<\/p:pic>/, (m) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="900" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:off x="360000" y="360000"/><a:ext cx="7200000" cy="7200000"/><a:chOff x="0" y="0"/><a:chExt cx="3600000" cy="3600000"/></a:xfrm></p:grpSpPr>${m}</p:grpSp>`)
    const grouped = writeZip(readZip(one.file).map((e) => (e.name === 'ppt/slides/slide1.xml' ? { name: e.name, data: new TextEncoder().encode(x) } : e)))
    const moved = edit('pptx', grouped, [{ move_picture: { slide: 1, picture: 1, x_mm: 30, y_mm: 40 } }], [])
    expect(moved.report.notes[0]!.where).toContain('at 30, 40 mm, 80 x 40 mm')
    expect(part(moved.file, 'ppt/slides/slide1.xml')).toContain(`<a:off x="${10 * 36000}" y="${15 * 36000}"/>`)
  })
  test('duplicate_slide keeps a slide with mc:AlternateContent (one shape id in Choice and Fallback), also next to a new picture', () => {
    const sp = (name: string) => `<p:sp><p:nvSpPr><p:cNvPr id="77" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp>`
    const alt = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="p14">${sp('New')}</mc:Choice><mc:Fallback>${sp('Old')}</mc:Fallback></mc:AlternateContent>`
    const a = writeZip(readZip(deck()).map((e) => (e.name === 'ppt/slides/slide1.xml' ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('</p:spTree>', `${alt}</p:spTree>`)) } : e)))
    expect(edit('pptx', a, [{ duplicate_slide: { slide: 1 } }], []).report.added.some((n) => /slides\/slide\d+\.xml$/.test(n))).toBe(true)
    const both = edit('pptx', a, [{ duplicate_slide: { slide: 1 } }, { insert_picture: { image: 0, slide: 1 } }])
    expect(both.report.placed!.length).toBe(1)
  })
  test('a picture in a group with no size is refused, nothing is written', () => {
    const one = edit('pptx', deck(), [{ insert_picture: { image: 0, slide: 1, width_mm: 40 } }])
    const x = part(one.file, 'ppt/slides/slide1.xml').replace(/<p:pic\b[\s\S]*<\/p:pic>/, (m) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="900" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></p:grpSpPr>${m}</p:grpSp>`)
    const f = writeZip(readZip(one.file).map((e) => (e.name === 'ppt/slides/slide1.xml' ? { name: e.name, data: new TextEncoder().encode(x) } : e)))
    expect(() => edit('pptx', f, [{ move_picture: { slide: 1, picture: 1, x_mm: 5, y_mm: 5 } }], [])).toThrow(/cannot be moved/)
  })
  test('a picture that is not there is refused with the slide\'s pictures listed', () => {
    const one = edit('pptx', deck(), [{ insert_picture: { image: 0, slide: 1 } }])
    expect(() => edit('pptx', one.file, [{ move_picture: { slide: 1, picture: 'Nope', x_mm: 1 } }], [])).toThrow(/its pictures: 1 "Picture/)
    expect(() => edit('pptx', deck(), [{ insert_picture: { image: 0, slide: 99 } }])).toThrow(/there is no slide 99/)
  })
})

describe('Excel', () => {
  test('adds a picture at a cell, keeps the cells and the workbook part, and moves it', () => {
    const a = book()
    const sheet = XLSX.read(a, { bookSheets: true }).SheetNames[0]!
    const one = edit('xlsx', a, [{ insert_picture: { image: 0, sheet, cell: 'B3', offset_x_mm: 2, width_mm: 30 } }])
    untouched(a, one.file, one.report)
    expect(one.report.changed).not.toContain('xl/workbook.xml')
    expect(one.report.added.some((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))).toBe(true)
    const d = one.report.added.find((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))!
    expect(part(one.file, d)).toContain('<xdr:col>1</xdr:col><xdr:colOff>72000</xdr:colOff><xdr:row>2</xdr:row>')
    const two = edit('xlsx', one.file, [{ move_picture: { sheet, picture: 1, cell: 'D5', width_mm: 60 } }], [])
    expect(part(two.file, d)).toContain('<xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row>')
    expect(part(two.file, d)).toContain(`<xdr:ext cx="${60 * 36000}" cy="${30 * 36000}"/>`)
    expect(part(two.file, d).match(/oneCellAnchor>/g)!.length).toBe(2)
  })
  test('the new drawing tag goes before tableParts, and a twoCell picture can be moved', () => {
    const a = book(), w = readZip(a).find((e) => /^xl\/worksheets\/sheet1\.xml$/.test(e.name))!
    const x = new TextDecoder().decode(w.data).replace('</worksheet>', '<tableParts count="0"/></worksheet>')
    const withTable = writeZip(readZip(a).map((e) => (e.name === w.name ? { name: e.name, data: new TextEncoder().encode(x) } : e)))
    const one = edit('xlsx', withTable, [{ insert_picture: { image: 0, cell: 'A1' } }])
    const after = part(one.file, w.name)
    expect(after.indexOf('<drawing ')).toBeGreaterThan(-1)
    expect(after.indexOf('<drawing ')).toBeLessThan(after.indexOf('<tableParts'))
    const d = one.report.added.find((n) => /drawing\d+\.xml$/.test(n) && !n.includes('_rels'))!
    const two = part(one.file, d).replace('<xdr:oneCellAnchor>', '<xdr:twoCellAnchor editAs="oneCell">').replace('</xdr:oneCellAnchor>', '</xdr:twoCellAnchor>').replace(/<xdr:ext [^>]*\/>/, '<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>9</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>')
    const f = writeZip(readZip(one.file).map((e) => (e.name === d ? { name: e.name, data: new TextEncoder().encode(two) } : e)))
    const moved = edit('xlsx', f, [{ move_picture: { picture: 1, cell: 'C2' } }], [])
    expect(part(moved.file, d)).toContain('<xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col>')
    expect(part(moved.file, d)).not.toContain('twoCellAnchor')
  })
  test('a sheet or picture that is not there is refused with the choices', () => {
    expect(() => edit('xlsx', book(), [{ insert_picture: { image: 0, sheet: 'Nope', cell: 'A1' } }])).toThrow(/the sheets are/)
    expect(() => edit('xlsx', book(), [{ move_picture: { picture: 1, cell: 'A1' } }], [])).toThrow(/its pictures: none/)
  })
})
