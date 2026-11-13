// Android Back after 나 (QA TC-404): 트리나 → 나 → 프로젝트 (or 대화) in 나's own tab bar → Back left the app. The page
// skipped telling the app where Back goes on 프로젝트's root (the same answer as 나's root: no Back, not home), and
// (since the tabs 트리나 · 대화 · 파일 · 나 the projects are a page of 트리나, so 파일 is the other tab's root checked here)
// Android's app forgets what it heard when the WebView reports some same-document moves as a load start
// (mobile/App.tsx onLoadStart), so it fell back to the WebView's history and left. The page now tells the app again on
// every screen. A fake app bridge records each `nav` with its path; the app's own decision (mobile/src/nav.ts backAction)
// is run on the last one, as if the app had just forgotten everything before it. Run in Chromium (Android's engine:
// phone-back-after-me.spec.ts) and WebKit (phone-back-after-me.webkit.spec.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { openTab } from './nav'
import { backAction } from '../../../mobile/src/nav'
import type { MobileConfig, MobileMessage, MobileReply } from '../../../mobile/src/protocol'

type Nav = { path: string; canGoBack: boolean; home: boolean }
type Win = { mycelMobile: MobileConfig; ReactNativeWebView: { postMessage(raw: string): void }; navs: Nav[] }

/** The phone app with nav-v1: answers every request (so the page's sends are not held), records each `nav`. */
async function app(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Win
    w.mycelMobile = { protocol: 1, appVersion: '1.0.5', platform: 'android', generation: 1, nonce: 'a'.repeat(64), capabilities: ['file-share-v1', 'external-oauth-v1', 'nav-v1'] }
    w.navs = []
    w.ReactNativeWebView = { postMessage(raw) {
      const m = JSON.parse(raw) as MobileMessage & { canGoBack?: boolean; home?: boolean }
      if (m.type === 'nav') w.navs.push({ path: location.pathname, canGoBack: !!m.canGoBack, home: !!m.home })
      const reply: MobileReply = { v: 1, type: 'mobile-result', id: m.id, nonce: m.nonce, generation: m.generation, for: m.type, ok: true }
      if (m.type === 'session-reset') { w.mycelMobile = { ...w.mycelMobile, generation: m.generation + 1 }; reply.nextGeneration = m.generation + 1 }
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('mycel:mobile', { detail: reply })))
    } }
  })
}
const navs = (page: Page) => page.evaluate(() => (window as unknown as Win).navs)
/** The last `nav` the page sent, once it is about `path`. */
async function lastNav(page: Page, path: string): Promise<Nav> {
  await expect.poll(async () => (await navs(page)).at(-1)?.path).toBe(path)
  return (await navs(page)).at(-1)!
}
/** What Android's Back does with only the last `nav` heard (the app forgot what came before): 'start-tab' expected. */
const androidBack = (n: Nav) => backAction({ canGoBack: n.canGoBack, home: n.home }, false)
/** A tab in the bar on show (나 has its own copy of the bar in its dialog). */
const tab = (page: Page, id: string) => page.locator(`[data-testid="tab-${id}"]:visible`).last()

export function backAfterMeCases() {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' })

  test.beforeEach(async ({ page }) => {
    await reset(page)
    await app(page)
    await signIn(page)
    // signIn leaves a phone on the new-chat box (/new, no tab bar): its ‹ to 트리나's root, the list (`/`)
    await openTab(page, 'ai')
    await expect(page).toHaveURL(/\/$/)
    await lastNav(page, '/')
  })

  for (const [id, path] of [['files', '/files'], ['chats', '/rooms']] as const) {
    test(`트리나 → 나 → ${id} in 나's bar: its root tells the app again, so Back goes to 트리나`, async ({ page }) => {
      await tab(page, 'me').click()
      await expect(page).toHaveURL(/\/settings$/)
      expect(await lastNav(page, '/settings')).toMatchObject({ canGoBack: false, home: false })
      await tab(page, id).click()
      await expect(page).toHaveURL(new RegExp(`${path}$`))
      // the same answer as 나's root, but sent again for this screen
      const here = await lastNav(page, path)
      expect(here).toMatchObject({ canGoBack: false, home: false })
      expect(androidBack(here)).toBe('start-tab')
      // the app's start-tab script: 트리나's root, which leaves the app on the next Back
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('mycel:start-tab')))
      await expect(page).toHaveURL(/\/$/)
      const home = await lastNav(page, '/')
      expect(home).toMatchObject({ canGoBack: false, home: true })
      expect(androidBack(home)).toBe('exit')
    })
  }

  test('나 › 보안 → Back → 나 → 파일: still tells the app, Back goes to 트리나', async ({ page }) => {
    await tab(page, 'me').click()
    await expect(page).toHaveURL(/\/settings$/)
    await page.getByTestId('settings-dialog').getByText(/^(Security & devices|보안·기기)$/).first().click()
    await expect(page).toHaveURL(/\/settings\/security/)
    expect(androidBack(await lastNav(page, '/settings/security'))).toBe('back')
    await page.goBack()
    await expect(page).toHaveURL(/\/settings$/)
    await tab(page, 'files').click()
    await expect(page).toHaveURL(/\/files$/)
    expect(androidBack(await lastNav(page, '/files'))).toBe('start-tab')
  })

  test('as before: 트리나 → 파일 → Back goes to 트리나', async ({ page }) => {
    await tab(page, 'files').click()
    await expect(page).toHaveURL(/\/files$/)
    expect(androidBack(await lastNav(page, '/files'))).toBe('start-tab')
  })

  test('트리나 → 모든 프로젝트: a page of 트리나, so Back goes back to its list', async ({ page }) => {
    // a fresh team has no project yet: the list's row is "+ 새 프로젝트" (/projects?new=1), the projects page all the same
    await page.getByTestId('phone-trina-home').getByTestId('trina-all-projects').or(page.getByTestId('phone-trina-home').getByTestId('trina-new-project')).first().click()
    await expect(page).toHaveURL(/\/projects(\?|$)/)
    expect(androidBack(await lastNav(page, '/projects'))).toBe('back')
  })
}
