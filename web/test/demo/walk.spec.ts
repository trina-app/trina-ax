// The whole demo story, clicked as a visitor would (web/test/demo/playwright.config.ts): Home's question, the lead's
// DM, the banner in the project, "send to room", the replies, the mail from the side chat, the end card. Driven by the
// story file the build played (its guide lines, suggestions and ids), so it walks any language's story.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DemoScript } from '../../demo/script'
import { contentFile } from '../../demo/vite'

const loaded = (await import(contentFile())) as { default: DemoScript | { default: DemoScript } }
// (Playwright's loader may wrap the default export once more)
const script = ('default' in loaded.default ? loaded.default.default : loaded.default) as DemoScript
const shots = process.env.DEMO_SHOTS
const step = (id: string) => script.guide.find((s) => s.id === id)!

async function shot(page: Page, name: string) {
  if (!shots) return
  fs.mkdirSync(shots, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(shots, `${test.info().project.name}-${name}.png`) })
}
const guide = (page: Page) => page.getByTestId('demo-next')
/** pick an option of the AI's card (components/chat/AskCard.tsx) and send it */
async function choose(card: Locator, label: string | RegExp) {
  await card.getByText(label, { exact: typeof label === 'string' }).first().click()
  const send = card.getByTestId('ask-send')
  if (await send.isVisible().catch(() => false)) await send.click()
}

test('the whole story, from the welcome card to the end card', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  // chapter 1: Home's welcome and its one button
  await expect(page.getByTestId('member-welcome-title')).toHaveText(script.home.title)
  await expect(guide(page)).toHaveText(script.guide[0]!.text)
  await shot(page, '1-home')
  await page.getByTestId('member-welcome-ask-button').click()
  await expect(page).toHaveURL(/\/c\//)
  // the answer streams in; when it is done the lead's DM arrives and the guide points to it
  await expect(guide(page)).toHaveText(step('dm').text, { timeout: 40_000 })
  await shot(page, '2-answer')

  // chapter 2: the DM, its link to the project, the banner
  await guide(page).click()
  await expect(page).toHaveURL(/\/rooms\//)
  const link = page.locator('a[href^="/projects/"]').last()
  await expect(link).toBeVisible()
  await shot(page, '3-dm')
  await link.click()
  await expect(guide(page)).toHaveText(step('banner').text)
  const first = step('banner').suggest![0]!
  await expect(page.getByTestId(`demo-suggest-${first}`)).toBeVisible()
  await shot(page, '4-project')
  await page.getByTestId(`demo-suggest-${first}`).click()
  await expect(guide(page)).toHaveText(step('share').text, { timeout: 40_000 })
  const banner = page.locator('img[src*="/api/files/download"]').last()
  await expect(banner).toBeVisible()
  await expect.poll(() => banner.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100)
  await shot(page, '5-banner')

  // chapter 3: send it to the team room, the replies, the mail from the side chat
  const share = page.getByTestId('share-to-room').last()
  await share.scrollIntoViewIfNeeded()
  await share.click({ force: true })
  const dialog = page.getByRole('dialog')
  const room = script.rooms.find((r) => r.id === (step('share').until as { shared: string }).shared)!
  const roomName = room.group ? script.groups.find((g) => g.id === room.group)!.name : room.name!
  await dialog.getByTestId('share-room-option').filter({ hasText: roomName }).first().click()
  await dialog.getByTestId('share-room-send').click()
  const confirm = dialog.getByTestId('share-room-confirm-send')
  if (await confirm.isVisible().catch(() => false)) await confirm.click()
  await expect(guide(page)).toHaveText(step('mail').text, { timeout: 60_000 })
  await guide(page).click()
  await expect(page).toHaveURL(/\/rooms\//)
  await expect(page.getByTestId('side-chat-panel')).toBeVisible()
  await shot(page, '6-room')
  const mail = step('mail').suggest![0]!
  await page.getByTestId(`demo-suggest-${mail}`).click()
  const card = page.getByTestId('ask-card').last()
  await expect(card).toBeVisible({ timeout: 40_000 })
  await shot(page, '7-confirm')
  const confirmCard = script.answers.find((a) => a.id === mail)!.ask!
  await choose(card, confirmCard.options[0]!.label)

  // the end card
  await expect(page.getByTestId('demo-end')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('demo-signup')).toHaveAttribute('href', /^https?:\/\//)
  await shot(page, '8-end')
  await page.getByTestId('demo-explore').click()
  await expect(page.getByTestId('demo-end')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('free typing gets a short reply with the suggested questions as buttons', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('member-welcome-title')).toBeVisible()
  const box = page.getByTestId('composer-input').first()
  await box.fill('What is the weather like?')
  await page.getByTestId('send').first().click()
  await expect(page.getByText(script.fallback.text)).toBeVisible({ timeout: 30_000 })
  const card = page.getByTestId('ask-card').last()
  await expect(card).toBeVisible()
  const home = script.answers.find((a) => a.prompt === script.home.prompt)!
  await choose(card, home.label ?? home.prompt)
  // the picked question is answered in the same reply, and the story goes on
  await expect(guide(page)).toHaveText(step('dm').text, { timeout: 40_000 })
})

test('"Start over" begins the story again', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('member-welcome-ask-button').click()
  await expect(page).toHaveURL(/\/c\//)
  await page.getByTestId('demo-restart').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('member-welcome-ask-button')).toBeVisible()
  await expect(guide(page)).toHaveText(script.guide[0]!.text)
})

test('Stop while a card waits closes it and leaves the story where it was', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('member-welcome-title')).toBeVisible()
  await page.getByTestId('composer-input').first().fill('Tell me a joke')
  await page.getByTestId('send').first().click()
  await expect(page.getByTestId('ask-card').last()).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('stop').first().click()
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
  await expect(page.getByTestId('stop')).toHaveCount(0)
  await expect(guide(page)).toHaveText(script.guide[0]!.text)
})
