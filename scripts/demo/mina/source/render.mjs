// Renders the 미나 demo pictures into ../assets from the HTML and SVG in this folder: the three banners and the
// "Higgsfield" background (1200×628), and the avatars (256×256).
//   bun scripts/demo/mina/source/render.mjs
// Needs playwright-core where Bun can find it (e.g. NODE_PATH=<a folder with it>/node_modules) and a Chromium it can
// start (`bunx playwright install chromium-headless-shell`). The banners load Pretendard (SIL OFL 1.1) from jsDelivr,
// so it needs the network. Afterwards make the PNGs small (256 colours; Python with Pillow):
//   python3 -c "from PIL import Image; import sys; [Image.open(p).convert('RGB').quantize(256, dither=Image.Dither.FLOYDSTEINBERG).save(p, optimize=True) for p in sys.argv[1:]]" scripts/demo/mina/assets/b*.png
// The demo never runs this; it only reads the files in ../assets. Plain .mjs so the repository's typecheck skips it.
import path from 'node:path'
import { chromium } from 'playwright-core'

const here = import.meta.dir
const assets = path.join(here, '..', 'assets')

const jobs = [
  // the background first: b.html uses it
  { from: 'banners/bg-b.html', to: 'bg-b.png', w: 1200, h: 628 },
  { from: 'banners/leo.html', to: 'banner-leo.png', w: 1200, h: 628 },
  { from: 'banners/a.html', to: 'banner-a.png', w: 1200, h: 628 },
  { from: 'banners/b.html', to: 'banner-b.png', w: 1200, h: 628 },
  ...['mina', 'seoyeon', 'woojin', 'leo', 'doyun', 'haeun', 'jisu'].map((n) => ({ from: `avatars/${n}.svg`, to: `avatar-${n}.png`, w: 256, h: 256, clear: true })),
]

const browser = await chromium.launch()
try {
  for (const j of jobs) {
    const page = await browser.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: 1 })
    await page.goto('file://' + path.join(here, j.from))
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(assets, j.to), clip: { x: 0, y: 0, width: j.w, height: j.h }, omitBackground: !!j.clear })
    await page.close()
    console.log('wrote assets/' + j.to)
  }
} finally {
  await browser.close()
}
