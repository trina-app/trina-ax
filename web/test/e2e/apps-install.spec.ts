// Settings > Apps (pages/Settings.tsx, components/settings/AppList.tsx, InstallGuide.tsx and InstallPictures.tsx): the
// team address, then every phone and desktop app with one way to get it (the edition's store listings and download page,
// APP_DOWNLOADS, and the team server's installers: a fixture here), then, in a web browser, how to install the page as an
// app, whose steps come with pictures that follow the browser (Chrome and Edge, Safari on a Mac; Firefox cannot
// install). No link is followed: the store pages are never fetched.
import { expect, test, type Page } from '@playwright/test'
import { APP_DOWNLOADS } from '@mycel/shared'
import { reset, signIn } from './helpers'

const UA = {
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  macDesktopApp: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) TrinaAX/0.4.0 Chrome/142.0.0.0 Electron/39.0.0 Safari/537.36',
}
/** a Linux server that takes only the Windows app from the release feed */
const WINDOWS_ONLY = { items: [{ platform: 'windows', file: 'Trina-AX-Setup-0.3.0-x64.exe', version: '0.3.0', size: 114304798, signed: false }] }

async function open(page: Page, o: { installed?: boolean; macAppStore?: boolean; phoneApp?: 'ios' | 'android' } = {}) {
  // the Mac App Store build's desktop bridge, as far as this page reads it (the store flag)
  if (o.macAppStore) await page.addInitScript(() => {
    const noop = () => {}
    ;(window as unknown as { mycelDesktop: unknown }).mycelDesktop = {
      bridgeVersion: 1, appVersion: '0.4.0', platform: 'darwin', store: true,
      browser: { run: async () => ({ ok: false, content: [] }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      connection: { get: async () => ({ route: 'remote', origin: location.origin, teamAddress: location.origin, fingerprintMismatch: false }), onChange: () => noop },
      notify: noop, openTeams: noop, setLocale: noop,
    }
  })
  // the phone app's WebView bridge (mobile/src/protocol.ts), answering nothing
  if (o.phoneApp) await page.addInitScript((platform) => {
    const w = window as unknown as { mycelMobile: unknown; ReactNativeWebView: { postMessage(raw: string): void } }
    w.mycelMobile = { protocol: 1, appVersion: '1.0.2', platform, generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1'] }
    w.ReactNativeWebView = { postMessage() {} }
  }, o.phoneApp)
  if (o.installed) await page.addInitScript(() => {
    const orig = window.matchMedia.bind(window)
    window.matchMedia = (q: string) => (q.includes('display-mode: standalone') ? { matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as unknown as MediaQueryList : orig(q))
  })
  await page.route('**/downloads/index.json', (r) => r.fulfill({ json: WINDOWS_ONLY }))
  await reset(page)
  await signIn(page)
  await page.goto('/settings/apps')
  return page.getByTestId('settings-dialog')
}
const windowsLink = (page: Page) => page.getByTestId('app-file-windows')
const y = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())!.y
/** where a phone's row leads: its store listing, else the download page */
const phoneHref = (os: 'iphone' | 'android') => APP_DOWNLOADS[os] || APP_DOWNLOADS.page
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

test.describe('a Mac in Chrome', () => {
  test.use({ userAgent: UA.macChrome })
  test('every app with one way to get it: the phones with one QR code, this Mac marked, the Windows installer', async ({ page }) => {
    test.skip(!APP_DOWNLOADS.page || !APP_DOWNLOADS.iphone || !APP_DOWNLOADS.mac, 'an edition without store links')
    const dialog = await open(page)
    const phones = dialog.getByTestId('apps-phone')
    await expect(phones.getByTestId('app-link-iphone')).toHaveAttribute('href', APP_DOWNLOADS.iphone)
    await expect(phones.getByTestId('app-link-iphone')).toHaveAttribute('target', '_blank')
    await expect(phones.getByTestId('app-link-android')).toHaveAttribute('href', phoneHref('android'))
    await expect(dialog.getByTestId('apps-phone-qr').getByRole('img', { name: '앱 받기 QR 코드' })).toBeVisible()
    const mac = dialog.getByTestId('app-row-mac')
    await expect(mac).toContainText('이 컴퓨터용')
    await expect(mac.getByTestId('app-link-mac')).toHaveAttribute('href', APP_DOWNLOADS.mac)
    await expect(dialog.getByTestId('desktop-none-here')).toHaveCount(0)
    // Windows is its own row: its installer from the team server, without the steps (they are for a Windows PC)
    await expect(windowsLink(page)).toHaveAttribute('href', '/downloads/Trina-AX-Setup-0.3.0-x64.exe')
    await expect(windowsLink(page)).toContainText('내려받기 · v0.3.0')
    await expect(dialog).not.toContainText('Windows의 PC 보호')
    // the team address on top, the apps, then installing the page as an app
    expect(await y(page, 'apps-phone')).toBeLessThan(await y(page, 'apps-computer'))
    expect(await y(page, 'apps-computer')).toBeLessThan(await y(page, 'install-guide-desktop'))
    expect(await noOverflow(page)).toBe(true)
  })
  test("the install guide's three steps have pictures that follow the browser; the phones' steps are one line away", async ({ page }) => {
    const dialog = await open(page)
    const guide = dialog.getByTestId('install-guide-desktop')
    await expect(guide).toHaveAttribute('data-flow', 'chromium')
    await expect(guide).toContainText('이 기기')
    const steps = guide.getByTestId('install-steps-chromium').getByRole('listitem')
    await expect(steps).toHaveCount(3)
    for (const step of await steps.all()) await expect(step.locator('[aria-hidden="true"]').first()).toBeVisible()
    await expect(steps.nth(0)).toContainText('주소창 오른쪽 끝의 설치 아이콘')
    await expect(steps.nth(2)).toContainText('Dock')
    // the pictures repeat the captions: nothing in them is read out
    await expect(guide.getByTestId('install-steps-chromium').locator('li > div').first()).toHaveAttribute('aria-hidden', 'true')
    // Safari's way, in one line, on a Mac
    await expect(guide).toContainText('Safari에서는 파일 → Dock에 추가')
    await expect(dialog.getByTestId('install-guide-ios')).toHaveCount(0)
    await expect(dialog.getByTestId('install-guide-others')).toBeVisible()
  })
  test('installed as an app already: no install steps', async ({ page }) => {
    const dialog = await open(page, { installed: true })
    await expect(dialog.getByTestId('install-guide')).toContainText('앱으로 설치되어 실행 중이에요.')
    await expect(dialog.getByTestId('install-steps-chromium')).toHaveCount(0)
  })
  test('a phone-wide window: the rows, the QR code and the pictures fit, nothing runs off the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const dialog = await open(page)
    await expect(dialog.getByTestId('install-steps-chromium').getByRole('listitem')).toHaveCount(3)
    for (const id of ['app-row-iphone', 'app-row-mac', 'app-row-windows']) {
      const box = (await dialog.getByTestId(id).boundingBox())!
      expect(box.x + box.width, id).toBeLessThanOrEqual(390)
    }
    expect(await noOverflow(page)).toBe(true)
  })
})

test.describe('a Mac in Safari', () => {
  test.use({ userAgent: UA.macSafari })
  test("Safari's own steps: File → Add to Dock…, Add, then the Dock", async ({ page }) => {
    const dialog = await open(page)
    const guide = dialog.getByTestId('install-guide-desktop')
    await expect(guide).toHaveAttribute('data-flow', 'safari')
    await expect(guide.getByRole('heading')).toContainText('Mac (Safari)')
    const steps = guide.getByTestId('install-steps-safari').getByRole('listitem')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0)).toContainText('파일 → Dock에 추가…')
    await expect(steps.nth(1)).toContainText('추가를 누르세요')
    await expect(guide).toContainText('macOS Sonoma(14) 이상')
  })
})

test.describe('a Mac in Firefox', () => {
  test.use({ userAgent: UA.macFirefox })
  test('says this browser cannot install it and names the ones that can', async ({ page }) => {
    const dialog = await open(page)
    await expect(dialog.getByTestId('install-browser-cannot')).toHaveText('이 브라우저에서는 앱으로 설치할 수 없어요. Chrome, Edge 또는 Safari에서 이 페이지를 여세요.')
    // only that line: no steps, pictures or install-icon note that would not work here
    await expect(dialog.getByTestId('install-steps-chromium')).toHaveCount(0)
    await expect(dialog.getByTestId('install-steps-safari')).toHaveCount(0)
    await expect(dialog.getByTestId('install-guide-desktop')).not.toContainText('설치 아이콘')
    // no line here sends it to steps it cannot follow
    await expect(dialog.getByTestId('apps-computer')).not.toContainText('앱으로 설치')
  })
})

test.describe('a Windows PC in Edge', () => {
  test.use({ userAgent: UA.winEdge })
  test("its installer is in sight with its steps; the guide's last step is the taskbar", async ({ page }) => {
    const dialog = await open(page)
    await expect(windowsLink(page)).toBeVisible()
    await expect(dialog.getByTestId('app-row-windows')).toContainText('이 컴퓨터용')
    await expect(dialog).toContainText('Windows의 PC 보호')
    await expect(dialog.getByTestId('desktop-none-here')).toHaveCount(0)
    const steps = dialog.getByTestId('install-steps-chromium').getByRole('listitem')
    await expect(steps.nth(2)).toContainText('작업 표시줄')
    // Safari's line is for Macs only
    await expect(dialog.getByTestId('install-guide-desktop')).not.toContainText('Safari')
  })
})

test.describe('an iPhone in Safari', () => {
  test.use({ userAgent: UA.iphoneSafari, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test("only the iPhone's App Store, no QR code; the computers' apps follow", async ({ page }) => {
    test.skip(!APP_DOWNLOADS.iphone && !APP_DOWNLOADS.page, 'an edition without phone links')
    const dialog = await open(page)
    await expect(dialog.getByTestId('app-link-iphone')).toHaveAttribute('href', phoneHref('iphone'))
    await expect(dialog.getByTestId('app-row-android')).toHaveCount(0)
    await expect(dialog.getByTestId('apps-phone-qr')).toHaveCount(0)
    await expect(dialog.getByTestId('apps-phone').getByRole('img')).toHaveCount(0)
    await expect(windowsLink(page)).toBeVisible()
    expect(await noOverflow(page)).toBe(true)
  })
})

test.describe('the Mac App Store build', () => {
  test.use({ userAgent: UA.macDesktopApp })
  test('this Mac\'s row is "This app", updated by the App Store; no installer file; no other phone platform named', async ({ page }) => {
    const dialog = await open(page, { macAppStore: true })
    const mac = dialog.getByTestId('app-row-mac')
    await expect(mac).toContainText('이 앱')
    await expect(mac).toContainText('이 앱은 Mac App Store에서 설치했어요. 업데이트도 App Store에서 받아요.')
    await expect(mac.getByRole('link')).toHaveCount(0)
    await expect(dialog.locator('a[href^="/downloads/"]')).toHaveCount(0)
    if (APP_DOWNLOADS.page || APP_DOWNLOADS.windows) await expect(dialog.getByTestId('app-link-windows')).toHaveAttribute('href', APP_DOWNLOADS.windows || APP_DOWNLOADS.page)
    // App Review 2.3.10: an Apple app names no other mobile platform; the QR code leads to the page that has it
    await expect(dialog).not.toContainText('Android')
    if (APP_DOWNLOADS.iphone) await expect(dialog.getByTestId('app-link-iphone')).toHaveAttribute('href', APP_DOWNLOADS.iphone)
    if (APP_DOWNLOADS.page) await expect(dialog.getByTestId('apps-phone-qr')).toBeVisible()
    // the desktop app is already an app: no install guide
    await expect(dialog.getByTestId('install-guide')).toHaveCount(0)
  })
})

test.describe('the iPhone app', () => {
  test.use({ userAgent: UA.iphoneSafari, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the phones collapse to "This app"; the computers stay', async ({ page }) => {
    const dialog = await open(page, { phoneApp: 'ios' })
    const phones = dialog.getByTestId('apps-phone')
    await expect(phones.getByRole('listitem')).toHaveCount(1)
    await expect(phones.getByTestId('app-row-iphone')).toContainText('이 앱')
    await expect(phones.getByRole('link')).toHaveCount(0)
    await expect(windowsLink(page)).toBeVisible()
    await expect(dialog.getByTestId('install-guide')).toHaveCount(0)
  })
})
