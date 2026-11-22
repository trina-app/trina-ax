// Several pictures in one room message as an even gallery, like Slack's (RoomMessages.tsx PictureGallery,
// lib/imageGallery.ts; docs/AGENTS/plan/20261122-0419-image-gallery-rows.md): messages with 1 to 5 pictures of mixed
// wide and tall shapes. Every tile of a row has one height, every row ends at the gallery's right edge, the page never
// scrolls sideways at 390, and a tile opens the viewer with the whole picture and ← → through the others.
// SHOTS_DIR=<folder>: screenshots at 1440 and 390, light and dark, go there.
import zlib from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(800 + n).padStart(12, '0')}`

/** a stand-in screenshot or photo: a soft two-colour gradient with a title bar, w × h, as a PNG made here */
function png(w: number, h: number, hue: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  const rgb = (l: number): [number, number, number] => {
    const a = (hue % 360) / 60, c = l, x = c * (1 - Math.abs((a % 2) - 1))
    const [r, g, b] = a < 1 ? [c, x, 0] : a < 2 ? [x, c, 0] : a < 3 ? [0, c, x] : a < 4 ? [0, x, c] : a < 5 ? [x, 0, c] : [c, 0, x]
    return [Math.round(60 + r * 180), Math.round(60 + g * 180), Math.round(60 + b * 180)]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bar = y < Math.max(8, h * 0.06)
      const box = x > w * 0.1 && x < w * 0.9 && y > h * 0.25 && y < h * 0.75 && ((x / 8) | 0) % 6 !== 0
      const [r, g, b] = bar ? [40, 44, 52] : box ? [245, 247, 250] : rgb(0.35 + 0.5 * ((x / w + y / h) / 2))
      raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3)
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => { let k = n; for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0 })
  const crc = (b: Buffer) => { let k = 0xffffffff; for (const v of b) k = table[(k ^ v) & 0xff]! ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0 }
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// [width, height] of each message's pictures: wide screenshots, phone photos, a square
const SHAPES: [number, number][][] = [
  [[1600, 900]],
  [[1600, 900], [900, 1600]],
  [[1440, 900], [1280, 800], [750, 1334]],
  [[1600, 900], [900, 1600], [1200, 1200], [1440, 900]],
  [[1440, 900], [750, 1334], [1600, 900], [900, 1600], [1200, 900]],
]
const BODIES = ['홈 화면 새 배너예요', '가로 하나 세로 하나', '오늘 QA 스크린샷 세 장', '네 장 비교해 주세요', '다섯 장: 데스크톱과 폰']

async function openRoom(page: Page) {
  await reset(page)
  const images = new Map<string, Buffer>()
  let n = 0
  const messages = SHAPES.map((shapes, m) => ({
    id: id(m), author: BEN, body: BODIES[m]!,
    extra: {
      files: shapes.map(([w, h], i) => {
        const fid = id(100 + ++n)
        const scale = 480 / Math.max(w, h)
        images.set(fid, png(Math.round(w * scale), Math.round(h * scale), 40 + n * 47))
        return { id: fid, name: `qa-${m + 1}-${i + 1}.png`, size: 1000, mime: 'image/png', kind: 'image', width: w, height: h, thumb: true }
      }),
    },
  }))
  await routeRoom(page, { members: [BEN], kind: 'team', messages })
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, (route) => {
    const fid = new URL(route.request().url()).pathname.split('/').pop()!
    const body = images.get(fid)
    return body ? route.fulfill({ status: 200, body, headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' } }) : route.fulfill({ status: 404 })
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(SHAPES.length)
}

/** each gallery's rows: the tiles' heights, and the rows' left and right edges against the gallery's */
const geometry = (page: Page) => page.getByTestId('room-gallery').evaluateAll((gs) => gs.map((g) => {
  const box = g.getBoundingClientRect()
  return [...g.querySelectorAll('[data-testid="room-gallery-row"]')].map((row) => {
    const tiles = [...row.querySelectorAll('[data-testid="room-image"]')].map((t) => t.getBoundingClientRect())
    return { heights: tiles.map((t) => t.height), left: tiles[0]!.left - box.left, right: box.right - tiles[tiles.length - 1]!.right, narrowest: Math.min(...tiles.map((t) => t.width)) }
  })
}))

for (const width of [1440, 390] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`1 to 5 pictures: even rows, both edges lined up, no sideways scroll (${width}, ${scheme})`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await openRoom(page)
      // the single picture keeps its own shape; 2 to 5 are galleries of 1, 1, 2 and 2 rows
      await expect(page.getByTestId('room-gallery')).toHaveCount(4)
      expect(await page.getByTestId('room-gallery').evaluateAll((gs) => gs.map((g) => g.querySelectorAll('[data-testid="room-gallery-row"]').length))).toEqual([1, 1, 2, 2])
      const rows = (await geometry(page)).flat()
      for (const r of rows) {
        expect(Math.max(...r.heights) - Math.min(...r.heights)).toBeLessThan(1)
        expect(Math.abs(r.left)).toBeLessThan(1)
        expect(Math.abs(r.right)).toBeLessThan(1)
        expect(r.narrowest).toBeGreaterThan(width === 390 ? 40 : 64)
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      // each message's pictures load once it is on screen (lazy): then nothing paints behind them
      for (const msg of await page.getByTestId('room-message').all()) {
        await msg.scrollIntoViewIfNeeded()
        await expect.poll(() => msg.locator('img').evaluateAll((ims) => ims.every((im) => (im as HTMLImageElement).complete && (im as HTMLImageElement).naturalWidth > 0))).toBe(true)
      }
      const dir = process.env.SHOTS_DIR
      if (dir) {
        await page.mouse.move(0, 0)
        const list = page.getByTestId('room-message').first()
        for (const [i, msg] of (await page.getByTestId('room-message').all()).entries()) {
          await msg.scrollIntoViewIfNeeded()
          await page.waitForTimeout(150)
          await msg.screenshot({ path: `${dir}/gallery-${i + 1}-images-${width}-${scheme}.png` })
        }
        await list.scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${dir}/gallery-page-top-${width}-${scheme}.png` })
        await page.getByTestId('room-message').last().scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${dir}/gallery-page-bottom-${width}-${scheme}.png` })
      }
    })
  }
}

test('a tile opens the viewer with the whole picture; ← → walk through the pictures; Enter on a focused tile opens it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openRoom(page)
  const third = page.getByTestId('room-gallery').nth(1)
  await third.getByTestId('room-image').nth(1).click()
  await expect(page.getByTestId('image-viewer')).toBeVisible()
  await expect(page.getByTestId('image-viewer-name')).toHaveText('qa-3-2.png')
  // the original is not cropped: its own shape (1280 × 800 stored, a 480 × 300 picture here)
  const original = page.getByTestId('image-viewer-original')
  await expect.poll(() => original.evaluate((e) => { const b = e.getBoundingClientRect(); return Math.round((b.width / b.height) * 10) / 10 })).toBe(1.6)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('qa-3-3.png')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('qa-3-1.png')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('image-viewer')).toHaveCount(0)
  await third.getByTestId('room-image').first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('qa-3-1.png')
})
