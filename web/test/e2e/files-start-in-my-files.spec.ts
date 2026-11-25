// 파일 opens 내 파일, like Drive's My Drive: upload first, share later (docs/decisions/20261125-upload-destination.md).
// The landing (owner and member), 내 파일 first in the places (computer list and phone tab), 최근 파일's one Upload that
// goes to 내 파일 without asking, the line after it with 옮기기 (the usual Move picker), 내 파일's empty state, and a
// guest (no 파일 place at all, as before).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { reset, signIn } from './helpers'
import { isPhone, openPlace } from './nav'

const t = DICTS.ko
const BOB = { username: 'bob', password: 'bob password 1' }
const ids = (page: Page) => page.getByTestId('files-panel').locator('[data-testid^="files-panel-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
const PLACES = ['files-panel-mine', 'files-panel-recent', 'files-panel-shared', 'files-panel-team', 'files-panel-project', 'files-panel-trash']

for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
  test.describe(`${vp.w}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h } })

    test('파일 starts at 내 파일, which is the first place; the team places follow', async ({ page }) => {
      await reset(page, { teamLocale: 'ko' })
      await signIn(page)
      await openPlace(page, 'files')
      await expect(page.getByTestId('files-panel-mine')).toBeVisible()
      await expect(page.getByTestId('files-panel-trash')).toBeVisible()
      const order = (await ids(page)).filter((id) => PLACES.includes(id!))
      expect(order[0]).toBe('files-panel-mine')
      expect(order.slice(1, 3)).toEqual(['files-panel-recent', 'files-panel-shared'])
      expect(order.at(-1)).toBe('files-panel-trash')
      if (!isPhone(page)) {
        await expect(page).toHaveURL(/\/files\?path=users%2Folga$/)
        await expect(page.getByTestId('files-panel-mine')).toHaveAttribute('aria-current', 'page')
      } else {
        // a phone's 파일 tab is its places; 내 파일 is its first row
        await expect(page.getByTestId('phone-files-home')).toBeVisible()
      }
    })

    test('a member: 최근 파일\'s Upload goes to 내 파일 without asking; one line says so, 옮기기 opens the Move picker', async ({ page }) => {
      await reset(page, { teamLocale: 'ko' })
      await signIn(page, BOB)
      // (the test server makes a person's own folder on first use; the team server has it from the start)
      await page.request.post('/api/files/mkdir', { headers: { [CSRF_HEADER]: '1' }, data: { path: 'users/bob' } })
      await page.goto('/files?path=users%2Fbob')
      // 내 파일 empty: who sees what goes here
      await expect(page.getByTestId('files-mine-empty')).toHaveText(t['files.mineEmpty'])
      await page.goto('/files?view=recent')
      await expect(page.getByTestId('recent-upload')).toBeVisible()
      await page.getByTestId('recent-upload-input').setInputFiles({ name: '견적서.txt', mimeType: 'text/plain', buffer: Buffer.from('quote') })
      await expect(page).toHaveURL(/\/files\?path=users%2Fbob$/)
      const line = page.getByTestId('upload-mine-line')
      await expect(line).toContainText(t['files.mineLanded'])
      await expect(line).toContainText(t['files.mineShareHint'])
      await expect(page.getByTestId('file-row').filter({ hasText: '견적서.txt' })).toBeVisible()
      await page.getByTestId('upload-mine-move').click()
      const picker = page.getByRole('dialog').filter({ hasText: '견적서.txt' })
      await expect(picker).toBeVisible()
      // at the team folder's places, not at 내 파일 where the file already is
      await expect(picker.getByText('marketing')).toBeVisible()
      await expect(line).toHaveCount(0)
    })

    test('an upload into a team folder keeps its usual rows, no 내 파일 line', async ({ page }) => {
      await reset(page, { teamLocale: 'ko' })
      await signIn(page)
      await page.goto('/files?path=marketing')
      await page.locator('input[type="file"]').first().setInputFiles({ name: '팀자료.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
      await expect(page.getByTestId('file-row').filter({ hasText: '팀자료.txt' })).toBeVisible()
      await expect(page.getByTestId('upload-mine-line')).toHaveCount(0)
    })
  })
}

test('a guest has no 파일 place, so no 내 파일 landing or 최근 파일 upload (as before)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page, { teamLocale: 'ko' })
  expect((await page.request.post('/__test/project', { data: { name: '견적 준비', by: 'bob' } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'project', name: '견적 준비' }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
  await page.goto('/login')
  await page.getByTestId('login-username').fill('gina')
  await page.getByTestId('login-password').fill('gina password 1')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-submit')).toHaveCount(0)
  await expect(page.getByTestId('rail-files')).toHaveCount(0)
  await expect(page.getByTestId('recent-upload')).toHaveCount(0)
})
