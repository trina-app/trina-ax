// The icons under an answer (copy, retry, save as a skill, the model) sit as one compact group from the left on every
// width: on a phone each button is a 44 × 44 px tap box (docs/DECISIONS.md "Phones: 44 px targets") and the boxes touch,
// no gap, so the icons stand 44 px apart, the closest a 44 px target allows (they stood 56 px apart: 44 + a 12 px gap).
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
  // the tap area of each button, as phone-targets.spec.ts counts it: how far from its middle a tap still lands on it
  const taps = await answer.getByTestId('answer-actions').evaluate((row) =>
    [...row.querySelectorAll('button')]
      .filter((b) => b.getBoundingClientRect().width > 2)
      .map((b) => {
        const r = b.getBoundingClientRect()
        const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2]
        const on = (x: number, y: number) => { const e = document.elementFromPoint(x, y); return !!e && (e === b || b.contains(e)) }
        const reach = (dx: number, dy: number) => { let n = 0; while (n < 30 && on(cx + dx * (n + 1), cy + dy * (n + 1))) n++; return n }
        return { w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1 }
      }),
  )
  return { boxes, pitch, gaps, taps }
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
  console.log(`answer actions ${width} ${scheme}: ${JSON.stringify({ widths: m.boxes.map((b) => Math.round(b.w)), heights: m.boxes.map((b) => Math.round(b.h)), pitch: m.pitch.map(Math.round), gaps: m.gaps.map(Math.round), taps: m.taps })}`)
  await ctx.close()
  return m
}

test('the icons under an answer are a compact group on a phone, spaced like the desktop, with 44 px tap targets', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const desk = await at(browser, 1440, scheme)
    const phone = await at(browser, 390, scheme)
    expect(desk.boxes.length).toBeGreaterThanOrEqual(3)
    expect(phone.boxes.length).toBe(desk.boxes.length)
    // the gap between two buttons on a phone: none past the 44 px tap boxes, never more than the desktop's
    const deskGap = Math.max(...desk.gaps)
    for (const g of phone.gaps) expect(g).toBeLessThanOrEqual(Math.min(deskGap, 1))
    // icon centre to icon centre: 44 px, the closest a 44 px target allows (was 56)
    for (const p of phone.pitch) expect(p).toBeLessThanOrEqual(44.5)
    // the group starts at the answer's left and ends well before the right edge
    const last = phone.boxes.at(-1)!
    expect(last.x + last.w).toBeLessThan(390 / 2 + 60)
    // touch targets: each button takes taps from 44 × 44 px on a phone (phone-targets.spec.ts allows a pixel for rounding)
    for (const t of phone.taps) {
      expect(t.w).toBeGreaterThanOrEqual(43)
      expect(t.h).toBeGreaterThanOrEqual(43)
    }
  }
})
