// A picture pasted into a message box shows as a 64 px square of itself above the text at once, while it uploads in the
// background, with its ✕ on the corner (components/ChipThumb.tsx, lib/paste.ts): a room's box and the AI chat's box. Pasted as the
// browser does it (the page's clipboard and ⌘V / Ctrl+V; Chromium only, WebKit grants these tests no clipboard): a
// screenshot (a picture alone) and a picture copied from a web page (its HTML with the picture: the picture goes in, the
// HTML is not pasted as text). Each upload is held until the picture was seen, then let go: the chip finishes and keeps
// its picture; a room send the server refuses comes back with the photo's room thumbnail. The room is answered through
// page.route (rooms-mock.ts).
// Three fit one row on a phone (390 px), and a file beside them keeps its compact chip.
// SHOTS_DIR=<folder>: both boxes with a pasted picture, 1440 light; the AI chat's box with three, 390 light.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

// a 192 x 192 picture (the app's own icon)
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const BEN = { id: 'ben', name: '벤' }
const FILE_ID = '019a5f00-0000-7000-8000-00000000f001'

/** Put a picture on the clipboard (with a web page's HTML around it: `html`) and paste it with the keyboard. */
async function paste(page: Page, o: { html?: string } = {}) {
  await page.evaluate(async ({ b64, html }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const parts: Record<string, Blob> = { 'image/png': new Blob([bytes], { type: 'image/png' }) }
    if (html) parts['text/html'] = new Blob([html], { type: 'text/html' })
    await navigator.clipboard.write([new ClipboardItem(parts)])
  }, { b64: PNG.toString('base64'), html: o.html })
  await page.keyboard.press('ControlOrMeta+V')
}

/** The chip shows the pasted picture itself, drawn (not a file icon), as a 64 px square that the picture fills. */
async function showsPicture(chip: Locator) {
  const pic = chip.getByTestId('chip-thumb')
  await expect(pic).toBeVisible()
  await expect.poll(() => pic.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0))).toBe(192)
  expect(await pic.boundingBox()).toMatchObject({ width: 64, height: 64 })
  expect(await pic.evaluate((i) => getComputedStyle(i).objectFit)).toBe('cover')
}

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

const WEB_PAGE = '<meta charset="utf-8"><img src="https://example.org/acme-logo.png" alt="acme">'

test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'pastes through the page clipboard (Chromium)'))

test("a room's box: a pasted picture shows at once while it uploads, can be taken out, and goes with the message", async ({ page }) => {
  await reset(page)
  await signIn(page)
  const room = await routeRoom(page, { members: [BEN], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '로고 시안 보내 주세요' }] })
  // every upload waits until the test lets it go
  const held: Route[] = []
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), (route) => void held.push(route))
  await page.goto(`/rooms/${ROOM_ID}`)
  const input = page.getByTestId('room-input')
  await input.click()
  const chips = page.getByTestId('room-file-chip')

  // a screenshot
  await paste(page)
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute('data-status', 'uploading')
  await showsPicture(chips.first())
  await expect(chips.first().getByRole('status')).toHaveText('image.png 올리는 중…')
  await expect(page.getByTestId('room-send')).toBeDisabled()
  await expect.poll(() => held.length).toBe(1)
  // the spinner over the picture while it uploads; the name is the picture's alt text, not words beside it
  await expect(chips.first().locator('.animate-spin')).toBeVisible()
  await expect(chips.first().getByRole('img', { name: 'image.png' })).toBeVisible()

  // a picture copied from a web page: the picture, not its HTML as text
  await paste(page, { html: WEB_PAGE })
  await expect(chips).toHaveCount(2)
  await showsPicture(chips.nth(1))
  await expect(input).toHaveValue('')
  // its ✕ takes it out while it uploads
  await chips.nth(1).getByRole('button', { name: 'image.png 빼기' }).click()
  await expect(chips).toHaveCount(1)

  // the upload ends: the chip keeps its picture, says the size, and the message goes with the file
  await expect.poll(() => held.length).toBe(2)
  await held[0]!.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: FILE_ID, name: 'image.png', size: PNG.length, mime: 'image/png', kind: 'image', width: 192, height: 192, thumb: true }) })
  await expect(chips.first()).toHaveAttribute('data-status', 'done')
  await showsPicture(chips.first())
  await expect(chips.first().getByRole('status')).toHaveText(/KB$/)
  await expect(chips.first().locator('.animate-spin')).toHaveCount(0)
  await page.mouse.move(0, 0)
  // (the send button's colour has finished turning on)
  await page.getByTestId('room-send').evaluate((b) => Promise.all(b.getAnimations().map((a) => a.finished)))
  await shot(page, 'room-composer-pasted-1440-light.png')

  // the server refuses the send once: the message comes back to the box, its photo shown by its room thumbnail
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+\?thumb=1$/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  let refused = false
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/messages$`), (route) => {
    if (route.request().method() !== 'POST' || refused) return route.fallback()
    refused = true
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'conflict', message: 'not now' } }) })
  })
  await page.getByTestId('room-send').click()
  await expect.poll(() => refused).toBe(true)
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute('data-status', 'done')
  await showsPicture(chips.first())
  expect(await chips.first().getByTestId('chip-thumb').getAttribute('src')).toBe(`/api/rooms/${ROOM_ID}/files/${FILE_ID}?thumb=1`)

  // sent again, with the file
  await page.getByTestId('room-send').click()
  await expect.poll(() => room.sent.length).toBe(1)
  expect((room.sent[0] as unknown as { fileIds: string[] }).fileIds).toEqual([FILE_ID])
  await expect(chips).toHaveCount(0)
  await held[1]!.abort().catch(() => {})
})

test("the AI chat's box: a pasted picture shows at once while it uploads, can be taken out, and ends attached", async ({ page }) => {
  await reset(page)
  await signIn(page)
  const held: Route[] = []
  await page.route('**/api/uploads', (route) => void held.push(route))
  const input = page.getByTestId('composer-input')
  await input.click()
  const chips = page.getByTestId('attachment-chip')

  await paste(page)
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute('data-status', 'uploading')
  await showsPicture(chips.first())
  await expect.poll(() => held.length).toBe(1)
  await shot(page, 'chat-composer-pasted-1440-light.png')

  await paste(page, { html: WEB_PAGE })
  await expect(chips).toHaveCount(2)
  await showsPicture(chips.nth(1))
  await expect(input).toHaveValue('')
  await chips.nth(1).getByRole('button', { name: 'image.png 빼기' }).click()
  await expect(chips).toHaveCount(1)

  // let it go to the team server: attached, still a picture
  await held[0]!.continue()
  await expect(chips.first()).toHaveAttribute('data-status', 'done')
  await showsPicture(chips.first())
  for (const r of held.slice(1)) await r.abort().catch(() => {})
})

test("the AI chat's box on a phone: three pasted pictures fit one row, each ✕ easy to tap, a file keeps its compact chip", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  const input = page.getByTestId('composer-input')
  await input.click()
  const chips = page.getByTestId('attachment-chip')
  for (let i = 1; i <= 3; i++) {
    await paste(page)
    await expect(chips).toHaveCount(i)
  }
  for (let i = 0; i < 3; i++) {
    await expect(chips.nth(i)).toHaveAttribute('data-status', 'done')
    await showsPicture(chips.nth(i))
  }
  // one row, inside the box
  const boxes = await Promise.all([0, 1, 2].map(async (i) => (await chips.nth(i).getByTestId('chip-thumb').boundingBox())!))
  expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1)
  const composer = (await page.getByTestId('composer').boundingBox())!
  expect(boxes[2]!.x + boxes[2]!.width).toBeLessThan(composer.x + composer.width)
  // each ✕ takes a tap around its dot, 44 px tall on a phone (36 px on a computer): 20 px above and below its centre,
  // 16 px to its left, inside the box
  for (let i = 0; i < 3; i++) {
    const x = chips.nth(i).getByRole('button', { name: 'image.png 빼기' })
    const b = (await x.boundingBox())!
    expect(b.width).toBeGreaterThanOrEqual(20)
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    expect(cy - 20).toBeGreaterThan(composer.y)
    for (const [dx, dy] of [[0, -20], [0, 20], [-16, 0]] as const) {
      expect(await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest('button')?.getAttribute('aria-label') ?? null, [cx + dx, cy + dy])).toBe('image.png 빼기')
    }
  }
  await shot(page, 'chat-composer-3-pictures-390-light.png')

  // the ✕ of one picture takes out that one only (each is drawn from its own file)
  const srcs = () => chips.getByTestId('chip-thumb').evaluateAll((all) => all.map((i) => i.getAttribute('src')))
  const [first, second, third] = await srcs()
  await chips.nth(1).getByRole('button', { name: 'image.png 빼기' }).click()
  await expect.poll(srcs).toEqual([first, third])
  expect(second).not.toBe(first)
  await chips.nth(1).getByRole('button', { name: 'image.png 빼기' }).click()
  await expect.poll(srcs).toEqual([first])

  // a file that is not a picture keeps its compact chip, its own height, on the picture's row
  await page.getByTestId('file-input').setInputFiles({ name: 'acme-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') })
  await expect(chips).toHaveCount(2)
  const file = chips.nth(1)
  await expect(file).toHaveAttribute('data-status', 'done')
  await expect(file.getByTestId('chip-thumb')).toHaveCount(0)
  const pic = (await chips.first().getByTestId('chip-thumb').boundingBox())!
  const chip = (await file.boundingBox())!
  expect(chip.height).toBeLessThan(40)
  expect(chip.y).toBeGreaterThan(pic.y)
  expect(chip.y + chip.height).toBeLessThan(pic.y + pic.height)
})
