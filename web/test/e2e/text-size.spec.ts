// 글자 크기 (Settings > Profile, lib/textSize.ts), like a phone's Text Size: the slider sets the page's root font size at
// once, the account keeps it (a reload, and a browser that forgot it, show it again), 기본 takes it back, and the largest
// step leaves a 390px phone with nothing sideways.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { ko } from '../../src/i18n/ko'
import { DICTS } from '../../src/i18n'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { openDrawer, tabBar } from './nav'

const rootSize = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)
/** the PATCH that saves the size to the account */
const saved = (page: Page, size: string) => page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/me') && (r.request().postData() ?? '').includes(`"textSize":"${size}"`))

test('the largest step grows the whole page, stays after a reload and in the account, and 기본 brings it back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  expect(await rootSize(page)).toBe('16px')
  const sidebarText = await page.getByTestId('new-chat').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

  await page.goto('/settings/profile')
  const slider = page.getByRole('slider', { name: ko['settings.textSize'] })
  await expect(slider).toHaveValue('1')
  await expect(slider).toHaveAttribute('aria-valuetext', ko['settings.textSize.default'])
  await slider.focus()
  const largest = saved(page, 'largest')
  await page.keyboard.press('End')
  await expect(slider).toHaveAttribute('aria-valuetext', ko['settings.textSize.largest'])
  await expect(page.getByTestId('text-size-sample')).toContainText(ko['settings.textSize.largest'])
  await expect.poll(() => rootSize(page)).toBe('22.4px')
  expect((await largest).ok()).toBe(true)

  // the page around it follows (rem sizes), not only Settings; the message box under the dialog measured itself again,
  // so its placeholder is not cut
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('new-chat')).toBeVisible()
  expect(await page.getByTestId('new-chat').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(sidebarText * 1.4, 1)
  expect(await page.getByTestId('composer-input').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)

  await page.reload()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  expect(await rootSize(page)).toBe('22.4px')
  // a browser that forgot it (another device): the account brings it back
  await page.evaluate(() => localStorage.removeItem('mycel.textSize'))
  await page.reload()
  await expect(page.getByTestId('composer-input')).toBeVisible()
  await expect.poll(() => rootSize(page)).toBe('22.4px')

  // 기본: no reset button, the step itself
  await page.goto('/settings/profile')
  await expect(slider).toHaveValue('4')
  const back = saved(page, 'default')
  await slider.fill('1')
  await expect(slider).toHaveAttribute('aria-valuetext', ko['settings.textSize.default'])
  await expect.poll(() => rootSize(page)).toBe('16px')
  expect((await back).ok()).toBe(true)
  expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('')
  expect(await page.evaluate(() => localStorage.getItem('mycel.textSize'))).toBeNull()
  await page.reload()
  await expect(slider).toHaveValue('1')
  expect(await rootSize(page)).toBe('16px')

  // the control itself passes the accessibility check
  const r = await new AxeBuilder({ page }).include('[data-testid="text-size"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(r.violations.map((v) => v.id)).toEqual([])
})

test('a drag shows the size in the line under the slider, and the page takes it when the slider is let go', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/settings/profile')
  const slider = page.getByTestId('text-size')
  await slider.scrollIntoViewIfNeeded()
  const sample = page.getByTestId('text-size-sample')
  const sampleSize = () => sample.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const before = await sampleSize()
  const box = (await slider.boundingBox())!
  const y = box.y + box.height / 2
  // the thumb of 기본 (the second of five steps), dragged to the end
  await page.mouse.move(box.x + box.width / 4, y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width / 4 + (box.width * 3 / 4) * i / 10, y)
  await expect(sample).toContainText(ko['settings.textSize.largest'])
  expect(await rootSize(page)).toBe('16px')
  expect(await sampleSize()).toBeCloseTo(before * 1.4, 0)
  const save = saved(page, 'largest')
  await page.mouse.up()
  await expect.poll(() => rootSize(page)).toBe('22.4px')
  expect(await sampleSize()).toBeCloseTo(before * 1.4, 0)
  expect((await save).ok()).toBe(true)
})

test('the sign-in screen shows this browser\'s size before the first paint', async ({ page }) => {
  await reset(page)
  await page.addInitScript(() => localStorage.setItem('mycel.textSize', 'larger'))
  await page.goto('/login')
  await expect(page.getByTestId('login-username')).toBeVisible()
  expect(await rootSize(page)).toBe('20px')
})

test.describe('on a 390px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  /** what goes sideways: the page, a box that scrolls sideways without meaning to (a list, a page's own scroll), or text
   * past the screen's edge; a row made to scroll sideways (tabs with edge-fade, a wide table) may */
  const sideways = (page: Page) => page.evaluate(() => {
    const W = window.innerWidth
    const out: string[] = []
    const onPurpose = (el: Element) => /(^|\s)(overflow-x-(auto|scroll)|edge-fade)(\s|$)/.test(el.getAttribute('class') ?? '')
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}"`
    if (document.documentElement.scrollWidth > W + 1) out.push(`page ${document.documentElement.scrollWidth}px wide`)
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || r.right <= 0 || r.left >= W) continue
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1 && !onPurpose(el)) out.push(`${name(el)} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`)
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) continue
      if (r.right <= W + 1 && r.left >= -1) continue
      let scrolls = false
      for (let p = el.parentElement; p && !scrolls; p = p.parentElement) scrolls = onPurpose(p)
      if (!scrolls) out.push(`${name(el)} at ${Math.round(r.left)}..${Math.round(r.right)}`)
    }
    return out
  })

  test('the largest step puts nothing past the screen\'s edge', async ({ page }) => {
    await reset(page)
    await page.addInitScript(() => localStorage.setItem('mycel.textSize', 'largest'))
    await signIn(page)
    expect(await rootSize(page)).toBe('22.4px')
    for (const [path, ready] of [['/', 'composer-input'], ['/rooms', 'rooms-page'], ['/files', 'content-search-input'], ['/settings', 'settings-dialog'], ['/settings/profile', 'text-size'], ['/admin/members', 'members-list']] as const) {
      await page.goto(path)
      await expect(page.getByTestId(ready)).toBeVisible()
      await page.waitForTimeout(300)
      expect(await sideways(page), path).toEqual([])
    }
    // the phone's tabs keep their names whole
    for (const tab of ['tab-ai', 'tab-chats', 'tab-projects', 'tab-me']) {
      const fits = await page.getByTestId(tab).evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth)
      expect(fits, tab).toBe(true)
    }
    // the drawer
    await page.goto('/')
    await openDrawer(page)
    await expect(page.getByRole('dialog', { name: ko['sidebar.label'] })).toBeVisible()
    expect(await sideways(page), 'drawer').toEqual([])
  })
})

// the tab bar's labels in the languages with the longest words ("Proyectos", "プロジェクト"; QA TC-255), at the largest
// step (140 %) on a 360 px phone: each on one line inside its tab (cut with "…" if it must be), the whole word still
// the tab's name, nothing past the screen's edge
test.describe('the tab labels on a 360px phone at 140 %', () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true })
  for (const locale of ['ja', 'es'] as const) {
    test(`${locale}: four labels, each on one line inside its tab`, async ({ page }) => {
      const t = DICTS[locale]
      await reset(page, { teamLocale: locale, usersFollowTeam: true })
      await page.addInitScript(() => localStorage.setItem('mycel.textSize', 'largest'))
      await signIn(page)
      await page.goto('/projects')
      await expect(page.getByTestId('projects-team-folder-row')).toBeVisible()
      expect(await rootSize(page)).toBe('22.4px')
      const tabs = tabBar(page)
      await expect(tabs.getByRole('link')).toHaveCount(4)
      for (const [id, word] of [['tab-ai', PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName], ['tab-chats', t['tabs.chats']], ['tab-projects', t['tabs.projects']], ['tab-me', t['tabs.me']]] as const) {
        const link = tabs.getByTestId(id)
        // the whole word is the tab's name, however much of it shows
        await expect(link).toHaveAccessibleName(new RegExp(word))
        const m = await link.getByTestId('bottom-tab-label').evaluate((el) => {
          const r = el.getBoundingClientRect()
          const tab = el.closest('a')!.getBoundingClientRect()
          const s = getComputedStyle(el)
          return { lines: Math.round(r.height / parseFloat(s.lineHeight)), wrap: s.whiteSpace, left: r.left, right: r.right, tabLeft: tab.left, tabRight: tab.right, W: window.innerWidth }
        })
        expect(m.lines, `${locale} ${id}`).toBe(1)
        expect(m.wrap).toBe('nowrap')
        expect(m.left, `${locale} ${id}`).toBeGreaterThanOrEqual(m.tabLeft - 0.5)
        expect(m.right, `${locale} ${id}`).toBeLessThanOrEqual(m.tabRight + 0.5)
        expect(m.tabRight).toBeLessThanOrEqual(m.W + 0.5)
      }
      // the four tabs share the bar evenly (a long word does not widen its tab)
      const widths = await tabs.getByRole('link').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)))
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
    })
  }
})
