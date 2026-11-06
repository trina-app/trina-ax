import { expect, type Locator, type Page } from '@playwright/test'

export const OWNER = { username: 'olga', password: 'correct horse battery' }

export async function reset(page: Page, o: { setup?: boolean; teamLocale?: 'ko' | 'en' | 'id' | 'ja' | 'es'; usersFollowTeam?: boolean; mustChange?: string } = {}) {
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
  await expect(page.getByTestId('composer-input')).toBeVisible()
}

/** Errors other than the expected 401 of GET /api/me before signing in. */
export const realErrors = (errors: string[]) => errors.filter((e) => !/status of 401/.test(e))

/** A field of the add-connection dialog that sits under its collapsed "Advanced" (type, sign-in, write rule, who connects,
 * who may use it): opens Advanced first when it is closed. `root`: the page or the dialog. */
export async function adv(root: Page | Locator, testId: string): Promise<Locator> {
  const toggle = root.getByTestId('integration-advanced')
  if ((await toggle.count()) && (await toggle.first().getAttribute('aria-expanded')) === 'false') await toggle.first().click()
  return root.getByTestId(testId)
}
