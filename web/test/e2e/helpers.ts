import { expect, type Page } from '@playwright/test'

export const OWNER = { username: 'olga', password: 'correct horse battery' }

export async function reset(page: Page, o: { setup?: boolean } = {}) {
  const r = await page.request.post('/__test/reset', { data: o })
  expect(r.ok()).toBeTruthy()
}

/** Console errors and CSP violations the page reported (React warnings in production builds are none). */
export function watchConsole(page: Page) {
  const errors: string[] = []
  page.on('console', (m) => {
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
