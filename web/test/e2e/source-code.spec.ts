import { expect, test, type Page } from '@playwright/test'
import { DEV_SESSION_COOKIE } from '@mycel/shared/api'
import { OWNER, reset, signIn } from './helpers'

const url = (version: string) => `https://source.example.test/releases/${version}/source.tar.gz`
const offer = (version: string) => ({ ok: true, time: new Date().toISOString(), version, sourceCode: { requestEmail: 'source@example.test', download: { version, url: url(version) } } })
const about = async (page: Page) => {
  await page.getByTestId('account-menu').click()
  await page.locator('a[href="/settings"]').first().click()
  await page.locator('a[href="/settings/about"]').click()
}
const logout = async (page: Page) => {
  await page.getByTestId('account-menu').click()
  await page.getByTestId('logout').click()
  await expect(page.getByTestId('login-submit')).toBeVisible()
}

test('login-hidden metadata is refetched after sign-in without a page reload and source download/request stay separate', async ({ page }) => {
  await reset(page)
  await page.route('**/api/health', route => route.fulfill({ json: route.request().headers().cookie?.includes(DEV_SESSION_COOKIE + '=') ? offer('0.3.1') : { ok: true, time: new Date().toISOString() } }))
  await page.goto('/login')
  await expect(page.getByTestId('source-code-link')).toHaveAttribute('href', /^mailto:/)
  await page.getByTestId('login-username').fill(OWNER.username)
  await page.getByTestId('login-password').fill(OWNER.password)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await about(page)
  await expect(page.getByTestId('source-code-download')).toHaveAttribute('href', url('0.3.1'))
  await expect(page.getByTestId('source-code-download')).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(page.getByTestId('source-code-link')).toHaveAttribute('href', /^mailto:source@example\.test\?subject=/)
  await expect(page.getByTestId('about-version')).toContainText('0.3.1')
  await logout(page)
  await expect(page.getByTestId('source-code-download')).toHaveCount(0)
  await expect(page.getByTestId('source-code-link')).not.toHaveAttribute('href', /source@example/)
})

test('an About screen left open refreshes source metadata after server reconnect', async ({ page }) => {
  await reset(page)
  let version = '0.3.1'
  await page.route('**/api/health', route => route.fulfill({ json: offer(version) }))
  await signIn(page)
  await about(page)
  await expect(page.getByTestId('source-code-download')).toHaveAttribute('href', url(version))
  version = '0.3.2'
  await page.request.post('/__test/server-version', { data: { version } })
  await page.request.post('/__test/drop-ws')
  await expect(page.getByTestId('source-code-download')).toHaveAttribute('href', url(version))
  await expect(page.getByTestId('about-version')).toContainText(version)
})

test('the browser refuses source metadata for a different running version', async ({ page }) => {
  await reset(page)
  await page.route('**/api/health', route => route.fulfill({ json: { ...offer('0.3.1'), version: '0.3.2' } }))
  await signIn(page)
  await about(page)
  await expect(page.getByTestId('about-version')).toContainText('0.3.2')
  await expect(page.getByTestId('source-code-download')).toHaveCount(0)
  await expect(page.getByTestId('source-code-link')).toHaveAttribute('href', /^mailto:source@example\.test\?subject=/)
})

test('late source metadata cannot reappear after logout', async ({ page }) => {
  await reset(page)
  let block = false, started!: () => void, unblock!: () => void
  const waiting = new Promise<void>(r => { started = r }), released = new Promise<void>(r => { unblock = r })
  await page.route('**/api/health', async route => {
    const signedIn = route.request().headers().cookie?.includes(DEV_SESSION_COOKIE + '=')
    if (block && signedIn) { started(); await released }
    await route.fulfill({ json: signedIn ? offer('0.3.1') : { ok: true, time: new Date().toISOString() } }).catch(() => {})
  })
  await signIn(page)
  block = true
  await about(page)
  await waiting
  await logout(page)
  unblock()
  await expect(page.getByTestId('source-code-download')).toHaveCount(0)
  await expect(page.getByTestId('source-code-link')).not.toHaveAttribute('href', /source@example/)
})
