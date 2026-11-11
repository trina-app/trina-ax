// Files on a phone (QA TC-258, and the Files row ⋯ of TC-249), at 390×844 with touch, in Chromium and WebKit (the iPhone
// app's engine). The owner on Team folder › Groups › leads: "여기 UI가 모바일 친화적임?". The steps follow the QA row:
//   1. Files › Team folder › Groups › leads: one bar (‹ to the folder above, the folder's name, ⊕ with New folder /
//      Upload as a sheet), the search scrolls away, rows "name" + "date · size", "팀 폴더" at most once
//   2. Trash: a place you open from the team folder; folder names in words (not storage paths), a short toast
//   3. Upload 3 files from ⊕: they are listed in two lines (the finished uploads' summary is components/FileUploads.tsx,
//      another change)
// TC-249: a row's ⋯ near the end of a long list is a sheet over the tab bar with 44 px rows, closes on an outside tap
// (Back closes it too: rooms/MenuButton's history entry, #452); "Select" in it starts a selection whose actions sit at the
// bottom. A tablet's touch screen shows ⋯ without hovering (FILES-21).
import { expect, test, type Page } from '@playwright/test'
import { folderLabel } from '@mycel/shared'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const t = DICTS.ko
const H = { [CSRF_HEADER]: '1' }
const groups = folderLabel('groups', 'ko', 'olga') ?? 'groups'
const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })
const open = (page: Page, name: string) => row(page, name).getByRole('button').first().click()
const title = (page: Page) => page.getByRole('heading', { level: 1 })
const back = (page: Page) => page.getByTestId('files-back')

async function file(page: Page, path: string, text = 'x') {
  expect((await page.request.post('/__test/file', { headers: H, data: { path, text } })).ok()).toBeTruthy()
}
/** nothing on the page wider than the screen */
const noSideways = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
/** '팀 폴더' shown at most once (it was the pill and the first breadcrumb) */
const rootWordsOnce = async (page: Page) => expect(await page.getByText(t['files.root'], { exact: true }).count()).toBeLessThanOrEqual(1)

test('step 1: Team folder › Groups › leads: one bar with ‹ and the folder name, ⊕ as a sheet, the search scrolls away, two-line rows', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await file(page, 'groups/leads/회사/a.txt')
  for (let i = 1; i <= 20; i++) await file(page, `groups/leads/견적서-${String(i).padStart(2, '0')}.html`, '<p>견적</p>'.repeat(i))
  await page.getByTestId('tab-files').last().click()

  // the team folder: no ‹, "파일" as the title, no Team folder / Trash pills and no breadcrumbs
  await expect(title(page)).toHaveText(t['files.title'])
  await expect(back(page)).toHaveCount(0)
  await expect(page.getByTestId('files-add')).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByTestId('crumb')).toHaveCount(0)
  await rootWordsOnce(page)

  await open(page, groups)
  await expect(title(page)).toHaveText(groups)
  await expect(page.getByTestId('files-back-label')).toHaveText(t['files.title'])
  await open(page, 'leads')
  await expect(title(page)).toHaveText('leads')
  // ‹ names where it goes
  await expect(back(page)).toHaveAccessibleName(translate('ko', 'tabs.backTo', { page: groups }))
  await expect(page.getByTestId('files-back-label')).toHaveText(groups)
  await rootWordsOnce(page)
  await noSideways(page)

  // one bar above the list: the first row starts right under the bar and the search box (it was at y≈318)
  const bar = page.getByTestId('phone-page-bar')
  const barBottom = (await bar.boundingBox())!.y + (await bar.boundingBox())!.height
  const first = page.getByTestId('file-row').first()
  await expect(first).toBeVisible()
  expect((await first.boundingBox())!.y - barBottom).toBeLessThan(110)

  // rows: the name, then date · size (a folder: the date), each 44 px or more
  const quote = row(page, '견적서-03.html')
  await expect(quote.getByTestId('file-row-meta')).toHaveText(/^\d{4}\. \d{1,2}\. \d{1,2}\. .+ · \d+ B$/)
  await expect(row(page, '회사').getByTestId('file-row-meta')).not.toContainText('·')
  for (const r of await page.getByTestId('file-row').all()) expect((await r.boundingBox())!.height).toBeGreaterThanOrEqual(44)

  // the search box scrolls away with the list; the bar stays
  const search = page.getByTestId('content-search-input')
  await expect(search).toBeInViewport()
  await row(page, '견적서-20.html').scrollIntoViewIfNeeded()
  await expect(search).not.toBeInViewport()
  await expect(bar).toBeInViewport()

  // ⊕: New folder and Upload in a sheet from the bottom, 44 px rows; New folder makes one here
  await page.getByTestId('files-add').click()
  const sheet = page.getByRole('menu')
  await expect(sheet.getByRole('menuitem')).toHaveText([t['files.newFolder'], t['files.upload']])
  const box = (await sheet.boundingBox())!
  expect(Math.round(box.x)).toBe(0)
  expect(Math.round(box.width)).toBe(390)
  expect(Math.round(box.y + box.height)).toBe(844)
  for (const item of await sheet.getByRole('menuitem').all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await sheet.getByRole('menuitem', { name: t['files.newFolder'] }).click()
  await page.getByLabel(t['files.folderName']).fill('drafts')
  await page.getByTestId('dialog-confirm').click()
  await expect(row(page, 'drafts')).toBeVisible()

  // ‹ goes up a folder at a time, to the team folder
  await back(page).click()
  await expect(title(page)).toHaveText(groups)
  await expect(page).toHaveURL(/path=groups$/)
  await back(page).click()
  await expect(title(page)).toHaveText(t['files.title'])
  await expect(back(page)).toHaveCount(0)
})

test('step 2: the trash is a place: folder names in words, a one-line note, a short toast, ‹ back to the team folder', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await file(page, 'groups/leads/회사/old-quote.txt', 'old')
  expect((await page.request.delete('/api/files?path=groups%2Fleads%2F%ED%9A%8C%EC%82%AC%2Fold-quote.txt', { headers: H })).ok()).toBeTruthy()
  await page.getByTestId('tab-files').last().click()
  await page.getByTestId('files-open-trash').click()
  await expect(page).toHaveURL(/view=trash/)
  await expect(title(page)).toHaveText(t['files.trash'])
  await expect(page.getByTestId('files-back-label')).toHaveText(t['files.title'])

  // the name, then the folder it was in, in words; never the storage path
  const item = page.getByTestId('trash-item').filter({ hasText: 'old-quote.txt' })
  await expect(item.getByTestId('trash-name')).toHaveText('old-quote.txt')
  await expect(item.getByTestId('trash-where')).toHaveText(`${groups} › leads › 회사`)
  await expect(page.getByTestId('trash-list')).not.toContainText('groups/')
  // one short note, not the four-line paragraph
  const note = page.getByTestId('trash-note')
  await expect(note).toHaveText(t['files.trashNoteShort'])
  expect((await note.boundingBox())!.height).toBeLessThanOrEqual(40)
  expect((await item.getByTestId('trash-restore').boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await noSideways(page)

  // Restore: a short toast with the folder in words
  await item.getByTestId('trash-restore').click()
  await expect(page.getByTestId('toast').filter({ hasText: translate('ko', 'files.restoredTo', { path: `${groups} › leads › 회사` }) })).toBeVisible()
  await expect(page.getByTestId('toast').filter({ hasText: 'groups/' })).toHaveCount(0)

  // ‹: the team folder again
  await back(page).click()
  await expect(page).not.toHaveURL(/view=trash/)
  await expect(title(page)).toHaveText(t['files.title'])
})

test('step 3: three files uploaded from ⊕ are listed in two lines', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await file(page, 'groups/leads/a.txt')
  await page.goto('/files?path=groups%2Fleads')
  await expect(title(page)).toHaveText('leads')
  await page.getByTestId('files-add').click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menu').getByRole('menuitem', { name: t['files.upload'] }).click()
  await (await chooser).setFiles(['one', 'two', 'three'].map((n) => ({ name: `견적-${n}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`quote ${n}`) })))
  for (const n of ['one', 'two', 'three']) await expect(row(page, `견적-${n}.txt`).getByTestId('file-row-meta')).toContainText(' · ')
})

test("TC-249: a row's ⋯ at the end of a long list is a sheet over the tab bar; Select starts a selection with its actions at the bottom", async ({ page }) => {
  await reset(page)
  await signIn(page)
  for (let i = 1; i <= 30; i++) await file(page, `shared/long/memo-${String(i).padStart(2, '0')}.txt`, `memo ${i}`)
  await page.goto('/files?path=shared%2Flong')
  const last = row(page, 'memo-30.txt')
  await last.scrollIntoViewIfNeeded()
  const more = last.getByTestId('file-menu')
  // a touch screen shows ⋯ without hovering, 44 px
  expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await more.click()
  const sheet = page.getByRole('menu')
  await expect(page.getByTestId('menu-sheet-title')).toHaveText('memo-30.txt')
  const box = (await sheet.boundingBox())!
  expect(Math.round(box.y + box.height)).toBe(844)
  // every item in sight and 44 px or more; the tab bar is under the sheet, not over it
  for (const item of await sheet.getByRole('menuitem').all()) {
    await expect(item).toBeInViewport({ ratio: 1 })
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  await expect(sheet.getByRole('menuitem', { name: t['files.moveToTrash'] })).toBeVisible()
  const tabs = (await page.getByTestId('bottom-tabs').boundingBox())!
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-bottom-bar]'), [tabs.x + tabs.width / 2, tabs.y + tabs.height / 2])).toBe(false)
  // a tap outside it closes it
  await page.mouse.click(195, 150)
  await expect(sheet).toHaveCount(0)

  // Select from ⋯: the selection, with its actions at the bottom above the tab bar
  await more.click()
  await page.getByRole('menuitem', { name: t['files.selectRow'] }).click()
  const bulk = page.getByTestId('bulk-bar')
  await expect(page.getByTestId('bulk-count')).toHaveText(translate('ko', 'files.bulk.count', { n: 1 }))
  const bulkBox = (await bulk.boundingBox())!
  const tabsNow = (await page.getByTestId('bottom-tabs').boundingBox())!
  expect(bulkBox.y + bulkBox.height).toBeLessThanOrEqual(tabsNow.y + 1)
  expect(bulkBox.y).toBeGreaterThan(844 / 2)
  for (const id of ['bulk-move', 'bulk-share', 'bulk-delete', 'bulk-clear']) {
    await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
    expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  // ⊕ waits while something is selected
  await expect(page.getByTestId('files-add')).toHaveCount(0)
  await page.getByTestId('bulk-clear').click()
  await expect(bulk).toHaveCount(0)
  await noSideways(page)
})

test.describe('tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true })
  test('FILES-21: a touch tablet sees each row\'s ⋯ without hovering, and keeps the computer\'s layout', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.goto('/files?path=marketing')
    const more = row(page, 'plan.md').getByTestId('file-menu')
    await expect(more).toBeVisible()
    expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false)
    expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    // 768 px and wider: the pills and the toolbar as before
    await expect(page.getByRole('tab', { name: t['files.trash'] })).toBeVisible()
    await expect(page.getByTestId('upload-button')).toBeVisible()
  })
})
