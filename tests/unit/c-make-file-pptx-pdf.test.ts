// make_file with a .pptx `source` and format pdf (AI flow check FL-15, QA TC-3816): the deck is drawn by the server with
// a page per shown slide (server/src/files/pptx-html.ts, in the office worker) and printed by the headless browser
// (files/html-pdf.ts). Before, the AI rewrote the slides as a one-page Markdown document. The drawing keeps the slide
// size, places, text, bullets, pictures and tables; hidden slides are left out; charts and diagrams are counted and
// said. Text is escaped, and the page loads only the deck's own pictures. Prints are skipped where no browser runs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import * as XLSX from 'xlsx'
import { API } from '@mycel/shared/api'
import { makeFileRule } from '../../server/src/chat/prompt'
import { which } from '../../server/src/config'
import { htmlPdfUnavailable } from '../../server/src/files/html-pdf'
import { pptxSlidesHtml } from '../../server/src/files/pptx-html'
import { deckPdfResultText, HTML_PDF_HINT, HTML_PDF_OFF_HINT } from '../../server/src/tools/make-file'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(90_000)
const pandoc = which('pandoc')
const PRINTS = htmlPdfUnavailable() === null && !!pandoc
const prints = PRINTS ? test : test.skip
const withPandoc = pandoc ? test : test.skip
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64')

/** A deck from Markdown (pandoc), run in `dir` so a picture path resolves. */
function deck(md: string, dir?: string): Uint8Array {
  const r = Bun.spawnSync([pandoc!, '-f', 'markdown', '-t', 'pptx', '-o', '-'], { stdin: Buffer.from(md), cwd: dir })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return new Uint8Array(r.stdout)
}
/** The zip with parts changed (`edit` gets the old text of a part). */
function withParts(bytes: Uint8Array, edit: Record<string, (old: string) => string>): Uint8Array {
  const c = XLSX.CFB.read(Buffer.from(bytes), { type: 'buffer' })
  for (const [name, f] of Object.entries(edit)) {
    const i = c.FullPaths.indexOf('Root Entry/' + name)
    if (i < 0) throw new Error(`no part ${name}`)
    c.FileIndex[i]!.content = Buffer.from(f(Buffer.from(c.FileIndex[i]!.content as Uint8Array).toString('utf8')), 'utf8')
  }
  return new Uint8Array(XLSX.CFB.write(c, { fileType: 'zip', type: 'buffer' }) as Buffer)
}
const THREE = '## 2027 친환경 신제품 소개\n\n가나다오피스\n\n## 일정\n\n- 12월: 샘플 제작\n- 1월: 시연\n    - 주요 거래처\n\n## 가격\n\n| 항목 | 가격 |\n|---|---|\n| 복사용지 | 27,000원 |\n'

describe('a deck drawn as a page per slide (pptx-html.ts)', () => {
  withPandoc('every slide is a page at the deck\'s size, with its text, bullets and table', () => {
    const r = pptxSlidesHtml(deck(THREE))
    expect(r.slides).toBe(3)
    expect(r.hidden).toBe(0)
    expect(r.html.match(/<section class="s"/g)!.length).toBe(3)
    // pandoc's 16:9 deck: 10 x 5.625 in
    expect(r.html).toContain('@page{size:10.0000in 5.6250in;margin:0}')
    for (const t of ['2027 친환경 신제품 소개', '12월: 샘플 제작', '주요 거래처', '27,000원']) expect(r.html).toContain(t)
    expect(r.html).toContain('<table>')
    // the list's items have a bullet; the title has none
    expect(r.html).toMatch(/>•<\/span><span[^>]*>12월: 샘플 제작/)
    expect(r.html).not.toMatch(/•<\/span><span[^>]*>일정/)
    expect(r.notDrawn).toEqual({ charts: 0, diagrams: 0, objects: 0, pictures: 0 })
  })

  withPandoc('a picture of the deck is handed over by name, never by a path of the team folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-pdf-'))
    try {
      fs.writeFileSync(path.join(dir, 'p.png'), PNG)
      const r = pptxSlidesHtml(deck('## 사진\n\n![매장](p.png)\n', dir))
      expect(Object.keys(r.media)).toEqual(['m1.png'])
      expect(Buffer.from(r.media['m1.png']!, 'base64').equals(PNG)).toBe(true)
      expect(r.html).toContain('<img src="m1.png"')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  withPandoc('hidden slides are left out; text is escaped; a chart leaves a grey box and is counted', () => {
    const chart = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="90" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
      '<p:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId99"/></a:graphicData></a:graphic></p:graphicFrame>'
    const bytes = withParts(deck(THREE.replace('가나다오피스', 'A &lt;script&gt;alert(1)&lt;/script&gt; B')), {
      'ppt/slides/slide2.xml': (x) => x.replace('<p:sld ', '<p:sld show="0" '),
      'ppt/slides/slide3.xml': (x) => x.replace('</p:spTree>', chart + '</p:spTree>'),
    })
    const r = pptxSlidesHtml(bytes)
    expect(r.slides).toBe(2)
    expect(r.hidden).toBe(1)
    expect(r.html).not.toContain('12월: 샘플 제작')
    expect(r.html).not.toContain('<script>')
    expect(r.html).toContain('&lt;script&gt;')
    expect(r.notDrawn.charts).toBe(1)
    expect(deckPdfResultText({ slides: 2, hidden: 1, notDrawn: r.notDrawn }, 2)).toMatch(/1 hidden slide was left out[\s\S]*Not drawn \(a light grey box in its place\): 1 chart/)
  })

  test('not a deck: refused with words', () => {
    expect(() => pptxSlidesHtml(new Uint8Array(Buffer.from('not a zip')))).toThrow(/not a zip container/)
  })

  test('the AI is sent to the deck path, and told plainly where this server cannot print', () => {
    expect(HTML_PDF_HINT).toContain('PDF from PowerPoint: give `source` = the .pptx and format "pdf"')
    expect(HTML_PDF_OFF_HINT).toContain('cannot save a PowerPoint deck as a PDF')
    expect(makeFileRule(false, true)).toContain('A PowerPoint deck becomes a PDF with `source` = the .pptx')
    expect(makeFileRule(false, false)).not.toContain('PowerPoint deck becomes a PDF')
  })
})

let h: Harness
let bob: TestSocket
const put = (rel: string, data: string | Uint8Array) => { const p = path.join(h.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const exists = (rel: string) => fs.existsSync(path.join(h.team, ...rel.split('/')))

describe('make_file: a .pptx source becomes a PDF with a page per slide', () => {
  beforeAll(async () => {
    h = await startHarness({ name: 'c-make-file-pptx-pdf', askUserTimeoutMs: 5000, stallTimeoutMs: 60_000 })
    bob = await h.ws('bob', { windowId: 'win-pptx-pdf-bob' })
    await bob.next('hello')
    if (pandoc) put('shared/deck/소개.pptx', deck(THREE))
  })
  afterAll(async () => { bob?.close(); await h?.close() })

  async function turn(content: string) {
    const chat = await h.api('bob').call(API.createChat, { body: {} })
    const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
    const done = await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 75_000)
    return { turnId: r.turnId as string, content: done.data.message.content as string }
  }

  prints('saved like every make_file output, a page per slide, and the AI is told how it was made', async () => {
    const r = await turn(fake({ tool: 'make_file', args: { source: 'shared/deck/소개.pptx', format: 'pdf', output: 'shared/deck/소개.pdf' }, sayResult: true }))
    expect(r.content).toContain('Saved shared/deck/소개.pdf')
    expect(r.content).toContain('The PDF has 3 pages, one per slide (3 slides shown)')
    const pdf = fs.readFileSync(path.join(h.team, 'shared', 'deck', '소개.pdf'))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const ev = h.ctx.db.query('SELECT detail FROM file_events WHERE path = ? ORDER BY id DESC').get('shared/deck/소개.pdf') as { detail: string }
    expect(JSON.parse(ev.detail)).toMatchObject({ tool: 'make_file', from: 'shared/deck/소개.pptx', pages: 3, slides: 3 })
  })

  withPandoc('a .pptx source for another format, or with a template, is refused; nothing saved', async () => {
    const a = await turn(fake({ tool: 'make_file', args: { source: 'shared/deck/소개.pptx', format: 'docx', output: 'shared/deck/x.docx' }, sayResult: true }))
    expect(a.content).toContain('a .pptx source can only be saved as a PDF')
    const b = await turn(fake({ tool: 'make_file', args: { source: 'shared/deck/소개.pptx', format: 'pdf', output: 'shared/deck/y.pdf', template: 'skills/x.docx' }, sayResult: true }))
    expect(b.content).toContain('takes no template')
    expect(exists('shared/deck/x.docx') || exists('shared/deck/y.pdf')).toBe(false)
  })

  test('a deck the person cannot read is refused', async () => {
    const r = await turn(fake({ tool: 'make_file', args: { source: 'groups/marketing/secret.pptx', format: 'pdf', output: 'shared/leak.pdf' }, sayResult: true }))
    expect(r.content).toContain('not found or no access')
    expect(exists('shared/leak.pdf')).toBe(false)
  })
})
