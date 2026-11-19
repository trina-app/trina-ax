// Settings › Connectors (pages/Connectors.tsx, opened from Settings, not by its address): "Add custom connector" (a
// service by its address) next to the search for an owner and an admin, and it opens the add dialog; a member has no
// Add and reads "Not listed? Ask an admin to add it." in its place, not under Discover's last card (docs/DECISIONS.md
// "Plain words for members"; an owner asked 2026-11-18 why a member's screen had no Add). On a computer and at 390.
import { expect, test, type Page } from '@playwright/test'
import { OWNER, realErrors, reset, signIn, watchConsole } from './helpers'
import { isPhone, openSettings } from './nav'

const ADMIN = { username: 'dana', password: 'dana password 1' }
const MEMBER = { username: 'bob', password: 'bob password 1' }
const header = (page: Page) => page.getByTestId('connectors-header')

/** Settings, then its Connectors section, the way a person gets there */
async function openConnectors(page: Page) {
  await openSettings(page)
  if (isPhone(page)) await page.getByTestId('settings-row-connectors').click()
  else await page.getByTestId('settings-dialog').getByRole('link', { name: '커넥터', exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/connectors$/)
  await expect(page.getByTestId('connector-discover')).toBeVisible()
}

for (const phone of [false, true]) {
  test.describe(phone ? '390' : 'computer', () => {
    if (phone) test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

    for (const who of [OWNER, ADMIN]) {
      test(`${who.username} (${who === OWNER ? 'owner' : 'admin'}) sees Add custom connector next to the search and it opens the add dialog`, async ({ page }) => {
        await reset(page, { withAdmin: true })
        const errors = watchConsole(page)
        await signIn(page, who)
        await openConnectors(page)
        const add = header(page).getByTestId('integration-add')
        await expect(add).toBeVisible()
        await expect(add).toHaveText('직접 커넥터 추가')
        await expect(page.getByTestId('connector-not-listed')).toHaveCount(0)
        await add.click()
        const dialog = page.getByRole('dialog', { name: '주소로 서비스 추가' })
        await expect(dialog.getByTestId('integration-name')).toBeVisible()
        await expect(dialog.getByTestId('integration-url')).toBeVisible()
        await dialog.getByRole('button', { name: '취소' }).click()
        await expect(dialog).toHaveCount(0)
        expect(realErrors(errors)).toEqual([])
      })
    }

    test('a member has no Add, and reads where to go next to the search', async ({ page }) => {
      await reset(page)
      const errors = watchConsole(page)
      await signIn(page, MEMBER)
      await openConnectors(page)
      await expect(page.getByTestId('integration-add')).toHaveCount(0)
      const hint = header(page).getByTestId('connector-not-listed')
      await expect(hint).toHaveText('목록에 없나요? 관리자에게 추가해 달라고 해 주세요.')
      await expect(hint).toBeInViewport()
      // once on screen: not again under Discover or under "Nothing matches"
      await expect(page.getByTestId('connector-not-listed')).toHaveCount(1)
      await page.getByTestId('connector-search').fill('zzz-nothing')
      await expect(page.getByTestId('connector-ask-admin')).toHaveCount(1)
      await expect(page.getByTestId('connector-ask-admin')).toHaveText('관리자에게 추가해 달라고 해 주세요.')
      // (a 404: the mock's file tree asks for the 재무팀 folder "finance", which Bob cannot see; integrations.spec.ts too)
      expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
    })
  })
}
