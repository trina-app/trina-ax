// A member shares a folder in their own files, like a folder in Google Drive's My Drive (folder sharing's web part,
// docs/AGENTS/plan/20261116-1330-folder-share-web.md; QA TC-4077..4089): the one Share dialog for a folder (what it
// holds, later files follow, the Everyone line), the "Shared" chip and marks in Files ("Shared through Work"), the
// receiver's Shared with me and the read-only folder page (one level, a folder inside, a file inside), Stop sharing that
// names nested shares (files and folders) with the server's Undo, places that are never shared, no guests, a paused
// share (the owner's Resume, the receiver's closed card), the admin's one-time line and counts. Folder sharing is always
// on (its rollout gate was removed, owner 2026-11-17). Axe on every new surface. FOLDER_SHARE_SHOTS names a folder:
// every state is shot there at 1440 and 390, light and dark.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const SHOTS = process.env.FOLDER_SHARE_SHOTS
const t = DICTS.en
const tr = (key: keyof typeof t, params: Record<string, string | number> = {}) => translate('en', key, params)
const OLGA = { username: 'olga', password: 'correct horse battery' }
const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }
const WORK = 'users/bob/Work'

const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })

type World = { paused?: string[]; blocked?: Record<string, string>; wide?: boolean; grants?: { path: string; to: { subjectType: 'user' | 'group'; subjectId: string }; by: string; at?: string }[] }
/** Bob's folders (users/bob/Work with Plan.md, Budget.csv, Q4/Notes.md and a hidden file; Drafts; downloads); signed in
 * as `who` (Bob) */
async function world(page: Page, o: World = {}, who = BOB): Promise<Record<string, string>> {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  const r = await post(page, '/__test/folder-shares', { world: true, ...o })
  expect(r.ok()).toBeTruthy()
  await signIn(page, who)
  return ((await r.json()) as { links: Record<string, string> }).links
}

async function windowOf(browser: Browser, page: Page, who: { username: string; password: string }) {
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'en-US', viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const p = await ctx.newPage()
  await signIn(p, who)
  return p
}

const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ has: page.getByText(name, { exact: true }) })
async function openRowMenu(page: Page, name: string) {
  await row(page, name).hover()
  await row(page, name).getByTestId('file-menu').click()
}
async function rowMenu(page: Page, name: string, item: string) {
  await openRowMenu(page, name)
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

async function axe(page: Page, where: string) {
  // (the theme just changed: colours that are still fading are measured at their end)
  await page.waitForTimeout(400)
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))))
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** every state at 1440 and 390, light and dark, with axe in both themes (shots only with FOLDER_SHARE_SHOTS) */
async function look(page: Page, name: string, o: { phone?: () => Promise<void>; computer?: () => Promise<void> } = {}) {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await axe(page, `${name} (${theme})`)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h })
    if (w === 390) await o.phone?.()
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await o.computer?.()
}

test.describe.configure({ timeout: SHOTS ? 300_000 : 90_000 })
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }) })

test('share a folder from Files: the dialog, the Shared marks; the receiver finds it in Shared with me and opens it, a folder inside and a file inside', async ({ page, browser }) => {
  await world(page)
  await page.goto('/files?path=users/bob')
  await rowMenu(page, 'Work', t['folderAccess.menu'])
  const dialog = page.getByTestId('file-share-dialog')
  await expect(dialog).toHaveAttribute('data-kind', 'folder')
  await expect(page.getByTestId('file-share-title')).toHaveText(tr('folderAccess.title', { name: 'Work' }))
  // what it holds (the hidden file is not counted), and that later files follow
  await expect(page.getByTestId('file-share-holds')).toHaveText(`${tr('fileShare.holdsFiles', { n: 2 })}, ${tr('fileShare.holdsFolders', { n: 1 })} · ${t['fileShare.folderLater']}`)
  await expect(page.getByTestId('file-share-stop')).toHaveCount(0)
  await look(page, 'dialog-folder-empty')
  // Everyone on the team: its own sentence for a folder, before the press
  await page.getByTestId('file-share-picker-search').click()
  await page.getByTestId('file-share-picker-results').getByRole('button').first().click()
  await expect(page.getByTestId('file-share-everyone-line')).toHaveText(t['fileShare.everyoneLineFolder'])
  await look(page, 'dialog-folder-everyone')
  await page.goto('/files?path=users/bob')
  await rowMenu(page, 'Work', t['folderAccess.menu'])
  await page.getByTestId('file-share-picker-search').fill('Olga')
  await page.getByTestId('participant-add-user-olga').click()
  await page.getByTestId('file-share-save').click()
  await expect(dialog.getByTestId('file-share-row-user-olga')).toContainText(t['fileShare.canView'])
  await expect(page.getByTestId('file-share-stop')).toBeVisible()
  await look(page, 'dialog-folder-shared')
  await page.getByTestId('file-share-done').click()
  // the folder's row says Shared; inside, the chip says Shared and a file says "Shared through Work"
  await expect(row(page, 'Work').getByTestId('file-shared')).toHaveAttribute('data-shared', 'own')
  await expect(row(page, 'Drafts').getByTestId('file-shared')).toHaveCount(0)
  await look(page, 'files-shared-row')
  await page.goto(`/files?path=${encodeURIComponent(WORK)}`)
  await expect(page.getByTestId('folder-access-chip')).toHaveAttribute('data-kind', 'shared')
  await expect(page.getByTestId('folder-access-chip')).toHaveAccessibleName(tr('folderAccess.sharedWith', { people: 'Olga' }))
  const plan = row(page, 'Plan.md').getByTestId('file-shared')
  await expect(plan).toHaveAttribute('data-shared', 'through')
  await expect(plan).toContainText(tr('files.sharedThrough', { folder: 'Work' }))
  await look(page, 'files-inside-shared')
  // a file inside: its own dialog lists Olga "through Work", with no ✕ there
  await rowMenu(page, 'Plan.md', t['folderAccess.menu'])
  const through = page.getByTestId('file-share-through-user-olga')
  await expect(through).toContainText(tr('fileShare.through', { folder: 'Work' }))
  await expect(page.getByTestId('file-share-remove-user-olga')).toHaveCount(0)
  await look(page, 'dialog-file-through')
  await page.getByTestId('file-share-done').click()

  // the receiver
  const olga = await windowOf(browser, page, OLGA)
  await olga.goto('/activity')
  await expect(olga.getByText(tr('notifications.event.file.sharedFolder', { by: 'Bob', name: 'Work' }))).toBeVisible()
  await olga.goto('/files?view=shared')
  const shared = olga.getByTestId('shared-file').filter({ hasText: 'Work' })
  await expect(shared).toHaveCount(1)
  await expect(shared.getByTestId('shared-file-meta')).toContainText('Bob · ')
  await look(olga, 'receiver-shared-with-me')
  await shared.click()
  await expect(olga.getByTestId('file-link-page')).toHaveAttribute('data-kind', 'folder')
  await expect(olga.getByTestId('file-link-name')).toHaveText('Work')
  await expect(olga.getByTestId('file-link-meta')).toHaveText(`${tr('fileLink.sharedBy', { name: 'Bob' })} · ${t['fileLink.viewOnly']}`)
  const names = olga.getByTestId('file-link-item-name')
  await expect(names).toHaveText(['Q4', 'Budget.csv', 'Plan.md'])
  // nothing above the shared folder, and no way to change anything
  await expect(olga.getByText('users/bob')).toHaveCount(0)
  await expect(olga.getByTestId('file-link-back')).toBeVisible()
  await look(olga, 'receiver-folder')
  await olga.getByTestId('file-link-folder-row').filter({ hasText: 'Q4' }).click()
  await expect(olga.getByTestId('file-link-crumbs')).toContainText('Work')
  await expect(olga.getByTestId('file-link-name')).toHaveText('Q4')
  await expect(names).toHaveText(['Notes.md'])
  await look(olga, 'receiver-subfolder')
  await olga.getByTestId('file-link-file-row').filter({ hasText: 'Notes.md' }).click()
  await expect(olga.getByTestId('file-link-name')).toHaveText('Notes.md')
  await expect(olga.getByTestId('file-link-body')).toContainText('Kick-off on Monday.')
  await expect(olga.getByTestId('file-link-crumbs')).toContainText('Q4')
  await look(olga, 'receiver-file')
  const dl = olga.waitForEvent('download')
  await olga.getByTestId('file-link-download').click()
  expect((await dl).suggestedFilename()).toBe('Notes.md')
  // back up by the crumbs
  await olga.getByTestId('file-link-crumb').filter({ hasText: 'Work' }).click()
  await expect(names).toHaveText(['Q4', 'Budget.csv', 'Plan.md'])
  await olga.context().close()
})

test('Stop sharing goes at once naming nested shares (files and folders), and Undo puts the people back', async ({ page }) => {
  await world(page, { grants: [
    { path: WORK, to: { subjectType: 'user', subjectId: 'olga' }, by: 'bob' },
    { path: `${WORK}/Q4`, to: { subjectType: 'user', subjectId: 'dana' }, by: 'bob' },
  ] })
  // a file inside with people of its own (the file share's own fixture)
  expect((await post(page, '/__test/file-shares', { grants: [{ path: `${WORK}/Plan.md`, to: 'dana', by: 'bob', at: '2026-11-12T09:00:00.000Z' }] })).ok()).toBeTruthy()
  await page.goto('/files?path=users/bob')
  await rowMenu(page, 'Work', t['folderAccess.menu'])
  // no question first (docs/decisions/20261123-do-then-undo.md): it stops, and the toast names what stays shared
  await page.getByTestId('file-share-stop').click()
  await expect(page.getByTestId('dialog-confirm')).toHaveCount(0)
  await expect(page.getByTestId('file-share-row-user-olga')).toHaveCount(0)
  const toastUndo = page.getByRole('button', { name: t['common.undo'] })
  await expect(page.getByText(`${tr('fileShare.stopped', { name: 'Work' })} ${tr('fileShare.stopKeeps', { names: `Plan.md and ${tr('fileShare.theFolder', { name: 'Q4' })}` })}`)).toBeVisible()
  await look(page, 'stop-undo-toast')
  await toastUndo.click()
  await expect(page.getByText(t['fileShare.undone'])).toBeVisible()
  await expect(page.getByTestId('file-share-row-user-olga')).toBeVisible()
  // stop again: an undo is used once
  await page.getByTestId('file-share-stop').click()
  await expect(page.getByTestId('file-share-row-user-olga')).toHaveCount(0)
})

test('a move into a shared folder says who more will see it: its own sentence with the count (one item and several)', async ({ page }) => {
  await world(page, { grants: [{ path: WORK, to: { subjectType: 'user', subjectId: 'olga' }, by: 'bob' }] })
  await page.goto(`/files?path=${encodeURIComponent('users/bob/Drafts')}`)
  await rowMenu(page, 'Idea.md', t['files.move'])
  const picker = page.getByRole('dialog').filter({ has: page.getByTestId('folder-pick') })
  await picker.getByRole('button', { name: 'My files' }).click()
  await picker.getByRole('button', { name: 'Work' }).click()
  await picker.getByTestId('folder-pick').click()
  const ask = page.getByRole('dialog', { name: t['files.widenTitle'] })
  await expect(ask).toContainText(tr('files.widenSharedBody', { n: 1 }))
  await expect(ask).not.toContainText(t['files.widenBody'].split(' means')[0]!)
  await look(page, 'move-into-shared')
  await ask.getByRole('button', { name: t['common.cancel'] }).click()
  await expect(row(page, 'Idea.md')).toBeVisible()
  // several at once: the count of items and of people
  await page.goto(`/files?path=${encodeURIComponent('users/bob/Drafts')}`)
  await row(page, 'Idea.md').getByTestId('file-check').click()
  await page.getByTestId('bulk-move').click()
  await picker.getByRole('button', { name: 'My files' }).click()
  await picker.getByRole('button', { name: 'Work' }).click()
  await picker.getByTestId('folder-pick').click()
  await expect(ask).toContainText(tr('files.bulk.widenSharedBody', { count: 1, n: 1 }))
  await ask.getByRole('button', { name: t['files.moveAnyway'] }).click()
  await expect(row(page, 'Idea.md')).toHaveCount(0)
})

test('places that are never shared offer no Share; a project folder and a disk without creation times say why', async ({ page }) => {
  await world(page, { blocked: { 'users/bob/Drafts': 'disk' } })
  // the personal folder itself, in Personal
  await page.goto('/files?path=users')
  await openRowMenu(page, 'My files')
  await expect(page.getByRole('menuitem', { name: t['folderAccess.menu'], exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // a place Trina keeps
  await page.goto('/files?path=users/bob')
  await openRowMenu(page, 'downloads')
  await expect(page.getByRole('menuitem', { name: t['folderAccess.menu'], exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // the server says why for the rest: Share stays off with one line, no people, no link
  await rowMenu(page, 'Drafts', t['folderAccess.menu'])
  await expect(page.getByTestId('file-share-blocked')).toHaveText(t['fileShare.blocked.disk'])
  await expect(page.getByTestId('file-share-picker-search')).toHaveCount(0)
  await expect(page.getByTestId('file-share-copy-link')).toHaveCount(0)
  await look(page, 'dialog-blocked')
})

test('a guest is never offered, and the "save without asking" line shows for those who allowed it', async ({ page }) => {
  await world(page, { wide: true })
  expect((await post(page, '/__test/project', { name: 'Launch', by: 'olga' })).ok()).toBeTruthy()
  expect((await post(page, '/__test/guest', { id: 'gina', name: 'Gina', place: { kind: 'project', name: 'Launch' } })).ok()).toBeTruthy()
  await page.goto('/files?path=users/bob')
  await rowMenu(page, 'Work', t['folderAccess.menu'])
  await expect(page.getByTestId('file-share-wide-saves')).toHaveText(t['fileShare.wideSaves'])
  await page.getByTestId('file-share-picker-search').fill('Gina')
  await expect(page.getByTestId('participant-add-user-gina')).toHaveCount(0)
  await page.getByTestId('file-share-picker-search').fill('Dana')
  await expect(page.getByTestId('participant-add-user-dana')).toBeVisible()
  await look(page, 'dialog-wide-saves')
})

test('paused: the owner reads why in Activity and the dialog and resumes; the receiver gets the closed card meanwhile', async ({ page, browser }) => {
  const links = await world(page, { grants: [{ path: WORK, to: { subjectType: 'user', subjectId: 'olga' }, by: 'bob' }], paused: [WORK] })
  await page.goto('/activity')
  await expect(page.getByText(tr('notifications.event.file.folderPaused', { name: 'Work' }))).toBeVisible()
  await page.goto('/files?path=users/bob')
  await rowMenu(page, 'Work', t['folderAccess.menu'])
  await expect(page.getByTestId('file-share-paused')).toContainText(t['fileShare.paused'])
  await expect(page.getByTestId('file-share-picker-search')).toHaveCount(0)
  // the owner can still take people off while paused
  await expect(page.getByTestId('file-share-remove-user-olga')).toBeVisible()
  await look(page, 'dialog-paused')
  const olga = await windowOf(browser, page, OLGA)
  await olga.goto(`/f/${links[WORK]}`)
  await expect(olga.getByTestId('file-link-closed-line')).toHaveText(t['fileLink.cantAsk'])
  await look(olga, 'receiver-paused')
  await olga.goto('/files?view=shared')
  await expect(olga.getByTestId('shared-file').filter({ hasText: 'Work' })).toHaveCount(0)
  await page.getByTestId('file-share-resume').click()
  await expect(page.getByTestId('file-share-paused')).toHaveCount(0)
  await expect(page.getByTestId('file-share-picker-search')).toBeVisible()
  await olga.goto(`/f/${links[WORK]}`)
  await expect(olga.getByTestId('file-link-name')).toHaveText('Work')
  await olga.context().close()
})

test('admins: the one-time line, the switch names folders, Remove all counts folders apart', async ({ page, browser }) => {
  await world(page, { grants: [{ path: WORK, to: { subjectType: 'user', subjectId: 'olga' }, by: 'bob' }] }, DANA)
  expect((await post(page, '/__test/file-shares', { grants: [{ path: 'users/bob/Drafts/Idea.md', to: 'olga', by: 'bob', at: '2026-11-12T09:00:00.000Z' }] })).ok()).toBeTruthy()
  await page.goto('/admin')
  const notice = page.getByTestId('admin-folder-share-notice')
  await expect(notice).toContainText(t['adminHome.folderShareNotice'])
  await look(page, 'admin-notice')
  await page.getByTestId('admin-folder-share-notice-close').click()
  await expect(notice).toHaveCount(0)
  await page.reload()
  await expect(page.locator('#admin-home-areas')).toBeVisible()
  await expect(notice).toHaveCount(0)
  await page.goto('/admin/settings')
  await expect(page.getByTestId('team-member-file-shares')).toContainText(t['teamSettings.memberFileFolderShares'])
  // Remove all is the team owner's; the count names files and folders apart
  const olga = await windowOf(browser, page, OLGA)
  await olga.goto('/admin/settings')
  // (the file-share fixtures add Olga's notes.md, shared with Bob)
  const what = `${tr('teamSettings.sharedFiles', { n: 2 })}${t['teamSettings.and']}${tr('teamSettings.sharedFolders', { n: 1 })}`
  await expect(olga.getByTestId('team-remove-file-shares')).toContainText(tr('teamSettings.removeSharesDesc', { what, people: 2 }))
  await olga.getByTestId('team-remove-file-shares').scrollIntoViewIfNeeded()
  await look(olga, 'admin-remove-all')
  await olga.context().close()
})
