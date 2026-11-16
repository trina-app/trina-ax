// Files › Shared with me (file sharing P2, PR 1; docs/decisions/20261116-files-shared-with-me.md). For the owner, an
// admin and a member: the row under Recent files, the list (name, "who · when"), a row opens the file's link page with
// "‹ Shared with me" back to the list (a computer: the link above the page; a phone: the phone's bar), the empty line,
// and a link opened from anywhere else shows no way back. FILES_SHARED_SHOTS names a folder: every surface at 1440 and
// 390, light and dark, in English and Korean.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { DICTS, translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const SHOTS = process.env.FILES_SHARED_SHOTS
const OLGA = { username: 'olga', password: 'correct horse battery' }
const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }
const post = (page: Page, url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
const year = new Date().getFullYear()

/** each role gets two files by name from the other two people: an older one and a newer one */
const CASES = [
  { role: 'owner', who: OLGA, name: 'Olga', from: [{ by: 'bob', path: 'users/bob/Quarterly plan.md', name: 'Bob' }, { by: 'dana', path: 'marketing/Launch checklist.md', name: 'Dana' }] },
  { role: 'admin', who: DANA, name: 'Dana', from: [{ by: 'olga', path: 'users/olga/Budget 2027.md', name: 'Olga' }, { by: 'bob', path: 'users/bob/Customer interview notes with a long name that does not fit on a phone.md', name: 'Bob' }] },
  { role: 'member', who: BOB, name: 'Bob', from: [{ by: 'olga', path: 'users/olga/Hiring plan.md', name: 'Olga' }, { by: 'dana', path: 'users/dana/Team offsite.md', name: 'Dana' }] },
] as const

async function world(page: Page, c: (typeof CASES)[number], locale: 'en' | 'ko' = 'en', o: { grants?: boolean } = {}) {
  await reset(page, { teamLocale: locale, usersFollowTeam: true, withAdmin: true })
  const grants = o.grants === false ? [] : c.from.map((f, i) => ({ path: f.path, to: c.who.username, by: f.by, at: `${year}-11-${10 + i * 4}T09:00:00.000Z` }))
  expect((await post(page, '/__test/file-shares', { grants })).ok()).toBeTruthy()
  await signIn(page, c.who)
}

/** every surface at 1440 and 390, light and dark (only with FILES_SHARED_SHOTS) */
async function shots(page: Page, name: string, o: { phone?: () => Promise<void> } = {}) {
  if (!SHOTS) return
  await page.mouse.move(0, 0)
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h })
    if (w === 390 && o.phone) await o.phone()
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${theme}.png` })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
}

test.describe.configure({ timeout: SHOTS ? 240_000 : 60_000 })
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }) })

for (const c of CASES) {
  for (const locale of SHOTS ? (['en', 'ko'] as const) : (['en'] as const)) {
    test(`${c.role} (${locale}): the row under Recent files, the list newest first with who and when, a row opens the file and ‹ Shared with me goes back`, async ({ page }) => {
      const t = DICTS[locale]
      await world(page, c, locale)
      await page.goto('/files?view=recent')
      const panel = page.getByTestId('files-panel')
      const rowLink = panel.getByTestId('files-panel-shared')
      await expect(rowLink).toHaveText(t['filesPanel.shared'])
      // directly under Recent files
      const order = await panel.locator('[data-testid^="files-panel-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
      expect(order.indexOf('files-panel-shared')).toBe(order.indexOf('files-panel-recent') + 1)
      await rowLink.click()
      await expect(page).toHaveURL(/\/files\?view=shared$/)
      await expect(rowLink).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('heading', { name: t['filesPanel.shared'] })).toBeVisible()
      const rows = page.getByTestId('shared-file')
      // (Bob also has Olga's notes.md from the file-share fixtures, shared on Nov 1)
      const count = c.role === 'member' ? 3 : 2
      await expect(rows).toHaveCount(count)
      // newest first: the second grant (Nov 14) above the first (Nov 10)
      const names = c.from.map((f) => f.path.slice(f.path.lastIndexOf('/') + 1))
      await expect(rows.nth(0).getByTestId('shared-file-name')).toHaveText(names[1]!)
      await expect(rows.nth(1).getByTestId('shared-file-name')).toHaveText(names[0]!)
      const meta = await rows.nth(0).getByTestId('shared-file-meta').innerText()
      expect(meta.startsWith(`${c.from[1].name} · `)).toBe(true)
      // this year: no year on the line
      expect(meta).not.toContain(String(year))
      // nothing about where it lives
      expect(await page.getByTestId('shared-files-list').innerText()).not.toContain('users/')
      await shots(page, `${c.role}-${locale}-list`)
      await rows.nth(0).click()
      await expect(page).toHaveURL(/\/f\//)
      await expect(page.getByTestId('file-link-name')).toHaveText(names[1]!)
      await expect(page.getByTestId('file-link-meta')).toContainText(translate(locale, 'fileLink.sharedBy', { name: c.from[1].name }))
      const back = page.getByTestId('file-link-back')
      await expect(back).toContainText(t['fileLink.backToShared'])
      await shots(page, `${c.role}-${locale}-file`)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.getByTestId('file-link-back').click()
      await expect(page).toHaveURL(/\/files\?view=shared$/)
      await expect(page.getByTestId('shared-file')).toHaveCount(count)
      await expect(panel.getByTestId('files-panel-shared')).toHaveAttribute('aria-current', 'page')
    })
  }
}

test('the empty list: one muted line, no button; the row is there before anything is shared', async ({ page }) => {
  for (const locale of SHOTS ? (['en', 'ko'] as const) : (['en'] as const)) {
    await world(page, CASES[1], locale, { grants: false })
    await page.goto('/files?view=shared')
    await expect(page.getByTestId('shared-files-empty')).toHaveText(DICTS[locale]['filesPanel.sharedEmpty'])
    await expect(page.getByTestId('shared-files-more')).toHaveCount(0)
    await shots(page, `admin-${locale}-empty`)
  }
})

test('a phone: the Files tab\'s places have the row (44 px); the page has ‹ Files; a file page has ‹ Shared with me back to the list', async ({ page }) => {
  const t = DICTS.en
  await world(page, CASES[2])
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/files')
  const row = page.getByTestId('files-panel-shared')
  await expect(row).toBeVisible()
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await row.click()
  await expect(page).toHaveURL(/\/files\?view=shared$/)
  await expect(page.getByTestId('files-title')).toHaveText(t['filesPanel.shared'])
  await expect(page.getByTestId('files-back')).toBeVisible()
  // a long name is cut on one line, the meta line whole
  const rows = page.getByTestId('shared-file')
  await expect(rows).toHaveCount(3)
  for (const r of await rows.all()) {
    const box = (await r.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  }
  await rows.nth(0).click()
  // one bar: the page's own "‹ Shared with me" (the app's generic phone bar steps aside)
  await expect(page.getByTestId('phone-page-bar')).toHaveCount(1)
  await expect(page.getByTestId('file-link-back')).toBeVisible()
  await page.getByTestId('file-link-back').click()
  await expect(page).toHaveURL(/\/files\?view=shared$/)
  await page.getByTestId('files-back').click()
  await expect(page).toHaveURL(/\/files$/)
})

test('a file link opened from anywhere else (Activity, a pasted link) shows no way back to the list; opening it marks its notice read', async ({ page }) => {
  await world(page, CASES[2])
  const list = await (await page.request.get('/api/files/shared-with-me')).json()
  const id = list.items[0].linkId as string
  const unread = async () => ((await (await page.request.get('/api/notifications?limit=50')).json()).items as { fileShare?: { linkId?: string }; readAt: string | null }[]).filter((n) => n.fileShare?.linkId === id && !n.readAt).length
  expect(await unread()).toBe(1)
  await page.goto(`/f/${id}`)
  await expect(page.getByTestId('file-link-name')).toBeVisible()
  await expect(page.getByTestId('file-link-back')).toHaveCount(0)
  expect(await unread()).toBe(0)
})
