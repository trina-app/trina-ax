// No zoom of the whole page in the phone app and the installed app (QA TC-246, part 1), at 390×844 with touch. The
// owner, on his iPhone: "모바일 기기에서 그냥 줌인하면 어떤 페이지든지 그냥 줌인되어 버리는 것도 해결해. 그리고 사진 볼 때는
// 줌인하면 실제 그 뷰 안에서만 줌인되어야 하고."
// - In the phone app (its bridge stubbed as the app installs it, lib/mobile.ts) and the installed web app (an iPhone's
//   Home Screen, navigator.standalone), on every page: the viewport meta holds the scale at 1 (maximum-scale=1,
//   user-scalable=no; viewport-fit=cover kept) and the root's touch-action is pan-x pan-y (lib/pageZoom.ts, index.css).
// - The app's bridge coming after the page loaded turns it on then.
// - A plain phone browser tab keeps the browser's own zoom (accessibility): the meta and the root as they were.
// - The picture viewer zooms on its own: its stage has touch-action none (data-own-zoom), a double tap zooms the picture
//   inside the stage, the bar stays where it was, the page's scale stays 1; in Chromium two touch points zoom it too.
// - A PDF's own pinch (QA TC-259, lib/usePinch.ts) still zooms its pages in the app (Chromium).
// Playwright makes no real pinch: that the page itself no longer scales under two fingers is for a phone to show (the
// PR lists the checks). Run in Chromium (Android's engine, phone-page-zoom.spec.ts) and WebKit (the iPhone's,
// phone-page-zoom.webkit.spec.ts). SHOTS_DIR=<folder>: screenshots.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

const BASE = 'width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content'
const HELD = `${BASE}, maximum-scale=1, user-scalable=no`

/** the phone app's bridge, as the app installs it before the page's own scripts (react-native-webview's object) and
 * after it loaded (mycelMobile) */
const phoneApp = (page: Page) => page.addInitScript(() => {
  const w = window as unknown as { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void } }
  w.mycelMobile = { protocol: 1, appVersion: '0.3.0', platform: 'ios', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', 'push-permission-v1'] }
  w.ReactNativeWebView = { postMessage(raw) {
    const m = JSON.parse(raw) as MobileMessage
    const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true, ...('seq' in m ? { seq: m.seq } : {}) }
    if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
  } }
})
/** opened from an iPhone's Home Screen */
const homeScreenApp = (page: Page) => page.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true })
})

const viewportMeta = (page: Page) => page.locator('meta[name="viewport"]').getAttribute('content')
const rootTouchAction = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).touchAction)
const pageScale = (page: Page) => page.evaluate(() => window.visualViewport?.scale ?? 1)
const shot = async (page: Page, name: string) => {
  const dir = process.env.SHOTS_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

/** the page holds its zoom: the meta, the root's mark and touch-action */
async function expectHeld(page: Page) {
  await expect.poll(() => viewportMeta(page)).toBe(HELD)
  await expect(page.locator('html')).toHaveAttribute('data-page-zoom', 'off')
  expect(await rootTouchAction(page)).toBe('pan-x pan-y')
}

const PIC_ID = '019a5f00-0000-7000-8000-000000000901'
const ICON = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/icons/icon-512.png'))
/** a room with Ben's 512 px picture, its file served as the team server does */
async function openRoomWithPicture(page: Page) {
  const BEN = { id: 'ben', name: '벤' }
  await routeRoom(page, {
    members: [BEN], kind: 'team',
    messages: [{ id: '019a5f00-0000-7000-8000-000000000001', author: BEN, body: '사진 봐 주세요', extra: { files: [{ id: PIC_ID, name: 'logo.png', size: ICON.length, mime: 'image/png', kind: 'image', width: 512, height: 512, thumb: true }] } }],
  })
  await page.route(/\/api\/rooms\/[^/]+\/files\/[^/?]+/, (route) => route.fulfill({
    status: 200, body: ICON,
    headers: { 'content-type': 'image/png', 'content-disposition': 'inline; filename="logo.png"', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" },
  }))
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
}

export function pageZoomCases() {
  test('the phone app: every page holds its zoom (viewport meta, root touch-action); the picture viewer zooms inside itself', async ({ page }) => {
    await reset(page)
    await phoneApp(page)
    await signIn(page)
    await expectHeld(page)
    await shot(page, 'app-home-390')
    for (const to of ['/files', '/rooms', '/settings']) {
      await page.goto(to)
      await expectHeld(page)
    }

    // the picture viewer: its stage takes the gestures itself
    await openRoomWithPicture(page)
    await expectHeld(page)
    await page.getByTestId('room-image').first().tap()
    const viewer = page.getByTestId('image-viewer')
    await expect(page.getByTestId('image-viewer-original')).toHaveAttribute('data-state', 'shown')
    const stage = page.getByTestId('image-viewer-stage')
    await expect(stage).toHaveAttribute('data-own-zoom', '')
    expect(await stage.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none')
    const bar = page.getByTestId('image-viewer-bar')
    await expect(bar).toBeVisible()
    const barBefore = (await bar.boundingBox())!
    const stageBefore = (await stage.boundingBox())!
    // a double tap on the picture zooms the picture, inside the stage
    const pic = (await page.getByTestId('image-viewer-original').boundingBox())!
    const at = { x: pic.x + pic.width / 2, y: pic.y + pic.height / 2 }
    await page.touchscreen.tap(at.x, at.y)
    await page.touchscreen.tap(at.x, at.y)
    await expect(viewer).toHaveAttribute('data-zoomed', '')
    await expect(bar).toBeVisible()
    expect(await bar.boundingBox()).toEqual(barBefore)
    expect(await stage.boundingBox()).toEqual(stageBefore)
    expect(await pageScale(page)).toBe(1)
    await shot(page, 'app-viewer-zoomed-390')
    // and back
    await page.waitForTimeout(350)
    await page.touchscreen.tap(at.x, at.y)
    await page.touchscreen.tap(at.x, at.y)
    await expect(viewer).not.toHaveAttribute('data-zoomed', '')
    expect(await pageScale(page)).toBe(1)
  })

  test('the phone app: two fingers on a picture zoom the picture, not the page (Chromium\'s touch points)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'touch points through CDP: Chromium only')
    await reset(page)
    await phoneApp(page)
    await signIn(page)
    await openRoomWithPicture(page)
    await page.getByTestId('room-image').first().tap()
    await expect(page.getByTestId('image-viewer-original')).toHaveAttribute('data-state', 'shown')
    const bar = page.getByTestId('image-viewer-bar')
    const barBefore = (await bar.boundingBox())!
    const pic = (await page.getByTestId('image-viewer-original').boundingBox())!
    const x = pic.x + pic.width / 2, y = pic.y + pic.height / 2
    // two fingers 60 px apart going to 150 px apart, then lifting
    const cdp = await page.context().newCDPSession(page)
    const at = (d: number) => [{ x, y: y - d / 2, id: 0 }, { x, y: y + d / 2, id: 1 }]
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(60) })
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(60 + (90 * i) / 8) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await expect(page.getByTestId('image-viewer')).toHaveAttribute('data-zoomed', '')
    const zoomed = (await page.getByTestId('image-viewer-original').boundingBox())!
    expect(zoomed.width).toBeGreaterThan(pic.width * 2)
    expect(await bar.boundingBox()).toEqual(barBefore)
    expect(await pageScale(page)).toBe(1)
    await shot(page, 'app-viewer-pinched-390')
  })

  test('the phone app: a PDF\'s own pinch still zooms its pages under the root\'s touch-action (QA TC-259 kept)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'a synthesized pinch through CDP: Chromium only')
    await reset(page)
    await phoneApp(page)
    await signIn(page)
    await page.goto(`/files?path=${encodeURIComponent('docs')}`)
    await page.getByTestId('file-row').filter({ hasText: 'handbook.pdf' }).getByRole('button').first().click()
    const pdf = page.getByTestId('file-panel').locator('.react-pdf__Page').first()
    await expect(pdf).toBeVisible()
    await expectHeld(page)
    const width = async () => Math.round((await pdf.boundingBox())!.width)
    const before = await width()
    const b = (await pdf.boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.synthesizePinchGesture', { x: b.x + b.width / 2, y: b.y + 150, scaleFactor: 1.8, relativeSpeed: 400, gestureSourceType: 'touch' })
    await cdp.detach()
    await expect.poll(width).toBeGreaterThan(before * 1.4)
    expect(await pageScale(page)).toBe(1)
  })

  test('the app\'s bridge after the page loaded: held from then on', async ({ page }) => {
    await reset(page)
    await signIn(page)
    expect(await viewportMeta(page)).toBe(BASE)
    await page.evaluate(() => {
      const w = window as unknown as { ReactNativeWebView: { postMessage(raw: string): void } }
      w.ReactNativeWebView = { postMessage() {} }
      window.dispatchEvent(new Event('mycel:mobile-ready'))
    })
    await expectHeld(page)
  })

  test('the installed app (an iPhone\'s Home Screen): held', async ({ page }) => {
    await reset(page)
    await homeScreenApp(page)
    await signIn(page)
    await expectHeld(page)
  })

  test('a plain phone browser tab: the browser\'s own zoom stays (accessibility); the viewer\'s stage still takes its gestures', async ({ page }) => {
    await reset(page)
    await signIn(page)
    expect(await viewportMeta(page)).toBe(BASE)
    await expect(page.locator('html')).not.toHaveAttribute('data-page-zoom', /.*/)
    expect(await rootTouchAction(page)).toBe('auto')
    await openRoomWithPicture(page)
    expect(await viewportMeta(page)).toBe(BASE)
    await page.getByTestId('room-image').first().tap()
    await expect(page.getByTestId('image-viewer-original')).toHaveAttribute('data-state', 'shown')
    expect(await page.getByTestId('image-viewer-stage').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none')
  })
}
