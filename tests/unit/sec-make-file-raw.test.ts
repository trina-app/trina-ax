// make_file: raw markup for the writer is refused (QA TC-4941). pandoc copies a raw block of the output's own format
// into the file as it is: `<w:instrText>DDEAUTO ...</w:instrText>`{=openxml} became a DDE field in word/document.xml.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { makeHandler } from '../../server/src/mcp/protocol'
import { which } from '../../server/src/config'
import { checkRawMarkup } from '../../server/src/tools/make-file'
import { makeCApp, type CApp } from '../lib/c-app'

setDefaultTimeout(30_000)
const pandoc = which('pandoc')
const typst = process.env.MYCEL_TYPST_BIN ?? which('typst')

let A: CApp
beforeAll(async () => { A = await makeCApp('sec-make-file-raw') })
afterAll(async () => { await A.close() })

let rpcId = 0
async function call(args: unknown) {
  const h = makeHandler(A.ctx.files, A.ctx.db, A.toolCtx('alice', null))
  const r = (await h({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'make_file', arguments: args } })).result
  return { text: r.content[0].text as string, isError: !!r.isError }
}
const file = (rel: string) => path.join(A.team, ...rel.split('/'))
const documentXml = (rel: string) => new TextDecoder().decode(Bun.spawnSync(['unzip', '-p', file(rel), 'word/document.xml']).stdout)

const DDE_INLINE = 'Total: `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`{=openxml}\n'
const DDE_BLOCK = '# Report\n\n```{=openxml}\n<w:p><w:r><w:instrText>DDEAUTO cmd "/k calc"</w:instrText></w:r></w:p>\n```\n'

describe('checkRawMarkup (pure)', () => {
  test('openxml, typst, ooxml, opendocument and unknown formats are refused, inline, block or in metadata', () => {
    for (const fmt of ['openxml', 'OpenXML', 'typst', 'opendocument', 'rtf', 'ms', 'x']) {
      expect(() => checkRawMarkup({ blocks: [{ t: 'RawBlock', c: [fmt, '<x/>'] }] })).toThrow(/cannot go into a file made here/)
      expect(() => checkRawMarkup({ blocks: [{ t: 'Para', c: [{ t: 'RawInline', c: [fmt, '<x/>'] }] }] })).toThrow(/nothing was saved/)
    }
    expect(() => checkRawMarkup({ meta: { title: { t: 'MetaInlines', c: [{ t: 'RawInline', c: ['openxml', '<x/>'] }] } }, blocks: [] })).toThrow()
  })
  test('html and markdown stay; tex is emptied', () => {
    const ast: { blocks: { t: string; c: unknown }[] } = { blocks: [{ t: 'RawBlock', c: ['html', '<br>'] }, { t: 'RawBlock', c: ['tex', '\\newpage'] }, { t: 'Para', c: [{ t: 'RawInline', c: ['latex', '\\LaTeX'] }] }] }
    checkRawMarkup(ast)
    expect(ast.blocks[0]).toEqual({ t: 'RawBlock', c: ['html', '<br>'] })
    expect(ast.blocks[1]).toEqual({ t: 'Div', c: [['', [], []], []] })
    expect((ast.blocks[2]!.c as unknown[])[0]).toEqual({ t: 'Span', c: [['', [], []], []] })
  })
})

describe.skipIf(!pandoc)('make_file', () => {
  test('a DDE field as raw openxml (inline or block) is refused for Word and PowerPoint; nothing saved', async () => {
    for (const [format, content] of [['docx', DDE_INLINE], ['docx', DDE_BLOCK], ['pptx', `# Slide\n\n${DDE_INLINE}`]] as const) {
      const out = `users/alice/dde-${format}-${content.length}.${format}`
      const r = await call({ format, output: out, content })
      expect(r.isError, r.text).toBe(true)
      expect(r.text).toContain('raw openxml markup')
      expect(fs.existsSync(file(out))).toBe(false)
    }
  })

  test('from a team-folder .md source too', async () => {
    fs.mkdirSync(file('users/alice/in'), { recursive: true })
    fs.writeFileSync(file('users/alice/in/notes.md'), DDE_BLOCK)
    const r = await call({ format: 'docx', output: 'users/alice/from-source.docx', source: 'users/alice/in/notes.md' })
    expect(r.isError).toBe(true)
    expect(fs.existsSync(file('users/alice/from-source.docx'))).toBe(false)
  })

  test.skipIf(!typst)('raw typst code in a PDF is refused', async () => {
    const r = await call({ format: 'pdf', output: 'users/alice/raw.pdf', content: '# a\n\n`#read("in.md")`{=typst}\n' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('raw typst markup')
  })

  test('\\newpage and raw HTML still make a Word file, without either in it', async () => {
    const out = 'users/alice/ok.docx'
    const r = await call({ format: 'docx', output: out, content: '# One\n\ntext <br> more\n\n\\newpage\n\n# Two\n' })
    expect(r.isError, r.text).toBe(false)
    const doc = documentXml(out)
    expect(doc).toContain('Two')
    expect(doc).not.toContain('newpage')
    expect(doc).not.toContain('instrText')
  })
})
