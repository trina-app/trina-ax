// Small phone fixes from the 11-11 phone audit (QA TC-265), at 390×844: a Mermaid diagram follows the dark theme, an
// answer table keeps an amount with its unit on one line, the page behind a file preview is out of reach, the usage
// filters have one ⌄, the empty room's box says its line on one line, and the room's side chat (full screen on a phone)
// has no "Open full screen". SHOTS_DIR=<folder>: a screenshot of each.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'
import { DICTS } from '../../src/i18n'

// the room's answers come through page.route, which does not see what the app's service worker fetches
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })
const t = DICTS.ko

async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
}

test('dark theme: the Mermaid diagram is drawn dark on a dark card', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await reset(page)
  await signIn(page)
  await ask(page, 'a diagram please')
  const d = page.getByTestId('md-mermaid')
  await expect(d).toBeVisible({ timeout: 15_000 })
  await expect(d).toHaveAttribute('data-theme', 'dark')
  expect(await d.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe('rgb(255, 255, 255)')
  await d.scrollIntoViewIfNeeded()
  await shot(page, 'after-1-mermaid-dark.png')
  // the light look draws it again with the light theme
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(d).toHaveAttribute('data-theme', 'neutral', { timeout: 15_000 })
})

test('an answer table keeps "1,234,567,890원" and "12,345건" on one line', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'big numbers')
  const table = page.getByTestId('md-table-scroll').last()
  for (const text of ['1,234,567,890원', '12,345건', '₩987,654,321']) {
    const cell = table.locator('td', { hasText: text })
    await expect(cell).toHaveCSS('white-space', 'nowrap')
    // one line: the cell's text is no taller than one line of it
    const lines = await cell.evaluate((td) => {
      const r = document.createRange()
      r.selectNodeContents(td)
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size
    })
    expect([text, lines]).toEqual([text, 1])
  }
  await table.scrollIntoViewIfNeeded()
  await shot(page, 'after-2-table.png')
})

test('a file preview on a phone: the page behind is inert until it closes', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  const row = page.getByTestId('file-row').filter({ hasText: 'plan.md' }).getByRole('button').first()
  await row.click()
  await expect(page.getByTestId('file-panel')).toBeVisible()
  await expect(page.locator('main#main')).toHaveAttribute('inert', '')
  await shot(page, 'after-3-file-preview.png')
  await page.getByTestId('file-panel').getByRole('button', { name: t['common.close'], exact: true }).first().click()
  await expect(page.getByTestId('side-panel')).toHaveCount(0)
  await expect(page.locator('main#main')).not.toHaveAttribute('inert')
  // the focus is back on the row that opened it
  await expect(row).toBeFocused()
})

test('the usage filters show one ⌄ each (the select\'s own)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/usage')
  const pill = page.getByTestId('usage-range-pill')
  await expect(pill).toBeVisible()
  await expect(pill.locator('svg')).toHaveCount(0)
  expect(await page.getByTestId('usage-range').evaluate((s) => getComputedStyle(s).backgroundImage)).toContain('data:image/svg+xml')
  await shot(page, 'after-5-admin-usage.png')
  await page.goto('/settings/usage')
  await expect(page.getByTestId('my-usage-period-pill').locator('svg')).toHaveCount(0)
  await shot(page, 'after-5-my-usage.png')
})

test('an empty DM: the box\'s line fits on one line; the side chat has no "Open full screen" on a phone', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await routeRoom(page, { members: [{ id: 'ben', name: '벤' }], kind: 'dm' })
  await page.goto(`/rooms/${ROOM_ID}`)
  const box = page.getByTestId('room-input')
  await expect(box).toHaveAttribute('placeholder', t['rooms.placeholderEmpty'])
  // both lines of the empty box, in every language, fit the box's text width at 390 px (measured in its own font)
  const lines = Object.entries(DICTS).flatMap(([loc, d]) => [`${loc}: ${d['rooms.placeholderEmpty']}`, `${loc}: ${d['rooms.placeholderEmptySide']}`])
  const over = await box.evaluate((el, all) => {
    const cs = getComputedStyle(el)
    const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    return all.filter((x) => ctx.measureText(x.slice(x.indexOf(': ') + 2)).width > room).map((x) => `${x} (${Math.round(room)} px)`)
  }, lines)
  expect(over).toEqual([])
  await shot(page, 'after-7-empty-dm.png')
  await page.getByTestId('room-side-chat-button').click()
  const side = page.getByTestId('side-chat-panel')
  await side.getByRole('textbox').first().fill('hi')
  await page.keyboard.press('Enter')
  await expect(side.getByTestId('side-chat-new')).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByTestId('side-chat-open-full')).toBeHidden()
  await shot(page, 'after-8-side-chat.png')
  // a computer keeps it beside the room
  await page.setViewportSize({ width: 1280, height: 860 })
  await expect(page.getByTestId('side-chat-open-full')).toBeVisible()
})
