// "Get the app" on the join pages (docs/AGENTS/plan/20261111-1058-invite-get-the-app.md), at 390 in a phone's browser:
// an iPhone gets Apple's Smart App Banner (no app-argument) and one button that copies the invite or team link, then
// opens the App Store; Android gets the same button to the download page and keeps "앱에서 열기" (its fallback the same
// page); the form is behind "브라우저에서 계속하기"; a computer sees the form as before. The token never reaches the
// store: not in its address, not in a Referer. SHOT_DIR=<folder> also saves light and dark screenshots.
import path from 'node:path'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { reset, signIn } from './helpers'

const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
}
const APP_STORE = 'https://apps.apple.com/app/trina-ax/id6829192435?platform=iphone'
const DOWNLOAD = 'https://ax.trina.app/download'

const post = async (page: Page, url: string, data: unknown) => {
  const r = await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.status(), url).toBe(201)
  return r.json()
}

/** A phone's browser at 390; the store and the download page answer a stub, and every request that leaves this
 * server is kept (address and Referer) to check that the token never goes along. */
async function phone(browser: Browser, ua: string, colorScheme: 'light' | 'dark' = 'light') {
  const ctx = await browser.newContext({ locale: 'ko-KR', userAgent: ua, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme, permissions: ['clipboard-read', 'clipboard-write'] })
  const outside: { url: string; referer: string | null }[] = []
  await ctx.route(/^https:\/\/(apps\.apple\.com|ax\.trina\.app)\//, async (route) => {
    outside.push({ url: route.request().url(), referer: (await route.request().allHeaders())['referer'] ?? null })
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>store</title><p>store</p>' })
  })
  return { ctx, outside }
}

const shot = async (p: Page, name: string) => {
  if (process.env.SHOT_DIR) await p.screenshot({ path: path.join(process.env.SHOT_DIR, `${name}.png`) })
}

test('an iPhone: the banner, "초대 링크 복사하고 앱 받기" copies the link and opens the App Store, the form behind a link', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const { ctx, outside } = await phone(browser, UA.iphone)
  const p = await ctx.newPage()
  await p.goto(`/invite/${token}`)
  await expect(p.getByTestId('get-app')).toBeVisible()
  const origin = new URL(p.url()).origin
  // Apple's Smart App Banner, without app-argument (the token is in this address)
  expect(await p.locator('meta[name="apple-itunes-app"]').getAttribute('content')).toBe('app-id=6829192435')
  expect(await p.content()).not.toContain('app-argument')
  const button = p.getByTestId('get-app-store')
  await expect(button).toHaveText(ko('auth.getApp'))
  expect(await button.getAttribute('href')).toBe(APP_STORE)
  await expect(p.getByTestId('get-app-hint')).toHaveText(ko('auth.getAppHint'))
  await expect(p.getByTestId('join-form')).toHaveCount(0)
  // an iPhone gets no custom-scheme link (any app could claim it)
  await expect(p.getByTestId('open-in-app')).toHaveCount(0)
  await expect(p.getByTestId('join-signin')).toBeVisible()
  // the page never copies on its own
  await p.evaluate(() => navigator.clipboard.writeText('before'))
  await p.reload()
  await expect(p.getByTestId('get-app')).toBeVisible()
  expect(await p.evaluate(() => navigator.clipboard.readText())).toBe('before')
  await shot(p, 'iphone-invite-light')

  await button.click()
  await p.waitForURL(APP_STORE)
  expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/invite/${token}`)
  expect(outside).toEqual([{ url: APP_STORE, referer: null }])

  // back on the page: the toast said so; "브라우저에서 계속하기" shows the form
  await p.goBack()
  await expect(p.getByTestId('get-app')).toBeVisible()
  await p.getByTestId('get-app-web').click()
  await expect(p.getByTestId('join-form')).toBeVisible()
  await expect(p.getByTestId('get-app')).toHaveCount(0)
  await ctx.close()
})

test('the toast says the link was copied', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const { ctx } = await phone(browser, UA.iphone)
  const p = await ctx.newPage()
  await p.goto(`/invite/${token}`)
  // the browser stays on this page (the navigation to the store is cancelled), so the toast can be read
  await p.evaluate(() => (window as unknown as { navigation: EventTarget }).navigation.addEventListener('navigate', (e) => e.preventDefault()))
  await p.getByTestId('get-app-store').click()
  await expect(p.getByText(ko('auth.linkCopied'))).toBeVisible()
  await shot(p, 'iphone-invite-copied')
  await ctx.close()
})

test('an iPhone on the team link: the copied link is the team link, with its token from memory', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const link = await post(page, '/api/admin/team-link', {})
  const linkUrl = new URL(link.link.url)
  const { ctx, outside } = await phone(browser, UA.iphone, 'dark')
  const p = await ctx.newPage()
  await p.goto(linkUrl.pathname + linkUrl.hash)
  await expect(p.getByTestId('get-app')).toBeVisible()
  expect(new URL(p.url()).hash).toBe('')
  expect(await p.locator('meta[name="apple-itunes-app"]').getAttribute('content')).toBe('app-id=6829192435')
  await shot(p, 'iphone-join-dark')
  const origin = new URL(p.url()).origin
  await p.getByTestId('get-app-store').click()
  await p.waitForURL(APP_STORE)
  expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/join${linkUrl.hash}`)
  expect(outside.map((o) => o.referer)).toEqual([null])
  for (const o of outside) expect(o.url).not.toContain(linkUrl.hash.slice(3))
  await ctx.close()
})

test('Android: the download page, "앱에서 열기" with the same page as its fallback, no banner', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  for (const scheme of ['light', 'dark'] as const) {
    const { ctx, outside } = await phone(browser, UA.android, scheme)
    const p = await ctx.newPage()
    await p.goto(`/invite/${token}`)
    await expect(p.getByTestId('get-app')).toBeVisible()
    const origin = new URL(p.url()).origin
    await expect(p.locator('meta[name="apple-itunes-app"]')).toHaveCount(0)
    expect(await p.getByTestId('get-app-store').getAttribute('href')).toBe(DOWNLOAD)
    expect(await p.getByTestId('open-in-app').getAttribute('href')).toBe(
      `intent://open?url=${encodeURIComponent(`${origin}/invite/${token}`)}#Intent;scheme=trina-ax;package=app.trina.ax;S.browser_fallback_url=${encodeURIComponent(DOWNLOAD)};end`,
    )
    await expect(p.getByTestId('join-form')).toHaveCount(0)
    await shot(p, `android-invite-${scheme}`)
    if (scheme === 'light') {
      await p.getByTestId('get-app-store').click()
      await p.waitForURL(DOWNLOAD)
      expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/invite/${token}`)
      expect(outside).toEqual([{ url: DOWNLOAD, referer: null }])
    }
    await ctx.close()
  }
})

test('a computer: the form as before, no banner, no button', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const ctx: BrowserContext = await browser.newContext({ locale: 'ko-KR' })
  const p = await ctx.newPage()
  await p.goto(`/invite/${token}`)
  await expect(p.getByTestId('join-form')).toBeVisible()
  await expect(p.getByTestId('get-app')).toHaveCount(0)
  await expect(p.locator('meta[name="apple-itunes-app"]')).toHaveCount(0)
  await ctx.close()
})
