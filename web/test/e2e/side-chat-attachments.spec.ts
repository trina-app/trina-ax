// Files in the Trina side chat (components/rooms/SideChatPanel.tsx, with the AI chat box's own parts:
// components/chat/ComposerFiles.tsx): a picture pasted into its box shows as its 64 px square at once, while it uploads
// into the side chat (the first file makes the room's side chat), goes with the question and shows in the message; a
// PDF picked with 📎 goes as a file card. Pasted as the browser does it (the page's clipboard and ⌘V / Ctrl+V; Chromium
// only, WebKit grants these tests no clipboard). The room is answered through page.route (rooms-mock.ts); the chats,
// uploads and answers by the mock team server. The box's send is the room box's round ↑ (rooms/RoomComposer.tsx).
// SHOTS_DIR=<folder>: a pasted picture at 1440 light, the sent message with its picture at 1440 dark, the box with a
// pasted picture at 390 light.
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

/** Put a picture on the clipboard and paste it with the keyboard. */
async function paste(page: Page) {
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
  }, PNG.toString('base64'))
  await page.keyboard.press('ControlOrMeta+V')
}

/** The room page with my Trina side chat open (none yet: its empty line). */
async function openSide(page: Page): Promise<Locator> {
  await reset(page)
  await signIn(page)
  await routeRoom(page, { members: [BEN], messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '로고 시안 보내 주세요' }] })
  await page.goto(`/rooms/${ROOM_ID}`)
  await page.getByTestId('room-side-chat-button').click()
  const side = page.getByTestId('room-side-chat')
  await expect(side.getByTestId('side-chat-empty')).toBeVisible()
  return side
}

/** The chip shows the pasted picture itself, drawn, as a 64 px square. */
async function showsPicture(chip: Locator) {
  const pic = chip.getByTestId('chip-thumb')
  await expect(pic).toBeVisible()
  await expect.poll(() => pic.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0))).toBe(192)
  expect(await pic.boundingBox()).toMatchObject({ width: 64, height: 64 })
}

/** the POST of a question to a side chat */
const question = (page: Page) => page.waitForRequest((r) => r.method() === 'POST' && /^\/api\/chats\/[^/]+\/messages$/.test(new URL(r.url()).pathname))

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'pastes through the page clipboard (Chromium)'))

test('the box: send is the room box\'s round ↑, named 보내기 with its tooltip; no "나만 볼 수 있어요" under it', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const side = await openSide(page)
  // the empty line says who sees the side chat; the line under the box is gone
  await expect(side.getByTestId('side-chat-empty')).toContainText('이 대화는 나만 봐요')
  await expect(side.getByText('나만 볼 수 있어요')).toHaveCount(0)
  const send = side.getByRole('button', { name: '보내기', exact: true })
  await expect(send).toHaveAttribute('data-testid', 'side-chat-send')
  await expect(send).toHaveText('')
  await expect(send).toBeDisabled()
  await side.getByTestId('side-chat-input').fill('요약해 줘')
  await expect(send).toBeEnabled()
  // the same button as the room's box: size, round, colours, empty and filled (polled: the colour fades in)
  const look = (l: Locator) => l.evaluate((e) => { const c = getComputedStyle(e); return JSON.stringify([c.width, c.height, c.borderRadius, c.backgroundColor, c.color, e.querySelector('svg')?.getAttribute('width')]) })
  const roomSend = page.getByTestId('room-send')
  const same = async () => (await look(send)) === (await look(roomSend))
  await page.getByTestId('room-input').first().fill('안녕하세요')
  await expect.poll(same).toBe(true)
  await side.getByTestId('side-chat-input').fill('')
  await page.getByTestId('room-input').first().fill('')
  await expect.poll(same).toBe(true)
  await side.getByTestId('side-chat-input').fill('요약해 줘')
  await send.hover()
  await expect(page.getByRole('tooltip')).toHaveText('보내기')
})

test('a picture pasted into the side chat: its square at once while it uploads into a new side chat, then sent with the question and shown in the message', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const side = await openSide(page)
  // the upload waits until the test lets it go
  const held: Route[] = []
  await page.route(/\/api\/uploads$/, (route) => void held.push(route))
  const made = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/chats')
  await side.getByTestId('side-chat-input').click()
  await paste(page)
  const chips = side.getByTestId('attachment-chip')
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute('data-status', 'uploading')
  await showsPicture(chips.first())
  await expect(chips.first().locator('.animate-spin')).toBeVisible()
  // the picture, not its name as text in the box
  await expect(side.getByTestId('side-chat-input')).toHaveValue('')
  // the first file made the room's side chat, and goes into it
  expect((await made).postDataJSON()).toMatchObject({ sideRoomId: ROOM_ID })
  await expect.poll(() => held.length).toBe(1)
  await side.getByTestId('side-chat-input').fill('이 로고 어때?')
  // nothing goes while it uploads
  await expect(side.getByTestId('side-chat-send')).toBeDisabled()
  await held[0]!.continue()
  await expect(chips.first()).toHaveAttribute('data-status', 'done')
  await expect(chips.first().locator('.animate-spin')).toHaveCount(0)
  await expect(side.getByTestId('side-chat-open-full')).toBeVisible()
  await shot(page, 'side-chat-pasted-1440-light.png')

  const [q] = await Promise.all([question(page), side.getByTestId('side-chat-send').click()])
  const body = q.postDataJSON() as { content: string; attachmentIds: string[] }
  expect(body.content).toBe('이 로고 어때?')
  expect(body.attachmentIds).toHaveLength(1)
  // the box is empty again; the message shows the picture
  await expect(chips).toHaveCount(0)
  const msg = side.getByTestId('user-message')
  await expect(msg).toHaveCount(1)
  const img = msg.getByTestId('attachment-image').locator('img')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0))).toBe(192)
  // the answer done ("Share to room" under it)
  await expect(side.getByTestId('share-to-room')).toBeVisible()
  await page.emulateMedia({ colorScheme: 'dark' })
  // the question with its picture in view (the mock's long answer is below it), after the box's colour transition
  await msg.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(400)
  await shot(page, 'side-chat-sent-1440-dark.png')
})

test('a PDF picked with 📎 goes with the question as a file card; ✕ takes a file out before it goes', async ({ page }) => {
  const side = await openSide(page)
  await expect(side.getByTestId('side-chat-attach')).toHaveAccessibleName('파일 첨부')
  const pick = async (files: { name: string; mimeType: string; buffer: Buffer }[]) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), side.getByTestId('side-chat-attach').click()])
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles(files)
  }
  await pick([
    { name: 'acme-brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% acme brief\n') },
    { name: 'acme-old.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% acme old\n') },
  ])
  const chips = side.getByTestId('attachment-chip')
  await expect(chips).toHaveCount(2)
  await expect(chips.nth(0)).toHaveAttribute('data-status', 'done')
  await expect(chips.nth(1)).toHaveAttribute('data-status', 'done')
  await expect(chips.nth(0)).toContainText('acme-brief.pdf')
  await chips.nth(1).getByRole('button', { name: 'acme-old.pdf 빼기' }).click()
  await expect(chips).toHaveCount(1)
  // a file alone may go
  await expect(side.getByTestId('side-chat-send')).toBeEnabled()
  await side.getByTestId('side-chat-input').fill('요점만 알려 줘')
  const [q] = await Promise.all([question(page), side.getByTestId('side-chat-input').press('Enter')])
  expect((q.postDataJSON() as { attachmentIds: string[] }).attachmentIds).toHaveLength(1)
  await expect(chips).toHaveCount(0)
  const msg = side.getByTestId('user-message')
  await expect(msg.getByRole('button', { name: /acme-brief\.pdf/ })).toBeVisible()
  await expect(msg).not.toContainText('acme-old.pdf')
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the side chat takes the whole screen; a pasted picture shows above its box, inside the screen', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    const side = await openSide(page)
    await side.getByTestId('side-chat-input').click()
    await paste(page)
    const chip = side.getByTestId('attachment-chip')
    await expect(chip).toHaveAttribute('data-status', 'done')
    await showsPicture(chip)
    const box = (await side.getByTestId('side-chat-box').boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await expect(side.getByTestId('side-chat-attach')).toBeVisible()
    await shot(page, 'side-chat-pasted-390-light.png')
  })
})
