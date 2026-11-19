// A room's own message box holds 10,000 characters (ROOM_MESSAGE_MAX, what the server takes). Text pasted over that is never
// cut without a word: like the AI chat's boxes (lib/longPaste.ts) it goes in as "Pasted text.txt" and a line says so;
// a paste that fits stays text (TC-5089). Pasted as the browser does it (page clipboard and Ctrl+V; Chromium only).
// SHOTS_DIR=<folder> (and SHOTS_TAG): the box after a 60,000-character paste, 1440 and 390, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ROOM_MESSAGE_MAX } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ locale: 'en-US', serviceWorkers: 'block' })
test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'pastes through the page clipboard (Chromium)'))

const BEN = { id: 'ben', name: 'Ben' }
const FILE_ID = '019a5f00-0000-7000-8000-00000000f002'

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${process.env.SHOTS_TAG ?? 'after'}-${name}.png`) })
}

async function pasteText(page: Page, text: string) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text)
  await page.keyboard.press('ControlOrMeta+V')
}

async function openRoom(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await routeRoom(page, { members: [BEN], messages: [{ id: '019a5f00-0000-7000-8000-000000000501', author: BEN, body: 'Can you send the whole log?' }] })
  // an upload waits until the test lets it go (the file the box makes is read back from here)
  const uploads: { name: string; body: Buffer }[] = []
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), async (route) => {
    // multipart: the "file" part is the text after its blank line, up to the closing boundary
    const form = (route.request().postDataBuffer() ?? Buffer.alloc(0)).toString('utf8')
    const at = form.indexOf('name="file"')
    const start = form.indexOf('\r\n\r\n', at) + 4
    const raw = Buffer.from(form.slice(start, form.lastIndexOf('\r\n------')), 'utf8')
    uploads.push({ name: /filename="([^"]*)"/.exec(form)?.[1] ?? '', body: raw })
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: FILE_ID, name: 'Pasted text.txt', size: raw.length, mime: 'text/plain', kind: 'text', thumb: false }) })
  })
  await page.goto(`/rooms/${ROOM_ID}`)
  const input = page.getByTestId('room-input')
  await input.click()
  return { input, uploads }
}

test('60,000 characters pasted into a room box become Pasted text.txt, none cut, and the box says so', async ({ page }) => {
  const { input, uploads } = await openRoom(page)
  const text = ('Line of a long log, 0123456789.\n').repeat(2000).slice(0, 60_000)
  expect(text.length).toBe(60_000)
  await pasteText(page, text)
  const chips = page.getByTestId('room-file-chip')
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toContainText('Pasted text.txt')
  // not in the box: neither cut to 10,000 nor whole
  await expect(input).toHaveValue('')
  await expect(page.getByText('The pasted text is longer than 10,000 characters, so it was added as a text file.')).toBeVisible()
  await expect(chips.first()).toHaveAttribute('data-status', 'done')
  expect(uploads).toHaveLength(1)
  expect(uploads[0]!.name).toBe('Pasted text.txt')
  // every character went up
  expect(uploads[0]!.body.length).toBe(60_000)
  expect(uploads[0]!.body.toString('utf8')).toBe(text)
  await expect(page.getByTestId('room-send')).toBeEnabled()
  await shot(page, 'room-paste-60000')
})

test('a paste that fits stays text; one more character, or a box with text already, goes to the file', async ({ page }) => {
  const { input, uploads } = await openRoom(page)
  expect(ROOM_MESSAGE_MAX).toBe(10_000)
  await pasteText(page, 'a'.repeat(ROOM_MESSAGE_MAX))
  await expect(input).toHaveValue('a'.repeat(ROOM_MESSAGE_MAX))
  await expect(page.getByTestId('room-file-chip')).toHaveCount(0)
  // the box is full: any more text pasted is a file, the text in the box stays as it is
  await pasteText(page, 'b')
  await expect(page.getByTestId('room-file-chip')).toHaveCount(1)
  await expect(input).toHaveValue('a'.repeat(ROOM_MESSAGE_MAX))
  await expect.poll(() => uploads.length).toBe(1)
  expect(uploads[0]!.body.toString('utf8')).toBe('b')
})

test('a short paste is a plain paste', async ({ page }) => {
  const { input } = await openRoom(page)
  await pasteText(page, 'see you at 3')
  await expect(input).toHaveValue('see you at 3')
  await expect(page.getByTestId('room-file-chip')).toHaveCount(0)
})
