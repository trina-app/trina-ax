// make_file: links in the Word, PowerPoint, Excel and PDF files it writes may only go to web pages (http, https), mail
// addresses (mailto) or places inside the document (QA TC-4949). pandoc wrote every Markdown link as it was: file:///
// ...exe, \\host\share, javascript:, ms-word:, search-ms:, ms-msdt:, ../../x.exe all became clickable links in the file.
// A team template from skills/ is checked too: its links, fields and outside references go into the file with it.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { which } from '../../server/src/config'
import { allowedLinkTarget, badField, checkOfficePackage, stripUnsafeLinks, wordFieldCodes } from '../../server/src/tools/office-links'
import { readZip, writeZip, type ZipEntry } from '../../server/src/files/zip-write'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)
const pandoc = which('pandoc')
const typst = process.env.MYCEL_TYPST_BIN ?? which('typst')

/** every hostile kind the row names, as the AI could write it in Markdown */
const HOSTILE = [
  'file:///C:/Windows/System32/calc.exe',
  'FILE:///c:/x.exe',
  'file://host/share/x.exe',
  '\\\\host\\share\\x.exe',
  '//host/share/x.exe',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'vbscript:msgbox(1)',
  'ms-word:ofe|u|https://evil.example/a.docx',
  'ms-excel:ofv|u|https://evil.example/a.xlsx',
  'search-ms:query=x&crumb=location:\\\\evil\\share',
  'ms-msdt:/id PCWDiagnostic /skip force',
  'ms-settings:',
  'data:text/html,<script>alert(1)</script>',
  'smb://host/share',
  'C:\\Windows\\calc.exe',
  'c:/x.exe',
  '../../x.exe',
  '..\\..\\x.exe',
  'x.exe',
  'report.pdf',
  '/etc/passwd',
  '%2e%2e/x.exe',
  'https:\\\\evil\\share',
  'http:/x',
  'https:///x',
  ' https://ok.example',
  'https://ok.example/\u202Eexe.pdf',
  '\u200Bfile:///c:/x.exe',
  'https://ok.example/a b',
  '#../x',
  '#a/b',
]
const PLAIN = ['https://example.com', 'http://example.com/a?b=1#c', 'HTTPS://EXAMPLE.COM/A', 'mailto:someone@example.com', 'mailto:a@b.c?subject=Hi%20there', '#top', '#section-2']

describe('allowedLinkTarget (pure)', () => {
  test('every hostile target is refused', () => { for (const t of HOSTILE) expect(allowedLinkTarget(t), t).toBe(false) })
  test('web pages, mail addresses and places in the document stay', () => { for (const t of PLAIN) expect(allowedLinkTarget(t), t).toBe(true) })
})

const link = (target: string, words = 'click') => ({ t: 'Link', c: [['', [], []], [{ t: 'Str', c: words }], [target, '']] })
describe('stripUnsafeLinks (pure)', () => {
  test('a bad link becomes its words; a good one stays; in footnotes, tables and metadata too', () => {
    const ast = {
      meta: { title: { t: 'MetaInlines', c: [link('file:///x.exe', 'title')] } },
      blocks: [
        { t: 'Para', c: [link('https://ok.example'), link('javascript:alert(1)', 'js'), { t: 'Note', c: [{ t: 'Para', c: [link('\\\\h\\s', 'note')] }] }] },
        { t: 'Table', c: [[{ t: 'Plain', c: [link('ms-msdt:x', 'cell')] }]] },
      ],
    }
    const dropped = stripUnsafeLinks(ast)
    expect(dropped.sort()).toEqual(['\\\\h\\s', 'file:///x.exe', 'javascript:alert(1)', 'ms-msdt:x'].sort())
    const s = JSON.stringify(ast)
    expect(s).toContain('https://ok.example')
    expect(s.match(/"t":"Link"/g)?.length).toBe(1)
    for (const w of ['title', 'js', 'note', 'cell']) expect(s).toContain(`{"t":"Span","c":[["",[],[]],[{"t":"Str","c":"${w}"}]]}`)
  })
  test('format characters in a dropped target are shown, not kept', () => {
    expect(stripUnsafeLinks({ blocks: [{ t: 'Para', c: [link('\u202Efile:x')] }] })).toEqual(['\\u{202e}file:x'])
  })
})

describe('Word fields (pure)', () => {
  test('HYPERLINK to anything but the web, mail or a bookmark; DDE and INCLUDE* fields', () => {
    for (const code of [' HYPERLINK "file:///c:/x.exe" ', 'HYPERLINK "\\\\\\\\host\\\\share\\\\x.exe"', 'hyperlink c:\\x.exe', 'HYPERLINK "ms-word:ofe|u|https://e/a"', 'HYPERLINK \\o "tip" "search-ms:query=a"', 'HYPERLINK "..\\\\x.exe"',
      'DDEAUTO c:\\windows\\system32\\cmd.exe "/k calc"', 'DDE "cmd" "x"', 'INCLUDEPICTURE "\\\\\\\\host\\\\a.png" \\d', 'INCLUDETEXT "c:\\\\x.docx"', 'IMPORT x', 'LINK Excel.Sheet "c:\\\\a.xlsx"'])
      expect(badField(code), code).not.toBeNull()
    expect(badField('HYPERLINK "https://x.example"', true)).toContain('another field')
    for (const code of ['HYPERLINK "https://example.com" \\o "tip"', 'HYPERLINK \\l "_Toc1"', 'HYPERLINK "mailto:a@b.c"', 'PAGE', ' NUMPAGES ', 'TOC \\o "1-3" \\h'])
      expect(badField(code), code).toBeNull()
  })
  test('complex fields are read across runs, entities decoded, nested fields seen; simple fields too', () => {
    const xml = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPER</w:instrText></w:r>' +
      '<w:r><w:instrText>LINK "&#102;ile:///c:/x.exe"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>x</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK "</w:instrText></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>QUOTE x</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' +
      '<w:fldSimple w:instr=" INCLUDEPICTURE &quot;\\\\h\\a.png&quot; "><w:r><w:t>p</w:t></w:r></w:fldSimple><x:instrText>ignored outside a field</x:instrText></w:p>'
    const codes = wordFieldCodes(xml)
    expect(codes.map((f) => f.code.trim())).toEqual(['HYPERLINK "file:///c:/x.exe"', 'QUOTE x', 'HYPERLINK "', 'INCLUDEPICTURE "\\\\h\\a.png"'])
    expect(codes.find((f) => f.code.startsWith('HYPERLINK "') && f.code.length < 12)!.nested).toBe(true)
    expect(codes.map((f) => badField(f.code, f.nested)).filter(Boolean).length).toBe(3)
  })
})

// ---- packages built by hand: what a template could bring
const enc = new TextEncoder()
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
function pkg(parts: Record<string, string>): Uint8Array {
  return writeZip(Object.entries(parts).map(([name, s]): ZipEntry => ({ name, data: enc.encode(s) })))
}
const rels = (...r: string[]) => `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}">${r.join('')}</Relationships>`
const baseDocx = (doc = '<w:document><w:body><w:p/></w:body></w:document>', docRels = rels()) => ({ '[Content_Types].xml': '<Types/>', 'word/document.xml': doc, 'word/_rels/document.xml.rels': docRels })

describe('checkOfficePackage (pure)', () => {
  test('an external hyperlink to a bad target, in Word, PowerPoint or Excel, is refused; entities are decoded', () => {
    for (const target of ['file:///c:/x.exe', '\\\\host\\share', '&#102;ile:///c:/x.exe', 'ms-msdt:x', '../x.exe', 'javascript:alert(1)']) {
      const r = rels(`<Relationship Id="rId9" Type="${R}hyperlink" Target="${target}" TargetMode="External"/>`)
      expect(() => checkOfficePackage(pkg(baseDocx(undefined, r)), 'docx'), target).toThrow(/nothing was saved/)
      expect(() => checkOfficePackage(pkg({ 'ppt/slides/_rels/slide1.xml.rels': r }), 'pptx'), target).toThrow(/a link to/)
      expect(() => checkOfficePackage(pkg({ 'xl/worksheets/_rels/sheet1.xml.rels': r }), 'xlsx'), target).toThrow(/a link to/)
    }
  })
  test('any other reference out of the file is refused (linked picture, OLE object, frame, prefixed or single-quoted)', () => {
    for (const rel of [`<Relationship Id="a" Type="${R}image" Target="\\\\host\\a.png" TargetMode="External"/>`, `<Relationship Id="a" Type="${R}oleObject" Target="https://evil.example/x" TargetMode="External"/>`,
      `<p:Relationship Id='a' Type='${R}frame' Target='file:///x' TargetMode='External'/>`, `<Relationship Id="a" Type="${R}image" Target="file:///c:/a.png"/>`])
      expect(() => checkOfficePackage(pkg(baseDocx(undefined, rels(rel))), 'docx'), rel).toThrow(/outside the file/)
  })
  test('a template attached by path (often C:\\Users\\...\\Normal.dotm, or a share) is taken out of a Word file', () => {
    const parts = { ...baseDocx(), 'word/settings.xml': '<w:settings xmlns:r="r"><w:attachedTemplate r:id="rId1"/><w:zoom/></w:settings>',
      'word/_rels/settings.xml.rels': rels(`<Relationship Id="rId1" Type="${R}attachedTemplate" Target="file:///\\\\evil\\share\\t.dotm" TargetMode="External"/>`) }
    const { bytes, changed } = checkOfficePackage(pkg(parts), 'docx')
    expect(changed).toBe(true)
    const got = new Map(readZip(bytes).map((e) => [e.name, new TextDecoder().decode(e.data)]))
    expect(got.get('word/_rels/settings.xml.rels')).not.toContain('evil')
    expect(got.get('word/settings.xml')).toBe('<w:settings xmlns:r="r"><w:zoom/></w:settings>')
  })
  test('a bad field anywhere in word/ is refused; good links, bookmarks and page fields stay unchanged', () => {
    const dde = '<w:document><w:body><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>DDEAUTO cmd "/k calc"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:body></w:document>'
    expect(() => checkOfficePackage(pkg(baseDocx(dde)), 'docx')).toThrow(/DDEAUTO field/)
    expect(() => checkOfficePackage(pkg({ ...baseDocx(), 'word/header1.xml': '<w:hdr><w:fldSimple w:instr="HYPERLINK &quot;file:///c:/x.exe&quot;"/></w:hdr>' }), 'docx')).toThrow(/HYPERLINK field/)
    const ok = pkg({ ...baseDocx('<w:document><w:body><w:p><w:hyperlink r:id="rId9"/><w:hyperlink w:anchor="top"/><w:fldSimple w:instr=" PAGE "/></w:p></w:body></w:document>',
      rels(`<Relationship Id="rId9" Type="${R}hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/>`, `<Relationship Id="rId1" Type="${R}styles" Target="styles.xml"/>`)) })
    const r = checkOfficePackage(ok, 'docx')
    expect(r.changed).toBe(false)
    expect(r.bytes).toBe(ok)
  })
})

// ---- the tool, with the real pandoc
let A: CApp
beforeAll(async () => { A = await makeCApp('sec-make-file-links') })
afterAll(async () => { await A.close() })
let rpcId = 0
async function call(args: unknown) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
  const r = (await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'make_file', arguments: args } })).result
  return { text: r.content[0].text as string, isError: !!r.isError }
}
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
/** every part of a package, as text */
const parts = (rel: string) => new Map(readZip(new Uint8Array(fs.readFileSync(file(rel)))).map((e) => [e.name, new TextDecoder().decode(e.data)]))
const allRels = (rel: string) => [...parts(rel)].filter(([n]) => n.endsWith('.rels')).map(([, s]) => s).join('\n')
/** Markdown with one link per hostile target, written as the AI would: [text](<target>) and <autolinks> */
const hostileMd = () => '# Links\n\n' + HOSTILE.map((t, i) => `- [bad ${i}](<${t.replace(/[<>]/g, '')}>)`).join('\n') +
  '\n- <file:///c:/auto.exe>\n- <a href="file:///c:/raw.exe">raw html</a>\n- [ref link][r]\n\n[r]: file:///c:/ref.exe\n'
const goodMd = '# Top {#top}\n\n[web](https://example.com/a?b=1) and <mailto:someone@example.com> and [back](#top) and <https://example.org>\n\n# Two\n\ntext[^1]\n\n[^1]: see [docs](https://docs.example.com)\n'

describe.skipIf(!pandoc)('make_file', () => {
  test('Word: every hostile link is kept as plain text, the AI is told, and no such target is in the file', async () => {
    const out = 'users/alice/links/hostile.docx'
    const r = await call({ format: 'docx', output: out, content: hostileMd() })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('kept as plain text')
    expect(r.text).toContain('file:///c:/auto.exe')
    // the only links left are the ones that were web addresses after all (pandoc writes <https://ok.example/a b> as a%20b)
    for (const m of allRels(out).matchAll(/Target="([^"]*)" TargetMode="External"/g)) expect(m[1]).toMatch(/^https:\/\/ok\.example\/[^\s\\]*$/)
    // the words stay (an autolink's words are its address, now plain text), but no link or field carries them
    expect(parts(out).get('word/document.xml')!.match(/<w:hyperlink\b/g)?.length ?? 0).toBe(1)
    expect(parts(out).get('word/document.xml')).not.toMatch(/instrText|fldSimple/)
    expect(allRels(out)).not.toMatch(/file:|javascript:|vbscript:|ms-msdt|ms-word|search-ms|\\\\host|\.\.\/x\.exe|raw\.exe/i)
    expect(parts(out).get('word/document.xml')).toContain('bad 0')
  })

  test('Word: web, mail, in-document and footnote links still work', async () => {
    const out = 'users/alice/links/good.docx'
    const r = await call({ format: 'docx', output: out, content: goodMd })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).not.toContain('plain text')
    const rs = allRels(out)
    for (const t of ['https://example.com/a?b=1', 'mailto:someone@example.com', 'https://example.org', 'https://docs.example.com']) expect(rs).toContain(`Target="${t}"`)
    expect(parts(out).get('word/document.xml')).toContain('w:anchor="_top"')
  })

  test('Word with colours and a page header (the finished file is checked too)', async () => {
    const out = 'users/alice/links/finished.docx'
    const r = await call({ format: 'docx', output: out, content: '# A\n\n[x]{color=red} [bad](file:///c:/x.exe) [ok](https://example.com)\n', page: { header: 'H', page_numbers: true } })
    expect(r.isError, r.text).toBe(false)
    expect(allRels(out)).not.toContain('file:')
    expect(allRels(out)).toContain('https://example.com')
  })

  test('PowerPoint: hostile links become text, plain ones and slide links stay', async () => {
    const out = 'users/alice/links/deck.pptx'
    const r = await call({ format: 'pptx', output: out, content: `# One {#one}\n\n- [bad](file:///c:/x.exe) [unc](<\\\\host\\share>) [msdt](ms-msdt:/id x)\n- [web](https://example.com) [mail](mailto:a@example.com)\n\n# Two\n\n- [back](#one)\n` })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('3 links were kept as plain text')
    const rs = allRels(out)
    expect(rs).not.toMatch(/file:|ms-msdt|host/)
    expect(rs).toContain('Target="https://example.com"')
    expect(rs).toContain('Target="mailto:a@example.com"')
  })

  test.skipIf(!typst)('PDF: a hostile link becomes text', async () => {
    const r = await call({ format: 'pdf', output: 'users/alice/links/a.pdf', content: '# A\n\n[x](file:///c:/x.exe) [y](https://example.com)\n' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('One link was kept as plain text')
    expect(fs.readFileSync(file('users/alice/links/a.pdf')).toString('latin1')).not.toContain('file:///c:/x.exe')
  })

  test('Excel: a Markdown link in a cell stays text (no link in the workbook); HYPERLINK formulas are refused', async () => {
    const out = 'users/alice/links/t.xlsx'
    const r = await call({ format: 'xlsx', output: out, content: '| a | b |\n|---|---|\n| [x](file:///c:/x.exe) | 1 |\n' })
    expect(r.isError, r.text).toBe(false)
    expect(allRels(out)).not.toMatch(/TargetMode="External"/)
    const f = await call({ format: 'xlsx', output: 'users/alice/links/f.xlsx', content: 'a,b\n"=HYPERLINK(""file:///c:/x.exe"",""x"")",1\n' })
    expect(f.isError).toBe(true)
    expect(fs.existsSync(file('users/alice/links/f.xlsx'))).toBe(false)
  })

  /** a template under skills/, made by pandoc and changed as a hostile one could be */
  function template(name: string, change: (p: Map<string, string>) => void): string {
    const base = file(`skills/links/${name}.src.docx`)
    fs.mkdirSync(path.dirname(base), { recursive: true })
    const md = path.join(path.dirname(base), `${name}.md`)
    fs.writeFileSync(md, '# x\n')
    expect(Bun.spawnSync([pandoc!, md, '-o', base]).exitCode).toBe(0)
    fs.rmSync(md)
    const entries = readZip(new Uint8Array(fs.readFileSync(base)))
    fs.rmSync(base)
    const p = new Map(entries.map((e) => [e.name, new TextDecoder().decode(e.data)]))
    change(p)
    const rel = `skills/links/${name}.docx`
    fs.writeFileSync(file(rel), writeZip([...p].map(([n, s]) => ({ name: n, data: enc.encode(s) }))))
    return rel
  }
  const withHeader = (p: Map<string, string>, header: string, extraRel = '') => {
    p.set('word/header1.xml', `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R.slice(0, -1)}">${header}</w:hdr>`)
    p.set('word/_rels/header1.xml.rels', rels(extraRel))
    p.set('word/_rels/document.xml.rels', p.get('word/_rels/document.xml.rels')!.replace('</Relationships>', `<Relationship Id="rIdH1" Type="${R}header" Target="header1.xml"/></Relationships>`))
    p.set('[Content_Types].xml', p.get('[Content_Types].xml')!.replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'))
    p.set('word/document.xml', p.get('word/document.xml')!.replace(/<w:sectPr\b[^>]*>/, (m) => `${m}<w:headerReference w:type="default" r:id="rIdH1"/>`))
  }

  test('a template with a file: link or a HYPERLINK / INCLUDEPICTURE field in its header is refused; nothing saved', async () => {
    const cases: [string, (p: Map<string, string>) => void, RegExp][] = [
      ['rel', (p) => withHeader(p, '<w:p><w:hyperlink r:id="rIdX"><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p>', `<Relationship Id="rIdX" Type="${R}hyperlink" Target="file:///c:/x.exe" TargetMode="External"/>`), /a link to "file:/],
      ['field', (p) => withHeader(p, '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "\\\\\\\\host\\\\share\\\\x.exe" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>x</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'), /HYPERLINK field/],
      ['picture', (p) => withHeader(p, '<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;\\\\\\\\host\\\\a.png&quot; \\d "><w:r><w:t>p</w:t></w:r></w:fldSimple></w:p>'), /INCLUDEPICTURE field/],
    ]
    for (const [name, change, why] of cases) {
      const tpl = template(name, change)
      const out = `users/alice/links/tpl-${name}.docx`
      const r = await call({ format: 'docx', output: out, content: '# Hello\n', template: tpl })
      expect(r.isError, `${name}: ${r.text}`).toBe(true)
      expect(r.text).toMatch(why)
      expect(r.text).toContain(tpl)
      expect(fs.existsSync(file(out))).toBe(false)
    }
  })

  test('a template attached by a network path keeps working: the file is saved without that reference', async () => {
    const tpl = template('attached', (p) => {
      p.set('word/settings.xml', p.get('word/settings.xml')!.replace(/(<w:settings\b[^>]*>)/, '$1<w:attachedTemplate r:id="rIdT"/>'))
      p.set('word/_rels/settings.xml.rels', rels(`<Relationship Id="rIdT" Type="${R}attachedTemplate" Target="file:///\\\\evil\\share\\t.dotm" TargetMode="External"/>`))
    })
    const out = 'users/alice/links/tpl-attached.docx'
    const r = await call({ format: 'docx', output: out, content: '# Hello\n\n[ok](https://example.com)\n', template: tpl })
    expect(r.isError, r.text).toBe(false)
    expect(allRels(out)).not.toContain('evil')
    expect(parts(out).get('word/settings.xml')).not.toContain('attachedTemplate')
    expect(allRels(out)).toContain('https://example.com')
  })
})
