// Renders docs/guide/guide.html to "Team-AX-사용설명서.pdf" (A4) with Playwright's Chromium.
//
//   bun docs/guide/build-pdf.ts              build the PDF
//   bun docs/guide/build-pdf.ts --png <dir>  also render every page to <dir>/page-NN.png (pdftoppm) for checking
//
// Two passes: the first PDF tells which page each chapter starts on (pdftotext), those numbers go into the table
// of contents, then the final PDF is printed. The cover is printed without the page-number footer and joined with
// the rest by pdfunite. Needs poppler (pdftotext, pdfunite, pdftoppm: `brew install poppler`) and the network for
// the web fonts (Pretendard, Inter, Space Grotesk); without it the Apple SD Gothic Neo fallback is used.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// @playwright/test is a dependency of the tests workspace (not hoisted to the repo root)
import { chromium } from '../../tests/node_modules/@playwright/test/index.js'

const DIR = import.meta.dir
const HTML = path.join(DIR, 'guide.html')
const OUT = path.join(DIR, 'Team-AX-사용설명서.pdf')
const pngIdx = process.argv.indexOf('--png')
const PNG_DIR = pngIdx > 0 ? process.argv[pngIdx + 1] : null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamax-guide-'))

const FOOTER = `<div style="width:100%;padding:0 17mm;font-size:10.5px;font-family:'Inter','Apple SD Gothic Neo',sans-serif;color:#8a8a85;display:flex;justify-content:space-between;align-items:center;">
  <span>Team AX 사용 설명서</span><span style="font-weight:700;color:#0A0A0A;"><span class="pageNumber"></span></span></div>`

const pdfText = (file: string, page: number) =>
  execFileSync('pdftotext', ['-f', String(page), '-l', String(page), '-layout', file, '-'], { encoding: 'utf8' }).replace(/\s+/g, '')
const pageCount = (file: string) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))![1])

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(pathToFileURL(HTML).href, { waitUntil: 'networkidle' })
  await page.evaluate(async () => { await document.fonts.ready })
  await page.emulateMedia({ media: 'print' })
  const print = (file: string, opts: Record<string, unknown> = {}) =>
    page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true, ...opts })

  // pass 1: where does each chapter start?
  const draft = path.join(tmp, 'draft.pdf')
  await print(draft)
  const chapters: { id: string; title: string }[] = await page.evaluate(() =>
    [...document.querySelectorAll('section.chap .chap-head')].map((h) => ({ id: h.closest('section')!.id, title: (h.querySelector('.no')!.textContent! + h.querySelector('h2')!.textContent!).replace(/\s+/g, '') })))
  const n = pageCount(draft)
  const texts = Array.from({ length: n }, (_, i) => pdfText(draft, i + 1))
  const toc: Record<string, number> = {}
  for (const c of chapters) {
    const p = texts.findIndex((t, i) => i >= 2 && t.includes(c.title)) // page 1 = cover, page 2 = contents
    if (p < 0) throw new Error(`chapter not found in the draft PDF: ${c.title}`)
    toc[c.id] = p + 1
  }
  await page.evaluate((toc) => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-toc]')) el.textContent = String(toc[el.dataset.toc!] ?? '')
  }, toc)

  // pass 2: cover without footer, the rest with page numbers (numbered as in the whole document)
  const cover = path.join(tmp, 'cover.pdf')
  const body = path.join(tmp, 'body.pdf')
  await print(cover, { pageRanges: '1' })
  await print(body, { pageRanges: `2-${n}`, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: FOOTER })
  execFileSync('pdfunite', [cover, body, OUT])
  const total = pageCount(OUT)
  if (total !== n) throw new Error(`page count changed between passes: ${n} -> ${total}`)
  console.log(`${OUT}\n${total} pages; chapters start on: ${chapters.map((c) => `${c.id}=${toc[c.id]}`).join(' ')}`)

  if (PNG_DIR) {
    fs.mkdirSync(PNG_DIR, { recursive: true })
    execFileSync('pdftoppm', ['-png', '-r', '80', OUT, path.join(PNG_DIR, 'page')])
    console.log(`page images in ${PNG_DIR}`)
  }
} finally {
  await browser.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
