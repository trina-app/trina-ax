import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })

test('phone screenshots', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'only with SHOTS=1')
  await reset(page)
  await signIn(page)
  await page.screenshot({ path: 'test-results/shot-m-home.png' })
  await page.getByTestId('composer-input').fill('make an artifact')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('artifact-panel')).toBeVisible()
  await page.waitForTimeout(800)
  await page.screenshot({ path: 'test-results/shot-m-artifact.png' })
  await page.getByTestId('artifact-panel').getByRole('button', { name: '닫기' }).click()
  await page.screenshot({ path: 'test-results/shot-m-chat.png' })
})
