// A promo video made in a chat (GET /api/promo-videos/:id, POST and GET …/mp4): "/promo-video …" saves the video on the
// mock like on the team server and it opens beside the chat. [영상 파일로 받기] is there only where the server can make
// the MP4; the first press makes it (the button says so meanwhile, and the page asks again every two seconds) and the
// download starts by itself when it is ready; a failed render is said once. The mock never makes MP4s, so the video's
// state and the render are answered here (the MP4 itself is the mock's few bytes).
import { expect, test, type Page } from '@playwright/test'
import type { PromoVideoInfo } from '@mycel/shared/api'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const ko = DICTS.ko

async function startVideo(page: Page) {
  await page.getByTestId('composer-input').fill('/promo-video a quiet desk fan')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
}

/** A server that can make MP4s: a render ends `as` on the second read of the state after the press. Returns the renders asked. */
async function mp4Server(page: Page, as: 'done' | 'failed' = 'done') {
  let state: PromoVideoInfo['mp4']['state'] = 'none'
  let reads = 0
  let base: PromoVideoInfo | null = null
  const renders: string[] = []
  const mp4 = () => ({ available: true, state, seconds: state === 'done' ? 31 : null, bytes: state === 'done' ? 9 : null })
  await page.route(/\/api\/promo-videos\/[0-9a-f-]+$/, async (r) => {
    const response = await r.fetch()
    // the first read after the press still says "rendering"; the next one ends it
    if (state === 'rendering' && reads++ > 0) state = as
    base = (await response.json()) as PromoVideoInfo
    await r.fulfill({ response, json: { ...base, mp4: mp4() } })
  })
  await page.route(/\/api\/promo-videos\/[0-9a-f-]+\/mp4$/, async (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    renders.push(r.request().url())
    state = 'rendering'
    reads = 0
    await r.fulfill({ status: 202, json: { ...base!, mp4: mp4() } })
  })
  return renders
}

test('the first press makes the MP4 and the download starts by itself; a later press downloads it at once', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  const renders = await mp4Server(page)
  await signIn(page)
  await startVideo(page)
  const panel = page.getByTestId('artifact-panel')
  const button = panel.getByTestId('promo-mp4')
  await expect(button).toHaveText(ko['promo.mp4.get'])
  const first = page.waitForEvent('download', { timeout: 15_000 })
  await button.click()
  await expect(button).toHaveText(ko['promo.mp4.making'])
  await expect(button).toBeDisabled()
  expect((await first).suggestedFilename()).toBe('Acme 홍보 영상.mp4')
  await expect(button).toHaveText(ko['promo.mp4.get'])
  // made before: the press downloads at once, nothing is made again
  const second = page.waitForEvent('download')
  await button.click()
  expect((await second).suggestedFilename()).toBe('Acme 홍보 영상.mp4')
  expect(renders).toHaveLength(1)
  expect(realErrors(errors)).toEqual([])
})

test('a failed render is said once and the button is there to try again', async ({ page }) => {
  await reset(page)
  await mp4Server(page, 'failed')
  await signIn(page)
  await startVideo(page)
  const button = page.getByTestId('artifact-panel').getByTestId('promo-mp4')
  await button.click()
  await expect(page.getByText(ko['promo.mp4.failed'])).toHaveCount(1, { timeout: 15_000 })
  await expect(button).toBeEnabled()
})

test('a server that cannot make MP4s offers no button', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const info = page.waitForResponse((r) => /\/api\/promo-videos\/[0-9a-f-]+$/.test(r.url()))
  await startVideo(page)
  expect((await info).status()).toBe(200)
  await expect(page.getByTestId('artifact-panel')).toBeVisible()
  await expect(page.getByTestId('promo-mp4')).toHaveCount(0)
})

test('a phone: the video opens as a sheet with the button in reach', async ({ page }) => {
  await reset(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await mp4Server(page)
  await signIn(page)
  await startVideo(page)
  const sheet = page.getByTestId('side-panel')
  await expect(sheet.getByTestId('artifact-panel')).toBeVisible()
  expect(Math.round((await sheet.boundingBox())!.width)).toBe(390)
  const button = sheet.getByTestId('promo-mp4')
  await expect(button).toBeInViewport()
  expect((await button.boundingBox())!.x + (await button.boundingBox())!.width).toBeLessThanOrEqual(390)
  const download = page.waitForEvent('download', { timeout: 15_000 })
  await button.click()
  expect((await download).suggestedFilename()).toMatch(/\.mp4$/)
})
