// "Everyone on the team" in the file Share dialog, and one notice for several files shared in one press (QA TC-3509,
// TC-3510; docs/decisions/20261116-file-share-everyone.md). The owner, an admin (a team file) and a member (their own
// file) each pick it as the search's first option, see the line before the press, and the row after; someone else opens
// the link. A press of three files to Bob is one Activity row, "Olga shared 3 files with you", which opens their list.
// FILE_SHARE_EVERYONE_SHOTS names a folder: every surface at 1440 and 390, light and dark.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, FILE_SHARE_EVERYONE } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const SHOTS = process.env.FILE_SHARE_EVERYONE_SHOTS
const t = DICTS.en
const tr = (key: keyof typeof t, params: Record<string, string | number> = {}) => translate('en', key, params)
const OLGA = { username: 'olga', password: 'correct horse battery' }
const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }
const ALL = `group-${FILE_SHARE_EVERYONE}`

const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })

async function world(page: Page, who = OLGA) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  expect((await post(page, '/__test/file-shares')).ok()).toBeTruthy()
  for (const p of ['users/bob/team-guide.md', 'users/olga/a.md', 'users/olga/b.md', 'users/olga/c.md']) expect((await post(page, '/__test/file', { path: p, text: `# ${p}` })).ok()).toBeTruthy()
  await signIn(page, who)
}
const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })
async function openShare(page: Page, folder: string, name: string) {
  await page.goto(`/files?path=${encodeURIComponent(folder)}`)
  await row(page, name).hover()
  await row(page, name).getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: t['folderAccess.menu'], exact: true }).click()
  await expect(page.getByTestId('file-share-dialog')).toBeVisible()
}

/** every surface at 1440 and 390, light and dark (only with FILE_SHARE_EVERYONE_SHOTS) */
async function shots(page: Page, name: string) {
  if (!SHOTS) return
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
}
async function windowOf(browser: Browser, page: Page, who: { username: string; password: string }) {
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'en-US', viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  await signIn(p, who)
  return p
}

test.describe.configure({ timeout: SHOTS ? 240_000 : 60_000 })
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }) })

for (const c of [
  { role: 'owner', who: OLGA, folder: 'users/olga', file: 'draft.md', other: BOB },
  { role: 'admin', who: DANA, folder: 'marketing', file: 'plan.md', other: BOB },
  { role: 'member', who: BOB, folder: 'users/bob', file: 'team-guide.md', other: OLGA },
] as const) {
  test(`${c.role}: "Everyone on the team" is the search's first option; the line says what it does; the row after; someone else opens it`, async ({ page, browser }) => {
    await world(page, c.who)
    await openShare(page, c.folder, c.file)
    await page.getByTestId('file-share-picker-search').click()
    const first = page.getByTestId('file-share-picker-results').getByRole('button').first()
    await expect(first).toContainText(t['fileShare.everyone'])
    await expect(first).toContainText(t['fileShare.everyoneKind'])
    await shots(page, `${c.role}-everyone-search`)
    await page.getByTestId(`participant-add-${ALL}`).click()
    await expect(page.getByTestId('file-share-everyone-line')).toHaveText(t['fileShare.everyoneLineOne'])
    await shots(page, `${c.role}-everyone-picked`)
    await page.getByTestId('file-share-save').click()
    const r = page.getByTestId(`file-share-row-${ALL}`)
    await expect(r).toContainText(t['fileShare.everyone'])
    await expect(r).toContainText(t['fileShare.canView'])
    await expect(page.getByTestId('file-share-everyone-line')).toHaveCount(0)
    await shots(page, `${c.role}-everyone-shared`)
    const v = await (await page.request.get(`/api/files/shares?path=${encodeURIComponent(`${c.folder}/${c.file}`)}`)).json()
    const other = await windowOf(browser, page, c.other)
    await other.goto(v.link.url)
    await expect(other.getByTestId('file-link-name')).toHaveText(c.file)
    await other.context().close()
  })
}

test('one press of three files to Bob: ONE Activity row, "Olga shared 3 files with you", which opens their list', async ({ page, browser }) => {
  await world(page)
  const r = await (await post(page, '/api/files/shares/batch', { paths: ['users/olga/a.md', 'users/olga/b.md', 'users/olga/c.md'], add: [{ subjectType: 'user', subjectId: 'bob' }] })).json()
  expect(r).toEqual({ shared: ['users/olga/a.md', 'users/olga/b.md', 'users/olga/c.md'], failed: [] })
  const bob = await windowOf(browser, page, BOB)
  // the Activity page's list (a phone; a computer shows it as the panel beside the page)
  await bob.setViewportSize({ width: 390, height: 844 })
  await bob.goto('/activity')
  await expect(bob.getByTestId('rail-activity').or(bob.getByTestId('notification-item')).first()).toBeVisible()
  const item = bob.getByTestId('notification-item').filter({ hasText: tr('notifications.event.file.sharedMany', { by: 'Olga', n: 3 }) })
  await expect(item).toHaveCount(1)
  await expect(bob.getByTestId('notification-item').filter({ hasText: 'a.md' })).toHaveCount(0)
  await shots(bob, 'activity-shared-many')
  await bob.setViewportSize({ width: 390, height: 844 })
  const href = await item.getByTestId('notification-file-batch-link').getAttribute('href')
  await item.getByTestId('notification-file-batch-link').click()
  await expect(bob).toHaveURL(/\/f\/batch\/[A-Za-z0-9_-]{22}$/)
  await expect(bob.getByTestId('file-batch-title')).toHaveText(tr('notifications.event.file.sharedMany', { by: 'Olga', n: 3 }))
  await expect(bob.getByTestId('file-batch-row')).toHaveCount(3)
  await shots(bob, 'batch-list')
  await bob.getByTestId('file-batch-row').first().getByRole('link').click()
  await expect(bob).toHaveURL(/\/f\/[A-Za-z0-9_-]{22}$/)
  // someone the press did not tell: the link page's "doesn't work" line
  await page.goto(href!)
  await expect(page.getByTestId('file-batch-closed')).toContainText(t['fileLink.unknown'])
  await bob.context().close()
})
