// A live recording's words in the three message boxes with a mic (the AI chat's Composer, a room's RoomComposer, the
// ✦ side chat): the text that stands in the box's place while recording (VoiceBar.tsx VoiceHeld) grows with the words
// as the box does while typing, up to the box's own height limit; then it shows its last whole lines, the newest words
// at the bottom and no line cut in half at the top edge (QA: "받아쓰기 할 때 입력창이 안 늘어나서 답답해"). Also with the
// keyboard up on a phone (a shorter window) and in dark mode. GROW_SHOTS=<dir> saves a screenshot of each box.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'] })

const WORDS = 'Hello, nice to meet you. Who are you? I am Dion, and I am testing how the box grows while I talk to it.'
const SHOTS = process.env.GROW_SHOTS

/** a team whose voice input goes to OpenRouter: words while recording, each piece a long sentence */
async function live(page: Page) {
  expect((await page.request.post('/__test/speech', { data: { provider: 'openrouter', key: true } })).ok()).toBeTruthy()
  await page.route('**/api/transcribe/piece', (r) => r.fulfill({ json: { lines: [{ start: 0, end: 1, text: Array(4).fill(WORDS).join(' ') }], language: 'en' } }))
}

/** the held text's box: its height, whether it is at its limit, and how its lines sit in what can be seen */
const measure = (held: Locator) =>
  held.evaluate((p) => {
    const cs = getComputedStyle(p)
    const lh = parseFloat(cs.lineHeight)
    const pt = parseFloat(cs.paddingTop) || 0
    const pb = parseFloat(cs.paddingBottom) || 0
    const box = p.getBoundingClientRect()
    // what is drawn: the box less what its clip-path cuts at the top
    const inset = /^inset\(([\d.]+)px/.exec(cs.clipPath)
    const top = box.top + (inset ? parseFloat(inset[1]!) : 0)
    const range = document.createRange()
    range.selectNodeContents(p)
    const lines = [...range.getClientRects()].filter((r) => r.height > 0)
    // a line partly in sight: part of it above the top edge or below the bottom one
    const cut = lines.filter((r) => r.bottom > top + 1 && r.top < box.bottom - 1 && (r.top < top - 1 || r.bottom > box.bottom + 1)).length
    const last = lines[lines.length - 1]
    return {
      height: box.height,
      full: p.scrollHeight > p.clientHeight + 1,
      atEnd: p.scrollHeight - p.clientHeight - p.scrollTop <= 1,
      wholeLines: Math.abs(((p.clientHeight - pt - pb) / lh) % 1) < 0.05 || Math.abs(((p.clientHeight - pt - pb) / lh) % 1) > 0.95,
      lastInSight: !!last && last.top >= top - 1 && last.bottom <= box.bottom - pb + 1,
      cut,
    }
  })

/** records in `scope`'s box until the held text is at its limit, checking that it grew on the way */
async function recordLong(page: Page, scope: Locator, heldId: string, name: string) {
  await scope.getByTestId('voice-button').click()
  await expect(scope.getByTestId('voice-bar')).toBeVisible()
  const first = (await scope.boundingBox())!.height
  const held = page.getByTestId(heldId)
  await expect(held).toContainText(WORDS, { timeout: 12_000 })
  // more pieces: taller, until the box's limit
  await expect.poll(async () => (await measure(held)).full, { timeout: 30_000, intervals: [500] }).toBe(true)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    // the box's colours ease in (transition)
    await page.waitForTimeout(300)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
  const m = await measure(held)
  expect((await scope.boundingBox())!.height).toBeGreaterThan(first + 3 * 26)
  expect(m).toMatchObject({ atEnd: true, wholeLines: true, lastInSight: true, cut: 0 })
  return held
}

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the AI chat\'s box on Home grows with the words, then shows its last whole lines; also with the keyboard up', async ({ page }) => {
    await reset(page)
    await live(page)
    await signIn(page)
    const composer = page.getByTestId('composer')
    await composer.getByTestId('composer-input').fill('my draft')
    const held = await recordLong(page, composer, 'composer-text-held', 'phone-home-chat')
    // the keyboard up (a window as tall as what is above it): still the last whole lines
    await page.setViewportSize({ width: 390, height: 460 })
    await expect.poll(async () => measure(held)).toMatchObject({ atEnd: true, wholeLines: true, lastInSight: true, cut: 0 })
    if (SHOTS) {
      // (a screenshot right after the window changed comes out greyed)
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${SHOTS}/phone-home-chat-keyboard.png` })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => measure(held)).toMatchObject({ atEnd: true, wholeLines: true, lastInSight: true, cut: 0 })
    // ✓: the words in the box, which keeps its height
    const tall = (await held.boundingBox())!.height
    await composer.getByRole('button', { name: '녹음 끝내기' }).click()
    await expect(page.getByTestId('voice-bar')).toHaveCount(0)
    await expect(page.getByTestId('composer-input')).toHaveValue(new RegExp(`^my draft ${WORDS.replace(/[.?]/g, '\\$&')}`))
    const input = page.getByTestId('composer-input')
    expect(Math.abs((await input.boundingBox())!.height - tall)).toBeLessThan(26)
    // its newest words in sight, as they were
    await expect.poll(() => input.evaluate((ta) => ta.scrollHeight - ta.clientHeight - ta.scrollTop)).toBeLessThanOrEqual(1)
  })

  test('the AI chat\'s box in a chat (the bar under the text) grows with the words', async ({ page }) => {
    await reset(page)
    await live(page)
    await signIn(page)
    await page.getByTestId('composer-input').fill('first question')
    await page.getByTestId('send').click()
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
    await recordLong(page, page.getByTestId('composer'), 'composer-text-held', 'phone-chat')
  })

  test('a room\'s box grows with the words above the bar', async ({ page }) => {
    await reset(page)
    await live(page)
    await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    await recordLong(page, page.getByTestId('room-composer'), 'room-text-held', 'phone-room')
  })
})

test.describe('a computer', () => {
  test('the AI chat\'s box grows with the words', async ({ page }) => {
    await reset(page)
    await live(page)
    await signIn(page)
    await recordLong(page, page.getByTestId('composer'), 'composer-text-held', 'desktop-chat')
  })

  test('a room\'s box grows with the words', async ({ page }) => {
    await reset(page)
    await live(page)
    await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    await recordLong(page, page.getByTestId('room-composer'), 'room-text-held', 'desktop-room')
  })

  test('the ✦ side chat\'s box grows with the words', async ({ page }) => {
    await reset(page)
    await live(page)
    await routeRoom(page, { members: [{ id: 'sora', name: '소라님' }], messages: [] })
    await signIn(page)
    await page.goto(`/rooms/${ROOM_ID}`)
    await page.getByTestId('room-side-chat-button').click()
    await recordLong(page, page.getByTestId('room-side-chat').getByTestId('side-chat-box'), 'side-chat-text-held', 'desktop-side-chat')
  })
})
