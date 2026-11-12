// ⌘K: rooms and people by name, files sent in rooms, a result of an older text (docs/DECISIONS.md "⌘K: 대화방·사람,
// 대화방 파일, 모든 단어"): Korean initial consonants find a room and Enter opens it; a person with no DM opens the new-DM list with
// them ticked and makes nothing; a file sent in a room shows after the team's files as one line (who, where, when) and
// opens its message in the room; a fast Enter after a new text never opens the old text's chat. The rooms, the files
// and the slow chat search answer through page.route, contract-shaped (the mock server lists no rooms). Bob is the mock
// team's member with no DM.
// SHOTS_DIR=<dir>: the palette with 대화방·사람 and a room file, at 1440 and 390, light and dark.
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const TEAM = id(9101), GROUP = id(9102), MSG = id(31), QUOTE_CHAT = id(8001)
const MINJUN = { id: 'minjun', name: '민준' }, SEOYEON = { id: 'seoyeon', name: '서연' }
const T0 = Date.now() - 2 * 86_400_000
const at = (n: number) => new Date(T0 + n * 60_000).toISOString()
const roomOf = (o: Record<string, unknown>) => ({ canRename: false, managerId: null, groupId: null, memberCount: 3, peers: [MINJUN, SEOYEON], lastSeq: 40, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 40, lastMessage: null, muted: false, createdAt: at(-60), ...o })
const team = roomOf({ id: TEAM, kind: 'team', name: '디자인 리뷰', groupId: id(9200), activityAt: at(40) })
const group = roomOf({ id: GROUP, kind: 'group', name: '디자인팀 점심', activityAt: at(20) })
const FILE = { id: id(5001), name: '견적서_acme.pdf', size: 2048, mime: 'application/pdf', kind: 'pdf', thumb: false }
const message = (n: number, o: Record<string, unknown> = {}) => ({
  id: id(n), roomId: TEAM, seq: n, authorKind: 'user', author: n % 2 ? MINJUN : SEOYEON, askedBy: null, visibility: 'room', body: `디자인 리뷰 메모 ${n}`, replyTo: null,
  mentions: [], files: [], createdAt: at(n), editedAt: null, deletedAt: null, ...o,
})
const TIMELINE = Array.from({ length: 40 }, (_, i) => message(i + 1, i + 1 === 31 ? { body: '', files: [FILE], author: MINJUN } : {}))
const quoteChat = { id: QUOTE_CHAT, projectId: null, title: '견적서 초안 정리', engine: 'claude-code', model: null, createdAt: at(-30), updatedAt: at(-1), deletedAt: null, runState: 'idle' }

async function routes(page: Page) {
  const asked: string[] = []
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/room-files\?/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    const hit = q.split(/\s+/).every((w) => FILE.name.toLowerCase().includes(w.toLowerCase()))
    return route.fulfill(json(hit ? { items: [{ file: FILE, messageId: MSG, roomId: TEAM, threadRootId: null, author: MINJUN, createdAt: at(31) }], rooms: [{ id: TEAM, kind: 'team', name: '디자인 리뷰', peers: [MINJUN, SEOYEON], memberCount: 3 }], nextCursor: null } : { items: [], rooms: [], nextCursor: null }))
  })
  await page.route(/\/api\/room-messages\?/, (route) => route.fulfill(json({ items: [], rooms: [], nextCursor: null })))
  // the chat records: 견적서 at once, 회의록 slowly (an answer still on its way when Enter is pressed)
  await page.route(/\/api\/chats\?.*q=/, async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    if (q.includes('회의록')) await new Promise((r) => setTimeout(r, 2_000))
    return route.fulfill(json({ items: q.includes('견적서') ? [quoteChat] : [], nextCursor: null }))
  })
  await page.route(/\/api\/rooms(\/|\?|$)/, (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname, method = req.method()
    asked.push(`${method} ${p}`)
    if (method === 'GET' && p === '/api/rooms') return route.fulfill(json({ items: [team, group] }))
    if (method === 'GET' && p === `/api/rooms/${TEAM}`) return route.fulfill(json(team))
    if (method === 'GET' && p === `/api/rooms/${GROUP}`) return route.fulfill(json(group))
    if (method === 'GET' && (p === `/api/rooms/${TEAM}/messages` || p === `/api/rooms/${GROUP}/messages`)) return route.fulfill(json({ items: p.includes(TEAM) ? TIMELINE : [], nextCursor: null }))
    if (method === 'GET' && p.endsWith('/members')) return route.fulfill(json({ items: [MINJUN, SEOYEON].map((user) => ({ user, joinedAt: at(-60) })) }))
    if (method === 'GET' && p.endsWith('/ai')) return route.fulfill(json({ answering: 0, mine: [] }))
    if (method === 'POST' && p.endsWith('/read')) return route.fulfill(json({ lastReadSeq: 40, unreadCount: 0, mentioned: false }))
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return asked
}

const palette = (page: Page) => page.getByTestId('search-palette')
const input = (page: Page) => palette(page).getByRole('combobox')
const people = (page: Page) => palette(page).getByTestId('search-section-people')
async function open(page: Page) {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
}
async function shot(page: Page, name: string) {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${name}.png`) })
}

test('initial consonants find a room, first on 전체; Enter opens it', async ({ page }) => {
  await routes(page)
  await reset(page)
  await signIn(page)
  await open(page)
  await input(page).fill('ㄷㅈㅇ')
  await expect(people(page).getByText('대화방·사람')).toBeVisible()
  const rows = people(page).getByRole('option')
  await expect(rows).toHaveCount(2)
  // the latest activity first; the first row of the palette, highlighted
  await expect(rows.nth(0)).toHaveText('디자인 리뷰')
  await expect(rows.nth(1)).toHaveText('디자인팀 점심')
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${GROUP}$`))
})

test('a person with no DM: the new-DM list opens with them ticked, and no DM is made', async ({ page }) => {
  const asked = await routes(page)
  await reset(page)
  await signIn(page)
  await open(page)
  await input(page).fill('bob')
  const row = people(page).getByRole('option')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Bob')
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  await expect(page.getByTestId('picker-count')).toHaveText('1명 선택')
  await expect(page.getByTestId('picker-go')).toBeEnabled()
  expect(asked.filter((x) => x === 'POST /api/rooms')).toEqual([])
})

test('a file sent in a room: one line with who, where and when; it opens its message in the room', async ({ page }) => {
  await routes(page)
  await reset(page)
  await signIn(page)
  await open(page)
  await input(page).fill('acme 견적서')
  const file = palette(page).getByTestId('search-room-file')
  await expect(file).toHaveCount(1)
  await expect(file.locator('mark').first()).toHaveText('견적서')
  await expect(file.getByTestId('search-room-file-where')).toContainText('민준 · #디자인 리뷰 · ')
  await file.click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${TEAM}\\?m=${MSG}$`))
  await expect(page.locator('[data-testid="room-message"][data-highlight]')).toContainText('견적서_acme.pdf')
})

test('Enter right after a new text never opens a chat of the old one', async ({ page }) => {
  await routes(page)
  await reset(page)
  await signIn(page)
  await open(page)
  await input(page).fill('견적서')
  await expect(palette(page).getByTestId('search-section-chats')).toContainText('견적서 초안 정리')
  await input(page).fill('회의록')
  await expect(palette(page).getByTestId('search-section-chats')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page).not.toHaveURL(new RegExp(`/c/${QUOTE_CHAT}`))
})

for (const scheme of ['light', 'dark'] as const) {
  test(`rooms, people and room files pass the accessibility checks (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await routes(page)
    await reset(page)
    await signIn(page)
    await open(page)
    await input(page).fill('디자인')
    await expect(people(page).getByRole('option')).toHaveCount(2)
    const r = await new AxeBuilder({ page }).include('[data-testid="search-palette"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${scheme}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
    await input(page).fill('견적서')
    await expect(palette(page).getByTestId('search-room-file')).toHaveCount(1)
    await shot(page, `search-file-1440-${scheme}`)
    await input(page).fill('ㄷㅈ')
    await expect(people(page).getByRole('option')).toHaveCount(2)
    await shot(page, `search-people-1440-${scheme}`)
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  for (const scheme of ['light', 'dark'] as const) {
    test(`대화방·사람 and a room file fit the screen; the chat records stay in sight (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await routes(page)
      await reset(page)
      await signIn(page)
      await page.goto('/')
      await page.getByRole('button', { name: '메뉴 열기' }).click()
      await page.getByRole('button', { name: '검색' }).first().click()
      await expect(palette(page)).toBeVisible()
      await input(page).fill('견적서')
      await expect(palette(page).getByTestId('search-room-file')).toHaveCount(1)
      await expect(palette(page).getByTestId('search-section-chats')).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await shot(page, `search-file-390-${scheme}`)
      await input(page).fill('ㄷㅈ')
      await expect(people(page).getByRole('option')).toHaveCount(2)
      await shot(page, `search-people-390-${scheme}`)
      await people(page).getByRole('option').nth(0).tap()
      await expect(page).toHaveURL(new RegExp(`/rooms/${TEAM}$`))
    })
  }
})
