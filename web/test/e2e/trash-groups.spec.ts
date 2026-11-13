// Files › Trash (QA TC-1040): names and places instead of paths, repeats of one file as one row with its copies,
// "Deleted by me / Everyone" for whoever sees other people's deletes, one line on how long items stay. An admin and a
// member each restore one copy of a group.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { openFilesPlace } from './nav'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.en
const H = { [CSRF_HEADER]: '1' }
const ADMIN = { username: 'dana', password: 'dana password 1' }
const MEMBER = { username: 'bob', password: 'bob password 1' }

const put = async (page: Page, path: string, text = 'x') => expect((await page.request.post('/__test/file', { headers: H, data: { path, text } })).ok()).toBeTruthy()
const trash = async (page: Page, path: string) => expect((await page.request.delete(`/api/files?path=${encodeURIComponent(path)}`, { headers: H })).ok()).toBeTruthy()
/** sign in as someone else (the session cookie of the one before is dropped first) */
async function as(page: Page, who: { username: string; password: string }) {
  await page.context().clearCookies()
  await signIn(page, who)
}
const item = (page: Page, path: string) => page.locator(`[data-testid="trash-item"][data-path="${path}"]`)

/** price-sheet.xlsx deleted three times (by `who`, in turn), a team skill and a group folder by the admin */
async function seed(page: Page, who: { username: string; password: string }[]) {
  for (const [i, p] of who.entries()) {
    await as(page, p)
    await put(page, 'shared/Sales/price-sheet.xlsx', 'x'.repeat(100 * (i + 1)))
    await trash(page, 'shared/Sales/price-sheet.xlsx')
  }
}

test('an admin: names and places, one row for three copies, restores the oldest copy, then "Deleted by me"', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await seed(page, [ADMIN, MEMBER, ADMIN])
  // the latest delete is the admin's; a group folder and a team skill too
  await as(page, ADMIN)
  await put(page, 'groups/QA Sales/leads.csv')
  await put(page, 'skills/remotion-video.md')
  await trash(page, 'skills/remotion-video.md')
  await trash(page, 'groups/QA Sales')
  await page.goto('/files')
  await openFilesPlace(page, 'trash')

  // one plain line, the team's retention (30 days in the mock)
  await expect(page.getByTestId('trash-note')).toHaveText(translate('en', 'files.trashNoteDays', { days: 30 }))
  // name · place in the sidebar's words; no storage path anywhere
  await expect(item(page, 'groups/QA Sales').getByTestId('trash-name')).toHaveText('QA Sales')
  await expect(item(page, 'groups/QA Sales').getByTestId('trash-where')).toHaveText('Groups')
  await expect(item(page, 'skills/remotion-video.md').getByTestId('trash-where')).toHaveText('Team skills')
  const sheet = item(page, 'shared/Sales/price-sheet.xlsx')
  await expect(sheet).toHaveCount(1)
  await expect(sheet.getByTestId('trash-name')).toHaveText('price-sheet.xlsx')
  await expect(sheet.getByTestId('trash-where')).toHaveText('Company-wide › Sales')
  await expect(sheet.getByTestId('trash-copies')).toHaveText('3 copies')
  await expect(sheet).toContainText('Deleted by Dana')
  await expect(sheet.getByTestId('trash-purge')).toHaveText(/^removed in (29|30) days$/)
  await expect(page.getByTestId('trash-list')).not.toContainText(/(groups|shared|skills|users)\//)

  // open the row: three copies, newest first, each with who and its own Restore
  const toggle = sheet.getByTestId('trash-copies-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const copies = page.getByTestId('trash-copy')
  await expect(copies).toHaveCount(3)
  await expect(copies.nth(0)).toContainText('Deleted by Dana')
  await expect(copies.nth(1)).toContainText('Deleted by Bob')
  await expect(copies.nth(2)).toContainText('Deleted by Dana')
  await expect(copies.nth(2)).toContainText('100 B')
  // restore the oldest copy: it goes back to Company-wide › Sales, the row stays with 2 copies
  await copies.nth(2).getByTestId('trash-copy-restore').click()
  await expect(page.getByTestId('toast').filter({ hasText: translate('en', 'files.restoredTo', { path: 'Company-wide › Sales' }) })).toBeVisible()
  await expect(copies).toHaveCount(2)
  await expect(sheet.getByTestId('trash-copies')).toHaveText('2 copies')
  expect((await (await page.request.get('/api/files/trash')).json()).items.filter((x: { originalPath: string }) => x.originalPath === 'shared/Sales/price-sheet.xlsx')).toHaveLength(2)

  // Deleted by me: only Dana's (the price sheet's latest copy, the skill, the group folder)
  const mine = page.getByRole('tab', { name: t['files.trashMine'] })
  await expect(page.getByRole('tab', { name: t['files.trashEveryone'] })).toHaveAttribute('aria-selected', 'true')
  await mine.click()
  await expect(mine).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('trash-item')).toHaveCount(3)
  await expect(sheet.getByTestId('trash-copies')).toHaveCount(0)
  await expect(sheet).toContainText('Deleted by Dana')
  await page.getByRole('tab', { name: t['files.trashEveryone'] }).click()
  await expect(sheet.getByTestId('trash-copies')).toHaveText('2 copies')
})

test('a member: the row’s Restore brings back the latest copy; only their own deletes, no switch', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, MEMBER)
  for (const n of [1, 2]) {
    await put(page, 'users/bob/notes/todo.md', `v${n}`)
    await trash(page, 'users/bob/notes/todo.md')
  }
  await page.goto('/files')
  await openFilesPlace(page, 'trash')
  const todo = item(page, 'users/bob/notes/todo.md')
  await expect(todo.getByTestId('trash-name')).toHaveText('todo.md')
  await expect(todo.getByTestId('trash-where')).toHaveText('My files › notes')
  await expect(todo.getByTestId('trash-copies')).toHaveText('2 copies')
  // nobody else's deletes in this list: no "Deleted by me / Everyone"
  await expect(page.getByRole('tab', { name: t['files.trashMine'] })).toHaveCount(0)
  const before = (await (await page.request.get('/api/files/trash')).json()).items as { id: string; deletedAt: string }[]
  const latest = [...before].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt) || b.id.localeCompare(a.id))[0]!
  await todo.getByTestId('trash-restore').click()
  await expect(page.getByTestId('toast').filter({ hasText: translate('en', 'files.restoredTo', { path: 'My files › notes' }) })).toBeVisible()
  await expect(todo.getByTestId('trash-copies')).toHaveCount(0)
  const after = (await (await page.request.get('/api/files/trash')).json()).items as { id: string }[]
  expect(after.map((x) => x.id)).not.toContain(latest.id)
  expect(after).toHaveLength(1)
})

test('a member who shares a folder sees the switch; another person’s personal deletes never show', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await seed(page, [{ username: 'olga', password: 'correct horse battery' }])
  await put(page, 'users/olga/private.md')
  await trash(page, 'users/olga/private.md')
  await as(page, MEMBER)
  await page.goto('/files')
  await openFilesPlace(page, 'trash')
  await expect(item(page, 'shared/Sales/price-sheet.xlsx')).toContainText('Deleted by Olga')
  await expect(item(page, 'users/olga/private.md')).toHaveCount(0)
  await page.getByRole('tab', { name: t['files.trashMine'] }).click()
  await expect(page.getByText(t['files.trashMineEmpty'])).toBeVisible()
})

test('another person’s personal delete is never listed, not even to the owner or an admin; its owner sees it under My files', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await as(page, MEMBER)
  await put(page, 'users/bob/notes/todo.md')
  await trash(page, 'users/bob/notes/todo.md')
  await put(page, 'shared/Sales/price-sheet.xlsx')
  await trash(page, 'shared/Sales/price-sheet.xlsx')
  for (const who of [{ username: 'olga', password: 'correct horse battery' }, ADMIN]) {
    await as(page, who)
    await page.goto('/files')
    await openFilesPlace(page, 'trash')
    // bob's team-folder delete shows (so the list has loaded), his personal one does not
    await expect(item(page, 'shared/Sales/price-sheet.xlsx')).toContainText('Deleted by Bob')
    await expect(item(page, 'users/bob/notes/todo.md')).toHaveCount(0)
    await expect(page.getByTestId('trash-list')).not.toContainText('todo.md')
    await expect(page.getByTestId('trash-list')).not.toContainText('Personal')
    const listed = (await (await page.request.get('/api/files/trash')).json()).items as { originalPath: string }[]
    expect(listed.map((x) => x.originalPath)).not.toContain('users/bob/notes/todo.md')
  }
  await as(page, MEMBER)
  await page.goto('/files')
  await openFilesPlace(page, 'trash')
  await expect(item(page, 'users/bob/notes/todo.md').getByTestId('trash-where')).toHaveText('My files › notes')
})

test('390px: Restore keeps the page gutter, ending where the switch above it ends', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await seed(page, [ADMIN, MEMBER])
  await page.goto('/files?view=trash')
  const sheet = item(page, 'shared/Sales/price-sheet.xlsx')
  await sheet.getByTestId('trash-copies-toggle').click()
  await expect(page.getByTestId('trash-copy')).toHaveCount(2)
  const toggle = (await page.getByRole('tablist', { name: t['files.trashWho'] }).boundingBox())!
  const right = toggle.x + toggle.width
  const buttons = await page.locator('[data-testid="trash-restore"], [data-testid="trash-copy-restore"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))
  expect(buttons.length).toBe(3)
  for (const r of buttons) {
    expect(390 - r).toBeGreaterThanOrEqual(16)
    expect(Math.abs(r - right)).toBeLessThanOrEqual(1)
  }
  // the titles stay flush with the line above (the row's inset bleeds out on the left)
  const note = (await page.getByTestId('trash-note').boundingBox())!
  const icon = (await sheet.locator('[aria-hidden="true"]').first().boundingBox())!
  expect(Math.abs(icon.x - note.x)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

