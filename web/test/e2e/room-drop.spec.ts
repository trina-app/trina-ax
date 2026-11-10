// A file dropped anywhere on a room goes into its box (components/FileDropZone.tsx, components/chat/ComposerFiles.tsx
// useFileDrop): the room's column (its header, the messages, the box), the thread beside it into the thread's box, the
// ✦ side chat into the side chat's. While files are over a column one light overlay says "여기에 놓으면 첨부돼요";
// moving over the column's own parts keeps it, Esc and leaving put it away. Text or a picture dragged from the page is
// left alone, and a file dropped where nothing takes it (the sidebar) is not opened in place of the app
// (lib/fileDrop.ts). Dragged as
// the browser fires it: drag events with a DataTransfer that holds the file (dispatchEvent). The room is answered
// through page.route (rooms-mock.ts), its uploads and the send here; the side chat's uploads by the mock team server.
// SHOTS_DIR=<folder>: the overlay over the room at 1440, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type JSHandle, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

// a 192 x 192 picture (the app's own icon), as a screenshot
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const BEN = { id: 'ben', name: '벤' }
const ROOT = '019a5f00-0000-7000-8000-000000000001'
const FILE_ID = '019a5f00-0000-7000-8000-00000000f101'
const PICTURE = { id: FILE_ID, name: 'screenshot.png', size: PNG.length, mime: 'image/png', kind: 'image', width: 192, height: 192, thumb: true }
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** What a drag carries: a screenshot dragged from the desktop (one PNG file), or (`text`) a selected text. */
function transfer(page: Page, o: { text?: string } = {}): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(({ b64, text }) => {
    const dt = new DataTransfer()
    if (text !== undefined) dt.setData('text/plain', text)
    else dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'screenshot.png', { type: 'image/png' }))
    return dt
  }, { b64: PNG.toString('base64'), text: o.text })
}
/** the drag comes over an element (enters it, then moves on it) */
async function dragOver(target: Locator, dt: JSHandle<DataTransfer>) {
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
}
async function dropOn(target: Locator, dt: JSHandle<DataTransfer>) {
  await dragOver(target, dt)
  await target.dispatchEvent('drop', { dataTransfer: dt })
}

/** The room with Ben's message: an upload is answered with the picture, the picture served, my send answered with
 * its files (as the server does). `at`: the room, or a thread of it. */
async function openRoom(page: Page, at = `/rooms/${ROOM_ID}`) {
  await reset(page)
  await signIn(page)
  await routeRoom(page, { members: [BEN], messages: [{ id: ROOT, author: BEN, body: '오류 화면 캡처해서 보내 주세요' }] })
  const uploads: number[] = []
  const sent: { body: string; fileIds: string[]; threadRootId?: string }[] = []
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/files$`), (route) => {
    uploads.push(route.request().postDataBuffer()?.length ?? 0)
    return route.fulfill(json(PICTURE, 201))
  })
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/messages$`), (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const b = route.request().postDataJSON() as (typeof sent)[number]
    sent.push(b)
    return route.fulfill(json({
      id: '019a5f00-0000-7000-8000-0000000000aa', roomId: ROOM_ID, seq: 50, authorKind: 'user', author: { id: 'olga', name: 'Olga' }, askedBy: null, visibility: 'room',
      body: b.body, replyTo: null, mentions: [], files: b.fileIds.map(() => PICTURE), createdAt: new Date().toISOString(), editedAt: null, deletedAt: null,
    }, 201))
  })
  await page.goto(at)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  return { uploads, sent }
}

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`files over the room: one light overlay over its column, "여기에 놓으면 첨부돼요"; its own parts keep it, leaving and Esc put it away (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await openRoom(page)
    // the pointer out of the way (no hover marks in the picture); a pointer event during the drag would end it
    await page.mouse.move(0, 899)
    const overlay = page.getByTestId('drop-overlay')
    const dt = await transfer(page)
    await dragOver(page.getByTestId('room-scroller'), dt)
    await expect(overlay).toHaveCount(1)
    await expect(overlay).toHaveText('여기에 놓으면 첨부돼요')
    await expect(overlay).toHaveCSS('border-top-style', 'dashed')
    await expect(overlay).toHaveCSS('pointer-events', 'none')
    // over the whole column (header, messages, box), not the sidebar
    const col = (await page.getByTestId('room').boundingBox())!
    const box = (await overlay.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(col.x)
    expect(box.width).toBeGreaterThan(col.width - 24)
    expect(box.height).toBeGreaterThan(col.height - 24)
    await shot(page, `room-drop-overlay-1440-${scheme}.png`)

    // into the box and the header: the next element is entered, then the last one left (relatedTarget)
    const input = page.getByTestId('room-input')
    await input.dispatchEvent('dragenter', { dataTransfer: dt })
    await page.getByTestId('room-scroller').dispatchEvent('dragleave', { dataTransfer: dt, relatedTarget: await input.elementHandle() })
    await expect(overlay).toHaveCount(1)
    await page.getByTestId('room-title').dispatchEvent('dragenter', { dataTransfer: dt })
    await input.dispatchEvent('dragleave', { dataTransfer: dt, relatedTarget: await page.getByTestId('room-title').elementHandle() })
    await expect(overlay).toHaveCount(1)
    // out of the window (no relatedTarget, the last leave)
    await page.getByTestId('room-title').dispatchEvent('dragleave', { dataTransfer: dt })
    await expect(overlay).toHaveCount(0)
    // Esc
    await dragOver(page.getByTestId('room-scroller'), dt)
    await expect(overlay).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)
    // a pointer event: the drag is over (it left the window and ended there)
    await dragOver(page.getByTestId('room-scroller'), dt)
    await expect(overlay).toHaveCount(1)
    await page.mouse.move(10, 899)
    await expect(overlay).toHaveCount(0)
  })
}

test('a screenshot dropped on the messages goes into the room\'s box, and is sent as a picture in the room', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const { uploads, sent } = await openRoom(page)
  const chips = page.getByTestId('room-composer').getByTestId('room-file-chip')
  await dropOn(page.getByTestId('room-message').first(), await transfer(page))
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toHaveAttribute('data-status', 'done')
  await expect(chips.first().getByTestId('chip-thumb')).toBeVisible()
  expect(uploads).toHaveLength(1)
  expect(uploads[0]).toBeGreaterThan(PNG.length)
  await page.getByTestId('room-input').fill('캡처 보내요')
  await page.getByTestId('room-send').click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ body: '캡처 보내요', fileIds: [FILE_ID] })
  await expect(chips).toHaveCount(0)
  // the picture in the room
  const img = page.getByTestId('room-scroller').getByTestId('room-image').locator('img')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => (i.complete ? i.naturalWidth : 0))).toBe(192)
})

test('dropped on the thread beside the room: the thread\'s box takes it, the room\'s box nothing; the overlay is on the thread only', async ({ page }) => {
  await openRoom(page, `/rooms/${ROOM_ID}/t/${ROOT}`)
  const thread = page.getByTestId('room-thread')
  await expect(thread.getByTestId('thread-count')).toBeVisible()
  const dt = await transfer(page)
  await dragOver(thread.getByTestId('thread-scroller'), dt)
  await expect(page.getByTestId('drop-overlay')).toHaveCount(1)
  await expect(thread.getByTestId('drop-overlay')).toHaveCount(1)
  await thread.getByTestId('thread-scroller').dispatchEvent('drop', { dataTransfer: dt })
  await expect(thread.getByTestId('room-file-chip')).toHaveCount(1)
  await expect(thread.getByTestId('room-file-chip')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('room').getByTestId('room-file-chip')).toHaveCount(0)
  // and the room's own messages go to the room's box
  await dropOn(page.getByTestId('room-scroller'), await transfer(page))
  await expect(page.getByTestId('room').getByTestId('room-file-chip')).toHaveCount(1)
  await expect(thread.getByTestId('room-file-chip')).toHaveCount(1)
})

test('dropped on the ✦ side chat: it goes with my next question there, not into the room', async ({ page }) => {
  const { uploads } = await openRoom(page)
  await page.getByTestId('room-side-chat-button').click()
  const side = page.getByTestId('room-side-chat')
  await expect(side.getByTestId('side-chat-empty')).toBeVisible()
  await dropOn(side.getByTestId('side-chat-scroller'), await transfer(page))
  await expect(side.getByTestId('attachment-chip')).toHaveCount(1)
  await expect(side.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('room').getByTestId('room-file-chip')).toHaveCount(0)
  expect(uploads).toEqual([])
})

test('text dragged over the room is left alone; a file dropped where nothing takes it is not opened in place of the app', async ({ page }) => {
  await openRoom(page)
  const text = await transfer(page, { text: '회의는 3시' })
  await dragOver(page.getByTestId('room-scroller'), text)
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await page.getByTestId('room-scroller').dispatchEvent('drop', { dataTransfer: text })
  await expect(page.getByTestId('room-file-chip')).toHaveCount(0)
  // a picture dragged from the page itself (Chromium carries it as a file): no overlay, nothing attached; once its drag
  // ended, a file from the computer is taken again
  const message = page.getByTestId('room-message').first()
  await message.dispatchEvent('dragstart')
  const picture = await transfer(page)
  await dropOn(page.getByTestId('room-scroller'), picture)
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await expect(page.getByTestId('room-file-chip')).toHaveCount(0)
  await message.dispatchEvent('dragend')
  await dragOver(page.getByTestId('room-scroller'), await transfer(page))
  await expect(page.getByTestId('drop-overlay')).toHaveCount(1)
  await page.keyboard.press('Escape')
  // the sidebar takes no file: the page-wide guard says "none" and takes the drop, so the browser does not open it;
  // text keeps the browser's way
  const outside = await page.evaluate((b64) => {
    const el = document.querySelector('[data-testid="sidebar-scroll"]')!
    const fire = (type: string, dt: DataTransfer) => {
      const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
      el.dispatchEvent(e)
      return { prevented: e.defaultPrevented, effect: dt.dropEffect }
    }
    const file = new DataTransfer()
    file.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'screenshot.png', { type: 'image/png' }))
    const words = new DataTransfer()
    words.setData('text/plain', '회의는 3시')
    return { over: fire('dragover', file), drop: fire('drop', file), text: fire('dragover', words).prevented }
  }, PNG.toString('base64'))
  expect(outside).toEqual({ over: { prevented: true, effect: 'none' }, drop: { prevented: true, effect: 'none' }, text: false })
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}$`))
})
