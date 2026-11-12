// Member screens on a phone (QA TC-380, TC-381, TC-382 items 1–2) in Chromium (Android's engine); the cases are in
// phone-member-pages.cases.ts. Below them, a computer (1440) keeps what it had: project cards, the profile form with its
// photo buttons and its Save under the form, and the password button at its own width.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'
import { memberPageCases, shot, twoProjects } from './phone-member-pages.cases'

const en = DICTS.en

test.describe('a phone', () => {
  memberPageCases()
})

test.describe('a computer (1440) is unchanged', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })

  test('Projects: cards with the instructions line; a project\'s files address opens the Files screen there', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const { qa } = await twoProjects(page)
    await page.goto('/projects')
    await expect(page.getByTestId('project-card')).toHaveCount(2)
    await expect(page.getByTestId('project-row')).toHaveCount(0)
    await expect(page.getByTestId('project-card').filter({ hasText: 'QA 프로젝트' })).toContainText(en['projects.noInstructions'])
    await expect(page.getByTestId('project-new')).toContainText(en['projects.new'])
    await shot(page, 'desktop-projects')
    await page.goto(`/projects/${qa.id}/files`)
    await expect(page).toHaveURL(new RegExp(`/files\\?path=${encodeURIComponent(qa.folderPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  })

  test('Profile: the photo buttons beside the photo, framed fields, Save under the form; Change password at its own width', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/settings/profile')
    await expect(page.getByTestId('profile-photo-pick')).toHaveText(en['profile.photoChoose'])
    await expect(page.getByTestId('profile-fields')).toHaveCount(0)
    const name = page.getByTestId('profile-form').locator('input:not([type=file])').first()
    expect(await name.evaluate((el) => getComputedStyle(el).borderTopWidth)).not.toBe('0px')
    await shot(page, 'desktop-profile')
    await name.fill('Olga B')
    await expect(page.getByTestId('profile-form').getByTestId('profile-save')).toBeVisible()
    await page.goto('/settings/security')
    const button = page.getByTestId('password-submit')
    const field = (await page.getByTestId('password-new2').boundingBox())!
    expect((await button.boundingBox())!.width).toBeLessThan(field.width / 2)
    await shot(page, 'desktop-security')
  })
})
