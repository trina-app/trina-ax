// The Preview button of a dev server in the chat (Steps.tsx PreviewLine, Step.devEnvRun kind server; server side:
// server/src/devenv/preview.ts): the step says the port, Preview asks for a link and opens it in a new tab, and a dev
// server that stopped says so in place of the button.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()

test('a dev server step has a Preview button that opens the link in a new tab', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  await ask(page, 'Start the site, devpreview')
  const a = lastAnswer(page)
  await expect(a).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await a.getByTestId('steps').getByRole('button').first().click()
  const line = a.getByTestId('devenv-preview')
  await expect(line).toContainText('Dev server on port 5173')
  const asked = page.waitForRequest((r) => /\/api\/dev-env\/runs\/[^/]+\/preview$/.test(r.url()) && r.method() === 'POST')
  const popup = page.waitForEvent('popup')
  await line.getByTestId('devenv-preview-open').click()
  expect((await asked).postDataJSON()).toEqual({ port: 5173 })
  const tab = await popup
  await expect.poll(() => tab.url()).toContain('#preview-')
  expect(realErrors(errors)).toEqual([])
})

test('a dev server that stopped: the step says so and the button goes', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await ask(page, 'Start the site, devpreviewgone')
  const a = lastAnswer(page)
  await expect(a).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await a.getByTestId('steps').getByRole('button').first().click()
  await a.getByTestId('devenv-preview-open').click()
  await expect(a.getByTestId('devenv-preview-ended')).toHaveText('The dev server stopped. Ask the AI to start it again.')
  await expect(a.getByTestId('devenv-preview-open')).toHaveCount(0)
})
