// The team menu for every role (docs/decisions/20261118-team-menu-for-members.md; the owner 2026-11-18: "어드민 아니어도
// 팀 바꾸고 할 수는 있어야"): in a plain browser a member's logo opens the menu with Switch team and no admin item, the
// owner's still has Invite people and Admin; Switch team opens the address dialog, which opens the other team in this
// tab; on a phone (390 px) the 나 tab's team group has the same row for a member, with no 팀원 초대 or 관리자.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { navRail, OWNER, reset, signIn } from './helpers'
import { openTab } from './nav'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const MEMBER = { username: 'bob', password: 'bob password 1' }

async function start(page: Page, width: number, who?: typeof MEMBER) {
  await page.setViewportSize({ width, height: 860 })
  await reset(page)
  await navRail(page)
  await signIn(page, who)
}

test('member (1440): the logo opens the team menu with Switch team only; the dialog opens another team in this tab', async ({ page }) => {
  await start(page, 1440, MEMBER)
  const button = page.getByTestId('team-menu')
  await expect(button).toHaveAttribute('aria-haspopup', 'menu')
  await button.click()
  const menu = page.getByTestId('team-dropdown')
  await expect(menu.getByRole('menuitem')).toHaveText([t['teamMenu.switch']])
  for (const id of ['team-menu-invite', 'team-menu-admin']) await expect(page.getByTestId(id)).toHaveCount(0)
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  expect((await new AxeBuilder({ page }).include('[data-testid="team-dropdown"]').analyze()).violations).toEqual([])
  await page.getByTestId('team-menu-switch').click()
  await expect(menu).toHaveCount(0)
  const dialog = page.getByRole('dialog', { name: t['teamMenu.switch'] })
  await expect(dialog).toContainText(t['teamSwitch.body'])
  const input = dialog.getByTestId('dialog-input')
  await expect(input).toBeFocused()
  await input.fill('me@example.com')
  await expect(dialog.getByRole('alert')).toHaveText(t['teamSwitch.problem.email'])
  await expect(dialog.getByTestId('dialog-confirm')).toBeDisabled()
  // the other team: the page leaves for it (answered here, so the test never reaches the network)
  await page.route('https://beta.trina.app/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>beta</title>other team' }))
  await input.fill('beta')
  await dialog.getByTestId('dialog-confirm').click()
  await expect(page).toHaveURL('https://beta.trina.app/')
})

test('owner (1440): the team menu still has Invite people and Admin, then Switch team', async ({ page }) => {
  await start(page, 1440, OWNER)
  await page.getByTestId('team-menu').click()
  await expect(page.getByTestId('team-dropdown').getByRole('menuitem')).toHaveText([t['teamMenu.invite'], t['sidebar.admin'], t['teamMenu.switch']])
  await page.getByTestId('team-menu-admin').click()
  await expect(page).toHaveURL(/\/admin/)
})

test('member (390): the 나 tab has Switch team in the team group, no 팀원 초대 or 관리자; the dialog opens from there', async ({ page }) => {
  await start(page, 390, MEMBER)
  await openTab(page, 'me')
  const group = page.getByTestId('settings-team-group')
  await expect(group.getByTestId('settings-switch-team')).toContainText(t['teamMenu.switch'])
  for (const id of ['settings-invite', 'settings-admin']) await expect(page.getByTestId(id)).toHaveCount(0)
  await group.getByTestId('settings-switch-team').click()
  const dialog = page.getByRole('dialog', { name: t['teamMenu.switch'] })
  await expect(dialog.getByTestId('dialog-input')).toBeVisible()
  // the sheet fits the phone's width
  const box = (await dialog.boundingBox())!
  expect(box.width).toBeLessThanOrEqual(390)
  await dialog.getByTestId('dialog-cancel').click()
  await expect(dialog).toHaveCount(0)
})
