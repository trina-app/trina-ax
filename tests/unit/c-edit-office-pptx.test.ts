// edit_office for PowerPoint (server/src/files/pptx-edit.ts in the office worker; QA TC-4906): a slide title changed
// in its run's look, a shape's whole text set, a slide copied, a slide added from a layout, a picture replaced and fitted
// into its frame; masters, layouts, notes and every other slide stay byte for byte. The deck is made by pandoc (title
// slide, bullets, a picture, speaker notes) and saved again by LibreOffice when it is installed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { which } from '../../server/src/config'
import { officeEditRequest, officeVerifyRequest, frame, unframe, Pkg, type EditReport } from '../../server/src/files/office-edit'
import { imageInfo, pptxParagraphTexts } from '../../server/src/files/pptx-edit'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { readCentral, entryData } from '../../server/src/files/zip-guard'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const soffice = which('soffice') ?? which('libreoffice')
const withPandoc = pandoc ? test : test.skip

function png(w: number, h: number, rgb = [255, 0, 0]): Uint8Array {
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])))
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}
function deck(): Uint8Array {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-deck-'))
  try {
    fs.writeFileSync(path.join(dir, 'logo.png'), png(40, 20))
    fs.writeFileSync(path.join(dir, 'd.md'), '% Q3 Plan\n\n# Goals\n\n- Grow sales\n- Hire two people\n\n::: notes\nSay hello\n:::\n\n# Logo\n\n![logo](logo.png)\n')
    const r = Bun.spawnSync([pandoc!, 'd.md', '-o', 'd.pptx'], { cwd: dir })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return new Uint8Array(fs.readFileSync(path.join(dir, 'd.pptx')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
function viaOffice(b: Uint8Array): Uint8Array {
  if (!soffice) return b
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-'))
  try {
    fs.writeFileSync(path.join(dir, 'in.pptx'), b)
    const r = Bun.spawnSync([soffice, `-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pptx:Impress MS PowerPoint 2007 XML', '--outdir', path.join(dir, 'out'), path.join(dir, 'in.pptx')])
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return new Uint8Array(fs.readFileSync(path.join(dir, 'out', 'in.pptx')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
/** LibreOffice opens the deck and prints it; the PDF's text (pdftotext) and its page count */
function inOffice(b: Uint8Array): { text: string; pages: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-open-'))
  try {
    fs.writeFileSync(path.join(dir, 'x.pptx'), b)
    const r = Bun.spawnSync([soffice!, `-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'x.pptx')])
    const pdf = path.join(dir, 'x.pdf')
    if (r.exitCode !== 0 || !fs.existsSync(pdf)) throw new Error(`LibreOffice could not open it: ${r.stderr.toString().slice(0, 300)}`)
    const t = which('pdftotext') ? Bun.spawnSync([which('pdftotext')!, pdf, '-']).stdout.toString() : ''
    const pages = (fs.readFileSync(pdf, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    return { text: t, pages }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const part = (b: Uint8Array, name: string) => { const e = readZip(b).find((x) => x.name === name); return e ? new TextDecoder().decode(e.data) : null }
function changedParts(a: Uint8Array, b: Uint8Array): string[] {
  const ra = new Map(readCentral(a).map((e) => [new TextDecoder().decode(e.nameBytes), Buffer.from(entryData(a, e))]))
  const rb = new Map(readCentral(b).map((e) => [new TextDecoder().decode(e.nameBytes), Buffer.from(entryData(b, e))]))
  return [...new Set([...ra.keys(), ...rb.keys()])].filter((n) => !ra.get(n) || !rb.get(n) || !ra.get(n)!.equals(rb.get(n)!)).sort()
}
function run(b: Uint8Array, changes: unknown[], images: Uint8Array[] = []): { file: Uint8Array; report: EditReport } {
  const out = unframe<EditReport>(officeEditRequest(frame({ kind: 'pptx', changes }, [b, ...images])))
  const file = out.blobs[0]!
  officeVerifyRequest(frame({ kind: 'pptx', changed: out.json.changed, added: out.json.added, notes: out.json.notes }, [b, file]))
  return { file, report: out.json }
}
const texts = (b: Uint8Array) => pptxParagraphTexts(new Pkg(b, 'pptx')).filter((t) => t !== '')

describe('edit_office: PowerPoint decks', () => {
  withPandoc('a slide title changed in place: only that slide changes; the others, the master, the notes stay', () => {
    const before = viaOffice(deck())
    const { file, report } = run(before, [{ find: 'Goals', replace: 'Goals for Q4', slide: 2 }])
    const changed = changedParts(before, file)
    expect(changed.length).toBe(1)
    expect(changed[0]).toMatch(/^ppt\/slides\/slide\d+\.xml$/)
    expect(texts(file)).toContain('Goals for Q4')
    expect(report.notes[0]).toMatchObject({ where: 'slide 2', before: 'Goals', after: ['Goals for Q4'] })
    if (soffice) { const o = inOffice(file); if (o.text) expect(o.text).toContain('Goals for Q4') }
  })

  withPandoc('shape_text sets a body in its first paragraph\'s look; an unknown shape lists the slide\'s shapes', () => {
    const before = deck()
    const { file } = run(before, [{ shape_text: { slide: 2, shape: 'body', text: 'Grow sales 20%\nHire three people\nOpen Busan office' } }])
    const t = texts(file)
    expect(t).toEqual(expect.arrayContaining(['Grow sales 20%', 'Hire three people', 'Open Busan office']))
    expect(t).not.toContain('Hire two people')
    expect(() => run(before, [{ shape_text: { slide: 2, shape: 'Chart 9', text: 'x' } }])).toThrow(/its text shapes: 1 .*title/)
    expect(() => run(before, [{ find: 'Goals', replace: 'a\nb' }])).toThrow(/line break/)
  })

  withPandoc('duplicate a slide and add one from a layout: the deck has two more slides in the right places', () => {
    const before = viaOffice(deck())
    const { file, report } = run(before, [
      { duplicate_slide: { slide: 2 } },
      // slide numbers are the deck's as read: both go after slide 2, in the order of the changes
      { add_slide: { layout: 'Title and Content', after: 2, title: 'Budget', body: 'Rent\nTravel' } },
    ])
    const order = pptxParagraphTexts(new Pkg(file, 'pptx')).filter((t) => t)
    expect(order.filter((t) => t === 'Goals').length).toBe(2)
    expect(order.indexOf('Budget')).toBe(order.lastIndexOf('Hire two people') + 1)
    expect(order.slice(order.indexOf('Budget'), order.indexOf('Budget') + 3)).toEqual(['Budget', 'Rent', 'Travel'])
    expect(order.indexOf('Logo')).toBeGreaterThan(order.indexOf('Travel'))
    expect(report.added.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length).toBe(2)
    // the copy has no speaker notes of its own
    const copyRels = report.added.find((n) => n.endsWith('.xml.rels'))!
    expect(part(file, copyRels)).not.toContain('notesSlide')
    expect(() => run(before, [{ add_slide: { layout: 'Nope' } }])).toThrow(/its layouts: .*Title and Content/)
    // a slide with a picture linked from outside the file is not copied (QA TC-4948)
    const link = '<Relationship Id="rIdL1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://evil.example/x.png" TargetMode="External"/>'
    const linked = writeZip(readZip(before).map((e) => (/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(e.name) ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('</Relationships>', `${link}</Relationships>`)) } : e)))
    expect(() => run(linked, [{ duplicate_slide: { slide: 2 } }])).toThrow(/image from outside the file/)
    // a plain hyperlink goes along
    expect(() => run(writeZip(readZip(before).map((e) => (/^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(e.name) ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace('</Relationships>', `${link.replace('/image"', '/hyperlink"')}</Relationships>`)) } : e))), [{ duplicate_slide: { slide: 2 } }])).not.toThrow()
    if (soffice) { const o = inOffice(file); expect(o.pages).toBe(5); if (o.text) expect(o.text).toContain('Budget') }
  })

  withPandoc('replace a picture: a new image part, fitted into the old frame; the old image stays', () => {
    const before = deck()
    const { file, report } = run(before, [{ replace_picture: { slide: 3, picture: 1, image: 0 } }], [png(20, 40, [0, 0, 255])])
    expect(report.added.some((n) => /^ppt\/media\/image\d+\.png$/.test(n))).toBe(true)
    expect(part(file, 'ppt/media/image1.png')).not.toBeNull()
    const slide = report.changed.find((n) => /slide\d+\.xml$/.test(n))!
    const x = part(file, slide)!
    // a tall image in a wide frame: the frame's height, a narrower width, centred
    const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(x.slice(x.indexOf('<p:pic')))!
    expect(Number(ext[2]) / Number(ext[1])).toBeCloseTo(2, 2)
    expect(() => run(before, [{ replace_picture: { slide: 3, picture: 'Missing', image: 0 } }], [png(2, 2)])).toThrow(/its pictures: 1 /)
    expect(() => run(before, [{ replace_picture: { slide: 3, picture: 1, image: 0 } }], [new TextEncoder().encode('not an image')])).toThrow(/not a PNG/)
    if (soffice) inOffice(file)
  })

  withPandoc('relationship ids with single quotes are read: a new picture gets an id the slide does not use yet; the verifier checks ids are unique', () => {
    const before = deck()
    const quoted = writeZip(readZip(before).map((e) => (/^ppt\/slides\/_rels\//.test(e.name) ? { name: e.name, data: new TextEncoder().encode(new TextDecoder().decode(e.data).replace(/Id="(rId\d+)"/g, "Id = '$1'")) } : e)))
    const { file, report } = run(quoted, [{ replace_picture: { slide: 3, picture: 1, image: 0 } }], [png(4, 4)])
    const rels = part(file, report.changed.find((n) => n.endsWith('.rels'))!)!
    const ids = [...rels.matchAll(/Id\s*=\s*["']([^"']+)["']/g)].map((m) => m[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('image sizes from their headers', () => {
    expect(imageInfo(png(7, 3))).toEqual({ ext: 'png', type: 'image/png', w: 7, h: 3 })
    expect(imageInfo(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 5, 0, 9, 0, 0, 0]))).toMatchObject({ ext: 'gif', w: 5, h: 9 })
    expect(imageInfo(new TextEncoder().encode('hello world'))).toBeNull()
  })
})
