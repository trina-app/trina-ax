// The AI share card (components/chat/ShareCard.tsx; docs/decisions/20261116-ai-share-card-and-stop.md; the mock scripts it
// with "sharecard", "sharecard stop", "sharecard many", "sharecard refused"): the confirmation card shows the file with
// its place in words and the person with "Can view", and turns into the result where it is ("Shared Quote.pdf with Bob",
// who was told, [Manage access] → the file's Share dialog with the person on it); a stop has no confirmation, says who
// can still open it, and [Undo] shares it again (the card then says so); several files are one card; a refusal is a card
// with why and no button of its own; another viewer of a shared chat sees the verb alone, no card and no name. No path is
// ever on a card. SHOTS_DIR=<folder>: each state at 1440 and 390, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
async function shot(page: Page, name: string, at = page.getByTestId('share-card').last()) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await at.scrollIntoViewIfNeeded()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `share-card-${name}-${page.viewportSize()!.width}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
const start = async (page: Page) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  return errors
}

for (const width of [1440, 390]) {
  test.describe(`${width} px`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: width > 400 ? 900 : 844 }) })

    test('a share: the confirmation card turns into the result; Manage access opens the Share dialog with the person on it', async ({ page }) => {
      const errors = await start(page)
      await ask(page, 'sharecard share Quote.pdf with Bob')
      const card = page.getByTestId('ask-card')
      await expect(card.getByTestId('share-ask-title')).toHaveText('Share Quote.pdf with Bob?')
      await expect(card.getByTestId('share-card-file-name')).toHaveText('Quote.pdf')
      await expect(card.getByTestId('share-card-file-place')).toHaveText('My files › Work')
      await expect(card.getByTestId('share-card-person')).toContainText('Bob')
      await expect(card.getByTestId('share-card-person')).toContainText('Can view')
      await expect(card.getByRole('button')).toHaveText(["Don't share", 'Share'])
      // no path, only words
      await expect(card).not.toContainText('users/')
      await shot(page, 'confirm', card)
      await card.getByRole('button', { name: 'Share', exact: true }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      // the same place: the question is gone, the result is there, one card
      await expect(page.getByTestId('ask-card')).toHaveCount(0)
      const result = lastAnswer(page).getByTestId('share-card')
      await expect(result).toHaveCount(1)
      await expect(result).toHaveAttribute('data-state', 'done')
      await expect(result.getByTestId('action-card-title')).toHaveText('Shared Quote.pdf with Bob')
      await expect(result.getByTestId('share-card-file-place')).toHaveText('My files › Work')
      await expect(result.getByTestId('share-card-person')).toContainText('Can view')
      await expect(result.getByTestId('share-card-note')).toHaveText('Bob got a notification.')
      await expect(result).not.toContainText('users/')
      await expect(result.getByRole('button')).toHaveText(['Manage access'])
      await shot(page, 'shared')
      await result.getByTestId('share-card-manage').click()
      const dialog = page.getByTestId('file-share-dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByTestId('file-share-row-user-bob')).toContainText('Can view')
      await page.getByTestId('file-share-done').click()
      expect(realErrors(errors)).toEqual([])
    })

    test('"Don\'t share": no result card, the step says it was not shared', async ({ page }) => {
      await start(page)
      await ask(page, 'sharecard share Quote.pdf with Bob')
      await page.getByTestId('ask-card').getByRole('button', { name: "Don't share" }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('share-card')).toHaveCount(0)
    })

    test('a stop: no confirmation, who can still open it, and Undo shares it again', async ({ page }) => {
      const errors = await start(page)
      await ask(page, 'sharecard stop sharing Quote.pdf with Bob')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('ask-card')).toHaveCount(0)
      const result = lastAnswer(page).getByTestId('share-card')
      await expect(result.getByTestId('action-card-title')).toHaveText('Stopped sharing Quote.pdf with Bob')
      await expect(result.getByTestId('share-card-note')).toHaveText('Bob can still open it through the Sales group.')
      await expect(result.getByTestId('share-card-person')).toHaveCount(0)
      await expect(result.getByRole('button')).toHaveText(['Undo'])
      await shot(page, 'stopped')
      await result.getByTestId('share-card-undo').click()
      await expect(result).toHaveAttribute('data-state', 'restored')
      await expect(result.getByTestId('action-card-title')).toHaveText('Shared Quote.pdf with Bob again')
      await expect(result.getByRole('button')).toHaveText(['Manage access'])
      await shot(page, 'undone')
      // really shared again, through the dialog's own endpoint
      await result.getByTestId('share-card-manage').click()
      await expect(page.getByTestId('file-share-dialog').getByTestId('file-share-row-user-bob')).toBeVisible()
      await page.getByTestId('file-share-done').click()
      expect(realErrors(errors)).toEqual([])
    })

    test('several files: one card; Manage access lists them, each opens its own dialog', async ({ page }) => {
      await start(page)
      await ask(page, 'sharecard many files with Bob')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      const result = lastAnswer(page).getByTestId('share-card')
      await expect(result).toHaveCount(1)
      await expect(result.getByTestId('action-card-title')).toHaveText('Shared 4 files with Bob: Quote.pdf, Budget.xlsx, Notes.docx and 1 more')
      await expect(result.getByTestId('share-card-file')).toHaveCount(0)
      await shot(page, 'many')
      await result.getByTestId('share-card-manage').click()
      await expect(result.getByTestId('share-card-file')).toHaveCount(4)
      await shot(page, 'many-listed')
      await result.getByTestId('share-card-file').nth(1).click()
      await expect(page.getByTestId('file-share-dialog')).toHaveAttribute('data-path', /Budget\.xlsx$/)
      await page.getByTestId('file-share-done').click()
    })

    test('a refusal: what and why from the record; its next step is the server\'s offer, on the card only', async ({ page }) => {
      await start(page)
      await ask(page, 'sharecard refused Quote.xlsx with Bob')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      const result = lastAnswer(page).getByTestId('share-card')
      await expect(result).toHaveAttribute('data-state', 'refused')
      await expect(result.getByTestId('action-card-title')).toHaveText("Couldn't share Quote.xlsx.")
      await expect(result.getByTestId('share-card-note')).toHaveText("It's Mina's file, so only Mina can add people.")
      await expect(result.getByTestId('share-card-file-place')).toHaveText('Team folder › Sales')
      // the step's stored offer (Step.fixes) is the card's one button, and is not shown again under the answer
      await expect(result.getByRole('button')).toHaveCount(1)
      await expect(result.getByTestId('share-card-next')).toHaveText('Ask Mina')
      await expect(lastAnswer(page).getByTestId('step-fix')).toHaveCount(0)
      await shot(page, 'refused')
      await result.getByTestId('share-card-next').click()
      await expect(result.getByTestId('share-card-next-done')).toContainText('Asked Mina')
      await expect(result.getByTestId('share-card-next')).toHaveCount(0)
    })

    test('another viewer of a shared chat sees the verb alone: no card, no name, no file', async ({ page, browser }) => {
      await start(page)
      await ask(page, 'sharecard many files with Bob')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      await expect(lastAnswer(page).getByTestId('share-card')).toHaveCount(1)
      const chatId = /\/c\/([^/?#]+)/.exec(page.url())![1]!
      // the chat is shared with Bob (the preview's key with the save)
      const subjects = [{ subjectType: 'user', subjectId: 'bob' }]
      const p = (await (await page.request.post(`/api/chats/${chatId}/audience/preview`, { headers: H, data: { subjects } })).json()) as { previewKey?: string }
      expect((await page.request.put(`/api/chats/${chatId}/audience`, { headers: H, data: { subjects, ...(p.previewKey ? { confirmKey: p.previewKey } : {}) } })).ok()).toBeTruthy()
      const bob = await as(browser, BOB, width)
      await bob.goto(`/c/${chatId}`)
      await expect(bob.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await expect(bob.getByTestId('share-card')).toHaveCount(0)
      const steps = bob.getByTestId('assistant-message').last().getByRole('button', { name: /step/i })
      if (await steps.count()) await steps.first().click()
      const text = await bob.getByTestId('assistant-message').last().innerText()
      expect(text).toContain('Share files')
      expect(text).not.toContain('Quote.pdf')
      expect(text).not.toContain('Budget.xlsx')
      await shot(bob, 'other-viewer', bob.getByTestId('assistant-message').last())
      await bob.context().close()
    })
  })
}

async function as(browser: Browser, who: { username: string; password: string }, width: number) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'en-US', viewport: { width, height: width > 400 ? 900 : 844 } })
  const page = await ctx.newPage()
  await signIn(page, who)
  return page
}
