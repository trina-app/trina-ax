// Tooltips that stayed on a phone-sized screen (QA N5, guest UX audit: a dialog's "Close", the side chat's history
// button): focus that a tap or click moved shows no tip, only focus after a key does; a tap or click anywhere takes a
// tip away (components/Tooltip.tsx).
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ viewport: { width: 390, height: 844 } })

test('a dialog opened with a click or tap focuses its close button without a tip; a key shows tips again, a tap hides them', async ({ page }) => {
  await reset(page)
  const r = await page.request.post('/__test/project', { data: { name: '견적 준비', by: 'olga', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  const { id } = (await r.json()) as { id: string }
  await signIn(page)
  await page.goto(`/projects/${id}`)
  await page.getByTestId('project-header-open').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.waitForTimeout(600)
  await expect(page.getByTestId('tooltip')).toHaveCount(0)
  // the keyboard: Tab to a control with a tip, then Shift+Tab back to the close button: its tip shows
  const close = page.getByRole('dialog').getByRole('button', { name: '닫기' }).first()
  await close.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(close).toBeFocused()
  await expect(page.getByTestId('tooltip')).toHaveText('닫기')
  // a tap somewhere else in the dialog: gone
  await page.getByRole('dialog').getByRole('heading').first().click()
  await expect(page.getByTestId('tooltip')).toHaveCount(0)
})
