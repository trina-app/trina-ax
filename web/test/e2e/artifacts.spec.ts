import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}

test('an HTML artifact opens by itself in an isolated frame (allow-scripts only, CSP first, network blocked)', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  const external: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('data:') && !r.url().startsWith('about:')) external.push(r.url())
  })
  await signIn(page)
  await ask(page, 'make an artifact')
  const panel = page.getByTestId('artifact-panel')
  await expect(panel).toBeVisible()
  const frame = panel.locator('iframe')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  const srcdoc = (await frame.getAttribute('srcdoc'))!
  expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('Hello artifact'))
  // the script ran inside the frame…
  await expect(page.frameLocator('[data-testid="artifact-panel"] iframe').locator('h1')).toHaveText('Hello artifact (ran)')
  // …but its fetch to example.com never left the page, and the panel says why
  await expect(panel.getByRole('alert')).toContainText('connect-src')
  expect(external).toEqual([])
  // the frame cannot reach the app: no cookies, no storage (opaque origin)
  const origin = await page.frameLocator('[data-testid="artifact-panel"] iframe').locator('body').evaluate(() => {
    try {
      return `${location.origin}|${document.cookie}|${String(window.parent.document)}`
    } catch (e) {
      return `blocked: ${(e as Error).name}`
    }
  })
  expect(origin).toMatch(/^blocked|^null\|\|/)
  // code tab, card in the answer
  await panel.getByRole('tab', { name: '코드' }).click()
  await expect(panel.locator('code')).toContainText('Hello artifact')
  await expect(page.getByTestId('artifact-card')).toContainText('Hello page')
  expect(realErrors(errors).filter((e) => !e.includes('Content Security Policy') && !e.includes('example.com'))).toEqual([])
})

test('a React artifact runs with the team server\'s vendor libraries, versions switch, errors can be sent back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'make a react counter')
  const panel = page.getByTestId('artifact-panel')
  const f = page.frameLocator('[data-testid="artifact-panel"] iframe')
  await expect(f.getByRole('button')).toContainText('count 0', { timeout: 15_000 })
  await f.getByRole('button').click()
  await expect(f.getByRole('button')).toContainText('count 1')
  // Tailwind from /vendor/ styled it
  await expect(f.getByRole('button')).toHaveCSS('color', 'rgb(255, 255, 255)')
  // a second version
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  await ask(page, 'make the react counter again')
  await expect(panel.getByTestId('artifact-version')).toHaveText('v2 / 2')
  await panel.getByRole('button', { name: '이전 버전' }).click()
  await expect(panel.getByTestId('artifact-version')).toHaveText('v1 / 2')
})

test('a failing artifact: "ask the AI to fix it" sends the error', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'make a broken artifact')
  const panel = page.getByTestId('artifact-panel')
  await expect(panel.getByRole('alert')).toContainText('boom')
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  await panel.getByTestId('ask-fix').click()
  await expect(page.getByTestId('user-text').last()).toContainText('boom')
})

test('save an artifact into the team folder', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'make an artifact')
  const panel = page.getByTestId('artifact-panel')
  await expect(panel.locator('iframe')).toBeVisible()
  await panel.getByRole('button', { name: '팀 폴더에 저장' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'marketing' }).click()
  await page.getByTestId('folder-pick').click()
  await expect(page.getByText('marketing/Hello page.html에 저장했어요.')).toBeVisible()
})
