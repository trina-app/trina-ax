// Web addresses in people's room messages, in the browser (components/rooms/MessageText.tsx): a link opens another site
// in a new tab without the referrer, a link to this team's app moves inside the app (no reload), a mention beside a link
// stays a mention, the keyboard shows the focus ring, a long address wraps at its slashes on a phone without widening
// the page, and copy and edit take the text as it was written. The room is answered through page.route (rooms-mock.ts).
// SHOTS_DIR=<folder>: the screenshots of a room with links (1440 and 390, light and dark) go there.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const OLGA = { id: 'olga', name: 'Olga' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`
const ARTIFACT = 'https://example.com/artifact/7A3N9vnbqnmBQiAeRtBPCx'
const MINE = 'https://example.com/a에서 확인했어요. javascript:alert(1)'

async function openRoom(page: Page) {
  await reset(page)
  const origin = new URL(test.info().project.use.baseURL!).origin
  const room = await routeRoom(page, {
    members: [SORA],
    messages: [
      { id: id(1), author: SORA, body: `${ARTIFACT} this one report for the team` },
      { id: id(2), author: SORA, body: `@Olga 가이드는 (www.example.org/guide) 참고하시고, 스레드는 여기요: ${origin}/rooms/${ROOM_ID}/t/${id(1)}`, mentions: ['olga'] },
      // my answer quotes the first message (an older reply, or one an AI app sent): its address is a link there too
      { id: id(3), author: OLGA, body: MINE, extra: { replyTo: { id: id(1), author: SORA, excerpt: `${ARTIFACT} this one report for the team`, fileCount: 0, deleted: false } } },
    ],
  })
  await page.context().route('https://example.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>example</title>ok' }))
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(3)
  return room
}

test('another site opens in a new tab without the referrer; a mention beside a link stays a mention', async ({ page }) => {
  await openRoom(page)
  const first = page.getByTestId('room-message').nth(0).getByTestId('room-link')
  await expect(first).toHaveAttribute('href', ARTIFACT)
  await expect(first).toHaveAttribute('target', '_blank')
  await expect(first).toHaveAttribute('rel', 'noopener noreferrer nofollow')
  await expect(first).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect(first).toHaveText(ARTIFACT)
  const second = page.getByTestId('room-message').nth(1)
  await expect(second.locator('span.text-accent-text', { hasText: '@Olga' })).toBeVisible()
  // the bracket and the comma of the sentence are not part of the link; www. opens as https
  await expect(second.getByTestId('room-link').first()).toHaveAttribute('href', 'https://www.example.org/guide')
  await expect(second.getByTestId('room-link').first()).toHaveText('www.example.org/guide')
  // the accent colour, underlined; the mention is the same colour without the line
  const look = await second.getByTestId('room-link').first().evaluate((e) => ({ color: getComputedStyle(e).color, line: getComputedStyle(e).textDecorationLine }))
  const mention = await second.locator('span.text-accent-text').first().evaluate((e) => ({ color: getComputedStyle(e).color, line: getComputedStyle(e).textDecorationLine }))
  expect(look).toEqual({ color: mention.color, line: 'underline' })
  expect(mention.line).toBe('none')
  const [popup] = await Promise.all([page.waitForEvent('popup'), first.click()])
  await popup.waitForLoadState()
  expect(popup.url()).toBe(ARTIFACT)
  // no referrer reached the other site
  expect(await popup.evaluate(() => document.referrer)).toBe('')
  await popup.close()
  // javascript: in my message is text
  await expect(page.getByTestId('room-message').nth(2).locator('p').getByTestId('room-link')).toHaveCount(1)
})

test("a quote's link sits above the quote's jump: the link opens the site, the rest of the quote goes to the message", async ({ page }) => {
  await openRoom(page)
  const quote = page.getByTestId('room-message').nth(2).getByTestId('message-quote')
  const link = quote.getByTestId('room-link')
  await expect(link).toHaveAttribute('href', ARTIFACT)
  await expect(link).toHaveAttribute('target', '_blank')
  // what is under the pointer: the link over its own text, the jump button over the name
  const hit = (l: typeof link) => l.evaluate((e) => { const r = e.getBoundingClientRect(); return document.elementFromPoint(r.left + 8, r.top + r.height / 2)?.getAttribute('data-testid') ?? null })
  expect(await hit(link)).toBe('room-link')
  expect(await hit(quote.locator('span').first())).toBe('message-quote-jump')
  await expect(quote.getByTestId('message-quote-jump')).toHaveAccessibleName(/소라님/)
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()])
  expect(popup.url()).toBe(ARTIFACT)
  await popup.close()
  // the name: to the quoted message, which lights up
  await quote.getByTestId('message-quote-jump').click({ position: { x: 12, y: 6 } })
  await expect(page.getByTestId('room-message').nth(0)).toHaveClass(/bg-accent-soft/)
})

test('a link to this team app moves inside the app, without a reload; the keyboard shows its focus ring', async ({ page }) => {
  await openRoom(page)
  const link = page.getByTestId('room-message').nth(1).getByTestId('room-link').nth(1)
  await expect(link).toHaveAttribute('href', `/rooms/${ROOM_ID}/t/${id(1)}`)
  await expect(link).not.toHaveAttribute('target', /.*/)
  // keyboard focus: the ring
  await page.keyboard.press('Shift')
  await link.focus()
  expect(await link.evaluate((e) => [e.matches(':focus-visible'), getComputedStyle(e).outlineStyle])).toEqual([true, 'solid'])
  await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true))
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM_ID}/t/${id(1)}$`))
  await expect(page.getByTestId('room-thread')).toBeVisible()
  // the thread's messages have their links too
  await expect(page.getByTestId('room-thread').getByTestId('room-link')).toHaveAttribute('href', ARTIFACT)
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true)
})

test('copy and edit take the message as it was written', async ({ page }) => {
  await openRoom(page)
  const mine = page.getByTestId('room-message').nth(2)
  await mine.hover()
  await mine.getByTestId('message-more').click()
  await page.getByTestId('message-copy').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MINE)
  await mine.hover()
  await mine.getByTestId('message-more').click()
  await page.getByTestId('message-edit').click()
  await expect(page.getByTestId('room-edit-input')).toHaveValue(MINE)
})

test('phones: a long address wraps at its slashes and never widens the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openRoom(page)
  const link = page.getByTestId('room-message').nth(0).getByTestId('room-link')
  const lay = await link.evaluate((a) => {
    const pieces = [...a.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => {
      const r = document.createRange()
      r.selectNodeContents(n)
      return { text: n.textContent, lines: new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size }
    })
    return { lines: new Set([...a.getClientRects()].map((x) => Math.round(x.top))).size, pieces, wide: document.documentElement.scrollWidth > innerWidth }
  })
  expect(lay.wide).toBe(false)
  expect(lay.lines).toBeGreaterThan(1)
  // every piece between two slashes stays on one line
  expect(lay.pieces.map((p) => p.text).join('')).toBe(ARTIFACT)
  expect(lay.pieces.every((p) => p.lines === 1)).toBe(true)
  // a quote is one line cut with "…": its address does not break there
  const excerpt = page.getByTestId('room-message').nth(2).getByTestId('message-quote').locator('span').nth(1)
  expect(await excerpt.evaluate((e) => Math.round(e.getBoundingClientRect().height))).toBeLessThan(24)
})

test('screenshots of a room with links (SHOTS_DIR)', async ({ page }) => {
  const dir = process.env.SHOTS_DIR
  test.skip(!dir, 'only with SHOTS_DIR')
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width, height })
      await openRoom(page)
      await page.mouse.move(0, height - 1)
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${dir}/room-links-${width}-${scheme}.png` })
    }
  }
})
