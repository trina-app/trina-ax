// A phone's message box with the keyboard up (QA TC-252): the text field and send stay in sight. A room's box with six
// files, the "@" list and a long draft in a 390 x 480 view (the keyboard took the rest; lib/viewport.ts sets
// .keyboard-open and --app-h): its files in one sideways row, the "@" list at most a quarter of what is in sight and over
// the newest messages (not pushing the box), the text field at most 30 %, the messages still showing. The AI chat's box: the row under it (the engine picker) and the
// who-sees line go while the keyboard is up and come back after. The keyboard is the window made shorter, as the iPhone
// app's WebView and Android do (phone-keyboard.spec.ts). SHOTS_DIR=<folder>: both boxes with the keyboard up.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const W = 390, H = 844, KB = 480
const SORA = { id: 'sora', name: '소라' }
const PEOPLE = [SORA, { id: 'jun', name: '준' }, { id: 'min', name: '민' }, { id: 'ha', name: '하' }, { id: 'yu', name: '유' }]
const PNG = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-192.png'))
const MESSAGES: MockMessage[] = Array.from({ length: 12 }, (_, i) => ({ id: `019a5f00-0000-7000-8000-0000000004${String(i).padStart(2, '0')}`, author: SORA, body: `${i + 1}번째 메시지예요.` }))

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

async function keyboard(page: Page, up: boolean) {
  await page.setViewportSize({ width: W, height: up ? KB : H })
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-h'))).toBe(`${up ? KB : H}px`)
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('keyboard-open'))).toBe(up)
}

const box = async (l: Locator) => (await l.boundingBox())!
/** wholly inside what is in sight */
async function inSight(l: Locator) {
  const b = await box(l)
  expect(b.y).toBeGreaterThanOrEqual(0)
  expect(b.y + b.height).toBeLessThanOrEqual(KB)
}

test("a room's box: six files, the @ list and a long draft keep the text field and send in sight", async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await reset(page)
  await signIn(page)
  await routeRoom(page, { members: PEOPLE, messages: MESSAGES })
  let n = 0
  await page.route(`**/api/rooms/${ROOM_ID}/files`, (r) => {
    const id = `019a5f00-0000-7000-8000-0000000005${String(++n).padStart(2, '0')}`
    return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id, name: `file-${n}`, size: 100, mime: 'text/plain', kind: 'text', thumb: false }) })
  })
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(MESSAGES.length)
  // six files: three pictures and three documents
  await page.getByTestId('room-attach').click()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('attach-files').click()])
  await chooser.setFiles([
    ...[1, 2, 3].map((i) => ({ name: `photo-${i}.png`, mimeType: 'image/png', buffer: PNG })),
    ...['회의록.pdf', '견적서-2026-11.xlsx', '디자인 리뷰 메모.txt'].map((name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })),
  ])
  const chips = page.getByTestId('room-file-chip')
  await expect(chips).toHaveCount(6)
  for (let i = 0; i < 6; i++) await expect(chips.nth(i)).toHaveAttribute('data-status', 'done')
  const input = page.getByTestId('room-input')
  await input.click()
  await keyboard(page, true)
  // a long draft, then "@" for the list
  await input.fill(Array.from({ length: 20 }, (_, i) => `${i + 1}. 오늘 정한 일을 한 줄씩 적어요`).join('\n') + '\n')
  await page.keyboard.type('@')
  await expect(page.getByTestId('mention-menu')).toBeVisible()
  await shot(page, 'keyboard-room-390x480.png')
  // the files: one row (each chip's middle on one line) that scrolls sideways
  const middles = await Promise.all([0, 1, 2, 3, 4, 5].map(async (i) => { const b = await box(chips.nth(i)); return Math.round(b.y + b.height / 2) }))
  expect(Math.max(...middles) - Math.min(...middles)).toBeLessThanOrEqual(2)
  const row = page.getByTestId('room-file-chips')
  expect(await row.evaluate((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).overflowX === 'auto')).toBe(true)
  // the "@" list: at most a quarter of what is in sight, over the newest messages right above the box (not pushing it)
  const list = page.getByTestId('mention-menu').getByRole('listbox')
  expect((await box(list)).height).toBeLessThanOrEqual(KB * 0.25 + 1)
  const menu = await box(page.getByTestId('mention-menu'))
  expect(Math.round(menu.y + menu.height)).toBeLessThanOrEqual(Math.round((await box(row)).y) + 1)
  // the text field: at most 30 %, and it and send in sight
  expect((await box(input)).height).toBeLessThanOrEqual(KB * 0.3 + 1)
  await inSight(input)
  await inSight(page.getByTestId('room-send'))
  // the messages still show above the box
  expect(await page.getByTestId('room-scroller').evaluate((e) => e.clientHeight)).toBeGreaterThanOrEqual(60)
  // the keyboard down: the text field may grow to 200 px again (a computer's cap); one row of files still
  await page.keyboard.press('Escape')
  await keyboard(page, false)
  expect((await box(input)).height).toBeLessThanOrEqual(201)
  expect((await box(input)).height).toBeGreaterThan(KB * 0.3 + 1)
})

test("the AI chat's box: the engine row and the who-sees line hide while the keyboard is up", async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('안녕하세요')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  const controls = page.getByTestId('composer-controls'), who = page.getByTestId('composer-phone-footer')
  await expect(controls).toBeVisible()
  await expect(page.getByTestId('engine-picker')).toBeVisible()
  await expect(who).toBeVisible()
  const input = page.getByTestId('composer-input')
  await input.click()
  await keyboard(page, true)
  await expect(controls).toBeHidden()
  await expect(who).toBeHidden()
  await input.fill(Array.from({ length: 20 }, (_, i) => `${i + 1}번째 줄`).join('\n'))
  expect((await box(input)).height).toBeLessThanOrEqual(KB * 0.3 + 1)
  await inSight(input)
  await inSight(page.getByTestId('send'))
  await shot(page, 'keyboard-chat-390x480.png')
  await keyboard(page, false)
  await expect(controls).toBeVisible()
  await expect(who).toBeVisible()
})
