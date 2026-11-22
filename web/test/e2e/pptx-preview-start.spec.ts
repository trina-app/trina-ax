// A PowerPoint preview shows every slide, from slide 1 (owner 2026-11-22: a 12-slide deck began at slide 9 in a chat's
// file panel and at slide 5 in Files; the view was at the top, slides 1-8 were not drawn). The preview draws again when
// the panel's width changes; a drawing still on its way emptied the next one's first batches of 4 slides
// (web/src/lib/renderHost.ts). Needs pandoc to make the deck; skipped without it.
import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { reset, signIn } from './helpers'

let dir = ''
let deck = ''
let notes = ''
const SHOTS = process.env.SHOTS_DIR

test.beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mycel-pptx-start-'))
  deck = path.join(dir, 'company-deck.pptx')
  const md = ['% Company deck (draft)', '', ...Array.from({ length: 11 }, (_, i) => `## Slide ${i + 2} title\n\n- point ${i + 2}\n`)].join('\n')
  notes = path.join(dir, 'notes.md')
  writeFileSync(notes, Array.from({ length: 80 }, (_, i) => `line ${i + 1}\n`).join('\n'))
  try { execFileSync('pandoc', ['-f', 'markdown', '-t', 'pptx', '-o', deck], { input: md, timeout: 20_000 }) } catch { deck = '' }
})
test.afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const open = async (page: Page, name: string) => {
  await page.getByTestId('file-row').filter({ hasText: name }).getByRole('button').first().click()
  return page.getByTestId('file-panel')
}

/** The slides in the panel, in order: their numbers and whether the first one's top is in view at the top. */
async function expectFromSlideOne(panel: Locator) {
  const slides = panel.locator('[data-slide-index]')
  await expect(slides).toHaveCount(12, { timeout: 15_000 })
  await expect.poll(() => slides.evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.slideIndex)))).toEqual(Array.from({ length: 12 }, (_, i) => i))
  await expect(slides.first()).toContainText('Company deck', { timeout: 15_000 })
  await expect(panel.locator('[data-slides]')).toHaveCount(1)
  await expect(panel.locator('[data-slides]')).toHaveAttribute('data-slides', '12')
  // at the top of its scroll box
  const top = await slides.first().evaluate((el) => {
    let box: HTMLElement | null = el.parentElement
    while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement
    return { scrollTop: box?.scrollTop ?? -1, inView: box ? el.getBoundingClientRect().top - box.getBoundingClientRect().top : -1 }
  })
  expect(top.scrollTop).toBe(0)
  expect(top.inView).toBeLessThan(60)
}

for (const vp of [{ width: 1440, height: 900, name: '1440' }, { width: 390, height: 844, name: '390' }]) {
  test(`${vp.name}: a deck the panel draws again while it is on its way still starts at slide 1, every slide drawn`, async ({ page }) => {
    test.skip(!deck, 'pandoc is needed to make the deck')
    await page.setViewportSize(vp)
    await reset(page, { teamLocale: 'en', usersFollowTeam: true })
    await signIn(page)
    await page.goto('/files?path=marketing')
    await page.getByTestId('files-input').setInputFiles([deck, notes])
    let panel = await open(page, 'company-deck.pptx')
    // the width changes while the slides are being added (the panel settling, the window resized): each change draws
    // the deck again; before the fix the deck began at slide 5 or 9
    for (let i = 0; i < 40; i++) {
      await page.setViewportSize({ width: vp.width - (i % 2) * 30 - (i % 7), height: vp.height })
      await page.waitForTimeout(i % 3 === 0 ? 10 : 25)
    }
    await page.setViewportSize(vp)
    await expectFromSlideOne(panel)
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `pptx-start-${vp.name}-files.png`) })

    // another file scrolled down, then the deck again: slide 1 at the top
    await page.goto('/files?path=marketing')
    panel = await open(page, 'company-deck.pptx')
    await expectFromSlideOne(panel)
    await panel.locator('[data-slide-index="9"]').scrollIntoViewIfNeeded()
    await page.goto('/files?path=marketing')
    panel = await open(page, 'notes.md')
    await expect(panel).toContainText('line 80')
    await panel.getByText('line 80').scrollIntoViewIfNeeded()
    // a computer shows the list beside the panel; a phone's panel covers it
    if (vp.width < 600) await page.goto('/files?path=marketing')
    panel = await open(page, 'company-deck.pptx')
    await expectFromSlideOne(panel)
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `pptx-start-${vp.name}-reopened.png`) })
  })
}
// a link that asks for a slide (an answer's source, &slide=N) still opens there: answer-sources.spec.ts
