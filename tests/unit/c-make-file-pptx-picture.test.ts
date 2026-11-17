// make_file pptx: a photo added to a slide that has text (TC-4445). pandoc put such a slide on its "Content with
// Caption" layout: a small bold title, the text in the small caption box without bullets, and the photo's alt text
// written again as a caption under the photo. Now the slide is drawn like the deck's other slides (title and bullets
// from the layout) with the photo beside the text and no caption.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { makeHandler } from '../../server/src/mcp/protocol'
import { pictureBesideText } from '../../server/src/tools/pptx-picture'
import { which } from '../../server/src/config'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)
const pandoc = which('pandoc')

let A: CApp
beforeAll(async () => {
  A = await makeCApp('c-make-file-pptx-picture')
  fs.mkdirSync(file('users/alice/photos'), { recursive: true })
  fs.writeFileSync(file('users/alice/photos/IMG_2041.png'), png(40, 30))
})
afterAll(async () => { await A.close() })

/** a small solid PNG */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(t))
    return Buffer.concat([len, t, sum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

let rpcId = 0
async function make(args: Record<string, unknown>) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
  const r = await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'make_file', arguments: args } })
  return { text: r.result.content[0].text as string, isError: !!r.result.isError }
}
function file(rel: string) { return path.join(A.team, ...rel.split('/')) }
/** slide N's XML and the layout it uses */
function slidePart(rel: string, n: number) {
  const out = fs.mkdtempSync(path.join(A.data, 'unzip-'))
  Bun.spawnSync(['unzip', '-o', '-q', file(rel), '-d', out])
  const xml = fs.readFileSync(path.join(out, `ppt/slides/slide${n}.xml`), 'utf8')
  const rels = fs.readFileSync(path.join(out, `ppt/slides/_rels/slide${n}.xml.rels`), 'utf8')
  const layoutFile = /slideLayouts\/(slideLayout\d+\.xml)/.exec(rels)![1]!
  const layout = /<p:cSld name="([^"]*)"/.exec(fs.readFileSync(path.join(out, 'ppt/slideLayouts', layoutFile), 'utf8'))?.[1]
  const notes = /notesSlides\//.test(rels)
  return { xml, layout, notes }
}
const texts = (xml: string) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1])

const deck = (picture: string) =>
  '## Eco line\n\nGanada Office\n\n' +
  '## Products\n\n- Recycled paper\n- Refill pens\n- Goal: 30 clients\n\n' + picture + '\n\n::: notes\nsay hello\n:::\n'

describe.skipIf(!pandoc)('make_file pptx: a photo on a slide with text (TC-4445)', () => {
  test('the slide keeps the layout title and bullets, and the alt text is not drawn as a caption', async () => {
    const r = await make({ content: deck('![Pen sample (example)](users/alice/photos/IMG_2041.png)'), format: 'pptx', output: 'users/alice/deck/photo.pptx', expected_slides: 2, expected_notes: 1 })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain("2 slides, 1 with speaker notes: 1 'Eco line', 2 'Products'")
    const s = slidePart('users/alice/deck/photo.pptx', 2)
    // the picture is there, beside the text, on a layout whose text placeholder has bullets
    expect(s.xml).toContain('<p:pic>')
    expect(s.layout).toBe('Two Content')
    // the title takes the layout's place and size (no small caption title box)
    const title = s.xml.split('<p:sp>').find((sp) => /<p:ph type="title"/.test(sp))!
    expect(title).not.toContain('<a:xfrm>')
    // the text is in a content placeholder, not the small caption box, and keeps its bullets
    const body = s.xml.split('<p:sp>').find((sp) => sp.includes('Recycled paper'))!
    expect(body).not.toMatch(/<p:ph type="body"/)
    expect(body).not.toContain('<a:buNone')
    expect(body).not.toMatch(/sz="\d+"/)
    // no caption under the photo: its alt text appears nowhere on the slide
    expect(texts(s.xml)).toEqual(['Products', 'Recycled paper', 'Refill pens', 'Goal: 30 clients'])
    expect(s.notes).toBe(true)
  })

  test('two photos beside text: none is dropped', async () => {
    const md = '## Products\n\n- a\n\n![one](users/alice/photos/IMG_2041.png)\n\n![two](users/alice/photos/IMG_2041.png)\n'
    const r = await make({ content: md, format: 'pptx', output: 'users/alice/deck/two.pptx', expected_slides: 1 })
    expect(r.isError, r.text).toBe(false)
    expect(slidePart('users/alice/deck/two.pptx', 1).xml.split('<p:pic>').length - 1).toBe(2)
  })

  test('a slide with only a photo, and a deck without photos, are made as before', async () => {
    const r = await make({ content: '## Cover\n\n![Cover photo](users/alice/photos/IMG_2041.png)\n\n## Text\n\n- a\n- b\n', format: 'pptx', output: 'users/alice/deck/plain.pptx', expected_slides: 2 })
    expect(r.isError, r.text).toBe(false)
    const pic = slidePart('users/alice/deck/plain.pptx', 1)
    expect(pic.xml).toContain('<p:pic>')
    expect(pic.layout).not.toBe('Two Content')
    expect(slidePart('users/alice/deck/plain.pptx', 2).layout).toBe('Title and Content')
  })
})

describe('pictureBesideText', () => {
  const h = (l: number, s = 'T') => ({ t: 'Header', c: [l, ['', [], []], [{ t: 'Str', c: s }]] })
  const para = (s: string) => ({ t: 'Para', c: [{ t: 'Str', c: s }] })
  const img = (alt: string) => ({ t: 'Image', c: [['', [], []], [{ t: 'Str', c: alt }], ['p.png', '']] })
  const figure = (alt: string) => ({ t: 'Figure', c: [['', [], []], [null, [{ t: 'Plain', c: [{ t: 'Str', c: alt }] }]], [{ t: 'Plain', c: [img(alt)] }]] })
  const notes = { t: 'Div', c: [['', ['notes'], []], [para('n')]] }
  const cls = (b: any) => b.c[0][1]

  test('text then picture: two columns (text left), picture without alt, notes outside the columns', () => {
    const ast = { blocks: [h(2, 'A'), para('x'), figure('cap'), notes, h(2, 'B'), para('y')] as any[] }
    pictureBesideText(ast, 2)
    expect(ast.blocks.map((b) => b.t)).toEqual(['Header', 'Div', 'Div', 'Header', 'Para'])
    const [cols, n] = [ast.blocks[1], ast.blocks[2]]
    expect(cls(cols)).toEqual(['columns'])
    expect(cls(n)).toEqual(['notes'])
    const [left, right] = cols.c[1]
    expect(left.c[1]).toEqual([para('x')])
    expect(right.c[1]).toEqual([{ t: 'Para', c: [{ t: 'Image', c: [['', [], []], [], ['p.png', '']] }] }])
  })

  test('picture first stays on the left; an image-only paragraph counts as a picture', () => {
    const ast = { blocks: [h(2), { t: 'Para', c: [img('a')] }, para('x')] as any[] }
    pictureBesideText(ast, 2)
    const [left, right] = ast.blocks[1].c[1]
    expect(left.c[1][0].c[0].c[1]).toEqual([])
    expect(right.c[1]).toEqual([para('x')])
  })

  test('left alone: picture only, text only, a picture inside a sentence, existing columns', () => {
    const cases = [
      [h(2), figure('a')],
      [h(2), para('x')],
      [h(2), { t: 'Para', c: [{ t: 'Str', c: 'see' }, { t: 'Space' }, img('a')] }],
      [h(2), para('x'), figure('a'), { t: 'Div', c: [['', ['columns'], []], []] }],
      // pandoc draws only the first picture of a column, so two pictures stay where pandoc puts them
      [h(2), para('x'), figure('a'), figure('b')],
      [h(2), para('x'), { t: 'Para', c: [img('a'), { t: 'Space' }, img('b')] }],
      // a table in the text column would go on the Comparison layout (text in its small heading box)
      [h(2), para('x'), { t: 'Table', c: [] }, figure('a')],
    ]
    for (const blocks of cases) {
      const before = JSON.stringify(blocks)
      const ast = { blocks: JSON.parse(before) }
      pictureBesideText(ast, 2)
      expect(JSON.stringify(ast.blocks)).toBe(before)
    }
  })

  test('slides end at headings up to the slide level and at rules; deeper headings stay in the slide', () => {
    const ast = { blocks: [h(2), para('x'), { t: 'HorizontalRule' }, figure('a'), h(3, 'sub'), para('y'), h(2), figure('b')] as any[] }
    pictureBesideText(ast, 2)
    expect(ast.blocks.map((b) => b.t)).toEqual(['Header', 'Para', 'HorizontalRule', 'Div', 'Header', 'Figure'])
    const [left, right] = ast.blocks[3].c[1]
    expect(left.c[1][0].t).toBe('Para')
    expect(right.c[1].map((b: any) => b.t)).toEqual(['Header', 'Para'])
  })
})
