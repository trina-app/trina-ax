import { expect, type Locator, type Page } from '@playwright/test'
import { reportBrowserAnswers } from './coverage-report'

export const OWNER = { username: 'olga', password: 'correct horse battery' }

export async function reset(page: Page, o: { setup?: boolean; teamLocale?: 'ko' | 'en' | 'id' | 'ja' | 'es'; usersFollowTeam?: boolean; mustChange?: string; withAdmin?: boolean } = {}) {
  reportBrowserAnswers(page)
  const r = await page.request.post('/__test/reset', { data: o })
  expect(r.ok()).toBeTruthy()
}

/** Console errors and CSP violations the page reported (React warnings in production builds are none). */
export function watchConsole(page: Page) {
  const errors: string[] = []
  page.on('console', (m) => {
    // the demo's GET /api/demo is a 404 on every server that is not a demo (the sign-in page asks each server once,
    // web/src/components/demo/Demo.tsx): the browser logs it, and it is no error of the page
    if (m.type() === 'error' && /status of 404/.test(m.text()) && /\/api\/demo$/.test(m.location().url)) return
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

export async function signIn(page: Page, who = OWNER) {
  await page.goto('/login')
  await page.getByTestId('login-username').fill(who.username)
  await page.getByTestId('login-password').fill(who.password)
  await page.getByTestId('login-submit').click()
  // a phone lands on the 대화 list (App.tsx AfterSignIn) or, with the new tabs (navigation phase P5), on the 트리나 list;
  // the tests start from the new-chat box either way (`/`, or /new on a phone with the new tabs, `/` being the list)
  const trinaList = page.getByTestId('phone-trina-home')
  await expect(page.getByTestId('composer-input').or(page.getByTestId('rooms-page')).or(trinaList).first()).toBeVisible()
  if (await page.getByTestId('rooms-page').isVisible()) {
    await page.goto('/')
    await expect(page.getByTestId('composer-input').or(trinaList).first()).toBeVisible()
  }
  if (await trinaList.isVisible()) await page.goto('/new')
  await expect(page.getByTestId('composer-input')).toBeVisible()
}

/** Errors other than the expected 401 of GET /api/me before signing in, and WebKit's notice that it does not know
 * index.html's interactive-widget=resizes-content (only Chromium reads it): about our own markup, no error of the page. */
export const realErrors = (errors: string[]) => errors.filter((e) => !/status of 401/.test(e) && !/^Viewport argument key "interactive-widget" not recognized/.test(e))

/** A field of the add-connection dialog that sits under its collapsed "Advanced" (type, sign-in, write rule, who connects,
 * who may use it): opens Advanced first when it is closed. `root`: the page or the dialog. */
export async function adv(root: Page | Locator, testId: string): Promise<Locator> {
  const toggle = root.getByTestId('integration-advanced')
  if ((await toggle.count()) && (await toggle.first().getAttribute('aria-expanded')) === 'false') await toggle.first().click()
  return root.getByTestId(testId)
}

/** @deprecated The new navigation's server switch is retired (docs/DECISIONS.md "navRail: retired, the old navigation
 * removed"): the rail and the phone tabs are always on, so this does nothing. Kept so suites that still call it run
 * unchanged until they drop the call. */
export async function navRail(_page: Page, _on = true) {}

/** Press a place on the computer's rail (lib/rail.ts RailItem: 'ai' | 'chats' | 'files' | 'activity'), the way a person
 * does, and wait for it to be the lit one. */
export async function openRail(page: Page, item: 'ai' | 'chats' | 'files' | 'activity') {
  const button = page.getByTestId(`rail-${item}`)
  await button.click()
  await expect(button).toHaveAttribute('aria-current', 'page')
}

/** Whether a phone bar's ‹ label (PhonePageBar.tsx) has room beside the bar's title in this browser's font, as the bar
 * measures it ('moved': ‹ with its label, the whole title and the right side). Where it has none the bar shows ‹ alone,
 * on purpose; the label's room depends on the system font (wider on the Linux CI's DejaVu Sans than on a phone). */
export function backLabelHasRoom(label: Locator): Promise<boolean> {
  return label.evaluate((el) => {
    const bar = el.closest('[data-testid="phone-page-bar"]') as HTMLElement
    const st = getComputedStyle(bar)
    const room = bar.clientWidth - (parseFloat(st.paddingLeft) || 0) - (parseFloat(st.paddingRight) || 0)
    const r = document.createRange()
    r.selectNodeContents(bar.children[1]!)
    const right = Math.max(44, bar.children[2]?.firstElementChild?.getBoundingClientRect().width ?? 0)
    return 44 - 10 + el.scrollWidth + 8 + r.getBoundingClientRect().width + 8 + right <= room + 1
  })
}

