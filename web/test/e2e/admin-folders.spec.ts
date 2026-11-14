// Admin › Folder permissions › Folders (docs/DECISIONS.md "드라이브처럼 공유 P1.5"): only the folders with their own
// sharing, in Files' names, Limited marked, who in one line, [Share] opening the same Share dialog as Files; a group's
// own folder as it was made is not listed; team projects' folders are one line to Projects; `?edit=<path>` and the old
// `?folder=<path>` open a folder's dialog; a one-time notice lists folders whose old rows give someone less than the
// folder above, and the dialog's Fix changes nobody's access. The answers are the mock's (server/src/policy/access.ts).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { TOP_FOLDER_LABELS } from '@mycel/shared'
import { DICTS, translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const en = (k: keyof typeof DICTS.en, p?: Record<string, string | number>) => translate('en', k, p)
const call = async (page: Page, method: 'post' | 'patch', url: string, data: unknown) => {
  const r = await page.request[method](url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.ok(), `${method} ${url}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}
const everyone = (access: 'read' | 'write') => ({ subjectType: 'everyone', subjectId: null, access })
const user = (id: string, access: 'read' | 'write') => ({ subjectType: 'user', subjectId: id, access })
const folderRow = (page: Page, path: string) => page.getByTestId('folders-row').and(page.locator(`[data-path="${path}"]`))
const panel = (page: Page) => page.getByTestId('folder-access-panel')

/** Bob and Carol (members, group Sales, whose own folder is groups/Sales); shared: everyone at Acme can edit;
 * marketing: limited, only Bob (Editor); finance (seed): 재무팀 can view; docs: everyone can edit */
async function team(page: Page) {
  const sales = (await call(page, 'post', '/api/admin/groups', { name: 'Sales', memberIds: ['bob'] })) as { id: string }
  await call(page, 'post', '/api/admin/users', { username: 'carol', name: 'Carol', role: 'member', groupIds: [sales.id], temporaryPassword: 'tiger4271x' })
  await call(page, 'patch', '/api/admin/users/bob', { groupIds: [sales.id] })
  await call(page, 'post', '/__test/file', { path: 'docs/old/a.md', text: 'a' })
  await call(page, 'post', '/api/admin/folders', { path: 'shared', create: true, rules: [everyone('write')] })
  await call(page, 'post', '/api/admin/folders', { path: 'marketing', create: false, rules: [user('bob', 'write')], limited: true })
  await call(page, 'post', '/api/admin/folders', { path: 'docs', create: false, rules: [everyone('write')] })
  return sales
}

test.beforeEach(async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
})

test('the list: only folders with their own sharing, in Files\' names, Limited marked, who in one line; search', async ({ page }) => {
  const errors = watchConsole(page)
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders')
  await expect(page.getByRole('tab', { name: t['folders.tabFolders'], exact: true })).toHaveAttribute('aria-selected', 'true')
  // Files' order and names; groups/Sales as it was made and folders without a rule of their own are not listed
  await expect(page.getByTestId('folders-row')).toHaveCount(4)
  expect(await page.getByTestId('folders-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-path')))).toEqual(['shared', 'docs', 'finance', 'marketing'])
  await expect(folderRow(page, 'groups/Sales')).toHaveCount(0)
  await expect(folderRow(page, 'secret')).toHaveCount(0)
  await expect(folderRow(page, 'shared').getByTestId('folder-crumbs')).toHaveText(TOP_FOLDER_LABELS.shared.en)
  // who, in one line
  // (a folder that is not limited also gets what the folder above gives: "+ the folder above"; a limited one only its own)
  await expect(folderRow(page, 'shared').getByTestId('folders-row-who')).toHaveText(`${en('folders.whoEveryone', { team: 'Acme', role: t['folderAccess.canEdit'] })} ${t['folders.plusAbove']}`)
  await expect(folderRow(page, 'marketing').getByTestId('folders-row-who')).toHaveText(`Bob · ${t['folderAccess.canEdit']}`)
  await expect(folderRow(page, 'finance').getByTestId('folders-row-who')).toHaveText(`재무팀 · ${t['folderAccess.canView']} ${t['folders.plusAbove']}`)
  // only a limited folder is marked (the review cut "Shared with more" and "Whole team")
  await expect(folderRow(page, 'marketing').getByTestId('folder-kind')).toHaveText(t['folders.kindLimited'])
  for (const p of ['shared', 'docs', 'finance']) await expect(folderRow(page, p).getByTestId('folder-kind')).toHaveCount(0)
  // no rule words anywhere on the page
  for (const w of ['No access', 'Narrow', 'Rule on this folder', 'groups/', 'users/']) await expect(page.getByTestId('folders-list')).not.toContainText(w)

  // search: by the folder's name and by who
  await page.getByTestId('folders-search').fill('market')
  await expect(page.getByTestId('folders-row')).toHaveCount(1)
  await expect(folderRow(page, 'marketing')).toBeVisible()
  await page.getByTestId('folders-search').fill('재무')
  await expect(page.getByTestId('folders-row')).toHaveCount(1)
  await expect(folderRow(page, 'finance')).toBeVisible()
  await page.getByTestId('folders-search').fill('nothing like this')
  await expect(page.getByTestId('folders-row')).toHaveCount(0)
  await expect(page.getByText(t['folders.noMatch'])).toBeVisible()
  expect(realErrors(errors)).toEqual([])
})

test('[Share] opens the folder\'s Share dialog over the list, and closing it leaves the address', async ({ page }) => {
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders')
  await folderRow(page, 'marketing').getByTestId('folders-share').click()
  await expect(page).toHaveURL(/[?&]edit=marketing/)
  await expect(panel(page)).toHaveAttribute('data-path', 'marketing')
  await expect(page.getByRole('dialog', { name: en('folderAccess.title', { name: 'marketing' }) })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await expect(page).not.toHaveURL(/edit=/)
  await expect(folderRow(page, 'marketing')).toBeVisible()
})

test('the address: ?edit= and the old ?folder= open a folder\'s Share dialog; a team project\'s folders are one line', async ({ page }) => {
  await signIn(page)
  await team(page)
  await page.goto('/admin/folders?folder=marketing')
  await expect(panel(page)).toHaveAttribute('data-path', 'marketing')
  await expect(page.getByTestId('sharing')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)
  await expect(page).not.toHaveURL(/folder=/)
  // a folder no list shows (no rule of its own) opens too: General access as docs gives it, and where from
  await page.goto('/admin/folders?edit=docs%2Fold')
  await expect(panel(page)).toHaveAttribute('data-path', 'docs/old')
  await page.keyboard.press('Escape')

  // team projects: one line to Projects, never a folder row of their own
  await call(page, 'post', '/api/projects', { name: 'Kite', participants: [{ subjectType: 'user', subjectId: 'bob' }] })
  await call(page, 'post', '/api/projects', { name: 'Falcon', participants: [{ subjectType: 'user', subjectId: 'carol' }] })
  await page.goto('/admin/folders')
  const projects = page.getByTestId('folders-projects')
  await expect(projects).toContainText(t['folders.projects'])
  await expect(projects).toContainText('· 2')
  await expect(projects).toContainText(t['folders.projectsLine'])
  await expect(page.getByTestId('folders-row').and(page.locator('[data-path^="projects/"]'))).toHaveCount(0)
  await projects.getByRole('link').click()
  await expect(page).toHaveURL(/\/projects$/)
})


test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
  test('375px: the list and [Share] fit; the Share dialog opens over it', async ({ page }) => {
    await signIn(page)
    await team(page)
    await page.goto('/admin/folders')
    await expect(folderRow(page, 'marketing')).toBeVisible()
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
    const share = folderRow(page, 'marketing').getByTestId('folders-share')
    expect((await share.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await share.tap()
    await expect(panel(page)).toHaveAttribute('data-path', 'marketing')
    await expect(page.getByTestId('sharing-done')).toBeInViewport()
  })
})
