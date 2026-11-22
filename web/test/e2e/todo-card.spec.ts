// The AI's to-do list (components/chat/TodoCard.tsx, Step.todos; the mock scripts it with "todolist" and "todohold") and
// a question that waits after its answer ended ("laterask"; docs/decisions/20261118-questions-wait-and-todo-card.md):
// one checklist card per answer that moves on in place and stays after the answer and a reload, each item's state in
// its mark and in words; the question's card stays under the finished answer, after a reload too, and its answer starts
// the next turn with the answer as the person's message. SHOTS_DIR=<folder>: each state at 1440 and 390, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
async function shot(page: Page, name: string, at: Locator) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    // the chat keeps to its newest end: put the card in the middle for each picture
    await at.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${name}-${page.viewportSize()!.width}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
const start = async (page: Page) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const errors = watchConsole(page)
  await signIn(page)
  return errors
}
const states = (card: Locator) => card.getByTestId('todo-item').evaluateAll((li) => li.map((x) => x.closest('li')?.getAttribute('data-status')))

for (const width of [1440, 390]) {
  test.describe(`${width} px`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: width > 400 ? 900 : 844 }) })

    test('the to-do card moves on in place while the AI works and stays with the answer', async ({ page }) => {
      const errors = await start(page)
      await ask(page, 'todohold the March invoices')
      const card = lastAnswer(page).getByTestId('todo-card')
      await expect(card).toHaveCount(1)
      await expect(card.getByTestId('todo-progress')).toHaveText('· 2 of 4 done')
      await expect.poll(() => states(card)).toEqual(['completed', 'completed', 'in_progress', 'pending'])
      // the item under way says what is being done; each state is said in words too
      await expect(card.getByTestId('todo-item').nth(2)).toContainText('Checking the totals against the bank statement')
      await expect(card.getByTestId('todo-item').nth(0)).toContainText('(Done)')
      // not a step line of its own
      await expect(lastAnswer(page).getByTestId('steps')).not.toContainText('To-do list')
      await shot(page, 'todo-card-running', card)
      await page.getByTestId('stop').click()
      await expect(lastAnswer(page)).not.toHaveAttribute('data-status', 'streaming')
      // stopped: the list stays as it was, the item under way by its own words
      await expect(card.getByTestId('todo-item').nth(2)).toContainText('Check the totals against the bank statement')

      await page.goto('/')
      await ask(page, 'todolist the March invoices')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      const done = lastAnswer(page).getByTestId('todo-card')
      await expect(done.getByTestId('todo-progress')).toHaveText('· 4 of 4 done')
      await expect(done).toHaveAttribute('data-state', 'done')
      await shot(page, 'todo-card-done', done)
      await page.reload()
      await expect(lastAnswer(page).getByTestId('todo-card').getByTestId('todo-item')).toHaveCount(4)
      expect(realErrors(errors)).toEqual([])
    })

    test('a question waits after its answer ended, also after a reload; its answer starts the next turn', async ({ page }) => {
      const errors = await start(page)
      await ask(page, 'laterask the monthly report')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      const card = lastAnswer(page).getByTestId('ask-card')
      await expect(card).toContainText('Which month should the report cover?')
      // the answer ended: no "waiting for you" line of a running answer, the card alone asks
      await expect(page.getByTestId('waiting-for-you')).toHaveCount(0)
      await shot(page, 'question-after-answer', card)
      await page.reload()
      const again = page.getByTestId('ask-card')
      await expect(again).toContainText('Which month should the report cover?')
      await again.getByRole('button', { name: 'October', exact: true }).click()
      await expect(page.getByTestId('ask-card')).toHaveCount(0)
      await expect(page.getByTestId('user-message').last()).toContainText('October')
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      expect(realErrors(errors)).toEqual([])
    })
  })
}
