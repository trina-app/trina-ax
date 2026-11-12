// QA TC-407: on a 390 px phone the empty box's hint while an answer runs ("sends after this answer") and while a card
// waits for a choice ("choose above first") is one line in every language: the empty box is as tall as with one
// letter typed in it, and the hint is the whole text (nothing cut).
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { en } from '../../src/i18n/en'
import { ko } from '../../src/i18n/ko'
import { id } from '../../src/i18n/id'
import { ja } from '../../src/i18n/ja'
import { es } from '../../src/i18n/es'
import { reset, signIn } from './helpers'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' })

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SHOTS_DIR, name) })
}

/** the empty box is as tall as with one letter in it, and its placeholder takes one line with no sideways overflow */
async function oneLine(input: Locator) {
  await input.fill('x')
  const idle = await input.evaluate((e) => e.getBoundingClientRect().height)
  await input.fill('')
  await expect.poll(() => input.evaluate((e) => e.getBoundingClientRect().height)).toBe(idle)
  const m = await input.evaluate((e) => {
    const ta = e as HTMLTextAreaElement
    const cs = getComputedStyle(ta)
    return { lines: (ta.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight), overflow: ta.scrollWidth - ta.clientWidth }
  })
  expect(m.lines).toBeLessThan(1.5)
  expect(m.overflow).toBeLessThanOrEqual(0)
}

for (const [locale, dict] of [['en', en], ['ko', ko], ['id', id], ['ja', ja], ['es', es]] as const) {
  test(`${locale}: the waiting-message hints fit on one line at 390 px`, async ({ page }) => {
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    const input = page.getByTestId('composer-input')
    // an answer runs: the box says a message typed now goes after it
    await input.fill('slow answer please, slow slow slow slow slow slow slow slow slow slow')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'streaming')
    await expect(input).toHaveAttribute('placeholder', dict['outbox.placeholder'])
    await oneLine(input)
    await shot(page, `hint-${locale}-answer-running.png`)
    await page.getByTestId('stop').click()
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'stopped')
    // a server safety check waits for a choice in the card: the box says to choose first
    await input.fill('ask me a safety question')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('ask-card')).toBeVisible()
    await expect(input).toHaveAttribute('placeholder', dict['outbox.placeholderChoice'])
    await oneLine(input)
    await shot(page, `hint-${locale}-choice.png`)
  })
}
