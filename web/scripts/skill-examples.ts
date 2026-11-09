// The picture of a kept skill's example (EXAMPLES-PLAN.md; server/src/onboarding/skill-examples.ts), made from the
// artifact the skill made in a chat on the fictional company (examples/data/example-coffee/README.md has the recipe):
// every slide, card or still is screenshotted at 2× in headless Chromium with no network (the page's /vendor/fonts/
// from web/dist, its team pictures from the example's inputs), then three of them are laid out 640 CSS px wide
// (1280 px), the first large and two stacked beside it, and saved as WebP quality 80 by Chromium's own encoder.
//
//   bun scripts/skill-examples.ts <intro-deck|card-news|promo-video> <artifact.html> <ko|en> <out.webp> [--pick 1,5,6]
//
// The artifact: the `content` of GET /api/artifacts/:id. Run `bun run build` first (the fonts come from web/dist).
import { chromium, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..', '..')
const INPUTS = path.join(ROOT, 'examples', 'data', 'example-coffee')
const ORIGIN = 'http://example.test'
const SKILLS = ['intro-deck', 'card-news', 'promo-video'] as const
type Skill = (typeof SKILLS)[number]
/** the three shown (1-based): the deck's cover, numbers and process; the first three cards; the video's hook, work, proof */
const PICK: Record<Skill, number[]> = { 'intro-deck': [1, 5, 6], 'card-news': [1, 2, 3], 'promo-video': [1, 3, 4] }
const LABEL = { ko: '18초 영상', en: '18-second video' } as const

const args = process.argv.slice(2)
const [skill, file, locale, out] = args as [Skill, string, 'ko' | 'en', string]
if (!SKILLS.includes(skill) || !file || !(locale === 'ko' || locale === 'en') || !out?.endsWith('.webp')) {
  console.error('usage: bun scripts/skill-examples.ts <intro-deck|card-news|promo-video> <artifact.html> <ko|en> <out.webp> [--pick 1,5,6]')
  process.exit(2)
}
const at = args.indexOf('--pick')
const pick = at >= 0 ? args[at + 1]!.split(',').map(Number) : PICK[skill]
const font = path.join(ROOT, 'web', 'dist', 'vendor', 'fonts', 'PretendardVariable.woff2')
if (!fs.existsSync(font)) { console.error('web/dist has no fonts yet: run `bun run build` in web/ first'); process.exit(1) }

/** The artifact at ORIGIN: its fonts from web/dist, a team picture by its file name from the inputs, nothing else. */
async function open(page: Page, html: string) {
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url())
    if (u.origin !== ORIGIN) return route.abort()
    const p = decodeURIComponent(u.pathname).normalize('NFC')
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    const vendor = path.join(ROOT, 'web', 'dist', p)
    if (p.startsWith('/vendor/') && vendor.startsWith(path.join(ROOT, 'web', 'dist', 'vendor') + path.sep) && fs.existsSync(vendor)) return route.fulfill({ status: 200, path: vendor })
    const input = path.join(INPUTS, locale, path.basename(p))
    if (p.startsWith('/groups/') && fs.existsSync(input)) return route.fulfill({ status: 200, path: input })
    console.warn(`not found: ${p}`)
    return route.fulfill({ status: 404, body: '' })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(600)
}

const browser = await chromium.launch()
const html = fs.readFileSync(file, 'utf8')
const shots: Buffer[] = []
if (skill === 'intro-deck') {
  // the stage 960 CSS px wide: 1920 × 1080 per slide
  const page = await browser.newPage({ viewport: { width: 984, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await open(page, html)
  for (const n of pick) {
    await page.evaluate((k) => document.querySelectorAll('.st > .s').forEach((s, j) => { s.classList.toggle('on', j === k); s.classList.remove('l', 'rt') }), n - 1)
    await page.waitForTimeout(150)
    shots.push(await page.locator('.st').screenshot())
  }
} else if (skill === 'card-news') {
  // the cards name Pretendard first; the frame has no font of its own, so it is given the web build's
  const page = await browser.newPage({ viewport: { width: 540, height: 900 }, deviceScaleFactor: 2 })
  const pretendard = '<style>@font-face{font-family:"Pretendard";src:url(/vendor/fonts/PretendardVariable.woff2) format("woff2-variations");font-weight:45 920}</style>'
  await open(page, html.replace(/<\/head>/i, `${pretendard}</head>`))
  for (const n of pick) shots.push(await page.locator('section.card').nth(n - 1).screenshot())
} else {
  // with reduced motion the video lays out every beat's settled frame
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await open(page, html)
  for (const n of pick) shots.push(await page.locator('.pv-stills .pv-stage').nth(n - 1).screenshot())
}

// the layout: 640 CSS px wide, gaps 8, corners 6, transparent around (the viewer's own background shows in both themes)
const src = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`
const face = `@font-face{font-family:P;src:url(data:font/woff2;base64,${fs.readFileSync(font).toString('base64')}) format("woff2-variations");font-weight:45 920}`
const grid = {
  'intro-deck': '.x{grid-template-columns:426px 206px;grid-template-rows:116px 116px}.x>:first-child{grid-row:1/3;height:240px}',
  'card-news': '.x{grid-template-columns:424px 208px;grid-template-rows:208px 208px}.x>:first-child{grid-row:1/3;height:424px}',
  'promo-video': '.x{grid-template-columns:424px 208px;grid-template-rows:260px 260px}.x>:first-child{grid-row:1/3;height:528px}',
}[skill]
const play = '<svg viewBox="0 0 10 12" width="8" height="10" aria-hidden="true"><path d="M0 0l10 6-10 6z" fill="currentColor"/></svg>'
const tag = skill === 'promo-video' ? `<span class="tag">${play}${LABEL[locale]}</span>` : ''
const layout = await browser.newPage({ viewport: { width: 640, height: 600 }, deviceScaleFactor: 2 })
await layout.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${face}
html,body{margin:0;background:transparent}
.x{width:640px;display:grid;gap:8px}.x>div{position:relative}
.x img{display:block;width:100%;height:100%;object-fit:cover;border-radius:6px;box-shadow:0 0 0 .5px rgba(0,0,0,.08)}
.tag{position:absolute;left:12px;bottom:12px;display:inline-flex;align-items:center;gap:6px;padding:5px 11px 5px 10px;border-radius:999px;background:rgba(245,240,235,.94);color:#2a1f18;font:650 13px/1.2 P,sans-serif;letter-spacing:-.01em}
${grid}</style></head><body><div class="x">${shots.map((b, i) => `<div><img src="${src(b)}">${i === 0 ? tag : ''}</div>`).join('')}</div></body></html>`)
await layout.evaluate(() => document.fonts.ready)
const png = await layout.locator('.x').screenshot({ omitBackground: true })
// WebP by Chromium's encoder: the PNG drawn on a canvas, quality 0.8
const webp = await layout.evaluate(async (data) => {
  const img = new Image()
  img.src = data
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  c.getContext('2d')!.drawImage(img, 0, 0)
  return c.toDataURL('image/webp', 0.8)
}, src(png))
await browser.close()
if (!webp.startsWith('data:image/webp;base64,')) throw new Error('this Chromium did not encode WebP')
fs.writeFileSync(out, Buffer.from(webp.slice(webp.indexOf(',') + 1), 'base64'))
console.log(`${out}: ${fs.statSync(out).size} bytes`)
