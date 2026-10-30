// Server safety cards that show exactly what is about to go out (docs/DECISIONS.md "Outbound web channels"): a
// connected service's write showed only its first 300 characters, so harmless words could go first and the data and
// the recipient after. Now the card has every character, scrollable, with its size; where it goes comes first, and
// long random-looking parts are highlighted. The same block carries a scheduled task's instruction.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}

test('a connected service write: the whole payload, the recipient first, its size, scrollable', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  await ask(page, 'sendcard please')
  const card = page.getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-origin', 'server')
  await expect(card).toContainText('팀 서버의 안전 확인')
  const detail = card.getByTestId('ask-detail')
  await expect(detail).toContainText('보낼 내용')
  await expect(detail.getByTestId('ask-detail-fields')).toContainText('to')
  await expect(detail.getByTestId('ask-detail-fields')).toContainText('outside@evil.example')
  await expect(detail.getByTestId('ask-detail-size')).toHaveText(/^2\d{3}자$/)
  const text = detail.getByTestId('ask-detail-text')
  // nothing cut: the end of the payload is there, inside a scrolling box that the keyboard can reach
  await expect(text).toContainText('SECRET-AT-THE-END')
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect(text).toHaveAttribute('tabindex', '0')
  await expect(detail.getByTestId('ask-detail-mark')).toHaveText('c2fsyxj5ltk4nzy1ndmy')
  await card.getByLabel('보내지 않기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(card).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the payload card has no serious accessibility problems (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await ask(page, 'sendcard please')
    await expect(page.getByTestId('ask-detail-mark')).toBeVisible()
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
    const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
  })
}
