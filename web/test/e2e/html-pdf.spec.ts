// "PDF로 저장" in an .html file's preview header (FilePanel; server/src/team-files/html-pdf-save.ts): only where the server
// can print HTML (Me.server.htmlPdf), saved next to the page ("<name>.pdf", " (2)" when taken) with "열기" in the
// notice; a folder the person cannot write gets the same PDF as a download. The mock prints a one-page stand-in PDF
// (the real print is covered by tests/unit/html-pdf.test.ts).
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const QUOTE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 15mm } th { background: #1f3a5f; color: #fff } .hl { background: #ffe066 }
</style></head><body><h1>견적서 ACME-001</h1><table><tr><th colspan="2">품목</th></tr><tr><td class="hl">디자인</td><td>1,000,000원</td></tr></table></body></html>`

async function put(page: Page, path: string, text: string) {
  expect((await page.request.post('/__test/file', { data: { path, text } })).ok()).toBeTruthy()
}
async function open(page: Page, folder: string, name: string) {
  await page.goto(`/files?path=${encodeURIComponent(folder)}`)
  await page.getByTestId('file-row').filter({ hasText: name }).getByRole('button').first().click()
  await expect(page.getByTestId('file-panel-title')).toHaveText(name)
}
const printed = async (page: Page) => (await (await page.request.get('/__test/html-pdf')).json()) as { path: string; how: string }[]

test('no "PDF로 저장" where the server cannot print HTML, and none for other files', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await put(page, 'marketing/quote/견적서.html', QUOTE)
  await put(page, 'marketing/quote/notes.md', '# notes')
  await open(page, 'marketing/quote', '견적서.html')
  await expect(page.getByTestId('file-panel').frameLocator('iframe').locator('h1')).toHaveText('견적서 ACME-001')
  await expect(page.getByTestId('file-save-pdf')).toHaveCount(0)

  expect((await page.request.post('/__test/html-pdf', { data: { on: true } })).ok()).toBeTruthy()
  await page.reload()
  await open(page, 'marketing/quote', 'notes.md')
  await expect(page.getByTestId('file-save-pdf')).toHaveCount(0)
})

test('"PDF로 저장" saves the PDF next to the page, "열기" opens it, a second save takes " (2)"', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  expect((await page.request.post('/__test/html-pdf', { data: { on: true } })).ok()).toBeTruthy()
  await signIn(page)
  await put(page, 'marketing/quote/견적서.html', QUOTE)
  await open(page, 'marketing/quote', '견적서.html')

  const save = page.getByTestId('file-save-pdf')
  await expect(save).toHaveText('PDF로 저장')
  await save.click()
  const notice = page.getByText('PDF로 저장했어요: 견적서.pdf')
  await expect(notice).toBeVisible()
  expect(await printed(page)).toEqual([{ path: 'marketing/quote/견적서.html', how: 'save' }])

  // the notice's "열기" opens the new PDF in the same panel
  await page.getByRole('button', { name: '열기', exact: true }).click()
  await expect(page.getByTestId('file-panel-title')).toHaveText('견적서.pdf')

  // the page again: a second PDF never replaces the first
  await open(page, 'marketing/quote', '견적서.html')
  await page.getByTestId('file-save-pdf').click()
  await expect(page.getByText('PDF로 저장했어요: 견적서 (2).pdf')).toBeVisible()
  await page.reload()
  await expect(page.getByTestId('file-row').filter({ hasText: '견적서.pdf' })).toHaveCount(1)
  await expect(page.getByTestId('file-row').filter({ hasText: '견적서 (2).pdf' })).toHaveCount(1)
  expect(realErrors(errors)).toEqual([])
})

test('a folder the person cannot write: the PDF is downloaded instead', async ({ page }) => {
  await reset(page)
  expect((await page.request.post('/__test/html-pdf', { data: { on: true } })).ok()).toBeTruthy()
  await signIn(page)
  // finance/ is read-only for the owner in the mock's policy
  await put(page, 'finance/2026/견적서.html', QUOTE)
  await open(page, 'finance/2026', '견적서.html')
  const download = page.waitForEvent('download')
  await page.getByTestId('file-save-pdf').click()
  const d = await download
  expect(d.suggestedFilename()).toBe('견적서.pdf')
  await expect(page.getByText('이 폴더에는 저장할 수 없어서 PDF를 내려받았어요.')).toBeVisible()
  expect(await printed(page)).toEqual([{ path: 'finance/2026/견적서.html', how: 'download' }])
})

test('a refusal that is not a read-only folder says why and downloads nothing', async ({ page }) => {
  await reset(page)
  expect((await page.request.post('/__test/html-pdf', { data: { on: true } })).ok()).toBeTruthy()
  await signIn(page)
  await put(page, 'marketing/quote/wider.html', QUOTE.replace('</body>', '<img src="../../finance/2026/chart.png"></body>'))
  await open(page, 'marketing/quote', 'wider.html')
  let downloads = 0
  page.on('download', () => { downloads++ })
  await page.getByTestId('file-save-pdf').click()
  await expect(page.getByText('이 폴더를 보는 사람 모두가 볼 수는 없는 파일이 있어서 여기에 저장하지 않았어요', { exact: false })).toBeVisible()
  await page.waitForTimeout(500)
  expect(downloads).toBe(0)
  expect(await printed(page)).toEqual([])
})

test('the download refuses a request from another site (Fetch Metadata)', async ({ page }) => {
  await reset(page)
  expect((await page.request.post('/__test/html-pdf', { data: { on: true } })).ok()).toBeTruthy()
  await signIn(page)
  await put(page, 'marketing/quote/견적서.html', QUOTE)
  const url = '/api/files/html-pdf?path=' + encodeURIComponent('marketing/quote/견적서.html')
  expect((await page.request.get(url, { headers: { 'sec-fetch-site': 'cross-site' } })).status()).toBe(403)
  expect((await page.request.get(url, { headers: { 'sec-fetch-site': 'same-site' } })).status()).toBe(403)
  expect((await page.request.get(url, { headers: { 'sec-fetch-site': 'same-origin' } })).status()).toBe(200)
})

test('on a phone the action sits in the ⋯ menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  expect((await page.request.post('/__test/html-pdf', { data: { on: true } })).ok()).toBeTruthy()
  await signIn(page)
  await put(page, 'marketing/quote/견적서.html', QUOTE)
  await open(page, 'marketing/quote', '견적서.html')
  await expect(page.getByTestId('file-save-pdf')).toBeHidden()
  await page.getByTestId('file-panel-more').click()
  await page.getByTestId('file-more-save-pdf').click()
  await expect(page.getByText('PDF로 저장했어요: 견적서.pdf')).toBeVisible()
})
