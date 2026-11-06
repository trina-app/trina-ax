// The computer's sidebar in a real browser (docs/DECISIONS.md "Desktop sidebar: rooms first"): its order, the icon row
// by keyboard (focus ring, tooltip on focus, the Inbox count in its name), Admin for owners only, both groups folded
// across a reload, 60 rooms in one scroll (대화 strictly capped at the five latest and the room on screen, "더 보기 (N)"
// with what is unread behind it, remembered; 트리나 기록 in sight below at 1440 and 1280), and "답변 필요" / the
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

test('in order: the team, a new chat and search, one row of icons, the rooms, then the AI chats', async ({ page }) => {
  await reset(page)
  await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: rooms(3) } }) : r.fallback()))
  await signIn(page)
  const s = side(page)
  await expect(s.getByTestId('sidebar-team')).toBeVisible()
  await expect(s.getByTestId('sidebar-team')).not.toHaveText(PRODUCT.displayName)
  const ys = [await top(page, 'sidebar-team'), await top(page, 'new-chat'), await top(page, 'nav-icons'), await top(page, 'sidebar-rooms'), await top(page, 'recents-toggle')]
  expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  await expect(s.getByTestId('recents-toggle')).toHaveText(t['sidebar.aiChats'].replace('{name}', ai))
  await expect(s.getByTestId('nav-icons').getByRole('link')).toHaveCount(6)
  await expect(s.getByTestId('nav-admin')).toBeVisible()
  // the old rows are gone: one text row (트리나에게 묻기), the rest are icons
  await expect(s.getByRole('link', { name: t['sidebar.projects'], exact: true })).toHaveAttribute('href', '/projects')
  expect(Math.round((await s.getByTestId('nav-icons').boundingBox())!.height)).toBe(36)
})

test('the icon row by keyboard: a focus ring and the name as a tooltip on each; the Inbox says its count', async ({ page }) => {
  await reset(page)
  await page.route('**/api/notifications?*', (r) => r.fulfill({ json: { items: [], nextCursor: null, unreadCount: 3 } }))
  await signIn(page)
  const s = side(page)
  await expect(s.getByTestId('inbox-unread')).toHaveText('3')
  await expect(s.getByTestId('nav-inbox')).toHaveAttribute('aria-label', `${t['inbox.title']}, ${t['notifications.unread'].replace('{count}', '3')}`)
  await s.getByTestId('new-chat').focus()
  const expectFocused = async (id: string, name: string) => {
    const el = s.getByTestId(id)
    await expect(el).toBeFocused()
    expect(await el.evaluate((e) => getComputedStyle(e).outlineStyle)).not.toBe('none')
    const tip = el.getByTestId('nav-tip')
    await expect(tip).toHaveText(name)
    await expect.poll(() => tip.evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
  }
  await page.keyboard.press('Tab')
  await expect(s.getByTestId('nav-search')).toBeFocused()
  for (const [id, key] of [['nav-files', 'sidebar.files'], ['nav-projects', 'sidebar.projects'], ['nav-scheduled', 'sidebar.scheduled'], ['nav-skills', 'sidebar.skills'], ['nav-inbox', 'inbox.title'], ['nav-admin', 'sidebar.admin']] as const) {
    await page.keyboard.press('Tab')
    await expectFocused(id, t[key])
  }
  // no tooltip without hover or focus
  await page.keyboard.press('Tab')
  await expect.poll(() => s.getByTestId('nav-admin').getByTestId('nav-tip').evaluate((e) => getComputedStyle(e).opacity)).toBe('0')
  // Enter opens it
  await s.getByTestId('nav-files').focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/files/)
  await expect(s.getByTestId('nav-files')).toHaveAttribute('aria-current', 'page')
})

test('a member has no Admin icon', async ({ page }) => {
  await reset(page)
  await signIn(page, { username: 'bob', password: 'bob password 1' })
  const s = side(page)
  await expect(s.getByTestId('nav-icons').getByRole('link')).toHaveCount(5)
  await expect(s.getByTestId('nav-admin')).toHaveCount(0)
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
    // one scroll: nothing pinned, the AI history follows the rooms, all of its five in sight without scrolling
    await expect(s.getByTestId('sidebar-ai-pane')).toHaveCount(0)
    const scroll = s.getByTestId('sidebar-scroll')
    const aiHead = s.getByTestId('recents-toggle')
    await expect(s.getByTestId('ai-chats-latest').getByRole('link')).toHaveCount(5)
    const inSight = await scroll.evaluate((pane) => {
      const b = pane.getBoundingClientRect()
      const seen = (q: Element) => { const r = q.getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1 }
      return { rooms: [...pane.querySelectorAll('[data-testid="sidebar-room"]')].filter(seen).length, ai: [...pane.querySelectorAll('[data-testid="ai-chats-latest"] a[href^="/c/"]')].filter(seen).length }
    })
    test.info().annotations.push({ type: 'in sight', description: `${size.width}×${size.height}: ${JSON.stringify(inSight)}` })
    expect(inSight).toEqual({ rooms: 5, ai: 5 })
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

test('"답변 필요" and the new-answer dot come from the chat list: they survive a reload, with no request per chat', async ({ page }) => {
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
  await expect(awayRow.getByTestId('new-answer-dot')).toBeVisible({ timeout: 20_000 })
  // a question card, left for Home
  await page.getByTestId('composer-input').fill('ask me which quarter')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\//)
  const askChat = new URL(page.url()).pathname
  await expect(page.getByTestId('ask-card')).toBeVisible()
  await s.getByTestId('new-chat').click()
  await expect(page).toHaveURL(/\/$/)
  const askRow = s.locator(`li:has(a[href="${askChat}"])`)
  await expect(askRow.getByTestId('needs-answer')).toHaveText(t['chat.needsAnswer'])
  // a reload: both still there, from the list alone
  const perChat: string[] = []
  page.on('request', (r) => { if (/\/api\/chats\/[^/]+\/(requests|messages)/.test(r.url())) perChat.push(r.url()) })
  await page.reload()
  await expect(askRow.getByTestId('needs-answer')).toBeVisible()
  await expect(awayRow.getByTestId('new-answer-dot')).toBeVisible()
  await page.waitForTimeout(500)
  expect(perChat).toEqual([])
  // opened: seen (the server is told), and still seen after a reload
  const seen = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/api/chats${awayChat.slice(2)}/seen`))
  await awayRow.getByRole('link').first().click()
  await seen
  await expect(awayRow.getByTestId('new-answer-dot')).toHaveCount(0)
  await s.getByTestId('new-chat').click()
  await expect(awayRow.getByTestId('new-answer-dot')).toHaveCount(0)
  await page.reload()
  await expect(awayRow).toBeVisible()
  await expect(awayRow.getByTestId('new-answer-dot')).toHaveCount(0)
})
