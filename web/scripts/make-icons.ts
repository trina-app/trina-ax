// Renders the PWA icons (public/icons/*.png), the PNG tab icons (public/icons/favicon-16/32/48.png) and
// public/favicon.ico (those three PNGs in one ICO, for browsers and systems that ask for /favicon.ico on their own) from
// public/favicon.svg with headless Chromium. Run after changing the logo: bun scripts/make-icons.ts (the files are
// committed, so builds don't need a browser). A team's own logo never replaces them: it shows only in the sidebar
// header (shared/src/team-icon.ts).
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'

const WEB = path.resolve(import.meta.dir, '..')
const svg = fs.readFileSync(path.join(WEB, 'public', 'favicon.svg'), 'utf8')
// maskable and Apple touch icons are full-bleed: the logo's own tile colour (its first <rect>) fills the square, so the
// edges match the mark (Trina: warm black #14110f). The logo's accent would hide its orange spark.
const tile = svg.match(/<rect\b[^>]*\bfill="(#[0-9a-f]{3,8})"/i)?.[1]
if (!tile) throw new Error('favicon.svg: no <rect fill="#…"> tile to use as the maskable background')
// the mark's own scale inside favicon.svg's tile (its first scale(…)); full-bleed icons size the mark from it
const markScale = Number(svg.match(/scale\(([\d.]+)\)/)?.[1] ?? 1)
/** Full-bleed icons: the mark at this share of the square. The Trina mark reaches 0.45 of its box from the centre
 * (its side corners), so at 0.82 it ends at 0.37 of the icon, inside the 0.40 safe circle of maskable icons (an Android
 * mask can be a circle); macOS's Dock and iOS cut a rounder square and show it whole. It was 0.56, which left the
 * logo small in the Dock with a wide black frame. */
const FULL_BLEED_MARK = 0.82
const out = path.join(WEB, 'public', 'icons')
fs.mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage()
async function render(name: string, size: number, maskable: boolean) {
  // maskable icons keep the logo inside the 80 % safe zone on a full-bleed background (the tile's colour around it)
  const inner = maskable ? Math.round(size * FULL_BLEED_MARK / markScale) : size
  const radius = maskable ? 0 : Math.round(size * 0.22)
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${maskable ? tile : 'transparent'}">
    <div style="width:${inner}px;height:${inner}px;border-radius:${radius}px;overflow:hidden">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`)
  await page.screenshot({ path: path.join(out, name), omitBackground: !maskable })
}
await render('icon-192.png', 192, false)
await render('icon-512.png', 512, false)
await render('icon-maskable-512.png', 512, true)
await render('apple-touch-icon.png', 180, true)
const favicons = [16, 32, 48]
for (const size of favicons) await render(`favicon-${size}.png`, size, false)
await browser.close()
fs.writeFileSync(path.join(WEB, 'public', 'favicon.ico'), ico(favicons.map((size) => ({ size, png: fs.readFileSync(path.join(out, `favicon-${size}.png`)) }))))
console.log('icons written to', out, 'and public/favicon.ico')

/** An ICO file holding PNG images (every browser and Windows since Vista read PNG entries). */
function ico(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(0, 0) // reserved
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach((im, i) => {
    const e = 6 + 16 * i
    head.writeUInt8(im.size >= 256 ? 0 : im.size, e) // width (0 = 256)
    head.writeUInt8(im.size >= 256 ? 0 : im.size, e + 1) // height
    head.writeUInt8(0, e + 2) // no palette
    head.writeUInt8(0, e + 3) // reserved
    head.writeUInt16LE(1, e + 4) // colour planes
    head.writeUInt16LE(32, e + 6) // bits per pixel
    head.writeUInt32LE(im.png.byteLength, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += im.png.byteLength
  })
  return Buffer.concat([head, ...images.map((im) => Buffer.from(im.png))])
}
