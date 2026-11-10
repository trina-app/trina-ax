// post_to_room's card (server/src/chat/post-to-room.ts; the mock scripts it with "postroomcard"): the room and its people
// on top, the note apart under 내 이름으로 보일 한마디, all of the text (folded past 600 characters), the lines that apply,
// the files [파일도 함께 보내기] attaches, three buttons only with files; a thread names the asked message. After 보내기
// the step names the room and has 보기. SHOTS_DIR=<folder>: each card, and the step after it, at 1440 and 390, light and
// dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()
async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
async function shot(page: Page, name: string, at = page.getByTestId('ask-card')) {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await at.scrollIntoViewIfNeeded()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(250)
    await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `post-to-room-${name}-${page.viewportSize()!.width}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

for (const width of [1440, 390]) {
  test.describe(`${width} px`, () => {
    test.beforeEach(async ({ page }) => { await page.setViewportSize({ width, height: width > 400 ? 900 : 844 }) })

    test('with files: three buttons, the note under my name, the lines, the file list; 보기 on the step after 보내기', async ({ page }) => {
      await reset(page)
      const errors = watchConsole(page)
      await signIn(page)
      await ask(page, 'postroomcard files 4분기 매출 요약해서 #전체에 올려줘')
      const card = page.getByTestId('ask-card')
      await expect(card).toHaveAttribute('data-kind', 'buttons')
      await expect(card).toContainText('#전체(24명)에 보낼까요?')
      await expect(card).toContainText('3명은 이 내용의 일부 출처(shared/재무/)를 볼 수 없어요.')
      await expect(card).toContainText('내 이름으로 보일 한마디')
      await expect(card).toContainText('shared/재무/4분기-매출.xlsx')
      // (in the server's order; a computer shows the main one on the right, a phone on top)
      await expect(card.getByRole('button')).toHaveText(['보내기', '파일도 함께 보내기', '보내지 않기'])
      await shot(page, 'files')
      await card.getByRole('button', { name: '보내기', exact: true }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
      // the step: the room, and 보기
      const steps = lastAnswer(page).getByRole('button', { name: /작업 \d단계/ })
      if (await steps.count()) await steps.click()
      await expect(lastAnswer(page).getByTestId('step-post-view')).toHaveText('보기')
      await shot(page, 'sent-step', lastAnswer(page).getByTestId('step-post-view'))
      expect(realErrors(errors)).toEqual([])
    })

    test('a long text folds (전체 보기); two buttons', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await ask(page, 'postroomcard long 이번 주 정리 #영업팀에 올려줘')
      const card = page.getByTestId('ask-card')
      await expect(card).toContainText('#영업팀(12명)에 보낼까요?')
      await expect(card.getByTestId('ask-detail-more')).toBeVisible()
      // (a yes/no card: the quiet no first, the main yes last)
      await expect(card.getByRole('button', { name: /보내/ })).toHaveText(['보내지 않기', '보내기'])
      await shot(page, 'long')
      await card.getByRole('button', { name: '보내지 않기' }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
    })

    test('a thread: the asked message in the question', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await ask(page, 'postroomcard thread 스레드에 올려줘')
      const card = page.getByTestId('ask-card')
      await expect(card).toContainText("#영업팀(12명)에서 '로고 시안 언제까지 받을 수 있을까요?' 메시지의 스레드에 보낼까요?")
      await shot(page, 'thread')
      await card.getByRole('button', { name: '보내지 않기' }).click()
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
    })
  })
}
