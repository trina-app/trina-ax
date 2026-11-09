// The image viewer (components/ImageViewer.tsx): a picture clicked in a room, a thread, the AI chat or the file panel
// opens over the whole window, like Slack. Fitted and never upscaled; the thumbnail first, then the original through the
// room (no new address); a click zooms to 100 % about its point; ← → walk the pane's pictures; Esc, ✕, the backdrop
// and Back close it, and focus goes back to the picture. The desktop app's 이미지 복사 copies what is under the pointer:
// that is the original, drawn on the page itself. A phone: the bar hides on a tap, a swipe sideways steps, a swipe down
// closes. 복사 and ⌘C put the picture on the clipboard as a PNG (the browser's own clipboard in this run: Chromium's,
// granted by playwright.config.ts, never the computer's). A room's photo has its thread beside it on computers (the
// viewer's column, room-file-viewer.spec.ts), so it is fitted to the stage left of it. The room is answered through
// page.route as the team server sends it (rooms-mock.ts).
// SHOTS_DIR=<folder>: the screenshots (1440 light fitted, 1440 dark zoomed, 390 light; 복사 at 1440 light and its toast at
// 390 light) go there.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const SHOT_ID = id(801)

/** A screenshot of a web page, as a PNG made here: a dark top bar, a title, lines of text and a blue button. */
function pagePng(w: number, h: number): Buffer {
  const k = w / 2880
  const raw = Buffer.alloc((w * 3 + 1) * h)
  const fill = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
    for (let y = Math.max(0, Math.round(y0 * k)); y < Math.min(h, Math.round(y1 * k)); y++) {
      const row = y * (w * 3 + 1) + 1
      for (let x = Math.max(0, Math.round(x0 * k)); x < Math.min(w, Math.round(x1 * k)); x++) raw.set(rgb, row + x * 3)
    }
  }
  fill(0, 0, 2880, 1800, [250, 250, 248])
  fill(0, 0, 2880, 140, [30, 30, 34])
  fill(120, 50, 420, 90, [240, 240, 240])
  fill(240, 260, 1500, 360, [20, 20, 24])
  for (let i = 0; i < 12; i++) fill(240, 440 + i * 80, 240 + 2200 - (i % 3) * 420, 476 + i * 80, [120, 122, 128])
  fill(240, 1480, 760, 1600, [37, 99, 235])
  fill(2000, 260, 2640, 1100, [226, 232, 240])
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
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
// a retina screenshot (the owner's case: a web page, hard to read small) and its 640 px thumbnail; a small icon
const SHOT = pagePng(2880, 1800)
const SHOT_THUMB = pagePng(640, 400)
const ICON = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))

const shotFile = { id: SHOT_ID, name: 'acme-page.png', size: SHOT.length, mime: 'image/png', kind: 'image', width: 2880, height: 1800, thumb: true }
const iconFile = (n: number, name: string) => ({ id: id(n), name, size: ICON.length, mime: 'image/png', kind: 'image', width: 192, height: 192, thumb: true })
type Msg = NonNullable<Parameters<typeof routeRoom>[1]['messages']>[number]

/** The room: Ben's screenshot and his icon, or `messages`; its photos as the team server sends them (any other id is
 * the icon). */
type Served = { body: Buffer; type: string }
async function openRoom(page: Page, o: { messages?: Msg[]; at?: string; bodies?: Record<string, Served & { thumb?: Served }> } = {}) {
  await reset(page)
  const messages = o.messages ?? [
    { id: id(1), author: BEN, body: '이 페이지 좀 봐 주세요', extra: { files: [shotFile] } },
    { id: id(2), author: BEN, body: '아이콘도요', extra: { files: [iconFile(802, 'acme-icon.png')] } },
  ]
  await routeRoom(page, { members: [BEN], kind: 'team', messages })
  const served: string[] = []
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, async (route) => {
    const u = new URL(route.request().url())
    const fid = u.pathname.split('/').pop()!
    const thumb = u.searchParams.get('thumb') === '1'
    const download = u.searchParams.get('download') === '1'
    served.push(`${fid === SHOT_ID ? 'page' : 'icon'}${u.search}`)
    const own = o.bodies?.[fid] ? (thumb ? (o.bodies[fid]!.thumb ?? o.bodies[fid]!) : o.bodies[fid]!) : undefined
    const body = own ? own.body : fid === SHOT_ID ? (thumb ? SHOT_THUMB : SHOT) : ICON
    // the original comes a moment after the thumbnail, as a large file over a network does
    if (!thumb && !download) await new Promise((r) => setTimeout(r, 300))
    return route.fulfill({
      status: 200, body,
      headers: { 'content-type': own?.type ?? 'image/png', 'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${fid === SHOT_ID ? 'acme-page.png' : 'acme-icon.png'}"`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" },
    })
  })
  await signIn(page)
  await page.goto(o.at ?? `/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  if (!o.messages) await expect(page.getByTestId('room-message')).toHaveCount(2)
  return { served }
}

const viewer = (page: Page) => page.getByTestId('image-viewer')
const original = (page: Page) => page.getByTestId('image-viewer-original')
/** the original drawn: loaded, the thumbnail gone */
async function shown(page: Page) {
  await expect(original(page)).toHaveAttribute('data-state', 'shown')
  await expect(page.getByTestId('image-viewer-thumb')).toHaveCount(0)
}
async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('a room photo opens full-window: thumbnail, then the original, fitted; the bar says what and who', async ({ page }) => {
  const { served } = await openRoom(page)
  await page.getByTestId('room-image').first().click()
  const v = viewer(page)
  await expect(v).toBeVisible()
  await expect(v).toHaveAttribute('aria-modal', 'true')
  await expect(page.getByRole('dialog', { name: '이미지 보기: acme-page.png' })).toBeVisible()
  // the side panel did not open
  await expect(page.getByTestId('file-panel')).toHaveCount(0)
  await shown(page)
  // the original, read through the room inline: no new address
  expect(new URL((await original(page).getAttribute('src'))!, 'http://x').pathname).toBe(`/api/rooms/${ROOM_ID}/files/${SHOT_ID}`)
  expect(served).toEqual(expect.arrayContaining(['page?thumb=1', 'page']))
  // fitted to the stage under the bar, left of the photo's thread (the 400 px column), centred
  const stage = (await page.getByTestId('image-viewer-stage').boundingBox())!
  const pic = (await original(page).boundingBox())!
  expect(stage).toMatchObject({ x: 0, y: 56, width: 1040 })
  await expect(v.getByTestId('viewer-column')).toHaveAttribute('data-show', 'thread')
  const scale = Math.min(stage.width / 2880, stage.height / 1800)
  expect(pic.width).toBeCloseTo(2880 * scale, 0)
  expect(pic.height).toBeCloseTo(1800 * scale, 0)
  expect(pic.x + pic.width / 2).toBeCloseTo(520, 0)
  expect(pic.y + pic.height / 2).toBeCloseTo(stage.y + stage.height / 2, 0)
  await expect(page.getByTestId('image-viewer-zoom')).toHaveText(`${Math.round(scale * 100)}%`)
  // the bar: the name, who sent it and when, where it is in the room
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-page.png')
  await expect(page.getByTestId('image-viewer-sent')).toContainText('벤')
  await expect(page.getByTestId('image-viewer-sent').locator('time')).toHaveCount(1)
  await expect(page.getByTestId('image-viewer-count')).toHaveText('1 / 2')
  await expect(page.getByTestId('image-viewer-download')).toBeVisible()
  await expect(page.getByTestId('image-viewer-open')).toHaveAttribute('target', '_blank')
  await audit(page, 'viewer')
  // the download is the room's own, as an attachment
  const [d] = await Promise.all([page.waitForEvent('download'), page.getByTestId('image-viewer-download').click()])
  expect(d.suggestedFilename()).toBe('acme-page.png')
  expect(new URL(d.url()).searchParams.get('download')).toBe('1')
})

test('a small picture is not upscaled; a click zooms to 100 % about its point and back', async ({ page }) => {
  await openRoom(page)
  await page.getByTestId('room-image').nth(1).click()
  await shown(page)
  const icon = (await original(page).boundingBox())!
  expect(icon.width).toBeCloseTo(192, 0)
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-page.png')
  await shown(page)
  // a click on the picture: 100 %, the point under the pointer stays put
  const before = (await original(page).boundingBox())!
  const at = { x: before.x + before.width * 0.25, y: before.y + before.height * 0.3 }
  await page.mouse.click(at.x, at.y)
  await expect(viewer(page)).toHaveAttribute('data-zoomed', '')
  await expect(page.getByTestId('image-viewer-zoom')).toHaveText('100%')
  await page.waitForTimeout(300)
  const after = (await original(page).boundingBox())!
  expect(after.width).toBeCloseTo(2880, 0)
  expect(at.x - after.x).toBeCloseTo(2880 * 0.25, -1)
  expect(at.y - after.y).toBeCloseTo(1800 * 0.3, -1)
  // a drag pans it
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 200, at.y + 100, { steps: 5 })
  await page.mouse.up()
  const panned = (await original(page).boundingBox())!
  expect(panned.x - after.x).toBeCloseTo(200, 0)
  expect(panned.y - after.y).toBeCloseTo(100, 0)
  // a second click (not a drag) goes back to fitted
  await page.mouse.click(at.x, at.y)
  await expect(viewer(page)).not.toHaveAttribute('data-zoomed', '')
  // ⌘/Ctrl + wheel zooms, 0 fits again, + and the bar's buttons step
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -200)
  await page.keyboard.up('Control')
  await expect(viewer(page)).toHaveAttribute('data-zoomed', '')
  await page.keyboard.press('0')
  await expect(viewer(page)).not.toHaveAttribute('data-zoomed', '')
  await page.keyboard.press('+')
  await expect(viewer(page)).toHaveAttribute('data-zoomed', '')
  await page.getByTestId('image-viewer-zoom-out').click()
  await expect(viewer(page)).not.toHaveAttribute('data-zoomed', '')
})

test('← → step through the room\'s pictures; Esc closes and focus goes back to the picture', async ({ page }) => {
  await openRoom(page)
  const first = page.getByTestId('room-image').first()
  await first.click()
  await shown(page)
  await expect(page.getByTestId('image-viewer-prev')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-icon.png')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('2 / 2')
  await expect(page.getByTestId('image-viewer-next')).toHaveCount(0)
  await page.getByTestId('image-viewer-prev').click()
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-page.png')
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  await expect(first).toBeFocused()
  // no history entry left behind
  expect(await page.evaluate(() => (history.state as Record<string, unknown> | null)?.__imageViewer)).toBeUndefined()
})

test('a click on the backdrop, ✕ and Back close it; Back stays on the room', async ({ page }) => {
  await openRoom(page)
  const url = page.url()
  await page.getByTestId('room-image').nth(1).click()
  await shown(page)
  // the backdrop beside the small icon
  const stage = (await page.getByTestId('image-viewer-stage').boundingBox())!
  await page.mouse.click(stage.x + 40, stage.y + stage.height - 40)
  await expect(viewer(page)).toHaveCount(0)
  await page.getByTestId('room-image').nth(1).click()
  await page.getByTestId('image-viewer-close').click()
  await expect(viewer(page)).toHaveCount(0)
  await page.getByTestId('room-image').nth(1).click()
  await expect(viewer(page)).toBeVisible()
  await page.goBack()
  await expect(viewer(page)).toHaveCount(0)
  expect(page.url()).toBe(url)
  await expect(page.getByTestId('room-message')).toHaveCount(2)
})

test('the desktop app\'s 이미지 복사 gets the original: the viewer\'s picture is on the page, the one under the pointer', async ({ page }) => {
  await openRoom(page)
  await page.evaluate(() => {
    const w = window as unknown as { __menus: { tag: string; src: string; prevented: boolean }[] }
    w.__menus = []
    window.addEventListener('contextmenu', (e) => {
      const el = e.target as HTMLImageElement
      w.__menus.push({ tag: el.tagName, src: el.src ?? '', prevented: e.defaultPrevented })
      e.preventDefault()
    })
  })
  await page.getByTestId('room-image').first().click()
  await shown(page)
  const box = (await original(page).boundingBox())!
  const top = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y) as HTMLImageElement | null
    return { tag: el?.tagName, testId: el?.dataset.testid, framed: window !== window.top }
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  expect(top).toEqual({ tag: 'IMG', testId: 'image-viewer-original', framed: false })
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  const menus = () => page.evaluate(() => (window as unknown as { __menus: { tag: string; src: string; prevented: boolean }[] }).__menus)
  await expect.poll(menus).toHaveLength(1)
  expect((await menus())[0]).toMatchObject({ tag: 'IMG', prevented: false, src: expect.stringMatching(new RegExp(`/api/rooms/${ROOM_ID}/files/${SHOT_ID}$`)) })
  // the right-click did not zoom or close it
  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page)).not.toHaveAttribute('data-zoomed', '')
})

/** The PNG on the browser's clipboard: its size, and the pixels (RGBA) at the points asked; null: no PNG there. */
async function clipboardPng(page: Page, at: { x: number; y: number }[] = []) {
  return page.evaluate(async (points) => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'))
    if (!item) return null
    const blob = await item.getType('image/png')
    const bmp = await createImageBitmap(blob)
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!
    g.drawImage(bmp, 0, 0)
    return { type: blob.type, width: bmp.width, height: bmp.height, px: points.map(({ x, y }) => [...g.getImageData(x, y, 1, 1).data]) }
  }, at)
}
const emptyClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.writeText(''))
const toastText = (page: Page) => page.getByTestId('toast').last()

test('복사 puts the original on the clipboard as a PNG, with no new request; ⌘C / Ctrl+C does too', async ({ page }) => {
  const { served } = await openRoom(page)
  await page.getByTestId('room-image').first().click()
  await shown(page)
  const asked = served.length
  const copy = page.getByTestId('image-viewer-copy')
  await expect(copy).toHaveAccessibleName('복사')
  // beside the download
  const [cb, db] = [(await copy.boundingBox())!, (await page.getByTestId('image-viewer-download').boundingBox())!]
  expect(db.x - (cb.x + cb.width)).toBeLessThan(8)
  await emptyClipboard(page)
  await copy.click()
  await expect(toastText(page)).toHaveText('이미지를 복사했어요')
  // said inside the dialog too (a screen reader may not read the toast outside it)
  await expect(page.getByTestId('image-viewer-said')).toHaveText(/^이미지를 복사했어요/)
  // the original at its own size (the thumbnail is 640 × 400)
  expect(await clipboardPng(page, [{ x: 10, y: 10 }])).toEqual({ type: 'image/png', width: 2880, height: 1800, px: [[30, 30, 34, 255]] })
  // the keys, ⌘C with the focus on the picture as it opened and Ctrl+C on a button of the bar
  await emptyClipboard(page)
  await page.getByTestId('image-viewer-stage').focus()
  await page.keyboard.press('Meta+c')
  await expect.poll(async () => (await clipboardPng(page))?.width).toBe(2880)
  await emptyClipboard(page)
  await page.getByTestId('image-viewer-download').focus()
  await page.keyboard.press('Control+c')
  await expect.poll(async () => (await clipboardPng(page))?.width).toBe(2880)
  // the picture already drawn: nothing was asked of the server again
  expect(served.slice(asked)).toEqual([])
  // the viewer stays open, not zoomed
  await expect(viewer(page)).toBeVisible()
  await expect(viewer(page)).not.toHaveAttribute('data-zoomed', '')
  await audit(page, 'viewer after a copy')
})

test('a JPEG and a WebP are copied as PNGs, the WebP\'s transparency kept; a copy while the original loads waits for it', async ({ page }) => {
  // made by the browser itself: a 200 × 100 picture, its left half transparent and its right half red; its thumbnail
  // is 100 × 50, so the size on the clipboard tells which was copied
  const made = await page.evaluate(async () => {
    const draw = (w: number, h: number) => {
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')!
      g.fillStyle = 'rgb(220, 20, 30)'
      g.fillRect(w / 2, 0, w / 2, h)
      return c
    }
    const b64 = async (c: OffscreenCanvas, type: string) => {
      const bytes = new Uint8Array(await (await c.convertToBlob({ type, quality: 1 })).arrayBuffer())
      return btoa(Array.from(bytes, (x) => String.fromCharCode(x)).join(''))
    }
    return { webp: await b64(draw(200, 100), 'image/webp'), jpeg: await b64(draw(200, 100), 'image/jpeg'), thumb: await b64(draw(100, 50), 'image/png') }
  })
  const webp = Buffer.from(made.webp, 'base64')
  const jpeg = Buffer.from(made.jpeg, 'base64')
  const small = { body: Buffer.from(made.thumb, 'base64'), type: 'image/png' }
  const pic = (n: number, name: string, mime: string, body: Buffer) => ({ id: id(n), name, size: body.length, mime, kind: 'image', width: 200, height: 100, thumb: true })
  await openRoom(page, {
    messages: [
      { id: id(1), author: BEN, body: '도장', extra: { files: [pic(811, 'acme-stamp.webp', 'image/webp', webp)] } },
      { id: id(2), author: BEN, body: '사진', extra: { files: [pic(812, 'acme-photo.jpg', 'image/jpeg', jpeg)] } },
    ],
    bodies: { [id(811)]: { body: webp, type: 'image/webp', thumb: small }, [id(812)]: { body: jpeg, type: 'image/jpeg', thumb: small } },
  })
  // the stamp's original is held on its way: the thumbnail shows meanwhile
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route((u) => u.pathname === `/api/rooms/${ROOM_ID}/files/${id(811)}` && !u.search, async (route) => {
    await held
    await route.fallback()
  })
  await page.getByTestId('room-image').first().click()
  await expect(page.getByTestId('image-viewer-thumb')).toBeVisible()
  await expect(original(page)).toHaveAttribute('data-state', 'loading')
  await emptyClipboard(page)
  await page.getByTestId('image-viewer-copy').click()
  // the copy waits for the original: nothing yet, then the original itself (not the thumbnail: no "small" line)
  await page.waitForTimeout(400)
  await expect(page.getByTestId('toast')).toHaveCount(0)
  release()
  await expect(toastText(page)).toHaveText('이미지를 복사했어요')
  const stamp = await clipboardPng(page, [{ x: 20, y: 50 }, { x: 180, y: 50 }])
  expect(stamp).toMatchObject({ type: 'image/png', width: 200, height: 100 })
  expect(stamp!.px[0]![3]).toBe(0)
  expect(stamp!.px[1]![3]).toBe(255)
  expect(stamp!.px[1]![0]).toBeGreaterThan(200)
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-photo.jpg')
  await shown(page)
  await emptyClipboard(page)
  const said = page.getByTestId('image-viewer-said')
  const before = await said.textContent()
  await page.keyboard.press('ControlOrMeta+c')
  // a second result, said again (the toast of the first may still be on screen)
  await expect.poll(() => said.textContent()).not.toBe(before)
  await expect(said).toHaveText(/^이미지를 복사했어요\s*$/)
  const photo = await clipboardPng(page, [{ x: 180, y: 50 }])
  expect(photo).toMatchObject({ width: 200, height: 100 })
  expect(photo!.px[0]![0]).toBeGreaterThan(180)
})

test('a copy still waiting for its original is given up when the viewer closes: what was copied since stays', async ({ page }) => {
  await openRoom(page)
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route((u) => u.pathname === `/api/rooms/${ROOM_ID}/files/${SHOT_ID}` && !u.search, async (route) => {
    await held
    await route.fallback()
  })
  await page.getByTestId('room-image').first().click()
  await expect(original(page)).toHaveAttribute('data-state', 'loading')
  await page.getByTestId('image-viewer-copy').click()
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  // something else copied meanwhile, then the original arrives
  await page.evaluate(() => navigator.clipboard.writeText('acme note'))
  release()
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('acme note')
  expect(await clipboardPng(page)).toBeNull()
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

test('a picture over the 20 MB preview limit copies its thumbnail, and the toast says so', async ({ page }) => {
  await openRoom(page, { messages: [{ id: id(1), author: BEN, body: '큰 사진', extra: { files: [{ ...shotFile, size: 25 * 1024 * 1024 }] } }] })
  await page.getByTestId('room-image').first().click()
  await expect(page.getByTestId('image-viewer-note')).toBeVisible()
  await expect(original(page)).toHaveCount(0)
  await emptyClipboard(page)
  await page.getByTestId('image-viewer-copy').click()
  await expect(toastText(page)).toContainText('이미지를 복사했어요')
  await expect(toastText(page)).toContainText('원본 대신 화면에 보이는 작은 사진을 복사했어요.')
  expect(await clipboardPng(page)).toMatchObject({ width: 640, height: 400 })
})

test('no 복사 where the clipboard takes no picture: ⌘C then does nothing of the viewer\'s', async ({ page }) => {
  // a browser without ClipboardItem (an older Firefox, a plain http page)
  await page.addInitScript(() => {
    delete (window as { ClipboardItem?: unknown }).ClipboardItem
  })
  await openRoom(page)
  await page.getByTestId('room-image').first().click()
  await shown(page)
  await expect(page.getByTestId('image-viewer-download')).toBeVisible()
  await expect(page.getByTestId('image-viewer-copy')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+c')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('toast')).toHaveCount(0)
})

test('an AI chat attachment opens in the viewer, then its file panel picture does too', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('file-input').setInputFiles({ name: 'acme-chart.png', mimeType: 'image/png', buffer: ICON })
  await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'done')
  // the box's own picture opens first, from its bytes (nothing to download yet)
  await page.getByTestId('picture-tile-open').click()
  await expect(viewer(page)).toBeVisible()
  await expect(original(page)).toHaveAttribute('src', /^blob:/)
  await expect(page.getByTestId('image-viewer-download')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  await page.getByTestId('composer-input').fill('what is in the picture?')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  const pic = page.getByTestId('user-message').first().getByTestId('attachment-image')
  await pic.click()
  await shown(page)
  const src = new URL((await original(page).getAttribute('src'))!, 'http://x')
  expect(src.pathname).toBe('/api/files/download')
  expect(src.searchParams.get('disposition')).toBe('inline')
  expect(src.searchParams.get('path')).toMatch(/\/\.attachments\/.+\/acme-chart\.png$/)
  await expect(page.getByTestId('image-viewer-sent')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pic).toBeFocused()
  // the same picture opened as a file (its link): the panel stays the panel, its picture opens the viewer alone
  await page.goto(`/files/view?path=${encodeURIComponent(src.searchParams.get('path')!)}`)
  const panelPic = page.getByTestId('file-panel-image')
  await expect(panelPic).toBeVisible()
  await panelPic.click()
  await shown(page)
  await expect(page.getByTestId('image-viewer-count')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('file-panel')).toBeVisible()
})

test('the room box\'s picture opens in the viewer from its own bytes, like the AI chat box\'s', async ({ page }) => {
  await openRoom(page)
  // the upload is held: the picture is still only on this computer
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), () => {})
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('room-attach').click()])
  await chooser.setFiles({ name: 'acme-draft.png', mimeType: 'image/png', buffer: ICON })
  await page.getByTestId('room-file-chip').getByTestId('picture-tile-open').click()
  await shown(page)
  await expect(original(page)).toHaveAttribute('src', /^blob:/)
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-draft.png')
  await expect(page.getByTestId('image-viewer-download')).toHaveCount(0)
  await expect(page.getByTestId('image-viewer-open')).toHaveCount(0)
  // the box's pictures are their own pane: not the room's
  await expect(page.getByTestId('image-viewer-count')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('room-file-chip').getByTestId('picture-tile-open')).toBeFocused()
})

test('a thread\'s pictures are its root\'s and its replies\', not the timeline\'s', async ({ page }) => {
  const root = { id: id(1), author: BEN, body: '이 페이지 좀 봐 주세요', extra: { files: [shotFile], thread: { replyCount: 1, repliers: [BEN], lastReplyAt: '2026-11-09T05:00:00.000Z', newReplies: false } } }
  await openRoom(page, {
    messages: [
      root,
      { id: id(2), author: BEN, body: '아이콘 두 개', extra: { files: [iconFile(803, 'acme-a.png'), iconFile(804, 'acme-b.png')] } },
      { id: id(3), author: BEN, body: '답글 아이콘', threadRootId: id(1), extra: { files: [iconFile(805, 'acme-reply.png')] } },
    ],
    at: `/rooms/${ROOM_ID}/t/${id(1)}`,
  })
  const thread = page.getByTestId('thread-scroller')
  await expect(thread.getByTestId('room-image')).toHaveCount(2)
  await thread.getByTestId('room-image').nth(1).click()
  await shown(page)
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-reply.png')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('2 / 2')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-page.png')
  await page.keyboard.press('Escape')
  // the timeline's own: the root and the two icons
  await page.getByTestId('room-scroller').getByTestId('room-image').nth(1).click()
  await expect(page.getByTestId('image-viewer-count')).toHaveText('2 / 3')
})

test('an AI answer\'s picture is one of the room\'s; the same picture twice loads each time', async ({ page }) => {
  const CHART = 'shared/acme/chart.png'
  const md = `![차트](/api/files/download?path=${encodeURIComponent(CHART)})`
  // the team picture, as the team server sends it to a member who may read it
  await page.route((u) => u.pathname === '/api/files/download' && u.searchParams.get('path') === CHART, (route) =>
    route.fulfill({ status: 200, body: ICON, headers: { 'content-type': 'image/png', 'content-disposition': 'inline; filename="chart.png"' } }))
  await openRoom(page, {
    messages: [
      { id: id(1), author: BEN, body: '이 페이지 좀 봐 주세요', extra: { files: [shotFile] } },
      // @트리나's answer to Ben (an AI message has no author)
      { id: id(2), author: BEN, body: `차트예요.\n\n${md}\n\n같은 차트를 한 번 더:\n\n${md}`, extra: { authorKind: 'ai', author: null, askedBy: BEN, openable: [CHART] } },
    ],
  })
  const pics = page.getByTestId('md-image')
  await expect(pics).toHaveCount(2)
  await pics.first().click()
  await shown(page)
  await expect(page.getByTestId('image-viewer-name')).toHaveText('차트')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('2 / 3')
  await expect(page.getByTestId('image-viewer-sent')).toContainText('트리나')
  const src = new URL((await original(page).getAttribute('src'))!, 'http://x')
  expect(src.searchParams.get('path')).toBe(CHART)
  // the next one is the same picture at the same address: drawn again, not left loading
  await page.keyboard.press('ArrowRight')
  await expect(page.getByTestId('image-viewer-count')).toHaveText('3 / 3')
  await shown(page)
  expect((await original(page).boundingBox())!.width).toBeCloseTo(192, 0)
  await page.keyboard.press('ArrowLeft')
  await shown(page)
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  /** a one-finger swipe, as touch events through the browser (they reach the page as pointer events) */
  async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] })
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  }

  test('a tap opens it full-screen; a swipe sideways steps, a swipe down closes', async ({ page }) => {
    await openRoom(page)
    await page.getByTestId('room-image').first().tap()
    await shown(page)
    const stage = (await page.getByTestId('image-viewer-stage').boundingBox())!
    expect(stage).toMatchObject({ x: 0, y: 0, width: 390 })
    const pic = (await original(page).boundingBox())!
    expect(pic.width).toBeCloseTo(390, 0)
    await expect(page.getByTestId('image-viewer-bar')).toBeVisible()
    await audit(page, 'viewer on a phone')
    await swipe(page, { x: 330, y: 420 }, { x: 60, y: 430 })
    await expect(page.getByTestId('image-viewer-name')).toHaveText('acme-icon.png')
    await swipe(page, { x: 195, y: 300 }, { x: 200, y: 700 })
    await expect(viewer(page)).toHaveCount(0)
    await expect(page.getByTestId('room-message')).toHaveCount(2)
  })
})

test('screenshots of the image viewer (SHOTS_DIR)', async ({ page }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'only with SHOTS_DIR')
  fs.mkdirSync(dir!, { recursive: true })
  await openRoom(page)
  await page.getByTestId('room-image').first().click()
  await shown(page)
  await page.mouse.move(1439, 300)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${dir}/image-viewer-1440-light-fitted.png` })
  await page.keyboard.press('Escape')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByTestId('room-image').first().click()
  await shown(page)
  const box = (await original(page).boundingBox())!
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2)
  await page.mouse.move(1439, 300)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${dir}/image-viewer-1440-dark-zoomed.png` })
})

test('screenshot of 복사 in the bar (SHOTS_DIR)', async ({ page }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'only with SHOTS_DIR')
  fs.mkdirSync(dir!, { recursive: true })
  await openRoom(page)
  await page.getByTestId('room-image').first().click()
  await shown(page)
  await page.getByTestId('image-viewer-copy').hover()
  await expect(page.getByRole('tooltip')).toHaveText('복사')
  await page.screenshot({ path: `${dir}/image-viewer-copy-1440-light.png` })
})

test.describe('screenshots on a phone (SHOTS_DIR)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('390 light', async ({ page }) => {
    const dir = process.env.SHOTS_DIR
    test.skip(!dir, 'only with SHOTS_DIR')
    await openRoom(page)
    await page.getByTestId('room-image').first().tap()
    await shown(page)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/image-viewer-390-light.png` })
  })
  test('390 light, the toast after 복사', async ({ page }) => {
    const dir = process.env.SHOTS_DIR
    test.skip(!dir, 'only with SHOTS_DIR')
    await openRoom(page)
    await page.getByTestId('room-image').first().tap()
    await shown(page)
    await page.getByTestId('image-viewer-copy').tap()
    await expect(page.getByTestId('toast').last()).toHaveText('이미지를 복사했어요')
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${dir}/image-viewer-copy-toast-390-light.png` })
  })
})
