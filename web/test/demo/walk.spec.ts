// The whole demo story, clicked as a visitor would (web/test/demo/playwright.config.ts), on both banner branches: Home's
// question, Sara's toast and DM, the project card, the banner prompt, the answer's five deliverables and its one send
// button, the live room, the side chat's mail and its card, the agency's toast, the end card. Driven by the story file
// the build played (guide lines, suggestions, ids), so it walks any language's story.
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
const glowing = (page: Page) => page.locator('.demo-glow:visible')
/** pick an option of the AI's card (components/chat/AskCard.tsx) and send it */
async function choose(card: Locator, label: string | RegExp) {
  await card.getByText(label, { exact: typeof label === 'string' }).first().click()
  const send = card.getByTestId('ask-send')
  if (await send.isVisible().catch(() => false)) await send.click()
}

for (const branch of step('banner').suggest!) {
  test(`the whole story on ${branch}, from the welcome card to the end card`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    // ① Home: the welcome, the inviter's photo, one big button, and it is the one thing that glows
    await expect(page.getByTestId('member-welcome-title')).toHaveText(script.home.title)
    await expect(page.getByTestId('member-welcome-ask-button')).toBeVisible()
    await expect(glowing(page)).toHaveCount(1)
    await shot(page, `${branch}-1-home`)
    await page.getByTestId('member-welcome-ask-button').click()
    await expect(page).toHaveURL(/\/c\//)
    // the answer: sources and people under it; then Sara's toast slides in
    await expect(page.getByTestId('demo-people')).toBeVisible({ timeout: 40_000 })
    await expect(page.getByTestId('demo-sources')).toBeVisible()
    const toast = page.getByTestId('demo-toast')
    await expect(toast).toBeVisible({ timeout: 20_000 })
    await expect(guide(page)).toHaveText(step('dm').away ?? step('dm').text)
    await shot(page, `${branch}-2-answer`)
    await toast.click()
    await expect(page).toHaveURL(/\/rooms\//)
    // the DM's project card
    const card = page.locator('[data-testid="demo-project-card"]:visible').first()
    await expect(card).toBeVisible()
    await shot(page, `${branch}-3-dm`)
    await card.click()
    // ② the project: Leo's banner and the two prompts above the box
    const prompt = page.getByTestId(`demo-suggest-${branch}`)
    await expect(prompt).toBeVisible()
    await shot(page, `${branch}-4-project`)
    await prompt.click()
    const send = page.getByTestId('demo-send-to')
    await expect(send).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('demo-compare')).toBeVisible()
    await expect(page.getByTestId('demo-deliverables').locator('button')).toHaveCount(answer(branch).deliverables!.length)
    await send.scrollIntoViewIfNeeded()
    await shot(page, `${branch}-5-deliverables`)
    // ③ one click: posted and in the room; the team reacts; ✦ glows when Sara says Gmail is connected
    await send.click()
    await expect(page).toHaveURL(/\/rooms\//)
    const side = page.getByTestId('room-side-chat-button')
    await expect(side).toHaveClass(/demo-glow/, { timeout: 60_000 })
    await expect(page.locator('[data-testid="room-message"]').filter({ hasText: /🔥|👏|🙌/ }).first()).toBeVisible()
    await shot(page, `${branch}-6-room`)
    await side.click()
    // the side chat's one prompt, the draft with its attachments and the card
    const mail = page.getByTestId(`demo-suggest-${step('mail').suggest![0]}`)
    await expect(mail).toBeVisible()
    await mail.click()
    const ask = page.getByTestId('ask-card').last()
    await expect(ask).toBeVisible({ timeout: 40_000 })
    await expect(page.locator('.demo-file')).not.toHaveCount(0)
    await shot(page, `${branch}-7-confirm`)
    await choose(ask, answer('mail').ask!.options[0]!.label)
    // ④ the agency's toast, then the end card with the day's numbers
    await expect(page.getByTestId('demo-toast').last()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('demo-end')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('demo-stats').locator('dd')).toHaveCount(script.end.stats!.length)
    await expect(page.getByTestId('demo-signup')).toHaveAttribute('href', /^https?:\/\//)
    await shot(page, `${branch}-8-end`)
    await page.getByTestId('demo-explore').click()
    await expect(page.getByTestId('demo-end')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('free typing gets a short reply with the step\'s question as a button', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('member-welcome-title')).toBeVisible()
  await page.getByTestId('composer-input').first().fill('What is the weather like?')
  await page.getByTestId('send').first().click()
  await expect(page.getByText(script.fallback.text)).toBeVisible({ timeout: 30_000 })
  const card = page.getByTestId('ask-card').last()
  await expect(card).toBeVisible()
  const home = script.answers.find((a) => a.prompt === script.home.prompt)!
  await choose(card, home.label ?? home.prompt)
  // the picked question is answered in the same reply, and the story goes on
  await expect(page.getByTestId('demo-toast')).toBeVisible({ timeout: 40_000 })
})

test('off the path: the guide says where to go and takes the visitor back', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('member-welcome-ask-button').click()
  await expect(page.getByTestId('demo-toast')).toBeVisible({ timeout: 40_000 })
  // wander off to Files instead of opening the DM
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
