// Phone previews fit the screen (QA TC-259), at 390×844 with touch: an HTML quotation drawn as a fixed 794 px page is
// fitted to the preview's width (in Files: the script frame; in a room: the static frame), with "실제 크기" to see it at
// its own size; a pinch inside the page or on a PDF zooms the document (the touches reach the viewer's own handlers);
// the point of a PDF under a two-finger pinch (2x, 2.5x) or a double tap stays under them; the PDF's zoom buttons are not
// there on a phone; and on a phone only .md / .txt offer 고치기, from the ⋯
// sheet. Computers are as before: at 1440 the page is at its own size (no fit, no bar) and the PDF keeps its buttons;
// a narrow window with a mouse is not fitted either and keeps the pencil for every editable kind.
// SHOTS_DIR=<folder>: screenshots of each step.
import { expect, test, type Page } from '@playwright/test'
import { makePagedPdf } from '../../../tests/lib/pdf'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })

const QUOTE = `<!doctype html><html><head><style>
body{margin:0;background:#eee}.page{width:794px;min-height:1123px;margin:0 auto;background:#fff;padding:48px;box-sizing:border-box;font-family:sans-serif}
table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:6px}.total{text-align:right;font-weight:bold}
</style></head><body><div class="page"><h1>견적서</h1><p>수신: 에이크미 주식회사</p>
<table><tr><th>품목</th><th>수량</th><th>단가</th><th>금액</th></tr><tr><td>웹 앱 개발</td><td>1</td><td>12,000,000</td><td>12,000,000</td></tr></table>
<p class="total" id="total">합계 12,000,000원</p></div></body></html>`

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png` })
}
/** the app's own zoom: 1 unless the browser zoomed the page around the viewer. A guard only: headless Chromium does not
 * zoom a page on this gesture even when nothing holds it back, so that the app stays put is for a real phone to show
 * (the viewers cancel a two-finger touchmove and Safari's gesture events, lib/usePinch.ts and lib/pageFit.ts). */
const appZoom = (page: Page) => page.evaluate(() => window.visualViewport?.scale ?? 1)

/** a real two-finger pinch at (x, y) in the page (Chromium's gesture: the browser's own zoom unless it is held back) */
async function pinch(page: Page, x: number, y: number, scale: number) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.synthesizePinchGesture', { x, y, scaleFactor: scale, relativeSpeed: 400, gestureSourceType: 'touch' })
  await cdp.detach()
}

/** a pinch by `scale` with two touch points (CDP touch events, what a phone sends) around (x, y), the fingers going
 * apart vertically in steps, then lifting */
async function touchPinch(page: Page, x: number, y: number, scale: number) {
  const cdp = await page.context().newCDPSession(page)
  const from = 60
  const at = (d: number) => [{ x, y: y - d / 2, id: 0 }, { x, y: y + d / 2, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) })
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(from * (1 + ((scale - 1) * i) / 8)) })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function putFiles(page: Page) {
  for (const data of [
    { path: 'sales/quote.html', text: QUOTE },
    { path: 'sales/memo.md', text: '# 메모\n\n견적서 보냈어요.' },
    { path: 'sales/notes.txt', text: '전화 메모' },
    { path: 'sales/price.csv', text: '품목,금액\n개발,12000000' },
    { path: 'sales/conf.json', text: '{ "rate": 12000000 }' },
  ]) expect((await page.request.post('/__test/file', { data })).ok()).toBeTruthy()
}
const openInFiles = async (page: Page, folder: string, name: string) => {
  await page.goto(`/files?path=${encodeURIComponent(folder)}`)
  await page.getByTestId('file-row').filter({ hasText: name }).getByRole('button').first().click()
  await expect(page.getByTestId('file-panel')).toBeVisible()
}

test('an HTML quotation from Files fits the phone, with 실제 크기; a pinch zooms the page, not the app', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await putFiles(page)
  await openInFiles(page, 'sales', 'quote.html')
  const panel = page.getByTestId('file-panel')
  const frame = panel.getByTestId('sandbox-frame')
  const f = page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]')
  await expect(f.locator('h1')).toHaveText('견적서')
  const bar = panel.getByTestId('page-fit-bar')
  await expect(bar).toHaveAttribute('data-zoom', 'fit')
  await expect(bar).toContainText('화면 너비에 맞췄어요')
  // the whole page is in view: its right edge (the total) is inside the frame
  const box = (await frame.boundingBox())!
  const fits = () => f.locator('.page').evaluate((el) => Math.round(el.getBoundingClientRect().right * Number(document.documentElement.style.zoom || 1)) <= document.documentElement.clientWidth + 1)
  await expect.poll(fits).toBe(true)
  expect(box.width).toBeLessThanOrEqual(390)
  await shot(page, 'files-html-fit-390')
  // 실제 크기: the page at 794 px, scrolled sideways
  await panel.getByTestId('page-fit-toggle').click()
  await expect(bar).toHaveAttribute('data-zoom', 'actual')
  await expect(panel.getByTestId('page-fit-toggle')).toHaveText('화면에 맞추기')
  await expect.poll(fits).toBe(false)
  await shot(page, 'files-html-actual-390')
  await panel.getByTestId('page-fit-toggle').click()
  await expect(bar).toHaveAttribute('data-zoom', 'fit')
  // a pinch inside the page: the page zooms, the app does not
  await pinch(page, box.x + box.width / 2, box.y + 200, 2)
  await expect(bar).toHaveAttribute('data-zoom', 'custom')
  expect(await appZoom(page)).toBe(1)
  await shot(page, 'files-html-pinched-390')
  // on a phone a page's raw source is not offered to edit
  await expect(panel.getByTestId('file-edit')).toBeHidden()
  await panel.getByTestId('file-panel-more').click()
  await expect(page.getByTestId('file-more-download')).toBeVisible()
  await expect(page.getByTestId('file-more-edit')).toHaveCount(0)
  await shot(page, 'files-html-more-sheet-390')
})

test('a PDF on a phone: no zoom buttons, a pinch zooms the pages, not the app; a double tap goes to 200 % and back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await openInFiles(page, 'docs', 'handbook.pdf')
  const panel = page.getByTestId('file-panel')
  const canvas = panel.locator('.react-pdf__Page').first()
  await expect(canvas).toBeVisible()
  await expect(panel.getByTestId('pdf-toolbar')).toBeHidden()
  const width = async () => Math.round((await canvas.boundingBox())!.width)
  const before = await width()
  const b = (await canvas.boundingBox())!
  await pinch(page, b.x + b.width / 2, b.y + 150, 1.8)
  await expect.poll(width).toBeGreaterThan(before * 1.4)
  expect(await appZoom(page)).toBe(1)
  // drawn again at the new width, the text under the fingers still in view
  await expect(panel.locator('.react-pdf__Page canvas').first()).toBeVisible()
  await expect(panel.locator('.react-pdf__Page__textContent').first()).toContainText('Handbook')
  await page.waitForTimeout(500)
  await shot(page, 'files-pdf-pinched-390')
  // a double tap: back to the width (it was zoomed in), then 200 %
  const tapAt = async () => {
    const c = (await panel.boundingBox())!
    await page.touchscreen.tap(c.x + 100, c.y + 300)
    await page.waitForTimeout(80)
    await page.touchscreen.tap(c.x + 100, c.y + 300)
  }
  await tapAt()
  await expect.poll(width).toBe(before)
  await tapAt()
  await expect.poll(width).toBeGreaterThan(before * 1.8)
  expect(await appZoom(page)).toBe(1)
})

test('a pinch on a PDF keeps the place under the fingers there, at 2x and 2.5x (QA TC-259)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const pages = Array.from({ length: 3 }, (_, i) => Array.from({ length: 40 }, (_, k) => `line ${k + 1} of page ${i + 1}: the quick brown fox jumps over the lazy dog`))
  expect((await page.request.post('/__test/file', { data: { path: 'docs/terms.pdf', base64: Buffer.from(makePagedPdf(pages)).toString('base64') } })).ok()).toBeTruthy()
  await openInFiles(page, 'docs', 'terms.pdf')
  const panel = page.getByTestId('file-panel')
  const first = panel.locator('[data-page="1"]')
  await expect(first.locator('canvas')).toBeVisible()
  const width = async () => Math.round((await first.boundingBox())!.width)
  const fitted = await width()
  /** the place on the pages at client y: a page and how far down it (0 to 1) */
  const placeAt = (y: number) =>
    panel.locator('[data-page]').evaluateAll((els, y) => {
      for (const el of els) {
        const r = el.getBoundingClientRect()
        if (y >= r.top && y < r.bottom) return { page: Number((el as HTMLElement).dataset.page), at: (y - r.top) / r.height }
      }
      return null
    }, y)
  /** where that place is now, in client y */
  const yOf = (p: { page: number; at: number }) => panel.locator(`[data-page="${p.page}"]`).evaluate((el, at) => { const r = el.getBoundingClientRect(); return r.top + at * r.height }, p.at)
  const zoomKeeps = async (y: number, zoom: () => Promise<void>, want: number, name: string) => {
    const place = (await placeAt(y))!
    expect(place).not.toBeNull()
    await zoom()
    // drawn at the new width (the placeholder's own width: a pinch's live transform is gone then)
    await expect.poll(() => first.evaluate((el) => (el as HTMLElement).offsetWidth)).toBeGreaterThan(fitted * want * 0.95)
    // the same line of the page under the fingers (the finding: ~500 px lower at 2x, ~1,000 at 2.5x)
    await expect.poll(async () => Math.abs((await yOf(place)) - y)).toBeLessThan(30)
    await shot(page, name)
  }
  const x = (await panel.boundingBox())!.x + 195
  // on page 1, at about its 12th line
  await zoomKeeps(300, () => touchPinch(page, x, 300, 2), 2, 'files-pdf-pinch-2x-390')
  // back to the width with a double tap, then 2.5x lower on the screen
  await page.touchscreen.tap(x, 400)
  await page.waitForTimeout(80)
  await page.touchscreen.tap(x, 400)
  await expect.poll(width).toBe(fitted)
  await page.waitForTimeout(300)
  await zoomKeeps(500, () => touchPinch(page, x, 500, 2.5), 2.5, 'files-pdf-pinch-2_5x-390')
  // a double tap keeps its place too: back to the width, then 200 % around another point
  await page.touchscreen.tap(x, 400)
  await page.waitForTimeout(80)
  await page.touchscreen.tap(x, 400)
  await expect.poll(width).toBe(fitted)
  await page.waitForTimeout(300)
  await zoomKeeps(
    350,
    async () => {
      await page.touchscreen.tap(x, 350)
      await page.waitForTimeout(80)
      await page.touchscreen.tap(x, 350)
    },
    2,
    'files-pdf-double-tap-390',
  )
  expect(await appZoom(page)).toBe(1)
})

test('on a phone only .md and .txt offer 고치기, from the ⋯ sheet', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await putFiles(page)
  for (const [name, editable] of [['memo.md', true], ['notes.txt', true], ['price.csv', false], ['conf.json', false]] as const) {
    await openInFiles(page, 'sales', name)
    const panel = page.getByTestId('file-panel')
    await expect(panel.getByTestId('file-edit')).toBeHidden()
    await panel.getByTestId('file-panel-more').click()
    await expect(page.getByTestId('file-more-download')).toBeVisible()
    await expect(page.getByTestId('file-more-edit')).toHaveCount(editable ? 1 : 0)
    if (name === 'memo.md') {
      await shot(page, 'files-md-more-sheet-390')
      await page.getByTestId('file-more-edit').click()
      await expect(panel.getByTestId('file-editor')).toHaveValue(/견적서 보냈어요/)
      await shot(page, 'files-md-editing-390')
    } else await page.keyboard.press('Escape')
  }
})

test('an HTML quotation sent in a room fits the phone too (the static frame)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const BEN = { id: 'ben', name: '벤' }
  const fileId = '019a5f00-0000-7000-8000-000000000901'
  await routeRoom(page, {
    members: [BEN],
    kind: 'team',
    messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '견적서예요', extra: { files: [{ id: fileId, name: 'quote.html', size: QUOTE.length, mime: 'text/html', kind: 'text', thumb: false }] } }],
  })
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, (route) => route.fulfill({
    status: 200,
    body: QUOTE,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'inline; filename="quote.html"', 'x-content-type-options': 'nosniff' },
  }))
  await page.goto(`/rooms/${ROOM_ID}`)
  await page.getByTestId('room-scroller').getByTestId('room-file').filter({ hasText: 'quote.html' }).getByTestId('room-file-open').click()
  const viewer = page.getByTestId('image-viewer')
  const bar = viewer.getByTestId('page-fit-bar')
  await expect(bar).toHaveAttribute('data-zoom', 'fit')
  const frame = viewer.locator('iframe').first()
  const f = frame.contentFrame()
  await expect(f.locator('h1')).toHaveText('견적서')
  await expect.poll(() => f.locator('.page').evaluate((el) => Math.round(el.getBoundingClientRect().right * Number(document.documentElement.style.zoom || 1)) <= document.documentElement.clientWidth + 1)).toBe(true)
  await shot(page, 'room-html-fit-390')
  await viewer.getByTestId('page-fit-toggle').click()
  await expect(bar).toHaveAttribute('data-zoom', 'actual')
  await shot(page, 'room-html-actual-390')
  const box = (await frame.boundingBox())!
  await pinch(page, box.x + box.width / 2, box.y + 200, 1.6)
  await expect(bar).toHaveAttribute('data-zoom', 'custom')
  expect(await appZoom(page)).toBe(1)
})

test.describe('computer', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false })
  test('at 1440 the PDF keeps its zoom buttons and an .html file keeps its pencil', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await putFiles(page)
    await openInFiles(page, 'sales', 'quote.html')
    const panel = page.getByTestId('file-panel')
    await expect(page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]').locator('h1')).toHaveText('견적서')
    await expect(panel.getByTestId('file-edit')).toBeVisible()
    // not fitted on a computer: no bar, the page at its own 794 px (wider than the ~660 px panel: it scrolls sideways)
    const f = page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]')
    await expect(f.locator('.page')).toHaveCount(1)
    await page.waitForTimeout(500)
    await expect(panel.getByTestId('page-fit-bar')).toHaveCount(0)
    expect(await f.locator('.page').evaluate((el) => ({ zoom: document.documentElement.style.zoom, width: Math.round(el.getBoundingClientRect().width) }))).toEqual({ zoom: '', width: 794 })
    await shot(page, 'files-html-1440')
    await openInFiles(page, 'docs', 'handbook.pdf')
    await expect(panel.getByTestId('pdf-toolbar')).toBeVisible()
    await panel.getByTestId('pdf-zoom-in').click()
    await expect(panel.getByTestId('pdf-zoom-level')).toHaveText('125%')
    await shot(page, 'files-pdf-1440')
  })

  test.describe('narrow window with a mouse', () => {
    test.use({ viewport: { width: 600, height: 900 } })
    test('the page is not fitted and the pencil stays, for .html too', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await putFiles(page)
      await openInFiles(page, 'sales', 'quote.html')
      const panel = page.getByTestId('file-panel')
      const f = page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]')
      await expect(f.locator('h1')).toHaveText('견적서')
      await page.waitForTimeout(500)
      await expect(panel.getByTestId('page-fit-bar')).toHaveCount(0)
      expect(await f.locator('html').evaluate((el) => (el as HTMLElement).style.zoom)).toBe('')
      await expect(panel.getByTestId('file-edit')).toBeVisible()
      // and no second edit in the ⋯ menu (that is a touch screen's)
      await panel.getByTestId('file-panel-more').click()
      await expect(page.getByTestId('file-more-download')).toBeVisible()
      await expect(page.getByTestId('file-more-edit')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await openInFiles(page, 'sales', 'memo.md')
      await expect(panel.getByTestId('file-edit')).toBeVisible()
      await panel.getByTestId('file-panel-more').click()
      await expect(page.getByTestId('file-more-download')).toBeVisible()
      await expect(page.getByTestId('file-more-edit')).toHaveCount(0)
      await shot(page, 'files-narrow-mouse-600')
    })
  })

  test.describe('wide touch screen (a tablet)', () => {
    test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true })
    test('the pencil (no ⋯ menu) for .md and .html; the page is not fitted', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await putFiles(page)
      await openInFiles(page, 'sales', 'memo.md')
      const panel = page.getByTestId('file-panel')
      await expect(panel.getByTestId('file-edit')).toBeVisible()
      // wide: the ⋯ menu (a phone's) is not there, the header's buttons are
      await expect(panel.getByTestId('file-panel-more')).toBeHidden()
      await openInFiles(page, 'sales', 'quote.html')
      await expect(page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]').locator('h1')).toHaveText('견적서')
      await page.waitForTimeout(500)
      await expect(panel.getByTestId('page-fit-bar')).toHaveCount(0)
      await expect(panel.getByTestId('file-edit')).toBeVisible()
    })
  })
})
