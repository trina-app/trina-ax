// "Who can open it" on the Files page (docs/DECISIONS.md "Who can see a folder, in place" and "Who can open it, like
// Drive's Share"): the chip at the end of the breadcrumbs and the panel, for a member, their own folder, a team
// project's folder and an admin, who changes it in place (add, change, remove, general access, the confirm before more
// access, rows from the folders above, a team project's folder only shown). The mock server keeps its own simple file
// policy; its edit previews are the server's own computation. What a member may learn and the save's checks are tested
// on the real server (tests/security/folder-audience, tests/security/folder-sharing).
import AxeBuilder from '@axe-core/playwright'
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
  await expect(page.getByTestId('folder-access-headline')).toHaveText(en('folderAccess.openCount', { n: 3 }))
  await expect(panel(page)).toContainText(t['folderAccess.adminsChange'])
  for (const name of ['Olga', 'Dana', 'Eve']) await expect(panel(page)).not.toContainText(name)
  // nothing of the admin's panel: no list, no general access, no "can view / can edit"
  await expect(page.getByTestId('sharing')).toHaveCount(0)
  for (const w of [t['folderAccess.canView'], t['folderAccess.canEdit'], t['folderAccess.general']]) await expect(panel(page)).not.toContainText(w)
  await page.keyboard.press('Escape')
  await expect(panel(page)).toHaveCount(0)

  // the same panel from the folder's row at the top, without going in
  await page.goto('/files')
  await row(page, 'marketing').hover()
  await row(page, 'marketing').getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: t['folderAccess.menu'] }).click()
  await expect(panel(page)).toHaveAttribute('data-path', 'marketing')
  await expect(page.getByTestId('folder-access-headline')).toHaveText(en('folderAccess.openCount', { n: 3 }))
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
  await expect(page.getByTestId('folder-access-headline')).toHaveText(t['folderAccess.onlyYouOpen'])
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

test('a team project\'s folder: whoever may change its members gets [Members] (#298\'s dialog); anyone else reads who does', async ({ page, browser }) => {
  await signIn(page)
  const made = await page.request.post('/api/projects', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Kite', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  const p = (await made.json()) as { id: string; folderPath: string }
  // Bob is in it but did not make it: the creator by name, as on the project page; no button
  const bob = await browser.newPage({ baseURL: new URL(page.url()).origin, locale: 'en-US' })
  await signIn(bob, BOB)
  await bob.goto(`/files?path=${encodeURIComponent(p.folderPath)}`)
  await chip(bob).click()
  await expect(bob.getByTestId('folder-access-members-hint')).toHaveText(en('projects.membersByCreator', { name: 'Olga' }))
  await expect(bob.getByTestId('folder-access-members')).toHaveCount(0)
  await bob.close()
  // Olga made it: [Members] opens the members dialog on the project page
  await page.goto(`/files?path=${encodeURIComponent(p.folderPath)}`)
  await chip(page).click()
  await expect(page.getByTestId('folder-access-members-hint')).toHaveCount(0)
  await page.getByTestId('folder-access-members').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${p.id}`))
  await expect(page.getByRole('dialog')).toContainText('Kite')
  await expect(page.getByTestId('folder-access-panel')).toHaveCount(0)
})

test('a project made before outside projects/: an admin reads where its members are changed, and changes who can open it here', async ({ page }) => {
  await signIn(page)
  const made = await page.request.post('/api/projects', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Old docs', folderPath: 'docs', participants: [] } })
  expect(made.ok()).toBe(true)
  await page.goto('/files?path=docs')
  await chip(page).click()
  await expect(page.getByTestId('folder-access-project')).toContainText(en('folderAccess.project', { name: 'Old docs' }))
  await expect(page.getByTestId('folder-access-members-hint')).toHaveText(en('projects.legacyNote', { folder: 'docs' }))
  await expect(page.getByTestId('folder-access-members')).toHaveCount(0)
  await expect(page.getByTestId('sharing')).toBeVisible()
})

test('a member with write and an admin on the same folder: the same people, the chip apart for the admin only', async ({ page, browser, playwright }) => {
  await signIn(page)
  const inv = await page.request.post('/api/admin/invites', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'member' } })
  const c = await playwright.request.newContext({ baseURL: new URL(page.url()).origin })
  expect((await c.post(`/api/invites/${(await inv.json()).token}/accept`, { headers: { [CSRF_HEADER]: '1' }, data: { username: 'carol', name: 'Carol', password: 'carol password 1' } })).ok()).toBe(true)
  await c.dispose()
  await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'everyone', subjectId: null, access: 'none' }, { subjectType: 'user', subjectId: 'bob', access: 'write' }] })
  // Olga (owner): Bob by the rule; Dana, Eve and herself by role; not Carol. The chip apart, the panel the total
  await page.goto('/files?path=marketing')
  await expect(chip(page)).toHaveText(en('folderAccess.direct', { n: 1 }))
  await chip(page).click()
  // the admin's panel is the list (no total): Bob can edit
  await expect(page.getByTestId('sharing-row').and(page.locator('[data-subject="user:bob"]'))).toBeVisible()
  // Bob (a member who writes there), in a window of his own: the same 4 people as one total, the owner and admins in
  // it, and no number for them on its own (the server sends him no split)
  const bob = await browser.newPage({ baseURL: new URL(page.url()).origin, locale: 'en-US' })
  await signIn(bob, BOB)
  await bob.goto('/files?path=marketing')
  await expect(chip(bob)).toHaveText(en('folderAccess.people', { n: 4 }))
  await chip(bob).click()
  await expect(bob.getByTestId('folder-access-headline')).toHaveText(en('folderAccess.openCount', { n: 4 }))
  await expect(bob.getByTestId('sharing')).toHaveCount(0)
  const told = (await (await bob.request.get('/api/files/audience?path=marketing')).json()) as Record<string, unknown>
  expect(told).toEqual({ path: 'marketing', access: 'write', people: 4, everyone: false })
  await bob.close()
})

/** Carol, a second member: an invite accepted in a context of her own (the page stays signed in as the admin) */
async function addCarol(page: Page, playwright: import('@playwright/test').PlaywrightWorkerArgs['playwright']) {
  const inv = await page.request.post('/api/admin/invites', { headers: { [CSRF_HEADER]: '1' }, data: { role: 'member' } })
  expect(inv.ok()).toBe(true)
  const c = await playwright.request.newContext({ baseURL: new URL(page.url()).origin })
  expect((await c.post(`/api/invites/${(await inv.json()).token}/accept`, { headers: { [CSRF_HEADER]: '1' }, data: { username: 'carol', name: 'Carol', password: 'carol password 1' } })).ok()).toBe(true)
  await c.dispose()
}

const rules = async (page: Page, p: string) => {
  const items = ((await (await page.request.get('/api/admin/folders')).json()) as { items: { path: string; rules: { subjectType: string; subjectId: string | null; access: string }[] }[] }).items
  return (items.find((f) => f.path === p)?.rules ?? []).map((r) => `${r.subjectType}:${r.subjectId ?? ''}:${r.access}`).sort()
}
const sharingRow = (page: Page, subject: string) => page.getByTestId('sharing-row').and(page.locator(`[data-subject="${subject}"]`))
const outcome = (page: Page) => page.getByTestId('sharing-outcome')
const confirm = (page: Page) => page.getByTestId('dialog-confirm')

test('an admin: add a person, change one, save with the confirm; remove one, saved straight; general access', async ({ page, playwright }) => {
  await signIn(page)
  await addCarol(page, playwright)
  await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }] })
  await page.goto('/files?path=marketing')
  await chip(page).click()
  await expect(page.getByTestId('sharing')).toBeVisible()
  // like Drive's list: Bob, who can edit; general access as the team folder gives it (nobody else)
  await expect(sharingRow(page, 'user:bob').getByTestId('sharing-level')).toHaveValue('write')
  await expect(page.getByTestId('sharing-general-select')).toHaveValue('follow')
  await expect(page.getByTestId('sharing-general-select').locator('option:checked')).toHaveText(t['folderAccess.sameAsTop'])
  await expect(page.getByTestId('sharing-general-hint')).toHaveText(t['folderAccess.hintAboveOnly'])
  await expect(page.getByTestId('sharing-footer')).toHaveText(t['folderAccess.adminsAlways'])
  // no reasons, no counts line, no one who cannot open it, no paths
  for (const gone of ['Carol', 'Dana', 'Eve', 'Name only', 'Can open:']) await expect(page.getByTestId('sharing-list')).not.toContainText(gone)
  await expect(page.getByTestId('sharing-done')).toBeVisible()

  // add Carol: a row at the top with "Can view", and what will happen, by name
  await page.getByTestId('edit-add').fill('Car')
  await page.getByTestId('edit-add-option').filter({ hasText: 'Carol' }).click()
  await expect(page.getByTestId('sharing-row').first()).toHaveAttribute('data-subject', 'user:carol')
  await expect(sharingRow(page, 'user:carol').getByTestId('sharing-level')).toHaveValue('read')
  await expect(outcome(page)).toHaveText(en('folderAccess.willOpen', { names: 'Carol' }))
  // change Bob to "Can view": named before Save
  await sharingRow(page, 'user:bob').getByTestId('sharing-level').selectOption('read')
  await expect(outcome(page)).toContainText(en('folderAccess.willViewOnly', { names: 'Bob' }))
  // Save: more access asks first, by name; Give access saves
  await page.getByTestId('sharing-save').click()
  await expect(page.getByRole('dialog').filter({ hasText: en('folderAccess.confirmOpen', { n: 1 }) })).toBeVisible()
  await expect(page.getByTestId('sharing-confirm-body')).toContainText(en('folderAccess.willOpen', { names: 'Carol' }))
  await expect(confirm(page)).toHaveText(t['folderAccess.giveAccess'])
  await confirm(page).click()
  await expect(page.getByTestId('sharing-done')).toBeVisible()
  expect(await rules(page, 'marketing')).toEqual(['user:bob:read', 'user:carol:read'])
  // its own save is not "someone else's change"
  await page.waitForTimeout(500)
  await expect(page.getByTestId('sharing-stale')).toHaveCount(0)
  // the footer link can be brought into sight, not under the buttons
  await page.getByTestId('sharing-open-admin').scrollIntoViewIfNeeded()
  const link = (await page.getByTestId('sharing-open-admin').boundingBox())!
  const bar = (await page.getByTestId('sharing-footer-slot').boundingBox())!
  expect(link.y + link.height).toBeLessThanOrEqual(bar.y + 1)

  // remove Carol: only less access, saved without a question
  await sharingRow(page, 'user:carol').getByTestId('sharing-remove').click()
  await expect(outcome(page)).toHaveText(en('folderAccess.willLose', { names: 'Carol' }))
  await page.getByTestId('sharing-save').click()
  await expect(page.getByTestId('sharing-done')).toBeVisible()
  await expect(confirm(page)).toHaveCount(0)
  expect(await rules(page, 'marketing')).toEqual(['user:bob:read'])

  // general access: everyone at Acme can view; asks first
  await page.getByTestId('sharing-general-select').selectOption('read')
  await expect(page.getByTestId('sharing-general-hint')).toHaveText(en('folderAccess.hintEveryoneView', { team: 'Acme' }))
  await expect(outcome(page)).toContainText(en('folderAccess.willOpen', { names: 'Carol' }))
  await page.getByTestId('sharing-save').click()
  await confirm(page).click()
  await expect(page.getByTestId('sharing-done')).toBeVisible()
  expect(await rules(page, 'marketing')).toEqual(['everyone::read', 'user:bob:read'])
})

test('the confirm says who gains later by what they get: "open" for a group added as "Can view", "open or edit" for "Can edit" (QA TC-232)', async ({ page }) => {
  await signIn(page)
  // a group nobody is in yet: only whoever joins it later gains
  expect((await page.request.post('/api/admin/groups', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Design', memberIds: [] } })).ok()).toBe(true)
  await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] })
  await page.goto('/files?path=marketing')
  await chip(page).click()
  await page.getByTestId('edit-add').fill('Des')
  await page.getByTestId('edit-add-option').filter({ hasText: 'Design' }).click()
  await page.getByTestId('sharing-save').click()
  const body = page.getByTestId('sharing-confirm-body')
  await expect(body.getByTestId('sharing-confirm-latent')).toHaveText(en('folderAccess.latentGroupsView', { groups: 'Design' }))
  await expect(body).not.toContainText('edit')
  await page.getByRole('dialog').filter({ has: confirm(page) }).getByRole('button', { name: t['common.cancel'] }).click()
  // the same group with "Can edit": its future members can edit, said so
  await page.getByTestId('sharing-row').filter({ hasText: 'Design' }).getByTestId('sharing-level').selectOption('write')
  await page.getByTestId('sharing-save').click()
  await expect(body.getByTestId('sharing-confirm-latent')).toHaveText(en('folderAccess.latentGroups', { groups: 'Design' }))
  await confirm(page).click()
  await expect(page.getByTestId('sharing-done')).toBeVisible()
})

test('rows from a folder above: greyed, read only, "Change there" opens that folder and comes back; the names who lose access', async ({ page, playwright }) => {
  await signIn(page)
  await addCarol(page, playwright)
  const sales = (await (await page.request.post('/api/admin/groups', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Sales', memberIds: ['bob', 'carol'] } })).json()) as { id: string }
  // the mock keeps each person's groups on the person too (the server has one membership table)
  for (const id of ['bob', 'carol']) expect((await page.request.patch(`/api/admin/users/${id}`, { headers: { [CSRF_HEADER]: '1' }, data: { groupIds: [sales.id] } })).ok()).toBe(true)
  await post(page, '/__test/file', { path: 'marketing/plans/q4.md', text: 'plans' })
  // marketing: Bob can edit, nobody else; plans has no settings of its own
  await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] })
  await page.goto('/files?path=marketing%2Fplans')
  await chip(page).click()
  const above = page.getByTestId('sharing-above').and(page.locator('[data-subject="user:bob"]'))
  await expect(above).toContainText('Bob')
  await expect(above).toContainText(en('folderAccess.fromFolder', { folder: 'marketing' }))
  await expect(above).toContainText(t['folderAccess.canEdit'])
  await expect(above).toContainText(t['folderAccess.changeThere'])
  await expect(above.getByRole('combobox')).toHaveCount(0)
  await expect(page.getByTestId('sharing-row')).toHaveCount(0)
  await expect(page.getByTestId('sharing-general-select').locator('option:checked')).toHaveText(en('folderAccess.sameAs', { folder: 'marketing' }))

  // the group Sales set to "Can view" here: Bob is in it, so here he can only view; Carol gets in. Both named
  await page.getByTestId('edit-add').fill('Sal')
  await page.getByTestId('edit-add-option').filter({ hasText: 'Sales' }).click()
  await expect(outcome(page)).toContainText(en('folderAccess.willViewOnly', { names: 'Bob' }))
  await expect(outcome(page)).toContainText(en('folderAccess.willOpen', { names: 'Carol' }))
  await expect(sharingRow(page, `group:${sales.id}`)).toContainText(en('accessEdit.kind.group', { n: 2 }))
  // the confirm says both
  await page.getByTestId('sharing-save').click()
  await expect(page.getByTestId('sharing-confirm-body')).toContainText(en('folderAccess.willViewOnly', { names: 'Bob' }))
  await expect(page.getByTestId('sharing-confirm-body')).toContainText(en('folderAccess.willOpen', { names: 'Carol' }))
  await page.getByRole('dialog').filter({ has: confirm(page) }).getByRole('button', { name: t['common.cancel'] }).click()

  // Bob is decided here now (by Sales): his row from above is gone, the change named above
  await expect(above).toHaveCount(0)
  // "Change there" (general access, the folder above) with a draft asks first; Discard, then the folder above, and back
  await page.getByTestId('sharing-general-from').click()
  await confirm(page).click()
  await expect(panel(page)).toHaveAttribute('data-path', 'marketing')
  await expect(sharingRow(page, 'user:bob').getByTestId('sharing-level')).toHaveValue('write')
  await page.getByTestId('folder-access-back').click()
  await expect(panel(page)).toHaveAttribute('data-path', 'marketing/plans')
  await expect(page.getByTestId('sharing-row')).toHaveCount(0)
  // the greyed row itself opens the folder above too
  await above.click()
  await expect(panel(page)).toHaveAttribute('data-path', 'marketing')
})

test('a team project\'s folder and the folders inside it: shown, not changed, and no admin endpoint is asked', async ({ page }) => {
  await signIn(page)
  const made = await page.request.post('/api/projects', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Kite', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  const p = (await made.json()) as { id: string; folderPath: string }
  await post(page, '/__test/file', { path: `${p.folderPath}/notes/a.md`, text: 'a' })
  const asked: string[] = []
  page.on('request', (r) => { if (/\/api\/admin\/(folders|access\/)/.test(r.url())) asked.push(r.url()) })
  await page.goto(`/files?path=${encodeURIComponent(p.folderPath)}`)
  await chip(page).click()
  await expect(page.getByTestId('folder-access-project')).toContainText(en('folderAccess.project', { name: 'Kite' }))
  await expect(page.getByTestId('folder-access-headline')).toBeVisible()
  await expect(page.getByTestId('folder-access-footer')).toHaveText(t['folderAccess.adminsAlways'])
  await expect(page.getByTestId('sharing')).toHaveCount(0)
  await expect(panel(page).getByRole('combobox')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // inside it: the count, the way to Folder permissions, nothing to change
  await page.goto(`/files?path=${encodeURIComponent(p.folderPath + '/notes')}`)
  await chip(page).click()
  await expect(page.getByTestId('folder-access-headline')).toBeVisible()
  await expect(page.getByTestId('sharing')).toHaveCount(0)
  await expect(page.getByTestId('folder-access-open-admin')).toHaveAttribute('href', `/admin/folders?folder=${encodeURIComponent(p.folderPath + '/notes')}`)
  expect(asked).toEqual([])
})

test('one\'s own folder, and Admin\'s `from` that is not "files"', async ({ page }) => {
  await signIn(page)
  await page.goto('/files?path=users%2Folga')
  await chip(page).click()
  await expect(page.getByTestId('folder-access-headline')).toHaveText(t['folderAccess.onlyYouOpen'])
  await expect(page.getByTestId('sharing')).toHaveCount(0)
  // a `from` that is not "files" is no way back anywhere: the editor opens as Admin opens it
  await page.goto('/admin/folders?edit=marketing&from=https%3A%2F%2Fexample.com')
  await expect(page.getByTestId('edit-panel')).toHaveAttribute('data-path', 'marketing')
  await expect(page.getByTestId('edit-return')).toHaveCount(0)
})


for (const scheme of ['light', 'dark'] as const) {
  test(`the panel has no serious accessibility problems (${scheme}): an admin while changing it, and a member`, async ({ page, browser }) => {
    // two sign-ins and two axe runs
    test.setTimeout(120_000)
    const axe = async (p: Page, where: string) => {
      const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).include('[role="dialog"]').analyze()
      const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
    }
    await page.emulateMedia({ colorScheme: scheme })
    await signIn(page)
    await post(page, '/__test/file', { path: 'marketing/plans/q4.md', text: 'plans' })
    await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }, { subjectType: 'everyone', subjectId: null, access: 'none' }] })
    await page.goto('/files?path=marketing%2Fplans')
    await chip(page).click()
    await expect(page.getByTestId('sharing-above')).toBeVisible()
    await page.getByTestId('sharing-general-select').selectOption('read')
    await expect(page.getByTestId('sharing-outcome')).toBeVisible()
    await axe(page, 'admin panel')
    // axe needs a page of a context of its own
    const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'en-US', colorScheme: scheme })
    const bob = await ctx.newPage()
    await signIn(bob, BOB)
    await bob.goto('/files?path=marketing')
    await chip(bob).click()
    await expect(bob.getByTestId('folder-access-headline')).toBeVisible()
    await axe(bob, 'member panel')
    await ctx.close()
  })
}

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
    await expect(page.getByTestId('folder-access-headline')).toHaveText(en('folderAccess.openCount', { n: 3 }))
  })
  test('an admin: the same panel in the sheet; a change, what will happen and Save in reach, nothing wider than the screen', async ({ page }) => {
    await signIn(page)
    await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }] })
    await page.goto('/files?path=marketing')
    await chip(page).tap()
    const level = page.getByTestId('sharing-row').and(page.locator('[data-subject="user:bob"]')).getByTestId('sharing-level')
    await expect(level).toBeVisible()
    expect((await level.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await level.selectOption('read')
    await expect(page.getByTestId('sharing-outcome')).toContainText(en('folderAccess.willViewOnly', { names: 'Bob' }))
    const save = page.getByTestId('sharing-save')
    await expect(save).toBeInViewport()
    for (const el of await page.getByTestId('folder-access-panel').locator('*').all()) {
      const b = await el.boundingBox()
      if (b) expect(b.x + b.width).toBeLessThanOrEqual(391)
    }
    await save.tap()
    await expect(page.getByTestId('sharing-done')).toBeVisible()
  })
})
