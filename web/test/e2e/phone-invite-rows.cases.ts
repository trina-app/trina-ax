// Phone rows in Admin (390×844, touch), the QA rows' steps as they say them:
// - TC-390: "Admin › Members & invites, with a team invite link made. Look at the Invite links section." → "The link's
//   row reads as a phone row: its name, then its details (team, uses, expiry) on one or two lines under it, and its
//   actions (Copy link only, ⋯) on the right or in ⋯; no column of single words." The details were squeezed between the
//   name and Copy link only, one word per line. Copy, ⋯ › Link settings… and ⋯ › Turn off work as before.
// - TC-382 item 4: "Admin › Team settings › General (Team logo) and › File list (Run now)" → "actions as rows or
//   full-width buttons on phones, not small outline buttons beside text": Upload logo and Run now are list rows across
//   the screen (Upload logo with the logo now on its right), and do what the buttons did.
// Each test runs in WebKit (the iPhone app's engine: phone-invite-rows.webkit.spec.ts) and Chromium (Android's:
// phone-invite-rows.spec.ts). A computer (1440) keeps its one-line row and its small buttons (computerCases, Chromium).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { makePng } from '../../../tests/lib/images'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.en
const W = 390
const post = async (page: Page, path: string, data: object) => {
  const r = await page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.ok(), `${path}: ${r.status()}`).toBe(true)
  return r.json()
}

/** a group and the team invite link for it (20 uses, 14 days), and one single-use invite */
async function makeLinks(page: Page) {
  const group = await post(page, '/api/admin/groups', { name: 'Phone QA' })
  await post(page, '/api/admin/team-link', { groupIds: [group.id] })
  await post(page, '/api/admin/invites', { role: 'member' })
}

/** 나 › Admin › a section, as a person taps it */
async function openAdmin(page: Page, id: string) {
  await page.getByTestId('tab-me').click()
  await page.getByTestId('settings-admin').click()
  await expect(page.getByTestId('admin-phone-root')).toBeVisible()
  await page.getByTestId(`admin-row-${id}`).click()
  await expect(page).toHaveURL(new RegExp(`/admin/${id}$`))
}

async function openTeamSettings(page: Page, group: string) {
  await openAdmin(page, 'settings')
  await page.getByTestId(`team-settings-row-${group}`).click()
  await expect(page).toHaveURL(new RegExp(`/admin/settings/${group}$`))
}

const box = async (l: Locator) => (await l.boundingBox())!
const lineHeight = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight))
const noSideways = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(W)

/** a row across the screen, as Settings' rows: at least 300 px wide at 390, a 44 px target, inside the screen */
async function expectRow(row: Locator, what: string) {
  const b = await box(row)
  expect(b.width, `${what}: width`).toBeGreaterThanOrEqual(300)
  expect(Math.round(b.height), `${what}: height`).toBeGreaterThanOrEqual(44)
  expect(Math.round(b.x + b.width), `${what}: right edge`).toBeLessThanOrEqual(W)
}

/** TC-390: the team link's row: the name, the details under it as wide as the row allows, the actions on the right */
async function expectLinkRow(page: Page, name: string) {
  const row = page.getByTestId('team-link-row')
  const title = row.getByText(name, { exact: true })
  const details = row.getByTestId('team-link-details')
  const [r, n, d] = [await box(row), await box(title), await box(details)]
  // the details: at least 120 px wide (they were one word per line), on one or two lines (three at most), under the name
  expect(d.width).toBeGreaterThanOrEqual(120)
  expect(d.height).toBeLessThanOrEqual(3 * (await lineHeight(details)) + 1)
  expect(d.y).toBeGreaterThanOrEqual(n.y + n.height - 1)
  // the actions on the right of the name, each a 44 px target, inside the screen
  const copy = row.getByRole('button', { name: t['teamLink.copyLink'] })
  const more = row.getByTestId('member-more')
  for (const [b, what] of [[await box(copy), 'Copy link only'], [await box(more), '⋯']] as const) {
    expect(Math.round(b.height), what).toBeGreaterThanOrEqual(44)
    expect(Math.round(b.width), what).toBeGreaterThanOrEqual(44)
    expect(b.x, what).toBeGreaterThanOrEqual(n.x + n.width)
    expect(Math.round(b.x + b.width), what).toBeLessThanOrEqual(W)
  }
  expect(Math.round(r.x + r.width)).toBeLessThanOrEqual(W)
  return { row, details, copy, more, d }
}

export function phoneCases() {
  // the app's service worker (WebKit) would answer the API itself, past page.route
  test.use({ viewport: { width: W, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US', serviceWorkers: 'block' })

  test.beforeEach(async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  })

  test('TC-390: the team invite link is a phone row: name, details under it, Copy link only and ⋯ on the right; each still works', async ({ page, browserName }) => {
    const errors = watchConsole(page)
    await signIn(page)
    await makeLinks(page)
    await openAdmin(page, 'members')
    const section = page.getByTestId('invite-links')
    await expect(section.getByRole('heading', { name: t['members.invites'] })).toBeVisible()
    const { details, copy, more, d } = await expectLinkRow(page, t['teamLink.title'])
    // the team, the uses and the end date, in full; one or two lines in English
    await expect(details).toContainText('Phone QA')
    await expect(details).toContainText(translate('en', 'teamLink.uses', { used: 0, max: 20 }))
    await expect(details).toContainText(/\d{4}/)
    expect(d.height).toBeLessThanOrEqual(2 * (await lineHeight(details)) + 1)
    expect(d.width).toBeGreaterThan(300)
    // the single-use invite's row stays one tidy row with Revoke
    await expect(page.getByTestId('invite-list').locator('li')).toHaveCount(1)
    await noSideways(page)
    await page.screenshot({ path: test.info().outputPath(`invite-links-${browserName}-390.png`) })

    // Copy link only copies the link (WebKit grants no clipboard reading: the button says Copied there)
    await copy.click()
    await expect(page.getByTestId('team-link-row').getByRole('button', { name: t['common.copied'] })).toBeVisible()
    if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/join#t=tl[0-9a-f]+$/)
    // ⋯ › Link settings… opens the link's popup
    await more.click()
    await page.getByRole('menu').getByTestId('team-link-row-open').click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('team-link-url')).toBeVisible()
    await page.getByTestId('team-link-done').click()
    await expect(dialog).toHaveCount(0)
    // ⋯ › Turn off asks first, then the row goes
    await more.click()
    await page.getByRole('menu').getByTestId('team-link-row-revoke').click()
    await page.getByTestId('dialog-confirm').click()
    await expect(page.getByTestId('team-link-row')).toHaveCount(0)
    await expect(page.getByTestId('invite-list').locator('li')).toHaveCount(1)
    expect(realErrors(errors)).toEqual([])
  })

  test('TC-390: in a long language (Spanish) the details stay a block under the name, not one word per line', async ({ page }) => {
    await reset(page, { teamLocale: 'es', usersFollowTeam: true })
    await signIn(page)
    await makeLinks(page)
    await page.goto('/admin/members')
    const es = DICTS.es
    await expect(page.getByTestId('team-link-row')).toContainText(es['teamLink.title'])
    const row = page.getByTestId('team-link-row')
    const details = row.getByTestId('team-link-details')
    const d = await box(details)
    expect(d.width).toBeGreaterThan(300)
    expect(d.height).toBeLessThanOrEqual(3 * (await lineHeight(details)) + 1)
    for (const b of [await box(row.getByRole('button', { name: es['teamLink.copyLink'] })), await box(row.getByTestId('member-more'))]) {
      expect(Math.round(b.height)).toBeGreaterThanOrEqual(44)
      expect(Math.round(b.x + b.width)).toBeLessThanOrEqual(W)
    }
    await noSideways(page)
  })

  test('TC-382 item 4: Team settings › General: Upload logo is a row across the screen with the logo on it; it uploads, Back to the default icon is a row too', async ({ page, browserName }) => {
    const errors = watchConsole(page)
    await signIn(page)
    await openTeamSettings(page, 'general')
    const card = page.getByTestId('team-icon')
    const upload = page.getByTestId('team-icon-upload')
    await upload.scrollIntoViewIfNeeded()
    await expect(upload).toHaveText(t['teamIcon.upload'])
    await expectRow(upload, 'Upload logo')
    // the logo now on its right (the default mark), not a separate picture beside a small button
    const logo = upload.locator('img')
    await expect(logo).toHaveAttribute('src', '/favicon.svg')
    expect((await box(logo)).x).toBeGreaterThan(W / 2)
    await expect(page.getByTestId('team-icon-remove')).toHaveCount(0)
    await noSideways(page)
    await page.screenshot({ path: test.info().outputPath(`team-logo-${browserName}-390.png`) })

    // a tap opens the file picker, as the button did; a PNG is uploaded and shows on the row
    const chooser = page.waitForEvent('filechooser')
    await upload.click()
    await (await chooser).setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: Buffer.from(makePng(256, 256)) })
    await expect(page.getByText(t['teamIcon.saved'])).toBeVisible()
    await expect(card).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
    const v = (await card.getAttribute('data-version'))!
    await expect(upload).toHaveText(t['teamIcon.replace'])
    await expect(logo).toHaveAttribute('src', `/team-icon?v=${v}`)
    // a file it refuses says why, as before
    await page.getByTestId('team-icon-input').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from(makePng(16, 16)) })
    await expect(page.getByTestId('team-icon-error')).toBeVisible()
    // Back to the default icon: a row too; it asks first, then the default mark is back
    const remove = page.getByTestId('team-icon-remove')
    await expect(remove).toHaveText(t['teamIcon.remove'])
    await expectRow(remove, 'Back to the default icon')
    await page.screenshot({ path: test.info().outputPath(`team-logo-set-${browserName}-390.png`) })
    await remove.click()
    await page.getByTestId('dialog-confirm').click()
    await expect(page.getByText(t['teamIcon.removed'])).toBeVisible()
    await expect(upload).toHaveText(t['teamIcon.upload'])
    await expect(remove).toHaveCount(0)
    expect(realErrors(errors)).toEqual([])
  })

  test('TC-382 item 4: Team settings › File list: Run now is a row across the screen; it starts a run, the row says it is reading, then Run now is back', async ({ page, browserName }) => {
    const errors = watchConsole(page)
    await signIn(page)
    await openTeamSettings(page, 'file-list')
    const run = page.getByTestId('file-list-run')
    await expect(run).toHaveText(t['fileList.runNow'])
    await expectRow(run, 'Run now')
    // under the status lines, not beside them
    expect((await box(run)).y).toBeGreaterThanOrEqual((await box(page.getByTestId('file-list-status'))).y + (await box(page.getByTestId('file-list-status'))).height)
    await noSideways(page)
    await page.screenshot({ path: test.info().outputPath(`file-list-${browserName}-390.png`) })
    await run.click()
    await expect(page.getByTestId('file-list-running')).toHaveText(t['fileList.running'])
    await expect(run).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('file-list-counts')).toHaveText('Files listed: 1,258')
    expect(realErrors(errors)).toEqual([])
  })

  test('TC-382 item 4: Run now is a row that cannot be tapped while the team has no AI for it', async ({ page }) => {
    await page.route('**/api/admin/file-list', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const r = await route.fetch()
      await route.fulfill({ response: r, json: { ...(await r.json()), problem: 'no_ai', signIn: null } })
    })
    await signIn(page)
    await page.goto('/admin/settings/file-list')
    await expect(page.getByTestId('file-list-problem')).toBeVisible()
    await expect(page.getByTestId('file-list-run')).toBeDisabled()
  })
}

/** A computer (1440): the team link row, the logo's buttons and Run now as they were (one line, small buttons). The
 * screenshots are compared with the ones taken before this change. */
export function computerCases() {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })

  test('a computer keeps the one-line team link row, the logo buttons and the small Run now', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    // a fixed end date, so the pictures can be compared run to run
    await page.route('**/api/admin/team-link', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const r = await route.fetch()
      const body = await r.json()
      if (body.link) body.link = { ...body.link, expiresAt: '2026-11-26T04:13:00.000Z' }
      await route.fulfill({ response: r, json: body })
    })
    await page.route('**/api/admin/invites', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const r = await route.fetch()
      const body = await r.json()
      await route.fulfill({ response: r, json: { ...body, items: body.items.map((i: object) => ({ ...i, expiresAt: '2026-11-19T04:13:00.000Z' })) } })
    })
    await signIn(page)
    await makeLinks(page)
    await page.goto('/admin/members')
    const row = page.getByTestId('team-link-row')
    await expect(row).toContainText('Phone QA')
    // one line: the name, the details, Copy link only and "…" side by side
    expect((await box(row)).height).toBeLessThan(60)
    await expect(row.getByTestId('team-link-details')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await page.getByTestId('invite-links').screenshot({ path: test.info().outputPath('invite-links-1440.png') })

    await page.goto('/admin/settings')
    const upload = page.getByTestId('team-icon-upload')
    await expect(upload).toBeVisible()
    await expect(page.getByTestId('team-icon-rows')).toHaveCount(0)
    expect((await box(upload)).width).toBeLessThan(200)
    await upload.scrollIntoViewIfNeeded()
    await page.getByTestId('team-icon').screenshot({ path: test.info().outputPath('team-logo-1440.png') })
    const run = page.getByTestId('file-list-run')
    await run.scrollIntoViewIfNeeded()
    expect((await box(run)).width).toBeLessThan(200)
    await expect(page.getByTestId('file-list-run-row')).toHaveCount(0)
    await page.getByTestId('file-list').screenshot({ path: test.info().outputPath('file-list-1440.png') })
  })
}
