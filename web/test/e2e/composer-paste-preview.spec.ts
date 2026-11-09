// A picture pasted into a message box shows as a small picture above the text at once, while it uploads in the
// background, with its ✕ (components/LocalThumb.tsx, lib/paste.ts): a room's box and the AI chat's box. Pasted as the
// browser does it (the page's clipboard and ⌘V / Ctrl+V; Chromium only, WebKit grants these tests no clipboard): a
// screenshot (a picture alone) and a picture copied from a web page (its HTML with the picture: the picture goes in, the
// HTML is not pasted as text). Each upload is held until the picture was seen, then let go: the chip finishes and keeps
// its picture. The room is answered through page.route (rooms-mock.ts).
// SHOTS_DIR=<folder>: both boxes with a pasted picture, 1440 light.
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

/** The chip shows the pasted picture itself, drawn (not a file icon). */
async function showsPicture(chip: Locator) {
  const pic = chip.getByTestId('local-thumb')
  await expect(pic).toBeVisible()
  await expect.poll(() => pic.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0))).toBe(192)
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
  await shot(page, 'room-composer-pasted-1440-light.png')

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
