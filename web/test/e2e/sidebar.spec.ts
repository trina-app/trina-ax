// The computer's sidebar in a real browser (docs/DECISIONS.md "Desktop sidebar: rooms first"): its order, one labeled
// row each by keyboard (focus ring, the Inbox count on its row and in words), Admin for owners only, both groups folded
// across a reload, 60 rooms in one scroll (대화 strictly capped at the five latest and the room on screen, "더 보기 (N)"
// with what is unread behind it, remembered; 트리나 기록's heading and first chats in sight below at 1440 and 1280), and "답변 필요" / the
// new-answer dot that come from the chat list (they survive a reload, and no request is made per chat).
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

const ROWS = [['new-chat', 'nav-search', 'nav-projects', 'nav-scheduled', 'nav-inbox', 'nav-files', 'nav-skills'], ['nav-admin']] as const

test('in order: the team, one labeled row each, the rooms, then the AI chats', async ({ page }) => {
  await reset(page)
  await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: rooms(3) } }) : r.fallback()))
  await signIn(page)
  const s = side(page)
  await expect(s.getByTestId('sidebar-team')).toBeVisible()
  await expect(s.getByTestId('sidebar-team')).not.toHaveText(PRODUCT.displayName)
  const ids = ['sidebar-team', ...ROWS[0], ...ROWS[1], 'sidebar-rooms', 'recents-toggle']
  const ys: number[] = []
  for (const id of ids) ys.push(await top(page, id))
  expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  await expect(s.getByTestId('recents-toggle')).toHaveText(t['sidebar.aiChats'].replace('{name}', ai))
  // each row says its name, 36 px high, the old order: 트리나에게 묻기, 검색, 프로젝트, 예약 작업, 알림함, 파일, 팀 스킬, 관리자
  const said = (words: string, hint = false) => new RegExp(`^\\s*${words}${hint ? '' : '$'}`)
  await expect(s.getByTestId('nav-rows').locator(':scope > *')).toHaveText([
    said(t['sidebar.askAi'].replace('{name}', ai), true), said(t['sidebar.search'], true), said(t['sidebar.projects']), said(t['sidebar.scheduled']), said(t['inbox.title']), said(t['sidebar.files']), said(t['sidebar.skills']), said(t['sidebar.admin']),
  ])
  for (const id of [...ROWS[0], ...ROWS[1]]) expect(Math.round((await s.getByTestId(id).boundingBox())!.height)).toBe(36)
  // 트리나에게 묻기's icon is the ✦ that asks the AI (the room header's, rooms/AiFace.tsx AiMark), not the orange speech
  // bubble: Trina's star drawn 18 (the sparkle 16) in the 16 px slot of the icons below it, on the same middle, so its
  // words start where theirs do
  const mark = s.getByTestId('new-chat').locator('svg')
  await expect(mark).toHaveCount(1)
  expect(await mark.evaluate((e) => e.hasAttribute('data-trina-star'))).toBe(PRODUCT_NAMED_AFTER_AI)
  const icon = async (id: string) => (await s.getByTestId(id).locator('svg').first().boundingBox())!
  const [star, search] = [await icon('new-chat'), await icon('nav-search')]
  expect(star.width).toBe(PRODUCT_NAMED_AFTER_AI ? 18 : 16)
  expect(search.width).toBe(16)
  expect(star.x + star.width / 2).toBe(search.x + search.width / 2)
  const row = (await s.getByTestId('new-chat').boundingBox())!
  expect(star.y + star.height / 2).toBe(row.y + row.height / 2)
  const wordsAt = (id: string) => s.getByTestId(id).evaluate((e) => {
    const text = [...e.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()) ?? e.querySelector('span')!.firstChild!
    const r = document.createRange()
    r.selectNodeContents(text)
    return Math.round([...r.getClientRects()].find((x) => x.width > 0)!.x)
  })
  expect(await wordsAt('new-chat')).toBe(await wordsAt('nav-projects'))
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
  for (const id of [...ROWS[0].slice(1), ...ROWS[1]]) {
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

test('a member has no Admin row', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  const s = side(page)
  await expect(s.getByTestId('nav-rows').locator(':scope > *')).toHaveCount(7)
  await expect(s.getByTestId('nav-admin')).toHaveCount(0)
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
