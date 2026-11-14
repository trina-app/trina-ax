// The right-click menu of a picture or file (components/FileMenu.tsx, docs/DECISIONS.md "A right-click menu on pictures
// and files"), at 1440: a room's photo, the image viewer's picture, a file chip and a Files row. 링크 복사 puts the app's
// own address of the place on the clipboard (the message, or the file), and 이미지 복사 the original as a PNG, read
// through the room's own file route; the menu key and Shift+F10 open it from the keyboard and Esc gives the focus back.
// The clipboard is Chromium's, granted by playwright.config.ts, never the computer's. The room is answered through
// page.route as the team server sends it (rooms-mock.ts).
// SHOTS_DIR=<folder>: the menu at 1440 light and the sheet at 390 light go there.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ICON = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const PIC = { id: id(801), name: 'acme-logo.png', size: ICON.length, mime: 'image/png', kind: 'image', width: 192, height: 192, thumb: true }
const DOC = { id: id(802), name: 'acme-plan.pdf', size: 1234, mime: 'application/pdf', kind: 'pdf', thumb: false }
const MSG = id(1)

async function openRoom(page: Page) {
  await reset(page)
  await routeRoom(page, { members: [BEN], kind: 'team', messages: [
    { id: MSG, author: BEN, body: '로고예요', extra: { files: [PIC] } },
    { id: id(2), author: BEN, body: '계획서', extra: { files: [DOC] } },
  ] })
  const served: string[] = []
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, (route) => {
    const u = new URL(route.request().url())
    served.push(`${u.pathname}${u.search}`)
    const doc = u.pathname.endsWith(DOC.id)
    return route.fulfill({ status: 200, body: doc ? Buffer.from('%PDF-1.4') : ICON, headers: { 'content-type': doc ? 'application/pdf' : 'image/png', 'x-content-type-options': 'nosniff' } })
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(2)
  return { served }
}

const menu = (page: Page) => page.getByRole('menu')
const items = (page: Page) => menu(page).getByRole('menuitem')
const clipboardText = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const shoot = async (page: Page, name: string) => {
  const dir = process.env.SHOTS_DIR
  if (dir) await page.screenshot({ path: path.join(dir, name) })
}

test("a room photo's right-click: the app's menu at the pointer; 링크 복사 copies the message's address", async ({ page }) => {
  const { served } = await openRoom(page)
  const pic = page.getByTestId('room-image')
  const box = (await pic.boundingBox())!
  await page.mouse.click(box.x + 20, box.y + 20, { button: 'right' })
  await expect(items(page)).toHaveText(['이미지 복사', '링크 복사', '내려받기', '트리나에게 이 파일 묻기'])
  // at the pointer: its top left corner there
  const m = (await menu(page).boundingBox())!
  expect(Math.abs(m.x - (box.x + 20))).toBeLessThan(2)
  // (a 4 px gap under the pointer, as under a button)
  expect(Math.abs(m.y - (box.y + 20 + 4))).toBeLessThan(2)
  await shoot(page, 'file-menu-1440-light.png')
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await items(page).filter({ hasText: '링크 복사' }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(page.getByTestId('toast').last()).toHaveText('링크를 복사했어요. 볼 수 있는 사람만 열 수 있어요.')
  const link = await clipboardText(page)
  const origin = new URL(page.url()).origin
  expect(link).toBe(`${origin}/rooms/${ROOM_ID}?m=${MSG}`)
  expect(link).not.toMatch(/token|\/api\//)
  // the picture did not open (a right-click is no click)
  await expect(page.getByTestId('image-viewer')).toHaveCount(0)
  // the link opens the room at the message
  await page.goto(link)
  await expect(page.getByTestId('room-message').first()).toBeVisible()

  // 이미지 복사: the original, read through the room's own route, as a PNG
  await page.getByTestId('room-image').click({ button: 'right' })
  await items(page).filter({ hasText: '이미지 복사' }).click()
  await expect(page.getByTestId('toast').last()).toHaveText('이미지를 복사했어요')
  const png = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'))
    if (!item) return null
    const bmp = await createImageBitmap(await item.getType('image/png'))
    return { width: bmp.width, height: bmp.height }
  })
  expect(png).toEqual({ width: 192, height: 192 })
  expect(served).toContain(`/api/rooms/${ROOM_ID}/files/${PIC.id}`)
  for (const s of served) expect(s.startsWith(`/api/rooms/${ROOM_ID}/files/`)).toBe(true)
})

test('the keyboard: the menu key and Shift+F10 open it on the focused photo, Esc closes it with the focus back', async ({ page }) => {
  await openRoom(page)
  const pic = page.getByTestId('room-image')
  await pic.focus()
  await page.keyboard.press('Shift+F10')
  await expect(items(page).first()).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(items(page).nth(1)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(pic).toBeFocused()
  await page.keyboard.press('ContextMenu')
  await expect(items(page)).toHaveCount(4)
  await page.keyboard.press('Escape')
  // Shift+right-click keeps the browser's own menu: the app's does not open
  await pic.click({ button: 'right', modifiers: ['Shift'] })
  await expect(menu(page)).toHaveCount(0)
})

test('a file chip: no 이미지 복사; the viewer picture: its menu, and 링크 복사 there too', async ({ page }) => {
  await openRoom(page)
  await page.getByTestId('room-file-open').click({ button: 'right' })
  await expect(items(page)).toHaveText(['링크 복사', '내려받기', '트리나에게 이 파일 묻기'])
  await page.keyboard.press('Escape')

  await page.getByTestId('room-image').click()
  const viewer = page.getByTestId('image-viewer')
  await expect(viewer).toBeVisible()
  await expect(page.getByTestId('image-viewer-original')).toHaveAttribute('data-state', 'shown')
  const pic = (await page.getByTestId('image-viewer-original').boundingBox())!
  // beside the picture: nothing of the app's
  await page.mouse.click(10, 300, { button: 'right' })
  await expect(menu(page)).toHaveCount(0)
  await page.mouse.click(pic.x + pic.width / 2, pic.y + pic.height / 2, { button: 'right' })
  await expect(viewer.getByRole('menu').getByRole('menuitem')).toHaveText(['이미지 복사', '링크 복사', '내려받기', '트리나에게 이 파일 묻기'])
  await viewer.getByRole('menuitem', { name: '링크 복사' }).click()
  expect(await clipboardText(page)).toBe(`${new URL(page.url()).origin}/rooms/${ROOM_ID}?m=${MSG}`)
  // the viewer is still open: the menu's Esc was the menu's
  await expect(viewer).toBeVisible()
})

test("a Files row's right-click opens its ⋯ menu at the pointer, with 링크 복사 of the file", async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  const row = page.getByTestId('file-row').filter({ hasText: 'plan.md' })
  const name = row.getByRole('button').first()
  const box = (await name.boundingBox())!
  await page.mouse.click(box.x + 30, box.y + box.height / 2, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  const m = (await menu(page).boundingBox())!
  expect(Math.abs(m.x - (box.x + 30))).toBeLessThan(2)
  await page.getByTestId('file-copy-link').click()
  expect(await clipboardText(page)).toBe(`${new URL(page.url()).origin}/files/view?path=${encodeURIComponent('marketing/plan.md')}`)
  // from the keyboard: Shift+F10 on the row's name opens the same menu, with the keyboard in it
  await name.focus()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByTestId('file-copy-link')).toBeVisible()
  await expect(items(page).first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
})

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 780 } })
  test('the same menu is a sheet from the bottom', async ({ page }) => {
    await openRoom(page)
    await page.getByTestId('room-image').click({ button: 'right' })
    await expect(items(page)).toHaveCount(4)
    const m = (await menu(page).boundingBox())!
    expect(m.x).toBe(0)
    expect(Math.round(m.y + m.height)).toBe(780)
    await shoot(page, 'file-menu-390-light.png')
  })
})
