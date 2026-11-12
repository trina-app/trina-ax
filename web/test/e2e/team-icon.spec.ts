// The team logo in Admin › Team settings (shared/src/team-icon.ts): refused files say why, an upload shows at once in
// the computer's sidebar header (this window, and the team's other windows through the realtime notice) and in the
// preview, and removing it brings the product's mark back. Since 2026-11-07 the logo shows only inside the page: the
// tab icon links, /favicon.ico, /apple-touch-icon.png and the manifest stay the product's, after sign-in and after the
// notice too (docs/DECISIONS.md). The mock serves /team-icon through the real serveWeb() (same headers as production).
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@mycel/shared'
import { makeJpeg, makePng, SVG } from '../../../tests/lib/images'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const file = (name: string, mimeType: string, b: Uint8Array) => ({ name, mimeType, buffer: Buffer.from(b) })
const iconHrefs = (page: Page) => page.evaluate(() => [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map((l) => `${l.getAttribute('rel')} ${l.getAttribute('href')}`))
const PRODUCT_LINKS = ['icon /icons/favicon-16.png', 'icon /icons/favicon-32.png', 'icon /icons/favicon-48.png', 'icon /favicon.svg', 'apple-touch-icon /icons/apple-touch-icon.png']
const BUILT_MANIFEST_ICONS = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']

/** what a browser or system takes the app's icon from, as a signed-out visitor gets it: the product's, never the logo */
async function expectProductIcons(visitor: Page) {
  await visitor.reload()
  await expect(visitor.getByTestId('login-username')).toBeVisible()
  expect(await iconHrefs(visitor)).toEqual(PRODUCT_LINKS)
  const ico = await visitor.request.get('/favicon.ico')
  expect(ico.headers()['content-type']).not.toContain('text/html')
  expect([...(await ico.body()).subarray(0, 4)]).toEqual([0, 0, 1, 0])
  const appleBuilt = await (await visitor.request.get('/icons/apple-touch-icon.png')).body()
  for (const p of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) expect((await (await visitor.request.get(p)).body()).equals(appleBuilt)).toBe(true)
  const manifest = await (await visitor.request.get('/manifest.webmanifest')).json()
  expect(manifest.icons.map((i: { src: string }) => i.src)).toEqual(BUILT_MANIFEST_ICONS)
}

test('team logo: refused files, upload, the sidebar follows, the tab and app icons stay the product\'s, remove', async ({ page, browser }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  expect(await iconHrefs(page)).toEqual(PRODUCT_LINKS)
  const other = await page.context().newPage() // another window of the same person
  await other.goto('/')
  await expect(other.getByTestId('composer-input')).toBeVisible()
  await expect(other.getByTestId('sidebar-logo')).toHaveAttribute('src', '/favicon.svg')

  await page.goto('/admin/settings')
  const card = page.getByTestId('team-icon')
  await expect(page.getByRole('heading', { name: '팀 로고' })).toBeVisible()
  await expect(card).toContainText(`컴퓨터에서 사이드바 왼쪽 위, 팀 이름 옆에 보여요. 브라우저 탭과 홈 화면 아이콘은 ${PRODUCT.displayName} 아이콘 그대로예요.`)
  await expect(page.getByTestId('team-icon-status')).toHaveText(`지금은 기본 ${PRODUCT.displayName} 아이콘을 쓰고 있어요.`)
  await expect(page.getByTestId('team-icon-remove')).toHaveCount(0)
  await expect(page.getByTestId('team-icon-preview-light').getByTestId('team-icon-preview-logo')).toHaveAttribute('src', '/favicon.svg')

  // refused before anything is sent: SVG, a JPEG named .png, too small
  const input = page.getByTestId('team-icon-input')
  await input.setInputFiles(file('logo.svg', 'image/svg+xml', SVG))
  await expect(page.getByTestId('team-icon-error')).toHaveText('PNG, JPEG, WebP 이미지만 올릴 수 있어요.')
  await input.setInputFiles(file('photo.png', 'image/png', makeJpeg(200, 200)))
  await expect(page.getByTestId('team-icon-error')).toHaveText('파일 내용이 PNG, JPEG, WebP 이미지가 아니에요. 이미지 파일을 다시 골라 주세요.')
  await input.setInputFiles(file('tiny.png', 'image/png', makePng(16, 16)))
  await expect(page.getByTestId('team-icon-error')).toHaveText('가로와 세로가 32px 이상인 이미지를 올려 주세요.')
  expect(await page.request.get('/__test/log').then((r) => r.json())).not.toContain('PUT /api/admin/team-icon')

  // a 256 px PNG: uploaded; the sidebar header shows it at once, without a reload (it showed the product's mark before)
  await input.setInputFiles(file('logo.png', 'image/png', makePng(256, 256)))
  await expect(page.getByText('팀 로고를 바꿨어요.')).toBeVisible()
  await expect(page.getByTestId('team-icon-error')).toHaveCount(0)
  await expect(card).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
  const v = (await card.getAttribute('data-version'))!
  await expect(page.getByTestId('team-icon-status')).toHaveText('팀 로고를 쓰고 있어요.')
  await expect(page.getByTestId('team-icon-upload')).toHaveText('로고 바꾸기')
  await expect(page.getByTestId('sidebar-logo')).toHaveAttribute('src', `/team-icon?v=${v}`)
  await expect.poll(() => page.getByTestId('sidebar-logo').evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(256)
  // the preview behind "Show previews": the sidebar header with the logo beside the team name, light and dark
  await page.getByTestId('team-icon-previews').click()
  for (const scheme of ['light', 'dark']) {
    const preview = page.getByTestId(`team-icon-preview-${scheme}`)
    await expect(preview).toContainText('Acme')
    const img = preview.getByTestId('team-icon-preview-logo')
    await expect(img).toHaveAttribute('src', `/team-icon?v=${v}`)
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(256)
    expect((await img.boundingBox())!.width).toBe(20)
  }
  // only the sidebar's: no tab or home-screen previews any more
  await expect(card.locator('img')).toHaveCount(3)
  // the other window's sidebar follows through the realtime notice; its tab icon does not
  await expect(other.getByTestId('sidebar-logo')).toHaveAttribute('src', `/team-icon?v=${v}`)
  expect(await iconHrefs(other)).toEqual(PRODUCT_LINKS)
  expect(await iconHrefs(page)).toEqual(PRODUCT_LINKS)

  // the logo itself is public, image only; nothing a browser takes the app's icon from points at it
  const visitor = await browser.newPage()
  await visitor.goto(page.url().replace(/\/admin.*$/, '/login'))
  const icon = await visitor.request.get(`/team-icon?v=${v}`)
  expect(icon.headers()['content-type']).toBe('image/png')
  expect(icon.headers()['content-security-policy']).toBe("default-src 'none'; sandbox")
  expect(icon.headers()['x-content-type-options']).toBe('nosniff')
  expect(icon.headers()['cache-control']).toContain('immutable')
  await expectProductIcons(visitor)

  // a 512 px square (the installed app's icon until 2026-11-07): still only the sidebar
  await input.setInputFiles(file('logo-512.png', 'image/png', makePng(512, 512)))
  await expect(card).not.toHaveAttribute('data-version', v)
  const v2 = (await card.getAttribute('data-version'))!
  expect(v2).toMatch(/^[0-9a-f]{16}$/)
  await expect(page.getByTestId('sidebar-logo')).toHaveAttribute('src', `/team-icon?v=${v2}`)
  await expect(other.getByTestId('sidebar-logo')).toHaveAttribute('src', `/team-icon?v=${v2}`)
  expect(await iconHrefs(page)).toEqual(PRODUCT_LINKS)
  expect(await iconHrefs(other)).toEqual(PRODUCT_LINKS)
  await expectProductIcons(visitor)
  await visitor.close()

  // remove: asked first, then the product's mark in the sidebar again
  await page.getByTestId('team-icon-remove').click()
  await expect(page.getByRole('dialog')).toContainText('팀 로고를 지울까요?')
  await expect(page.getByRole('dialog')).toContainText(`사이드바에 기본 ${PRODUCT.displayName} 아이콘이 다시 보여요.`)
  await page.getByRole('dialog').getByRole('button', { name: '지우기' }).click()
  await expect(page.getByText('기본 아이콘으로 되돌렸어요.')).toBeVisible()
  await expect(page.getByTestId('sidebar-logo')).toHaveAttribute('src', '/favicon.svg')
  await expect(other.getByTestId('sidebar-logo')).toHaveAttribute('src', '/favicon.svg')
  await expect(card).toHaveAttribute('data-version', '')
  await expect(page.getByTestId('team-icon-status')).toHaveText(`지금은 기본 ${PRODUCT.displayName} 아이콘을 쓰고 있어요.`)
  expect(await iconHrefs(page)).toEqual(PRODUCT_LINKS)
  expect(await iconHrefs(other)).toEqual(PRODUCT_LINKS)
  const ico = await page.request.get('/favicon.ico')
  expect(ico.headers()['content-type']).not.toContain('text/html')
  expect([...(await ico.body()).subarray(0, 4)]).toEqual([0, 0, 1, 0])
  // an icon-like file that does not exist is a 404, not the app page
  expect((await page.request.get('/favicon.png')).status()).toBe(404)
  expect(realErrors(errors)).toEqual([])
})

test('a member signing in with a logo set: the logo in the sidebar, the product\'s tab icon; may not set it', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  await page.getByTestId('team-icon-input').setInputFiles(file('logo.png', 'image/png', makePng(64, 64)))
  await expect(page.getByTestId('team-icon')).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
  const v = await page.getByTestId('team-icon').getAttribute('data-version')
  const ctx = await browser.newContext({ baseURL: page.url().replace(/\/admin.*$/, '') })
  const member = await ctx.newPage()
  await signIn(member, { username: 'bob', password: 'bob password 1' })
  await expect(member.getByTestId('sidebar-logo')).toHaveAttribute('src', `/team-icon?v=${v}`)
  expect(await iconHrefs(member)).toEqual(PRODUCT_LINKS)
  expect(await member.evaluate(() => (document.querySelector('link[rel=icon]') as HTMLLinkElement).href)).toMatch(/\/icons\/favicon-16\.png$/)
  const r = await member.request.put('/api/admin/team-icon?type=image%2Fpng', { headers: { 'x-mycel-csrf': '1', 'content-type': 'application/octet-stream' }, data: Buffer.from(makePng(64, 64)) })
  expect(r.status()).toBe(403)
  await ctx.close()
})

test('phone width: the previews keep the sidebar\'s logo size and the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  // a phone: the logo is in Team settings' General (pages/admin/teamSettingsGroups.ts)
  await page.goto('/admin/settings/general')
  await page.getByTestId('team-icon-input').setInputFiles(file('logo.png', 'image/png', makePng(256, 256)))
  await expect(page.getByTestId('team-icon-remove')).toBeVisible()
  await page.getByTestId('team-icon-previews').click()
  for (const scheme of ['light', 'dark']) expect((await page.getByTestId(`team-icon-preview-${scheme}`).getByTestId('team-icon-preview-logo').boundingBox())!.width).toBe(20)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})

test('the sidebar header shows a non-square logo cropped, not stretched', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  await page.getByTestId('team-icon-input').setInputFiles(file('wide.png', 'image/png', makePng(240, 120)))
  await expect(page.getByTestId('team-icon')).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
  const logo = page.getByTestId('sidebar-logo')
  await expect.poll(() => logo.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(240)
  const box = (await logo.boundingBox())!
  expect([box.width, box.height]).toEqual([28, 28])
  expect(await logo.evaluate((el) => getComputedStyle(el).objectFit)).toBe('cover')
})

// <main> is only a focus target (the skip link, the notification line giving focus back): it draws no ring of its own.
// The ring used to be drawn around the whole page area, and its left edge showed as a full-height line over the
// sidebar's border. What is inside <main> keeps its ring.
test('main takes focus without an outline; a button inside it still shows its ring', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const outline = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).outlineStyle)
  // the skip link is the first stop of the keyboard; Enter moves focus to <main>
  await page.keyboard.press('Tab')
  await expect(page.locator('a[href="#main"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main')).toBeFocused()
  expect(await outline('#main')).toBe('none')
  // a click on an empty spot in <main> and then a key: the case that showed the line
  await page.evaluate(() => (document.activeElement as HTMLElement).blur())
  await page.locator('#main').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('Shift')
  await page.evaluate(() => document.getElementById('main')!.focus())
  expect(await outline('#main')).toBe('none')
  // the next button inside <main> shows its ring (the message box's own frame takes the ring for the text field)
  for (let i = 0; i < 8 && (await page.evaluate(() => document.activeElement?.tagName)) !== 'BUTTON'; i++) await page.keyboard.press('Tab')
  const inside = await page.evaluate(() => ({ in: !!document.activeElement?.closest('main'), style: getComputedStyle(document.activeElement!).outlineStyle }))
  expect(inside).toEqual({ in: true, style: 'solid' })
})

test('phone width: the menu header keeps the product mark next to the AI name, the logo shows on computers', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  await page.getByTestId('team-icon-input').setInputFiles(file('logo.png', 'image/png', makePng(256, 256)))
  await expect(page.getByTestId('team-icon')).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '메뉴 열기' }).click()
  const drawer = page.locator('[data-drawer]')
  await expect(drawer.getByTestId('sidebar-logo-phone')).toBeVisible()
  await expect(drawer.getByTestId('sidebar-logo-phone')).toHaveAttribute('src', '/favicon.svg')
  await expect(drawer.getByTestId('sidebar-logo')).toBeHidden()
})
