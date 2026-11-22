// A member shares their own file with chosen people, Drive style (QA TC-3093; plan
// docs/AGENTS/plan/20261115-1407-file-share-links.md "UI", "States"): the file's Share dialog (one press to add, ✕ asks
// first), Copy link's /f/<id> and its toasts, the link page (open, ask, waiting, unknown, sharing off), the request in
// Activity (Share, Decline), Admin › Team settings (the switch; Remove all for the owner only) and the move confirm's
// line about people who have the file by its link. FILE_SHARE_SHOTS names a folder: every new surface is shot there at
// 1440 and 390, light and dark.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const SHOTS = process.env.FILE_SHARE_SHOTS
const t = DICTS.en
const tr = (key: keyof typeof t, params: Record<string, string | number> = {}) => translate('en', key, params)
const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }
const OPEN = 'mockOpenLink0000000001'
const ASK = 'mockNoAccess0000000002'

const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
const put = (page: Page, url: string, data: unknown) => page.request.put(url, { headers: { [CSRF_HEADER]: '1' }, data })

async function world(page: Page, o: { off?: boolean } = {}) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await signIn(page)
  expect((await post(page, '/__test/file-shares', o)).ok()).toBeTruthy()
}

const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })
async function rowMenu(page: Page, name: string, item: string) {
  await row(page, name).hover()
  await row(page, name).getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

/** every new surface at 1440 and 390, light and dark (only with FILE_SHARE_SHOTS) */
async function shots(page: Page, name: string, o: { phone?: () => Promise<void>; computer?: () => Promise<void> } = {}) {
  if (!SHOTS) return
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h })
    if (w === 390) await o.phone?.()
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForTimeout(150)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await o.computer?.()
}

async function windowOf(browser: Browser, page: Page, who: { username: string; password: string }) {
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'en-US', viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const p = await ctx.newPage()
  await signIn(p, who)
  return p
}

// four screenshots per surface take their time
test.describe.configure({ timeout: SHOTS ? 240_000 : 60_000 })
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }) })

test('Share dialog: one press adds Bob, ✕ asks and removes him; a team file says the folder\'s people open it too', async ({ page }) => {
  await world(page)
  await page.goto('/files?path=users/olga')
  await rowMenu(page, 'draft.md', t['folderAccess.menu'])
  const dialog = page.getByTestId('file-share-dialog')
  await expect(page.getByTestId('file-share-title')).toHaveText(tr('folderAccess.title', { name: 'draft.md' }))
  await expect(dialog.getByTestId('file-share-owner')).toContainText('Olga')
  await expect(dialog.getByTestId('file-share-owner')).toContainText(t['fileShare.owner'])
  await expect(page.getByTestId('file-share-done')).toBeVisible()
  await shots(page, 'share-dialog-empty')
  // adding a person and pressing Share saves at once
  await page.getByTestId('file-share-picker-search').fill('Bob')
  await page.getByTestId('participant-add-user-bob').click()
  await expect(page.getByTestId('file-share-save')).toBeVisible()
  await shots(page, 'share-dialog-picked')
  await page.getByTestId('file-share-save').click()
  const bob = dialog.getByTestId('file-share-row-user-bob')
  await expect(bob).toContainText(t['fileShare.canView'])
  await expect(page.getByTestId('file-share-done')).toBeVisible()
  await shots(page, 'share-dialog-shared')
  // ✕ asks first, then removes
  await page.getByTestId('file-share-remove-user-bob').click()
  await expect(page.getByRole('dialog', { name: tr('folderAccess.removeTitle', { name: 'Bob' }) })).toBeVisible()
  await page.getByTestId('dialog-confirm').click()
  await expect(bob).toHaveCount(0)
  await page.getByTestId('file-share-done').click()
  await expect(dialog).toHaveCount(0)

  // a team file: the folder's people open it too
  await page.goto('/files?path=marketing')
  await rowMenu(page, 'plan.md', t['folderAccess.menu'])
  await expect(page.getByTestId('file-share-folder-too')).toHaveText(t['fileShare.folderToo'])
  await shots(page, 'share-dialog-team-file')
})

test('Share dialog for someone who may not share: who has it, who to ask, Copy link', async ({ page, browser }) => {
  await world(page)
  // Olga's team file marketing/plan.md: Bob (a member who did not add it) sees only who owns it
  const bob = await windowOf(browser, page, BOB)
  await bob.goto('/files?path=marketing')
  await rowMenu(bob, 'plan.md', t['folderAccess.menu'])
  // who to ask, by name, and the people to ask Olga for (QA TC-7230); never the owner's own picker
  await expect(bob.getByTestId('file-share-why')).toHaveText(t['fileShare.ownerOnlyNamed'].replaceAll('{owner}', 'Olga'))
  await expect(bob.getByTestId('file-share-picker-search')).toHaveCount(0)
  await expect(bob.getByTestId('file-share-ask-picker-search')).toBeVisible()
  await expect(bob.getByTestId('file-share-copy-link')).toBeVisible()
  await shots(bob, 'share-dialog-not-owner')
  await bob.context().close()
})

test('Copy link: /f/<id> with the toast true for the case; a folder keeps its old link', async ({ page }) => {
  await world(page)
  await page.goto('/files?path=users/olga')
  // my own file shared with nobody: only I open it, with Share… to fix that
  await rowMenu(page, 'draft.md', t['rooms.menu.copyLink'])
  await expect(page.getByText(t['fileLink.copiedOnlyYou'])).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/f\/[A-Za-z0-9_-]{22}$/)
  await shots(page, 'copy-link-only-you')
  // (the toast may have gone while the shots were taken: copy again; the newest toast)
  await rowMenu(page, 'draft.md', t['rooms.menu.copyLink'])
  await page.getByTestId('toast').filter({ hasText: t['fileLink.copiedOnlyYou'] }).last().getByRole('button', { name: t['fileLink.shareAction'] }).click()
  await expect(page.getByTestId('file-share-dialog')).toHaveAttribute('data-path', 'users/olga/draft.md')
  await page.getByTestId('file-share-done').click()
  // a file shared with someone: people with access open it
  await rowMenu(page, 'notes.md', t['rooms.menu.copyLink'])
  await expect(page.getByText(t['fileLink.copied'])).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/f/${OPEN}`)
  // a folder: the Files address as before
  await page.goto('/files')
  await rowMenu(page, 'marketing', t['rooms.menu.copyLink'])
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('/files/view?path=marketing')
})

test('the link page: open with "Shared by", ask with a note, waiting, unknown, sharing off', async ({ page, browser }) => {
  await world(page)
  // Olga's own file opens for her
  await page.goto(`/f/${OPEN}`)
  await expect(page.getByTestId('file-link-name')).toHaveText('notes.md')
  await expect(page.getByTestId('file-link-body')).toContainText('Quarter plan')
  // Bob has it by a share: "Shared by Olga"
  const bob = await windowOf(browser, page, BOB)
  await bob.goto(`/f/${OPEN}`)
  await expect(bob.getByTestId('file-link-meta')).toContainText(tr('fileLink.sharedBy', { name: 'Olga' }))
  await expect(bob.getByTestId('file-link-body')).toContainText('Quarter plan')
  await shots(bob, 'link-open-shared-by')
  await bob.context().close()

  // a file Olga cannot open: nothing about it, Ask for access with a note
  await page.goto(`/f/${ASK}`)
  const ask = page.getByTestId('file-link-ask')
  await expect(ask).toContainText(t['fileLink.needAccess'])
  await expect(ask).not.toContainText('budget')
  await page.getByTestId('file-link-note').fill('Need it for the review')
  await shots(page, 'link-no-access')
  await page.getByTestId('file-link-ask-button').click()
  await expect(page.getByTestId('file-link-sent')).toHaveText(t['fileLink.sent'])
  await shots(page, 'link-request-sent')
  // back later: still waiting, with the day it was asked
  await page.reload()
  await expect(page.getByTestId('file-link-waiting')).toContainText('Waiting for an answer.')
  await shots(page, 'link-waiting')
  // an unknown link
  await page.goto('/f/zzzzzzzzzzzzzzzzzzzzzz')
  await expect(page.getByTestId('file-link-closed')).toHaveAttribute('data-state', 'unknown')
  await expect(page.getByTestId('file-link-closed-line')).toHaveText(t['fileLink.unknown'])
  await shots(page, 'link-unknown')
})

test('sharing off: no Ask on a member\'s file, and the member\'s Share says why', async ({ page, browser }) => {
  await world(page, { off: true })
  // Bob's file (a member's) while members' sharing is off: Olga cannot ask
  await page.goto(`/f/${ASK}`)
  await expect(page.getByTestId('file-link-closed-line')).toHaveText(t['fileLink.cantAsk'])
  await expect(page.getByTestId('file-link-ask-button')).toHaveCount(0)
  await shots(page, 'link-cant-ask')
  // Bob's own file: Share says the team turned it off
  expect((await post(page, '/__test/file', { path: 'users/bob/list.md', text: 'x' })).ok()).toBeTruthy()
  const bob = await windowOf(browser, page, BOB)
  await bob.goto('/files?path=users/bob')
  await rowMenu(bob, 'list.md', t['folderAccess.menu'])
  await expect(bob.getByTestId('file-share-why')).toHaveText(t['fileShare.off'])
  await shots(bob, 'share-dialog-off')
  await bob.context().close()
})

test('Activity: an ask to open a file, its note, Share; the other notices', async ({ page }) => {
  await world(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/activity')
  const req = page.getByTestId('notification-item').filter({ hasText: tr('notifications.event.file.access_requestedNamed', { by: 'Bob', name: 'report.md' }) })
  await expect(req.getByTestId('file-request-note')).toContainText('For the Monday review, please.')
  await expect(page.getByTestId('notification-item').filter({ hasText: tr('notifications.event.file.sharedNamed', { by: 'Bob', name: 'plan.md' }) }).getByTestId('notification-file-link')).toHaveAttribute('href', /\/f\/[A-Za-z0-9_-]{22}$/)
  await expect(page.getByTestId('notification-item').filter({ hasText: t['notifications.event.file.access_answered'] })).toHaveCount(1)
  await expect(page.getByTestId('notification-item').filter({ hasText: tr('notifications.event.file.unshared_by_moveNamed', { by: 'Bob', name: 'notes.md' }) })).toHaveCount(1)
  await shots(page, 'activity-file-notices', { computer: async () => { await page.setViewportSize({ width: 390, height: 844 }) } })
  await req.getByTestId('file-request-share').click()
  await expect(req.getByTestId('file-request-done')).toHaveText(tr('fileRequest.approved', { by: 'Bob' }))
  await expect(req.getByTestId('file-request-share')).toHaveCount(0)
  // Bob now has it
  const shares = await (await page.request.get('/api/files/shares?path=users/olga/report.md')).json()
  expect(shares.people.map((p: { subjectId: string }) => p.subjectId)).toEqual(['bob'])
  // a computer: the 요청 chip holds it, and the notice opens beside the list with what was done
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/files')
  await page.getByTestId('rail-activity').click()
  await page.getByTestId('activity-panel-chips').getByRole('button', { name: t['activity.chip.requests'] }).click()
  await page.getByTestId('activity-panel-row').filter({ hasText: 'report.md' }).click()
  await expect(page.getByTestId('file-request-done')).toHaveText(tr('fileRequest.approved', { by: 'Bob' }))
  await shots(page, 'activity-request-answered')
})

test('Activity: Decline, and the asker hears it without the file\'s name', async ({ page, browser }) => {
  await world(page)
  // a computer: the notice opens beside the list, with Share and Decline
  await page.goto('/activity')
  await page.getByTestId('activity-panel-row').filter({ hasText: 'report.md' }).click()
  const req = page.getByTestId('notification-item').filter({ hasText: 'report.md' })
  await expect(req.getByTestId('file-request-note')).toBeVisible()
  await shots(page, 'activity-request-open', { computer: async () => { await page.getByTestId('activity-panel-row').filter({ hasText: 'report.md' }).click() } })
  await req.getByTestId('file-request-decline').click()
  await expect(req.getByTestId('file-request-done')).toHaveText(t['fileRequest.declined'])
  const bob = await windowOf(browser, page, BOB)
  await bob.goto('/activity')
  const notice = bob.getByTestId('activity-panel-row').filter({ hasText: t['notifications.event.file.access_answered'] })
  await expect(notice).toHaveCount(1)
  await expect(notice).not.toContainText('report')
  await bob.context().close()
})

test('Admin › Team settings: the switch for everyone who manages; Remove all for the team owner only', async ({ page, browser }) => {
  await world(page)
  await page.goto('/admin/settings')
  const sw = page.getByTestId('team-member-file-shares')
  await expect(sw).toHaveAttribute('data-on', 'true')
  const remove = page.getByTestId('team-remove-file-shares')
  await expect(remove).toContainText(tr('teamSettings.removeSharesDesc', { what: tr('teamSettings.sharedFiles', { n: 1 }), people: 1 }))
  await remove.scrollIntoViewIfNeeded()
  await shots(page, 'admin-file-shares', { phone: async () => { await page.goto('/admin/settings/members'); await page.getByTestId('team-member-file-shares').scrollIntoViewIfNeeded() }, computer: async () => { await page.goto('/admin/settings'); await page.getByTestId('team-remove-file-shares').scrollIntoViewIfNeeded() } })
  await page.getByTestId('team-remove-file-shares-button').click()
  const confirm = page.getByRole('dialog', { name: tr('teamSettings.removeSharesConfirm', { what: tr('teamSettings.sharedFiles', { n: 1 }), people: 1 }) })
  await expect(confirm).toBeVisible()
  await shots(page, 'admin-remove-confirm')
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText(t['teamSettings.fileSharesRemoved'])).toBeVisible()
  await page.reload()
  await expect(sw).toBeVisible()
  await expect(remove).toHaveCount(0)
  // the switch saves with the form
  await sw.locator('label.touch-hit').click()
  await page.getByTestId('team-settings-savebar').getByRole('button', { name: t['common.save'] }).click()
  await expect.poll(async () => (await (await page.request.get('/api/admin/settings')).json()).memberFileShares).toBe(false)

  // an admin: the switch, no Remove all
  expect((await post(page, '/__test/file-shares')).ok()).toBeTruthy()
  expect((await put(page, '/api/files/shares', { path: 'users/olga/draft.md', add: [{ subjectType: 'user', subjectId: 'bob' }] })).ok()).toBeTruthy()
  const dana = await windowOf(browser, page, DANA)
  await dana.goto('/admin/settings')
  await expect(dana.getByTestId('team-member-file-shares')).toBeVisible()
  await expect(dana.getByTestId('team-remove-file-shares')).toHaveCount(0)
  await dana.context().close()
})

test('move confirm: how many people have the file by its link', async ({ page }) => {
  await world(page)
  // marketing/data.csv shared with Bob by Olga (the team owner); moving it into her own folder leaves Bob out
  expect((await put(page, '/api/files/shares', { path: 'marketing/data.csv', add: [{ subjectType: 'user', subjectId: 'bob' }] })).ok()).toBeTruthy()
  await page.goto('/files?path=marketing')
  await rowMenu(page, 'data.csv', t['files.move'])
  const picker = page.getByRole('dialog').filter({ has: page.getByTestId('folder-pick') })
  await picker.getByRole('button', { name: t['files.root'] }).click()
  await picker.getByRole('button', { name: 'Personal' }).click()
  await picker.getByRole('button', { name: 'My files' }).click()
  await picker.getByTestId('folder-pick').click()
  const ask = page.getByRole('dialog', { name: t['files.narrowTitle'] })
  await expect(ask.getByTestId('move-link-people')).toHaveText(tr('files.narrowLinkPeople', { n: 1 }))
  await shots(page, 'move-confirm-link-people')
  await ask.getByRole('button', { name: t['common.cancel'] }).click()
})

test('folder Share dialog: narrowing a folder with files shared by link offers "Remove those links too", ticked; the save honours it', async ({ page }) => {
  await world(page)
  const sharing = page.getByTestId('sharing')
  // (what will happen and Save are in the sheet's footer, outside `sharing`)
  const line = page.getByTestId('sharing-link-people')
  const box = page.getByTestId('sharing-remove-links')
  const level = sharing.getByTestId('sharing-row').and(page.locator('[data-subject="user:bob"]')).getByTestId('sharing-level')
  const sent = async () => ((await (await page.request.get('/__test/file-shares')).json()) as { lastRemoveFileLinks: boolean | null }).lastRemoveFileLinks
  const bobHasIt = async () => ((await (await page.request.get('/api/files/shares?path=marketing%2Fdata.csv')).json()) as { people: { subjectId: string }[] }).people.some((p) => p.subjectId === 'bob')
  expect((await post(page, '/api/admin/folders', { path: 'marketing', create: false, rules: [{ subjectType: 'user', subjectId: 'bob', access: 'write' }] })).ok()).toBeTruthy()
  // marketing/data.csv shared with Bob one by one (by Olga, the team owner)
  expect((await put(page, '/api/files/shares', { path: 'marketing/data.csv', add: [{ subjectType: 'user', subjectId: 'bob' }] })).ok()).toBeTruthy()
  await page.goto('/files?path=marketing')
  await page.getByTestId('folder-access-chip').click()
  await expect(sharing).toBeVisible()

  // a change that takes access from nobody: no line
  await page.getByTestId('sharing-general-select').selectOption('team')
  await expect(page.getByTestId('sharing-outcome')).toBeVisible()
  await expect(line).toHaveCount(0)
  await page.getByTestId('sharing-general-select').selectOption('restricted')
  await expect(page.getByTestId('sharing-done')).toBeVisible()

  // Bob down to Viewer: the line, the box ticked; unticked, the save sends false (always the box's choice) and Bob keeps the file
  await level.selectOption('read')
  await expect(line).toContainText(tr('folderAccess.linkPeople', { n: 1 }))
  await expect(line).toContainText(t['folderAccess.removeLinks'])
  await expect(box).toBeChecked()
  await box.uncheck()
  await page.getByTestId('sharing-save').click()
  await expect(page.getByTestId('sharing-done')).toBeVisible()
  expect(await sent()).toBe(false)
  expect(await bobHasIt()).toBe(true)
  // (the "Saved." toast would cover the line in the phone's shots)
  await page.getByTestId('toast').getByRole('button', { name: t['common.close'] }).click()
  await expect(page.getByTestId('toast')).toHaveCount(0)

  // Bob removed: a new change, the box ticked again; the save sends removeFileLinks and the link grant goes
  await level.selectOption('remove')
  await page.getByTestId('dialog-confirm').click()
  await expect(line).toContainText(tr('folderAccess.linkPeople', { n: 1 }))
  await expect(box).toBeChecked()
  await shots(page, 'folder-link-people')
  await page.getByTestId('sharing-save').click()
  await expect(page.getByTestId('sharing-done')).toBeVisible()
  expect(await sent()).toBe(true)
  expect(await bobHasIt()).toBe(false)
})
