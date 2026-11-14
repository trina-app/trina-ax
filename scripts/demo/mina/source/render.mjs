// Renders the demo pictures into ../assets:
//   banners (1200×628) from banners/*.html filled with banners/copy.<locale>.json → banner-leo.<locale>.png, …
//   the Instagram square (1080×1080) and story (1080×1920) of A and B, kit.html       → square-a.<locale>.png, story-b…
//   the "Higgsfield" background (no words, every locale)                       → bg-b.png
//   avatars: photos in assets/avatar-<id>.jpg (512×512, made with Higgsfield), not rendered here
//
//   bun scripts/demo/mina/source/render.mjs [locale]        (default: en)
//
// Needs playwright-core where Bun can find it (e.g. NODE_PATH=<a folder with it>/node_modules) and a Chromium it can
// start (`bunx playwright install chromium-headless-shell`). Pretendard (SIL OFL 1.1) is loaded from jsDelivr, so it
// needs the network. Afterwards make the PNGs small (256 colours; Python with Pillow):
//   python3 -c "from PIL import Image; import sys; [Image.open(p).convert('RGB').quantize(256, dither=Image.Dither.FLOYDSTEINBERG).save(p, optimize=True) for p in sys.argv[1:]]" scripts/demo/mina/assets/b*.png scripts/demo/mina/assets/square-*.png scripts/demo/mina/assets/story-*.png
// A new language: copy banners/copy.en.json to copy.<locale>.json, translate it, run this with the locale.
// The demo never runs this; it only reads ../assets. Plain .mjs so the repository's typecheck skips it.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const here = import.meta.dir
const assets = path.join(here, '..', 'assets')
const locale = process.argv[2] ?? 'en'
const copy = JSON.parse(fs.readFileSync(path.join(here, 'banners', `copy.${locale}.json`), 'utf8'))

/** the people's avatars: initials, background, letters, shape colour */
const AVATARS = [
  ['mina', 'ML', '#F2B630', '#1F4D3A', '#FBE3A2'],
  ['sara', 'SJ', '#2F6B8F', '#F6F1E7', '#5B95B8'],
  ['daniel', 'DO', '#1F4D3A', '#F6F1E7', '#2F6B52'],
  ['leo', 'LS', '#D9824B', '#FFF7EE', '#E9A574'],
  ['tom', 'TB', '#6B5CA5', '#F4F1FB', '#8C80BD'],
  ['aiko', 'AT', '#C55A7A', '#FFF3F6', '#DA86A0'],
  ['omar', 'OH', '#3D7D6E', '#EEF7F4', '#62A08F'],
  ['chris', 'CW', '#3B4A5C', '#F3F5F8', '#5E7085'],
]
const SHAPES = [
  (c) => `<circle cx="208" cy="48" r="70" fill="${c}"/>`,
  (c) => `<rect x="150" y="-30" width="140" height="140" rx="30" transform="rotate(20 220 40)" fill="${c}"/>`,
  (c) => `<path d="M0 200 Q128 120 256 200 V256 H0Z" fill="${c}"/>`,
  (c) => `<circle cx="40" cy="220" r="80" fill="${c}"/>`,
]
const avatarPage = ([, initials, bg, fg, shape], i) => `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="banners/product.css">
<style>html,body{width:256px;height:256px;background:transparent}</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><clipPath id="c"><circle cx="128" cy="128" r="128"/></clipPath>
<g clip-path="url(#c)"><rect width="256" height="256" fill="${bg}"/>${SHAPES[i % SHAPES.length](shape)}</g>
<text x="128" y="128" dy=".35em" text-anchor="middle" font-family="Pretendard, sans-serif" font-weight="800" font-size="92" letter-spacing="-2" fill="${fg}">${initials}</text></svg></body></html>`

const fill = (file, vars = {}) => fs.readFileSync(path.join(here, 'banners', file), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => {
  if (k in vars) return String(vars[k])
  if (!(k in copy)) throw new Error(`copy.${locale}.json has no "${k}" (${file})`)
  return copy[k]
})
/** the Instagram square and story of version A or B (kit.html) */
const kit = (theme, format, w, h) => [fill('kit.html', { theme, format, w, h }), `banners/_kit-${theme}-${format}.html`, `${format}-${theme}.${locale}.png`, w, h]

// pages to shoot: [html text, a temporary file next to the templates (for relative links), output, w, h, transparent]
const jobs = [
  [fill('bg-b.html'), 'banners/_bg-b.html', 'bg-b.png', 1200, 628],
  [fill('leo.html'), 'banners/_leo.html', `banner-leo.${locale}.png`, 1200, 628],
  [fill('a.html'), 'banners/_a.html', `banner-a.${locale}.png`, 1200, 628],
  [fill('b.html'), 'banners/_b.html', `banner-b.${locale}.png`, 1200, 628],
  kit('a', 'square', 1080, 1080),
  kit('a', 'story', 1080, 1920),
  kit('b', 'square', 1080, 1080),
  kit('b', 'story', 1080, 1920),
  // (avatars are photos now: assets/avatar-<id>.jpg, made with Higgsfield; the initials pages below are not rendered)
]

const browser = await chromium.launch()
try {
  for (const [html, tmp, out, w, h, clear] of jobs) {
    const file = path.join(here, tmp)
    fs.writeFileSync(file, html)
    try {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
      await page.goto('file://' + file)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(150)
      await page.screenshot({ path: path.join(assets, out), clip: { x: 0, y: 0, width: w, height: h }, omitBackground: !!clear })
      await page.close()
      console.log('wrote assets/' + out)
    } finally {
      fs.rmSync(file, { force: true })
    }
  }
} finally {
  await browser.close()
}
