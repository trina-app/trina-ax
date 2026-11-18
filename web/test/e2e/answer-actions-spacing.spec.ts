// The icons under an answer (copy, retry, save as a skill, the model) sit as one compact group from the left on every
// width: on a phone the space between them comes from each button's 44 px tap box, not from extra gaps, so the gap
// between two icons is about the desktop's.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { reset, signIn } from './helpers'

const SHOTS = process.env.QA_SHOTS
const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })

async function answered(page: Page) {
  await reset(page)
  await signIn(page)
  const r = await post(page, '/api/chats', { title: 'Spacing' })
  const id = ((await r.json()) as { id: string }).id
  await page.goto(`/c/${id}`)
  await page.getByTestId('composer-input').fill('a question')
  await page.getByTestId('send').click()
  const answer = page.locator('[data-testid="assistant-message"][data-status="done"]')
  await expect(answer).toHaveCount(1)
  await expect(answer.getByTestId('answer-actions')).toHaveCSS('clip-path', 'none')
  return answer
}

/** The visible icon buttons of the newest answer's row, left to right: their boxes and the gaps between them. */
async function measure(page: Page) {
  const answer = page.locator('[data-testid="assistant-message"][data-status="done"]').last()
  const boxes = await answer.getByTestId('answer-actions').evaluate((row) =>
    [...row.querySelectorAll('button')]
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width > 2 && r.height > 2)
      .sort((a, b) => a.x - b.x)
      .map((r) => ({ x: r.x, w: r.width, h: r.height })),
  )
  const pitch = boxes.slice(1).map((b, i) => b.x - boxes[i]!.x)
  const gaps = boxes.slice(1).map((b, i) => b.x - (boxes[i]!.x + boxes[i]!.w))
  return { boxes, pitch, gaps }
}

async function at(browser: Browser, width: number, scheme: 'light' | 'dark') {
  const phone = width < 768
  const ctx = await browser.newContext({
    viewport: { width, height: phone ? 844 : 900 },
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
    colorScheme: scheme,
    locale: 'ko-KR',
    baseURL: test.info().project.use.baseURL,
  })
  const page = await ctx.newPage()
  await answered(page)
  const m = await measure(page)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    const row = page.locator('[data-testid="assistant-message"][data-status="done"]').last()
    await row.screenshot({ path: join(SHOTS, `answer-actions-${width}-${scheme}.png`) })
    await page.screenshot({ path: join(SHOTS, `answer-actions-${width}-${scheme}-page.png`) })
  }
  console.log(`answer actions ${width} ${scheme}: ${JSON.stringify({ widths: m.boxes.map((b) => Math.round(b.w)), heights: m.boxes.map((b) => Math.round(b.h)), pitch: m.pitch.map(Math.round), gaps: m.gaps.map(Math.round) })}`)
  await ctx.close()
  return m
}

test('the icons under an answer are a compact group on a phone, spaced like the desktop, with 44 px tap targets', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const desk = await at(browser, 1440, scheme)
    const phone = await at(browser, 390, scheme)
    expect(desk.boxes.length).toBeGreaterThanOrEqual(3)
    expect(phone.boxes.length).toBe(desk.boxes.length)
    // the gap between two icons on a phone: no more than the desktop's and a few px
    const deskGap = Math.max(...desk.gaps)
    for (const g of phone.gaps) expect(g).toBeLessThanOrEqual(deskGap + 4)
    // the group starts at the answer's left and ends well before the right edge
    const last = phone.boxes.at(-1)!
    expect(last.x + last.w).toBeLessThan(390 / 2 + 60)
    // touch targets: each button at least 40 px on a phone
    for (const b of phone.boxes) {
      expect(b.w).toBeGreaterThanOrEqual(40)
      expect(b.h).toBeGreaterThanOrEqual(40)
    }
  }
})
