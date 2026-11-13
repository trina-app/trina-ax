// Screenshots of the team invite link's details ("Manage link" opened in Invite people, and the Admin › Members
// popup), 1440 and 390 wide, light and dark, as an admin of the mock team, for reviewing by eye. Only when
// TEAM_LINK_MANAGE_SHOTS names a folder to write them to.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const dir = process.env.TEAM_LINK_MANAGE_SHOTS
test.skip(!dir, 'TEAM_LINK_MANAGE_SHOTS is not set')
test.use({ locale: 'en-US' })

const ADMIN = { username: 'dana', password: 'dana password 1' }

async function setUp(page: Page) {
  await reset(page, { withAdmin: true, teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, ADMIN)
  const h = { [CSRF_HEADER]: '1' }
  const leads = (await (await page.request.post('/api/admin/groups', { headers: h, data: { name: 'Leads' } })).json()) as { id: string }
  await page.request.post('/api/admin/team-link', { headers: h, data: { groupIds: [leads.id] } })
}

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`team link manage screenshots (${vp.name}, ${scheme})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await setUp(page)
      // Invite people (the team menu is on the computer's sidebar; the dialog stays open when the window narrows)
      await page.getByTestId('team-menu').click()
      await page.getByTestId('team-menu-invite').click()
      const invite = page.getByRole('dialog')
      await page.setViewportSize(vp.size)
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/c-invite-${vp.name}-${scheme}.png` })
      await invite.getByTestId('team-link-manage').click()
      const panel = invite.getByTestId('team-link-manage-panel')
      await expect(panel).toBeVisible()
      await panel.scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/a-invite-manage-${vp.name}-${scheme}.png` })
      await page.keyboard.press('Escape')
      // Admin › Members' popup: the same details in place
      await page.goto('/admin/members')
      const row = page.getByTestId('team-link-row')
      await expect(row).toBeVisible()
      await row.getByTestId('member-more').click()
      await page.getByTestId('team-link-row-open').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('team-link-groups')).toBeVisible()
      await dialog.getByTestId('team-link-groups').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/b-members-popup-${vp.name}-${scheme}.png` })
      await dialog.getByTestId('team-link-qr').click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/c-members-qr-${vp.name}-${scheme}.png` })
    })
  }
}
