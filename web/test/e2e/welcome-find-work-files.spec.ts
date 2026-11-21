// The invited person's welcome card on Home, its optional desktop-app row "Bring work files from this computer"
// (components/onboarding/MemberWelcome.tsx FilesRow; docs/DECISIONS.md "The welcome card brings work files from this
// computer"), in a real browser against the mock with the stand-in desktop bridge of find-work-files.spec.ts. Checked: in
// a browser the row opens the desktop app instead, no row with an older app, "1 of 3" either way; the row opens My files' dialog; every way out comes back to
// the card (Cancel in the app's window, the dialog's ✕, Not now on the Full Disk Access screen then Cancel, Undo then
// Close); a file added turns the row done, Undo turns it back; it never holds back "You're all set".
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { answer, app, fakeApp, look, notNow, type Meta } from './fake-work-files'

const BOB = { username: 'bob', password: 'bob password 1' }
const EVERYONE = '01900000-0000-7000-8000-0000000000a1'
const WORK: Meta[] = [
  { name: 'Quote template 2026.xlsx', folder: 'Sales' },
  { name: 'Weekly report - Nov 10.docx', root: 'downloads' },
]

/** Console errors that are no fault of this screen (as find-work-files.spec.ts): a member's sidebar 404, mkdir's 409. */
const own = (errors: string[]) => realErrors(errors).filter((e) => !/status of (404|409)/.test(e))

async function welcomeCard(page: Page, steps: Record<string, boolean> = {}, allSet = false) {
  await page.request.post('/__test/member-welcome', { data: { welcome: {
    team: 'Acme', inviter: { id: 'olga', name: 'Olga' }, people: 3, rooms: [{ id: EVERYONE, kind: 'all', name: null }],
    owner: { id: 'olga', name: 'Olga' }, steps: { rooms: true, hi: false, photo: false, asked: false, ...steps }, allSet,
  } } })
  // the person's own folder is there (a real team makes it with the account)
  expect((await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })).ok()).toBeTruthy()
}

async function home(page: Page) {
  await signIn(page, BOB)
  await page.goto('/')
  await expect(page.getByTestId('member-welcome')).toBeVisible()
}

const row = (page: Page) => page.getByTestId('member-welcome-files')
const backOnCard = async (page: Page) => {
  await expect(page.getByTestId('find-work')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('member-welcome')).toHaveAttribute('data-state', 'open')
  await expect(page.getByTestId('member-welcome-files-button')).toBeVisible()
}

test('a browser: the row opens the desktop app instead (a Mac or Windows browser), and the card counts 1 of 3', async ({ page }) => {
  await reset(page)
  await welcomeCard(page)
  await home(page)
  await expect(page.getByTestId('member-welcome-ask')).toBeVisible()
  // Playwright's Desktop Chrome says Windows: "Open the desktop app" (docs/decisions/20261120-my-setup-card.md)
  await expect(row(page)).toContainText('데스크톱 앱 열기')
  await expect(page.getByTestId('member-welcome-files-button')).toHaveCount(0)
  await expect(page.getByTestId('member-welcome-open-app')).toHaveAttribute('href', '/open-app')
  await expect(page.getByTestId('member-welcome-progress')).toContainText('1')
  await expect(page.getByTestId('member-welcome-progress')).toContainText('3')
})

test('an older desktop app: no files row', async ({ page }) => {
  await fakeApp(page, { version: 99 })
  await reset(page)
  await welcomeCard(page)
  await home(page)
  await expect(page.getByTestId('member-welcome-ask')).toBeVisible()
  await expect(row(page)).toHaveCount(0)
})

test('the desktop app: the row (optional, not counted); Cancel in the app\'s window and the dialog\'s ✕ come back to the card; Add turns it done, Undo turns it back', async ({ page }) => {
  const errors = watchConsole(page)
  await fakeApp(page)
  await reset(page)
  await welcomeCard(page)
  await home(page)
  await expect(row(page)).toBeVisible()
  await expect(row(page)).toHaveAttribute('data-optional', 'true')
  await expect(row(page)).not.toHaveAttribute('data-done', 'true')
  const progress = await page.getByTestId('member-welcome-progress').textContent()
  expect(progress).toMatch(/1\D+3|3\D+1/)

  // 1. Cancel in the app's own window: nothing looked at, back on the card
  await page.getByTestId('member-welcome-files-button').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await answer(page, 'cancel')
  await backOnCard(page)
  expect((await app(page)).reads).toEqual([])

  // 2. the dialog's ✕ on the list: back on the card, nothing ticked or read
  await look(page, WORK)
  await page.getByTestId('member-welcome-files-button').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  for (const c of await page.getByTestId('find-work-check').all()) await expect(c).not.toBeChecked()
  await page.getByRole('dialog').getByRole('button', { name: /close|닫기/i }).first().click()
  await backOnCard(page)
  expect((await app(page)).reads).toEqual([])

  // 3. Add one file: the row is done behind the result; Undo: not done again; Close: the card
  await page.getByTestId('member-welcome-files-button').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await page.getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await notNow(page)
  await expect(row(page)).toHaveAttribute('data-done', 'true')
  await page.getByTestId('find-work-undo').click()
  await expect(page.getByTestId('find-work-undone-until')).toBeVisible()
  await page.getByTestId('find-work-done').click()
  await backOnCard(page)
  await expect(row(page)).not.toHaveAttribute('data-done', 'true')

  // 4. Add again, Close: done (the server looked), Open goes to My files › From this computer; still not counted
  await page.getByTestId('member-welcome-files-button').click()
  await answer(page, 'look')
  await page.getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await notNow(page)
  await page.getByTestId('find-work-done').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(row(page)).toHaveAttribute('data-done', 'true')
  await expect(page.getByTestId('member-welcome-files-open')).toHaveAttribute('href', '/files?path=users%2Fbob%2FFrom%20this%20computer')
  await expect(page.getByTestId('member-welcome-progress')).toHaveText(progress!)
  // the server's answer after a reload says the same
  await page.reload()
  await expect(row(page)).toHaveAttribute('data-done', 'true')
  expect(own(errors)).toEqual([])
})

test('a Mac without Full Disk Access: Not now, then Cancel in the app\'s window, comes back to the card; Not now is kept', async ({ page }) => {
  await fakeApp(page, { wide: true, fullDisk: 'denied' })
  await reset(page)
  await welcomeCard(page)
  await home(page)
  await page.getByTestId('member-welcome-files-button').click()
  await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'ask')
  await page.getByTestId('find-work-access-later').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await answer(page, 'cancel')
  await backOnCard(page)
  // Not now is kept (30 days): the next open goes straight to the three folders, and Cancel there comes back too
  await page.getByTestId('member-welcome-files-button').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await expect(page.getByTestId('find-work-access')).toHaveCount(0)
  await answer(page, 'cancel')
  await backOnCard(page)
})

test('a dialog open on a wide window stays as it is when the window is made narrow; the row goes, the dialog\'s Close comes back to the card', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fakeApp(page)
  await reset(page)
  await welcomeCard(page)
  await home(page)
  await look(page, WORK)
  await page.getByTestId('member-welcome-files-button').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await page.getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  await page.setViewportSize({ width: 390, height: 844 })
  // the same look, the tick kept: not started over
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await expect(page.getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check')).toBeChecked()
  expect((await app(page)).scans).toBe(1)
  await expect(row(page)).toHaveCount(0)
  await page.getByTestId('find-work-cancel').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('member-welcome')).toHaveAttribute('data-state', 'open')
  await expect(row(page)).toHaveCount(0)
})

test('a run started on the card, its dialog closed while it uploads, is the one My files\' line reopens (Undo there)', async ({ page }) => {
  await fakeApp(page)
  await reset(page)
  await welcomeCard(page)
  await home(page)
  await look(page, WORK)
  await page.getByTestId('member-welcome-files-button').click()
  await answer(page, 'look')
  await page.getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  await page.request.post('/__test/upload-delay', { data: { ms: 1500 } })
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'running')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByTestId('member-welcome')).toBeVisible()
  // My files' line opens the same run, not a new look
  // in the app, not a reload (the run lives in the page)
  await page.evaluate(() => { history.pushState({}, '', '/files?path=users%2Fbob'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await page.getByTestId('files-find-work-entry').click()
  await expect(page.getByTestId('find-work-run')).toBeVisible()
  expect((await app(page)).scans).toBe(1)
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await notNow(page)
  await expect(page.getByTestId('find-work-undo')).toBeVisible()
})

test('the all-set card (the server\'s allSet, which never counts files: tests/unit/b-member-welcome) shows no files row', async ({ page }) => {
  await fakeApp(page)
  await reset(page)
  await welcomeCard(page, { hi: true, asked: true }, true)
  await home(page)
  await expect(page.getByTestId('member-welcome')).toHaveAttribute('data-state', 'all-set')
  await expect(row(page)).toHaveCount(0)
})
