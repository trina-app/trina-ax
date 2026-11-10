// The computer's sidebar in a real browser (docs/DECISIONS.md "Desktop sidebar: rooms first"): its order, one labeled
// row each by keyboard (focus ring, the Inbox count on its row and in words), the team menu on top with Admin and
// Invite for owners and admins (docs/DECISIONS.md "The team menu"; no Admin row any more), both groups folded
// across a reload, 60 rooms in one scroll (대화 strictly capped at the five latest and the room on screen, "더 보기 (N)"
// with what is unread behind it, remembered; 트리나 기록's heading and first chats in sight below at 1440 and 1280), and "답변 필요" / the
// new-answer dot that come from the chat list (they survive a reload, and no request is made per chat).
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@mycel/shared'
import { CSRF_HEADER, PRODUCT_NAMED_AFTER_AI, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const side = (page: Page) => page.getByRole('navigation', { name: t['sidebar.label'] })
const top = async (page: Page, id: string) => (await side(page).getByTestId(id).boundingBox())!.y

function rooms(n: number) {
  const now = Date.now()
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(now - i * 60_000).toISOString()
    return {
      id: uuidv7(), kind: 'team', canRename: false, managerId: null, name: i === 0 ? '신제품 출시 태스크포스 (마케팅·디자인·영업·콘텐츠전략파트 합동) 2026 상반기' : `팀 ${i}`, groupId: uuidv7(), memberCount: 3,
      peers: [{ id: 'bob', name: 'Bob' }], unreadCount: i % 7 === 0 ? 2 : 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 2, muted: false, createdAt: at, activityAt: at,
      lastMessage: { id: uuidv7(), seq: 2, author: { id: 'bob', name: 'Bob' }, excerpt: '안녕하세요', fileCount: 0, deleted: false, createdAt: at },
    }
  })
}

async function someChats(page: Page, n: number) {
  for (let i = 1; i <= n; i++) expect((await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: { title: `채팅 ${i}` } })).ok()).toBeTruthy()
}

const ROWS = ['new-chat', 'nav-search', 'nav-projects', 'nav-scheduled', 'nav-inbox', 'nav-files', 'nav-skills'] as const
const BOB = { username: 'bob', password: 'bob password 1' }
const fontOf = (page: Page, id: string) => side(page).getByTestId(id).evaluate((e) => [getComputedStyle(e).fontSize, getComputedStyle(e).fontWeight])

test('in order: the team, one labeled row each, the rooms, then the AI chats', async ({ page }) => {
  await reset(page)
  await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: rooms(3) } }) : r.fallback()))
  await signIn(page)
  const s = side(page)
  await expect(s.getByTestId('sidebar-team')).toBeVisible()
  await expect(s.getByTestId('sidebar-team')).not.toHaveText(PRODUCT.displayName)
  const ids = ['sidebar-team', ...ROWS, 'sidebar-rooms', 'recents-toggle']
  const ys: number[] = []
  for (const id of ids) ys.push(await top(page, id))
  expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  await expect(s.getByTestId('recents-toggle')).toHaveText(t['sidebar.aiChats'].replace('{name}', ai))
  // each row says its name, 36 px high, the old order: 트리나에게 묻기, 검색, 프로젝트, 예약 작업, 알림함, 파일, 팀 스킬 (관리자
  // is in the team menu now)
  const said = (words: string, hint = false) => new RegExp(`^\\s*${words}${hint ? '' : '$'}`)
  await expect(s.getByTestId('nav-rows').locator(':scope > *')).toHaveText([
    said(t['sidebar.askAi'].replace('{name}', ai), true), said(t['sidebar.search'], true), said(t['sidebar.projects']), said(t['sidebar.scheduled']), said(t['inbox.title']), said(t['sidebar.files']), said(t['sidebar.skills']),
  ])
  await expect(s.getByTestId('nav-admin')).toHaveCount(0)
  for (const id of ROWS) expect(Math.round((await s.getByTestId(id).boundingBox())!.height)).toBe(36)
  await expect(s.getByRole('link', { name: t['sidebar.projects'], exact: true })).toHaveAttribute('href', '/projects')
  await expect(s.getByTestId('nav-icons')).toHaveCount(0)
})

test('the rows by keyboard: a focus ring on each; the Inbox has its count on the row, in words for a screen reader', async ({ page }) => {
  await reset(page)
  await page.route('**/api/notifications?*', (r) => r.fulfill({ json: { items: [], nextCursor: null, unreadCount: 3 } }))
  await signIn(page)
  const s = side(page)
  await expect(s.getByTestId('inbox-unread').locator('[aria-hidden="true"]')).toHaveText('3')
  await expect(s.getByTestId('nav-inbox')).toHaveAccessibleName(new RegExp(`^${t['inbox.title']}\\s*${t['notifications.unread'].replace('{count}', '3')}$`))
  await s.getByTestId('new-chat').focus()
  for (const id of ROWS.slice(1)) {
    await page.keyboard.press('Tab')
    const el = s.getByTestId(id)
    await expect(el).toBeFocused()
    expect(await el.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none')
  }
  // Enter opens it
  await s.getByTestId('nav-files').focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/files/)
  await expect(s.getByTestId('nav-files')).toHaveAttribute('aria-current', 'page')
})

test('a member: no Admin row, and the team on top is its name and logo, not a menu', async ({ page }) => {
  await reset(page)
  await signIn(page, BOB)
  const s = side(page)
  await expect(s.getByTestId('nav-rows').locator(':scope > *')).toHaveCount(7)
  await expect(s.getByTestId('nav-admin')).toHaveCount(0)
  await expect(s.getByTestId('team-header')).toBeVisible()
  await expect(s.getByTestId('team-menu')).toHaveCount(0)
  await expect(s.getByRole('button', { name: 'Acme' })).toHaveCount(0)
  await expect(s.getByText(t['sidebar.admin'], { exact: true })).toHaveCount(0)
  // a click on it does nothing: no menu, still on Home
  await s.getByTestId('team-header').click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/)
  // the same type sizes as an admin's
  expect(await fontOf(page, 'sidebar-team')).toEqual(['16px', '600'])
})

test('the team menu: the team on top opens it; an admin goes to Admin from it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.request.post('/__test/team-address', { data: { address: 'https://acme.trina.app' } })
  await page.reload()
  const s = side(page)
  const button = s.getByTestId('team-menu')
  await expect(button).toHaveAccessibleName('Acme')
  await expect(button).toHaveAttribute('aria-haspopup', 'menu')
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  // the top of the hierarchy, not louder than a page title: 16 px semibold over the 14 px rows (page titles are 20 px);
  // the logo 28 px, its middle in line with the rows' icons
  expect(await fontOf(page, 'sidebar-team')).toEqual(['16px', '600'])
  expect(await fontOf(page, 'nav-projects')).toEqual(['14px', '400'])
  const logo = (await s.getByTestId('sidebar-logo').boundingBox())!
  expect([logo.width, logo.height]).toEqual([28, 28])
  const icon = (await s.getByTestId('nav-projects').locator('svg').boundingBox())!
  expect(logo.x + logo.width / 2).toBe(icon.x + icon.width / 2)
  expect(Math.round((await button.boundingBox())!.height)).toBe(44)
  await expect(s.getByTestId('nav-admin')).toHaveCount(0)

  await button.click()
  const menu = page.getByRole('menu', { name: 'Acme' })
  await expect(menu).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.getByTestId('team-menu-name')).toHaveText('Acme')
  await expect(menu.getByTestId('team-menu-address')).toHaveText('acme.trina.app')
  await expect(menu.getByRole('menuitem')).toHaveText([t['teamMenu.invite'], t['sidebar.admin']])
  // nothing personal: those are in the profile menu at the bottom
  await expect(menu.getByText(t['sidebar.settings'])).toHaveCount(0)
  await expect(menu.getByText(t['auth.logout'])).toHaveCount(0)
  // inside the window, under the button, the sidebar's width less its padding
  const box = (await menu.boundingBox())!
  expect(box.y).toBeGreaterThan((await button.boundingBox())!.y)
  expect(box.x + box.width).toBeLessThanOrEqual((await s.boundingBox())!.width)
  expect((await new AxeBuilder({ page }).include('[data-testid="team-menu"]').include('[data-testid="team-dropdown"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()).violations).toEqual([])
  // a click outside closes it
  await page.getByTestId('composer-input').click()
  await expect(menu).toHaveCount(0)
  await button.click()
  await menu.getByRole('menuitem', { name: t['sidebar.admin'] }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('menu')).toHaveCount(0)
  // the way home is the first row (and ⇧⌘O): the header is the team, not a second home link
  await s.getByTestId('new-chat').click()
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/)
})

test('the team menu by keyboard: Enter opens it on its first item, arrows wrap, Esc closes it and gives the keyboard back', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const s = side(page)
  const button = s.getByTestId('team-menu')
  // reached by the keyboard (Shift+Tab from the first row): a focus ring
  await s.getByTestId('new-chat').focus()
  await page.keyboard.press('Shift+Tab')
  await expect(button).toBeFocused()
  expect(await button.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none')
  await page.keyboard.press('Enter')
  const invite = page.getByRole('menuitem', { name: t['teamMenu.invite'] })
  const admin = page.getByRole('menuitem', { name: t['sidebar.admin'] })
  await expect(invite).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(admin).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(invite).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(admin).toBeFocused()
  await page.keyboard.press('Home')
  await expect(invite).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  // Space opens it too; Enter on an item does it
  await page.keyboard.press('Space')
  await expect(invite).toBeFocused()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/admin$/)
})

test('팀원 초대 in the team menu opens the invite flow; closing it gives the keyboard back to the team button', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const s = side(page)
  await s.getByTestId('team-menu').click()
  await page.getByRole('menuitem', { name: t['teamMenu.invite'] }).click()
  const dialog = page.getByRole('dialog', { name: t['teamMenu.invite'] })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('invite-step')).toBeVisible()
  // the team invite link: made in one press, its message ready to copy
  await dialog.getByTestId('team-link-create').click()
  await expect(dialog.getByTestId('team-link-message')).toBeVisible()
  await dialog.getByTestId('invite-step-done').click()
  await expect(dialog).toHaveCount(0)
  await expect(s.getByTestId('team-menu')).toBeFocused()
  // Esc closes it as well
  await s.getByTestId('team-menu').click()
  await page.getByRole('menuitem', { name: t['teamMenu.invite'] }).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(s.getByTestId('team-menu')).toBeFocused()
})

test('⌘K finds 관리자 and 팀원 초대 for an admin (not listed before typing); a member finds neither', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const palette = page.getByTestId('search-palette')
  const box = palette.getByRole('combobox')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(box).toBeFocused()
  await expect(palette.getByTestId('search-section-actions').getByRole('option')).not.toHaveText([new RegExp(t['sidebar.admin'])])
  await expect(palette.getByRole('option', { name: t['teamMenu.invite'] })).toHaveCount(0)
  await box.fill(t['sidebar.admin'])
  await expect(palette.getByTestId('search-section-actions').getByRole('option', { name: t['sidebar.admin'] })).toBeVisible()
  await palette.getByTestId('search-section-actions').getByRole('option', { name: t['sidebar.admin'] }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(palette).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  // its other words find it too ("Members & invites")
  await box.fill(t['admin.members'].slice(0, 2))
  await expect(palette.getByRole('option', { name: t['teamMenu.invite'] })).toBeVisible()
  await box.fill('초대')
  const invite = palette.getByRole('option', { name: t['teamMenu.invite'] })
  await expect(invite).toBeVisible()
  await invite.click()
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: t['teamMenu.invite'] }).getByTestId('invite-step')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByTestId('account-menu').click()
  await page.getByTestId('logout').click()
  await signIn(page, BOB)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(box).toBeFocused()
  for (const words of [t['sidebar.admin'], '초대']) {
    await box.fill(words)
    await expect(palette.getByRole('option', { name: t['sidebar.admin'], exact: true })).toHaveCount(0)
    await expect(palette.getByRole('option', { name: t['teamMenu.invite'] })).toHaveCount(0)
  }
})

test('the phone drawer keeps the AI\'s name on top, with no team menu; Admin is on the 나 tab', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page)
  await signIn(page)
  await page.getByRole('button', { name: '메뉴 열기' }).click()
  const drawer = page.locator('[data-drawer]')
  await expect(drawer.getByTestId('sidebar-logo-phone')).toBeVisible()
  await expect(drawer.getByTestId('sidebar-logo-phone').locator('..')).toHaveText(ai)
  await expect(drawer.getByTestId('team-menu')).toHaveCount(0)
  await expect(drawer.getByTestId('team-header')).toHaveCount(0)
  await expect(drawer.getByTestId('nav-admin')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.goto('/settings')
  await expect(page.getByTestId('settings-admin')).toBeVisible()
  await page.getByTestId('settings-admin').click()
  await expect(page).toHaveURL(/\/admin$/)
})

test('short lists keep their entries: "모든 대화" opens the conversations page, "모두 보기" the whole history and "접기" back', async ({ page }) => {
  await reset(page)
  await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: rooms(2) } }) : r.fallback()))
  await signIn(page)
  await someChats(page, 3)
  await page.reload()
  const s = side(page)
  await expect(s.getByTestId('sidebar-room')).toHaveCount(2)
  await expect(s.getByTestId('rooms-more')).toHaveCount(0)
  await expect(s.getByTestId('ai-chats-latest').getByRole('link')).toHaveCount(3)
  await expect(s.getByTestId('ai-chats-all')).toHaveText(t['rooms.showAll'])
  await s.getByTestId('ai-chats-all').click()
  await expect(s.getByTestId('ai-chats-latest')).toHaveCount(0)
  await expect(s.getByTestId('ai-chats-less')).toBeVisible()
  await s.getByTestId('ai-chats-less').click()
  await expect(s.getByTestId('ai-chats-latest').getByRole('link')).toHaveCount(3)
  await expect(s.getByTestId('rooms-all')).toHaveText(t['sidebar.allRooms'])
  await s.getByTestId('rooms-all').click()
  await expect(page).toHaveURL(/\/rooms$/)
})

test('a hairline at the top of the scroll only while it is scrolled, the color of the one above the account row; nothing moves', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await reset(page)
  await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: rooms(60) } }) : r.fallback()))
  await signIn(page)
  await someChats(page, 7)
  await page.reload()
  const s = side(page)
  const scroll = s.getByTestId('sidebar-scroll')
  await expect(s.getByTestId('sidebar-room')).toHaveCount(5)
  const line = () => scroll.evaluate((e) => ({ width: getComputedStyle(e).borderTopWidth, color: getComputedStyle(e).borderTopColor }))
  const account = await s.getByTestId('account-menu').evaluate((e) => getComputedStyle(e.closest('.border-t')!).borderTopColor)
  const top0 = (await s.getByTestId('rooms-toggle').boundingBox())!.y
  expect(await line()).toEqual({ width: '1px', color: 'rgba(0, 0, 0, 0)' })
  await scroll.evaluate((e) => e.scrollTo({ top: 80 }))
  await expect(scroll).toHaveAttribute('data-scrolled', '')
  expect(await line()).toEqual({ width: '1px', color: account })
  await scroll.evaluate((e) => e.scrollTo({ top: 0 }))
  await expect(scroll).not.toHaveAttribute('data-scrolled')
  expect(await line()).toEqual({ width: '1px', color: 'rgba(0, 0, 0, 0)' })
  expect((await s.getByTestId('rooms-toggle').boundingBox())!.y).toBe(top0)
})

test('both groups fold and stay folded after a reload', async ({ page }) => {
  await reset(page)
  await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: rooms(3) } }) : r.fallback()))
  await signIn(page)
  await someChats(page, 2)
  await page.reload()
  const s = side(page)
  await s.getByTestId('rooms-toggle').click()
  await s.getByTestId('recents-toggle').click()
  await expect(s.getByTestId('sidebar-rooms-list')).toBeHidden()
  await expect(s.getByTestId('recents-list')).toBeHidden()
  await page.reload()
  await expect(s.getByTestId('rooms-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(s.getByTestId('recents-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(s.getByTestId('sidebar-rooms-list')).toBeHidden()
  await expect(s.getByTestId('recents-list')).toBeHidden()
  await s.getByTestId('rooms-toggle').click()
  await expect(s.getByTestId('sidebar-room').first()).toBeVisible()
})

/** In the page, for each [selector, nth] under `root` (nth -1: the first one at rest, weight 400): the computed style of
 * the element that holds its first text (the text node's parent), that colour's contrast on the sidebar, and the box of
 * the text itself (not the padding around it). */
function textStyles(root: Element, picks: [string, number][]) {
  const rgb = (c: string) => c.match(/[\d.]+/g)!.slice(0, 3).map(Number)
  const lum = (c: string) => { const [r, g, b] = rgb(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! }
  const bg = getComputedStyle(root).backgroundColor
  const contrast = (c: string) => { const [a, b] = [lum(c), lum(bg)].sort((x, y) => y - x); return (a! + 0.05) / (b! + 0.05) }
  return picks.map(([sel, nth]) => {
    const all = [...root.querySelectorAll(sel)]
    const el = nth < 0 ? all.find((a) => getComputedStyle(a).fontWeight === '400') : all[nth]
    if (!el) throw new Error(`no ${sel} #${nth}`)
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n = walk.nextNode()
    while (n && !n.textContent!.trim()) n = walk.nextNode()
    if (!n) throw new Error(`no text in ${sel}`)
    const range = document.createRange()
    range.selectNodeContents(n)
    const box = range.getBoundingClientRect()
    const st = getComputedStyle(n.parentElement!)
    return { size: parseFloat(st.fontSize), weight: Number(st.fontWeight), contrast: contrast(st.color), top: box.top, bottom: box.bottom, height: box.height }
  })
}
const id = (testId: string, nth = 0): [string, number] => [`[data-testid="${testId}"]`, nth]

test('대화 and 트리나 기록 read as section titles (the owner, 2026-11-07): semibold in the main text colour, AA in both looks, a step under the rows, above "더 보기", with room before 트리나 기록', async ({ page }) => {
  await reset(page)
  await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: rooms(7) } }) : r.fallback()))
  await signIn(page)
  await someChats(page, 3)
  await page.reload()
  const s = side(page)
  await expect(s.getByTestId('rooms-more')).toBeVisible()
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
    // two rows next to each other (whatever their weight) for the gap; a row at rest (not unread) for the colour
    const [roomsTitle, ai, more, first, second, row] = await s.evaluate(textStyles, [id('rooms-toggle'), id('recents-toggle'), id('rooms-more'), id('sidebar-room', 0), id('sidebar-room', 1), id('sidebar-room', -1)])
    for (const title of [roomsTitle!, ai!]) {
      expect(title.weight, scheme).toBe(600)
      expect(title.contrast, scheme).toBeGreaterThanOrEqual(4.5)
      // more than a row's text and than "더 보기" under the list, which share neither its weight nor its colour
      expect(title.contrast, scheme).toBeGreaterThan(row!.contrast)
      expect(title.contrast, scheme).toBeGreaterThan(more!.contrast)
      expect(title.weight, scheme).toBeGreaterThan(more!.weight)
      // not one more row: a step smaller, on one line
      expect(title.size, scheme).toBeLessThan(row!.size)
      expect(title.height, scheme).toBeLessThan(2 * title.size)
    }
    // the break before 트리나 기록 is at least 1.5 times the gap between two rows' text
    expect(ai!.top - more!.bottom).toBeGreaterThanOrEqual(1.5 * (second!.top - first!.bottom))
  }
  // the fold and "+" still work from the title row
  await s.getByTestId('rooms-toggle').click()
  await expect(s.getByTestId('sidebar-rooms-list')).toBeHidden()
  await s.getByTestId('rooms-toggle').click()
  await expect(s.getByTestId('sidebar-room').first()).toBeVisible()
  await s.getByTestId('rooms-new-dm').click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('a long history filter beside 트리나 기록 is cut; the title stays on one line', async ({ page }) => {
  await reset(page, { teamLocale: 'id', usersFollowTeam: true })
  // "waiting" has the longest label (id: "Sedang menjawab atau menunggu Anda")
  await page.addInitScript(() => localStorage.setItem('mycel.sidebar.recentsView', JSON.stringify({ status: 'waiting', activity: 'all', group: 'date', sort: 'updated' })))
  await signIn(page)
  const s = page.getByRole('navigation', { name: DICTS.id['sidebar.label'] })
  await expect(s.getByTestId('recents-filter-label')).toContainText(DICTS.id['sidebar.filter.active'])
  const [title] = await s.evaluate(textStyles, [id('recents-toggle')])
  expect(title!.height).toBeLessThan(2 * title!.size)
  // the label gives way: its text is cut with an ellipsis, not the title
  expect(await s.getByTestId('recents-filter-label').locator('.truncate').evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('in the drawer 트리나 기록 stands above the date heading under it ("오늘"): heavier and higher contrast, in both looks', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await someChats(page, 3)
    await page.reload()
    await page.getByTestId('menu-open').click()
    const drawer = page.getByRole('dialog', { name: t['sidebar.label'] }).getByRole('navigation', { name: t['sidebar.label'] })
    await expect(drawer.locator('[data-testid="recents-list"] h3').first()).toHaveText(t['sidebar.today'])
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(page.locator('html')).toHaveClass(scheme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
      const [title, day] = await drawer.evaluate(textStyles, [id('recents-toggle'), ['[data-testid="recents-list"] h3', 0] as [string, number]])
      expect(title!.weight, scheme).toBeGreaterThan(day!.weight)
      expect(title!.contrast, scheme).toBeGreaterThan(day!.contrast)
      expect(title!.contrast, scheme).toBeGreaterThanOrEqual(4.5)
      // the phone floor: 13px
      expect(title!.size, scheme).toBeGreaterThanOrEqual(13)
    }
  })
})

for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
  test(`60 rooms at ${size.width}: one scroll; 대화 shows strictly the five latest and the room on screen, "더 보기 (N)" the rest with what is unread there, remembered; 트리나 기록 in sight`, async ({ page }) => {
    await page.setViewportSize(size)
    await reset(page)
    const list = rooms(60)
    await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: list } }) : r.fallback()))
    await signIn(page)
    await someChats(page, 7)
    await page.reload()
    const s = side(page)
    // the five latest only; the eight unread rooms beyond them (every seventh has 2 unread) are counted on "더 보기"
    await expect(s.getByTestId('sidebar-room')).toHaveCount(5)
    await expect(s.getByTestId('rooms-more').locator('span').first()).toHaveText(t['sidebar.showMore'].replace('{n}', '55'))
    await expect(s.getByTestId('rooms-more-unread').locator('[aria-hidden]')).toHaveText(t['sidebar.moreUnread'].replace('{n}', '16'))
    await expect(s.getByTestId('rooms-more')).toHaveAccessibleName(new RegExp(t['rooms.unread'].replace('{n}', '16')))
    const first = s.getByTestId('sidebar-room').first()
    await expect(first.locator('[title]')).toHaveAttribute('title', /합동\) 2026 상반기/)
    expect((await first.boundingBox())!.width).toBeLessThanOrEqual(280)
    // one scroll: nothing pinned, the AI history follows the rooms, its heading and its first chats in sight without
    // scrolling (below the labeled rows: 4 of its 5 at 1440×900, 2 at 1280×800 in this run)
    await expect(s.getByTestId('sidebar-ai-pane')).toHaveCount(0)
    const scroll = s.getByTestId('sidebar-scroll')
    const aiHead = s.getByTestId('recents-toggle')
    await expect(s.getByTestId('ai-chats-latest').getByRole('link')).toHaveCount(5)
    const inSight = await scroll.evaluate((pane) => {
      const b = pane.getBoundingClientRect()
      const seen = (q: Element) => { const r = q.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 }
      return { rooms: [...pane.querySelectorAll('[data-testid="sidebar-room"]')].filter(seen).length, ai: [...pane.querySelectorAll('[data-testid="ai-chats-latest"] a[href^="/c/"]')].filter(seen).length, head: [...pane.querySelectorAll('[data-testid="recents-toggle"]')].filter(seen).length }
    })
    test.info().annotations.push({ type: 'in sight', description: `${size.width}×${size.height}: ${JSON.stringify(inSight)}` })
    expect(inSight.rooms).toBe(5)
    expect(inSight.head).toBe(1)
    expect(inSight.ai).toBeGreaterThanOrEqual(1)
    // "더 보기": the rest in place, and still so after a reload
    await s.getByTestId('rooms-more').click()
    await expect(s.getByTestId('sidebar-room')).toHaveCount(60)
    await expect(s.getByTestId('rooms-more')).toHaveText(t['common.less'])
    await expect(s.getByTestId('rooms-more-unread')).toHaveCount(0)
    await page.reload()
    await expect(s.getByTestId('sidebar-room')).toHaveCount(60)
    // the room on screen stays, the sixth, when the list closes again
    await s.getByTestId('sidebar-room').nth(30).click()
    await expect(page).toHaveURL(new RegExp(`/rooms/${list[30]!.id}`))
    await s.getByTestId('rooms-more').click()
    await expect(s.getByTestId('sidebar-room')).toHaveCount(6)
    await expect(s.getByTestId('sidebar-room').nth(5)).toHaveAttribute('href', `/rooms/${list[30]!.id}`)
    // 트리나 기록's 모두 보기 stays open after a reload too
    await page.goto('/')
    await aiHead.scrollIntoViewIfNeeded()
    await s.getByTestId('ai-chats-all').click()
    await expect(s.getByTestId('ai-chats-less')).toBeAttached()
    await page.reload()
    await expect(s.getByTestId('ai-chats-less')).toBeAttached()
    await expect(s.getByTestId('ai-chats-latest')).toHaveCount(0)
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)
  })
}

test('the "?" and the new-answer dot (session markers) come from the chat list: they survive a reload, with no request per chat', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const s = side(page)
  // an answer that finishes while I am on Home (one turn at a time: the question below comes after it)
  await page.getByTestId('composer-input').fill('slow answer while I look elsewhere')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\//)
  const awayChat = new URL(page.url()).pathname
  await s.getByTestId('new-chat').click()
  await expect(page).toHaveURL(/\/$/)
  const awayRow = s.locator(`li:has(a[href="${awayChat}"])`)
  await expect(awayRow.getByTestId('marker-new')).toBeVisible({ timeout: 20_000 })
  // a question card, left for Home
  await page.getByTestId('composer-input').fill('ask me which quarter')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\//)
  const askChat = new URL(page.url()).pathname
  await expect(page.getByTestId('ask-card')).toBeVisible()
  await s.getByTestId('new-chat').click()
  await expect(page).toHaveURL(/\/$/)
  const askRow = s.locator(`li:has(a[href="${askChat}"])`)
  await expect(askRow.getByTestId('marker-ask')).toBeVisible()
  // a reload: both still there, from the list alone
  const perChat: string[] = []
  page.on('request', (r) => { if (/\/api\/chats\/[^/]+\/(requests|messages)/.test(r.url())) perChat.push(r.url()) })
  await page.reload()
  await expect(askRow.getByTestId('marker-ask')).toBeVisible()
  await expect(awayRow.getByTestId('marker-new')).toBeVisible()
  await page.waitForTimeout(500)
  expect(perChat).toEqual([])
  // opened: seen (the server is told), and still seen after a reload
  const seen = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/chats${awayChat.slice(2)}/seen`))
  await awayRow.getByRole('link').first().click()
  await seen
  await expect(awayRow.getByTestId('marker-new')).toHaveCount(0)
  await s.getByTestId('new-chat').click()
  await expect(awayRow.getByTestId('marker-new')).toHaveCount(0)
  await page.reload()
  await expect(awayRow).toBeVisible()
  await expect(awayRow.getByTestId('marker-new')).toHaveCount(0)
})
