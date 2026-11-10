// "Who can see it" on the Files page (docs/DECISIONS.md "Who can see a folder, in place"): the chip at the end of the
// breadcrumbs and the panel, for a member, their own folder, a team project's folder and an admin. The mock server keeps
// its own simple file policy; what a member may learn is checked on the real server (tests/security/folder-audience).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { TOP_FOLDER_LABELS } from '@mycel/shared'
import { DICTS, translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const t = DICTS.en
const en = (k: keyof typeof DICTS.en, p?: Record<string, string | number>) => translate('en', k, p)
const BOB = { username: 'bob', password: 'bob password 1' }
const post = async (page: Page, url: string, data: unknown) => expect((await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })).ok()).toBe(true)
const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })
const chip = (page: Page) => page.getByTestId('folder-access-chip')
const panel = (page: Page) => page.getByTestId('folder-access-panel')

test.beforeEach(async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
})

test('a member: a count where they can write, no names; the panel from the chip and from a row', async ({ page }) => {
  // marketing: Bob, Olga (owner) and Dana (admin); not Eve
  await post(page, '/__test/restrict', { path: 'marketing', users: ['bob', 'olga', 'dana'] })
  await signIn(page, BOB)
  await page.goto('/files?path=marketing')
  await expect(chip(page)).toHaveText(en('folderAccess.people', { n: 3 }))
  await expect(chip(page)).toHaveAccessibleName(en('folderAccess.peopleAll', { n: 3 }))
  await chip(page).click()
  await expect(panel(page)).toBeVisible()
  await expect(page.getByRole('dialog', { name: t['folderAccess.menu'] })).toBeVisible()
  await expect(page.getByTestId('folder-access-headline')).toHaveText(en('folderAccess.peopleAll', { n: 3 }))
  await expect(panel(page)).toContainText(t['folderAccess.adminsChange'])
  for (const name of ['Olga', 'Dana', 'Eve']) await expect(panel(page)).not.toContainText(name)
  await expect(page.getByTestId('folder-access-admin')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)

  // the same panel from the folder's row at the top, without going in
  await page.goto('/files')
  await row(page, 'marketing').hover()
  await row(page, 'marketing').getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: t['folderAccess.menu'] }).click()
  await expect(panel(page)).toHaveAttribute('data-path', 'marketing')
  await expect(page.getByTestId('folder-access-headline')).toHaveText(en('folderAccess.peopleAll', { n: 3 }))
  await page.keyboard.press('Escape')
  // no entry on users/ ("Personal", a container), and no chip at the root
  await row(page, TOP_FOLDER_LABELS.users.en).hover()
  await row(page, TOP_FOLDER_LABELS.users.en).getByTestId('file-menu').click()
  await expect(page.getByRole('menuitem', { name: t['folderAccess.menu'] })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(chip(page)).toHaveCount(0)
})

test('a plugin\'s managed folder: no chip, and its panel ends with no endless loading', async ({ page }) => {
  await post(page, '/__test/managed', { path: 'docs' })
  await signIn(page, BOB)
  await page.goto('/files?path=docs')
  await expect(page.getByTestId('crumb').last()).toBeVisible()
  await page.goto('/files')
  await row(page, 'docs').hover()
  await row(page, 'docs').getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: t['folderAccess.menu'] }).click()
  await expect(panel(page)).toContainText(t['folderAccess.adminsChange'])
  await expect(page.getByTestId('folder-access-headline')).toHaveCount(0)
  await expect(panel(page).locator('.animate-pulse')).toHaveCount(0)
  await page.goto('/files?path=docs')
  await expect(chip(page)).toHaveCount(0)
})

test('a member\'s own folder: only them, without asking', async ({ page }) => {
  await post(page, '/__test/file', { path: 'users/bob/note.md', text: 'mine' })
  await signIn(page, BOB)
  await page.goto('/files?path=users%2Fbob')
  await expect(chip(page)).toHaveText(t['folderAccess.onlyYou'])
  await chip(page).click()
  await expect(page.getByTestId('folder-access-headline')).toHaveText(t['folderAccess.onlyYou'])
  await expect(panel(page)).toContainText(t['folderAccess.ownFolder'])
})

test('the whole team, and a team project\'s folder with its own count and a way to the project', async ({ page }) => {
  await signIn(page, BOB)
  await page.goto('/files?path=docs')
  await expect(chip(page)).toHaveText(t['folderAccess.team'])
  const made = await page.request.post('/api/projects', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Kite', participants: [] } })
  expect(made.ok()).toBe(true)
  const p = (await made.json()) as { id: string; folderPath: string }
  const list = (await (await page.request.get('/api/projects')).json()) as { items: { id: string; audience?: number }[] }
  const audience = list.items.find((x) => x.id === p.id)!.audience!
  await page.goto(`/files?path=${encodeURIComponent(p.folderPath)}`)
  await expect(chip(page)).toHaveText(en('folderAccess.people', { n: audience }))
  await chip(page).click()
  await expect(page.getByTestId('folder-access-project')).toContainText(en('folderAccess.project', { name: 'Kite' }))
  await page.getByTestId('folder-access-open-project').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${p.id}`))
})

test('an admin: the people by name, where it comes from, the way to Admin', async ({ page, playwright }) => {
  await signIn(page)
  // a second member, Carol (an invite accepted in a context of her own)
  const inv = await page.request.post('/api/admin/invites', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'member' } })
  expect(inv.ok()).toBe(true)
  const carol = await playwright.request.newContext({ baseURL: new URL(page.url()).origin })
  expect((await carol.post(`/api/invites/${(await inv.json()).token}/accept`, { headers: { [CSRF_HEADER]: '1' }, data: { username: 'carol', name: 'Carol', password: 'carol password 1' } })).ok()).toBe(true)
  await carol.dispose()
  // marketing: only Bob of the members, the owner and the admins
  await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'user', subjectId: 'bob', access: 'write' }] })
  await page.goto('/files?path=marketing')
  await expect(chip(page)).toHaveText(en('folderAccess.people', { n: 4 }))
  await chip(page).click()
  const admin = page.getByTestId('folder-access-admin')
  await expect(admin).toBeVisible()
  await expect(page.getByTestId('folder-access-headline')).toHaveText(en('folderAccess.peopleAll', { n: 4 }))
  await expect(page.getByTestId('folder-access-source')).toHaveText(t['accessTree.source.here'])
  await expect(admin.getByTestId('folder-detail-counts')).toHaveText(en('accessTree.counts', { see: 4, write: 4, none: 1 }))
  await expect(admin.getByTestId('folder-person-link').filter({ hasText: 'Bob' })).toHaveAttribute('href', '/admin/folders?view=people&person=bob')
  await expect(admin.getByTestId('folder-person').filter({ hasText: 'Carol' })).toHaveAttribute('data-level', 'none')
  await page.getByTestId('folder-access-all').click()
  await expect(page).toHaveURL(/\/admin\/folders\?folder=marketing/)
  await expect(page.getByTestId('folder-detail')).toHaveAttribute('data-path', 'marketing')
})

test('an admin on a folder no member can open: owner and admins only', async ({ page }) => {
  await post(page, '/__test/restrict', { path: 'docs', users: ['olga', 'dana', 'eve'] })
  await signIn(page)
  await post(page, '/api/admin/folders', { path: 'docs', create: false, rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }] })
  await page.goto('/files?path=docs')
  await expect(chip(page)).toHaveText(t['accessTree.who.adminsOnly'])
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the chip after the crumbs and the panel as a bottom sheet', async ({ page }) => {
    await post(page, '/__test/restrict', { path: 'marketing', users: ['bob', 'olga', 'dana'] })
    await signIn(page, BOB)
    await page.goto('/files?path=marketing')
    await expect(chip(page)).toBeVisible()
    const box = (await chip(page).boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    await chip(page).tap()
    await expect(panel(page)).toBeVisible()
    await expect(page.getByTestId('folder-access-headline')).toHaveText(en('folderAccess.peopleAll', { n: 3 }))
  })
})
