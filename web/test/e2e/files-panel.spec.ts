// 파일 beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P3), with the server's `navRail` switch on:
// the places on the left (최근 파일, 팀 폴더, 프로젝트 폴더, 내 파일, 휴지통), the folder or the file on the right, the place
// on screen marked. The person's own folder is "내 파일" (decision Q4), on the list and in the folder's own rows. With
// the switch off the Files page is as it was ("내 폴더", its tabs; files.spec.ts and the other suites run with it off).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko

async function start(page: Page, on = true) {
  await page.setViewportSize({ width: 1440, height: 860 })
  await reset(page)
  await navRail(page, on)
  await signIn(page)
}
const panel = (page: Page) => page.getByTestId('files-panel')

test('the places: 최근 파일, the team\'s top folders, project folders, 내 파일, 휴지통; the one on screen is marked', async ({ page }) => {
  await start(page)
  await page.request.post('/api/projects', { headers: { [CSRF_HEADER]: '1' }, data: { name: '출시 준비' } })
  await page.request.post('/__test/file', { data: { path: 'marketing/캠페인 시안.md', text: '# 시안' } })
  await page.getByTestId('rail-files').click()
  await expect(panel(page)).toBeVisible()
  await expect(page.getByTestId('rail-files')).toHaveAttribute('aria-current', 'page')
  await expect(panel(page).getByTestId('files-panel-recent')).toHaveText(t['filesPanel.recent'])
  // the team's top folders, not the projects folder or users/ (they have their own rows)
  const team = await panel(page).getByTestId('files-panel-team').allTextContents()
  expect(team).toContain('marketing')
  expect(team).not.toContain('개인')
  expect(team).not.toContain('프로젝트')
  await expect(panel(page).getByTestId('files-panel-project')).toHaveText(['출시 준비'])
  await expect(panel(page).getByTestId('files-panel-mine')).toHaveText('내 파일')
  await expect(panel(page).getByTestId('files-panel-trash')).toHaveText(t['files.trash'])
  // a team folder: its rows on the right, its row marked (a folder inside it too)
  await panel(page).getByTestId('files-panel-team').filter({ hasText: 'marketing' }).click()
  await expect(page).toHaveURL(/\/files\?path=marketing$/)
  await expect(panel(page).getByTestId('files-panel-team').filter({ hasText: 'marketing' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('캠페인 시안.md')).toBeVisible()
  // no tabs on the page: the trash is a place on the list
  await expect(page.getByRole('tab', { name: t['files.trash'] })).toHaveCount(0)
  // 내 파일: the own folder, named so on the page too
  await panel(page).getByTestId('files-panel-mine').click()
  await expect(page).toHaveURL(/\/files\?path=users%2Folga$/)
  await expect(panel(page).getByTestId('files-panel-mine')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('main').getByText('내 파일').first()).toBeVisible()
  // 휴지통: the page says so
  await panel(page).getByTestId('files-panel-trash').click()
  await expect(page).toHaveURL(/\/files\?view=trash$/)
  await expect(page.locator('main h1')).toHaveText(t['files.trash'])
  // 최근 파일: the files that changed last, where each is; one opens in its folder with its preview
  await panel(page).getByTestId('files-panel-recent').click()
  await expect(page.getByTestId('recent-files')).toBeVisible()
  await expect(panel(page).getByTestId('files-panel-recent')).toHaveAttribute('aria-current', 'page')
  const row = page.getByTestId('recent-file').filter({ hasText: '캠페인 시안.md' })
  await expect(row.getByTestId('recent-file-where')).toHaveText('marketing')
  await row.click()
  await expect(page).toHaveURL(/\/files\?path=marketing/)
  await expect(page.getByTestId('side-panel').or(page.getByTestId('file-panel')).first()).toBeVisible()
})

test('with the switch off, Files is the page it was: its tabs, "내 폴더", no panel', async ({ page }) => {
  await start(page, false)
  await page.goto('/files?path=users%2Folga')
  await expect(page.getByRole('tab', { name: t['files.trash'] })).toBeVisible()
  await expect(page.locator('main').getByText('내 폴더').first()).toBeVisible()
  await expect(panel(page)).toHaveCount(0)
})
