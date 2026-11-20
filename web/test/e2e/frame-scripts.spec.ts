// Team script files in HTML previews and artifacts (AP-080, lib/frame-scripts.ts): a classic <script src> and ES
// modules (relative imports, bare names through the page's import map, a dynamic import) from the team folder run in
// the real sandbox frame (Chromium and WebKit); a web script stays blocked and is named in a note; a script the viewer
// cannot read, or that some readers of the page cannot read (embedIn), is never put in; a static view fetches no
// scripts. No request leaves this machine.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const PAGE = `<!doctype html><html><head>
<script type="importmap">{"imports":{"three":"./lib/three.module.js","three/addons/":"./lib/addons/"}}</script>
</head><body><h1>Warehouse</h1>
<script src="lib/classic.js"></script>
<script>document.body.dataset.classic = String(window.CLASSIC)</script>
<script type="module">
import { REVISION, Scene } from 'three'
import { Orbit } from 'three/addons/orbit.js'
document.body.dataset.module = REVISION + ':' + new Scene().kind + ':' + Orbit.of()
import('./lib/late.js').then((m) => { document.body.dataset.late = m.default })
</script>
<script type="module" src="lib/main.js"></script>
<script src="https://cdn.attacker.test/three.min.js"></script>
<script src="/secret/hidden.js"></script>
<script src="/finance/2026/narrow.js"></script>
</body></html>`

async function putFiles(page: Page) {
  for (const data of [
    { path: 'marketing/warehouse/index.html', text: PAGE },
    { path: 'marketing/warehouse/lib/classic.js', text: "window.CLASSIC = 'ok'" },
    { path: 'marketing/warehouse/lib/three.module.js', text: "export * from './three.core.js'\nexport const REVISION = '181'" },
    { path: 'marketing/warehouse/lib/three.core.js', text: "export class Scene { get kind() { return 'scene' } }\nexport const shader = `import './not-a-file.js'`" },
    { path: 'marketing/warehouse/lib/addons/orbit.js', text: "import { REVISION } from 'three'\nexport const Orbit = { of: () => 'orbit' + REVISION }" },
    { path: 'marketing/warehouse/lib/late.js', text: "export default 'late'" },
    // the same module as the inline one imports: one copy (its counter is 1)
    { path: 'marketing/warehouse/lib/main.js', text: "import { Scene } from './three.core.js'\nwindow.MAIN = (window.MAIN || 0) + 1\ndocument.body.dataset.main = String(window.MAIN) + ':' + new Scene().kind" },
    // nobody may read secret/ (the mock's policy); only the owner reads finance/, which bob (who reads the page) cannot
    { path: 'secret/hidden.js', text: "document.body.dataset.leak = 'hidden'" },
    { path: 'finance/2026/narrow.js', text: "document.body.dataset.leak = 'narrow'" },
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
  await page.goto('/files?path=marketing%2Fwarehouse')
  await page.getByTestId('file-row').filter({ hasText: 'index.html' }).getByRole('button').first().click()
}

test('HTML file preview: team scripts and modules run, web and unreadable scripts do not, with notes', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await putFiles(page)
  const net = watchRequests(page)
  await openPage(page)
  const panel = page.getByTestId('file-panel')
  const f = page.frameLocator('[data-testid="file-panel"] [data-testid="sandbox-frame"]')
  await expect(f.locator('h1')).toHaveText('Warehouse')
  // a classic script from the team folder ran before the inline script after it
  await expect(f.locator('body')).toHaveAttribute('data-classic', 'ok')
  // modules: a bare name through the page's import map, a relative import inside a module, an addon that imports the
  // bare name again, a dynamic import; a module src is one copy with the module others import
  await expect(f.locator('body')).toHaveAttribute('data-module', '181:scene:orbit181')
  await expect(f.locator('body')).toHaveAttribute('data-late', 'late')
  await expect(f.locator('body')).toHaveAttribute('data-main', '1:scene')
  // scripts the viewer cannot read, or that a reader of the page cannot read: never ran
  await expect(f.locator('body')).not.toHaveAttribute('data-leak', /.*/)
  await expect(panel.getByTestId('web-scripts-note')).toBeVisible()
  await expect(panel.getByTestId('missing-scripts-note')).toContainText('hidden.js')
  await expect(panel.getByTestId('missing-scripts-note')).toContainText('narrow.js')
  expect(net.answers.find((a) => a.url.includes('path=secret/hidden.js'))?.status).toBe(404)
  const narrow = net.answers.find((a) => a.url.includes('path=finance/2026/narrow.js'))
  expect(narrow?.url).toContain('embedIn=marketing/warehouse/index.html')
  expect(narrow?.status).toBe(403)
  const lib = net.answers.find((a) => a.url.includes('path=marketing/warehouse/lib/three.module.js'))
  expect(lib?.status).toBe(200)
  expect(lib?.url).toContain('embedIn=marketing/warehouse/index.html')
  // no web request, and no script request from the frame itself (everything came in the page)
  expect(net.seen.filter((u) => /attacker\.test/.test(u))).toEqual([])
  expect(net.seen.filter((u) => /(classic|three\.module|three\.core|orbit|late|main|hidden|narrow)\.js/.test(u) && !u.includes('/api/files/download'))).toEqual([])
  // the frame's policy is unchanged
  await expect(panel.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts')
})

test('the same page shown without scripts (every chat confidential): no script is fetched', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await putFiles(page)
  expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
  await page.reload()
  const net = watchRequests(page)
  await openPage(page)
  const f = page.frameLocator('[data-testid="file-panel"] [data-testid="static-frame"]')
  await expect(f.locator('h1')).toHaveText('Warehouse')
  await expect(f.locator('script')).toHaveCount(0)
  expect(net.answers.filter((a) => /path=[^&]*\.js/.test(a.url))).toEqual([])
  await expect(page.getByTestId('file-panel').getByTestId('missing-scripts-note')).toHaveCount(0)
})

test('HTML artifact: a team script from the team root runs; a CDN script is named in the note', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await putFiles(page)
  const net = watchRequests(page)
  const content = '<h1>Art</h1><script src="marketing/warehouse/lib/classic.js"></script><script>document.body.dataset.classic = String(window.CLASSIC)</script>' +
    '<script src="https://cdn.attacker.test/three.min.js"></script>'
  expect((await page.request.post('/__test/artifact', { data: { type: 'html', content } })).ok()).toBeTruthy()
  await page.getByTestId('composer-input').fill('make an artifact with a 3D warehouse')
  await page.getByTestId('send').click()
  const panel = page.getByTestId('artifact-panel')
  const f = page.frameLocator('[data-testid="artifact-panel"] [data-testid="sandbox-frame"]')
  await expect(f.locator('h1')).toHaveText('Art')
  await expect(f.locator('body')).toHaveAttribute('data-classic', 'ok')
  await expect(panel.getByTestId('web-scripts-note')).toBeVisible()
  // an artifact has no page file: no embedIn
  expect(net.answers.find((a) => a.url.includes('path=marketing/warehouse/lib/classic.js'))?.url).not.toContain('embedIn')
  expect(net.seen.filter((u) => /attacker\.test/.test(u))).toEqual([])
})
