// Real Electron + production web build + actual registered service worker. No page.route/network mocks.
import { expect, test } from '@playwright/test'
import { STRINGS } from '../src/common/i18n'
import { account, offlineServer, signInOfflineTeam, warmWorker } from '../../web/test/e2e/offline-server'
import { close, launch, newUserData, teamPage, welcome } from './helpers'

// A hidden WebContents still has a visible DOM in Playwright; check attachment to the actual native window.
const nativeRecoveryVisible = (app: Awaited<ReturnType<typeof launch>>) => app.evaluate(({ BaseWindow }) =>
  BaseWindow.getAllWindows()[0]?.contentView.children.some((view: any) => view.webContents?.getURL().endsWith('/welcome.html')) ?? false,
)

for (const locale of ['ko', 'en', 'id'] as const) {
  test(`${locale}: SW 503 opens native recovery; Other teams and Retry work; ordinary 503 stays visible`, async () => {
    const server = await test.step('start stoppable server', () => offlineServer())
    const app = await test.step('launch Electron', () => launch(newUserData('en'))).catch(async error => {
      await server.close()
      throw error
    })
    const strings = STRINGS[locale]
    try {
      const shell = await welcome(app)
      await shell.locator('#address').fill(server.url)
      await shell.getByRole('button', { name: 'Connect', exact: true }).click()
      let page = await teamPage(app, server.url)
      await test.step('sign in to production web', () => signInOfflineTeam(page, server.url, locale))
      await test.step('wait for worker and warm hashed assets', () => warmWorker(page))
      const before = await account(page)
      await expect(shell.locator('html')).toHaveAttribute('lang', locale)

      await test.step('stop HTTP listener', () => server.mode('stop'))
      const response = await test.step('reload through service worker', () => page.reload())
      expect(response?.status()).toBe(503)
      expect(response?.fromServiceWorker()).toBe(true)
      await expect.poll(() => nativeRecoveryVisible(app)).toBe(true)
      await expect(shell.getByTestId('offline')).toBeVisible()
      await expect(shell.getByRole('heading')).toHaveText(strings['offline.title'])
      await expect(shell.getByRole('button', { name: strings['offline.retry'], exact: true })).toBeVisible()
      await shell.getByRole('button', { name: strings['offline.teams'], exact: true }).click()
      await expect(shell.getByTestId('team-list')).toBeVisible()
      // Reopen the stopped team from the native list: the registered worker still supplies the document.
      await shell.locator('[data-testid="team"] button.open').click()
      await expect.poll(() => page.isClosed()).toBe(true)
      page = await teamPage(app, server.url)
      await expect(page.locator('meta[name="mycel-offline"]')).toHaveAttribute('content', 'navigation-v1')
      await expect.poll(() => nativeRecoveryVisible(app)).toBe(true)
      await expect(shell.getByTestId('offline')).toBeVisible()
      await server.mode('online')
      await shell.getByRole('button', { name: strings['offline.retry'], exact: true }).click()
      await expect.poll(() => page.isClosed()).toBe(true)
      page = await teamPage(app, server.url)
      await expect(page.getByTestId('composer-input')).toBeVisible()
      expect(await account(page)).toEqual(before)
      // A normal application 503 is a successful document load, not native offline recovery.
      await server.mode('503')
      expect((await page.reload())?.status()).toBe(503)
      await expect(page.getByRole('heading')).toHaveText('Scheduled maintenance')
      await expect.poll(() => nativeRecoveryVisible(app)).toBe(false)
    } finally { await test.step('close Electron', () => close(app)); await server.close() }
  })
}
