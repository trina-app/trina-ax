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
  await expect(card).toContainText('확인해 주세요')
  // the tool by its title, not its id (docs/DECISIONS.md "Plain words in errors, cards and steps")
  await expect(card).toContainText('AI가 Tasks에 이 내용을 보내려고 해요: 할 일 만들기')
  await expect(card).not.toContainText('create_task')
  const detail = card.getByTestId('ask-detail')
  // every value as a labelled line, where it goes first, the random-looking part highlighted there
  const fields = detail.getByTestId('ask-detail-fields')
  await expect(fields.locator('dt').first()).toHaveText('받는 사람')
  await expect(fields.locator('dd').first()).toHaveText('outside@evil.example')
  await expect(fields).toContainText('마감일')
  await expect(fields).toContainText('SECRET-AT-THE-END')
  await expect(fields.getByTestId('ask-detail-mark')).toHaveText('c2fsyxj5ltk4nzy1ndmy')
  // the long value scrolls in place and the keyboard reaches it
  const long = fields.getByTestId('ask-detail-value').filter({ hasText: 'SECRET-AT-THE-END' })
  await expect(long).toHaveAttribute('tabindex', '0')
  // the exact JSON one click away, with its size; open, every character of it, the same part highlighted
  await expect(detail.getByTestId('ask-detail-text')).toHaveCount(0)
  const exact = detail.getByTestId('ask-detail-exact')
  await expect(exact).toContainText('보내는 내용 그대로 보기')
  await expect(exact).toContainText(/2\d{3}자/)
  await exact.click()
  await expect(exact).toHaveAttribute('aria-expanded', 'true')
  const text = detail.getByTestId('ask-detail-text')
  // nothing cut: the end of the payload is there, inside a scrolling box that the keyboard can reach
  await expect(text).toContainText('"to": "outside@evil.example"')
  await expect(text).toContainText('SECRET-AT-THE-END')
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect(text).toHaveAttribute('tabindex', '0')
  await expect(text.getByTestId('ask-detail-mark')).toHaveText('c2fsyxj5ltk4nzy1ndmy')
  await card.getByRole('button', { name: '보내지 않기', exact: true }).click()
  await expect(card).toHaveCount(0)
  expect(realErrors(errors)).toEqual([])
})

test('a call the lines cannot show all of (an invisible character): the JSON open as before, the recipient first', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'sendcard raw please')
  const card = page.getByTestId('ask-card')
  await expect(card).toContainText('AI가 Tasks에 이 내용을 보내려고 해요: Create task')
  const detail = card.getByTestId('ask-detail')
  await expect(detail.getByTestId('ask-detail-exact')).toHaveCount(0)
  await expect(detail.getByTestId('ask-detail-fields')).toContainText('받는 사람')
  await expect(detail.getByTestId('ask-detail-text')).toContainText('SECRET-AT-THE-END')
  await card.getByRole('button', { name: '보내기', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('assistant-message').first()).toContainText('You chose "allow"')
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
