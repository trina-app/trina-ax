// The team logo in Admin › Team settings (shared/src/team-icon.ts): refused files say why, an upload shows previews and
// becomes the tab icon at once (this window, the team's other windows, the sign-in page and the manifest), and removing
// it brings the default mark back. The mock serves /team-icon through the real serveWeb() (same headers as production).
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@mycel/shared'
import { makeJpeg, makePng, SVG } from '../../../tests/lib/images'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const file = (name: string, mimeType: string, b: Uint8Array) => ({ name, mimeType, buffer: Buffer.from(b) })
const iconHrefs = (page: Page) => page.evaluate(() => [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map((l) => `${l.getAttribute('rel')} ${l.getAttribute('href')}`))
const DEFAULT_LINKS = ['icon /icons/favicon-16.png', 'icon /icons/favicon-32.png', 'icon /icons/favicon-48.png', 'icon /favicon.svg', 'apple-touch-icon /icons/apple-touch-icon.png']

test('team logo: refused files, upload with previews, the tab icon follows, remove', async ({ page, browser }) => {
  await reset(page)
  const errors = watchConsole(page)
  await signIn(page)
  expect(await iconHrefs(page)).toEqual(DEFAULT_LINKS)
  const other = await page.context().newPage() // another window of the same person
  await other.goto('/')
  await expect(other.getByTestId('composer-input')).toBeVisible()

  await page.goto('/admin/settings')
  const card = page.getByTestId('team-icon')
  await expect(page.getByRole('heading', { name: '팀 로고' })).toBeVisible()
  await expect(page.getByTestId('team-icon-status')).toHaveText(`지금은 기본 ${PRODUCT.displayName} 아이콘을 쓰고 있어요.`)
  await expect(page.getByTestId('team-icon-remove')).toHaveCount(0)
  await expect(page.getByTestId('team-icon-preview-light').getByTestId('team-icon-img-16')).toHaveAttribute('src', '/favicon.svg')

  // refused before anything is sent: SVG, a JPEG named .png, too small
  const input = page.getByTestId('team-icon-input')
  await input.setInputFiles(file('logo.svg', 'image/svg+xml', SVG))
  await expect(page.getByTestId('team-icon-error')).toHaveText('PNG, JPEG, WebP 이미지만 올릴 수 있어요.')
  await input.setInputFiles(file('photo.png', 'image/png', makeJpeg(200, 200)))
  await expect(page.getByTestId('team-icon-error')).toHaveText('파일 내용이 PNG, JPEG, WebP 이미지가 아니에요. 이미지 파일을 다시 골라 주세요.')
  await input.setInputFiles(file('tiny.png', 'image/png', makePng(16, 16)))
  await expect(page.getByTestId('team-icon-error')).toHaveText('가로와 세로가 32px 이상인 이미지를 올려 주세요.')
  expect(await page.request.get('/__test/log').then((r) => r.json())).not.toContain('PUT /api/admin/team-icon')

  // a PNG: uploaded, previews at 16, 32 and 180 px on light and dark
  await input.setInputFiles(file('logo.png', 'image/png', makePng(256, 256)))
  await expect(page.getByText('팀 로고를 바꿨어요.')).toBeVisible()
  await expect(page.getByTestId('team-icon-error')).toHaveCount(0)
  await expect(card).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
  const v = (await card.getAttribute('data-version'))!
  await expect(page.getByTestId('team-icon-status')).toHaveText('팀 로고를 쓰고 있어요.')
  await expect(page.getByTestId('team-icon-upload')).toHaveText('로고 바꾸기')
  for (const scheme of ['light', 'dark']) {
    for (const n of [16, 32, 180]) {
      const img = page.getByTestId(`team-icon-preview-${scheme}`).getByTestId(`team-icon-img-${n}`)
      await expect(img).toHaveAttribute('src', `/team-icon?v=${v}`)
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(256)
      expect((await img.boundingBox())!.width).toBe(n)
    }
  }

  // the tab icon of this window, of the person's other window (realtime) and of a signed-out visitor (server-written)
  const logoLinks = [`icon /team-icon?v=${v}`, `apple-touch-icon /team-icon?v=${v}`]
  expect(await iconHrefs(page)).toEqual(logoLinks)
  await expect.poll(() => iconHrefs(other)).toEqual(logoLinks)
  const visitor = await browser.newPage()
  await visitor.goto(page.url().replace(/\/admin.*$/, '/login'))
  await expect(visitor.getByTestId('login-username')).toBeVisible()
  expect(await iconHrefs(visitor)).toEqual(logoLinks)
  const icon = await visitor.request.get(`/team-icon?v=${v}`)
  expect(icon.headers()['content-type']).toBe('image/png')
  expect(icon.headers()['content-security-policy']).toBe("default-src 'none'; sandbox")
  expect(icon.headers()['x-content-type-options']).toBe('nosniff')
  expect(icon.headers()['cache-control']).toContain('immutable')
  expect((await visitor.request.get('/favicon.ico')).headers()['content-type']).toBe('image/png')
  const manifest = await (await visitor.request.get('/manifest.webmanifest')).json()
  expect(manifest.icons).toEqual([{ src: `/team-icon?v=${v}`, sizes: '256x256', type: 'image/png', purpose: 'any' }])
  await visitor.close()

  // remove: asked first, then the default mark everywhere again
  await page.getByTestId('team-icon-remove').click()
  await expect(page.getByRole('dialog')).toContainText('팀 로고를 지울까요?')
  await page.getByRole('dialog').getByRole('button', { name: '지우기' }).click()
  await expect(page.getByText('기본 아이콘으로 되돌렸어요.')).toBeVisible()
  await expect(card).toHaveAttribute('data-version', '')
  await expect(page.getByTestId('team-icon-status')).toHaveText(`지금은 기본 ${PRODUCT.displayName} 아이콘을 쓰고 있어요.`)
  expect(await iconHrefs(page)).toEqual(DEFAULT_LINKS)
  await expect.poll(() => iconHrefs(other)).toEqual(DEFAULT_LINKS)
  const ico = await page.request.get('/favicon.ico')
  expect(ico.headers()['content-type']).not.toContain('text/html')
  expect([...(await ico.body()).subarray(0, 4)]).toEqual([0, 0, 1, 0])
  // an icon-like file that does not exist is a 404, not the app page
  expect((await page.request.get('/favicon.png')).status()).toBe(404)
  expect(realErrors(errors)).toEqual([])
})

test('a member gets the logo as tab icon but may not set it', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  await page.getByTestId('team-icon-input').setInputFiles(file('logo.png', 'image/png', makePng(64, 64)))
  await expect(page.getByTestId('team-icon')).toHaveAttribute('data-version', /^[0-9a-f]{16}$/)
  const v = await page.getByTestId('team-icon').getAttribute('data-version')
  const ctx = await browser.newContext({ baseURL: page.url().replace(/\/admin.*$/, '') })
  const member = await ctx.newPage()
  await signIn(member, { username: 'bob', password: 'bob password 1' })
  expect(await iconHrefs(member)).toEqual([`icon /team-icon?v=${v}`, `apple-touch-icon /team-icon?v=${v}`])
  const r = await member.request.put('/api/admin/team-icon?type=image%2Fpng', { headers: { 'x-mycel-csrf': '1', 'content-type': 'application/octet-stream' }, data: Buffer.from(makePng(64, 64)) })
  expect(r.status()).toBe(403)
  await ctx.close()
})

test('phone width: the previews keep their real sizes and the page does not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  await page.getByTestId('team-icon-input').setInputFiles(file('logo.png', 'image/png', makePng(256, 256)))
  await expect(page.getByTestId('team-icon-remove')).toBeVisible()
  for (const scheme of ['light', 'dark']) {
    for (const n of [16, 32, 180]) expect((await page.getByTestId(`team-icon-preview-${scheme}`).getByTestId(`team-icon-img-${n}`).boundingBox())!.width).toBe(n)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
})
