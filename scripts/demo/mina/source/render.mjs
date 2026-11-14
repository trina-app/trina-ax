// Renders the demo pictures into ../assets:
//   Leo's weak first draft (1200×628), banners/leo.html                → banner-leo.<locale>.png
//   the launch campaign over the Higgsfield photos (photos/*.jpg),
//   banners/campaign.html                                               → campaign-banner.<locale>.png (1200×628)
//                                                                          campaign-square.<locale>.png (1080×1080)
//                                                                          campaign-story.<locale>.png (1080×1920)
//   (avatars are photos of made-up people, assets/avatar-<id>.jpg, made with Higgsfield: not rendered here)
// Words come from banners/copy.<locale>.json.
//
//   bun scripts/demo/mina/source/render.mjs [locale]        (default: en)
//
// Needs playwright-core where Bun can find it (e.g. NODE_PATH=<a folder with it>/node_modules) and a Chromium it can
// start (`bunx playwright install chromium-headless-shell`). Pretendard and Fraunces (both SIL OFL 1.1) load from
// jsDelivr and Google Fonts, so it needs the network.
//
// The photos were made once with Higgsfield (gpt_image_2_6, quality medium, 2k, no text in them; the square and the
// story with the hero as a reference so the pouch stays the same) and are not made again here. The pouch's label is
// blank in the photos: campaign.html prints it. higgsfield-photo.jpg in ../assets is photos/hero.jpg made smaller.
// A new language: copy banners/copy.en.json to copy.<locale>.json, translate it, run this with the locale.
// The demo never runs this; it only reads ../assets. Plain .mjs so the repository's typecheck skips it.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'

const here = import.meta.dir
const assets = path.join(here, '..', 'assets')
const locale = process.argv[2] ?? 'en'
const copy = JSON.parse(fs.readFileSync(path.join(here, 'banners', `copy.${locale}.json`), 'utf8'))

const fill = (file, vars = {}) => fs.readFileSync(path.join(here, 'banners', file), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => {
  if (k in vars) return String(vars[k])
  if (!(k in copy)) throw new Error(`copy.${locale}.json has no "${k}" (${file})`)
  return copy[k]
})

/** each photo: its size, the point kept in the middle when cropped (fractions), and the pouch's blank label
 * (fractions of the photo: left, top, right, bottom), measured on the photo */
const PHOTOS = {
  banner: { photo: 'hero.jpg', w: 2688, h: 1520, fx: 0.5, fy: 0.5, label: [0.7786, 0.35, 0.91, 0.6618] },
  square: { photo: 'square.jpg', w: 2048, h: 2048, fx: 0.5, fy: 0.5, label: [0.7466, 0.5024, 0.8994, 0.71] },
  story: { photo: 'story.jpg', w: 1520, h: 2688, fx: 0.5, fy: 0.5, label: [0.5882, 0.5179, 0.8224, 0.6886] },
}
const campaign = (format, w, h) => {
  const { photo, ...cfg } = PHOTOS[format]
  return [fill('campaign.html', { format, w, h, photo, cfg: JSON.stringify(cfg) }), `banners/_campaign-${format}.html`, `campaign-${format}.${locale}.png`, w, h]
}

// pages to shoot: [html text, a temporary file next to the templates (for relative links), output, w, h, transparent]
const only = process.argv[3] // optional: one output name prefix, e.g. "campaign-story"
const jobs = [
  [fill('leo.html'), 'banners/_leo.html', `banner-leo.${locale}.png`, 1200, 628],
  campaign('banner', 1200, 628),
  campaign('square', 1080, 1080),
  campaign('story', 1080, 1920),
].filter((j) => !only || j[2].startsWith(only))

const browser = await chromium.launch()
try {
  for (const [html, tmp, out, w, h, clear] of jobs) {
    const file = path.join(here, tmp)
    fs.writeFileSync(file, html)
    try {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
      await page.goto('file://' + file, { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(300)
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
