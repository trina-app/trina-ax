// Renders the PWA icons (public/icons/*.png) from public/favicon.svg with headless Chromium. Run after changing the
// logo: bun scripts/make-icons.ts (the PNGs are committed, so builds don't need a browser).
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

const WEB = path.resolve(import.meta.dir, '..')
const svg = fs.readFileSync(path.join(WEB, 'public', 'favicon.svg'), 'utf8')
const out = path.join(WEB, 'public', 'icons')
fs.mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage()
async function render(name: string, size: number, maskable: boolean) {
  // maskable icons keep the logo inside the 80 % safe zone on a full-bleed background
  const inner = maskable ? Math.round(size * 0.72) : size
  const radius = maskable ? 0 : Math.round(size * 0.22)
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${maskable ? '#2c6a59' : 'transparent'}">
    <div style="width:${inner}px;height:${inner}px;border-radius:${radius}px;overflow:hidden">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`)
  await page.screenshot({ path: path.join(out, name), omitBackground: !maskable })
}
await render('icon-192.png', 192, false)
await render('icon-512.png', 512, false)
await render('icon-maskable-512.png', 512, true)
await render('apple-touch-icon.png', 180, true)
await browser.close()
console.log('icons written to', out)
