// A picture with transparency in a room message (components/rooms/RoomMessages.tsx RoomThumb): its thumbnail is a PNG
// that keeps the see-through pixels (uploads/image.ts makeThumbnail; a JPEG one made them black), and the message
// paints nothing behind it once it is there, so a red seal stamp sits on the page in light and in dark mode. The
// thumbnail is answered through page.route as the team server sends it (rooms-mock.ts).
// SHOTS_DIR=<folder>: the screenshots (1440, light and dark) go there.
import zlib from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const BEN = { id: 'ben', name: '벤' }
const FILE_ID = '019a5f00-0000-7000-8000-000000000701'

/** a red seal stamp on a see-through square, as a PNG made here (RGBA rows without a filter) */
function sealPng(size = 320): Buffer {
  const c = size / 2
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const ring = d < size * 0.46 && d > size * 0.39
      const block = Math.abs(x - c) < size * 0.2 && Math.abs(y - c) < size * 0.2 && !(Math.abs(x - c) < size * 0.05 || Math.abs(y - c) < size * 0.05)
      if (ring || block) raw.set([196, 30, 36, 255], y * (size * 4 + 1) + 1 + x * 4)
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => { let k = n; for (let i = 0; i < 8; i++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1; return k >>> 0 })
  const crc = (b: Buffer) => { let k = 0xffffffff; for (const x of b) k = table[(k ^ x) & 0xff]! ^ (k >>> 8); return (k ^ 0xffffffff) >>> 0 }
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const SEAL = sealPng()

async function openRoom(page: Page) {
  await reset(page)
  const file = { id: FILE_ID, name: '도장.png', size: SEAL.length, mime: 'image/png', kind: 'image', width: 320, height: 320, thumb: true }
  await routeRoom(page, { members: [BEN], kind: 'team', messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '계약서에 찍을 도장이에요', extra: { files: [file] } }] })
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, (route) => route.fulfill({
    status: 200, body: SEAL,
    headers: { 'content-type': 'image/png', 'content-disposition': 'inline; filename="도장.png.png"', 'x-content-type-options': 'nosniff' },
  }))
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(1)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`a transparent picture sits on the message, nothing painted behind it (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await openRoom(page)
    const button = page.getByTestId('room-image')
    const img = button.locator('img')
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth)).toBe(320)
    // after it loads: no background on the picture or the button around it (the soft box only held the place)
    await expect.poll(() => img.evaluate((e) => [getComputedStyle(e).backgroundColor, getComputedStyle(e.parentElement!).backgroundColor])).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
    const dir = process.env.SHOTS_DIR
    if (dir) {
      await page.mouse.move(0, 899)
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/room-transparent-1440-${scheme}.png` })
    }
  })
}
