import { expect, test, type Page } from '@playwright/test'
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
  await expect(page.getByTestId('file-panel').getByRole('heading', { name: 'Plan' })).toBeVisible()
  await row(page, 'page.html').getByRole('button').first().click()
  const frame = page.getByTestId('file-panel').locator('iframe')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(page.frameLocator('[data-testid="file-panel"] iframe').locator('h1')).toHaveText('Hi')
  // the owner can only read finance: no upload there
  await page.goto('/files?path=finance')
  await expect(page.getByText('읽기 전용 폴더')).toBeVisible()
  await expect(page.getByTestId('upload-button')).toBeDisabled()
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
  await list.getByRole('button', { name: '되돌리기' }).click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByText('v1으로 되돌렸어요.')).toBeVisible()

  await rowMenu(page, 'notes.txt', '이 파일로 채팅 시작')
  await expect(page.getByTestId('composer-input')).toHaveValue('`marketing/notes.txt` 파일을 읽고 ')
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
