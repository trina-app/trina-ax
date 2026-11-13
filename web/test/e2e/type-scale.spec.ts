// The type scale on every main screen (docs/DESIGN-SYSTEM.md "Typography"; docs/DECISIONS.md "Settings rows: one
// component, the lists' sizes"), at a phone's 390px and a computer's 1440px: a list row's name is 15px on a computer and
// 16px on a phone (text-row) in every list, Settings and Admin included (a setting's name too); a row's second line, a
// setting's line, hints and times are 13px (text-meta, text-xs); body text is 15px (text-sm); nothing reads under 12px
// but a badge. A screen whose rows or body leave the scale fails here, so the next one-off size is caught in CI.
// (The full sweep of every view is web/scripts/type-audit.ts against a test server.)
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { openRail, reset, signIn } from './helpers'
import { routeRoom } from './rooms-mock'

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
  const row = phone ? 16 : 15
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

// The rail's five panels at 1440 (docs/DECISIONS.md "Lists: one set of rows and headers"): 트리나's 고정 · 최근 기록 rows
// (nav/ChatItem.tsx, a ListRow) read at the other panels' row size, line height and height, its section headers at
// theirs, and the trailing tags (a chat's project, a task's last run) are 13px, end at one edge on every row and never
// take more than 40% of the row.
test('panel rows at 1440px: 트리나\'s rows, headers and tags read as 대화, 프로젝트, 파일 and 활동\'s', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page)
  await signIn(page)
  await routeNotices(page)
  await routeRoom(page, { members: [{ id: 'minjun', name: '민준' }] })
  const post = (url: string, data: unknown = {}) => page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  const made = async (url: string, data: unknown) => ((await (await post(url, data)).json()) as { id: string }).id
  const projects: Record<string, string> = {}
  for (const name of ['acme-web', 'Hello', 'ops']) projects[name] = await made('/api/projects', { name, scope: 'team', instructions: '' })
  await post(`/api/chats/${await made('/api/chats', { title: 'Pinned plan' })}/pin`)
  await made('/api/chats', { title: 'Short one', projectId: projects['acme-web'] })
  await made('/api/chats', { title: 'A much longer chat title that has to be cut somewhere', projectId: projects.Hello })
  await made('/api/chats', { title: 'Notes', projectId: projects.ops })
  expect((await page.request.post('/__test/schedule', { data: { title: '아침 요약', runs: 2 } })).ok()).toBeTruthy()
  await page.reload()
  type Look = { size: string; weight: string; lh: string; height: number }
  // `box`: what the height is measured on (a row's link; a header's row)
  const look = (sel: string, box: string) => page.locator(sel).first().evaluate((el, box) => {
    const s = getComputedStyle(el)
    return { size: s.fontSize, weight: s.fontWeight, lh: s.lineHeight, height: Math.round(el.closest(box)!.getBoundingClientRect().height) }
  }, box)
  // a row's name: the ListRow's name span, or a room's link that carries the name's look itself (nav/RoomsList.tsx)
  const rowName = '#rail-panel li > a .text-row, #rail-panel li > a.text-row'
  const head = '#rail-panel section[aria-labelledby] > div > h3'
  const looks: Record<string, { row: Look; head?: Look }> = {}
  for (const item of ['chats', 'projects', 'files', 'activity', 'ai'] as const) {
    await openRail(page, item)
    await expect(page.locator(rowName).first()).toBeVisible()
    looks[item] = { row: await look(rowName, 'a'), head: (await page.locator(head).count()) ? await look(head, 'div') : undefined }
  }
  const ai = looks.ai!
  for (const item of ['chats', 'projects', 'files', 'activity']) {
    const o = looks[item]!
    expect({ size: ai.row.size, lh: ai.row.lh }, `트리나's row against ${item}'s`).toEqual({ size: o.row.size, lh: o.row.lh })
    if (o.head) expect(ai.head, `트리나's section header against ${item}'s`).toEqual(o.head)
  }
  // a read row: 15px at 400 in a 30px row, as 파일's
  expect(ai.row).toEqual({ ...looks.files!.row, weight: '400' })
  expect(ai.row.height).toBe(30)
  // every row of 트리나's list is one height; a tag ends at the row's edge, 13px, at most 40% of its row
  const list = page.getByTestId('trina-list')
  const heights = await list.locator('li > a').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))
  expect(new Set(heights)).toEqual(new Set([30]))
  const tags = await list.locator('[data-testid="chat-row-project"], [data-testid="task-runs-row"] .text-meta').evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect(), row = e.closest('a')!.getBoundingClientRect()
    return { right: Math.round(r.right), share: r.width / row.width, size: getComputedStyle(e).fontSize, text: e.textContent }
  }))
  // grouped by project (QA TC-1080): the projects are headers, so a row's tag is only the task's time; the headers
  // are the section headers' look
  expect(tags.length).toBe(1)
  await expect(list.getByTestId('history-group-name')).toHaveText(['ops', 'Hello', 'acme-web'])
  expect(await list.getByTestId('history-group-head').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))).toEqual([30, 30, 30, 30])
  expect(new Set(tags.map((x) => x.right)).size, JSON.stringify(tags)).toBe(1)
  for (const x of tags) {
    expect(x.size).toBe('13px')
    expect(x.share).toBeLessThanOrEqual(0.41)
  }
})
