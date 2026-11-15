// Find work files on this computer (docs/DECISIONS.md "Find work files on this computer") in a real browser against the
// mock. The desktop app is a stand-in bridge (window.mycelDesktop.workFiles) that answers like the real main process
// (desktop/src/main/work-files.ts): scan() waits for "its own dialog" (the test answers it), then gives the list with an
// id per file; read() gives bytes only for ids of its latest look and logs each read. The real app is covered by
// desktop/e2e/work-files.spec.ts. Checked here: who gets the entry, Cancel in the app's dialog, nothing ticked, the
// folders' lines (macOS kept the app out, a big Downloads, the home folder), the personal group (never sent to the AI),
// Select all and the 100 cap, nothing read before Add, My files › From this computer, Undo (only what the run made), no
// AI, a read the app refuses, every folder blocked, the owner's setup step (the team home), and an older app.
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

import { answer, app, fakeApp, look, pickHolds, roots, type Meta } from './fake-work-files'

const BOB = { username: 'bob', password: 'bob password 1' }

const tree = async (page: Page, path: string) => ((await (await page.request.get(`/api/files/tree?path=${encodeURIComponent(path)}`)).json()).entries ?? []) as { name: string; type: string }[]

const WORK: Meta[] = [
  { name: 'Quote template 2026.xlsx', folder: 'Sales' },
  { name: 'Brand guide v3.pdf', folder: 'Brand' },
  { name: 'Weekly report - Nov 10.docx', root: 'downloads' },
  { name: 'Northwind proposal.pptx', folder: 'Clients/Northwind' },
  { name: 'notes.txt', root: 'desktop' },
  { name: 'payslip_oct.pdf', root: 'downloads' },
  { name: '급여명세서 10월.pdf', root: 'desktop' },
]

/** Console errors that are no fault of this screen: the mock's sidebar asks a member for a group folder they cannot see
 * (404), and a run's mkdir of a folder that is there answers 409 (folderUpload.ts uses it as it is). */
const own = (errors: string[]) => realErrors(errors).filter((e) => !/status of (404|409)/.test(e))

async function openMine(page: Page) {
  // the person's own folder is there (a real team makes it with the account)
  expect((await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })).ok()).toBeTruthy()
  await page.goto('/files?path=users%2Fbob')
  await expect(page.getByTestId('files-find-work-entry')).toBeVisible()
}

test('a member on My files: the app asks first; Cancel does nothing; nothing ticked; folders\' lines; personal apart; nothing read before Add', async ({ page }) => {
  const errors = watchConsole(page)
  await fakeApp(page)
  await reset(page)
  await signIn(page, BOB)
  await openMine(page)
  await expect(page.getByTestId('files-find-work-entry')).toHaveText('업무 파일 찾기')
  // Cancel in the app's own dialog: the page closes, nothing was looked at or sent
  await page.getByTestId('files-find-work-entry').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await answer(page, 'cancel')
  await expect(page.getByTestId('find-work')).toHaveCount(0)
  expect((await app(page)).reads).toEqual([])
  expect(await (await page.request.get('/__test/file-rank')).json()).toEqual([])
  // Look: Downloads blocked by macOS, Desktop cut (big), the list with nothing ticked
  await look(page, WORK, roots({ id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok', cut: true, tooBig: 1 }, { id: 'downloads', state: 'blocked' }))
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
  await expect(page.getByTestId('find-work-title')).toHaveText('업무 파일로 보이는 4개를 찾았어요')
  await expect(page.getByTestId('find-work')).toContainText('아무것도 체크하지 않았어요. 체크한 파일만 내 파일 › 이 컴퓨터에서에 들어가고, 나만 볼 수 있어요.')
  for (const c of await page.getByTestId('find-work-check').all()) await expect(c).not.toBeChecked()
  await expect(page.getByTestId('find-work-add')).toBeDisabled()
  await expect(page.getByTestId('find-work-blocked')).toContainText('다운로드 폴더를 볼 수 없어요')
  await page.getByTestId('find-work-settings').click()
  expect((await app(page)).settings).toBe(1)
  await expect(page.getByTestId('find-work-guide')).toHaveAttribute('href', /\/docs\/use\/find-work-files\/$/)
  await expect(page.getByTestId('find-work-cut')).toContainText('데스크탑 폴더가 커서 일부만')
  await expect(page.getByTestId('find-work-too-big')).toBeVisible()
  // the AI's picks with their reason; the personal files folded, never sent to the AI; no content went anywhere
  const work = page.getByTestId('find-work-work').getByTestId('find-work-row')
  // why each is shown, in plain words: the AI's reason, when it was last changed, where it is
  const quote = work.filter({ hasText: 'Quote template 2026.xlsx' })
  await expect(quote).toContainText('양식 · ')
  await expect(quote).toContainText(' 고침 · 문서 › Sales')
  await expect(page.getByTestId('find-work-personal-toggle')).toContainText('개인 파일일 수 있어요 (2)')
  await expect(page.getByTestId('find-work-personal-toggle')).toContainText('AI에 보내지 않음')
  await expect(page.getByTestId('find-work-personal')).toHaveCount(0)
  const sent = (await (await page.request.get('/__test/file-rank')).json()) as { entries: { name: string; path: string }[]; own?: boolean }[]
  expect(sent).toHaveLength(1)
  expect(sent[0]!.own).toBe(true)
  expect(sent[0]!.entries.map((e) => e.name)).not.toContain('payslip_oct.pdf')
  expect(sent[0]!.entries.map((e) => e.name)).not.toContain('급여명세서 10월.pdf')
  expect(sent[0]!.entries.find((e) => e.name === 'Northwind proposal.pptx')!.path).toBe('Documents/Clients/Northwind')
  expect(JSON.stringify(sent)).not.toContain('content of')
  expect((await app(page)).reads).toEqual([])
  // a ticked personal file says who sees it
  await page.getByTestId('find-work-personal-toggle').click()
  await page.getByTestId('find-work-personal').getByTestId('find-work-check').first().check()
  await expect(page.getByTestId('find-work-personal-ticked')).toHaveText('내 파일에서 나만 봐요')
  await page.getByTestId('find-work-personal').getByTestId('find-work-check').first().uncheck()
  // search finds every file found, the ones not picked too
  await page.getByTestId('find-work-search').fill('notes')
  await expect(page.getByTestId('find-work-found').getByTestId('find-work-row')).toHaveText([/notes\.txt/])
  await page.getByTestId('find-work-search').fill('')
  // Cancel: nothing read, nothing in My files
  await page.getByTestId('find-work-cancel').click()
  expect((await app(page)).reads).toEqual([])
  expect((await tree(page, 'users/bob')).map((e) => e.name)).not.toContain('From this computer')
  expect(own(errors)).toEqual([])
})

test('Add: only the ticked files are read, they land in My files › From this computer; Undo takes back only what the run made', async ({ page }) => {
  const errors = watchConsole(page)
  await fakeApp(page)
  await reset(page)
  await signIn(page, BOB)
  // a file of the person's already there with the name of one about to go up (a different size): it stays after Undo
  expect((await page.request.post('/__test/file', { data: { path: 'users/bob/From this computer/Documents/Sales/Quote template 2026.xlsx', text: 'older copy' } })).ok()).toBeTruthy()
  await openMine(page)
  await look(page, WORK)
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
  const work = page.getByTestId('find-work-work')
  await work.getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  await work.getByTestId('find-work-row').filter({ hasText: 'Northwind proposal.pptx' }).getByTestId('find-work-check').check()
  // ticked, then unticked: never named to the app, never read (TC-3300)
  const brand = work.getByTestId('find-work-row').filter({ hasText: 'Brand guide v3.pdf' }).getByTestId('find-work-check')
  await brand.check()
  await brand.uncheck()
  await expect(page.getByTestId('find-work-add')).toHaveText('2개 넣기')
  // slow uploads: the dialog is closed while they go, and the line opens on the same run (its Undo stays reachable)
  await page.request.post('/__test/upload-delay', { data: { ms: 1500 } })
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'running')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('find-work-run')).toHaveCount(0)
  await page.getByTestId('files-find-work-entry').click()
  await expect(page.getByTestId('find-work-run')).toBeVisible()
  expect((await app(page)).scans).toBe(1)
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await expect(page.getByTestId('find-work-run-title')).toHaveText('내 파일 › 이 컴퓨터에서에 2개를 넣었어요')
  // exactly the two ticked files were named to the app at Add (TC-3300) and read, each once
  expect((await app(page)).adds.map((a) => [...a].sort())).toEqual([['id0', 'id3']])
  expect((await app(page)).reads.sort()).toEqual(['id0', 'id3'])
  expect((await tree(page, 'users/bob/From this computer/Documents')).map((e) => e.name).sort()).toEqual(['Clients', 'Sales'])
  // the older copy is not replaced: the new one gets a name of its own
  const sales = (await tree(page, 'users/bob/From this computer/Documents/Sales')).map((e) => e.name).sort()
  expect(sales).toHaveLength(2)
  expect(sales[0]).toMatch(/^Quote template 2026 \(\d\)\.xlsx$/)
  expect(sales[1]).toBe('Quote template 2026.xlsx')
  // Undo: the run's two files and the folders it made go; the older copy and its folder stay
  await page.getByTestId('find-work-undo').click()
  await expect(page.getByTestId('find-work-run-title')).toHaveText('2개를 휴지통으로 옮겼어요')
  await expect(page.getByTestId('find-work-undone-until')).toContainText('휴지통에서 되살릴 수 있어요')
  expect((await tree(page, 'users/bob/From this computer/Documents')).map((e) => e.name)).toEqual(['Sales'])
  expect((await tree(page, 'users/bob/From this computer/Documents/Sales')).map((e) => e.name)).toEqual(['Quote template 2026.xlsx'])
  await page.getByTestId('find-work-done').click()
  expect(own(errors)).toEqual([])
})

test('Select all: never a personal file, at most 100, and it says so; no AI: the names\' order', async ({ page }) => {
  await fakeApp(page)
  await reset(page)
  await page.request.post('/__test/file-rank', { data: { ai: 'none' } })
  await signIn(page, BOB)
  await openMine(page)
  // without AI only the company's files are listed (here by the team's name in the file name)
  await look(page, [...Array.from({ length: 120 }, (_, i) => ({ name: `Acme report q${'abcdefghijkl'[i % 12]}${'mnopqrstuv'[Math.floor(i / 12)]}.pdf` })), { name: 'Acme Tax Return 2025.pdf' }, { name: 'random notes.pdf' }])
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work-ai')).toHaveText('AI 없이 파일 이름으로 정렬했어요')
  // at most 50 shown, best first; the rest found by name
  await expect(page.getByTestId('find-work-work').getByTestId('find-work-row')).toHaveCount(50)
  await expect(page.getByTestId('find-work-rest')).toBeVisible()
  await expect(page.getByTestId('find-work-select-all')).toHaveText('50개 모두 선택')
  await page.getByTestId('find-work-select-all').click()
  await expect(page.getByTestId('find-work-add')).toHaveText('50개 넣기')
  // more through the search, up to 100 at a time, said
  await page.getByTestId('find-work-search').fill('Acme report')
  for (const c of await page.getByTestId('find-work-found').getByTestId('find-work-check').all()) { if ((await page.getByTestId('find-work-cap').count()) > 0) break; if (!(await c.isChecked())) await c.click() }
  await expect(page.getByTestId('find-work-cap')).toBeVisible()
  await expect(page.getByTestId('find-work-add')).toHaveText('100개 넣기')
  await page.getByTestId('find-work-search').fill('')
  await page.getByTestId('find-work-personal-toggle').click()
  await expect(page.getByTestId('find-work-personal').getByTestId('find-work-check')).not.toBeChecked()
  expect((await app(page)).reads).toEqual([])
})

test('a read the app refuses (the file changed) is not added; every folder blocked shows no list', async ({ page }) => {
  await fakeApp(page, { refuse: ['id1'] })
  await reset(page)
  await signIn(page, BOB)
  await openMine(page)
  await look(page, [{ name: 'Quote template.xlsx' }, { name: 'Brand guide.pdf' }])
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await page.getByTestId('find-work-select-all').click()
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'failed')
  await expect(page.getByTestId('find-work-run')).toContainText('1개는 넣지 못했어요')
  // the app's reason, in words
  await expect(page.getByTestId('find-work-failed')).toContainText('살펴본 뒤 이 컴퓨터에서 바뀌었어요')
  await page.getByTestId('find-work-done').click()
  await look(page, [], roots({ id: 'documents', state: 'blocked' }, { id: 'desktop', state: 'blocked' }, { id: 'downloads', state: 'blocked' }))
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'none')
  await expect(page.getByTestId('find-work-title')).toContainText('문서, 데스크탑, 다운로드 폴더를 볼 수 없어요')
  await expect(page.getByTestId('find-work-blocked')).toHaveCount(3)
  // the person let the app in: Look again asks the app again (a new look)
  await page.getByTestId('find-work-again').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await answer(page, 'cancel')
  await expect(page.getByTestId('find-work')).toHaveCount(0)
  expect((await app(page)).scans).toBe(3)
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'none')
  await page.getByTestId('find-work-close').click()
  await expect(page.getByTestId('find-work')).toHaveCount(0)
})

test('an older desktop app (another version) and a browser show no entry; the owner\'s setup step keeps the team home', async ({ page }) => {
  await fakeApp(page, { version: 0 })
  await reset(page)
  await signIn(page, BOB)
  expect((await page.request.post('/__test/file', { data: { path: 'users/bob/memo.md', text: 'memo' } })).ok()).toBeTruthy()
  await page.goto('/files?path=users%2Fbob')
  await expect(page.getByText('memo.md')).toBeVisible()
  await expect(page.getByTestId('files-find-work-entry')).toHaveCount(0)
})

test('the owner\'s setup step on the desktop app: Find work files puts the files in the team home with the team pick', async ({ page }) => {
  await fakeApp(page)
  await reset(page)
  await signIn(page)
  await page.goto('/welcome')
  await page.getByTestId('welcome-profile').getByRole('button', { name: '나중에 하기' }).click()
  await page.getByTestId('skills-later').click()
  await expect(page.getByTestId('welcome-team-files-computer')).toHaveText('이 컴퓨터에서 업무 파일 찾기')
  await expect(page.getByTestId('welcome-team-files-pick')).toBeVisible()
  await look(page, [{ name: '2026 견적서 양식.xlsx', folder: 'Sales' }, { name: '회사 소개서.pdf' }])
  await page.getByTestId('welcome-team-files-computer').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
  for (const c of await page.getByTestId('find-work-check').all()) await expect(c).not.toBeChecked()
  const sent = (await (await page.request.get('/__test/file-rank')).json()) as { own?: boolean }[]
  expect(sent.map((x) => !!x.own)).toEqual([false])
  await page.getByTestId('find-work-select-all').click()
  await page.getByTestId('find-work-add').click()
  // the step's own run into the team home (shared/), then its folder plan, as before
  await expect.poll(async () => (await tree(page, 'shared/Documents')).map((e) => e.name).sort()).toEqual(['Sales', '회사 소개서.pdf'])
  await expect(page.getByTestId('organize-proposal').or(page.getByTestId('welcome-team-files-run')).first()).toBeVisible()
})

test('macOS kept the app out of Downloads: "Choose it yourself" opens the system\'s folder window, and its files join the list', async ({ page }) => {
  await fakeApp(page, { pick: true })
  await reset(page)
  await signIn(page, BOB)
  await openMine(page)
  await look(page, [{ name: 'Acme plan.docx' }], roots({ id: 'documents', state: 'ok' }, { id: 'desktop', state: 'ok' }, { id: 'downloads', state: 'blocked' }))
  await pickHolds(page, [{ name: 'Acme invoice.pdf', root: 'downloads' }])
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
  const line = page.getByTestId('find-work-blocked')
  await expect(line).toContainText('다운로드 폴더를 볼 수 없어요')
  // the main way is the folder window, not System Settings
  await expect(line.getByTestId('find-work-settings')).toHaveCount(0)
  await line.getByTestId('find-work-choose').click()
  await expect(page.getByTestId('find-work-blocked')).toHaveCount(0)
  await expect(page.getByTestId('find-work-work').getByTestId('find-work-row').filter({ hasText: 'Acme invoice.pdf' })).toBeVisible()
  expect((await app(page)).picks).toBe(1)
  // nothing was read: the picked folder's files are listed only
  expect((await app(page)).reads).toEqual([])
})
