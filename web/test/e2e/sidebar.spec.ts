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
