// TC-071: a file dropped anywhere on an AI chat (the message list, away from the box) goes into its box, as the ✦ side
// chat and a room do (components/FileDropZone.tsx, pages/Chat.tsx). While a file is over the chat one light overlay
// covers the chat's column; a drop puts the file on the box as a chip, and Send takes it into the chat. A drop on the box
// itself still works; text dragged from the page is left alone; leaving and Esc put the overlay away. Dragged as the
// browser fires it: drag events with a DataTransfer that holds the file (dispatchEvent), and once as the browser's own
// drag (CDP Input.dispatchDragEvent), at 1440 on the mock team server.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type JSHandle, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ viewport: { width: 1440, height: 900 } })

// a 192 x 192 picture (the app's own icon), as a screenshot
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))

/** What a drag carries: a screenshot dragged from the desktop (one PNG file), or (`text`) a selected text. */
function transfer(page: Page, o: { text?: string } = {}): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(({ b64, text }) => {
    const dt = new DataTransfer()
    if (text !== undefined) dt.setData('text/plain', text)
    else dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'screenshot.png', { type: 'image/png' }))
    return dt
  }, { b64: PNG.toString('base64'), text: o.text })
}
async function dragOver(target: Locator, dt: JSHandle<DataTransfer>) {
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
}
async function dropOn(target: Locator, dt: JSHandle<DataTransfer>) {
  await dragOver(target, dt)
  await target.dispatchEvent('drop', { dataTransfer: dt })
}

/** a chat with one answered question: the message list has something to drop on, away from the box */
async function openChat(page: Page) {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('first question')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  // the pointer out of the way: a pointer event while a drag lasts ends it
  await page.mouse.move(1439, 899)
}

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

test('a file over the message list: one overlay over the whole chat; leaving and Esc put it away', async ({ page }) => {
  await openChat(page)
  const overlay = page.getByTestId('drop-overlay')
  const messages = page.getByTestId('messages')
  const dt = await transfer(page)
  await dragOver(page.getByTestId('user-message').first(), dt)
  await expect(overlay).toHaveCount(1)
  await expect(overlay).toHaveText('여기에 놓으면 첨부돼요')
  await expect(overlay).toHaveCSS('pointer-events', 'none')
  // over the chat's column (header, messages, box), not only the box
  const col = (await page.getByTestId('chat-drop').boundingBox())!
  const box = (await overlay.boundingBox())!
  const list = (await messages.boundingBox())!
  expect(box.width).toBeGreaterThan(col.width - 24)
  expect(box.height).toBeGreaterThan(col.height - 24)
  expect(box.y).toBeLessThanOrEqual(list.y + 8)
  await shot(page, 'chat-drop-overlay-1440.png')
  // into the box: still one overlay (the next element entered, then the last left)
  const input = page.getByTestId('composer-input')
  await input.dispatchEvent('dragenter', { dataTransfer: dt })
  await messages.dispatchEvent('dragleave', { dataTransfer: dt, relatedTarget: await input.elementHandle() })
  await expect(overlay).toHaveCount(1)
  // out of the window (no relatedTarget): gone, nothing stuck
  await input.dispatchEvent('dragleave', { dataTransfer: dt })
  await expect(overlay).toHaveCount(0)
  // Esc
  await dragOver(messages, dt)
  await expect(overlay).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  expect(await page.getByTestId('attachment-chip').count()).toBe(0)
})

test('a screenshot dropped on the message list goes on the box as a chip, and Send takes it into the chat', async ({ page }) => {
  await openChat(page)
  const chip = page.getByTestId('attachment-chip')
  await dropOn(page.getByTestId('assistant-message').last(), await transfer(page))
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('screenshot.png')
  await expect(chip).toHaveAttribute('data-status', 'done')
  await page.getByTestId('composer-input').fill('what is in the picture?')
  await page.getByTestId('send').click()
  await expect(chip).toHaveCount(0)
  const sent = page.getByTestId('user-message').last()
  await expect(sent.locator('img[alt="screenshot.png"]')).toBeVisible()
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
})

test('a file dropped on the box itself still goes on the box, once', async ({ page }) => {
  await openChat(page)
  await dropOn(page.getByTestId('composer-input'), await transfer(page))
  await expect(page.getByTestId('attachment-chip')).toHaveCount(1)
  await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
})

test('text, and a picture dragged from the page itself, over the message list are left alone', async ({ page }) => {
  await openChat(page)
  const messages = page.getByTestId('messages')
  const text = await transfer(page, { text: '회의는 3시' })
  await dragOver(messages, text)
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await messages.dispatchEvent('drop', { dataTransfer: text })
  await expect(page.getByTestId('attachment-chip')).toHaveCount(0)
  // a drag that started on the page (Chromium carries a dragged picture as a file)
  const message = page.getByTestId('user-message').first()
  await message.dispatchEvent('dragstart')
  await dropOn(messages, await transfer(page))
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await expect(page.getByTestId('attachment-chip')).toHaveCount(0)
  await message.dispatchEvent('dragend')
})

test('a real drag from the computer (the browser\'s own drag, not made-up events): overlay over the list, a chip on drop', async ({ page }) => {
  await openChat(page)
  const at = (await page.getByTestId('assistant-message').last().boundingBox())!
  const x = at.x + 40
  const y = at.y + Math.min(at.height / 2, 40)
  await page.mouse.move(x, y)
  const cdp = await page.context().newCDPSession(page)
  const data = { items: [], files: [path.resolve(import.meta.dirname, '../../public/icons/icon-192.png')], dragOperationsMask: 1 }
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y: y + 5, data })
  await expect(page.getByTestId('drop-overlay')).toHaveCount(1)
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y: y + 5, data })
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await expect(page.getByTestId('attachment-chip')).toHaveCount(1)
  await expect(page.getByTestId('attachment-chip')).toContainText('icon-192.png')
})
