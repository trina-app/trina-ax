// make_file with an .html `source` (format pdf) and the file preview's "PDF로 저장" (POST/GET /api/files/html-pdf):
// the page printed by the server's headless browser (server/src/files/html-pdf.ts), saved with make_file's rules
// (access, conflict copy, audit, the wider-audience card for every file whose bytes are in the PDF) and, for the
// person, next to the page with the preview's rule for its pictures. The tool description and the system prompt send
// the AI here for HTML and never to a Markdown rewrite. Prints are skipped where no browser runs in the isolation.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { API } from '@mycel/shared/api'
import { makeFileRule } from '../../server/src/chat/prompt'
import { htmlPdfUnavailable } from '../../server/src/files/html-pdf'
import { HTML_PDF_HINT, HTML_PDF_OFF_HINT, htmlPdfResultText } from '../../server/src/tools/make-file'
import { toolRegistry } from '../../server/src/tools/registry'
import { startHarness, type Harness, type TestSocket } from '../lib/b-harness'

setDefaultTimeout(90_000)
const PRINTS = htmlPdfUnavailable() === null
const prints = PRINTS ? test : test.skip
const fake = (...ds: unknown[]) => ds.map((d) => '@fake ' + JSON.stringify(d)).join('\n')
const cm = () => 'cm-' + crypto.randomUUID()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64')
const QUOTE = (extra = '') => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 12mm } h1 { background: #1f3a5f; color: #fff } .hl { background: #ffe066 } .b { break-before: page }
</style></head><body><h1>견적서 ACME-7</h1><img src="logo.png" width="30">${extra}
<table><tr><th colspan="2">품목</th></tr><tr><td rowspan="2" class="hl">디자인</td><td>1,000,000원</td></tr><tr><td>500,000원</td></tr></table>
<div class="b">조건</div></body></html>`

let h: Harness
let bob: TestSocket
const put = (rel: string, data: string | Buffer) => { const p = path.join(h.team, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const exists = (rel: string) => fs.existsSync(path.join(h.team, ...rel.split('/')))
const read = (rel: string) => fs.readFileSync(path.join(h.team, ...rel.split('/')))

beforeAll(async () => {
  h = await startHarness({ name: 'c-make-file-html-pdf', askUserTimeoutMs: 5000, turnTimeoutMs: 60_000 })
  bob = await h.ws('bob', { windowId: 'win-html-pdf-bob' })
  await bob.next('hello')
  // bob (finance) writes shared/ and groups/finance/, reads projects/falcon/, cannot read groups/marketing/
  put('shared/quote/견적서.html', QUOTE())
  put('shared/quote/logo.png', PNG)
  put('groups/finance/chart.png', PNG)
  put('groups/marketing/secret-quote.html', QUOTE())
  put('groups/marketing/secret.png', PNG)
  put('projects/falcon/견적서.html', QUOTE())
  put('projects/falcon/logo.png', PNG)
})
afterAll(async () => { bob?.close(); await h?.close() })

async function turn(content: string, answer: string | null) {
  const chat = await h.api('bob').call(API.createChat, { body: {} })
  const r = await h.api('bob').call(API.sendMessage, { params: { id: chat.id }, body: { content, clientMessageId: cm(), attachmentIds: [] } })
  const questions: string[] = []
  let stop = false
  const answering = (async () => {
    while (!stop) {
      const c = await bob.next('turn.request', (f) => f.data.turnId === r.turnId && !questions.includes(f.data.request.requestId), 1500).catch(() => null)
      if (!c) continue
      questions.push(c.data.request.requestId)
      if (answer) await h.api('bob').call(API.answerTurn, { params: { id: r.turnId }, body: { kind: 'ask_user', requestId: c.data.request.requestId, answer } })
    }
  })()
  const done = await bob.next('message.done', (f) => f.data.messageId === r.assistantMessage.id, 75_000)
  stop = true
  await answering
  const cards = bob.frames.filter((f) => f.type === 'turn.request' && f.data.turnId === r.turnId).map((f) => (f as Extract<typeof f, { type: 'turn.request' }>).data.request as { question: string })
  return { chatId: chat.id as string, turnId: r.turnId as string, content: done.data.message.content as string, cards }
}
const toolEvent = (turnId: string) => h.ctx.db.query("SELECT ok, summary FROM tool_events WHERE turn_id = ? AND tool = 'make_file'").get(turnId) as { ok: number; summary: string } | null
const fileEventOf = (p: string) => h.ctx.db.query('SELECT user_id, turn_id, action, detail FROM file_events WHERE path = ? ORDER BY id DESC').get(p) as { user_id: string; turn_id: string | null; action: string; detail: string } | null

describe('make_file: an .html source becomes a PDF by printing', () => {
  prints('printed and saved like every make_file output: the PDF, its pages, the audit lines, no card for files of the same audience', async () => {
    const r = await turn(fake({ tool: 'make_file', args: { source: 'shared/quote/견적서.html', format: 'pdf', output: 'shared/quote/견적서.pdf' }, sayResult: true }), null)
    expect(r.cards.length).toBe(0)
    expect(r.content).toContain('Saved shared/quote/견적서.pdf')
    expect(r.content).toContain('The PDF has 2 pages, printed from the HTML as a browser prints it.')
    expect(read('shared/quote/견적서.pdf').subarray(0, 5).toString()).toBe('%PDF-')
    const ev = fileEventOf('shared/quote/견적서.pdf')!
    expect(ev).toMatchObject({ user_id: 'bob', turn_id: r.turnId, action: 'create' })
    // the audit line names the page and every team file in the PDF
    expect(JSON.parse(ev.detail)).toMatchObject({ tool: 'make_file', from: 'shared/quote/견적서.html', pages: 2, files: ['shared/quote/logo.png'] })
    const te = toolEvent(r.turnId)!
    expect(te.ok).toBe(1)
    expect(te.summary).toContain('make_file pdf -> shared/quote/견적서.pdf')
    expect(te.summary).toContain('from shared/quote/견적서.html 2 pages')
  })

  prints('an existing PDF the AI did not read is kept: the new one is a conflict copy', async () => {
    put('shared/quote/old.pdf', 'not read in this turn')
    const r = await turn(fake({ tool: 'make_file', args: { source: 'shared/quote/견적서.html', format: 'pdf', output: 'shared/quote/old.pdf' }, sayResult: true }), null)
    expect(read('shared/quote/old.pdf').toString()).toBe('not read in this turn')
    expect(r.content).toContain("'shared/quote/old.pdf' already exists")
  })

  test('refused for a page the person cannot read; nothing saved', async () => {
    const r = await turn(fake({ tool: 'make_file', args: { source: 'groups/marketing/secret-quote.html', format: 'pdf', output: 'shared/leak.pdf' }, sayResult: true }), 'save')
    expect(r.content).toContain('not found or no access')
    expect(exists('shared/leak.pdf')).toBe(false)
    expect(toolEvent(r.turnId)!.ok).toBe(0)
  })

  test('an .html source for another format, or with a template, is refused', async () => {
    const a = await turn(fake({ tool: 'make_file', args: { source: 'shared/quote/견적서.html', format: 'docx', output: 'shared/quote/x.docx' }, sayResult: true }), null)
    expect(a.content).toContain('an .html source can only be printed to PDF')
    const b = await turn(fake({ tool: 'make_file', args: { source: 'shared/quote/견적서.html', format: 'pdf', output: 'shared/quote/y.pdf', template: 'skills/x.docx' }, sayResult: true }), null)
    expect(b.content).toContain('takes no template')
    expect(exists('shared/quote/x.docx') || exists('shared/quote/y.pdf')).toBe(false)
  })

  prints('a picture outside the person\'s access is not loaded; one from a narrower folder makes the PDF wider, so the person is asked first', async () => {
    put('shared/quote/mixed.html', QUOTE('<img src="../../groups/marketing/secret.png"><img src="../../groups/finance/chart.png">'))
    const no = await turn(fake({ tool: 'make_file', args: { source: 'shared/quote/mixed.html', format: 'pdf', output: 'shared/quote/mixed.pdf' }, sayResult: true }), 'skip')
    expect(no.cards.length).toBe(1)
    expect(no.cards[0]!.question).toContain('groups/finance/')
    expect(no.cards[0]!.question).not.toContain('groups/marketing')
    expect(exists('shared/quote/mixed.pdf')).toBe(false)
    const yes = await turn(fake({ tool: 'make_file', args: { source: 'shared/quote/mixed.html', format: 'pdf', output: 'shared/quote/mixed.pdf' }, sayResult: true }), 'save')
    expect(exists('shared/quote/mixed.pdf')).toBe(true)
    // the marketing picture: not loaded, said to the AI
    expect(yes.content).toMatch(/1 reference was not loaded .*groups\/marketing\/secret\.png/)
  })

  prints('a page with scripts: printed, and the AI is told they did not run', async () => {
    put('shared/quote/scripted.html', QUOTE('<script>document.write("SCRIPT")</script>'))
    const r = await turn(fake({ tool: 'make_file', args: { source: 'shared/quote/scripted.html', format: 'pdf', output: 'shared/quote/scripted.pdf' }, sayResult: true }), null)
    expect(r.content).toContain('The page has scripts, which did not run')
  })
})

describe('the file preview\'s "PDF로 저장"', () => {
  const post = (user: string, p: string) => h.req(user, '/api/files/html-pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) })

  prints('saved next to the page, never over a file; recorded as made from the page', async () => {
    const r = await h.api('bob').call(API.saveHtmlPdf, { body: { path: 'shared/quote/견적서.html' } })
    // make_file's PDF of the same page is already there: the person's gets " (2)"
    expect(r.entry.path).toBe('shared/quote/견적서 (2).pdf')
    expect(r.pages).toBe(2)
    expect(r.scripts).toBe(false)
    expect(read(r.entry.path).subarray(0, 5).toString()).toBe('%PDF-')
    const ev = fileEventOf(r.entry.path)!
    expect(ev).toMatchObject({ user_id: 'bob', turn_id: null, action: 'create' })
    expect(JSON.parse(ev.detail)).toMatchObject({ via: 'html_pdf', from: 'shared/quote/견적서.html', pages: 2, files: ['shared/quote/logo.png'] })
  })

  prints('the preview\'s rule for pictures: a file not everyone who can read the page can read is left out, and the PDF is saved without a widening', async () => {
    put('shared/quote/preview-rule.html', QUOTE('<img src="../../groups/finance/chart.png">'))
    const r = await h.api('bob').call(API.saveHtmlPdf, { body: { path: 'shared/quote/preview-rule.html' } })
    expect(r.entry.path).toBe('shared/quote/preview-rule.pdf')
    expect(r.blocked).toBe(1)
  })

  test('a page the person cannot read: 404; not an .html file: 400', async () => {
    expect((await post('bob', 'groups/marketing/secret-quote.html')).status).toBe(404)
    put('shared/quote/notes.md', '# notes')
    expect((await post('bob', 'shared/quote/notes.md')).status).toBe(400)
  })

  test('a folder the person can read but not write: 403 before anything is printed; the download works', async () => {
    const r = await post('bob', 'projects/falcon/견적서.html')
    expect(r.status).toBe(403)
    expect(exists('projects/falcon/견적서.pdf')).toBe(false)
    if (!PRINTS) return
    const d = await h.req('bob', `/api/files/html-pdf?path=${encodeURIComponent('projects/falcon/견적서.html')}`)
    expect(d.status).toBe(200)
    expect(d.headers.get('content-type')).toBe('application/pdf')
    expect(d.headers.get('content-disposition')).toContain('attachment')
    expect(Buffer.from(await d.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')
    expect(exists('projects/falcon/견적서.pdf')).toBe(false)
  })

  test('Me says whether this server prints HTML (the preview shows the action only then)', async () => {
    // dana: the fixture's group ids are not UUIDv7, so a member's Me does not pass the response check in this harness
    const me = await h.api('dana').call(API.me, {})
    expect(!!me.server.htmlPdf).toBe(PRINTS)
  })
})

describe('the AI is sent to the print for HTML', () => {
  test('make_file\'s description: the print where it works, the warning where it does not', () => {
    const reg = toolRegistry(h.ctx.files)
    const was = process.env.MYCEL_HTML_PDF_BROWSER
    try {
      if (PRINTS) {
        const d = reg.describeTool('make_file')!.description
        expect(d).toContain(HTML_PDF_HINT)
        expect(d).toContain('never rewrite HTML as Markdown for a PDF')
      }
      process.env.MYCEL_HTML_PDF_BROWSER = 'none'
      const off = reg.describeTool('make_file')!.description
      expect(off).toContain(HTML_PDF_OFF_HINT)
      expect(off).not.toContain(HTML_PDF_HINT)
    } finally {
      if (was === undefined) delete process.env.MYCEL_HTML_PDF_BROWSER
      else process.env.MYCEL_HTML_PDF_BROWSER = was
    }
  })

  test('the system prompt\'s make_file rule names the print only where it works', () => {
    expect(makeFileRule(false, true)).toContain('An HTML page becomes a PDF with make_file `source` = the .html file and format "pdf"')
    expect(makeFileRule(true, false)).not.toContain('HTML')
  })

  test('the result text: pages, what was not loaded, scripts', () => {
    expect(htmlPdfResultText({ pages: 1, blocked: [], blockedCount: 0, scripts: false })).toBe('The PDF has 1 page, printed from the HTML as a browser prints it.')
    const t = htmlPdfResultText({ pages: 3, blocked: ['https://cdn.example/a.png'], blockedCount: 1, scripts: true })
    expect(t).toContain('1 reference was not loaded')
    expect(t).toContain('https://cdn.example/a.png')
    expect(t).toContain('save_url')
    expect(t).toContain('JavaScript is off')
  })
})
