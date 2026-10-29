import { expect, test } from '@playwright/test'
import { en } from '../../src/i18n/en'
import { id } from '../../src/i18n/id'
import { ko } from '../../src/i18n/ko'
import { account, cachedPaths, offlineServer, signInOfflineTeam, warmWorker } from './offline-server'

for (const locale of ['ko', 'en', 'id'] as const) {
  test(`${locale}: production SW, stopped listener, warm/cold assets and API-down retry retain the session`, async ({ page }) => {
    const server = await offlineServer()
    const dict = { ko, en, id }[locale]
    try {
      await signInOfflineTeam(page, server.url, locale)
      await warmWorker(page)
      const before = await account(page)
      const paths = await cachedPaths(page)
      expect(paths.length).toBeGreaterThan(0)
      expect(paths.every(path => path.startsWith('/assets/') || /^\/vendor\/(chunk|asset)-/.test(path))).toBe(true)

      // The app shell still loads; its account request fails. React must use the same language policy.
      await server.mode('api-down')
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await expect(page.getByText(dict['conn.cantReach'], { exact: true })).toBeVisible()
      await expect(page.locator('meta[name="mycel-offline"]')).toHaveCount(0)
      await server.mode('online')
      await page.getByRole('button', { name: dict['common.retry'], exact: true }).click()
      await expect(page.getByTestId('composer-input')).toBeVisible()
      expect(await account(page)).toEqual(before)

      for (const cold of [false, true]) {
        if (cold) await page.evaluate(async () => { for (const key of await caches.keys()) await caches.delete(key) })
        await server.mode('stop')
        const response = await page.reload()
        expect(response?.status()).toBe(503)
        expect(response?.fromServiceWorker()).toBe(true)
        await expect(page.locator('html')).toHaveAttribute('lang', locale)
        await expect(page.getByRole('heading')).toHaveText(dict['conn.cantReach'])
        await expect(page.locator('#hint')).toHaveText(dict['conn.cantReachHint'])
        expect(await cachedPaths(page)).toEqual(cold ? [] : paths)
        await server.mode('online')
        await page.getByRole('button', { name: dict['common.retry'], exact: true }).click()
        await expect(page.getByTestId('composer-input')).toBeVisible()
        expect(await account(page)).toEqual(before)
      }

      await server.mode('503')
      const response = await page.reload()
      expect(response?.status()).toBe(503)
      await expect(page.getByRole('heading')).toHaveText('Scheduled maintenance')
      await expect(page.locator('meta[name="mycel-offline"]')).toHaveCount(0)
    } finally { await server.close() }
  })
}

test('SW first-run, invalid hints, sign-in choice and blocked storage have bounded fallbacks', async ({ page }) => {
  const server = await offlineServer()
  try {
    await page.goto(server.url)
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
    })
    await server.mode('stop')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await page.evaluate(() => {
      localStorage.setItem('mycel.recentLocale', 'unexpected')
      localStorage.setItem('mycel.locale', 'id')
    })
    await page.reload()
    await expect(page.getByRole('heading')).toHaveText(id['conn.cantReach'])
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError') } }))
    await page.reload()
    await expect(page.getByRole('heading')).toHaveText(en['conn.cantReach'])
    await expect(page.getByRole('button', { name: en['common.retry'], exact: true })).toBeVisible()
  } finally { await server.close() }
})

for (const end of ['logout', '401'] as const) {
  test(`${end} clears the account hint before a subsequent SW navigation failure`, async ({ page, context }) => {
    const server = await offlineServer()
    try {
      await signInOfflineTeam(page, server.url, 'ko')
      await warmWorker(page)
      // The prior sign-in choice is separate from the account's current Korean language.
      await page.evaluate(() => localStorage.setItem('mycel.locale', 'id'))
      if (end === 'logout') {
        await page.getByTestId('account-menu').click()
        await page.getByTestId('logout').click()
      } else {
        await context.clearCookies()
        await page.reload()
      }
      await expect(page.getByTestId('login-username')).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('mycel.recentLocale'))).toBeNull()
      await server.mode('stop')
      expect((await page.reload())?.fromServiceWorker()).toBe(true)
      await expect(page.getByRole('heading')).toHaveText(id['conn.cantReach'])
      await expect(page.locator('html')).toHaveAttribute('lang', 'id')
    } finally { await server.close() }
  })
}

test('two team origins retain their own account language through SW navigation recovery', async ({ page, context }) => {
  const server = await offlineServer()
  const other = await context.newPage()
  try {
    await signInOfflineTeam(page, server.url, 'ko')
    await warmWorker(page)
    const first = await account(page)
    await other.goto(`${server.url.replace('127.0.0.1', 'localhost')}/login`)
    expect(await other.evaluate(() => localStorage.getItem('mycel.recentLocale'))).toBeNull()
    await other.getByTestId('auth-locale').selectOption('id')
    await other.getByTestId('login-username').fill('bob')
    await other.getByTestId('login-password').fill('bob password 1')
    await other.getByTestId('login-submit').click()
    await expect(other.getByTestId('composer-input')).toBeVisible()
    await warmWorker(other)
    await expect(other.locator('html')).toHaveAttribute('lang', 'id')
    const second = await account(other)
    expect(second.user).not.toBe(first.user)
    await server.mode('stop')
    expect((await page.reload())?.fromServiceWorker()).toBe(true)
    expect((await other.reload())?.fromServiceWorker()).toBe(true)
    await expect(page.getByRole('heading')).toHaveText(ko['conn.cantReach'])
    await expect(other.getByRole('heading')).toHaveText(id['conn.cantReach'])
    await server.mode('online')
    await page.getByRole('button', { name: ko['common.retry'], exact: true }).click()
    await other.getByRole('button', { name: id['common.retry'], exact: true }).click()
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(other.getByTestId('composer-input')).toBeVisible()
    expect(await account(page)).toEqual(first)
    expect(await account(other)).toEqual(second)
  } finally { await other.close(); await server.close() }
})
