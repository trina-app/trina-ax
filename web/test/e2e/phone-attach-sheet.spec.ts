// A phone's attach sheet (components/chat/AttachSheet.tsx, QA TC-251): the AI chat's +, a room's and a thread's 📎 and
// the side chat's 📎 open one and the same sheet (rooms/MenuButton.tsx's bottom sheet over a scrim): 사진 보관함, 사진
// 찍기, 파일, 팀 파일. Each row opens one picker of the phone (a file chooser here) with what it asks for: pictures and
// videos, the camera, any file (on an iPhone any data file, which WebKit opens as its Files browser without its own
// menu), or the team-file picker. A room takes a team file as a copy (POST /api/rooms/:id/team-file), sent by id, and
// says how many more people it reaches. Runs in Chromium and WebKit (playwright.config.ts). The room is answered through
// page.route (rooms-mock.ts); the team files and chats by the mock team server.
// SHOTS_DIR=<folder>: the sheet in the AI chat and in a room at 390.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const BEN = { id: 'ben', name: '벤' }
const ROOT = '019a5f00-0000-7000-8000-000000000301'
const ROWS = ['attach-photos', 'attach-camera', 'attach-files', 'attach-team']

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

/** The sheet is open: its four rows in this order, at the bottom of the screen, over a scrim. */
async function sheetOpen(page: Page) {
  const sheet = page.getByRole('menu', { name: '파일 첨부' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('menuitem')).toHaveText(['사진 보관함', '사진 찍기', '파일', '팀 파일'])
  const box = (await sheet.boundingBox())!
  expect(Math.round(box.y + box.height)).toBeGreaterThanOrEqual(840)
  expect(box.width).toBe(390)
  return sheet
}

/** What each row's input asks the phone for (in `page`: a page, or the box's part of it). `ios`: the 파일 row asks for
 * any data file. */
async function inputsAsk(page: Page | Locator, files: string, ios: boolean) {
  await expect(page.getByTestId('attach-photos-input')).toHaveAttribute('accept', 'image/*,video/*')
  await expect(page.getByTestId('attach-photos-input')).toHaveAttribute('multiple', '')
  await expect(page.getByTestId('attach-photos-input')).not.toHaveAttribute('capture')
  await expect(page.getByTestId('attach-camera-input')).toHaveAttribute('accept', 'image/*')
  await expect(page.getByTestId('attach-camera-input')).toHaveAttribute('capture', 'environment')
  const f = page.getByTestId(files)
  await expect(f).toHaveAttribute('multiple', '')
  await expect(f).not.toHaveAttribute('capture')
  if (ios) await expect(f).toHaveAttribute('accept', 'application/octet-stream')
  else await expect(f).not.toHaveAttribute('accept')
}

/** A row opens exactly one chooser, of that row's input, and the sheet goes. */
async function opensOneChooser(page: Page, row: string, input: string) {
  let choosers = 0
  const count = () => { choosers++ }
  page.on('filechooser', count)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId(row).click()])
  await expect(page.getByRole('menu', { name: '파일 첨부' })).toHaveCount(0)
  expect(await chooser.element().getAttribute('data-testid')).toBe(input)
  await page.waitForTimeout(300)
  page.off('filechooser', count)
  expect(choosers).toBe(1)
  return chooser
}

test.describe('Android', () => {
  test.use({ userAgent: ANDROID_UA })

  test("the AI chat's +: the sheet, one chooser per row, a tap outside closes it, 팀 파일 opens the team-file picker", async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await reset(page)
    await signIn(page)
    // no small web menu by the button any more, and its inputs are not on the page
    await page.getByTestId('attach-button').click()
    await sheetOpen(page)
    await shot(page, 'attach-sheet-chat-390.png')
    await inputsAsk(page, 'file-input', false)
    await expect(page.getByTestId('attach-computer')).toHaveCount(0)
    // a tap on the scrim above it closes it; the message box takes the next tap
    await page.mouse.click(195, 120)
    await expect(page.getByRole('menu', { name: '파일 첨부' })).toHaveCount(0)
    await page.getByTestId('composer-input').click()
    await expect(page.getByTestId('composer-input')).toBeFocused()
    // 파일: one chooser, several files; what is picked becomes chips
    await page.getByTestId('attach-button').click()
    const chooser = await opensOneChooser(page, 'attach-files', 'file-input')
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles([{ name: 'acme-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') }])
    await expect(page.getByTestId('attachment-chip')).toHaveCount(1)
    await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'done')
    // 사진 보관함 and 사진 찍기: one chooser each, of their own input
    await page.getByTestId('attach-button').click()
    await opensOneChooser(page, 'attach-photos', 'attach-photos-input')
    await page.getByTestId('attach-button').click()
    const cam = await opensOneChooser(page, 'attach-camera', 'attach-camera-input')
    expect(cam.isMultiple()).toBe(false)
    // 팀 파일: the team-file picker
    await page.getByTestId('attach-button').click()
    await page.getByTestId('attach-team').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('picker-search').fill('plan')
    await dialog.getByTestId('picker-file').filter({ hasText: 'plan.md' }).first().locator('input').check()
    await dialog.getByTestId('picker-attach').click()
    await expect(page.locator('[data-testid="attachment-chip"][data-source="team"]')).toHaveCount(1)
  })

  test("a room's 📎 and a thread's 📎: the same sheet; a team file goes into the room as a copy, and the box says who more sees it", async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await reset(page)
    await signIn(page)
    const room = await routeRoom(page, { members: [BEN, { id: 'cho', name: '초' }], messages: [{ id: ROOT, author: BEN, body: '이번 주 기획안 보내 주세요' }] })
    // the copy (server/src/routes/rooms.ts attachRoomTeamFile): my upload in the room, two people could not open it
    const copied: string[] = []
    await page.route(`**/api/rooms/${ROOM_ID}/team-file`, async (r) => {
      const { path: p } = r.request().postDataJSON() as { path: string }
      copied.push(p)
      await r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ file: { id: '019a5f00-0000-7000-8000-00000000f001', name: p.slice(p.lastIndexOf('/') + 1), size: 24, mime: 'text/markdown', kind: 'document', thumb: false }, unable: 2 }) })
    })
    await page.goto(`/rooms/${ROOM_ID}`)
    await page.getByTestId('room-attach').click()
    await sheetOpen(page)
    await shot(page, 'attach-sheet-room-390.png')
    await inputsAsk(page, 'room-file-input', false)
    await page.getByTestId('attach-team').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('picker-search').fill('plan')
    await dialog.getByTestId('picker-file').filter({ hasText: 'plan.md' }).first().locator('input').check()
    await dialog.getByTestId('picker-attach').click()
    await expect(dialog).toHaveCount(0)
    const chip = page.locator('[data-testid="room-file-chip"][data-team]')
    await expect(chip).toHaveAttribute('data-status', 'done')
    await expect(chip).toContainText('plan.md')
    expect(copied).toEqual(['marketing/plan.md'])
    await expect(page.getByTestId('room-team-file-widen')).toHaveText('팀 파일을 보내면 2명이 더 보게 돼요')
    await page.getByTestId('room-send').click()
    await expect.poll(() => room.sent.length).toBe(1)
    expect((room.sent[0] as unknown as { fileIds: string[] }).fileIds).toEqual(['019a5f00-0000-7000-8000-00000000f001'])
    await expect(page.getByTestId('room-team-file-widen')).toHaveCount(0)
    // a thread's box: the same sheet
    await page.goto(`/rooms/${ROOM_ID}/t/${ROOT}`)
    const threadAttach = page.locator('[data-testid="room-attach"]:visible')
    await expect(threadAttach).toHaveCount(1)
    await threadAttach.click()
    await sheetOpen(page)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: '파일 첨부' })).toHaveCount(0)
  })

  test("the side chat's 📎: the same sheet, with team files too", async ({ page }) => {
    await reset(page)
    await signIn(page)
    await routeRoom(page, { members: [BEN], messages: [{ id: ROOT, author: BEN, body: '로고 시안 보내 주세요' }] })
    await page.goto(`/rooms/${ROOM_ID}`)
    await page.getByTestId('room-side-chat-button').click()
    const side = page.getByTestId('room-side-chat')
    await expect(side.getByTestId('side-chat-empty')).toBeVisible()
    await side.getByTestId('side-chat-attach').click()
    await sheetOpen(page)
    await inputsAsk(side, 'side-chat-file-input', false)
    await page.getByTestId('attach-team').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByTestId('picker-search').fill('plan')
    await dialog.getByTestId('picker-file').filter({ hasText: 'plan.md' }).first().locator('input').check()
    await dialog.getByTestId('picker-attach').click()
    await expect(side.locator('[data-testid="attachment-chip"][data-source="team"]')).toHaveAttribute('data-status', 'done')
  })
})

test.describe('iPhone', () => {
  test.use({ userAgent: IPHONE_UA })

  test('each row asks iOS for one picker: the photo library, the camera, the Files browser', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.getByTestId('attach-button').click()
    await sheetOpen(page)
    await inputsAsk(page, 'file-input', true)
    const chooser = await opensOneChooser(page, 'attach-files', 'file-input')
    await chooser.setFiles([{ name: '견적서.hwp', mimeType: 'application/x-hwp', buffer: Buffer.from('hwp') }])
    await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'done')
    // a room's box alike
    await routeRoom(page, { members: [BEN] })
    await page.goto(`/rooms/${ROOM_ID}`)
    await page.getByTestId('room-attach').click()
    await sheetOpen(page)
    await inputsAsk(page, 'room-file-input', true)
  })
})
