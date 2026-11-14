// The whole demo story, clicked as a visitor would (web/test/demo/playwright.config.ts), on both banner branches, on
// the app's own UI only: Home's welcome card, the company answer and its sources, Sara's DM and its project link, the
// banner answer with its pictures inline, the app's "Send to room" dialog, the live room, the side chat's mail and its
// card, the end line. The only demo layer is the guide line and the ring over the next real control; on the first
// branch the walk presses only the guide line. Driven by the story file the build played, so it walks any language.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { en as enWords } from '../../src/i18n/en'
import { ko as koWords } from '../../src/i18n/ko'
import type { DemoScript } from '../../demo/script'
import { contentFile } from '../../demo/vite'
import { demoWord } from '../../demo/words'

const loaded = (await import(contentFile())) as { default: DemoScript | { default: DemoScript } }
// (Playwright's loader may wrap the default export once more)
const script = ('default' in loaded.default ? loaded.default.default : loaded.default) as DemoScript
const shots = process.env.DEMO_SHOTS
const step = (id: string) => script.guide.find((s) => s.id === id)!
const answer = (id: string) => script.answers.find((a) => a.id === id)!
// the story's language: the demo's own words, the app's own words (the everyone room's name), the story's messages
const L = script.locale
const appWord = (key: 'rooms.all') => (L === 'ko' ? koWords[key] : enWords[key])
const said = (id: string) => script.events.find((e) => e.id === id)!.text!.slice(0, 12)
/** a content line with {time} as a pattern (the real elapsed time) */
const timed = (line: string) => new RegExp(line.split('{time}').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\d+:\\d\\d'))

// (the demo's start: the base it is served under, DEMO_BASE, is in the config's baseURL)
const START = './'
// the page breaks no rule of the CSP it is served with (test/demo/serve.ts DEMO_CSP): a blocked load is a failure
const blocked = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const list: string[] = []
  blocked.set(page, list)
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) list.push(m.text()) })
})
test.afterEach(({ page }) => { expect(blocked.get(page) ?? []).toEqual([]) })

async function shotAs(page: Page, name: string) {
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

const PRESS_SEND = demoWord('pressSend', L)
/** A step's prompt: typed into the real box by itself on arrival (one prompt) or by its button (a choice), then sent with
 * the real send button (by hand) or the guide line ("Press send →"). Checks the box holds the prompt, the ring is on
 * send, and the box was never focused (no phone keyboard). */
async function prompt(page: Page, id: string, owner: string, byGuide: boolean, box: string, send: string) {
  if (step(owner).suggest!.length > 1) await page.getByTestId(`demo-suggest-${id}`).click()
  await expect(guide(page)).toHaveText(PRESS_SEND, { timeout: 15_000 })
  await expect(page.locator(`[data-testid="${box}"]:visible`).last()).toHaveValue(answer(id).prompt)
  await expect(ring(page)).toBeVisible()
  const sendBox = await page.locator(`[data-testid="${send}"]:visible`).last().boundingBox()
  const ringBox = await ring(page).boundingBox()
  expect(Math.abs((ringBox!.x + ringBox!.width / 2) - (sendBox!.x + sendBox!.width / 2))).toBeLessThan(8)
  // on a phone the typing never takes the focus (no keyboard); on a computer the app's chat focuses its own box, and the
  // app's side chat does so everywhere when it opens
  if (box === 'composer-input' && test.info().project.name.startsWith('390')) expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
  if (byGuide) await guide(page).click()
  else await page.locator(`[data-testid="${send}"]:visible`).last().click()
}

// every branch of the choice, the first by the guide line alone; with one prompt only, once by the guide line and
// once by hand
const banner = step('banner').suggest!
const runs = banner.length > 1 ? banner.map((branch, i) => ({ branch, byGuide: i === 0 }))
  : [{ branch: banner[0]!, byGuide: true }, { branch: banner[0]!, byGuide: false }]
for (const { branch, byGuide } of runs) {
  test(`the whole story on ${branch}${byGuide ? ', by the guide line alone' : ', by hand'}`, async ({ page }) => {
    const shot = (p: Page, n: string) => shotAs(p, byGuide ? n : n.replace(branch, `${branch}-hand`))
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(START)
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
    if (byGuide) await follow(page, demoWord('openChat', L).replace('{title}', leoChat))
    else await page.locator('a[href^="/c/"]:visible').filter({ hasText: leoChat }).first().click()
    await expect(page.locator('[data-testid="assistant-message"] img[src*="/api/files/download"]').first()).toBeVisible()
    // ② the step's prompt: its choice buttons in the guide line, or (one prompt) the guide line itself
    if (banner.length > 1) await expect(page.getByTestId(`demo-suggest-${branch}`)).toBeVisible()
    else await expect(page.getByTestId('demo-suggest')).toHaveCount(0)
    await shot(page, `${branch}-4-project`)
    await prompt(page, branch, 'banner', byGuide, 'composer-input', 'send')
    // the answer as the app shows it: the pictures inline, the saved files, the sources
    await expect(guide(page)).toHaveText(step('share').text, { timeout: 60_000 })
    const pictures = page.locator('[data-testid="assistant-message"]').last().locator('img[src*="/api/files/download"]')
    await expect(pictures).toHaveCount(4)
    await expect.poll(() => pictures.first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100)
    await shot(page, `${branch}-5-answer`)
    // ③ the app's own "Send to room": the button, the room row, Send (and its confirm, when it asks)
    // the guide line (or the ringed button itself) opens the dialog; in the dialog the ring shows the room row, then
    // Send (the guide steps back while the app's dialog is open, so it never covers the dialog's buttons)
    if (byGuide) await guide(page).click()
    else await page.getByTestId('share-to-room').last().click({ force: true })
    const dialog = page.getByRole('dialog')
    const room = script.rooms.find((r) => r.id === 'mkt-room')!
    const name = script.groups.find((g) => g.id === room.group)!.name
    await expect(dialog.getByTestId('share-room-option').first()).toBeVisible()
    await expect(ring(page)).toBeVisible()
    await shot(page, `${branch}-6-share`)
    await dialog.getByTestId('share-room-option').filter({ hasText: name }).first().click()
    await dialog.getByTestId('share-room-send').click()
    // (the app asks again only when someone in the room cannot open something in the answer)
    const confirm = dialog.getByTestId('share-room-confirm-send')
    if (await confirm.waitFor({ timeout: 2500 }).then(() => true, () => false)) await confirm.click()
    // the room: the team reacts with the app's own typing, messages and reactions
    await follow(page, step('room').text)
    await expect(page).toHaveURL(/\/rooms\//)
    await expect(page.locator('[data-testid="room-message"]').filter({ hasText: /🔥|👏|🙌/ }).first()).toBeVisible({ timeout: 60_000 })
    // ④ ✦ is ringed when Sara says Gmail is connected; the side chat's prompt is in the guide line
    await expect(guide(page)).toHaveText(step('mail').text, { timeout: 60_000 })
    await shot(page, `${branch}-7-room`)
    // the side chat: opened by the guide line, or by its real ✦ button; its prompt types itself, send is ringed
    if (byGuide) await guide(page).click()
    else await page.locator('[data-testid="room-side-chat-button"]:visible').first().click()
    await expect(page.getByTestId('side-chat-panel')).toBeVisible()
    await prompt(page, step('mail').suggest![0]!, 'mail', byGuide, 'side-chat-input', 'side-chat-send')
    const card = page.getByTestId('ask-card').last()
    await expect(card).toBeVisible({ timeout: 40_000 })
    await expect(ring(page)).toBeVisible()
    await shot(page, `${branch}-8-confirm`)
    if (byGuide) await guide(page).click()
    else await choose(card, answer('mail').ask!.options[0]!.label)
    // ⑤ Chris's reply in the room, then the CEO's shoutout in #Everyone: its unread row, or the guide line, takes the
    // visitor there; the team's reactions pile up on it and Sara welcomes Mina
    await expect(guide(page)).toHaveText(step('everyone').text, { timeout: 60_000 })
    const everyone = page.locator('a[href^="/rooms/"]:visible').filter({ hasText: script.groups.find((g) => g.id === script.rooms.find((r) => r.id === 'all')!.group)?.name ?? appWord('rooms.all') }).first()
    if (!byGuide && await everyone.isVisible().catch(() => false)) await everyone.click()
    else await guide(page).click()
    const shout = page.locator('[data-testid="room-message"]').filter({ hasText: said('ceo-shoutout') }).last()
    await expect(shout).toBeVisible()
    for (const emoji of ['🎉', '🔥', '👏', '🙌']) await expect(shout.getByText(emoji).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="room-message"]').filter({ hasText: said('sara-welcome') })).toBeVisible({ timeout: 20_000 })
    // the end popup (the app's own Modal): the real time, the recap, the plans link in a new tab, then Look around
    const popup = page.getByRole('dialog')
    await expect(popup.getByTestId('demo-popup')).toBeVisible({ timeout: 40_000 })
    await expect(popup).toContainText(script.end.popup!.title)
    await expect(popup.getByTestId('demo-popup')).toContainText(timed(script.end.popup!.line))
    for (const r of script.end.popup!.recap ?? []) await expect(popup).toContainText(r)
    await shot(page, `${branch}-9-popup`)
    const [plans] = await Promise.all([page.context().waitForEvent('page'), popup.getByTestId('demo-popup-signup').click()])
    await plans.waitForURL(/pricing|about:blank/).catch(() => {})
    expect(plans.url() === 'about:blank' || plans.url().startsWith(script.end.signup.url)).toBe(true)
    await plans.close()
    await popup.getByTestId('demo-popup-close').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // after it: the guide line's end line (the real time, what it usually takes, the plans link) is the way back
    await expect(page.getByTestId('demo-end')).toBeVisible()
    await expect(page.getByTestId('demo-end')).toContainText(timed(`${script.end.title} (${script.end.contrast})`))
    await expect(page.getByTestId('demo-signup')).toHaveAttribute('href', script.end.signup.url)
    await expect(page.getByTestId('demo-signup')).toHaveAttribute('target', '_blank')
    await shot(page, `${branch}-9-end`)
    // no card of the demo's own anywhere
    await expect(page.locator('.demo-toast, .demo-end-backdrop, [data-testid="demo-send-to"], [data-testid="demo-compare"]')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('free typing gets a short reply with the step\'s question on the app\'s card', async ({ page }) => {
  await page.goto(START)
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
  await page.goto(START)
  await page.getByTestId('member-welcome-ask-button').click()
  await expect(guide(page)).toHaveText(step('dm').away ?? step('dm').text, { timeout: 40_000 })
  await page.evaluate(() => { history.pushState(null, '', '/files'); window.dispatchEvent(new PopStateEvent('popstate')) })
  await expect(guide(page)).toHaveText(step('dm').away ?? step('dm').text)
  await guide(page).click()
  await expect(page).toHaveURL(/\/rooms\//)
})

test('"Start over" begins the story again', async ({ page }) => {
  await page.goto(START)
  await page.getByTestId('member-welcome-ask-button').click()
  await expect(page).toHaveURL(/\/c\//)
  await page.getByTestId('demo-restart').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('member-welcome-ask-button')).toBeVisible()
  await expect(guide(page)).toHaveText(script.guide[0]!.text)
  // a deep link (or a reload on one) under the base: the site gives the page, and the story starts at Home, at the base
  await page.goto('rooms/somewhere')
  await expect(page.getByTestId('member-welcome-ask-button')).toBeVisible()
  expect(new URL(page.url()).pathname).toBe(new URL(test.info().project.use.baseURL!).pathname)
})

test('Stop while the guide line\'s prompt streams: the guide line sends it again', async ({ page }) => {
  await page.goto(START)
  await follow(page, step('ask').text)
  await expect(page.getByTestId('answer-sources')).toBeVisible({ timeout: 40_000 })
  await follow(page)
  await expect(page).toHaveURL(/\/rooms\//)
  await follow(page, step('project').text)
  const leoChat = script.projects[0]!.chats![0]!.title
  await follow(page, demoWord('openChat', L).replace('{title}', leoChat))
  await follow(page, PRESS_SEND)
  await expect(page.getByTestId('stop').first()).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('stop').first().click()
  await expect(page.getByTestId('stop')).toHaveCount(0)
  // the prompt is back on the guide line: pressing it fills the box at once (no second typing), then send
  await expect(guide(page)).toHaveText(step('banner').text)
  const sent = await page.getByTestId('user-message').count()
  await guide(page).click()
  await expect(guide(page)).toHaveText(PRESS_SEND)
  await guide(page).click()
  await expect(page.getByTestId('user-message')).toHaveCount(sent + 1, { timeout: 20_000 })
})

test('reduced motion: the prompt is filled at once and the ring on send stands still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(START)
  await follow(page, step('ask').text)
  await expect(page.getByTestId('answer-sources')).toBeVisible({ timeout: 40_000 })
  await follow(page)
  await expect(page).toHaveURL(/\/rooms\//)
  await follow(page, step('project').text)
  const leoChat = script.projects[0]!.chats![0]!.title
  await follow(page, demoWord('openChat', L).replace('{title}', leoChat))
  await expect(page.locator('[data-testid="composer-input"]:visible').last()).toHaveValue(answer(step('banner').suggest![0]!).prompt, { timeout: 2000 })
  await expect(guide(page)).toHaveText(PRESS_SEND)
  expect(await ring(page).evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
})

test('a slow phone: Leo\'s prompt still types itself when the visitor arrives', async ({ page }, info) => {
  // (one phone project is enough; the CPU six times slower, as a busy phone, so the chat mounts late)
  test.skip(info.project.name !== '390-light', 'once, on a phone')
  test.setTimeout(300_000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
  await page.goto(START)
  await follow(page, step('ask').text)
  await expect(page.getByTestId('answer-sources')).toBeVisible({ timeout: 90_000 })
  await follow(page)
  await expect(page).toHaveURL(/\/rooms\//, { timeout: 30_000 })
  await follow(page, step('project').text)
  const leoChat = script.projects[0]!.chats![0]!.title
  await follow(page, demoWord('openChat', L).replace('{title}', leoChat))
  // no press of the guide line here: the arrival alone types the prompt
  await expect(guide(page)).toHaveText(PRESS_SEND, { timeout: 60_000 })
  await expect(page.locator('[data-testid="composer-input"]:visible').last()).toHaveValue(answer(step('banner').suggest![0]!).prompt)
})

// DEMO_OTHER: the other language's demo on the same server (test/demo/serve.ts DEMO_MOUNTS), e.g. /demo/ko/ for /demo/
test('the other language\'s demo next to this one: its own worker, its link in the guide line', async ({ page, context }) => {
  const other = process.env.DEMO_OTHER
  test.skip(!other, 'one demo served')
  await page.goto(START)
  await expect(page.getByTestId('member-welcome-title')).toHaveText(script.home.title)
  const mine = new URL(page.url()).pathname
  const own = (p: Page, base: string) => expect.poll(() => p.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''), { timeout: 10_000 }).toBe(new URL(`${base}sw.js`, p.url()).href)
  // a picture through the page's worker: the visitor's photo, as an <img> asks for it
  const pictures = (p: Page) => expect.poll(() => p.evaluate((id) => new Promise<number>((done) => {
    const img = new Image()
    img.onload = () => done(img.naturalWidth)
    img.onerror = () => done(0)
    img.src = `/api/people/${id}/avatar?t=${Date.now()}`
  }), script.visitor), { timeout: 10_000 }).toBeGreaterThan(0)
  await own(page, mine)
  // the other demo in a second tab of the same browser: held by its own worker (the narrower scope wins), pictures on both
  const second = await context.newPage()
  await second.goto(other!)
  await expect(second.getByTestId('member-welcome-title')).toBeVisible()
  await own(second, other!)
  await pictures(second)
  await pictures(page)
  // this tab again, after the other demo started: still this demo, with its own worker (tabs share no session)
  await page.reload()
  await expect(page.getByTestId('member-welcome-title')).toHaveText(script.home.title)
  await own(page, mine)
  // the guide line's language link goes there
  await page.locator(`[data-testid="demo-langs"] a[href="${other}"]`).click()
  await expect(page).toHaveURL(new RegExp(`${other!.replace(/\//g, '\\/')}$`))
  await expect(page.getByTestId('member-welcome-title')).toBeVisible()
  await own(page, other!)
})

test('a picture downloads and opens on its own (under a base path too)', async ({ page, context }, info) => {
  // (the viewer's "open original" is a computer's control)
  test.skip(info.project.name.startsWith('390'), 'no "open original" on phones')
  await page.goto(START)
  await expect(page.getByTestId('member-welcome-title')).toBeVisible()
  await page.locator('nav a[href^="/rooms"]').first().click()
  const mkt = script.groups.find((g) => g.id === script.rooms.find((r) => r.id === 'mkt-room')!.group)!.name
  await page.locator('a[href^="/rooms/"]:visible').filter({ hasText: mkt }).first().click()
  await page.locator('[data-testid="room-message"] img').first().click()
  await expect(page.getByTestId('image-viewer')).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('image-viewer-download').click()])
  expect(download.suggestedFilename()).toMatch(/\.(png|jpe?g)$/)
  expect((await download.createReadStream()) !== null).toBe(true)
  const [tab] = await Promise.all([context.waitForEvent('page'), page.getByTestId('image-viewer-open').click()])
  await tab.waitForURL(/^blob:/)
  await expect.poll(() => tab.evaluate(() => (document.querySelector('img') as HTMLImageElement | null)?.naturalWidth ?? 0)).toBeGreaterThan(100)
})

test('Stop while a card waits closes it and leaves the story where it was', async ({ page }) => {
  await page.goto(START)
  await expect(page.getByTestId('member-welcome-title')).toBeVisible()
  await page.getByTestId('composer-input').first().fill('Tell me a joke')
  await page.getByTestId('send').first().click()
  await expect(page.getByTestId('ask-card').last()).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('stop').first().click()
  await expect(page.getByTestId('ask-card')).toHaveCount(0)
  await expect(page.getByTestId('stop')).toHaveCount(0)
  await expect(guide(page)).toHaveText(script.guide[0]!.text)
})
