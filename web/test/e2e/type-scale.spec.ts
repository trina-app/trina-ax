// The type scale on every main screen (docs/DESIGN-SYSTEM.md "Typography"; docs/DECISIONS.md "Settings rows: one
// component, the lists' sizes"), at a phone's 390px and a computer's 1440px: a list row's name is 15px on a computer and
// 17px on a phone (text-row) in every list, Settings and Admin included (a setting's name too); a row's second line, a
// setting's line, hints and times are 13px (text-meta, text-xs); body text is 15px (text-sm); nothing reads under 12px
// but a badge. A screen whose rows or body leave the scale fails here, so the next one-off size is caught in CI.
// (The full sweep of every view is web/scripts/type-audit.ts against a test server.)
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const notice = (n: number, code: string, minutes: number, o: Record<string, unknown> = {}) =>
  ({ id: `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`, eventType: code, sourceId: `019a5f00-0000-7000-8000-${String(n + 1000).padStart(12, '0')}`, code, createdAt: ago(minutes), readAt: null, chatId: null, link: null, outcome: null, ...o })

/** notices for 활동 (the mock server lists none by itself) */
async function routeNotices(page: Page) {
  const items = [notice(1, 'connection.reconnect', 30, { link: 'connections' }), notice(2, 'team.joined', 50, { joined: { name: '민준' } }), notice(3, 'schedule.failure', 600, { readAt: ago(500), outcome: 'failed', schedule: { title: '아침 요약' } })]
  await page.route('**/api/notifications?*', (route) => {
    const only = new URL(route.request().url()).searchParams.get('only')
    return route.fulfill({ json: { items: only === 'rooms' ? [] : items, nextCursor: null, unreadCount: 2, roomUnreadCount: 0, noticeUnreadCount: 2 } })
  })
}

interface Off { screen: string; rule: string; px: number; text: string; cls: string; testid: string }

/** In the page: the visible texts of the top layer (an open dialog, else the page) that leave the scale. */
function offScale(phone: boolean): Omit<Off, 'screen'>[] {
  const layers = [...document.querySelectorAll('[role="dialog"]')].filter((d) => d.getBoundingClientRect().width > 2)
  const root = layers[layers.length - 1] ?? document.body
  const cls = (el: Element) => (el.getAttribute('class') ?? '')
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05 || s.clipPath === 'inset(50%)' || s.clip === 'rect(0px, 0px, 0px, 0px)') return false
    }
    return true
  }
  const row = phone ? 17 : 15
  const out: Omit<Off, 'screen'>[] = []
  const add = (rule: string, el: Element, px: number) => out.push({ rule, px, text: (el.textContent ?? '').trim().slice(0, 40), cls: cls(el).slice(0, 120), testid: el.closest('[data-testid]')?.getAttribute('data-testid') ?? '' })
  const px = (el: Element) => Number.parseFloat(getComputedStyle(el).fontSize)
  // a list row's name, and a setting's name and line
  for (const el of root.querySelectorAll('.text-row')) if (shown(el) && px(el) !== row) add(`row-name-not-${row}`, el, px(el))
  for (const el of root.querySelectorAll('[data-setting-name]')) if (shown(el) && px(el) !== row) add(`setting-name-not-${row}`, el, px(el))
  for (const el of root.querySelectorAll('[data-setting-desc]')) if (shown(el) && px(el) !== 13) add('setting-line-not-13', el, px(el))
  // meta and hints 13, body 15 (a field on a phone is 16 or more, against iOS's zoom)
  for (const el of root.querySelectorAll('.text-meta, .text-xs, .text-micro')) if (shown(el) && !el.closest('[aria-hidden="true"]') && px(el) !== 13) add('meta-not-13', el, px(el))
  for (const el of root.querySelectorAll('.text-sm')) if (shown(el) && !el.matches('input, textarea, select') && px(el) !== 15) add('body-not-15', el, px(el))
  // nothing under 12px but a badge (a picture drawn small, aria-hidden, is no text)
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement
    if (!el || !(n.textContent ?? '').trim() || el.closest('script,style,svg,[aria-hidden="true"],[data-badge]') || !shown(el)) continue
    if (px(el) < 12) add('under-12', el, px(el))
  }
  return out
}

const SCREENS = ['/', '/activity', '/rooms', '/files?path=marketing', '/projects', '/scheduled', '/skills', '/settings', '/settings/profile', '/settings/notifications', '/settings/connectors', '/settings/apps', '/settings/about', '/admin', '/admin/members', '/admin/settings', '/admin/connectors', '/admin/plugins']

for (const width of [390, 1440]) {
  test(`type scale at ${width}px: rows, settings, meta and body on the scale on every main screen`, async ({ page }) => {
    test.setTimeout(240_000)
    const phone = width < 768
    await page.setViewportSize({ width, height: phone ? 844 : 900 })
    await reset(page)
    await signIn(page)
    await routeNotices(page)
    const off: Off[] = []
    for (const screen of SCREENS) {
      await page.goto(screen)
      await expect(page.locator('main, [data-testid="app-layout"], #root > *').first()).toBeVisible()
      await page.waitForLoadState('networkidle')
      for (const o of await page.evaluate(offScale, phone)) off.push({ screen, ...o })
    }
    expect(off, off.map((o) => `${o.screen} ${o.rule} ${o.px}px [${o.testid}] "${o.text}" .${o.cls}`).join('\n')).toEqual([])
  })
}
