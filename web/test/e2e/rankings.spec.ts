import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

test('accessible skill ranking goes first and fills its slash command without triggering a turn', async ({ page }) => {
  await reset(page)
  await page.route(/\/api\/skills(\?.*)?$/, r => r.fulfill({ json: { items: [
    { path: 'skills/proposal.md', name: 'proposal', description: 'Client proposal' },
    { path: 'skills/weekly-report/SKILL.md', name: 'weekly-report', description: 'Weekly report' },
  ] } }))
  await page.route('**/api/skills/popular', r => r.fulfill({ json: { days: 30, items: [
    { path: 'skills/weekly-report/SKILL.md', name: 'weekly-report', description: 'Weekly report', uses: 4, users: 2 },
  ] } }))
  await signIn(page)
  await page.goto('/skills')
  const row = page.getByTestId('skill-row').first()
  // a skill without a title reads as the name people type
  await expect(row.getByTestId('skill-name')).toHaveText('/weekly-report')
  await expect(row).toContainText('4회')
  await row.getByTestId('skill-use').click()
  await expect(page.getByTestId('composer-input')).toHaveValue('/weekly-report ')
  await expect(page.getByTestId('assistant-message')).toHaveCount(0)
})
