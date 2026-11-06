// Settings > Apps on a computer (pages/Settings.tsx DesktopDownloads, components/settings/InstallGuide.tsx and
// InstallPictures.tsx): only this computer's desktop installer is in sight (a Mac never sees "Download for Windows" as
// its app; the other computer's installers are one folded line away), and without one the page points at installing
// it as an app, whose steps come with pictures that follow the browser (Chrome and Edge, Safari on a Mac; Firefox
// cannot install).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const UA = {
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
}
/** a Linux server that takes only the Windows app from the release feed */
const WINDOWS_ONLY = { items: [{ platform: 'windows', file: 'Trina-AX-Setup-0.3.0-x64.exe', version: '0.3.0', size: 114304798, signed: false }] }

async function open(page: Page, o: { installed?: boolean } = {}) {
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
const windowsLink = (page: Page) => page.getByRole('link', { name: /Windows용 내려받기/ })
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)

test.describe('a Mac in Chrome', () => {
  test.use({ userAgent: UA.macChrome })
  test('no Windows button in sight: one line points at installing it as an app, whose three steps have pictures; Windows is folded', async ({ page }) => {
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
    // the phones' steps are one line away
    await expect(dialog.getByTestId('install-guide-ios')).toHaveCount(0)
    await expect(dialog.getByTestId('install-guide-others')).toBeVisible()

    const none = dialog.getByTestId('desktop-none-here')
    await expect(none).toHaveText('이 서버에는 아직 Mac 앱이 없어요. 대신 위의 \'앱으로 설치\' 방법대로 이 컴퓨터에 앱처럼 설치할 수 있어요.')
    await expect(windowsLink(page)).toHaveCount(0)
    await dialog.getByTestId('desktop-others').locator('summary').click()
    await expect(windowsLink(page)).toBeVisible()
    await expect(windowsLink(page)).toHaveAttribute('href', '/downloads/Trina-AX-Setup-0.3.0-x64.exe')
    expect(await noOverflow(page)).toBe(true)
  })
  test('installed as an app already: no install steps and no pointer to them, still no Windows button in sight', async ({ page }) => {
    const dialog = await open(page, { installed: true })
    await expect(dialog.getByTestId('install-guide')).toContainText('앱으로 설치되어 실행 중이에요.')
    await expect(dialog.getByTestId('install-steps-chromium')).toHaveCount(0)
    await expect(dialog.getByTestId('desktop-none-here')).toHaveText('이 서버에는 아직 Mac 앱이 없어요.')
    await expect(windowsLink(page)).toHaveCount(0)
  })
  test('a phone-wide window: the pictures fit, nothing runs off the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const dialog = await open(page)
    await expect(dialog.getByTestId('install-steps-chromium').getByRole('listitem')).toHaveCount(3)
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
    await expect(windowsLink(page)).toHaveCount(0)
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
    // and no Mac app: the line does not send it to steps it cannot follow
    await expect(dialog.getByTestId('desktop-none-here')).toContainText('이 서버에는 아직 Mac 앱이 없어요')
    await expect(dialog.getByTestId('desktop-none-here')).not.toContainText('앱으로 설치')
  })
})

test.describe('a Windows PC in Edge', () => {
  test.use({ userAgent: UA.winEdge })
  test("its installer is in sight with its steps; the guide's last step is the taskbar", async ({ page }) => {
    const dialog = await open(page)
    await expect(windowsLink(page)).toBeVisible()
    await expect(dialog).toContainText('Windows의 PC 보호')
    await expect(dialog.getByTestId('desktop-others')).toHaveCount(0)
    await expect(dialog.getByTestId('desktop-none-here')).toHaveCount(0)
    const steps = dialog.getByTestId('install-steps-chromium').getByRole('listitem')
    await expect(steps.nth(2)).toContainText('작업 표시줄')
    // Safari's line is for Macs only
    await expect(dialog.getByTestId('install-guide-desktop')).not.toContainText('Safari')
  })
})
