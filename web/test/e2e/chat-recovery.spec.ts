import { expect, test, type Page } from '@playwright/test'
import { translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const rawReason = 'Read-only file cannot be modified (no write permission).'
const input = (page: Page) => page.getByTestId('composer-input')
const messages = (page: Page) => page.getByTestId('messages')

async function rejectedAnswer(page: Page, locale: 'ko' | 'en' | 'id', hidden = false, reason = rawReason) {
  await reset(page, { teamLocale: locale, usersFollowTeam: true })
  await signIn(page)
  await input(page).fill('write the files please')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  // Supplement the mock's usual rejection with unknown and redacted server payloads on reload.
  await page.route('**/api/chats/*/messages*', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    for (const m of body.items) if (m.files?.rejected.length) m.files.rejected = [{ path: hidden ? '' : 'finance/2026/q3.csv', reason }]
    await route.fulfill({ response, json: body })
  })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  const summary = page.getByTestId('file-summary')
  await summary.getByRole('button').first().click()
  await expect(summary).toContainText(translate(locale, hidden ? 'files.summary.rejectedHidden' : 'files.summary.rejectedLine', { path: 'finance/2026/q3.csv' }))
  await expect(summary).not.toContainText(reason)
  return summary.getByRole('button', { name: translate(locale, 'files.summary.askOwnFolder'), exact: true })
}

async function mutations(page: Page) {
  const response = await page.request.post('/__test/log')
  return (await response.json() as string[]).filter(line => /^(POST|PUT|PATCH|DELETE) /.test(line))
}

for (const locale of ['ko', 'en', 'id'] as const) {
  test(`${locale}: retry prepares and focuses a draft, preserves attachments, and sends only explicitly`, async ({ page }) => {
    const retry = await rejectedAnswer(page, locale)
    const request = translate(locale, 'files.summary.askOwnFolderPrompt', { path: 'finance/2026/q3.csv', folder: 'users/olga' })
    const before = await mutations(page)
    await retry.click()
    await expect(input(page)).toHaveValue(request)
    await expect(input(page)).toBeFocused()
    await retry.click()
    await expect(input(page)).toHaveValue(request)
    await expect(messages(page).getByTestId('user-message')).toHaveCount(1)
    await expect(messages(page).getByTestId('assistant-message')).toHaveCount(1)
    expect(await mutations(page)).toEqual(before)

    // Existing text and completed uploads survive preparation and a reload.
    const existing = 'Keep my draft.\nKeep the second line.'
    await input(page).fill(existing)
    await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('review notes') })
    await expect(page.getByTestId('attachment-chip')).toContainText('notes.txt')
    await expect(page.getByTestId('attachment-chip')).not.toContainText('%')
    const withAttachment = await mutations(page)
    await retry.click()
    await retry.click()
    await expect(input(page)).toHaveValue(`${existing}\n\n${request}`)
    await expect(input(page)).toBeFocused()
    await expect(page.getByTestId('attachment-chip')).toContainText('notes.txt')
    expect(await mutations(page)).toEqual(withAttachment)
    await page.reload()
    await expect(input(page)).toHaveValue(`${existing}\n\n${request}`)
    await expect(page.getByTestId('attachment-chip')).toContainText('notes.txt')
    await page.getByTestId('send').click()
    await expect(messages(page).getByTestId('user-message')).toHaveCount(2)
    await expect(messages(page).getByTestId('user-message').last()).toContainText('notes.txt')
    await expect(messages(page).getByTestId('assistant-message')).toHaveCount(2)
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
    await expect(input(page)).toHaveValue('')
  })

  test(`${locale}: unknown and hidden-path rejection reasons stay out of localized recovery`, async ({ page }) => {
    const reason = 'Future diagnostic: internal/path/that-must-not-be-shown'
    const retry = await rejectedAnswer(page, locale, true, reason)
    const before = await mutations(page)
    await retry.click()
    await expect(input(page)).toHaveValue(translate(locale, 'files.summary.askOwnFolderHiddenPrompt', { folder: 'users/olga' }))
    await expect(input(page)).toBeFocused()
    await expect(messages(page)).not.toContainText(reason)
    await expect(messages(page)).not.toContainText('finance/2026/q3.csv')
    expect(await mutations(page)).toEqual(before)
  })
}

test('recovery stays disabled during a running turn and works after Stop', async ({ page }) => {
  const retry = await rejectedAnswer(page, 'en', false, 'Unknown rejection reason')
  await input(page).fill('slow answer please')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('stop')).toBeVisible()
  await expect(retry).toBeDisabled()
  await input(page).fill('Keep this for later')
  await page.getByTestId('stop').click()
  await expect(retry).toBeEnabled()
  const before = await mutations(page)
  await retry.click()
  await expect(input(page)).toHaveValue('Keep this for later\n\n' + translate('en', 'files.summary.askOwnFolderPrompt', { path: 'finance/2026/q3.csv', folder: 'users/olga' }))
  await expect(input(page)).toBeFocused()
  expect(await mutations(page)).toEqual(before)
})

test('preparing a request preserves an upload in progress', async ({ page }) => {
  const retry = await rejectedAnswer(page, 'en')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/uploads', async route => {
    await held
    await route.continue()
  })
  try {
    await input(page).fill('Keep pending attachment')
    await page.getByTestId('file-input').setInputFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('pending notes') })
    await expect(page.getByTestId('attachment-chip')).toContainText('pending.txt')
    await expect(page.getByTestId('send')).toBeDisabled()
    const before = await mutations(page)
    await retry.click()
    await expect(input(page)).toBeFocused()
    await expect(input(page)).toHaveValue('Keep pending attachment\n\n' + translate('en', 'files.summary.askOwnFolderPrompt', { path: 'finance/2026/q3.csv', folder: 'users/olga' }))
    await expect(page.getByTestId('attachment-chip')).toContainText('pending.txt')
    expect(await mutations(page)).toEqual(before)
    release()
    await expect(page.getByTestId('attachment-chip')).not.toContainText('%')
    await expect(page.getByTestId('send')).toBeEnabled()
    await expect(messages(page).getByTestId('user-message')).toHaveCount(1)
  } finally {
    release()
  }
})
