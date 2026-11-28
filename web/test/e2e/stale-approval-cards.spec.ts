// An approval card left unanswered closes when the person writes a new message instead (docs/decisions/20261128-stale-
// approval-cards.md; the owner, 11-28: a Gmail send card stayed pressable above the new turn and the chat kept its "?").
// The mock scripts the server's side ("latecard": a send card that waits after the answer ended, closed by the person's
// next message as server/src/chat/runtime.ts createTurn does); this checks what the person sees: the card goes, the step
// under the earlier answer says it was not done, the "?" goes, and the card never shows a "team-file:" handle.
// SHOTS_DIR=<folder>: each state at 1440 and 390.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const answers = (page: Page) => page.getByTestId('assistant-message')
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${name}-${page.viewportSize()!.width}.png`) })
}

for (const width of [1440, 390]) {
  test.describe(`${width} px`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: width > 400 ? 900 : 844 }) })

    test('a new message closes the waiting send card as not done; the step says so and the "?" goes', async ({ page }) => {
      await reset(page)
      const errors = watchConsole(page)
      await signIn(page)
      await ask(page, 'latecard 견적서 메일로 보내 줘')
      await expect(answers(page).last()).toHaveAttribute('data-status', 'done')
      const card = answers(page).last().getByTestId('ask-card')
      await expect(card).toContainText('보낼까요?')
      // the attachment by its name and place on every line, never the raw handle
      await expect(card).toContainText('견적서.pdf')
      await expect(card).not.toContainText('team-file:')
      await expect(answers(page).last().getByTestId('step-waiting')).toHaveCount(1)
      if (width > 400) await expect(page.getByTestId('marker-ask').first()).toBeVisible()
      await shot(page, 'stale-card-waiting')

      await ask(page, '다음 메일이야')
      // the card is gone, nothing waits for it, and the earlier answer's step says it was not done
      await expect(page.getByTestId('ask-card')).toHaveCount(0)
      const first = answers(page).first()
      await expect(first.getByTestId('step-waiting')).toHaveCount(0)
      await first.getByTestId('steps').getByRole('button').first().click().catch(() => {})
      await expect(first).toContainText('답하지 않고 넘어가서 하지 않았어요')
      await expect(answers(page).last()).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('marker-ask')).toHaveCount(0)
      // the new message went as a message, not as an answer to the card
      await expect(page.getByTestId('user-message')).toHaveCount(2)
      await expect(page.getByTestId('outbox')).toHaveCount(0)
      await shot(page, 'stale-card-closed')
      // after a reload: still closed
      await page.reload()
      await expect(answers(page)).toHaveCount(2)
      await expect(page.getByTestId('ask-card')).toHaveCount(0)
      expect(realErrors(errors)).toEqual([])
    })
  })
}
