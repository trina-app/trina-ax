// Find work files, part 5 (docs/DECISIONS.md "Find work files, part 5") in a real browser against the mock, with the
// stand-in desktop app (fake-work-files.ts). A Mac app that offers the wide look: Full Disk Access granted goes straight to
// the app's own dialog (wide, with the company's words); not granted shows the Full Disk Access screen, whose Open
// Settings goes on by itself once it is granted, offers one Restart button when the person comes back without it (the restarted app opens the same step again), and
// whose Not now is the three folders as before. Windows looks wide at once. Each row names its place; an online-only file
// says so. The real app is covered by desktop/e2e/work-files-wide.spec.ts.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { answer, app, fakeApp, look, roots, setFullDisk, type Meta } from './fake-work-files'

const BOB = { username: 'bob', password: 'bob password 1' }
const own = (errors: string[]) => realErrors(errors).filter((e) => !/status of (404|409)/.test(e))
const WIDE: Meta[] = [
  { name: 'Acme Q3 plan.xlsx', root: 'cloud', place: 'OneDrive – Acme', folder: 'Plans' },
  { name: 'Acme brief.pptx', root: 'cloud', place: 'OneDrive – Acme', cloud: true },
  { name: 'Acme quote.pdf', root: 'messenger', place: 'KakaoTalk' },
  { name: 'Acme roadmap.docx', root: 'folder', place: 'Projects' },
  { name: 'Acme ideas.md', root: 'home', place: '', folder: 'Notes' },
  { name: 'Acme budget.xlsx', root: 'drive', place: 'D:', folder: 'Finance' },
  { name: 'Acme weekly.docx' },
]
const WIDE_ROOTS = roots({ id: 'messenger', place: 'KakaoTalk', state: 'ok' }, { id: 'folder', place: 'Projects', state: 'ok' }, { id: 'cloud', place: 'OneDrive – Acme', state: 'ok' }, { id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok' }, { id: 'downloads', state: 'ok' })

async function openMine(page: Page) {
  expect((await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })).ok()).toBeTruthy()
  await page.goto('/files?path=users%2Fbob')
  await expect(page.getByTestId('files-find-work-entry')).toBeVisible()
}
const start = async (page: Page, o: Parameters<typeof fakeApp>[1]) => {
  await fakeApp(page, o)
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page, BOB)
  await openMine(page)
}

test('a Mac with Full Disk Access: no screen of its own; the wide look with the company\'s words; each row names its place', async ({ page }) => {
  const errors = watchConsole(page)
  await start(page, { wide: true, fullDisk: 'granted' })
  await look(page, WIDE, WIDE_ROOTS)
  await page.getByTestId('files-find-work-entry').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await expect(page.getByTestId('find-work-access')).toHaveCount(0)
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  const asked = (await app(page)).asks
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ wide: true })
  expect((asked[0] as { words: string[] }).words).toEqual(['Acme'])
  const rows = page.getByTestId('find-work-work').getByTestId('find-work-row')
  await expect(rows).toHaveCount(7)
  const text = await rows.allInnerTexts()
  const row = (name: string) => text.find((x) => x.includes(name)) ?? ''
  expect(row('Acme Q3 plan.xlsx')).toContain('OneDrive – Acme › Plans')
  expect(row('Acme brief.pptx')).toContain('OneDrive – Acme · In the cloud')
  expect(row('Acme quote.pdf')).toContain('KakaoTalk downloads')
  expect(row('Acme roadmap.docx')).toContain('Projects')
  expect(row('Acme ideas.md')).toContain('Home folder › Notes')
  expect(row('Acme budget.xlsx')).toContain('D: › Finance')
  expect(row('Acme weekly.docx')).toContain('Documents')
  // added: each lands under its place's name in My files › From this computer
  await rows.filter({ hasText: 'Acme budget.xlsx' }).getByTestId('find-work-check').check()
  await rows.filter({ hasText: 'Acme ideas.md' }).getByTestId('find-work-check').check()
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'done')
  const tree = async (path: string) => ((await (await page.request.get(`/api/files/tree?path=${encodeURIComponent(path)}`)).json()).entries ?? []).map((e: { name: string }) => e.name).sort()
  expect(await tree('users/bob/From this computer')).toEqual(['D', 'Home'])
  expect(own(errors)).toEqual([])
})

test('a Mac without it: the screen; Open Settings, then on by itself once granted', async ({ page }) => {
  const errors = watchConsole(page)
  await start(page, { wide: true, fullDisk: 'denied' })
  await look(page, WIDE, WIDE_ROOTS)
  await page.getByTestId('files-find-work-entry').click()
  await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'ask')
  // what the person gets first (QA TC-3098), then in one line what the look needs; My files is their own
  await expect(page.getByTestId('find-work-access-title')).toHaveText('Find your work files')
  await expect(page.getByTestId('find-work-access-why')).toHaveText('Trina AX looks through the folders on this Mac and suggests the files you work on. You pick what to add to My files, where only you see them; nothing is moved.')
  await expect(page.getByTestId('find-work-access-need')).toHaveText('To look, Trina AX needs Full Disk Access on this Mac.')
  await expect(page.getByTestId('find-work-access-picture')).toContainText('Privacy & Security › Full Disk Access')
  await expect(page.getByTestId('find-work-access-how')).toHaveAttribute('href', 'https://ax.trina.app/docs/use/find-work-files/')
  // nothing was looked at yet
  expect((await app(page)).scans).toBe(0)
  await page.getByTestId('find-work-access-open').click()
  await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'waiting')
  expect((await app(page)).fdSettings).toBe(1)
  // the person turns it on in Settings: the screen goes on by itself to the app's own dialog, the wide look
  await setFullDisk(page, 'granted')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  expect((await app(page)).asks[0]).toMatchObject({ wide: true })
  expect(own(errors)).toEqual([])
})

test('back from Settings without it: Restart; Not now is the three folders as before', async ({ page }) => {
  await start(page, { wide: true, fullDisk: 'denied' })
  await look(page, WIDE.slice(-1), roots({ id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok' }, { id: 'downloads', state: 'blocked' }))
  await page.getByTestId('files-find-work-entry').click()
  await page.getByTestId('find-work-access-open').click()
  await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'waiting')
  // the person comes back to the window, still without it
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'restart')
  await expect(page.getByTestId('find-work-access-restart')).toHaveText("Switched it on? Restart Trina AX to finish. You'll come back to this step. Open Settings again")
  await expect(page.getByTestId('find-work-access-relaunch')).toHaveText('Restart Trina AX')
  await page.getByTestId('find-work-access-relaunch').click()
  expect((await app(page)).fdRelaunch).toBe(1)
  // Not now: the three folders, macOS asking for each, and Choose it yourself for the one kept out
  await page.getByTestId('find-work-access-later').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  expect((await app(page)).asks).toEqual([null])
  await expect(page.getByTestId('find-work-blocked')).toHaveAttribute('data-root', 'downloads')
})

test('Restart lands back on the same step: the app starts on Home, the page and its dialog open again and go on once granted', async ({ page }) => {
  const errors = watchConsole(page)
  await start(page, { wide: true, fullDisk: 'denied' })
  await look(page, WIDE, WIDE_ROOTS)
  await page.getByTestId('files-find-work-entry').click()
  await page.getByTestId('find-work-access-open').click()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByTestId('find-work-access-relaunch').click()
  expect((await app(page)).fdRelaunch).toBe(1)
  // the restarted app: it opens Home (a new page, the stand-in app with the access now)
  await fakeApp(page, { wide: true, fullDisk: 'granted' })
  await page.goto('/')
  await look(page, WIDE, WIDE_ROOTS)
  await expect(page).toHaveURL(/\/files\?path=users%2Fbob$/)
  // the same dialog, which goes on by itself to the app's own question: nothing said about a restart
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await expect(page.getByTestId('find-work-access-restart')).toHaveCount(0)
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  // taken once: another start on Home stays on Home
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('find-work')).toHaveCount(0)
  expect(own(errors)).toEqual([])
})

test('the setup\'s 팀 파일 step: the team\'s words; Restart lands back on that step', async ({ page }) => {
  await fakeApp(page, { wide: true, fullDisk: 'denied' })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: 'Do this later' }).click()
  await page.getByTestId('skills-later').click()
  await page.getByTestId('welcome-team-files-computer').click()
  await expect(page.getByTestId('find-work-access-title')).toHaveText('Find files your team should have')
  await expect(page.getByTestId('find-work-access-why')).toHaveText('Trina AX looks through the folders on this Mac and suggests files worth sharing with the team. You pick what to share; nothing is shared or moved without you.')
  await page.getByTestId('find-work-access-open').click()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByTestId('find-work-access-relaunch').click()
  await fakeApp(page, { wide: true, fullDisk: 'granted' })
  await page.goto('/')
  await look(page, WIDE, WIDE_ROOTS)
  await expect(page).toHaveURL(/\/welcome$/)
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  expect((await app(page)).asks[0]).toMatchObject({ wide: true })
})

test('closing the screen forgets it: a later start opens Home as usual', async ({ page }) => {
  await start(page, { wide: true, fullDisk: 'denied' })
  await page.getByTestId('files-find-work-entry').click()
  await page.getByTestId('find-work-access-open').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('find-work-access')).toHaveCount(0)
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('find-work-access')).toHaveCount(0)
})

test('Windows: the wide look at once (no screen, no Full Disk Access); the dialog\'s ✕ on the screen closes it', async ({ page }) => {
  await start(page, { wide: true, platform: 'win32' })
  await look(page, WIDE, WIDE_ROOTS)
  await page.getByTestId('files-find-work-entry').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await expect(page.getByTestId('find-work-access')).toHaveCount(0)
  await answer(page, 'cancel')
  await expect(page.getByTestId('find-work')).toHaveCount(0)
  expect((await app(page)).asks[0]).toMatchObject({ wide: true })
})

test('the screen\'s ✕ and Escape close it: nothing looked at', async ({ page }) => {
  await start(page, { wide: true, fullDisk: 'denied' })
  await page.getByTestId('files-find-work-entry').click()
  await expect(page.getByTestId('find-work-access')).toHaveAttribute('data-screen', 'ask')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('find-work-access')).toHaveCount(0)
  expect((await app(page)).scans).toBe(0)
})

test('the 50-file list: Select all ticks the 50 shown, never a personal file; the rest are found by name', async ({ page }) => {
  await start(page, { wide: true, fullDisk: 'granted' })
  const many: Meta[] = [...Array.from({ length: 60 }, (_, i) => ({ name: `Acme report ${i}.docx`, root: 'cloud' as const, place: 'OneDrive – Acme' })), { name: 'Acme payslip_oct.pdf' }]
  await look(page, many, WIDE_ROOTS)
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await expect(page.getByTestId('find-work-work').getByTestId('find-work-row')).toHaveCount(50)
  await expect(page.getByTestId('find-work-rest')).toContainText('10 more documents')
  await expect(page.getByTestId('find-work-select-all')).toHaveText('Select all 50')
  await page.getByTestId('find-work-select-all').click()
  await expect(page.getByTestId('find-work-add')).toHaveText('Add 50 files')
  await expect(page.getByTestId('find-work-personal-toggle')).toBeVisible()
  await page.getByTestId('find-work-personal-toggle').click()
  await expect(page.getByTestId('find-work-personal').getByTestId('find-work-check')).not.toBeChecked()
  // one beyond the 50 is found by name and can be ticked too
  await page.getByTestId('find-work-search').fill('report 59')
  await page.getByTestId('find-work-found').getByTestId('find-work-check').check()
  await expect(page.getByTestId('find-work-add')).toHaveText('Add 51 files')
})
