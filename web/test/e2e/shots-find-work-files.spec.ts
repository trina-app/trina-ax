// Screenshots of Find work files on this computer (docs/DECISIONS.md "Find work files on this computer"), for reviewing
// it by eye: the My files line, the dialog while the app asks, the list (a folder macOS kept the app out of, a big folder,
// the personal group, Select all at its cap), the result with Undo, every folder blocked, and the owner's setup step; at
// 1440 light and dark, the dialogs at 390 too; the Full Disk Access screen in My files' words and the setup's. Only
// when FIND_WORK_SHOTS names a folder to write them to.
import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { answer, fakeApp, look, notNow, roots, setFullDisk, type Meta } from './fake-work-files'

const dir = process.env.FIND_WORK_SHOTS
test.skip(!dir, 'FIND_WORK_SHOTS is not set')

const BOB = { username: 'bob', password: 'bob password 1' }
const FOUND: Meta[] = [
  { name: 'Acme quote template 2026.xlsx', folder: 'Sales' }, { name: 'Brand guide v3.pdf', folder: 'Acme/Brand' }, { name: 'Weekly report - Nov 10.docx', root: 'downloads' },
  { name: 'Northwind proposal.pptx', folder: 'Clients/Northwind' }, { name: 'Onboarding policy.pdf', folder: 'Team' }, { name: 'Meeting minutes 11-04.docx', root: 'desktop' },
  { name: 'notes.txt', root: 'desktop' }, { name: 'payslip_oct.pdf', root: 'downloads' }, { name: 'Tax Return 2025.pdf' },
]
// part 5: the wide look's places, and the Full Disk Access screen
const WIDE: Meta[] = [
  { name: 'Acme Q3 plan.xlsx', root: 'cloud', place: 'OneDrive – Acme', folder: 'Plans' }, { name: 'Acme brand deck.pptx', root: 'cloud', place: 'OneDrive – Acme', cloud: true },
  { name: 'Acme quote 견적서.pdf', root: 'messenger', place: 'KakaoTalk' }, { name: 'Roadmap 2027.docx', root: 'folder', place: 'Acme' },
  { name: 'Acme ideas.md', root: 'home', place: '', folder: 'Notes' }, { name: 'Weekly report - Nov 10.docx', root: 'downloads' }, { name: 'payslip_oct.pdf', root: 'downloads' },
]
const WIDE_ROOTS = roots({ id: 'messenger', place: 'KakaoTalk', state: 'ok' }, { id: 'folder', place: 'Acme', state: 'ok' }, { id: 'cloud', place: 'OneDrive – Acme', state: 'ok' }, { id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok' }, { id: 'downloads', state: 'ok' })
const BLOCKED = roots({ id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok', cut: true }, { id: 'downloads', state: 'blocked' })

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 390] as const) {
    test(`find work files · ${width} · ${scheme}`, async ({ page }) => {
      const shot = async (name: string) => page.screenshot({ path: `${dir}/${width}-${scheme}-${name}.png` })
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await fakeApp(page)
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page, BOB)
      await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })
      await page.goto('/files?path=users%2Fbob')
      await look(page, FOUND, BLOCKED)
      // the line is for computers only; at 390 the dialog is opened as on a narrow desktop window (390 applies to dialogs)
      if (width === 1440) {
        await expect(page.getByTestId('files-find-work-entry')).toBeVisible()
        await shot('1-my-files-line')
        await page.getByTestId('files-find-work-entry').click()
      } else {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.getByTestId('files-find-work-entry').click()
        await page.setViewportSize({ width: 390, height: 844 })
      }
      await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
      await shot('2-asking')
      await answer(page, 'look')
      await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
      await shot('3-list')
      await page.getByTestId('find-work-personal-toggle').click()
      await page.getByTestId('find-work-personal').getByTestId('find-work-check').first().check()
      await page.getByTestId('find-work-select-all').click()
      await shot('4-ticked-personal-open')
      await page.getByTestId('find-work-add').click()
      await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'share')
      await shot('5-share')
      await notNow(page)
      await shot('5-added')
      await page.getByTestId('find-work-undo').click()
      await expect(page.getByTestId('find-work-undone-until')).toBeVisible()
      await shot('6-undone')
      await page.getByTestId('find-work-done').click()
      await look(page, [], roots({ id: 'documents', state: 'blocked' }, { id: 'desktop', state: 'blocked' }, { id: 'downloads', state: 'blocked' }))
      if (width === 390) await page.setViewportSize({ width: 1440, height: 900 })
      await page.getByTestId('files-find-work-entry').click()
      if (width === 390) await page.setViewportSize({ width: 390, height: 844 })
      await answer(page, 'look')
      await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'none')
      await shot('7-all-blocked')
    })
  }
  test(`setup step · 1440 · ${scheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: scheme })
    await fakeApp(page)
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/welcome')
    await page.getByTestId('welcome-profile').getByRole('button', { name: 'Do this later' }).click()
    await page.getByTestId('skills-later').click()
    await expect(page.getByTestId('welcome-team-files-computer')).toBeVisible()
    await page.screenshot({ path: `${dir}/1440-${scheme}-8-setup-start.png` })
    await look(page, FOUND, roots({ id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok' }, { id: 'downloads', state: 'ok' }))
    await page.getByTestId('welcome-team-files-computer').click()
    await answer(page, 'look')
    await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
    await page.screenshot({ path: `${dir}/1440-${scheme}-9-setup-list.png` })
  })
  for (const width of [1440, 390] as const) {
    test(`full disk access · ${width} · ${scheme}`, async ({ page }) => {
      const shot = async (name: string) => page.screenshot({ path: `${dir}/${width}-${scheme}-${name}.png` })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await fakeApp(page, { wide: true, fullDisk: 'denied' })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page, BOB)
      await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })
      await page.goto('/files?path=users%2Fbob')
      await look(page, WIDE, WIDE_ROOTS)
      await page.getByTestId('files-find-work-entry').click()
      if (width === 390) await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'ask')
      await shot('10-full-disk')
      await page.getByTestId('find-work-access-open').click()
      await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'waiting')
      await shot('11-full-disk-waiting')
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'restart')
      await shot('12-full-disk-reopen')
      await setFullDisk(page, 'granted')
      await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
      await answer(page, 'look')
      await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
      await expect(page.getByTestId('find-work-ai')).toBeVisible()
      await shot('13-wide-list')
    })
    // the setup's 팀 파일 step (the owner, files for the team): the same screen in the team's words (QA TC-3098); a
    // computer's width only (on a narrow window the step has no Find work files)
    if (width === 1440) test(`full disk access · setup · ${width} · ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: scheme })
      await fakeApp(page, { wide: true, fullDisk: 'denied' })
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await page.goto('/welcome')
      await page.getByTestId('welcome-profile').getByRole('button', { name: 'Do this later' }).click()
      await page.getByTestId('skills-later').click()
      await page.getByTestId('welcome-team-files-computer').click()
      await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'ask')
      await page.screenshot({ path: `${dir}/${width}-${scheme}-14-full-disk-team.png` })
    })
  }
}
