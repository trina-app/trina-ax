// Lazy PDF pages and the room file viewer's page thumbnails (components/viewers/PdfView.tsx, lib/pdfPages.ts;
// docs/DECISIONS.md "Lazy PDF pages"): a 60-page PDF, made here, sent in a room. Every page has a placeholder of its
// size, and only the pages near the view are drawn, so a few canvases are mounted wherever the PDF is shown. In the
// viewer on a computer a rail of page pictures sits left of the document: drawn as they come into view, the current page
// marked and following the scroll, a click (or ↑ ↓) goes to that page, and the toolbar says "3 / 60". A one-page PDF
// has no rail, a phone has none, and the side panel has none. Zoom keeps the page being read at the top, and the text of
// a drawn page can be selected and copied; a link inside the file goes to its page even when that page is not drawn.
// The room is answered through page.route (rooms-mock.ts).
// SHOTS_DIR=<folder>: the viewer mid-document at 1440 light and dark, and at 390 light.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { makePagedPdf, makePdf } from '../../../tests/lib/pdf'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } })

const BEN = { id: 'ben', name: '벤' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const PAGES = 60
// page 1's second line is a link inside the file to page 45, as a table of contents has
const SIXTY = Buffer.from(
  makePagedPdf(
    Array.from({ length: PAGES }, (_, i) => [`acme page ${i + 1}`, ...(i === 0 ? ['contents: go to page 45'] : []), ...Array.from({ length: 44 }, (_, k) => `line ${k + 1} of page ${i + 1}: the quick brown fox jumps over the lazy dog`)]),
    { links: [{ page: 1, line: 1, to: 45 }] },
  ),
)
const ONE = Buffer.from(makePdf(['acme one page', 'Only this page.']))
const FILES = new Map([
  [id(901), { name: 'acme-60.pdf', body: SIXTY }],
  [id(902), { name: 'acme-one.pdf', body: ONE }],
])

/** A room with Ben's 60-page PDF and, after it, a one-page PDF. */
async function openRoom(page: Page) {
  await reset(page)
  await signIn(page)
  const file = (n: number) => ({ id: id(n), name: FILES.get(id(n))!.name, size: FILES.get(id(n))!.body.length, mime: 'application/pdf', kind: 'pdf', thumb: false })
  await routeRoom(page, {
    members: [BEN],
    kind: 'team',
    messages: [
      { id: id(1), author: BEN, body: '60쪽 자료예요', extra: { files: [file(901)] } },
      { id: id(2), author: BEN, body: '한 쪽짜리', extra: { files: [file(902)] } },
    ],
  })
  // the room's files, inline, as the team server sends a PDF (team-files/download.ts streamFile)
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, async (route) => {
    const f = FILES.get(new URL(route.request().url()).pathname.split('/').pop()!)
    if (!f) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"not_found","message":"x"}}' })
    return route.fulfill({ status: 200, body: f.body, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${f.name}"`, 'x-content-type-options': 'nosniff' } })
  })
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-scroller').getByTestId('room-message')).toHaveCount(2)
}

const viewer = (page: Page) => page.getByTestId('image-viewer')
const body = (page: Page) => viewer(page).getByTestId('file-viewer-body')
const openChip = (page: Page, name: string) => page.getByTestId('room-scroller').getByTestId('room-file').filter({ hasText: name }).getByTestId('room-file-open').click()
/** the document's pages that hold a canvas (the thumbnails' are not pages) */
const drawn = (where: Locator) => where.locator('.react-pdf__Page canvas')
const rail = (page: Page) => viewer(page).getByTestId('pdf-thumbnails')
const thumb = (page: Page, n: number) => rail(page).locator(`[data-thumb="${n}"]`).getByTestId('pdf-thumb')
const pageInfo = (page: Page) => viewer(page).getByTestId('pdf-page-info')

/** How far page `n`'s top is from the toolbar's bottom, in px (0: right under it). */
async function belowToolbar(where: Locator, n: number) {
  const [p, bar] = await Promise.all([where.locator(`[data-page="${n}"]`).boundingBox(), where.getByTestId('pdf-toolbar').boundingBox()])
  return p!.y - (bar!.y + bar!.height)
}

/** Scrolls the viewer's document as a person would (not through a thumbnail): page `n`'s top `dy` px below the toolbar. */
async function scrollToPage(page: Page, n: number, dy = 0) {
  const off = await belowToolbar(body(page), n)
  await body(page).evaluate((el, d) => el.scrollBy(0, d), off - dy)
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('a 60-page PDF in the viewer: every page has its place, a few are drawn; the thumbnails go to a page and follow the scroll', async ({ page }) => {
  await openRoom(page)
  await openChip(page, 'acme-60.pdf')
  await expect(page.getByRole('dialog', { name: '파일 보기: acme-60.pdf' })).toBeVisible()
  await expect(drawn(body(page)).first()).toBeVisible({ timeout: 15_000 })
  // a placeholder for each page, as tall as the page (A4 fitted to the column: 928 px wide)
  await expect(body(page).locator('[data-page]')).toHaveCount(PAGES)
  const sizes = await body(page).locator('[data-page]').evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]))
  expect(new Set(sizes.map((s) => s.join('x')))).toEqual(new Set(['928x1313']))
  // the document is as tall as all of them
  expect(await body(page).evaluate((el) => el.scrollHeight)).toBeGreaterThan(PAGES * 1313)
  // only the first pages are drawn
  await page.waitForTimeout(500)
  expect(await drawn(body(page)).count()).toBeLessThanOrEqual(3)
  await expect(body(page).locator('[data-page="1"] .react-pdf__Page__textContent')).toContainText('acme page 1')

  // the rail: left of the document, one picture per page, and only the ones in its view drawn
  await expect(rail(page)).toBeVisible()
  await expect(rail(page)).toHaveAccessibleName('페이지 목록')
  await expect(rail(page).getByTestId('pdf-thumb')).toHaveCount(PAGES)
  // the column stays centred where it was (as without the rail), the rail right beside it
  const [r, b] = await Promise.all([rail(page).boundingBox(), body(page).boundingBox()])
  expect(b).toMatchObject({ x: 240, width: 960 })
  expect(r!.x + r!.width).toBeLessThanOrEqual(b!.x + 1)
  expect(r!.x + r!.width).toBeGreaterThan(b!.x - 20)
  await expect(rail(page).locator('canvas').first()).toBeVisible()
  expect(await rail(page).locator('canvas').count()).toBeLessThanOrEqual(20)
  expect(await drawn(rail(page)).count()).toBe(0)
  await expect(thumb(page, 1)).toHaveAttribute('aria-current', 'page')
  // named by the number it shows (label in name), in the list named 페이지 목록
  await expect(thumb(page, 1)).toHaveAccessibleName('1')
  await expect(pageInfo(page)).toHaveText(`1 / ${PAGES}`)
  await audit(page, 'viewer with page thumbnails')

  // a link inside the file (page 1's contents line) to page 45, which is not drawn: it goes there
  await expect(body(page).locator('[data-page="45"] canvas')).toHaveCount(0)
  await body(page).locator('[data-page="1"] .annotationLayer a').first().click()
  await expect(pageInfo(page)).toHaveText(`45 / ${PAGES}`)
  await expect.poll(async () => Math.abs((await belowToolbar(body(page), 45)) - 12)).toBeLessThanOrEqual(2)
  await expect(body(page).locator('[data-page="45"] canvas')).toBeVisible()
  await expect(page.getByRole('dialog', { name: '파일 보기: acme-60.pdf' })).toBeVisible()

  // a thumbnail's click: that page at the top, drawn, the current one in the rail and the toolbar
  await thumb(page, 40).click()
  await expect(pageInfo(page)).toHaveText(`40 / ${PAGES}`)
  await expect(thumb(page, 40)).toHaveAttribute('aria-current', 'page')
  await expect(thumb(page, 1)).not.toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => Math.abs((await belowToolbar(body(page), 40)) - 12)).toBeLessThanOrEqual(2)
  await expect(body(page).locator('[data-page="40"] canvas')).toBeVisible()
  await expect(body(page).locator('[data-page="40"] .react-pdf__Page__textContent')).toContainText('acme page 40')
  // the pages far away were released: still a few canvases
  await expect.poll(() => drawn(body(page)).count()).toBeLessThanOrEqual(4)
  await expect(body(page).locator('[data-page="1"] canvas')).toHaveCount(0)

  // scrolling the document: the current page follows, and its picture comes into the rail's view
  await scrollToPage(page, 12, -300)
  await expect(pageInfo(page)).toHaveText(`12 / ${PAGES}`)
  await expect(thumb(page, 12)).toHaveAttribute('aria-current', 'page')
  await expect(thumb(page, 12)).toBeInViewport()
  await expect.poll(async () => {
    const [t, list] = await Promise.all([thumb(page, 12).boundingBox(), rail(page).boundingBox()])
    return t!.y >= list!.y && t!.y + t!.height <= list!.y + list!.height
  }).toBe(true)
  await expect.poll(() => drawn(body(page)).count()).toBeLessThanOrEqual(4)
  await expect(body(page).locator('[data-page="40"] canvas')).toHaveCount(0)

  // zoom: the page being read stays at the top, still a few canvases; fit to width brings it back
  await scrollToPage(page, 20)
  await expect(pageInfo(page)).toHaveText(`20 / ${PAGES}`)
  await viewer(page).getByTestId('pdf-zoom-in').click()
  await viewer(page).getByTestId('pdf-zoom-in').click()
  await expect(viewer(page).getByTestId('pdf-zoom-level')).toHaveText('150%')
  await expect.poll(async () => Math.round((await body(page).locator('[data-page="20"]').boundingBox())!.width)).toBe(1392)
  await expect.poll(async () => Math.abs(await belowToolbar(body(page), 20))).toBeLessThanOrEqual(4)
  await expect(pageInfo(page)).toHaveText(`20 / ${PAGES}`)
  await expect(body(page).locator('[data-page="20"] canvas')).toBeVisible()
  expect(await drawn(body(page)).count()).toBeLessThanOrEqual(4)
  await viewer(page).getByTestId('pdf-zoom-out').click()
  await viewer(page).getByTestId('pdf-zoom-out').click()
  await viewer(page).getByTestId('pdf-zoom-out').click()
  await expect(viewer(page).getByTestId('pdf-zoom-level')).toHaveText('75%')
  await expect.poll(async () => Math.abs(await belowToolbar(body(page), 20))).toBeLessThanOrEqual(4)
  await viewer(page).getByTestId('pdf-fit-width').click()
  await expect.poll(async () => Math.round((await body(page).locator('[data-page="20"]').boundingBox())!.width)).toBe(928)
  await expect.poll(async () => Math.abs(await belowToolbar(body(page), 20))).toBeLessThanOrEqual(4)

  // the text of a drawn page is selected and copied as text
  const word = body(page).locator('[data-page="20"] .react-pdf__Page__textContent span').filter({ hasText: 'acme page 20' })
  await word.dblclick()
  await expect.poll(() => page.evaluate(() => getSelection()?.toString().trim())).toMatch(/^(acme|page|20)$/)
  await word.click({ clickCount: 3 })
  await expect.poll(() => page.evaluate(() => getSelection()?.toString() ?? '')).toContain('acme page 20')
  await page.keyboard.press('ControlOrMeta+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('acme page 20')
  await expect(page.getByRole('dialog', { name: '파일 보기: acme-60.pdf' })).toBeVisible()

  // the keys in the rail: one Tab stop (the current page's), ↓ the next page, End the last
  await thumb(page, 20).focus()
  await expect(rail(page).locator('button[tabindex="0"]')).toHaveCount(1)
  await page.keyboard.press('ArrowDown')
  await expect(pageInfo(page)).toHaveText(`21 / ${PAGES}`)
  await expect(thumb(page, 21)).toBeFocused()
  await page.keyboard.press('End')
  await expect(pageInfo(page)).toHaveText(`${PAGES} / ${PAGES}`)
  await expect(body(page).locator(`[data-page="${PAGES}"] canvas`)).toBeVisible()
  await expect(thumb(page, PAGES)).toBeInViewport()
  // ← → still step through the room's files from the rail
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: '파일 보기: acme-one.pdf' })).toBeVisible()
})

test('a one-page PDF has no rail and no page count; the document stays centred', async ({ page }) => {
  await openRoom(page)
  await openChip(page, 'acme-one.pdf')
  await expect(drawn(body(page)).first()).toBeVisible({ timeout: 15_000 })
  await expect(viewer(page).getByTestId('pdf-toolbar')).toBeVisible()
  await expect(rail(page)).toHaveCount(0)
  await expect(pageInfo(page)).toHaveCount(0)
  const b = (await body(page).boundingBox())!
  expect(b.width).toBe(960)
  expect(b.x).toBe(240)
})

test('the side panel (패널에서 열기): a few canvases for the 60 pages, no thumbnails, zoom keeps the page', async ({ page }) => {
  await openRoom(page)
  await openChip(page, 'acme-60.pdf')
  await expect(drawn(body(page)).first()).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('image-viewer-panel').click()
  await expect(viewer(page)).toHaveCount(0)
  const panel = page.getByTestId('file-panel')
  await expect(panel.getByTestId('file-panel-title')).toHaveText('acme-60.pdf')
  await expect(drawn(panel).first()).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('[data-page]')).toHaveCount(PAGES)
  await expect(panel.getByTestId('pdf-thumbnails')).toHaveCount(0)
  await expect(page.getByTestId('pdf-thumbnails')).toHaveCount(0)
  await expect(panel.getByTestId('pdf-page-info')).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(await drawn(panel).count()).toBeLessThanOrEqual(5)
  // far down by scrolling: the pages there are drawn, the first ones released
  const scroller = panel.locator('[data-page="1"]').locator('xpath=ancestor::div[contains(@class,"overflow-auto")][1]')
  await scroller.evaluate((el) => el.scrollBy(0, el.scrollHeight / 2))
  const current = () => panel.locator('[data-current-page]').getAttribute('data-current-page').then(Number)
  await expect.poll(current).toBeGreaterThan(25)
  await expect(panel.locator('[data-page="1"] canvas')).toHaveCount(0)
  await expect.poll(() => drawn(panel).count()).toBeLessThanOrEqual(6)
  // the link inside the file, back at the top: it goes to page 45
  await scroller.evaluate((el) => el.scrollTo(0, 0))
  await panel.locator('[data-page="1"] .annotationLayer a').first().click()
  await expect.poll(current).toBe(45)
  await expect(panel.locator('[data-page="45"] canvas')).toBeVisible()
  // zoom in: the page being read stays where it was
  const reading = await current()
  const before = await belowToolbar(panel, reading)
  await panel.getByTestId('pdf-zoom-in').click()
  await expect(panel.getByTestId('pdf-zoom-level')).toHaveText('125%')
  await expect.poll(current).toBe(reading)
  await expect.poll(async () => Math.abs((await belowToolbar(panel, reading)) - before * 1.25)).toBeLessThanOrEqual(6)
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the viewer has no rail; a few pages are drawn', async ({ page }) => {
    await openRoom(page)
    await openChip(page, 'acme-60.pdf')
    await expect(drawn(body(page)).first()).toBeVisible({ timeout: 15_000 })
    await expect(body(page).locator('[data-page]')).toHaveCount(PAGES)
    await expect(rail(page)).toHaveCount(0)
    await expect(pageInfo(page)).toHaveCount(0)
    expect((await body(page).boundingBox())!.width).toBe(390)
    await page.waitForTimeout(500)
    expect(await drawn(body(page)).count()).toBeLessThanOrEqual(6)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  })
})

test('screenshots of the PDF thumbnails (SHOTS_DIR)', async ({ page }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'only with SHOTS_DIR')
  await page.emulateMedia({ colorScheme: 'light' })
  await openRoom(page)
  await openChip(page, 'acme-60.pdf')
  await expect(drawn(body(page)).first()).toBeVisible({ timeout: 15_000 })
  // mid-document, as a person scrolled there
  await scrollToPage(page, 30, -200)
  await expect(pageInfo(page)).toHaveText(`30 / ${PAGES}`)
  await expect(body(page).locator('[data-page="30"] canvas')).toBeVisible()
  await expect(thumb(page, 30).locator('canvas')).toBeVisible()
  await page.mouse.move(720, 500)
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${dir}/pdf-viewer-thumbnails-1440-light.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${dir}/pdf-viewer-thumbnails-1440-dark.png` })
  // closed by a click, so the next one opens as a tap would (no keyboard focus ring)
  await page.getByTestId('image-viewer-close').click()
  await expect(viewer(page)).toHaveCount(0)
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  await openChip(page, 'acme-60.pdf')
  await expect(drawn(body(page)).first()).toBeVisible({ timeout: 15_000 })
  await scrollToPage(page, 30, -100)
  await expect(body(page).locator('[data-page="30"] canvas')).toBeVisible()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${dir}/pdf-viewer-390-light.png` })
})
