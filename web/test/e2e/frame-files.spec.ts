// Team images in HTML previews and artifacts (lib/frame-files.ts): a relative <img> next to an HTML file shows the
// team file (inlined as a data: URL before the page goes into the frame; the frame's CSP is unchanged), a web image
// stays blocked with a placeholder and the notice above the frame, a file the viewer cannot read is never inlined, and
// neither is one that some readers of the page cannot read (the server's embedIn check). No request leaves this
// machine: the page's web addresses are never fetched.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

/** a 1×1 PNG */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PAGE = `<!doctype html><html><head><style>#bg{width:20px;height:20px;background:url("images/hero.png")}</style></head><body>
<h1>Landing</h1>
<img id="hero" src="images/hero.png" alt="hero">
<img id="web" src="https://cdn.attacker.test/a.png" alt="web">
<img id="web2" srcset="https://cdn.attacker.test/b.png 1x" alt="web 2">
<img id="hidden" src="/secret/hidden.png" alt="hidden">
<img id="narrow" src="/finance/2026/chart.png" alt="narrow">
<div id="bg"></div>
<script>document.body.dataset.ran = "yes"</script>
</body></html>`

async function putFiles(page: Page) {
  for (const data of [
    { path: 'marketing/landing/index.html', text: PAGE },
    { path: 'marketing/landing/images/hero.png', base64: PNG },
    // nobody may read secret/ (the mock's policy); only the owner reads finance/, which bob cannot
    { path: 'secret/hidden.png', base64: PNG },
    { path: 'finance/2026/chart.png', base64: PNG },
  ]) expect((await page.request.post('/__test/file', { data })).ok()).toBeTruthy()
}

function watchRequests(page: Page) {
  const seen: string[] = []
  const answers: { url: string; status: number }[] = []
  page.on('request', (r) => seen.push(r.url()))
  page.on('response', (r) => { if (r.url().includes('/api/files/download')) answers.push({ url: decodeURIComponent(r.url()), status: r.status() }) })
  return { seen, answers }
}

async function openPage(page: Page) {
  await page.goto('/files?path=marketing%2Flanding')
  await page.getByTestId('file-row').filter({ hasText: 'index.html' }).getByRole('button').first().click()
}

const PLACEHOLDER = /^data:image\/svg\+xml,/

test('HTML file preview: team images shown, web images blocked with a notice, unreadable and narrower files left out', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await putFiles(page)
  const net = watchRequests(page)
  await openPage(page)
  const f = page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]')
  await expect(f.locator('h1')).toHaveText('Landing')
  await expect(f.locator('body')).toHaveAttribute('data-ran', 'yes')
  // the relative image is the team file, drawn
  await expect(f.locator('#hero')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect.poll(() => f.locator('#hero').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
  // the page's own <style> rule too
  expect(await f.locator('style').last().textContent()).toContain('url("data:image/png;base64,')
  // web images: placeholders, never fetched, counted in the notice
  await expect(f.locator('#web')).toHaveAttribute('src', PLACEHOLDER)
  await expect(f.locator('#web2')).toHaveAttribute('src', PLACEHOLDER)
  await expect(page.getByTestId('file-panel').getByTestId('external-images-note')).toHaveText('바깥 이미지 2개는 미리보기에서 막혀요 — AI에게 파일로 저장해 달라고 하세요')
  // a file nobody may read, and one that bob (who can read the page) cannot read: not inlined
  await expect(f.locator('#hidden')).toHaveAttribute('src', PLACEHOLDER)
  await expect(f.locator('#narrow')).toHaveAttribute('src', PLACEHOLDER)
  expect(net.answers.find((a) => a.url.includes('path=secret/hidden.png'))?.status).toBe(404)
  const narrow = net.answers.find((a) => a.url.includes('path=finance/2026/chart.png'))
  expect(narrow?.url).toContain('embedIn=marketing/landing/index.html')
  expect(narrow?.status).toBe(403)
  expect(net.answers.find((a) => a.url.includes('path=marketing/landing/images/hero.png'))?.status).toBe(200)
  expect(net.seen.filter((u) => /attacker\.test/.test(u))).toEqual([])
  // the frame's policy is unchanged: still a sandboxed frame with scripts only
  await expect(page.getByTestId('file-panel').locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
})

test('the same page shown without scripts (every chat confidential): the team image still shows', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await putFiles(page)
  expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
  await page.reload()
  await openPage(page)
  const f = page.frameLocator('[data-testid="file-panel"] [data-testid="static-frame"]')
  await expect(f.locator('h1')).toHaveText('Landing')
  await expect(f.locator('#hero')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect.poll(() => f.locator('#hero').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
  await expect(f.locator('#hidden')).toHaveAttribute('src', PLACEHOLDER)
  await expect(page.getByTestId('file-panel').getByTestId('external-images-note')).toContainText('2개')
})

test('HTML artifact: team paths from the team root, web images blocked with the notice', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await putFiles(page)
  const net = watchRequests(page)
  expect((await page.request.post('/__test/artifact', { data: { type: 'html', content: '<h1>Art</h1><img id="a" src="marketing/landing/images/hero.png"><img id="w" src="https://cdn.attacker.test/z.png">' } })).ok()).toBeTruthy()
  await page.getByTestId('composer-input').fill('make an artifact with images')
  await page.getByTestId('send').click()
  const f = page.frameLocator('[data-testid="artifact-panel"] [data-testid="sandbox-frame"]')
  await expect(f.locator('h1')).toHaveText('Art')
  await expect(f.locator('#a')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect.poll(() => f.locator('#a').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
  await expect(f.locator('#w')).toHaveAttribute('src', PLACEHOLDER)
  await expect(page.getByTestId('artifact-panel').getByTestId('external-images-note')).toContainText('1개')
  // an artifact has no page file: no embedIn
  expect(net.answers.find((a) => a.url.includes('path=marketing/landing/images/hero.png'))?.url).not.toContain('embedIn')
  expect(net.seen.filter((u) => /attacker\.test/.test(u))).toEqual([])
})
