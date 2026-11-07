// HTML -> PDF with the server's headless browser (server/src/files/html-pdf.ts, docs/DECISIONS.md "HTML to PDF"): what a
// printed page keeps (backgrounds, colours, merged cells, @page size, page breaks, Korean text) and what it never does
// (load a web address, reach this machine's HTTP servers, read file:, run a script, go past its limits).
// The renders need a Chromium (findPdfBrowser: the promo video's chrome-headless-shell on a development Mac, Debian's
// chromium on a Linux server) in the converter isolation; without one they are skipped and the rest still runs.
// The poppler tools (pdfinfo, pdftotext, pdftoppm) check the PDFs where they are installed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  _queueForTest, assetMime, browserArgs, BROWSER_SHELL, findPdfBrowser, HtmlPdfError, htmlPdfUnavailable, ORIGIN, PAGE_CSP, pdfPageCount, PINNED_BROWSER,
  QUEUE_MAX, renderHtmlPdf, RENDER_PARALLEL, renderParallel, renderSlot, serverFontDirs, teamPathOf, trustedBrowser, type HtmlPdfRequest,
} from '../../server/src/files/html-pdf'
import { makePagedPdf } from '../lib/pdf'
import { BROWSER_MACH_SERVICES, browserProfileRules, isolation, sandboxProfile } from '../../server/src/tools/isolate'
import { which } from '../../server/src/config'
import { WORK } from '../lib/env'

setDefaultTimeout(90_000)
const BROWSER = htmlPdfUnavailable() === null ? findPdfBrowser() : null
const renders = BROWSER ? test : test.skip
if (!BROWSER) console.warn(`html-pdf: no headless browser in the isolation here (${htmlPdfUnavailable()}); the renders are skipped`)
const poppler = { info: which('pdfinfo'), text: which('pdftotext'), ppm: which('pdftoppm') }
// a folder of this run's own: two runs at once must not remove each other's work folders
fs.mkdirSync(WORK, { recursive: true })
const base = fs.mkdtempSync(path.join(WORK, 'html-pdf-'))
/** a 1×1 grey PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNoAAAAggCBd81ytgAAAABJRU5ErkJggg==', 'base64')

afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

const render = (html: string, o: Partial<HtmlPdfRequest> = {}) =>
  renderHtmlPdf({ browser: BROWSER!, html: Buffer.from(html), page: 'sales/견적서.html', workBase: base, asset: () => null, ...o })

let n = 0
function pdfText(pdf: Buffer): string | null {
  if (!poppler.text) return null
  const f = path.join(base, `t-${n++}.pdf`)
  fs.writeFileSync(f, pdf)
  const r = Bun.spawnSync([poppler.text, '-layout', f, '-'])
  return r.stdout.toString()
}
/** page size in points (from the page's MediaBox) */
function pageSize(pdf: Buffer): [number, number] {
  const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'))!
  return [Number(m[1]), Number(m[2])]
}
/** page 1 drawn at 72 dpi (one pixel per point): the RGB of pixel (x, y) */
function pixels(pdf: Buffer): ((x: number, y: number) => [number, number, number]) | null {
  if (!poppler.ppm) return null
  const f = path.join(base, `p-${n++}.pdf`)
  fs.writeFileSync(f, pdf)
  Bun.spawnSync([poppler.ppm, '-r', '72', '-f', '1', '-l', '1', '-singlefile', f, f])
  const img = fs.readFileSync(f + '.ppm')
  // P6 <w> <h> <max>\n then RGB
  const head = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(img.subarray(0, 40).toString('latin1'))!
  const w = Number(head[1]), start = head[0].length
  return (x, y) => { const i = start + (Math.round(y) * w + Math.round(x)) * 3; return [img[i]!, img[i + 1]!, img[i + 2]!] }
}
const near = (a: [number, number, number], b: [number, number, number]) => a.every((v, i) => Math.abs(v - b[i]!) <= 16)
const mm = (v: number) => (v * 72) / 25.4

// ---------------- the sample: a quote with a coloured band, merged cells, @page A4 and a page break ----------------
const QUOTE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 10mm }
html, body { margin: 0; padding: 0 }
.band { background: #1f3a5f; color: #fff; height: 30mm; font-size: 8mm; line-height: 10mm }
table { border-collapse: collapse; width: 190mm; table-layout: fixed; margin-top: 10mm }
td, th { height: 20mm; padding: 0; border: 0.3mm solid #333; font-size: 5mm; vertical-align: top; text-align: left }
th { background: #1f3a5f; color: #fff; text-align: center }
.hl { background: #ffe066 }
.break { break-before: page }
</style></head><body>
<div class="band">견적서 ACME-QUOTE-001</div>
<table><tr><th colspan="3">품목과 금액</th></tr>
<tr><td rowspan="2" class="hl">디자인</td><td>시안</td><td>1,000,000원</td></tr>
<tr><td>수정</td><td>500,000원</td></tr></table>
<div class="break"><h2>2쪽 조건</h2><p>납기 30일, 부가세 별도</p></div>
</body></html>`

describe('the print', () => {
  renders('a coloured table with merged cells, @page A4 and a page break: 2 A4 pages, the text, the colours where they belong', async () => {
    const r = await render(QUOTE)
    expect(r.pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(r.pages).toBe(2)
    const [w, h] = pageSize(r.pdf)
    expect(Math.abs(w - 595.3)).toBeLessThan(1.5)
    expect(Math.abs(h - 841.9)).toBeLessThan(1.5)
    expect(r.scripts).toBe(false)
    expect(r.blockedCount).toBe(0)
    if (poppler.info) {
      const f = path.join(base, 'quote.pdf')
      fs.writeFileSync(f, r.pdf)
      expect(Bun.spawnSync([poppler.info, f]).stdout.toString()).toMatch(/Pages:\s+2[\s\S]*Page size:\s+59[45][.\d]* x 84[12][.\d]* pts \(A4\)/)
    }
    const text = pdfText(r.pdf)
    if (text !== null) {
      // spaces aside: pdftotext puts one where the font changes between Latin and Hangul ("1,000,000 원")
      for (const s of ['견적서 ACME-QUOTE-001', '품목과 금액', '디자인', '1,000,000원', '2쪽 조건', '납기 30일']) expect(text.replace(/\s+/g, '')).toContain(s.replace(/\s+/g, ''))
      // the break: the conditions are on page 2 (pdftotext separates pages with a form feed)
      const [p1, p2] = text.split('\f')
      expect(p1).not.toContain('납기')
      expect(p2).toContain('납기')
    }
    const px = pixels(r.pdf)
    if (px) {
      const navy: [number, number, number] = [0x1f, 0x3a, 0x5f], yellow: [number, number, number] = [0xff, 0xe0, 0x66], white: [number, number, number] = [255, 255, 255]
      // the band's background printed (printBackground), under its text line
      expect(near(px(mm(190), mm(35)), navy)).toBe(true)
      // the header cell spans all three columns (colspan): navy at both ends of the row
      expect(near(px(mm(20), mm(65)), navy)).toBe(true)
      expect(near(px(mm(190), mm(65)), navy)).toBe(true)
      // the highlighted cell spans two rows (rowspan): yellow in the third row's first column
      expect(near(px(mm(60), mm(105)), yellow)).toBe(true)
      expect(near(px(mm(190), mm(105)), white)).toBe(true)
    }
  })

  renders('@page size is the page\'s own: A5 portrait, and US Letter landscape', async () => {
    const a5 = await render('<!doctype html><style>@page { size: 148mm 210mm; margin: 0 }</style><p>A5</p>')
    const [w, h] = pageSize(a5.pdf)
    expect(Math.abs(w - 419.5)).toBeLessThan(1.5)
    expect(Math.abs(h - 595.3)).toBeLessThan(1.5)
    const letter = await render('<!doctype html><style>@page { size: letter landscape }</style><p>Letter</p>')
    const [lw, lh] = pageSize(letter.pdf)
    expect(Math.abs(lw - 792)).toBeLessThan(1.5)
    expect(Math.abs(lh - 612)).toBeLessThan(1.5)
  })

  renders('no @page: A4', async () => {
    const r = await render('<!doctype html><p>plain</p>')
    const [w, h] = pageSize(r.pdf)
    expect(Math.abs(w - 595.3)).toBeLessThan(1.5)
    expect(Math.abs(h - 841.9)).toBeLessThan(1.5)
  })

  renders('Korean text in the server\'s fonts: Pretendard by name (Linux: the bundled fonts through fontconfig), a CJK face for the rest', async () => {
    const r = await render('<!doctype html><p style="font-family: Pretendard, sans-serif">프리텐다드 글꼴</p><p style="font-family: sans-serif">기본 글꼴</p>', { fonts: serverFontDirs() })
    const pdffonts = which('pdffonts')
    if (!pdffonts) return
    const f = path.join(base, 'fonts.pdf')
    fs.writeFileSync(f, r.pdf)
    const list = Bun.spawnSync([pdffonts, f]).stdout.toString()
    // every face is embedded, and the Hangul has a CJK face (a Mac: Apple SD Gothic Neo; Linux: Noto Sans CJK)
    expect(list).not.toMatch(/\bno\s+(yes|no)\s+(yes|no)\s+\d+\s+0\s*$/m)
    expect(list).toMatch(/Pretendard|AppleSDGothic|NotoSansCJK|NotoSansKR/)
    // Linux reads the server's own Pretendard (the Mac has it only when it is installed)
    if (process.platform === 'linux' && serverFontDirs().some((d) => fs.existsSync(path.join(d, 'Pretendard-Regular.ttf')))) expect(list).toContain('Pretendard')
  })

  renders('a page without a charset of its own is read as UTF-8', async () => {
    const r = await render('<!doctype html><p>한글 견적</p>')
    const text = pdfText(r.pdf)
    if (text !== null) expect(text).toContain('한글 견적')
  })

  renders('the page\'s own pictures and stylesheet, by relative path through asset(); asked by team path, never by URL', async () => {
    const asked: string[] = []
    const r = await render('<!doctype html><link rel="stylesheet" href="css/look.css"><img src="../shared/logo.png" width="40"><p class="x">styled</p>', {
      asset: (p) => { asked.push(p); return p === 'sales/css/look.css' ? Buffer.from('.x { background: #1f3a5f; color: #fff; height: 30mm }') : p === 'shared/logo.png' ? PNG : null },
    })
    expect(asked.sort()).toEqual(['sales/css/look.css', 'shared/logo.png'])
    expect(r.assets.sort()).toEqual(['sales/css/look.css', 'shared/logo.png'])
    expect(r.blockedCount).toBe(0)
  })
})

// ---------------- what it never does ----------------
describe('locked down', () => {
  /** an HTTP server on this machine standing in for the team server's API, the network and localhost */
  let hits: string[] = []
  let server: ReturnType<typeof Bun.serve> | null = null
  let origin = ''
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => { hits.push(new URL(req.url).pathname); return new Response('SECRET-FROM-THE-SERVER', { headers: { 'content-type': 'text/html' } }) } })
    origin = `http://127.0.0.1:${server.port}`
  })
  afterAll(() => server?.stop(true))

  renders('an external picture is never fetched: a grey placeholder, the address reported', async () => {
    hits = []
    const r = await render(`<!doctype html><img src="${origin}/picture.png"><img srcset="${origin}/srcset.png 1x"><div style="background:url(${origin}/bg.png);height:20px"></div><p>body</p>`)
    expect(hits).toEqual([])
    expect(r.blocked).toContain(`${origin}/picture.png`)
    expect(r.blockedCount).toBeGreaterThanOrEqual(2)
    expect(r.pages).toBe(1)
  })

  renders('fetch(), XHR, a beacon and a script from the network: JavaScript is off, nothing is sent', async () => {
    hits = []
    const r = await render(`<!doctype html><script>fetch('${origin}/fetch'); new Image().src='${origin}/img-by-script'; navigator.sendBeacon('${origin}/beacon'); document.body.innerHTML='SCRIPT RAN'</script>
      <script src="${origin}/remote.js"></script><body onload="fetch('${origin}/onload')"><p>static page</p></body>`)
    // a moment for anything late
    await Bun.sleep(300)
    expect(hits).toEqual([])
    expect(r.scripts).toBe(true)
    const text = pdfText(r.pdf)
    if (text !== null) { expect(text).toContain('static page'); expect(text).not.toContain('SCRIPT RAN') }
  })

  renders('an iframe to localhost or this machine\'s address (the server\'s own API): never loaded', async () => {
    hits = []
    const port = server!.port
    const r = await render(`<!doctype html><iframe src="http://localhost:${port}/api/me"></iframe><iframe src="${origin}/api/files/tree"></iframe>
      <iframe src="http://[::1]:${port}/api/me"></iframe><object data="${origin}/object"></object><embed src="${origin}/embed"><p>frames</p>`)
    await Bun.sleep(300)
    expect(hits).toEqual([])
    const text = pdfText(r.pdf)
    if (text !== null) expect(text).not.toContain('SECRET-FROM-THE-SERVER')
  })

  renders('stylesheets, fonts, @import, preconnect, prefetch and a meta refresh to the network: nothing is sent, the page stays', async () => {
    hits = []
    const r = await render(`<!doctype html><head><meta http-equiv="refresh" content="0;url=${origin}/refresh">
      <link rel="stylesheet" href="${origin}/style.css"><link rel="preconnect" href="${origin}"><link rel="prefetch" href="${origin}/prefetch">
      <link rel="preload" as="image" href="${origin}/preload.png"><style>@import url(${origin}/import.css); @font-face { font-family: X; src: url(${origin}/font.woff2) } p { font-family: X }</style>
      </head><body><p>still the page</p><a href="${origin}/link">a link is no request</a></body>`)
    await Bun.sleep(600)
    expect(hits).toEqual([])
    const text = pdfText(r.pdf)
    if (text !== null) expect(text).toContain('still the page')
  })

  renders('the page is given once: a refresh to itself and a frame of itself get nothing, the print still ends', async () => {
    const r = await render('<!doctype html><meta http-equiv="refresh" content="0"><iframe src="견적서.html"></iframe><p>once</p>')
    expect(r.pages).toBe(1)
    const text = pdfText(r.pdf)
    if (text !== null) expect(text.match(/once/g)?.length).toBe(1)
  })

  renders('file:///etc/passwd and a file of this machine: never read', async () => {
    const secret = path.join(base, 'machine-secret.txt')
    fs.writeFileSync(secret, 'MACHINE-SECRET-4411')
    const r = await render(`<!doctype html><img src="file:///etc/passwd"><iframe src="file:///etc/passwd"></iframe><iframe src="file://${secret}"></iframe>
      <link rel="stylesheet" href="file:///etc/passwd"><object data="file://${secret}"></object><p>no files</p>`)
    const text = pdfText(r.pdf)
    if (text !== null) {
      expect(text).toContain('no files')
      expect(text).not.toContain('root:')
      expect(text).not.toContain('MACHINE-SECRET-4411')
    }
  })

  renders('a relative path that climbs out: the URL is normalized at the origin\'s root, and asset() decides; other kinds of files are never asked for', async () => {
    const asked: string[] = []
    const r = await render(`<!doctype html><img src="../../../../etc/passwd.png"><img src="/users/alice/private.png"><link rel="stylesheet" href="../../x/..%2F..%2Fescape.css">
      <iframe src="other-page.html"></iframe><script src="app.js"></script><img src="..%2F..%2Fsecret.png"><p>climb</p>`, {
      asset: (p) => { asked.push(p); return null },
    })
    // never a path with ".." or a leading "/" (teamPathOf), and never a page or a script
    for (const p of asked) { expect(p.split('/')).not.toContain('..'); expect(p.startsWith('/')).toBe(false); expect(/\.(html|js)$/.test(p)).toBe(false) }
    expect(asked).toContain('etc/passwd.png')
    expect(asked).toContain('users/alice/private.png')
    expect(r.assets).toEqual([])
    expect(r.blockedCount).toBeGreaterThanOrEqual(3)
  })

  renders('huge output: more pages than the limit, a PDF over the size limit, an HTML file over its limit', async () => {
    const many = '<!doctype html>' + Array.from({ length: 12 }, (_, i) => `<div style="break-before: page">page ${i + 1}</div>`).join('')
    const pages = await render(many, { limits: { maxPages: 10 } }).catch((e) => e)
    expect(pages).toBeInstanceOf(HtmlPdfError)
    expect((pages as HtmlPdfError).code).toBe('pages')
    // at the limit: printed
    expect((await render(many, { limits: { maxPages: 12 } })).pages).toBe(12)
    const big = await render(QUOTE, { limits: { maxPdfBytes: 2_000 } }).catch((e) => e)
    expect((big as HtmlPdfError).code).toBe('too_large')
    const html = await render(QUOTE, { limits: { maxHtmlBytes: 100 } }).catch((e) => e)
    expect((html as HtmlPdfError).code).toBe('html_too_large')
  })

  renders('one picture under many addresses: each team file is read once, and every byte handed over counts against one budget', async () => {
    const big = Buffer.alloc(300 * 1024, 7)
    let reads = 0
    const tags = Array.from({ length: 60 }, (_, i) => `<img src="big.png?${i}" width="4">`).join('')
    const r = await render(`<!doctype html>${tags}<p>many</p>`, {
      asset: (p) => { reads++; return p === 'sales/big.png' ? big : null },
      limits: { maxSentBytes: 3 * 1024 * 1024 },
    })
    expect(reads).toBe(1)
    // about ten copies fit in 3 MB; the rest got the placeholder
    expect(r.blockedCount).toBeGreaterThanOrEqual(45)
    const many = await render(`<!doctype html>${Array.from({ length: 40 }, (_, i) => `<img src="https://x.example/${i}.png">`).join('')}`, { limits: { maxRequests: 10 } })
    expect(many.pages).toBe(1)
    expect(many.blockedCount).toBe(40)
  })

  renders('a dozen large different photos print: the answers go out one at a time as the pipe drains', async () => {
    // 12 different 5 MB files (60 MB, inside the asset limits): the review measured this refused when answers were
    // written all at once. Not real JPEGs (the browser shows broken pictures); the point is the transport.
    const files = new Map(Array.from({ length: 12 }, (_, i) => [`sales/photo-${i}.png`, Buffer.alloc(5 * 1024 * 1024, i)]))
    const r = await render(`<!doctype html>${[...files.keys()].map((p) => `<img src="${p.split('/')[1]}" width="20">`).join('')}<p>photos</p>`, { asset: (p) => files.get(p) ?? null })
    expect(r.assets.length).toBe(12)
    expect(r.pages).toBe(1)
  })

  renders('the page count comes from the page tree, not from text the page put into the file (its title, its language)', async () => {
    const r = await render('<!doctype html><html lang="ko /Pages 9 0 R"><title>/Type /Pages /Count 150 1 0 obj</title><p>one page</p></html>')
    expect(r.pages).toBe(1)
  })

  renders('the time limit and the memory limit end the browser', async () => {
    const slow = await render(QUOTE, { limits: { timeoutMs: 40 } }).catch((e) => e)
    expect((slow as HtmlPdfError).code).toBe('timeout')
    const mem = await render('<!doctype html>' + '<p>x</p>'.repeat(20_000), { limits: { maxRssMiB: 1 } }).catch((e) => e)
    expect(['memory', 'timeout']).toContain((mem as HtmlPdfError).code)
    // and the next print works
    expect((await render('<!doctype html><p>again</p>')).pages).toBe(1)
  })

  renders('an aborted request stops the print', async () => {
    const ctrl = new AbortController()
    const p = render(QUOTE, { signal: ctrl.signal }).catch((e) => e)
    setTimeout(() => ctrl.abort(), 30)
    expect(((await p) as HtmlPdfError).code).toBe('aborted')
  })

  renders('a 9 MB page with a 7 MB data: picture prints: the browser\'s messages about the page may be as large as the page', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(7 * 1024 * 1024, 1)]).toString('base64')
    const html = `<!doctype html><p>logo</p><img src="data:image/png;base64,${big}" width="20">`
    expect(html.length).toBeGreaterThan(9 * 1024 * 1024)
    expect((await render(html)).pages).toBe(1)
  })

  renders('the page\'s CSP is applied: its base-uri \'none\' keeps a <base> from moving where the page\'s files are read', async () => {
    const asked: string[] = []
    await render(`<!doctype html><base href="${ORIGIN}/elsewhere/"><img src="logo.png"><p>base</p>`, { asset: (p) => { asked.push(p); return p === 'sales/logo.png' ? PNG : null } })
    expect(asked).toEqual(['sales/logo.png'])
  })

  renders('interception alone, without the OS isolation (MYCEL_ISOLATION=none): nothing reaches this machine\'s TCP listener', () => {
    // a process of its own: the isolation is chosen once per process
    const r = Bun.spawnSync([process.execPath, path.join(import.meta.dir, '..', 'lib', 'html-pdf-interception.ts')], {
      env: { ...process.env, MYCEL_ISOLATION: 'none', ...(BROWSER ? { MYCEL_HTML_PDF_BROWSER: BROWSER } : {}) }, timeout: 300_000,
    })
    const line = r.stdout.toString().trim().split('\n').pop()!
    const out = JSON.parse(line) as { isolation: string; cases: Record<string, string[]> }
    expect(out.isolation).toBe('none')
    const reached = Object.entries(out.cases).filter(([, c]) => c.length > 0)
    expect(reached).toEqual([])
    expect(Object.keys(out.cases).length).toBeGreaterThanOrEqual(17)
  }, 300_000)
})

// ---------------- a misbehaving browser: fake ones, shell scripts on the DevTools pipes (fd 3 in, fd 4 out) ----------------
describe('a browser that misbehaves', () => {
  const fakes = path.join(base, 'fakes')
  /** a fake "browser" in a folder of its own (trustedBrowser: owned, not writable by others) */
  const fake = (name: string, script: string) => {
    const dir = path.join(fakes, name)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const bin = path.join(dir, 'browser')
    fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return bin
  }
  const run = (bin: string, limits: Partial<HtmlPdfRequest['limits']> = {}) =>
    renderHtmlPdf({ browser: bin, html: Buffer.from('<p>x</p>'), page: 'a/b.html', workBase: base, asset: () => null, limits: { timeoutMs: 8000, ...limits } }).then(() => null, (e) => e as HtmlPdfError)
  /** processes whose command line names `dir` */
  const left = (dir: string) => Bun.spawnSync(['/bin/ps', '-A', '-o', 'pid=,command=']).stdout.toString().split('\n').filter((l) => l.includes(dir) && !l.includes('/bin/ps'))
  const isolated = isolation() !== 'none'
  const fakeTest = isolated ? test : test.skip

  fakeTest('endless output without a message end: refused at the protocol\'s message size, at once, its own error', async () => {
    const bin = fake('junk', "while :; do printf '%s' 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' >&4; done")
    const t = Date.now()
    const e = await run(bin, { timeoutMs: 30_000 })
    expect(e?.code).toBe('protocol')
    expect(Date.now() - t).toBeLessThan(25_000)
    await Bun.sleep(200)
    expect(left(path.dirname(bin))).toEqual([])
  }, 40_000)

  fakeTest('half a message and an exit: the browser stopped', async () => {
    const e = await run(fake('crash', `printf '{"id":1,"result":{"targ' >&4\nexit 3`))
    expect(e?.code).toBe('browser')
    expect(e?.message).toContain('stopped (3)')
  })

  fakeTest('not JSON, an answer to nothing asked, a forged error: no crash, the error ends the print', async () => {
    const e = await run(fake('badjson', `printf 'not json\\0{"id":999,"result":{}}\\0{"id":1,"error":{"message":"forged"}}\\0' >&4\nread -r x <&3`))
    expect(e?.code).toBe('browser')
    expect(e?.message).toContain('forged')
  })

  fakeTest('a browser that never answers: the time limit', async () => {
    const e = await run(fake('silent', 'read -r x <&3\nsleep 30'), { timeoutMs: 1500 })
    expect(e?.code).toBe('timeout')
    await Bun.sleep(200)
    expect(left(path.join(fakes, 'silent'))).toEqual([])
  })

  fakeTest('a helper that outlives the browser: killed with its process group (it held the pipes open)', async () => {
    const bin = fake('orphan', '( n=0; while [ $n -lt 40000000 ]; do n=$((n+1)); done ) &\nexit 0')
    const e = await run(bin)
    expect(e?.code).toBe('browser')
    await Bun.sleep(300)
    expect(left(path.dirname(bin))).toEqual([])
  })

  fakeTest('a browser in a folder others can write is never run, even when named directly', async () => {
    const bin = fake('writable', 'exit 0')
    fs.chmodSync(path.dirname(bin), 0o777)
    const e = await run(bin)
    expect(e?.code).toBe('unavailable')
    fs.chmodSync(path.dirname(bin), 0o755)
  })
})

// ---------------- the parts, without a browser ----------------
describe('parts', () => {
  test('teamPathOf: only the made-up origin, decoded, never ".." or a control character', () => {
    expect(teamPathOf(`${ORIGIN}/sales/%EA%B2%AC%EC%A0%81%EC%84%9C.html`)).toBe('sales/견적서.html')
    expect(teamPathOf(`${ORIGIN}/a/b/../c.png`)).toBe('a/c.png')
    expect(teamPathOf(`${ORIGIN}/../../etc/passwd`)).toBe('etc/passwd')
    expect(teamPathOf(`${ORIGIN}/a/..%2F..%2Fb.png`)).toBeNull()
    expect(teamPathOf(`${ORIGIN}/a/%2e%2e/b.png`)).toBe('b.png')
    expect(teamPathOf(`${ORIGIN}/a%00b.png`)).toBeNull()
    expect(teamPathOf(`${ORIGIN}/`)).toBeNull()
    expect(teamPathOf('http://127.0.0.1:19143/api/me')).toBeNull()
    expect(teamPathOf('https://html-pdf.invalid.evil.example/x.png')).toBeNull()
    expect(teamPathOf(`https://user:pw@html-pdf.invalid/x.png`)).toBeNull()
    expect(teamPathOf('file:///etc/passwd')).toBeNull()
    expect(teamPathOf('data:image/png;base64,AAAA')).toBeNull()
  })

  test('only pictures, stylesheets and fonts are team assets', () => {
    for (const p of ['a.png', 'a.JPG', 'a.svg', 'a.css', 'a.woff2', 'a.ttf', 'a.webp']) expect(assetMime(p)).not.toBeNull()
    for (const p of ['a.html', 'a.js', 'a.mjs', 'a.json', 'a.pdf', 'a.md', 'a', 'a.xml']) expect(assetMime(p)).toBeNull()
  })

  test('the page CSP: no scripts, no connections, frames and styles only from the made-up origin', () => {
    expect(PAGE_CSP).toContain("script-src 'none'")
    expect(PAGE_CSP).toContain("connect-src 'none'")
    expect(PAGE_CSP).toContain("object-src 'none'")
    expect(PAGE_CSP).toContain("form-action 'none'")
    expect(PAGE_CSP).toContain("base-uri 'none'")
    expect(PAGE_CSP).toContain(`frame-src ${ORIGIN}`)
    expect(PAGE_CSP).toContain(`style-src ${ORIGIN} 'unsafe-inline'`)
    expect(PAGE_CSP).not.toMatch(/http:|127\.0\.0\.1|localhost/)
  })

  test('the browser\'s command line: DevTools over pipes (no port), JavaScript off, nothing resolved, nothing in the background', () => {
    const a = browserArgs('/w')
    for (const f of ['--headless', '--remote-debugging-pipe', '--host-resolver-rules=MAP * ~NOTFOUND', '--blink-settings=scriptEnabled=false', '--no-proxy-server',
      '--disable-background-networking', '--dns-prefetch-disable', '--disable-component-update', '--disable-sync', '--disable-extensions', '--user-data-dir=/w/profile'])
      expect(a).toContain(f)
    expect(a.some((x) => x.startsWith('--remote-debugging-port'))).toBe(false)
    expect(a.some((x) => x.startsWith('--allow-file-access') || x === '--disable-web-security')).toBe(false)
  })

  test('the macOS profile of a program with helpers: still no network and writes only in the work folder; it may fork and exec its own folder only', () => {
    const p = sandboxProfile({ cmd: '/opt/b/chrome', workDir: '/tmp/w', readPaths: ['/opt/b'], denyRead: [], helpersIn: '/opt/b' })
    expect(p).toContain('(deny network*)')
    expect(p).toContain('(deny file-write*)')
    expect(p).toContain('(deny process-exec)')
    expect(p).toContain('(allow process-exec (subpath "/opt/b"))')
    expect(p).not.toContain('(deny process-fork)')
    const plain = sandboxProfile({ cmd: '/opt/b/chrome', workDir: '/tmp/w', readPaths: [], denyRead: [] })
    expect(plain).toContain('(deny process-fork)')
    expect(plain).not.toContain('(subpath "/opt/b")')
    // the shell in front of the browser: /bin/sh, and on macOS the one shell it starts, each by its exact path
    const sh = sandboxProfile({ cmd: '/bin/sh', workDir: '/tmp/w', readPaths: ['/opt/b'], denyRead: [], helpersIn: '/opt/b', execAlso: ['/bin/bash'] })
    // by their real paths (on Debian /bin/sh is /usr/bin/dash)
    expect(sh).toContain(`(allow process-exec (literal "${fs.realpathSync('/bin/sh')}"))`)
    expect(sh).toContain(`(allow process-exec (literal "${fs.realpathSync('/bin/bash')}"))`)
    expect(sh).toContain('(deny network*)')
    expect(sh).not.toContain('(deny mach-lookup)')
    // the browser's own: Mach lookups only to its rendezvous service; no LaunchServices, no Apple events. Last rule wins,
    // so they come last. The other converters' profiles have none of it.
    const b = sandboxProfile({ cmd: '/bin/sh', workDir: '/tmp/w', readPaths: [], denyRead: [], helpersIn: '/opt/b', browserProfile: true }).split('\n')
    const tail = b.slice(-4)
    expect(tail).toEqual(browserProfileRules())
    expect(tail[0]).toBe('(deny mach-lookup)')
    expect(tail[1]).toBe('(allow mach-lookup (global-name-regex #"^org\\.chromium\\.[A-Za-z]+\\.MachPortRendezvousServer\\.[0-9]+$"))')
    expect(tail.slice(2)).toEqual(['(deny lsopen)', '(deny appleevent-send)'])
    expect(BROWSER_MACH_SERVICES).toHaveLength(1)
  })

  test('the shell line maps stdin and stdout to the DevTools descriptors 3 and 4, then becomes the browser', () => {
    expect(BROWSER_SHELL).toBe('exec "$0" "$@" 3<&0 4>&1 0</dev/null 1>/dev/null')
    // a real shell: what goes in on stdin comes out of fd 3, what is written to fd 4 comes out on stdout
    const r = Bun.spawnSync(['/bin/sh', '-c', BROWSER_SHELL, '/bin/sh', '-c', 'cat <&3 >&4; echo stdout-is-null'], { stdin: Buffer.from('ping\0') })
    expect(r.stdout.toString()).toBe('ping\0')
  })

  test('findPdfBrowser: the installers\' pinned browser on Linux while MYCEL_HTML_PDF_BROWSER is not set yet; trustedBrowser applies', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-pinned-'))
    try {
      // /opt/trina/chrome-headless-shell as packages.sh lays it out: <version>/<dir>/chrome-headless-shell and current -> it
      const top = path.join(d, 'chrome-headless-shell'), dir = path.join(top, '157.0.8103.38', 'chrome-headless-shell-linux64')
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
      fs.writeFileSync(path.join(dir, 'chrome-headless-shell'), '#!/bin/sh\n', { mode: 0o755 })
      fs.symlinkSync('157.0.8103.38/chrome-headless-shell-linux64', path.join(top, 'current'))
      const pinned = path.join(top, 'current', 'chrome-headless-shell'), real = fs.realpathSync(pinned)
      expect(findPdfBrowser({}, 'linux', '/nonexistent', pinned)).toBe(real)
      // the variable still wins, and "none" still turns it off; not on a Mac (its office browser is named by the supervisor)
      expect(findPdfBrowser({ MYCEL_HTML_PDF_BROWSER: 'none' }, 'linux', '/nonexistent', pinned)).toBeNull()
      expect(findPdfBrowser({ MYCEL_HTML_PDF_BROWSER: path.join(d, 'other') }, 'linux', '/nonexistent', pinned)).toBeNull()
      expect(findPdfBrowser({}, 'darwin', '/nonexistent', pinned)).toBeNull()
      // a folder others can write is never trusted, pinned or not
      fs.chmodSync(dir, 0o777)
      expect(findPdfBrowser({}, 'linux', '/nonexistent', pinned)).toBeNull()
      fs.chmodSync(dir, 0o755)
      expect(PINNED_BROWSER).toBe('/opt/trina/chrome-headless-shell/current/chrome-headless-shell')
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })

  test('findPdfBrowser: an explicit browser, "none", the promo video\'s chrome-headless-shell; nothing otherwise', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-home-'))
    try {
      expect(findPdfBrowser({ MYCEL_HTML_PDF_BROWSER: 'none' }, 'darwin', home)).toBeNull()
      expect(findPdfBrowser({ MYCEL_HTML_PDF_BROWSER: path.join(home, 'missing') }, 'darwin', home)).toBeNull()
      expect(findPdfBrowser({}, 'darwin', home)).toBeNull()
      const bin = path.join(home, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell', 'mac_arm-152.0.1.1', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
      fs.mkdirSync(path.dirname(bin), { recursive: true })
      fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
      // the real path: the one trustedBrowser looked at is the one that runs
      const real = fs.realpathSync(bin)
      expect(findPdfBrowser({}, 'darwin', home)).toBe(real)
      expect(findPdfBrowser({ HYPERFRAMES_BROWSER_PATH: bin }, 'linux', '/nonexistent')).toBe(real)
      expect(findPdfBrowser({ MYCEL_HTML_PDF_BROWSER: bin }, 'linux', '/nonexistent')).toBe(real)
      // trustedBrowser decides: the same browser in a folder others can write is never found
      fs.chmodSync(path.dirname(bin), 0o777)
      expect(findPdfBrowser({}, 'darwin', home)).toBeNull()
      expect(findPdfBrowser({ MYCEL_HTML_PDF_BROWSER: bin }, 'linux', '/nonexistent')).toBeNull()
      fs.chmodSync(path.dirname(bin), 0o755)
      fs.chmodSync(bin, 0o777)
      // ('darwin': no system browser to fall back to)
      expect(findPdfBrowser({ HYPERFRAMES_BROWSER_PATH: bin }, 'darwin', '/nonexistent')).toBeNull()
      fs.chmodSync(bin, 0o755)
      expect(htmlPdfUnavailable({ MYCEL_HTML_PDF_BROWSER: 'none' })).toContain('no headless browser')
      if (isolation() !== 'none') {
        // never as root (only this repository's container check, NODE_ENV=test with MYCEL_HTML_PDF_TEST_AS_ROOT=1)
        if (process.getuid?.() === 0) {
          expect(htmlPdfUnavailable({ MYCEL_HTML_PDF_BROWSER: bin })).toContain('root')
          expect(htmlPdfUnavailable({ MYCEL_HTML_PDF_BROWSER: bin, MYCEL_HTML_PDF_TEST_AS_ROOT: '1' })).toContain('root')
        } else expect(htmlPdfUnavailable({ MYCEL_HTML_PDF_BROWSER: bin })).toBeNull()
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })

  test('pdfPageCount reads the page tree through the trailer, never text elsewhere in the file', () => {
    expect(pdfPageCount(Buffer.from(makePagedPdf([['one'], ['two'], ['three']])))).toBe(3)
    // a page that writes "/Type /Pages /Count 150" (a title, a text) changes nothing
    expect(pdfPageCount(Buffer.from(makePagedPdf([['/Type /Pages /Count 150'], ['x']])))).toBe(2)
    // no cross-reference table: unread, 0 (the print is then refused)
    expect(pdfPageCount(Buffer.from('%PDF-1.4\n<</Type /Pages /Count 7>>'))).toBe(0)
  })

  test('trustedBrowser: never one in a shared folder or in a folder or file others can change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-trust-'))
    try {
      const bin = path.join(dir, 'chrome-headless-shell')
      fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 })
      fs.chmodSync(dir, 0o755)
      expect(trustedBrowser(bin)).toBe(true)
      fs.chmodSync(bin, 0o777)
      expect(trustedBrowser(bin)).toBe(false)
      fs.chmodSync(bin, 0o755)
      fs.chmodSync(dir, 0o777)
      expect(trustedBrowser(bin)).toBe(false)
      fs.chmodSync(dir, 0o755)
      // another account's file (uid 12345 stands for someone else)
      expect(trustedBrowser(bin, 12345)).toBe(process.getuid?.() === 0)
      for (const shared of ['/usr/bin/env', '/bin/sh']) if (fs.existsSync(shared)) expect(trustedBrowser(shared)).toBe(false)
      // every folder between the binary and its bundle's root counts: an app's Contents writable by its group is not trusted
      const app = path.join(dir, 'Shell.app', 'Contents', 'MacOS')
      fs.mkdirSync(app, { recursive: true, mode: 0o755 })
      const inApp = path.join(app, 'Shell')
      fs.writeFileSync(inApp, '#!/bin/sh\n', { mode: 0o755 })
      expect(trustedBrowser(inApp)).toBe(true)
      fs.chmodSync(path.dirname(app), 0o775)
      expect(trustedBrowser(inApp)).toBe(false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('the queue: one print per person, a few on the server, a bounded wait list', async () => {
    const a1 = await renderSlot('a')
    const b1 = await renderSlot('b')
    // two at a time without a converter cgroup (here); one where the cgroup's budget is small
    expect(renderParallel()).toBe(RENDER_PARALLEL)
    expect(_queueForTest()).toEqual({ running: RENDER_PARALLEL, waiting: 0 })
    // the same person waits behind their own print; so does a third person while the server is full
    let a2Granted = false, c1Granted = false
    const a2 = renderSlot('a').then((r) => { a2Granted = true; return r })
    const c1 = renderSlot('c').then((r) => { c1Granted = true; return r })
    await Bun.sleep(10)
    expect(a2Granted || c1Granted).toBe(false)
    // one waiting print per person: a third one of a is busy at once (nobody fills the list for everyone)
    expect(((await renderSlot('a').catch((e) => e)) as HtmlPdfError).code).toBe('busy')
    // b ends: c goes first (a still prints its first one)
    b1()
    const c1r = await c1
    expect(c1Granted).toBe(true)
    expect(a2Granted).toBe(false)
    a1()
    const a2r = await a2
    expect(a2Granted).toBe(true)
    // an aborted wait (the person closed the request) leaves the list
    const ctrl = new AbortController()
    const gone = renderSlot('aborter', ctrl.signal).catch((e) => e)
    await Bun.sleep(5)
    expect(_queueForTest().waiting).toBe(1)
    ctrl.abort()
    expect(((await gone) as HtmlPdfError).code).toBe('aborted')
    expect(_queueForTest().waiting).toBe(0)
    // a full wait list: busy at once
    const fill = Array.from({ length: QUEUE_MAX }, (_, i) => renderSlot(`w${i}`).then((r) => r(), () => {}))
    const over = await renderSlot('one-too-many').catch((e) => e)
    expect((over as HtmlPdfError).code).toBe('busy')
    a2r(); c1r()
    await Promise.all(fill)
    expect(_queueForTest()).toEqual({ running: 0, waiting: 0 })
  })
})
