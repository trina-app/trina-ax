// Member screens on a phone (390×844, touch), the QA rows' steps as they say them
// (docs/AGENTS/plan/20261112-0412-phone-projects-profile.md):
// - TC-380: "Trina ☰ › Projects" → one row per project (its name, who sees it, ›), no bordered card with "No
//   instructions."; "A project › Files" → no raw path line ("projects/QA 프로젝트"). The row keeps the card's "···" (44 px,
//   always shown, before ›), and a long press opens the same menu as a sheet. No last-chat time: the project has no such
//   field and the chats the app holds are only mine.
// - TC-381 (Settings part): "Me › Security & devices › Other devices" and "› Change password" → ‹ names the page it
//   returns to ("Security & devices" / "보안·기기"). Both pages pass that name; the bar shows it whole where it fits
//   beside the centred title (Korean), and "Security & devices" in English once the bar moves the title over instead
//   of hiding the name: that is #560's change to components/phone/PhonePageBar.tsx (its bar says `data-fit`), checked
//   here as soon as it is in.
// - TC-382 items 1–2: "Me › Profile" → a centred photo you tap to change (no "Choose a photo" box beside it), the name,
//   job title and email as rows of one group, the username and role as rows; Save in the bar once something changed,
//   saving as before; "Change password" → one button the form's width.
// A computer keeps the cards, the path line's folder screen and the profile form (phone-member-pages.spec.ts). Each case
// runs in WebKit (the iPhone app's engine: phone-member-pages.webkit.spec.ts) and Chromium (Android's).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { backLabelHasRoom, reset, signIn } from './helpers'
import { openProjectsTab, openTab } from './nav'
import { DICTS } from '../../src/i18n'

const en = DICTS.en
const ko = DICTS.ko
const H = { [CSRF_HEADER]: '1' }
export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US', serviceWorkers: 'block' } as const
/** a 1×1 PNG: the photo picker's file */
const PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const box = async (l: Locator) => (await l.boundingBox())!

async function call(page: Page, method: 'POST' | 'PATCH', path: string, data: unknown = {}) {
  const r = await page.request.fetch(path, { method, headers: H, data })
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}

/** SHOTS=1: screenshots of each screen into $SHOTS_DIR (default test-results/phone-member-pages) */
export const shot = (page: Page, name: string) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS_DIR ?? 'test-results/phone-member-pages'}/${name}.png` }).then(() => {}) : Promise.resolve())


/** Two projects: "QA 프로젝트" (no instructions, a chat in it) and "Launch" (instructions, no chat). */
export async function twoProjects(page: Page) {
  const qa = (await call(page, 'POST', '/api/projects', { name: 'QA 프로젝트', scope: 'team', instructions: '' })) as { id: string; folderPath: string }
  const launch = (await call(page, 'POST', '/api/projects', { name: 'Launch', scope: 'team', instructions: '# Launch\n\nAnswer in **short** bullet points.' })) as { id: string; folderPath: string }
  await call(page, 'POST', '/api/chats', { projectId: qa.id, title: 'Weekly numbers' })
  await call(page, 'POST', '/__test/file', { path: `${qa.folderPath}/notes.md`, text: '# Notes' })
  return { qa, launch }
}

/** Me › Security & devices, with this device and two others signed in */
async function security(page: Page) {
  const at = new Date().toISOString()
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  const items = Array.from({ length: 3 }, (_, i) => ({ id: `0192f0a0-0000-7000-8000-${String(i).padStart(12, '0')}`, client: 'web', userAgent: ua, createdAt: at, lastSeenAt: at, expiresAt: at, current: i === 0 }))
  await page.route('**/api/me/sessions', (r) => r.fulfill({ json: { items } }))
  await openTab(page, 'me')
  await page.getByTestId('settings-row-security').click()
  await expect(page).toHaveURL(/\/settings\/security$/)
}

/** ‹ names where it goes: the page passes the name, and the bar shows it whole (not hidden for want of room). `fits`:
 * the name fits beside the centred title in any bar (Korean); otherwise it is shown once the bar has #560's layout. */
async function backNamed(page: Page, name: string, fits: boolean) {
  const label = page.getByTestId('settings-back-label')
  await expect(label).toHaveText(name)
  const movable = (await page.getByTestId('settings-dialog').getByTestId('phone-page-bar').getAttribute('data-fit')) !== null
  if (!fits && !movable) return
  // no room in this font for ‹ with its name beside the whole title (Linux's wider DejaVu Sans): ‹ alone, still named
  if (!fits && !(await backLabelHasRoom(label))) return await expect(label).toBeHidden()
  await expect(label).toBeVisible()
  await expect(label).toHaveAttribute('data-fits', '')
  // the whole label is in sight, inside the bar and clear of the title
  const l = await box(label)
  const title = await box(page.getByTestId('settings-section-title'))
  expect(l.x).toBeGreaterThanOrEqual(0)
  expect(l.x + l.width).toBeLessThanOrEqual(title.x + 1)
  expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
}

export function memberPageCases() {
  test.use(PHONE)

  test('TC-380: the 프로젝트 tab is one plain row per project (name, who sees it), no card, no "No instructions.", no "···"; a tap opens it', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const { qa, launch } = await twoProjects(page)
    await page.goto('/')
    // 1. Projects: the 프로젝트 tab since QA TC-255 (it was Trina ☰ › Projects)
    await openProjectsTab(page)
    // the 프로젝트 tab's list (panels/ProjectsPanel.tsx ProjectsList): rename, members and delete are on the project's
    // page, so a row has no "···" or long-press menu
    const rows = page.getByTestId('phone-projects-list').getByTestId('projects-panel-row')
    await expect(rows).toHaveCount(2)
    await shot(page, 'projects')
    // no cards, no "No instructions.", no instructions at all on the list
    await expect(page.getByTestId('project-card')).toHaveCount(0)
    await expect(page.getByText(en['projects.noInstructions'])).toHaveCount(0)
    await expect(page.getByText('Answer in short bullet points.')).toHaveCount(0)
    const row = rows.filter({ hasText: 'QA 프로젝트' })
    // its name, who sees it on the line under it (no folder path)
    await expect(row.getByTestId('projects-panel-name')).toHaveText('QA 프로젝트')
    await expect(row.getByTestId('projects-panel-meta')).not.toHaveText('')
    await expect(row.getByTestId('projects-panel-meta')).not.toContainText('projects/')
    await expect(row.getByTestId('project-card-menu')).toHaveCount(0)
    // a thumb's row: at least 44 px tall, inside the screen
    const b = await box(row)
    expect(b.x).toBeGreaterThanOrEqual(0)
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    expect(Math.round(b.height)).toBeGreaterThanOrEqual(44)
    // a tap opens the project
    await row.click()
    await expect(page).toHaveURL(new RegExp(`/projects/${qa.id}$`))

    // 2. A project › Files: no raw path line
    await page.getByTestId('project-files-open').click()
    await expect(page).toHaveURL(new RegExp(`/projects/${qa.id}/files$`))
    await expect(page.getByTestId('project-file')).toHaveCount(1)
    await expect(page.getByTestId('project-files-page').getByText(qa.folderPath)).toHaveCount(0)
    await expect(page.getByTestId('project-files-page')).not.toContainText('projects/')
    await shot(page, 'project-files')
    void launch
  })

  test('TC-381: › Other devices and › Change password name ‹ "Security & devices" (shown whole with #560\'s bar); ‹ goes back there', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await security(page)
    await page.getByTestId('devices-more').click()
    await expect(page).toHaveURL(/\/settings\/security\/devices$/)
    await backNamed(page, en['settings.security'], false)
    await shot(page, 'devices')
    await page.getByTestId('settings-back').click()
    await expect(page).toHaveURL(/\/settings\/security$/)
    await page.getByTestId('password-open').click()
    await expect(page).toHaveURL(/\/settings\/security\/password$/)
    await backNamed(page, en['settings.security'], false)
    await shot(page, 'password')
    await page.getByTestId('settings-back').click()
    await expect(page).toHaveURL(/\/settings\/security$/)
  })

  test('TC-381 in Korean: ‹ 보안·기기 shown whole on both pages', async ({ page }) => {
    await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
    await signIn(page)
    await security(page)
    await page.getByTestId('devices-more').click()
    await backNamed(page, ko['settings.security'], true)
    await page.getByTestId('settings-back').click()
    await page.getByTestId('password-open').click()
    await backNamed(page, ko['settings.security'], true)
  })

  test('TC-382 item 1: Profile has a centred photo to tap (no "Choose a photo" box), the fields as rows, Save in the bar saving as before', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const sent: { profile: unknown[]; avatar: string[] } = { profile: [], avatar: [] }
    await page.route('**/api/me/profile', async (r) => {
      sent.profile.push(r.request().postDataJSON())
      await r.fulfill({ json: { id: 'olga', name: 'Olga B', title: 'Designer' } })
    })
    await page.route('**/api/me/avatar*', async (r) => {
      sent.avatar.push(r.request().method())
      await r.fulfill({ json: { avatarVersion: 1 } })
    })
    // Me › Profile
    await openTab(page, 'me')
    await page.getByTestId('settings-me').click()
    await expect(page).toHaveURL(/\/settings\/profile$/)
    await expect(page.getByTestId('profile-form')).toBeVisible()
    await shot(page, 'profile')
    // the photo: centred, one tap target of at least 44 px, no "Choose a photo" button beside it
    await expect(page.getByRole('button', { name: en['profile.photoChoose'] })).toHaveCount(0)
    await expect(page.getByText(en['profile.photoChoose'])).toHaveCount(0)
    const photo = page.getByTestId('profile-photo-pick')
    const p = await box(photo)
    expect(Math.round(p.height)).toBeGreaterThanOrEqual(44)
    expect(Math.round(p.width)).toBeGreaterThanOrEqual(44)
    expect(Math.abs(p.x + p.width / 2 - 195)).toBeLessThanOrEqual(2)
    await expect(photo).toContainText(en['profile.photoAdd'])
    // the name, job title and email: rows of one group (no frame on the fields), each at least 48 px
    const fields = page.getByTestId('profile-fields')
    await expect(fields.locator('li')).toHaveCount(3)
    for (const li of await fields.locator('li').all()) expect(Math.round((await box(li)).height)).toBeGreaterThanOrEqual(48)
    for (const input of await fields.locator('input').all()) expect(await input.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')
    await expect(fields).toContainText(en['auth.name'])
    await expect(fields).toContainText(en['profile.title'])
    await expect(fields).toContainText(en['settings.email'])
    // the username and role stay rows
    await expect(page.getByTestId('profile-account')).toContainText(en['auth.username'])
    await expect(page.getByTestId('profile-username')).toHaveText('olga')
    await expect(page.getByTestId('profile-account')).toContainText(en['settings.role'])
    // nothing to save yet: no Save anywhere
    await expect(page.getByTestId('profile-save')).toHaveCount(0)

    // a tap on the photo opens the photo picker (no photo yet); the picked one shows, and Save is in the bar
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), photo.click()])
    await chooser.setFiles({ name: 'me.png', mimeType: 'image/png', buffer: PHOTO })
    await expect(page.getByTestId('profile-photo-preview')).toBeVisible()
    const save = page.getByTestId('settings-bar-action').getByTestId('profile-save')
    await expect(save).toBeVisible()
    await expect(page.getByTestId('profile-form').getByTestId('profile-save')).toHaveCount(0)
    expect(Math.round((await box(save)).height)).toBeGreaterThanOrEqual(44)
    // with a photo, a tap opens the photo choices as a sheet: a new one, or take it away
    await photo.click()
    const sheet = page.getByRole('menu')
    await expect(sheet.getByTestId('profile-photo-new')).toHaveText(en['profile.photoChange'])
    await expect(sheet.getByTestId('profile-photo-remove')).toHaveText(en['profile.photoRemove'])
    await shot(page, 'profile-photo-sheet')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    // a new name, then Save in the bar: the same calls as before, and "Saved."
    await fields.locator('input').first().fill('Olga B')
    await shot(page, 'profile-changed')
    await save.click()
    await expect(page.getByText(en['common.saved'])).toBeVisible()
    expect(sent.profile).toEqual([{ name: 'Olga B', title: '' }])
    expect(sent.avatar).toEqual(['PUT'])
  })

  test('TC-382 item 1: Enter in a field saves, as before (the bar\'s Save is the form\'s)', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    const sent: unknown[] = []
    await page.route('**/api/me/profile', async (r) => {
      sent.push(r.request().postDataJSON())
      await r.fulfill({ json: { id: 'olga', name: 'Olga', title: 'Designer' } })
    })
    await page.goto('/settings/profile')
    const title = page.getByTestId('profile-fields').locator('input').nth(1)
    await title.fill('Designer')
    await title.press('Enter')
    await expect(page.getByText(en['common.saved'])).toBeVisible()
    expect(sent).toEqual([{ name: 'Olga', title: 'Designer' }])
  })

  test('TC-382 item 2: Change password has one button the form\'s width at its end', async ({ page }) => {
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await security(page)
    await page.getByTestId('password-open').click()
    const button = page.getByTestId('password-submit')
    await expect(button).toBeVisible()
    const b = await box(button)
    const field = await box(page.getByTestId('password-new2'))
    // as wide as the fields, under the last one, at least 44 px tall
    expect(Math.abs(b.x - field.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(b.width - field.width)).toBeLessThanOrEqual(1)
    expect(b.y).toBeGreaterThan(field.y + field.height)
    expect(Math.round(b.height)).toBeGreaterThanOrEqual(44)
    await shot(page, 'password-form')
  })
}
