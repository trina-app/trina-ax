import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const PORT = Number(process.env.MOCK_PORT ?? 19143)

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}

test('an HTML artifact opens by itself in an isolated frame (allow-scripts only, CSP first, network blocked)', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  const external: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('data:') && !r.url().startsWith('about:')) external.push(r.url())
  })
  await signIn(page)
  await ask(page, 'make an artifact')
  const panel = page.getByTestId('artifact-panel')
  await expect(panel).toBeVisible()
  const frame = panel.locator('iframe')
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  // the fixed receiver document of the team server, not srcdoc (which would inherit the app's CSP)
  expect(await frame.getAttribute('srcdoc')).toBeNull()
  expect(await frame.getAttribute('src')).toMatch(/^\/sandbox\/frame\?v=/)
  // the written document starts with the meta CSP, before anything the AI wrote
  const doc = await page.frameLocator('[data-testid="artifact-panel"] iframe').locator('html').evaluate((el) => el.outerHTML)
  expect(doc.indexOf('Content-Security-Policy')).toBeGreaterThan(-1)
  expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('Hello artifact'))
  // the script ran inside the frame…
  await expect(page.frameLocator('[data-testid="artifact-panel"] iframe').locator('h1')).toHaveText('Hello artifact (ran)')
  // …but its fetch to example.com never left the page, and the panel says why
  await expect(panel.getByRole('alert')).toContainText('connect-src')
  expect(external).toEqual([])
  // the frame cannot reach the app: no cookies, no storage (opaque origin)
  const origin = await page.frameLocator('[data-testid="artifact-panel"] iframe').locator('body').evaluate(() => {
    try {
      return `${location.origin}|${document.cookie}|${String(window.parent.document)}`
    } catch (e) {
      return `blocked: ${(e as Error).name}`
    }
  })
  expect(origin).toMatch(/^blocked|^null\|\|/)
  // code tab, card in the answer
  await panel.getByRole('tab', { name: '코드' }).click()
  await expect(panel.locator('code')).toContainText('Hello artifact')
  await expect(page.getByTestId('artifact-card')).toContainText('Hello page')
  expect(realErrors(errors).filter((e) => !e.includes('Content Security Policy') && !e.includes('example.com'))).toEqual([])
})

test('a React artifact runs with the team server\'s vendor libraries, versions switch, errors can be sent back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'make a react counter')
  const panel = page.getByTestId('artifact-panel')
  const f = page.frameLocator('[data-testid="artifact-panel"] iframe')
  await expect(f.getByRole('button')).toContainText('count 0', { timeout: 15_000 })
  await f.getByRole('button').click()
  await expect(f.getByRole('button')).toContainText('count 1')
  // Tailwind from /vendor/ styled it
  await expect(f.getByRole('button')).toHaveCSS('color', 'rgb(255, 255, 255)')
  // a second version
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  await ask(page, 'make the react counter again')
  await expect(panel.getByTestId('artifact-version')).toHaveText('v2 / 2')
  await panel.getByRole('button', { name: '이전 버전' }).click()
  await expect(panel.getByTestId('artifact-version')).toHaveText('v1 / 2')
})

test('a failing artifact: "ask the AI to fix it" sends the error', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'make a broken artifact')
  const panel = page.getByTestId('artifact-panel')
  await expect(panel.getByRole('alert')).toContainText('boom')
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  await panel.getByTestId('ask-fix').click()
  await expect(page.getByTestId('user-text').last()).toContainText('boom')
})

test('save an artifact into the team folder', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'make an artifact')
  const panel = page.getByTestId('artifact-panel')
  await expect(panel.locator('iframe')).toBeVisible()
  await panel.getByRole('button', { name: '팀 폴더에 저장' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'marketing' }).click()
  await page.getByTestId('folder-pick').click()
  await expect(page.getByText('marketing/Hello page.html에 저장했어요.')).toBeVisible()
})

test('the receiver document: sandbox CSP header, framable only by this server, no cookies needed', async ({ page }) => {
  await reset(page)
  const r = await page.request.get('/sandbox/frame?v=x')
  expect(r.status()).toBe(200)
  const csp = r.headers()['content-security-policy']!
  expect(csp.startsWith('sandbox allow-scripts;')).toBe(true)
  expect(csp).toContain("connect-src 'none'")
  expect(csp).toContain(`script-src 'unsafe-inline' data: blob: https://127.0.0.1:${PORT}/vendor/ http://127.0.0.1:${PORT}/vendor/`)
  expect(csp).toContain(`frame-ancestors https://127.0.0.1:${PORT} http://127.0.0.1:${PORT}`)
  expect(r.headers()['set-cookie']).toBeUndefined()
  // the app page itself: no inline or data: scripts, no eval
  const app = (await page.request.get('/')).headers()['content-security-policy']!
  expect(app).toContain("script-src 'self' 'wasm-unsafe-eval';")
  expect(app).not.toMatch(/script-src[^;]*('unsafe-inline'|data:|blob:)/)
})

test('a parent that missed the receiver\'s "ready" gets it again with a ping (no empty frame)', async ({ page }) => {
  await reset(page)
  await page.goto('/')
  const got = await page.evaluate(async () => {
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts')
    f.src = '/sandbox/frame?v=late'
    // the receiver loads and says "ready" while nobody listens yet
    await new Promise((r) => { f.onload = r; document.body.appendChild(f) })
    await new Promise((r) => setTimeout(r, 200))
    const ready = new Promise<string>((resolve) => window.addEventListener('message', (e) => {
      if (e.source === f.contentWindow && (e.data as { type?: string })?.type === 'ready') resolve('ready')
    }))
    f.contentWindow!.postMessage({ source: 'mycel-host', type: 'ping' }, '*')
    const r = await Promise.race([ready, new Promise<string>((res) => setTimeout(() => res('timeout'), 3000))])
    // and the document still renders after the late handshake
    const rendered = new Promise<string>((resolve) => window.addEventListener('message', (e) => {
      if (e.source === f.contentWindow && (e.data as { type?: string })?.type === 'rendered') resolve('rendered')
    }))
    f.contentWindow!.postMessage({ source: 'mycel-host', type: 'render', html: '<script>parent.postMessage({ type: "rendered" }, "*")</script>' }, '*')
    return [r, await Promise.race([rendered, new Promise<string>((res) => setTimeout(() => res('timeout'), 3000))])]
  })
  expect(got).toEqual(['ready', 'rendered'])
})

test('the app CSP blocks inline script even if markup got into the page', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const ran = await page.evaluate(async () => {
    const d = document.createElement('div')
    d.innerHTML = '<img src="/icons/missing.png" onerror="window.__xss = 1">'
    document.body.append(d)
    const s = document.createElement('script')
    s.textContent = 'window.__xss = 2'
    document.body.append(s)
    await new Promise((r) => setTimeout(r, 300))
    return (window as unknown as { __xss?: number }).__xss ?? 0
  })
  expect(ran).toBe(0)
})

for (const [what, prompt] of [['another site', 'make a wander artifact'], ['this app', 'make a wander home artifact']] as const) {
  test(`an artifact that tries to navigate to ${what} is stopped`, async ({ page }) => {
    await reset(page)
    await signIn(page)
    await ask(page, prompt)
    const panel = page.getByTestId('artifact-panel')
    await expect(page.frameLocator('[data-testid="artifact-panel"] iframe').locator('h1')).toHaveText('Wanderer')
    await expect(panel.getByRole('alert')).toContainText('다른 페이지로 이동하려 해', { timeout: 10_000 })
    await expect(panel.locator('iframe')).toHaveCount(0)
    // the app itself is untouched
    await expect(page.getByTestId('composer-input')).toBeVisible()
  })
}
