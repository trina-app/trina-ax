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
import { FILE_SHARE_EVERYONE } from '@mycel/shared/api'
import { translate } from '../../src/i18n'

import { answer, app, fakeApp, look, notNow, pickHolds, roots, type Meta } from './fake-work-files'

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
  // Not now, Esc or closing the app's window (the app answers 'cancelled' for each): the page says so (TC-3491)
  await expect(page.getByTestId('toast').filter({ hasText: '취소했어요. 아무것도 넣지 않았어요.' })).toBeVisible()
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
  await notNow(page)
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

test('the share step: nothing ticked, a hint on the kinds teams keep, Share is the file Share dialog\'s; Not now and the way back', async ({ page }) => {
  const errors = watchConsole(page)
  await fakeApp(page)
  await reset(page)
  await signIn(page, BOB)
  await openMine(page)
  await look(page, WORK)
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
  const work = page.getByTestId('find-work-work')
  await work.getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  await work.getByTestId('find-work-row').filter({ hasText: 'Northwind proposal.pptx' }).getByTestId('find-work-check').check()
  await page.getByTestId('find-work-add').click()
  // after the add: the step, with what was added said above it
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'share', { timeout: 15_000 })
  await expect(page.getByTestId('find-work-share-added')).toHaveText('내 파일 › 이 컴퓨터에서에 2개를 넣었어요')
  await expect(page.getByTestId('find-work-share-title')).toHaveText('이 중에 팀과 공유할 파일이 있나요?')
  const rows = page.getByTestId('find-work-share-row')
  // the hinted kind first (a form), the proposal with no hint; nothing ticked, Share off
  await expect(rows).toHaveText([/Quote template 2026\.xlsx/, /Northwind proposal\.pptx/])
  await expect(rows.first()).toContainText('공유하기 좋은 양식 · 문서 › Sales')
  await expect(rows.nth(1)).not.toContainText('공유하기 좋은')
  for (const c of await page.getByTestId('find-work-share-check').all()) await expect(c).not.toBeChecked()
  await expect(page.getByTestId('find-work-share-go')).toBeDisabled()
  // a file ticked, nobody added yet: says who is missing, still off
  await rows.first().getByTestId('find-work-share-check').check()
  await expect(page.getByTestId('find-work-share-who')).toHaveText('볼 사람을 추가해 주세요.')
  await expect(page.getByTestId('find-work-share-go')).toBeDisabled()
  await page.getByTestId('find-work-share-picker-search').fill('Olga')
  await page.getByTestId('participant-add-user-olga').click()
  await expect(page.getByTestId('find-work-share-go')).toHaveText('1개 공유')
  await page.getByTestId('find-work-share-go').click()
  // the result: added, shared with whom; Undo, Open, Close as before
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'result')
  await expect(page.getByTestId('find-work-shared')).toHaveText('Olga 님에게 1개를 공유했어요')
  await expect(page.getByTestId('find-work-undo')).toBeVisible()
  const shares = async (path: string) => (await (await page.request.get(`/api/files/shares?path=${encodeURIComponent(path)}`)).json()) as { people: { subjectId: string }[] }
  expect((await shares('users/bob/From this computer/Documents/Sales/Quote template 2026.xlsx')).people.map((p) => p.subjectId)).toEqual(['olga'])
  expect((await shares('users/bob/From this computer/Documents/Clients/Northwind/Northwind proposal.pptx')).people).toEqual([])
  // the way back: the step again, nothing ticked; Not now leaves everything as it is
  await page.getByTestId('find-work-share-again').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'share')
  for (const c of await page.getByTestId('find-work-share-check').all()) await expect(c).not.toBeChecked()
  await page.getByTestId('find-work-share-skip').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'result')
  expect((await shares('users/bob/From this computer/Documents/Clients/Northwind/Northwind proposal.pptx')).people).toEqual([])
  await page.getByTestId('find-work-done').click()
  expect(own(errors)).toEqual([])
})

test('the share step with "Everyone on the team": the first option, the line before the press, one press; a teammate gets ONE notice for both files', async ({ page, browser }) => {
  const ko = (k: Parameters<typeof translate>[1], p: Record<string, string | number> = {}) => translate('ko', k, p)
  await fakeApp(page)
  await reset(page)
  await signIn(page, BOB)
  await openMine(page)
  await look(page, WORK)
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
  const work = page.getByTestId('find-work-work')
  await work.getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  await work.getByTestId('find-work-row').filter({ hasText: 'Brand guide v3.pdf' }).getByTestId('find-work-check').check()
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'share', { timeout: 15_000 })
  for (const c of await page.getByTestId('find-work-share-check').all()) await c.check()
  await page.getByTestId('find-work-share-picker-search').click()
  await expect(page.getByTestId('find-work-share-picker-results').getByRole('button').first()).toContainText(ko('fileShare.everyone'))
  await page.getByTestId(`participant-add-group-${FILE_SHARE_EVERYONE}`).click()
  await expect(page.getByTestId('find-work-share-everyone-line')).toHaveText(ko('fileShare.everyoneLineMany', { n: 2 }))
  await page.getByTestId('find-work-share-go').click()
  await expect(page.getByTestId('find-work-shared')).toHaveText(ko('files.findWork.share.done', { n: 2, names: ko('fileShare.everyoneWho') }))
  // Olga (the team owner) gets one notice for the two files, which opens their list
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 }, locale: 'ko-KR' })
  const olga = await ctx.newPage()
  await signIn(olga)
  await olga.goto('/activity')
  const item = olga.getByTestId('notification-item').filter({ hasText: ko('notifications.event.file.sharedMany', { by: 'Bob', n: 2 }) })
  await expect(item).toHaveCount(1)
  await item.getByTestId('notification-file-batch-link').click()
  await expect(olga.getByTestId('file-batch-row')).toHaveCount(2)
  await ctx.close()
})

test('the share step at 390 (QA TC-3522): twelve files ticked, a person and "Everyone on the team" picked: the warning line and both buttons stay fully in sight together in the sheet\'s footer; the list scrolls', async ({ page }) => {
  await fakeApp(page)
  await reset(page)
  // twelve of the company's files (named after it, no AI): a list taller than the sheet
  await page.request.post('/__test/file-rank', { data: { ai: 'none' } })
  await signIn(page, BOB)
  await openMine(page)
  await look(page, Array.from({ length: 12 }, (_, i) => ({ name: `Acme report ${'abcdefghijkl'[i]}.pdf` })))
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work-ai')).toBeVisible()
  await page.getByTestId('find-work-select-all').click()
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'share', { timeout: 15_000 })
  await page.setViewportSize({ width: 390, height: 844 })
  for (const c of await page.getByTestId('find-work-share-check').all()) await c.check()
  await page.getByTestId('find-work-share-picker-search').fill('Olga')
  await page.getByTestId('participant-add-user-olga').click()
  // "Everyone on the team" too: its warning sits in the footer, right above the buttons (QA TC-3509)
  await page.getByTestId('find-work-share-picker-search').click()
  await page.getByTestId(`participant-add-group-${FILE_SHARE_EVERYONE}`).click()
  await page.getByTestId('find-work-share-picker-search').blur()
  await expect(page.getByTestId('find-work-share-check')).toHaveCount(12)
  // the buttons are in the dialog's footer row, below the scrolling body, whole and on screen without scrolling
  const footer = page.getByRole('dialog').getByTestId('modal-footer')
  for (const id of ['find-work-share-everyone-line', 'find-work-share-go', 'find-work-share-skip']) {
    await expect(footer.getByTestId(id)).toBeInViewport({ ratio: 1 })
  }
  const box = (await footer.boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(844)
  if (process.env.FIND_SHARE_390_SHOTS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${process.env.FIND_SHARE_390_SHOTS}/390-${scheme}-picked.png` })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${process.env.FIND_SHARE_390_SHOTS}/1440-${scheme}-picked.png` })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light' })
  }
  // Not now from the footer: the result
  await footer.getByTestId('find-work-share-skip').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'result')
})

test('the share step is skipped when the team turned off members\' file sharing', async ({ page }) => {
  await fakeApp(page)
  await reset(page)
  expect((await page.request.post('/__test/file-shares', { data: { off: true } })).ok()).toBeTruthy()
  await signIn(page, BOB)
  await openMine(page)
  await look(page, WORK)
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await page.getByTestId('find-work-work').getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-stage', 'result', { timeout: 15_000 })
  await expect(page.getByTestId('find-work-share-again')).toHaveCount(0)
  await expect(page.getByTestId('find-work-run-title')).toHaveText('내 파일 › 이 컴퓨터에서에 1개를 넣었어요')
})

test('My files\' dialog stays open at 390 and through resizes (QA TC-3504): the look goes on, the search works, Add lands', async ({ page }) => {
  const errors = watchConsole(page)
  await fakeApp(page)
  await reset(page)
  // the share step is the share test's; this one looks at the dialog at phone width
  expect((await page.request.post('/__test/file-shares', { data: { off: true } })).ok()).toBeTruthy()
  await signIn(page, BOB)
  await openMine(page)
  await look(page, WORK)
  // the button is in the computer toolbar; made phone-narrow while the app asks, the dialog and its look stay
  await page.getByTestId('files-find-work-entry').click()
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'asking')
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  expect((await app(page)).scans).toBe(1)
  // the search works at 390
  await page.getByTestId('find-work-search').fill('notes')
  await expect(page.getByTestId('find-work-found').getByTestId('find-work-row')).toHaveText([/notes\.txt/])
  await page.getByTestId('find-work-search').fill('')
  await page.getByTestId('find-work-work').getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check').check()
  if (process.env.FIND_WORK_390_SHOT) await page.screenshot({ path: process.env.FIND_WORK_390_SHOT })
  // back to a computer width and narrow again: the same dialog, the tick kept
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('find-work-work').getByTestId('find-work-row').filter({ hasText: 'Quote template 2026.xlsx' }).getByTestId('find-work-check')).toBeChecked()
  expect((await app(page)).scans).toBe(1)
  await page.getByTestId('find-work-add').click()
  await expect(page.getByTestId('find-work-run')).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await expect(page.getByTestId('find-work-run-title')).toHaveText('내 파일 › 이 컴퓨터에서에 1개를 넣었어요')
  await page.getByTestId('find-work-done').click()
  await expect(page.getByTestId('find-work-run')).toHaveCount(0)
  expect((await tree(page, 'users/bob/From this computer/Documents/Sales')).map((e) => e.name)).toEqual(['Quote template 2026.xlsx'])
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
  await notNow(page)
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

test('MAN-057: "Choose a folder…" after a look that missed a folder: one quiet link, the system\'s window, the folder\'s files show at once and nothing is read', async ({ page }) => {
  await fakeApp(page, { pickFolder: 'Quotes', platform: 'win32' })
  await reset(page)
  await signIn(page, BOB)
  await openMine(page)
  // the look missed the quotes: two files, Documents cut
  await look(page, [{ name: 'Lunch menu.pdf', root: 'desktop' }, { name: 'Holiday.docx', root: 'downloads' }], roots({ id: 'documents', state: 'ok', cut: true }, { id: 'desktop', state: 'ok' }, { id: 'downloads', state: 'ok' }))
  await pickHolds(page, [
    { name: 'Quote-Hanbit-Q1001.xlsx', root: 'documents', folder: 'QA desktop test/Quotes' },
    { name: 'Quote-Sora-Q1002.xlsx', root: 'documents', folder: 'QA desktop test/Quotes' },
    { name: 'Quote-Mirae-Q1003.xlsx', root: 'documents', folder: 'QA desktop test/Quotes' },
  ])
  await page.getByTestId('files-find-work-entry').click()
  await answer(page, 'look')
  await expect(page.getByTestId('find-work')).toHaveAttribute('data-screen', 'list')
  await page.getByTestId('find-work-search').fill('quote')
  await expect(page.getByTestId('find-work-found').getByTestId('find-work-row')).toHaveCount(0)
  // the one quiet link (no panel); its files show at once with their folder's name
  const link = page.getByTestId('find-work-choose-folder')
  await expect(link).toHaveCount(1)
  await link.click()
  await expect(page.getByTestId('find-work-chosen')).toContainText('Quotes')
  await expect(page.getByTestId('find-work-found').getByTestId('find-work-row')).toHaveCount(3)
  // nothing ticked, nothing read
  await expect(page.getByTestId('find-work-add')).toBeDisabled()
  expect((await app(page)).reads).toEqual([])
  expect((await app(page)).picks).toBe(1)
  // Show all: back to the list; the quotes are found by name from now on
  await page.getByTestId('find-work-show-all').click()
  await expect(page.getByTestId('find-work-chosen')).toHaveCount(0)
  await page.getByTestId('find-work-search').fill('quote')
  await expect(page.getByTestId('find-work-found').getByTestId('find-work-row')).toHaveCount(3)
})
