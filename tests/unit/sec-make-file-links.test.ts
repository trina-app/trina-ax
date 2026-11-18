// make_file: links in the Word, PowerPoint, Excel and PDF files it writes may only go to web pages (http, https), mail
// addresses (mailto) or places inside the document (QA TC-4949). The finished package is checked in the office worker
// with a real XML parser (office-links-check.ts), so no quoting, prefix or ">" inside an attribute value can hide a
// file:, \\host\share, javascript:, ms-word:, search-ms: or ms-msdt: link, and no DDE / INCLUDE* / DATABASE / RD field.
// A PDF printed from an .html page or drawn from a deck has its link annotations filtered (pdf-links.ts). A team
// template that brings such a link is refused; an attached template (Normal.dotm) is taken out, not refused.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PDFArray, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { makeHandler } from '../../server/src/mcp/protocol'
import { which } from '../../server/src/config'
import { findPdfBrowser, htmlPdfUnavailable } from '../../server/src/files/html-pdf'
import { allowedLinkTarget, stripUnsafeLinks } from '../../server/src/tools/office-links'
import { fieldName, fieldProblem, SAFE_FIELDS, UNSAFE_FIELDS } from '../../server/src/files/office-rules'
import { fieldCodes } from '../../server/src/files/office-xml'
import { checkOfficeLinks } from '../../server/src/files/office-links-check'
import { sanitizePdfLinks } from '../../server/src/files/pdf-links'
import { readZip, writeZip, type ZipEntry } from '../../server/src/files/zip-write'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(40_000)
const pandoc = which('pandoc')
const typst = process.env.MYCEL_TYPST_BIN ?? which('typst')
const browser = !htmlPdfUnavailable() && findPdfBrowser()

/** every hostile kind the row names, as the AI could write it in Markdown */
const HOSTILE = [
  'file:///C:/Windows/System32/calc.exe', 'FILE:///c:/x.exe', 'file://host/share/x.exe', '\\\\host\\share\\x.exe',
  '//host/share/x.exe', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:msgbox(1)',
  'ms-word:ofe|u|https://evil.example/a.docx', 'ms-excel:ofv|u|https://evil.example/a.xlsx',
  'search-ms:query=x&crumb=location:\\\\evil\\share', 'ms-msdt:/id PCWDiagnostic /skip force', 'ms-settings:',
  'data:text/html,<script>alert(1)</script>', 'smb://host/share', 'C:\\Windows\\calc.exe', 'c:/x.exe', '../../x.exe',
  '..\\..\\x.exe', 'x.exe', 'report.pdf', '/etc/passwd', '%2e%2e/x.exe', 'https:\\\\evil\\share', 'http:/x',
  'https:///x', ' https://ok.example', 'https://ok.example/\u202Eexe.pdf', '\u200Bfile:///c:/x.exe',
  'https://ok.example/a b', '#../x', '#a/b', 'mailto:a@b.c?attach=/etc/passwd', 'mailto:a@b.c?attach=%5C%5Cevil%5Cs',
]
const PLAIN = ['https://example.com', 'http://example.com/a?b=1#c', 'HTTPS://EXAMPLE.COM/A', 'mailto:someone@example.com',
  'mailto:a@b.c?subject=Hi%20there&cc=x@y.z', 'mailto:?to=a@b.c&body=hello', '#top', '#section-2']

describe('allowedLinkTarget (pure)', () => {
  test('every hostile target is refused', () => { for (const t of HOSTILE) expect(allowedLinkTarget(t), t).toBe(false) })
  test('web pages, mail addresses (only to/cc/bcc/subject/body) and places in the document stay', () => { for (const t of PLAIN) expect(allowedLinkTarget(t), t).toBe(true) })
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
    expect(s.match(/"t":"Link"/g)?.length).toBe(1)
    for (const w of ['title', 'js', 'note', 'cell']) expect(s).toContain(`{"t":"Span","c":[["",[],[]],[{"t":"Str","c":"${w}"}]]}`)
  })
  test('format characters in a dropped target are shown, not kept', () => {
    expect(stripUnsafeLinks({ blocks: [{ t: 'Para', c: [link('\u202Efile:x')] }] })).toEqual(['\\u{202e}file:x'])
  })
})

// ---- fields
const fail = (p: string, w: string): never => { throw new Error(`${p} ${w}`) }
const fieldsOf = (xml: string) => fieldCodes(`<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${xml}</w:p>`, 'p', fail)
const complex = (instr: string[]) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r>${instr.map((i) => `<w:r><w:instrText xml:space="preserve">${i}</w:instrText></w:r>`).join('')}<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>x</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
const problem = (xml: string) => fieldsOf(xml).map(fieldProblem).find(Boolean) ?? null

describe('Word fields (pure)', () => {
  test('allow-list: only known-safe fields pass; the refused set and anything unknown do not', () => {
    for (const name of [...UNSAFE_FIELDS, 'DATABASE', 'RD', 'PRIVATE', 'LINK', 'IMPORT', 'GOTOR', 'MADEUPFIELD'])
      expect(problem(complex([`${name} x`])), name).not.toBeNull()
    for (const name of SAFE_FIELDS) if (name !== 'HYPERLINK' && name !== '=') expect(problem(complex([`${name} `])), name).toBeNull()
    expect(problem(`<w:fldSimple w:instr="=SUM(A1:A3)"/>`)).toBeNull()
  })
  test('N4: template placeholders, citations and shapes stay (MACROBUTTON, ADDIN, SHAPE fetch nothing)', () => {
    for (const code of ['MACROBUTTON NoMacro [Click here to type]', 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"a"}', 'ADDIN EN.CITE <EndNote/>', 'SHAPE  \\* MERGEFORMAT'])
      expect(problem(complex([code.replace(/</g, '&lt;').replace(/>/g, '&gt;')])), code).toBeNull()
  })
  test('HYPERLINK only to the web, mail or a bookmark', () => {
    for (const t of ['file:///c:/x.exe', 'ms-word:x', '..\\x.exe', '\\\\host\\s'])
      expect(problem(complex([`HYPERLINK "${t.replace(/\\/g, '\\\\')}"`])), t).toContain('HYPERLINK')
    for (const code of ['HYPERLINK "https://example.com" \\o "tip"', 'HYPERLINK \\l "_Toc1"', 'HYPERLINK "mailto:a@b.c"'])
      expect(problem(complex([code])), code).toBeNull()
  })
  test('a field whose name is built by a nested field is refused ({ {QUOTE ...} "...cmd.exe" })', () => {
    const inner = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>QUOTE 68 68 69</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
    const outer = `<w:r><w:fldChar w:fldCharType="begin"/></w:r>${inner}<w:r><w:instrText> "c:\\windows\\cmd.exe"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
    const codes = fieldsOf(outer)
    const outerField = codes.find((f) => f.nested)!
    expect(outerField.nestedName).toBe(true)
    expect(fieldProblem(outerField)).toContain('name is made by another field')
  })
  test('N1: a quote or backslash before the nested field does not count as the name; an empty name with a nested field is refused', () => {
    const quote = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>QUOTE 68 68 69</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
    for (const before of ['"', ' "', '\\', ' \\ "']) {
      const outer = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${before}</w:instrText></w:r>${quote}<w:r><w:instrText xml:space="preserve">" "c:\\cmd.exe"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`
      const f = fieldsOf(outer).find((x) => x.nested)!
      expect(f.nestedName, JSON.stringify(before)).toBe(true)
      expect(fieldProblem(f)).toContain('name is made by another field')
    }
    // an empty name with a field inside it is refused even when not flagged as the name
    expect(fieldProblem({ code: '  "" ', nested: true, nestedName: false })).toContain('name is made by another field')
    expect(fieldProblem({ code: '', nested: false, nestedName: false })).toBeNull()
  })
  test('complex field joined across runs; nested fields are their own codes', () => {
    expect(fieldsOf(complex([' DDE', 'AUTO c:\\x "a" '])).map((f) => fieldName(f.code))).toEqual(['DDEAUTO'])
  })
  test('F6: many unclosed instrText tags do not hang or crash', () => {
    const many = `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` + Array.from({ length: 5000 }, () => '<w:r><w:instrText>DDE a</w:instrText></w:r>').join('')
    const t0 = Date.now()
    expect(problem(many)).not.toBeNull()
    expect(Date.now() - t0).toBeLessThan(4000)
  })
})

// ---- packages built by hand (what a template or a bug could bring)
const enc = new TextEncoder()
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const pkg = (parts: Record<string, string>): Uint8Array => writeZip(Object.entries(parts).map(([name, s]): ZipEntry => ({ name, data: enc.encode(s) })))
const rels = (...r: string[]) => `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}">${r.join('')}</Relationships>`
const baseDocx = (doc = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>', docRels = rels()) =>
  ({ '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', 'word/document.xml': doc, 'word/_rels/document.xml.rels': docRels })

describe('checkOfficeLinks (worker, saxes)', () => {
  test('F1: a ">" inside the Target value does not hide a bad link; the prefixed duplicate does not either', () => {
    for (const r of [
      rels(`<Relationship Id="r1" Type="${R}hyperlink" Target="file:///C:/Windows/x.exe#>" TargetMode="External"/>`),
      rels(`<Relationship Id="r1" Type="${R}oleObject" Target="\\\\evil\\s\\a>" TargetMode="External"/>`),
      rels(`<Relationship Id="r1" Type="${R}image" Target="\\\\attacker.example\\s\\x.png?>" TargetMode="External"/>`),
      rels(`<Relationship xmlns:p="urn:x" Id="r1" Type="${R}hyperlink" Target="file:///C:/x.exe" TargetMode="External" p:Target="https://ok.example/"/>`),
    ]) expect(() => checkOfficeLinks('docx', pkg(baseDocx(undefined, r))), r).toThrow(/nothing was saved/)
  })
  test('external hyperlink to a bad target, in docx, pptx or xlsx; entities decoded', () => {
    for (const target of ['file:///c:/x.exe', '\\\\host\\share', '&#102;ile:///c:/x.exe', 'ms-msdt:x', '../x.exe', 'javascript:alert(1)']) {
      const r = rels(`<Relationship Id="rId9" Type="${R}hyperlink" Target="${target}" TargetMode="External"/>`)
      expect(() => checkOfficeLinks('docx', pkg(baseDocx(undefined, r))), target).toThrow(/nothing was saved/)
      expect(() => checkOfficeLinks('pptx', pkg({ 'ppt/slides/_rels/slide1.xml.rels': r })), target).toThrow(/a link to/)
      expect(() => checkOfficeLinks('xlsx', pkg({ 'xl/worksheets/_rels/sheet1.xml.rels': r })), target).toThrow(/a link to/)
    }
  })
  test('any other reference out of the file is refused, in a header, footer, numbering or theme rels', () => {
    for (const [part, rel] of [
      ['word/_rels/header1.xml.rels', `<Relationship Id="a" Type="${R}oleObject" Target="https://evil.example/x" TargetMode="External"/>`],
      ['word/_rels/footer1.xml.rels', `<Relationship Id="a" Type="${R}frame" Target="file:///x" TargetMode="External"/>`],
      ['word/_rels/numbering.xml.rels', `<Relationship Id="a" Type="${R}image" Target="\\\\host\\a.png" TargetMode="External"/>`],
      ['word/theme/_rels/theme1.xml.rels', `<Relationship Id="a" Type="${R}image" Target="file:///c:/a.png"/>`],
    ] as const) expect(() => checkOfficeLinks("docx", pkg({ ...baseDocx(), [part]: rels(rel) })), part).toThrow(/outside the file|an embedded object, a frame/)
  })
  test('a bad field anywhere in word/ (body, header, footnotes) is refused', () => {
    for (const part of ['word/document.xml', 'word/header1.xml', 'word/footnotes.xml']) {
      const xml = `<w:root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${complex(['DDEAUTO cmd "/k calc"'])}</w:p></w:root>`
      expect(() => checkOfficeLinks('docx', pkg({ ...baseDocx(), [part]: xml })), part).toThrow(/DDEAUTO field/)
    }
    expect(() => checkOfficeLinks('docx', pkg({ ...baseDocx(), 'word/header1.xml': `<w:h xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:fldSimple w:instr="RD &quot;\\\\h\\a.docx&quot;"/></w:h>` }))).toThrow(/RD field/)
  })
  test('N2: a field in a part outside word/, or with no instrText marker in its UTF-8 text, is found; UTF-16 is refused', () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    expect(() => checkOfficeLinks('docx', pkg({ ...baseDocx(), 'custom/body.dat': `<w:document xmlns:w="${W}"><w:body><w:p><w:fldSimple w:instr="INCLUDETEXT &quot;x&quot;"/></w:p></w:body></w:document>` }))).toThrow(/custom\/body\.dat has a INCLUDETEXT/)
    // the element name written with a character reference cannot be; but a prefix other than w: is read by namespace
    expect(() => checkOfficeLinks('docx', pkg({ ...baseDocx(), 'word/header2.xml': `<q:hdr xmlns:q="${W}"><q:p><q:fldSimple q:instr="DDEAUTO a b"/></q:p></q:hdr>` }))).toThrow(/DDEAUTO/)
    const u16 = new Uint8Array([0xff, 0xfe, ...Buffer.from(`<w:hdr xmlns:w="${W}"><w:fldSimple w:instr="DDEAUTO a b"/></w:hdr>`, 'utf16le')])
    expect(() => checkOfficeLinks('docx', writeZip([...readZip(pkg(baseDocx())), { name: 'word/header3.xml', data: u16 }]))).toThrow(/UTF-16/)
  })
  test('N3: a rebuilt settings.xml keeps tab, line feed and carriage return in a docVar value', () => {
    const val = 'line1&#10;line2&#9;tab&#13;cr'
    const parts = { ...baseDocx(),
      'word/settings.xml': `<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:attachedTemplate r:id="rId1"/><w:docVars><w:docVar w:name="v" w:val="${val}"/></w:docVars></w:settings>`,
      'word/_rels/settings.xml.rels': rels(`<Relationship Id="rId1" Type="${R}attachedTemplate" Target="file:///C:/Normal.dotm" TargetMode="External"/>`) }
    const out = new TextDecoder().decode(readZip(checkOfficeLinks('docx', pkg(parts))).find((e) => e.name === 'word/settings.xml')!.data)
    expect(out).not.toContain('attachedTemplate')
    expect(out).toContain(`w:val="${val}"`)
  })
  test('an attached template (Normal.dotm, or a share) is taken out; good links and page fields stay', () => {
    const parts = { ...baseDocx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:fldSimple w:instr=" PAGE "/></w:p></w:body></w:document>'),
      'word/settings.xml': '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:attachedTemplate r:id="rId1"/><w:zoom w:percent="100"/></w:settings>',
      'word/_rels/settings.xml.rels': rels(`<Relationship Id="rId1" Type="${R}attachedTemplate" Target="file:///\\\\evil\\share\\t.dotm" TargetMode="External"/>`) }
    const out = checkOfficeLinks('docx', pkg(parts))
    const got = new Map(readZip(out).map((e) => [e.name, new TextDecoder().decode(e.data)]))
    expect(got.get('word/_rels/settings.xml.rels')).not.toContain('evil')
    expect(got.get('word/_rels/settings.xml.rels')).not.toContain('attachedTemplate')
    expect(got.get('word/settings.xml')).not.toContain('attachedTemplate')
    expect(got.get('word/settings.xml')).toContain('w:zoom')
  })
  test('a clean file passes through unchanged (same bytes)', () => {
    const ok = pkg(baseDocx('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="rId9"/><w:fldSimple w:instr=" PAGE "/></w:p></w:body></w:document>',
      rels(`<Relationship Id="rId9" Type="${R}hyperlink" Target="https://example.com/?a=1&amp;b=2" TargetMode="External"/>`)))
    expect(checkOfficeLinks('docx', ok)).toBe(ok)
  })
})

// ---- the PDF link filter
async function pdfWith(uri: string, extraAction?: Record<string, unknown>): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  const page = d.addPage([200, 200])
  const action = d.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(uri) })
  const annot = d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 100, 20], A: action, ...(extraAction ? {} : {}) })
  page.node.set(PDFName.of('Annots'), d.context.obj([annot]))
  return await d.save()
}
const uriTargets = async (bytes: Uint8Array): Promise<string[]> => {
  const d = await PDFDocument.load(bytes)
  const out: string[] = []
  for (const [, o] of d.context.enumerateIndirectObjects()) void o
  for (const page of d.getPages()) {
    const annots = page.node.get(PDFName.of('Annots'))
    if (!(annots instanceof PDFArray)) continue
    for (const a of annots.asArray()) {
      const annot = d.context.lookup(a) as any
      const act = d.context.lookup(annot.get(PDFName.of('A'))) as any
      const uri = act?.get(PDFName.of('URI'))
      if (uri) out.push(uri.decodeText())
    }
  }
  return out
}

/** a PDF with the given dicts set on the catalog (OpenAction, AA, Outlines) or on a page (AA, Annots), built raw */
async function craftedPdf(build: (d: PDFDocument) => void): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  d.addPage([200, 200])
  build(d)
  return await d.save()
}
/** every action dict left in the PDF with its /S and its target (URI, F, JS) */
async function actionsIn(bytes: Uint8Array): Promise<string[]> {
  const d = await PDFDocument.load(bytes)
  const out: string[] = []
  const K = (k: string) => PDFName.of(k)
  for (const [, o] of d.context.enumerateIndirectObjects()) {
    const visit = (x: unknown) => {
      if (!(x instanceof Object) || !('get' in (x as object))) return
      const dict = x as any
      if (typeof dict.get !== 'function' || typeof dict.entries !== 'function') return
      const s = d.context.lookup(dict.get(K('S')))
      if (s instanceof PDFName) out.push(`${s.decodeText()} ${['URI', 'F', 'JS'].map((k) => { const v = d.context.lookup(dict.get(K(k))) as any; return v?.decodeText?.() ?? '' }).join('')}`)
      for (const [, v] of dict.entries()) if (!(v instanceof PDFName)) visit(v)
    }
    visit(o)
  }
  return out
}

describe('sanitizePdfLinks (pure)', () => {
  test('N5: GoToR, Launch, JavaScript in /OpenAction and /AA, a URI in an outline, an indirect /S: all made inert', async () => {
    const cases: [string, (d: PDFDocument) => void][] = [
      ['GoToR link', (d) => { d.getPage(0).node.set(PDFName.of('Annots'), d.context.obj([d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 9, 9], A: d.context.obj({ S: 'GoToR', F: PDFString.of('\\\\evil\\s\\a.pdf'), D: [0, 'Fit'] }) })])) }],
      ['Launch OpenAction', (d) => { d.catalog.set(PDFName.of('OpenAction'), d.context.obj({ S: 'Launch', F: PDFString.of('C:\\Windows\\calc.exe') })) }],
      ['JavaScript OpenAction', (d) => { d.catalog.set(PDFName.of('OpenAction'), d.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') })) }],
      ['JavaScript page AA', (d) => { d.getPage(0).node.set(PDFName.of('AA'), d.context.obj({ O: d.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(2)') }) })) }],
      ['catalog AA', (d) => { d.catalog.set(PDFName.of('AA'), d.context.obj({ WC: d.context.obj({ S: 'Launch', F: PDFString.of('x.exe') }) })) }],
      ['URI in an outline', (d) => {
        const item = d.context.register(d.context.obj({ Title: PDFString.of('go'), A: d.context.obj({ S: 'URI', URI: PDFString.of('file:///C:/x.exe') }) }))
        d.catalog.set(PDFName.of('Outlines'), d.context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }))
      }],
      ['indirect /S', (d) => {
        const s = d.context.register(PDFName.of('URI'))
        d.catalog.set(PDFName.of('OpenAction'), d.context.obj({ S: s, URI: d.context.register(PDFString.of('ms-msdt:/id x')) }))
      }],
    ]
    for (const [name, build] of cases) {
      const r = await sanitizePdfLinks(await craftedPdf(build))
      expect(r.removed, name).toBeGreaterThanOrEqual(1)
      const left = (await actionsIn(r.bytes)).filter((a) => a !== 'URI ')
      expect(left, name).toEqual([])
    }
    // an internal GoTo (a link to a page of the same PDF) is left alone
    const internal = await sanitizePdfLinks(await craftedPdf((d) => { d.catalog.set(PDFName.of('OpenAction'), d.context.obj({ S: 'GoTo', D: [d.getPage(0).ref, 'Fit'] })) }))
    expect(internal.removed).toBe(0)
  })
  test('a URI annotation to file:, a share or javascript: is made inert; a web link stays', async () => {
    for (const bad of ['file:///C:/x.exe', '\\\\host\\s\\x.exe', 'javascript:alert(1)', 'ms-msdt:x']) {
      const r = await sanitizePdfLinks(await pdfWith(bad))
      expect(r.removed, bad).toBe(1)
      expect(await uriTargets(r.bytes)).toEqual([''])
    }
    const ok = await sanitizePdfLinks(await pdfWith('https://example.com/a'))
    expect(ok.removed).toBe(0)
    expect(await uriTargets(ok.bytes)).toEqual(['https://example.com/a'])
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
const parts = (rel: string) => new Map(readZip(new Uint8Array(fs.readFileSync(file(rel)))).map((e) => [e.name, new TextDecoder().decode(e.data)]))
const allRels = (rel: string) => [...parts(rel)].filter(([n]) => n.endsWith('.rels')).map(([, s]) => s).join('\n')
const hostileMd = () => '# Links\n\n' + HOSTILE.map((t, i) => `- [bad ${i}](<${t.replace(/[<>]/g, '')}>)`).join('\n') +
  '\n- <file:///c:/auto.exe>\n- <a href="file:///c:/raw.exe">raw html</a>\n- [ref link][r]\n\n[r]: file:///c:/ref.exe\n'
const goodMd = '# Top {#top}\n\n[web](https://example.com/a?b=1) and <mailto:someone@example.com> and [back](#top) and <https://example.org>\n\n# Two\n\ntext[^1]\n\n[^1]: see [docs](https://docs.example.com)\n'

describe.skipIf(!pandoc)('make_file', () => {
  test('Word: hostile links kept as plain text, the AI told, no such target in the file', async () => {
    const out = 'users/alice/links/hostile.docx'
    const r = await call({ format: 'docx', output: out, content: hostileMd() })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('kept as plain text')
    expect(r.text).toContain('file:///c:/auto.exe')
    // every link in the file is one of the few that were real web addresses (pandoc writes <https://ok.example/a b> as a%20b); the rest are plain text, no field
    expect(parts(out).get('word/document.xml')).not.toMatch(/instrText|fldSimple/)
    for (const m of allRels(out).matchAll(/Target="([^"]*)" TargetMode="External"/g)) expect(m[1]).toMatch(/^https:\/\/ok\.example\/[^\s\\]*$/)
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
  test.skipIf(!typst)('PDF (typst): a hostile link becomes text', async () => {
    const r = await call({ format: 'pdf', output: 'users/alice/links/a.pdf', content: '# A\n\n[x](file:///c:/x.exe) [y](https://example.com)\n' })
    expect(r.isError, r.text).toBe(false)
    expect(r.text).toContain('One link was kept as plain text')
    expect(fs.readFileSync(file('users/alice/links/a.pdf')).toString('latin1')).not.toContain('file:///c:/x.exe')
  })
  test('Excel: a Markdown link in a cell stays text; HYPERLINK formulas are refused', async () => {
    const out = 'users/alice/links/t.xlsx'
    const r = await call({ format: 'xlsx', output: out, content: '| a | b |\n|---|---|\n| [x](file:///c:/x.exe) | 1 |\n' })
    expect(r.isError, r.text).toBe(false)
    expect(allRels(out)).not.toMatch(/TargetMode="External"/)
    const f = await call({ format: 'xlsx', output: 'users/alice/links/f.xlsx', content: 'a,b\n"=HYPERLINK(""file:///c:/x.exe"",""x"")",1\n' })
    expect(f.isError).toBe(true)
    expect(fs.existsSync(file('users/alice/links/f.xlsx'))).toBe(false)
  })

  // ---- templates, made by pandoc and changed as a hostile one could be
  function template(name: string, change: (p: Map<string, string>) => void): string {
    const md = file(`skills/links/${name}.md`)
    fs.mkdirSync(path.dirname(md), { recursive: true })
    fs.writeFileSync(md, '# x\n')
    const base = file(`skills/links/${name}.src.docx`)
    expect(Bun.spawnSync([pandoc!, md, '-o', base]).exitCode).toBe(0)
    fs.rmSync(md)
    const p = new Map(readZip(new Uint8Array(fs.readFileSync(base))).map((e) => [e.name, new TextDecoder().decode(e.data)]))
    fs.rmSync(base)
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
      ['rel', (p) => withHeader(p, '<w:p/>', `<Relationship Id="rIdX" Type="${R}hyperlink" Target="file:///c:/x.exe" TargetMode="External"/>`), /outside the file|link to/],
      ['field', (p) => withHeader(p, '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> HYPERLINK "\\\\\\\\host\\\\share\\\\x.exe" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'), /HYPERLINK/],
      ['picture', (p) => withHeader(p, '<w:p><w:fldSimple w:instr=" INCLUDEPICTURE &quot;\\\\\\\\host\\\\a.png&quot; \\d "/></w:p>'), /INCLUDEPICTURE/],
    ]
    for (const [name, change, why] of cases) {
      const tpl = template(name, change)
      const out = `users/alice/links/tpl-${name}.docx`
      const r = await call({ format: 'docx', output: out, content: '# Hello\n', template: tpl })
      expect(r.isError, `${name}: ${r.text}`).toBe(true)
      expect(r.text).toMatch(why)
      expect(fs.existsSync(file(out))).toBe(false)
    }
  })
  test('a template attached by a network path keeps working: saved without that reference', async () => {
    const tpl = template('attached', (p) => {
      p.set('word/settings.xml', p.get('word/settings.xml')!.replace(/(<w:settings\b[^>]*>)/, '$1<w:attachedTemplate r:id="rIdT"/>'))
      p.set('word/_rels/settings.xml.rels', rels(`<Relationship Id="rIdT" Type="${R}attachedTemplate" Target="file:///\\\\evil\\share\\t.dotm" TargetMode="External"/>`))
    })
    const out = 'users/alice/links/tpl-attached.docx'
    const r = await call({ format: 'docx', output: out, content: '# Hello\n\n[ok](https://example.com)\n', template: tpl })
    expect(r.isError, r.text).toBe(false)
    expect(allRels(out)).not.toContain('evil')
    expect([...parts(out).values()].join('\n')).not.toContain('attachedTemplate')
    expect(allRels(out)).toContain('https://example.com')
  })

  test.skipIf(!browser)('PDF from an .html page: file:, UNC and javascript: links are made inert', async () => {
    fs.mkdirSync(file('users/alice/html'), { recursive: true })
    fs.writeFileSync(file('users/alice/html/p.html'), '<!doctype html><meta charset="utf-8"><body><a href="file:///C:/x.exe">a</a> <a href="\\\\host\\s\\x.exe">b</a> <a href="javascript:alert(1)">c</a> <a href="https://example.com/ok">d</a></body>')
    const r = await call({ format: 'pdf', output: 'users/alice/html/p.pdf', source: 'users/alice/html/p.html' })
    expect(r.isError, r.text).toBe(false)
    const latin = fs.readFileSync(file('users/alice/html/p.pdf')).toString('latin1')
    expect(latin).not.toMatch(/file:\/\/\/C:\/x\.exe|host.s.x\.exe|javascript:alert/)
  })
})

