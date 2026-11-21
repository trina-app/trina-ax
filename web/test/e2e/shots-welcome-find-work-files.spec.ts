// Screenshots of the welcome card's optional "Bring work files from this computer" row (docs/DECISIONS.md "The welcome
// card brings work files from this computer"), for reviewing it by eye: the card with the row, the dialog it opens, the
// row done; at 1440 and 390 (no row at 390; a dialog opened on a wide window stays when it is made narrow), light and
// dark. Only when WELCOME_FILES_SHOTS names a folder to write them to.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { answer, fakeApp, look, notNow, type Meta } from './fake-work-files'

const dir = process.env.WELCOME_FILES_SHOTS
test.skip(!dir, 'WELCOME_FILES_SHOTS is not set')

const BOB = { username: 'bob', password: 'bob password 1' }
const EVERYONE = '01900000-0000-7000-8000-0000000000a1'
const FOUND: Meta[] = [
  { name: 'Acme quote template 2026.xlsx', folder: 'Sales' }, { name: 'Brand guide v3.pdf', folder: 'Acme/Brand' },
  { name: 'Weekly report - Nov 10.docx', root: 'downloads' }, { name: 'payslip_oct.pdf', root: 'downloads' },
]

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 390] as const) {
    test(`welcome files row · ${width} · ${scheme}`, async ({ page }) => {
      const shot = async (name: string) => page.screenshot({ path: `${dir}/${width}-${scheme}-${name}.png` })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await fakeApp(page)
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await page.request.post('/__test/member-welcome', { data: { welcome: {
        team: 'Acme', inviter: { id: 'olga', name: 'Olga' }, people: 3, rooms: [{ id: EVERYONE, kind: 'all', name: null }],
        owner: { id: 'olga', name: 'Olga' }, steps: { rooms: true, hi: false, photo: false, asked: false }, allSet: false,
      } } })
      await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })
      await signIn(page, BOB)
      await page.goto('/')
      await expect(page.getByTestId('member-welcome-files')).toBeVisible()
      if (width === 1440) await shot('1-card-row')
      await look(page, FOUND)
      await page.getByTestId('member-welcome-files-button').click()
      await answer(page, 'look')
      await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
      await expect(page.getByTestId('find-work-ai')).toBeVisible()
      if (width === 390) {
        // a narrow window: the dialog stays open; the row goes
        await page.setViewportSize({ width: 390, height: 844 })
        await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
      }
      await shot('2-dialog-list')
      await page.getByTestId('find-work-row').filter({ hasText: 'Acme quote template 2026.xlsx' }).getByTestId('find-work-check').check()
      await page.getByTestId('find-work-add').click()
      await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
      await notNow(page)
      await shot('3-added')
      await page.getByTestId('find-work-done').click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      if (width === 390) {
        await expect(page.getByTestId('member-welcome')).toBeVisible()
        await expect(page.getByTestId('member-welcome-files')).toHaveCount(0)
        await shot('1-card-no-row')
      } else {
        await expect(page.getByTestId('member-welcome-files')).toHaveAttribute('data-done', 'true')
        await shot('4-card-row-done')
      }
    })
  }
}
