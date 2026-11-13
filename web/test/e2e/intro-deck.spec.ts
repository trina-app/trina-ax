// An intro deck made in a chat (docs/DECISIONS.md "D2"; GET /api/intro-decks/builds, …/builds/:id/slides/:n,
// /api/intro-decks/:id and its PPTX / PDF): "/intro-deck …" runs on the mock like on the team server (an outline, one
// slide per step with its small picture, then the deck arrives saved); the progress shows the finished slides' pictures,
// the deck opens beside the chat, and [받기 ▾] offers the files this server can make. The mock never builds the files,
// so its info is turned to "both can be made" here (its downloads are a few bytes).
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function startDeck(page: Page) {
  await page.getByTestId('composer-input').fill('/intro-deck Acme, a company that makes quiet desk fans')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
}

/** the deck's info says both files can be made (the mock's files are a few bytes) */
async function filesCanBeMade(page: Page) {
  await page.route(/\/api\/intro-decks\/[0-9a-f-]+$/, async (r) => {
    const response = await r.fetch()
    await r.fulfill({ response, json: { ...(await response.json()), pptx: true, pdf: true } })
  })
}

test('the deck is built with slide pictures, opens beside the chat, and downloads as PowerPoint and PDF', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  await filesCanBeMade(page)
  const slides: number[] = []
  page.on('response', (r) => { if (/\/api\/intro-decks\/builds\/[^/]+\/slides\/\d+/.test(r.url())) slides.push(r.status()) })
  const builds = page.waitForResponse((r) => /\/api\/intro-decks\/builds\?chatId=/.test(r.url()))
  await signIn(page)
  await startDeck(page)
  // the chat asks for its builds once it shows a step of the deck tool
  expect((await builds).status()).toBe(200)
  await expect(page.getByTestId('deck-progress').first()).toBeVisible()
  // the finished slides' small pictures come from the server
  await expect.poll(() => slides.filter((s) => s === 200).length).toBeGreaterThan(0)

  // the deck opens beside the chat with one [받기 ▾]: PowerPoint and PDF
  const panel = page.getByTestId('artifact-panel')
  await expect(panel).toBeVisible()
  const get = panel.getByTestId('deck-get')
  await expect(get).toBeVisible()
  await get.click()
  await expect(page.getByTestId('deck-menu').getByRole('menuitem')).toHaveCount(2)
  const pptx = page.waitForEvent('download')
  await page.getByTestId('deck-get-pptx').click()
  expect((await pptx).suggestedFilename()).toBe('Acme 회사 소개서.pptx')
  await get.click()
  const pdf = page.waitForEvent('download')
  await page.getByTestId('deck-get-pdf').click()
  expect((await pdf).suggestedFilename()).toBe('Acme 회사 소개서.pdf')
  expect(realErrors(errors)).toEqual([])
})

test('a server that cannot make the files offers no [받기 ▾]', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const info = page.waitForResponse((r) => /\/api\/intro-decks\/[0-9a-f-]+$/.test(r.url()))
  await startDeck(page)
  expect((await info).status()).toBe(200)
  await expect(page.getByTestId('artifact-panel')).toBeVisible()
  await expect(page.getByTestId('deck-get')).toHaveCount(0)
})

test('a phone: the deck opens as a sheet over the chat, with its [받기 ▾] in reach', async ({ page }) => {
  await reset(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await filesCanBeMade(page)
  await signIn(page)
  await startDeck(page)
  // the finished deck opens by itself, as a sheet over the whole chat
  const sheet = page.getByTestId('side-panel')
  await expect(sheet.getByTestId('artifact-panel')).toBeVisible()
  expect(Math.round((await sheet.boundingBox())!.width)).toBe(390)
  const get = page.getByTestId('artifact-panel').getByTestId('deck-get')
  await expect(get).toBeInViewport()
  const box = (await get.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await get.click()
  const pptx = page.waitForEvent('download')
  await page.getByTestId('deck-get-pptx').click()
  expect((await pptx).suggestedFilename()).toMatch(/\.pptx$/)
})
