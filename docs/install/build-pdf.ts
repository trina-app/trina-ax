// Renders docs/install/guide.html to "Team-AX-설치가이드.pdf" (A4) with Playwright's Chromium.
//
//   bun docs/install/build-pdf.ts              build the PDF
//   bun docs/install/build-pdf.ts --office     the office-mode guide instead: docs/office/guide.html -> docs/office/
//                                              Team-AX-사무실모드-설치가이드.pdf (docs/OFFICE.md; same look)
//   bun docs/install/build-pdf.ts --windows    the desk guide: docs/office/windows-guide.html -> docs/office/
//                                              Team-AX-윈도우-데스크-가이드.pdf (Edge web app / desktop app on the desks)
//   bun docs/install/build-pdf.ts --png <dir>  also render every page to <dir>/page-NN.png (pdftoppm) for checking
//
// One team's copy (--office / --windows) is built from the same neutral source without editing it:
//   --team-host shop.acme.com   the team's internet address instead of team.example.com (also the Cloudflare zone
//                               "acme.com" and the cert file ~/.cloudflared/cert-acme.pem in the commands)
//   --team-name 'OO학원'         the example team name (first-run setup)          default OO<place>
//   --place 학원                 what the workplace is called ("…의 맥 미니")      default 사무실
//   --boss 원장님                who owns the team and the Cloudflare login         default 대표님
//   --sensitive '학생 자료'      the sensitive data the security notes talk about  default 민감한 자료
//   --title '학원 설치 가이드'   cover, footer and <title> (after the product name)
//   --set key=value             any other <… data-k="key"> in the HTML (e.g. office-title in the desk guide)
//   --img-dir <dir>             pictures in <dir> replace docs/office/img/<same name> (that team's own screenshots)
//   --version x.y.z             file names in the commands (default: server/ and desktop/package.json)
//   --out <file.pdf>            where to write it (default: next to the HTML)
// Every element with data-k="<key>" gets that value as its text (in the HTML: <x-k data-k="boss">대표님</x-k>, a tag no
// style touches); team.example.com, example.com and cert-example.pem are replaced in all text and links; "Team AX"
// becomes PRODUCT.displayName (shared/src/product.ts). Customer copies are built outside this repository.
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
import { PRODUCT } from '../../shared/src/product'
import { DESK_PDF, FILE_NAME, OFFICE_PDF } from '../../scripts/build-office'

const REPO = path.resolve(import.meta.dir, '..', '..')
const argv = process.argv.slice(2)
function arg(name: string): string | null {
  const i = argv.indexOf(name)
  if (i < 0) return null
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`)
  return v
}
const args = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] !== undefined ? [argv[i + 1]] : []))

const WINDOWS = argv.includes('--windows')
const OFFICE = WINDOWS || argv.includes('--office')
const DIR = OFFICE ? path.join(import.meta.dir, '..', 'office') : import.meta.dir
const HTML = path.join(DIR, WINDOWS ? 'windows-guide.html' : 'guide.html')
const OUT = path.resolve(arg('--out') ?? path.join(DIR, WINDOWS ? DESK_PDF : OFFICE ? OFFICE_PDF : `${FILE_NAME}-설치가이드.pdf`))
const pngDir = arg('--png')
const PNG_DIR = pngDir ? path.resolve(pngDir) : null
const imgDir = arg('--img-dir')
const IMG_DIR = imgDir ? path.resolve(imgDir) : null
if (IMG_DIR && !fs.statSync(IMG_DIR, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--img-dir ${IMG_DIR}: not a folder`)

const pkgVersion = (p: string) => (JSON.parse(fs.readFileSync(path.join(REPO, p, 'package.json'), 'utf8')) as { version: string }).version
const HOST = (arg('--team-host') ?? 'team.example.com').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(HOST)) throw new Error(`--team-host ${HOST}: not a host name`)
const ZONE = HOST.split('.').slice(1).join('.')
const place = arg('--place') ?? '사무실'
const vars: Record<string, string> = {
  place,
  'team-name': arg('--team-name') ?? `OO${place}`,
  boss: arg('--boss') ?? '대표님',
  sensitive: arg('--sensitive') ?? '민감한 자료',
  version: arg('--version') ?? pkgVersion('server'),
  'desktop-version': arg('--version') ?? pkgVersion('desktop'),
}
const title = arg('--title')
if (title) vars.title = title
for (const kv of args('--set')) {
  const i = kv.indexOf('=')
  if (i < 1) throw new Error(`--set ${kv}: use key=value`)
  vars[kv.slice(0, i)] = kv.slice(i + 1)
}
/** literal replacements in every text node and attribute, in this order */
const REPLACE: [string, string][] = [
  ['team.example.com', HOST],
  ['cert-example.pem', `cert-${ZONE.split('.')[0]}.pem`],
  ['example.com', ZONE],
  ...(PRODUCT.displayName === 'Team AX' ? [] : [['Team AX', PRODUCT.displayName] as [string, string]]),
]

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamax-install-'))
const pdfText = (file: string, page: number) =>
  execFileSync('pdftotext', ['-f', String(page), '-l', String(page), '-layout', file, '-'], { encoding: 'utf8' }).replace(/\s+/g, '')
const pageCount = (file: string) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))![1])
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(pathToFileURL(HTML).href, { waitUntil: 'networkidle' })
  // this team's copy: marked words, the address, the product name, its own pictures
  const imgs = IMG_DIR ? Object.fromEntries(fs.readdirSync(IMG_DIR).map((f) => [f, pathToFileURL(path.join(IMG_DIR, f)).href])) : {}
  const docTitle: string = await page.evaluate(({ vars, replace, imgs, product }) => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-k]')) {
      const v = vars[el.dataset.k!]
      if (v !== undefined) el.textContent = v
    }
    if (vars.title) document.title = `${product} ${vars.title}`
    const sub = (s: string) => replace.reduce((t, [a, b]) => t.split(a).join(b), s)
    const walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue) n.nodeValue = sub(n.nodeValue)
    for (const el of document.querySelectorAll('*')) for (const a of [...el.attributes]) if (a.name !== 'src') a.value = sub(a.value)
    for (const img of document.querySelectorAll('img')) {
      const name = decodeURIComponent(new URL(img.src).pathname.split('/').pop() ?? '')
      if (imgs[name]) img.src = imgs[name]
    }
    return document.title
  }, { vars, replace: REPLACE, imgs, product: PRODUCT.displayName })
  await page.waitForLoadState('networkidle')
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => i.decode().catch(() => { throw new Error(`picture not loaded: ${i.src}`) })))
  })
  await page.emulateMedia({ media: 'print' })
  const print = (file: string, opts: Record<string, unknown> = {}) =>
    page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true, ...opts })
  const FOOTER = `<div style="width:100%;padding:0 17mm;font-size:10.5px;font-family:'Inter','Apple SD Gothic Neo',sans-serif;color:#8a8a85;display:flex;justify-content:space-between;align-items:center;">
  <span>${esc(docTitle)}</span><span style="font-weight:700;color:#0A0A0A;"><span class="pageNumber"></span></span></div>`

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
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
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
