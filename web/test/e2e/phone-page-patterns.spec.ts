// The shared phone page patterns (docs/DECISIONS.md "Admin and Settings on phones: a list you tap into", the page
// patterns), on Admin › Members & invites at 390×844 in a real browser: the page's name in the bar only (the page keeps
// it for screen readers); one main button with the other ways under its ⌄ (components/PageActions.tsx); the search and
// a Filters button on one row, the filters under it (components/PhoneFilters.tsx); compact rows, the second line only
// when it adds something (components/CompactRow.tsx); only the search row stays at the top. A computer keeps every
// button and the filter in the row.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' })

const t = DICTS.en
const box = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())!

test.beforeEach(async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/members')
  await expect(page.getByTestId('member-card-bob').or(page.getByTestId('members-table'))).toBeVisible()
})

test('the name is in the bar, the page keeps it for screen readers; one main button, the others under its ⌄', async ({ page }) => {
  await expect(page.getByTestId('admin-bar-title')).toHaveText(t['admin.members'])
  const heading = page.getByRole('heading', { level: 2, name: new RegExp(t['members.title']) })
  await expect(heading).toBeAttached()
  expect((await heading.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
  // one button and its ⌄, not three buttons on two rows
  await expect(page.getByTestId('invite-new')).toBeVisible()
  await expect(page.getByTestId('team-link-open')).toHaveCount(0)
  await expect(page.getByTestId('member-add')).toHaveCount(0)
  const more = page.getByTestId('invite-new-more')
  await expect(more).toHaveAccessibleName(t['members.inviteMore'])
  await more.click()
  const menu = page.getByRole('menu', { name: t['members.inviteMore'] })
  await expect(menu.getByRole('menuitem')).toHaveText([t['members.add'], t['teamLink.title']])
  const m = (await menu.boundingBox())!
  expect(m.x).toBeGreaterThanOrEqual(0)
  expect(m.x + m.width).toBeLessThanOrEqual(390)
  await page.getByTestId('team-link-open').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
})

test('the search and Filters share one row; the role filter opens under it and its count shows', async ({ page }) => {
  const search = await box(page, 'member-search')
  const filters = await box(page, 'member-filters-toggle')
  expect(Math.abs(search.y + search.height / 2 - (filters.y + filters.height / 2))).toBeLessThanOrEqual(2)
  expect(filters.x + filters.width).toBeLessThanOrEqual(390)
  await expect(page.getByTestId('member-role-filter-pill')).toBeHidden()
  await page.getByTestId('member-filters-toggle').click()
  await expect(page.getByTestId('member-filters-toggle')).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('member-role-filter').selectOption('owner')
  // the button says how many filters are on, to the eye and in its name
  await expect(page.getByTestId('member-filters-toggle')).toHaveAccessibleName(`${t['activity.filters']} 1 on`)
  await expect(page.getByTestId('member-card-olga')).toBeVisible()
  await expect(page.getByTestId('member-card-bob')).toHaveCount(0)
})

test('rows: one line with the role on the right; the owner\'s choice is 44 px; a second line only for what it adds', async ({ page }) => {
  const bob = page.getByTestId('member-card-bob')
  // "Bob" / "bob": the username adds nothing, so one line
  expect((await bob.boundingBox())!.height).toBeLessThanOrEqual(56)
  const role = bob.getByTestId('member-role-bob')
  expect(Math.round((await role.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  const name = (await bob.getByText('Bob', { exact: true }).boundingBox())!
  const r = (await role.boundingBox())!
  expect(Math.abs(name.y + name.height / 2 - (r.y + r.height / 2))).toBeLessThanOrEqual(4)
  // the first member comes early: the header is one line and the search row
  expect((await box(page, 'member-card-olga')).y).toBeLessThan(330)
  await expect(page.getByTestId('member-email-olga')).toHaveCount(0)
  // a username that is not the name: on the second line
  expect((await page.request.post('/api/admin/users', { headers: { [CSRF_HEADER]: '1' }, data: { name: 'Carol Kim', username: 'carol', role: 'member', groupIds: [], temporaryPassword: 'maple2026' } })).ok()).toBeTruthy()
  await page.reload()
  const carol = page.getByTestId('member-card-carol')
  await expect(carol).toContainText('Carol Kim')
  await expect(carol).toContainText('carol')
  expect((await carol.boundingBox())!.height).toBeGreaterThan(56)
  // a search that matches the email only: the email shows on the second line
  expect((await page.request.patch('/api/me', { headers: { [CSRF_HEADER]: '1' }, data: { email: 'boss@acme.example' } })).ok()).toBeTruthy()
  await page.reload()
  await page.getByTestId('member-search').fill('boss@')
  await expect(page.getByTestId('member-email-olga')).toHaveText('boss@acme.example')
  await expect(page.getByTestId('member-card-bob')).toHaveCount(0)
})

test('only the search row stays at the top while the list scrolls', async ({ page }) => {
  // enough people to scroll
  for (let i = 0; i < 14; i++) await page.request.post('/api/admin/users', { headers: { [CSRF_HEADER]: '1' }, data: { name: `Person ${i}`, username: `person${i}`, role: 'member', groupIds: [], temporaryPassword: 'maple2026' } })
  await page.reload()
  const controls = page.getByTestId('members-header-controls')
  await expect(controls).toBeVisible()
  expect((await controls.boundingBox())!.height).toBeLessThanOrEqual(64)
  const content = page.getByTestId('admin-content')
  const top = (await content.boundingBox())!.y
  await content.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
  // the controls are stuck at the top of the page's box; the line and the buttons scrolled away
  expect(Math.round((await controls.boundingBox())!.y)).toBe(Math.round(top))
  await expect(page.getByTestId('invite-new')).not.toBeInViewport()
})

test('an admin who is not the owner reads the roles; the other pages keep their buttons', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await signIn(page, { username: 'dana', password: 'dana password 1' })
  await page.goto('/admin/members')
  await expect(page.getByTestId('member-card-bob')).toBeVisible()
  // read, not a choice: the owner alone changes roles
  await expect(page.getByTestId('member-card-bob').locator('select')).toHaveCount(0)
  await expect(page.getByTestId('member-role-bob')).toHaveText(t['role.member'])
  // Usage: Download CSV sits under the ⌄ of Usage limits on a phone (phone-list-pages.spec.ts)
  for (const [path, id] of [['/admin/groups', 'group-new'], ['/admin/usage', 'usage-limits-link']] as const) {
    await page.goto(path)
    await expect(page.getByTestId(id)).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
  await page.getByTestId('usage-limits-link-more').click()
  await expect(page.getByTestId('usage-csv')).toBeVisible()
})

test('Connectors and AI apps say their name once on a phone (the bar), in Admin and in Settings', async ({ page }) => {
  for (const [path, bar] of [['/admin/connectors', 'admin-bar-title'], ['/settings/connectors', 'settings-section-title'], ['/settings/ai-apps', 'settings-section-title']] as const) {
    await page.goto(path)
    const name = path.endsWith('ai-apps') ? t['aiApps.title'] : t['integrations.title']
    await expect(page.getByTestId(bar)).toHaveText(name)
    const h2 = page.getByRole('heading', { level: 2, name, exact: true })
    await expect(h2).toBeAttached()
    expect((await h2.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1)
  }
})

for (const width of [768, 1440]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: false, isMobile: false })
    test('every button and the role filter in the row, the title shown, as before', async ({ page }) => {
      await expect(page.getByTestId('members-table')).toBeVisible()
      for (const id of ['invite-new', 'team-link-open', 'member-add', 'member-role-filter-pill']) await expect(page.getByTestId(id)).toBeVisible()
      await expect(page.getByTestId('invite-new-more')).toHaveCount(0)
      await expect(page.getByTestId('member-filters-toggle')).toHaveCount(0)
      await expect(page.getByRole('heading', { level: 2, name: new RegExp(t['members.title']) })).toBeVisible()
    })
  })
}
