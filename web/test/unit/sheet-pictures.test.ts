// QA TC-8833: the spreadsheet preview shows the pictures anchored in a sheet (its drawing part), not only the cells.
// lib/sheetPictures.ts reads two-cell, one-cell and absolute anchors and pictures in groups, skips what it must not or
// cannot draw, and places each picture on the drawn table's grid.
import { describe, expect, test } from 'bun:test'
import * as XLSX from 'xlsx'
import { gridFromCells, parseXmlTree, picturesReach, placePicture, readSheetPictures, resolvePart, type SheetGrid } from '../../src/lib/sheetPictures'

const enc = (s: string) => new TextEncoder().encode(s)
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const NS = 'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const pic = (rid: string, o: { name?: string; hidden?: boolean; link?: boolean; xfrm?: [number, number, number, number] } = {}) =>
  `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="${o.name ?? 'Picture'}"${o.hidden ? ' hidden="1"' : ''}/><xdr:cNvPicPr/></xdr:nvPicPr>` +
  `<xdr:blipFill><a:blip ${o.link ? 'r:link' : 'r:embed'}="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
  `<xdr:spPr>${o.xfrm ? `<a:xfrm><a:off x="${o.xfrm[0]}" y="${o.xfrm[1]}"/><a:ext cx="${o.xfrm[2]}" cy="${o.xfrm[3]}"/></a:xfrm>` : ''}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`
const cell = (tag: string, col: number, colOff: number, row: number, rowOff: number) =>
  `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>${colOff}</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>${rowOff}</xdr:rowOff></xdr:${tag}>`

/** a workbook of two sheets with a drawing part each and their pictures, as a part reader */
function book(drawings: [string, string][], media: Record<string, Uint8Array> = { 'xl/media/image1.png': PNG }) {
  const parts: Record<string, Uint8Array> = {
    'xl/workbook.xml': enc(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="견적" sheetId="1" r:id="rId1"/><sheet name="Logo" sheetId="2" r:id="rId2"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': enc(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`),
    ...media,
  }
  drawings.forEach(([body, rels], i) => {
    const n = i + 1
    parts[`xl/worksheets/sheet${n}.xml`] = enc(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheetData/><drawing r:id="rIdD"/></worksheet>`)
    parts[`xl/worksheets/_rels/sheet${n}.xml.rels`] = enc(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdD" Type="${REL}/drawing" Target="../drawings/drawing${n}.xml"/></Relationships>`)
    parts[`xl/drawings/drawing${n}.xml`] = enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr ${NS}>${body}</xdr:wsDr>`)
    parts[`xl/drawings/_rels/drawing${n}.xml.rels`] = enc(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`)
  })
  return (p: string) => parts[p] ?? null
}
const rel = (id: string, target: string, external = false) => `<Relationship Id="${id}" Type="${REL}/image" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`
const EMU = 9525

describe('reading the pictures of each sheet', () => {
  test('two-cell, one-cell and absolute anchors, in the sheet they belong to', () => {
    const read = book([
      [`<xdr:twoCellAnchor editAs="oneCell">${cell('from', 1, 2 * EMU, 2, 3 * EMU)}${cell('to', 3, 0, 6, 10 * EMU)}${pic('rId1', { name: '도장' })}<xdr:clientData/></xdr:twoCellAnchor>` +
        `<xdr:absoluteAnchor><xdr:pos x="${100 * EMU}" y="${50 * EMU}"/><xdr:ext cx="${40 * EMU}" cy="${20 * EMU}"/>${pic('rId1')}<xdr:clientData/></xdr:absoluteAnchor>`, rel('rId1', '../media/image1.png')],
      [`<xdr:oneCellAnchor>${cell('from', 0, 0, 0, 0)}<xdr:ext cx="${120 * EMU}" cy="${60 * EMU}"/>${pic('rId7')}<xdr:clientData/></xdr:oneCellAnchor>`, rel('rId7', '../media/image2.jpeg')],
    ], { 'xl/media/image1.png': PNG, 'xl/media/image2.jpeg': Uint8Array.from([0xff, 0xd8, 0xff, 1]) })
    const all = readSheetPictures(read)
    expect([...all.keys()]).toEqual(['견적', 'Logo'])
    const [two, abs] = all.get('견적')!
    expect(two!.anchor).toEqual({ kind: 'two', from: { col: 1, row: 2, dx: 2, dy: 3 }, to: { col: 3, row: 6, dx: 0, dy: 10 } })
    expect([two!.type, two!.name, two!.bytes]).toEqual(['image/png', '도장', PNG])
    expect(abs!.anchor).toEqual({ kind: 'abs', x: 100, y: 50, w: 40, h: 20 })
    expect(all.get('Logo')![0]).toMatchObject({ anchor: { kind: 'one', from: { col: 0, row: 0, dx: 0, dy: 0 }, w: 120, h: 60 }, type: 'image/jpeg' })
  })

  test('a picture in a group takes its part of the group\'s anchor', () => {
    const read = book([[`<xdr:twoCellAnchor>${cell('from', 0, 0, 0, 0)}${cell('to', 4, 0, 4, 0)}<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="5" name="g"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>` +
      `<xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000" cy="1000"/><a:chOff x="1000" y="1000"/><a:chExt cx="2000" cy="1000"/></a:xfrm></xdr:grpSpPr>` +
      `${pic('rId1', { xfrm: [1000, 1000, 1000, 500] })}${pic('rId1', { xfrm: [2000, 1500, 1000, 500] })}</xdr:grpSp><xdr:clientData/></xdr:twoCellAnchor>`, rel('rId1', '../media/image1.png')]])
    const list = readSheetPictures(read).get('견적')!
    expect(list.map((p) => p.part)).toEqual([{ fx: 0, fy: 0, fw: 0.5, fh: 0.5 }, { fx: 0.5, fy: 0.5, fw: 0.5, fh: 0.5 }])
    const grid: SheetGrid = { firstCol: 0, firstRow: 0, cols: [0, 100, 200, 300], rows: [0, 20, 40, 60], right: 400, bottom: 80 }
    expect(placePicture(list[1]!, grid)).toEqual({ x: 200, y: 40, w: 200, h: 40 })
  })

  test('skipped: hidden, linked (never fetched), a format a browser cannot draw, a missing part, an external drawing', () => {
    const read = book([[
      `<xdr:oneCellAnchor>${cell('from', 0, 0, 0, 0)}<xdr:ext cx="1" cy="1"/>${pic('rId1', { hidden: true })}<xdr:clientData/></xdr:oneCellAnchor>` +
      `<xdr:oneCellAnchor>${cell('from', 0, 0, 0, 0)}<xdr:ext cx="1" cy="1"/>${pic('rId2', { link: true })}<xdr:clientData/></xdr:oneCellAnchor>` +
      `<xdr:oneCellAnchor>${cell('from', 0, 0, 0, 0)}<xdr:ext cx="1" cy="1"/>${pic('rId3')}<xdr:clientData/></xdr:oneCellAnchor>` +
      `<xdr:oneCellAnchor>${cell('from', 0, 0, 0, 0)}<xdr:ext cx="1" cy="1"/>${pic('rId4')}<xdr:clientData/></xdr:oneCellAnchor>` +
      `<xdr:oneCellAnchor>${cell('from', 0, 0, 0, 0)}<xdr:ext cx="1" cy="1"/>${pic('rId5')}<xdr:clientData/></xdr:oneCellAnchor>` +
      `<xdr:oneCellAnchor>${cell('from', 0, 0, 0, 0)}<xdr:ext cx="1" cy="1"/>${pic('rIdX')}<xdr:clientData/></xdr:oneCellAnchor>`,
      rel('rId1', '../media/image1.png') + rel('rId2', 'https://example.invalid/a.png', true) + rel('rId3', '../media/image3.emf') + rel('rId4', '../media/missing.png') + rel('rId5', 'https://example.invalid/b.png', true),
    ]], { 'xl/media/image1.png': PNG, 'xl/media/image3.emf': Uint8Array.from([1, 0, 0, 0]) })
    expect(readSheetPictures(read).size).toBe(0)
    // damaged parts: nothing, no throw
    expect(readSheetPictures(() => enc('<workbook><sheets>')).size).toBe(0)
    expect(readSheetPictures(() => null).size).toBe(0)
  })

  test('a workbook SheetJS writes (no drawing) has no pictures; part paths resolve like the package\'s', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 1]]), 'S')
    const zip = XLSX.CFB.read(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer), { type: 'array' }) as { FullPaths: string[]; FileIndex: { content?: Uint8Array }[] }
    const read = (p: string) => { const i = zip.FullPaths.findIndex((f) => f.replace(/^Root Entry\//, '') === p); return i < 0 ? null : (zip.FileIndex[i]!.content as Uint8Array) }
    expect(read('xl/workbook.xml')).not.toBeNull()
    expect(readSheetPictures(read).size).toBe(0)
    expect(resolvePart('xl/worksheets/sheet1.xml', '../drawings/drawing1.xml')).toBe('xl/drawings/drawing1.xml')
    expect(resolvePart('xl/drawings/drawing1.xml', '/xl/media/a.png')).toBe('xl/media/a.png')
    expect(resolvePart('xl/workbook.xml', './worksheets/s.xml')).toBe('xl/worksheets/s.xml')
  })

  test('the XML reader: nesting, prefixes, entities, comments; broken nesting is null', () => {
    const t = parseXmlTree('<?xml version="1.0"?><!-- c --><a:x p:q="1 &amp; 2"><b>t&lt;</b><c/></a:x>')!
    expect(t.kids[0]).toMatchObject({ name: 'a:x', local: 'x', attrs: { 'p:q': '1 & 2' } })
    expect(t.kids[0]!.kids.map((k) => [k.local, k.text])).toEqual([['b', 't<'], ['c', '']])
    expect(parseXmlTree('<a><b></a></b>')).toBeNull()
    expect(parseXmlTree('<a>')).toBeNull()
  })
})

describe('placing on the drawn table', () => {
  // columns 80 px from x 10, rows 24 px from y 5, starting at B2 (col 1, row 1)
  const grid: SheetGrid = { firstCol: 1, firstRow: 1, cols: [10, 90, 170], rows: [5, 29, 53], right: 250, bottom: 77 }
  test('two-cell: from one point to the other; an offset stays in its cell', () => {
    expect(placePicture({ anchor: { kind: 'two', from: { col: 1, row: 1, dx: 8, dy: 4 }, to: { col: 2, row: 3, dx: 500, dy: 0 } } }, grid)).toEqual({ x: 18, y: 9, w: 160 - 8, h: 53 - 9 })
  })
  test('one-cell: its own size; absolute: from the sheet\'s top left; past the drawn cells: 64 x 20 steps', () => {
    expect(placePicture({ anchor: { kind: 'one', from: { col: 3, row: 2, dx: 0, dy: 0 }, w: 50, h: 30 } }, grid)).toEqual({ x: 170, y: 29, w: 50, h: 30 })
    expect(placePicture({ anchor: { kind: 'one', from: { col: 5, row: 5, dx: 0, dy: 0 }, w: 50, h: 30 } }, grid)).toEqual({ x: 250 + 64, y: 77 + 20, w: 50, h: 30 })
    expect(placePicture({ anchor: { kind: 'abs', x: 100, y: 50, w: 40, h: 20 } }, grid)).toEqual({ x: 10 - 64 + 100, y: 5 - 20 + 50, w: 40, h: 20 })
  })
  test('the grid from drawn cells: merged cells give their edges, a column nobody starts in gets an even share', () => {
    const g = gridFromCells([
      { col: 0, row: 0, colSpan: 3, rowSpan: 1, x: 0, y: 0, w: 300, h: 20 },
      { col: 0, row: 1, colSpan: 1, rowSpan: 1, x: 0, y: 20, w: 100, h: 25 },
      { col: 2, row: 1, colSpan: 1, rowSpan: 1, x: 220, y: 20, w: 80, h: 25 },
    ], 0, 0, 2, 1)
    expect(g).toEqual({ firstCol: 0, firstRow: 0, cols: [0, 100, 220], rows: [0, 20], right: 300, bottom: 45 })
  })
  test('the cells the pictures reach, so the table is drawn that far', () => {
    expect(picturesReach([
      { anchor: { kind: 'two', from: { col: 2, row: 3, dx: 0, dy: 0 }, to: { col: 5, row: 9, dx: 0, dy: 0 } }, type: 'image/png', bytes: PNG, name: '' },
      { anchor: { kind: 'one', from: { col: 1, row: 4, dx: 0, dy: 0 }, w: 1, h: 1 }, type: 'image/png', bytes: PNG, name: '' },
      { anchor: { kind: 'abs', x: 0, y: 0, w: 1, h: 1 }, type: 'image/png', bytes: PNG, name: '' },
    ])).toEqual({ first: { col: 1, row: 3 }, last: { col: 5, row: 9 } })
    expect(picturesReach([])).toBeNull()
  })
})
