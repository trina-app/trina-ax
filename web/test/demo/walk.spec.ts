// The whole demo story, clicked as a visitor would (web/test/demo/playwright.config.ts), on both banner branches, on
// the app's own UI only: Home's welcome card, the company answer and its sources, Sara's DM and its project link, the
// banner answer with its pictures inline, the app's "Send to room" dialog, the live room, the side chat's mail and its
// card, the end line. The only demo layer is the guide line and the ring over the next real control; on the first
// branch the walk presses only the guide line. Driven by the story file the build played, so it walks any language.
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
const answer = (id: string) => script.answers.find((a) => a.id === id)!

async function shot(page: Page, name: string) {
  if (!shots) return
  fs.mkdirSync(shots, { recursive: true })
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(shots, `${test.info().project.name}-${name}.png`) })
}
const guide = (page: Page) => page.getByTestId('demo-next')
const ring = (page: Page) => page.getByTestId('demo-ring')
/** pick an option of the AI's card (components/chat/AskCard.tsx) and send it */
async function choose(card: Locator, label: string | RegExp) {
  await card.getByText(label, { exact: typeof label === 'string' }).first().click()
  const send = card.getByTestId('ask-send')
  if (await send.isVisible().catch(() => false)) await send.click()
}
/** the guide line, pressed once it says `text` (or anything, without one) */
async function follow(page: Page, text?: string) {
  if (text) await expect(guide(page)).toHaveText(text, { timeout: 60_000 })
  else await expect(guide(page)).toBeVisible({ timeout: 60_000 })
  await guide(page).click()
}

for (const branch of step('banner').suggest!) {
  const byGuide = branch === step('banner').suggest![0]
  test(`the whole story on ${branch}${byGuide ? ', by the guide line alone' : ''}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    // ① Home: the app's welcome card, its question ringed
    await expect(page.getByTestId('member-welcome-title')).toHaveText(script.home.title)
    await expect(ring(page)).toBeVisible()
    await shot(page, `${branch}-1-home`)
    if (byGuide) await follow(page, step('ask').text)
    else await page.getByTestId('member-welcome-ask-button').click()
    await expect(page).toHaveURL(/\/c\//)
    // the company answer, with the app's own sources under it
    await expect(page.getByTestId('answer-sources')).toBeVisible({ timeout: 40_000 })
    await expect(guide(page)).toHaveText(step('dm').away ?? step('dm').text, { timeout: 20_000 })
    await shot(page, `${branch}-2-answer`)
    // Sara's DM (the way there is ringed), then the project link in it
    await follow(page)
    await expect(page).toHaveURL(/\/rooms\//)
    const link = page.locator('[data-testid="room-message"] a[href^="/projects/"]:visible').first()
    await expect(link).toBeVisible()
    await shot(page, `${branch}-3-dm`)
    if (byGuide) await follow(page, step('project').text)
    else await link.click()
    await expect(page).toHaveURL(/\/projects\/|\/c\//)
    // the project's page rings Leo's chat: the banner is seen before the choice
    const leoChat = script.projects[0]!.chats![0]!.title
    await expect(page.locator('a[href^="/c/"]:visible').filter({ hasText: leoChat }).first()).toBeVisible()
    await expect(ring(page)).toBeVisible()
    if (byGuide) await follow(page, step('banner').text)
    else await page.locator('a[href^="/c/"]:visible').filter({ hasText: leoChat }).first().click()
    await expect(page.locator('[data-testid="assistant-message"] img[src*="/api/files/download"]').first()).toBeVisible()
    // ② the two prompts in the guide line
    const prompt = page.getByTestId(`demo-suggest-${branch}`)
    await expect(prompt).toBeVisible()
    await shot(page, `${branch}-4-project`)
    if (byGuide) await guide(page).click()
    else await prompt.click()
    // the answer as the app shows it: the pictures inline, the saved files, the sources
    await expect(guide(page)).toHaveText(step('share').text, { timeout: 60_000 })
    const pictures = page.locator('[data-testid="assistant-message"]').last().locator('img[src*="/api/files/download"]')
    await expect(pictures).toHaveCount(4)
    await expect.poll(() => pictures.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100)
    await shot(page, `${branch}-5-answer`)
    // ③ the app's own "Send to room": the button, the room row, Send (and its confirm, when it asks)
    if (byGuide) {
      // the line presses the ringed control each time: the share button, the room row, Send, the confirm
      for (let i = 0; i < 5; i++) {
        if ((await guide(page).textContent().catch(() => '')) === step('room').text) break
        await guide(page).click()
        await page.waitForTimeout(700)
      }
    } else {
      await page.getByTestId('share-to-room').last().click({ force: true })
      const dialog = page.getByRole('dialog')
      const room = script.rooms.find((r) => r.id === 'mkt-room')!
      const name = script.groups.find((g) => g.id === room.group)!.name
      await expect(ring(page)).toBeVisible()
      await shot(page, `${branch}-6-share`)
      await dialog.getByTestId('share-room-option').filter({ hasText: name }).first().click()
      await dialog.getByTestId('share-room-send').click()
      // (the app asks again only when someone in the room cannot open something in the answer)
      const confirm = dialog.getByTestId('share-room-confirm-send')
      if (await confirm.waitFor({ timeout: 2500 }).then(() => true, () => false)) await confirm.click()
    }
    // the room: the team reacts with the app's own typing, messages and reactions
    await follow(page, step('room').text)
    await expect(page).toHaveURL(/\/rooms\//)
    await expect(page.locator('[data-testid="room-message"]').filter({ hasText: /🔥|👏|🙌/ }).first()).toBeVisible({ timeout: 60_000 })
    // ④ ✦ is ringed when Sara says Gmail is connected; the side chat's prompt is in the guide line
    await expect(guide(page)).toHaveText(step('mail').text, { timeout: 60_000 })
    await shot(page, `${branch}-7-room`)
    await guide(page).click()
    await expect(page.getByTestId('side-chat-panel')).toBeVisible()
    if (byGuide) await guide(page).click()
    else await page.getByTestId(`demo-suggest-${step('mail').suggest![0]}`).click()
    const card = page.getByTestId('ask-card').last()
    await expect(card).toBeVisible({ timeout: 40_000 })
    await expect(ring(page)).toBeVisible()
    await shot(page, `${branch}-8-confirm`)
    if (byGuide) await guide(page).click()
    else await choose(card, answer('mail').ask!.options[0]!.label)
    // the end: Chris's reply in the room, then the guide line becomes the end line
    await expect(page.getByTestId('demo-end')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('demo-signup')).toHaveAttribute('href', /^https?:\/\//)
    await expect(page.getByTestId('demo-signup')).toHaveAttribute('target', '_blank')
    await shot(page, `${branch}-9-end`)
    // no card of the demo's own anywhere
    await expect(page.locator('.demo-toast, .demo-end-backdrop, [data-testid="demo-send-to"], [data-testid="demo-compare"]')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('free typing gets a short reply with the step\'s question on the app\'s card', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('member-welcome-title')).toBeVisible()
  await page.getByTestId('composer-input').first().fill('What is the weather like?')
  await page.getByTestId('send').first().click()
  await expect(page.getByText(script.fallback.text)).toBeVisible({ timeout: 30_000 })
  const card = page.getByTestId('ask-card').last()
  await expect(card).toBeVisible()
  await expect(ring(page)).toBeVisible()
  const home = script.answers.find((a) => a.prompt === script.home.prompt)!
  await choose(card, home.label ?? home.prompt)
  // the picked question is answered in the same reply, and the story goes on
  await expect(guide(page)).toHaveText(step('dm').away ?? step('dm').text, { timeout: 40_000 })
})

test('off the path: the guide says where to go and takes the visitor back', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('member-welcome-ask-button').click()
  await expect(guide(page)).toHaveText(step('dm').away ?? step('dm').text, { timeout: 40_000 })
  await page.evaluate(() => { history.pushState(null, '', '/files'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await expect(guide(page)).toHaveText(step('dm').away ?? step('dm').text)
  await guide(page).click()
  await expect(page).toHaveURL(/\/rooms\//)
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
