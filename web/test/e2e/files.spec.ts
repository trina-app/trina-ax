import { expect, test, type Page, type Request } from '@playwright/test'
import { reset, signIn } from './helpers'

const row = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })
async function rowMenu(page: Page, name: string, item: string | RegExp) {
  await row(page, name).hover()
  await row(page, name).getByTestId('file-menu').click()
  await page.getByRole('menuitem', { name: item }).click()
}

test('browse, previews (CSV, Markdown, HTML in the sandbox), conflict copies, read-only folders', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files')
  await row(page, 'marketing').getByRole('button').first().click()
  await expect(page).toHaveURL(/path=marketing/)
  await expect(row(page, 'plan (충돌 사본')).toContainText('충돌 사본')
  await row(page, 'data.csv').getByRole('button').first().click()
  await expect(page.getByTestId('file-panel').locator('table')).toContainText('beta')
  await row(page, 'plan.md').getByRole('button').first().click()
  await expect(page.getByTestId('file-panel').getByRole('heading', { name: 'Plan', exact: true })).toBeVisible()
  await row(page, 'page.html').getByRole('button').first().click()
  const frame = page.getByTestId('file-panel').locator('iframe')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(page.frameLocator('[data-testid="file-panel"] iframe').locator('h1')).toHaveText('Hi')
  // the owner can only read finance: no upload there
  await page.goto('/files?path=finance')
  await expect(page.getByText('읽기 전용 폴더')).toBeVisible()
  await expect(page.getByTestId('upload-button')).toBeDisabled()
})

test('cancelling a chunked upload drops its session on the server', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  // hold the second chunk so the upload is still running when the person cancels
  await page.route(/\/api\/upload-sessions\/[^/]+\/chunks\/1$/, () => {})
  await page.getByTestId('files-input').setInputFiles([{ name: 'cancel-me.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 * 1024, 3) }])
  const list = page.getByTestId('upload-list')
  await expect.poll(async () => ((await (await page.request.post('/__test/log')).json()) as string[]).some((l) => /\/chunks\/0$/.test(l))).toBe(true)
  await list.getByRole('button', { name: '취소' }).click()
  await expect(list).toHaveCount(0)
  await expect.poll(async () => ((await (await page.request.post('/__test/log')).json()) as string[]).some((l) => /^DELETE \/api\/upload-sessions\//.test(l))).toBe(true)
})

test('a file picked while the folder is still loading is uploaded, not refused as read-only', async ({ page }) => {
  await reset(page)
  await signIn(page)
  // the folder's first listing answers late (a slow server) and the person picks a file before the table shows; the
  // upload's own reload answers first, so the late listing must not hide the new file either
  let held: Request | null = null
  let lateDone = false
  page.on('requestfinished', (r) => { if (r === held) lateDone = true })
  await page.route(/\/api\/files\/tree\?.*path=marketing/, async (route) => {
    if (!held) {
      held = route.request()
      await new Promise((r) => setTimeout(r, 2000))
    }
    await route.continue()
  })
  await page.goto('/files?path=marketing')
  await page.getByTestId('files-input').setInputFiles({ name: 'early-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('picked while loading') })
  await expect(row(page, 'early-upload.txt')).toBeVisible()
  await expect.poll(() => lateDone).toBe(true)
  await page.waitForTimeout(300) // the app handles that late answer
  await expect(row(page, 'early-upload.txt')).toBeVisible()
  await expect(page.getByText('읽기 전용 폴더')).toHaveCount(0)
})

test('upload small and chunked files, new folder, rename, trash and restore', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await page.getByTestId('files-input').setInputFiles([
    { name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('small file') },
    { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9 * 1024 * 1024, 7) },
  ])
  await expect(row(page, 'small.txt')).toBeVisible()
  await expect(row(page, 'big.bin')).toBeVisible({ timeout: 20_000 })
  const log = (await (await page.request.post('/__test/log')).json()) as string[]
  expect(log).toContain('POST /api/files/upload')
  expect(log.filter((l) => /^PUT \/api\/upload-sessions\/.+\/chunks\/\d$/.test(l))).toHaveLength(2)
  expect(log.some((l) => /\/complete$/.test(l))).toBe(true)

  await page.getByRole('button', { name: '새 폴더' }).click()
  await page.getByLabel('폴더 이름').fill('drafts')
  await page.getByTestId('dialog-confirm').click()
  await expect(row(page, 'drafts')).toBeVisible()

  await rowMenu(page, 'small.txt', '이름 바꾸기')
  await page.getByLabel('새 이름').fill('renamed.txt')
  await page.getByTestId('dialog-confirm').click()
  await expect(row(page, 'renamed.txt')).toBeVisible()

  await rowMenu(page, 'renamed.txt', '휴지통으로')
  await page.getByTestId('dialog-confirm').click()
  await expect(row(page, 'renamed.txt')).toHaveCount(0)
  await page.getByRole('tab', { name: '휴지통' }).click()
  await expect(page.getByTestId('trash-list')).toContainText('marketing/renamed.txt')
  await page.getByTestId('trash-list').getByRole('button', { name: '되돌리기' }).click()
  await expect(page.getByText('marketing/renamed.txt(으)로 되돌렸어요.')).toBeVisible()
})

test('version history with restore; start a chat with a file', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await rowMenu(page, 'plan.md', '버전 기록')
  const list = page.getByTestId('history-list')
  await expect(list).toContainText('v2')
  await expect(list).toContainText('Bob')
  await list.locator('[data-version="1"]').getByRole('button', { name: '되돌리기' }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText('v1으로 되돌렸어요.')).toBeVisible()

  // a file goes into a new chat as an attached team file (a folder is still named in the prompt)
  await rowMenu(page, 'notes.txt', 'AI에게 이 파일 물어보기')
  await expect(page.locator('[data-testid="attachment-chip"][data-source="team"]')).toContainText('notes.txt')
})

test('version history: every earlier version can be restored, the newest too; one equal to now is marked; read-only files offer download only', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await rowMenu(page, 'plan.md', '버전 기록')
  const list = page.getByTestId('history-list')
  // v3 is the file as it is now: nothing to restore
  await expect(list.locator('[data-version="3"]')).toContainText('지금 내용과 같음')
  await expect(list.locator('[data-version="3"]').getByRole('button', { name: '되돌리기' })).toHaveCount(0)
  // v2 is the newest version that differs from now (before the fix only versions below the newest had the button)
  for (const v of ['1', '2']) await expect(list.locator(`[data-version="${v}"]`).getByRole('button', { name: '되돌리기' })).toBeVisible()
  await list.locator('[data-version="2"]').getByRole('button', { name: '되돌리기' }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText('v2으로 되돌렸어요.')).toBeVisible()

  // finance is read-only for this person: the history shows, versions download, nothing restores
  await page.goto('/files?path=finance/2026')
  await rowMenu(page, 'q3.csv', '버전 기록')
  const ro = page.getByTestId('history-list')
  await expect(ro.locator('[data-version="1"]')).toBeVisible()
  await expect(ro.locator('[data-version="1"]').getByRole('button', { name: '내려받기' })).toBeVisible()
  await expect(ro.getByRole('button', { name: '되돌리기' })).toHaveCount(0)
})

test('files.changed from an answer refreshes the folder on screen', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await expect(row(page, 'notes.txt')).toBeVisible()
  // the same person in a second window asks the AI to write a file
  const other = await browser.newContext()
  const p2 = await other.newPage()
  await signIn(p2)
  await p2.getByTestId('composer-input').fill('write the files please')
  await p2.getByTestId('send').click()
  await expect(row(page, 'report.md')).toBeVisible()
  await other.close()
})

test('nested dialogs: Esc closes only the top one (new-folder prompt over the move picker)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await rowMenu(page, 'notes.txt', '옮기기')
  const picker = page.getByRole('dialog', { name: '"notes.txt" 옮기기' })
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: '새 폴더' }).click()
  await expect(page.getByLabel('폴더 이름')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('폴더 이름')).toHaveCount(0)
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
})

test('fix a text file in the preview panel; a save after someone else\'s becomes a conflict copy', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files?path=marketing')
  await row(page, 'plan.md').getByRole('button').first().click()
  const panel = page.getByTestId('file-panel')
  await panel.getByTestId('file-edit').click()
  const editor = panel.getByTestId('file-editor')
  await expect(editor).toHaveValue(/# Plan/)
  await expect(panel.getByTestId('file-save')).toBeDisabled()

  // the same file open in a second window, edited there first
  const other = await browser.newPage()
  await signIn(other)
  await other.goto('/files?path=marketing')
  await row(other, 'plan.md').getByRole('button').first().click()
  await other.getByTestId('file-panel').getByTestId('file-edit').click()
  await other.getByTestId('file-editor').fill('# Plan\n\nfirst change\n')
  await other.getByTestId('file-save').click()
  await expect(other.getByText('저장했어요.')).toBeVisible()
  await expect(other.getByTestId('file-panel').getByRole('heading', { name: 'Plan', exact: true })).toBeVisible()
  await expect(other.getByTestId('file-panel')).toContainText('first change')
  await other.close()

  // this window still has the old text: its save keeps the other version and goes to a conflict copy
  await editor.fill('# Plan\n\nsecond change\n')
  await panel.getByTestId('file-save').click()
  await expect(page.getByText(/충돌 사본\(marketing\/plan \(충돌 사본/)).toBeVisible()
  await expect(panel.getByRole('heading', { level: 2 })).toContainText('plan (충돌 사본')
  await expect(panel).toContainText('second change')
  await page.getByRole('button', { name: '새로 고침' }).click()
  // this save's copy (the mock also has an older copy of Bob's)
  await expect(row(page, 'plan (충돌 사본 - Olga)')).toBeVisible()
})
