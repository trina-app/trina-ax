// Lists, Search and Settings open at once (docs/DECISIONS.md "Lists, Search and Settings open at once"): going back to
// 팀 스킬, 예약 작업, Settings › Connectors and Notifications, 활동 and 멘션 shows what was there with no loading
// placeholder, and reads each list at most once behind it. Search opened again soon after reads none of its lists again.
// The places are opened as a click does (an in-app navigation), at 1440 and 390.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { isPhone, openPlace } from './nav'

test.use({ serviceWorkers: 'block' })

/** the GET /api/... requests from here on */
function track(page: Page) {
  const log: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.startsWith('/api/') && r.method() === 'GET') log.push(u.pathname + u.search)
  })
  return log
}
/** count every loading placeholder that shows from now on (the skeleton; 활동 panel's spinner) */
const watchSkeleton = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __sk: string[] }
    w.__sk = []
    const look = () => {
      const el = document.querySelector('.animate-pulse, [data-testid="activity-panel"] .animate-spin')
      if (el) w.__sk.push(el.outerHTML.slice(0, 160))
    }
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true })
    look()
  })
const skeletons = (page: Page) => page.evaluate(() => (window as unknown as { __sk: string[] }).__sk)
/** an in-app navigation, as a click on a link does */
const go = (page: Page, url: string) => page.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate', { state: {} })) }, url)
/** no placeholder for a moment, after the reads behind it came back */
async function settled(page: Page) {
  await expect(page.locator('.animate-pulse')).toHaveCount(0, { timeout: 10_000 })
  await page.waitForTimeout(700)
}

/** the places and the lists each reads (each at most once on a visit after the first) */
const PLACES = (phone: boolean): { name: string; url: string; lists: RegExp[] }[] => [
  { name: '팀 스킬', url: '/skills', lists: [/^\/api\/skills\/overview$/, /^\/api\/skills\/suggestions\?scope=mine/, /^\/api\/skills\?shadowed=1/, /^\/api\/skills\/issues$/] },
  { name: '예약 작업', url: '/scheduled', lists: [/^\/api\/schedules$/] },
  { name: 'Connectors', url: '/settings/connectors', lists: [/^\/api\/integrations$/, /^\/api\/integrations\/google-apps$/, /^\/api\/integration-templates$/, /^\/api\/me\/credentials$/] },
  { name: 'Notifications', url: '/settings/notifications', lists: [/^\/api\/notification-preferences$/, /^\/api\/me\/credentials$/] },
  { name: '멘션', url: '/activity?in=chats&tab=mentions', lists: [/^\/api\/notifications\?limit=\d+&only=rooms$/] },
  ...(phone ? [{ name: '활동', url: '/activity', lists: [/^\/api\/notifications\?limit=\d+$/] }] : []),
]

for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
  test(`going back to the lists and Settings at ${vp.w}: what was there at once, each read at most once behind it`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: vp.w, height: vp.h })
    await reset(page)
    const log = track(page)
    await signIn(page)
    const phone = isPhone(page)
    const places = PLACES(phone)
    // the first visits read the lists (and may show the placeholder)
    for (const p of places) {
      await go(page, p.url)
      await settled(page)
    }
    if (!phone) {
      await openPlace(page, 'activity')
      await expect(page.getByTestId('activity-panel')).toBeVisible()
      await settled(page)
    }
    for (const p of places) {
      await go(page, '/')
      await settled(page)
      const before = log.length
      await watchSkeleton(page)
      await go(page, p.url)
      await settled(page)
      expect(await skeletons(page), `${p.name}: no loading placeholder on a visit after the first`).toEqual([])
      const reads = log.slice(before)
      for (const re of p.lists) expect(reads.filter((u) => re.test(u)).length, `${p.name}: ${re} read at most once`).toBeLessThanOrEqual(1)
    }
    if (!phone) {
      // 활동 beside the rail: its list at once
      await openPlace(page, 'trina')
      await settled(page)
      await watchSkeleton(page)
      await openPlace(page, 'activity')
      await expect(page.getByTestId('activity-panel')).toBeVisible()
      await settled(page)
      expect(await skeletons(page), '활동: no spinner on a visit after the first').toEqual([])
    }
  })
}

test('Search opened again soon after reads none of its lists again (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  const log = track(page)
  await signIn(page)
  await settled(page)
  const LISTS = [/^\/api\/chats\?limit=30$/, /^\/api\/projects$/, /^\/api\/skills$/, /^\/api\/schedules$/, /^\/api\/integrations$/, /^\/api\/notifications\?limit=1$/]
  const open = async () => {
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('search-palette')).toBeVisible()
    await page.waitForTimeout(700)
  }
  await open()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('search-palette')).toHaveCount(0)
  const before = log.length
  await open()
  const reads = log.slice(before)
  for (const re of LISTS) expect(reads.filter((u) => re.test(u)), `${re} not read again`).toEqual([])
  // what it shows came from the first open: the actions and the lists are there
  await expect(page.getByTestId('search-palette').getByRole('option').first()).toBeVisible()
})
