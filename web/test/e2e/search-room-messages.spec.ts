// Room messages in ⌘K (docs/DECISIONS.md "⌘K에서 대화방 메시지 찾기"): ⌘K → a word → the 대화방 메시지 section → Enter
// opens the room at that message, marked, even when it is older than the newest page (the page around it, with
// "최근 메시지로" back to the newest); a thread reply opens its thread at the reply. Phones: the same from the menu's 검색.
// The room and the search answer through page.route, contract-shaped (the mock server lists no rooms).
// SHOTS_DIR=<dir>: the palette with chat records and messages, an empty result and the jump, at 1440 and 390, light and
// dark, and the font sizes of a message row (font-sizes.json).
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ROOM = id(9001), DM = id(9002), GROUP = id(9003)
const MINJUN = { id: 'minjun', name: '민준' }, SEOYEON = { id: 'seoyeon', name: '서연' }, JIHO = { id: 'jiho', name: '지호' }, HAEUN = { id: 'haeun', name: '하은' }
const T0 = Date.now() - 3 * 86_400_000
const at = (n: number) => new Date(T0 + n * 60_000).toISOString()
const TARGET = id(10), ROOT = id(55), REPLY = id(62)
const bodyOf = (n: number) => (n === 10 ? '견적서 초안은 금요일까지 보낼게요' : n === 55 ? '다음 주 일정 정리해 둘게요' : `디자인 리뷰 메모 ${n}`)
function message(n: number, o: Record<string, unknown> = {}) {
  return {
    id: id(n), roomId: ROOM, seq: n, authorKind: 'user', author: n % 2 ? MINJUN : SEOYEON, askedBy: null, visibility: 'room', body: bodyOf(n), replyTo: null,
    mentions: [], files: [], createdAt: at(n), editedAt: null, deletedAt: null, ...(n === 10 ? { author: MINJUN } : {}), ...o,
  }
}
const TIMELINE = Array.from({ length: 60 }, (_, i) => message(i + 1, i + 1 === 55 ? { thread: { replyCount: 3, lastReplyAt: at(63), repliers: [SEOYEON, MINJUN], newReplies: false } } : {}))
const REPLIES = [61, 62, 63].map((n) => message(n, { threadRootId: ROOT, body: n === 62 ? '견적 금액은 스레드에서 다시 볼게요' : `답글 ${n - 60}`, author: n === 62 ? SEOYEON : MINJUN }))
const room = { id: ROOM, kind: 'team', name: '디자인 리뷰', canRename: false, managerId: null, groupId: id(9100), memberCount: 3, peers: [MINJUN, SEOYEON], lastSeq: 63, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 63, lastMessage: null, muted: false, createdAt: at(-60), activityAt: at(60) }

const hit = (o: Record<string, unknown>) => ({ threadRootId: null, authorKind: 'user', askedBy: null, markdown: false, ...o })
const HITS = [
  hit({ id: TARGET, roomId: ROOM, author: MINJUN, snippet: bodyOf(10), createdAt: at(10) }),
  hit({ id: REPLY, roomId: ROOM, threadRootId: ROOT, author: SEOYEON, snippet: '견적 금액은 스레드에서 다시 볼게요', createdAt: at(62) }),
  hit({ id: id(70), roomId: ROOM, authorKind: 'ai', author: null, askedBy: SEOYEON, markdown: true, snippet: '**견적 비교**: 세 곳 중 A사가 가장 낮고, 납기는 B사가 가장 빨라요.', createdAt: at(30) }),
  hit({ id: id(71), roomId: DM, author: JIHO, snippet: '견적 받으셨어요? 오늘 오후에 같이 봐요', createdAt: at(20) }),
  hit({ id: id(72), roomId: GROUP, author: HAEUN, snippet: '점심 먹고 견적이랑 시안 같이 볼까요', createdAt: at(5) }),
  hit({ id: id(73), roomId: GROUP, author: HAEUN, snippet: '견적 하나 더 왔어요', createdAt: at(4) }),
]
const ROOMS = [
  { id: ROOM, kind: 'team', name: '디자인 리뷰', peers: [MINJUN, SEOYEON], memberCount: 3 },
  { id: DM, kind: 'dm', name: null, peers: [JIHO], memberCount: 2 },
  { id: GROUP, kind: 'group', name: '디자인팀 점심', peers: [HAEUN, JIHO], memberCount: 3 },
]

/** the room (its newest page leaves the old match out: the page around it is asked for), its thread, and the search */
async function routes(page: Page) {
  const asked: string[] = []
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/room-messages\?/, (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    asked.push(q)
    return route.fulfill(json(q.includes('견적') ? { items: HITS, rooms: ROOMS, nextCursor: null } : { items: [], rooms: [], nextCursor: null }))
  })
  await page.route(/\/api\/rooms(\/|\?|$)/, (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname, method = req.method()
    if (method === 'GET' && p === '/api/rooms') return route.fulfill(json({ items: [room] }))
    if (method === 'GET' && p === `/api/rooms/${ROOM}`) return route.fulfill(json(room))
    if (method === 'GET' && p === `/api/rooms/${ROOM}/messages`) {
      const around = url.searchParams.get('around'), cursor = url.searchParams.get('cursor')
      asked.push(`messages ${around ? 'around' : cursor ?? 'newest'}`)
      if (around) return route.fulfill(json({ items: TIMELINE.slice(0, 25), nextCursor: null, newerCursor: 'n25' }))
      if (cursor === 'n25') return route.fulfill(json({ items: TIMELINE.slice(25), nextCursor: null, newerCursor: null }))
      if (cursor === 'o40') return route.fulfill(json({ items: TIMELINE.slice(0, 40), nextCursor: null }))
      return route.fulfill(json({ items: TIMELINE.slice(40), nextCursor: 'o40' }))
    }
    if (method === 'GET' && p === `/api/rooms/${ROOM}/messages/${ROOT}/thread`) return route.fulfill(json({ root: TIMELINE[54], items: REPLIES, nextCursor: null }))
    if (method === 'POST' && p === `/api/rooms/${ROOM}/messages/${ROOT}/thread/read`) return route.fulfill(json({ lastReadSeq: 63, room }))
    if (method === 'GET' && p === `/api/rooms/${ROOM}/members`) return route.fulfill(json({ items: [{ id: 'olga', name: 'Olga' }, MINJUN, SEOYEON].map((user) => ({ user, joinedAt: at(-60) })) }))
    if (method === 'GET' && p === `/api/rooms/${ROOM}/ai`) return route.fulfill(json({ answering: 0, mine: [] }))
    if (method === 'POST' && p === `/api/rooms/${ROOM}/read`) return route.fulfill(json({ lastReadSeq: 63, unreadCount: 0, mentioned: false }))
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return asked
}

const palette = (page: Page) => page.getByTestId('search-palette')
const input = (page: Page) => palette(page).getByRole('combobox')
const messages = (page: Page) => palette(page).getByTestId('search-section-messages')
async function open(page: Page, phone = false) {
  if (phone) {
    await page.goto('/')
    await page.getByRole('button', { name: '메뉴 열기' }).click()
    await page.getByRole('button', { name: '검색' }).first().click()
  } else await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
}

test('⌘K → a word → Enter opens the room at an old message, marked; 최근 메시지로 goes back to the newest', async ({ page }) => {
  const asked = await routes(page)
  await reset(page)
  await signIn(page)
  await open(page)
  await expect(input(page)).toHaveAttribute('placeholder', '기록·대화 메시지, 파일, 프로젝트 등 검색')
  await input(page).fill('견적')
  await expect(messages(page)).toBeVisible()
  await expect(messages(page).getByText('대화방 메시지')).toBeVisible()
  const rows = messages(page).getByRole('option')
  // five, then 메시지 더 보기 (in place: the dialog stays)
  await expect(rows).toHaveCount(6)
  await expect(rows.nth(0)).toContainText('민준')
  await expect(rows.nth(0).getByTestId('search-message-room')).toHaveText('#디자인 리뷰')
  await expect(rows.nth(0).locator('mark')).toHaveText('견적')
  await expect(rows.nth(1).getByTestId('search-message-room')).toHaveText('#디자인 리뷰 · 스레드')
  await expect(rows.nth(2).getByTestId('search-message-text')).toHaveText('견적 비교: 세 곳 중 A사가 가장 낮고, 납기는 B사가 가장 빨라요.')
  // a 1:1 chat written by the other person: 1:1 대화 (their name is the sender's)
  await expect(rows.nth(3).getByTestId('search-message-room')).toHaveText('1:1 대화')
  await expect(rows.nth(4).getByTestId('search-message-room')).toHaveText('디자인팀 점심')
  await rows.nth(5).click()
  await expect(rows).toHaveCount(6) // all six now, no 더 보기
  await expect(rows.nth(5)).toContainText('견적 하나 더 왔어요')
  await expect(palette(page)).toBeVisible()
  // the pointer chose the sixth; ↑ back to the first, then Enter
  await expect(rows.nth(5)).toHaveAttribute('aria-selected', 'true')
  await page.mouse.move(2, 2)
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp')
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(palette(page)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}\\?m=${TARGET}$`))
  // not in the newest page: the page around it, the message marked and in sight
  const marked = page.locator('[data-testid="room-message"][data-highlight]')
  await expect(marked).toContainText('견적서 초안은 금요일까지 보낼게요')
  await expect(marked).toBeInViewport()
  expect(asked).toContain('messages around')
  // back to the newest
  await page.getByTestId('room-to-newest').click()
  await expect(page.getByTestId('room-to-newest')).toHaveCount(0)
  await expect(page.getByTestId('room-scroller')).toContainText('디자인 리뷰 메모 60')
})

test('a thread reply opens its thread at the reply; arrows and Esc as before', async ({ page }) => {
  await routes(page)
  await reset(page)
  await signIn(page)
  await open(page)
  await input(page).fill('견적')
  const rows = messages(page).getByRole('option')
  await expect(rows).toHaveCount(6)
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}/t/${ROOT}\\?m=${REPLY}$`))
  const thread = page.getByTestId('room-thread')
  await expect(thread.locator('[data-testid="room-message"][data-highlight]')).toContainText('견적 금액은 스레드에서 다시 볼게요')
  // Esc closes the palette without opening anything
  await open(page)
  await input(page).fill('견적')
  await expect(rows).toHaveCount(6)
  await page.keyboard.press('Escape')
  await expect(palette(page)).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}/t/${ROOT}\\?m=${REPLY}$`))
})

test('nothing found: no messages section', async ({ page }) => {
  const asked = await routes(page)
  await reset(page)
  await signIn(page)
  await open(page)
  await input(page).fill('zzz-없음')
  await expect.poll(() => asked.includes('zzz-없음')).toBe(true)
  await expect(palette(page).getByTestId('search-section-files')).toBeVisible()
  await expect(messages(page)).toHaveCount(0)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`messages in search pass the accessibility checks (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await routes(page)
    await reset(page)
    await signIn(page)
    await open(page)
    await input(page).fill('견적')
    await expect(messages(page).getByRole('option')).toHaveCount(6)
    const r = await new AxeBuilder({ page }).include('[data-testid="search-palette"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${scheme}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
  })
}

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the menu\'s 검색: a message hit opens the room at it', async ({ page }) => {
    await routes(page)
    await reset(page)
    await signIn(page)
    await open(page, true)
    const box = (await palette(page).boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(389)
    await input(page).fill('견적')
    const rows = messages(page).getByRole('option')
    await expect(rows).toHaveCount(6)
    // a row fits the screen: the time stays in sight, the room name gives way
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await rows.nth(0).tap()
    await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}\\?m=${TARGET}$`))
    await expect(page.locator('[data-testid="room-message"][data-highlight]')).toContainText('견적서 초안은 금요일까지 보낼게요')
  })
})

// screenshots and font sizes, only with SHOTS_DIR
const SHOTS = process.env.SHOTS_DIR
for (const [w, h] of [[1440, 900], [390, 844]] as const) for (const scheme of ['light', 'dark'] as const) {
  test(`screenshots ${w} ${scheme}`, async ({ page }) => {
    test.skip(!SHOTS, 'SHOTS_DIR not set')
    fs.mkdirSync(SHOTS!, { recursive: true })
    const shot = (name: string) => page.screenshot({ path: path.join(SHOTS!, `${name}-${w}-${scheme}.png`) })
    await page.setViewportSize({ width: w, height: h })
    await page.emulateMedia({ colorScheme: scheme })
    await routes(page)
    await reset(page)
    await signIn(page)
    // a chat record with the word too: mixed results
    await page.getByTestId('composer-input').fill('견적서 초안 정리해 줘')
    await page.getByTestId('send').click()
    await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1)
    await open(page, w < 768)
    await expect(input(page)).toBeFocused()
    await shot('palette-no-text')
    await input(page).fill('견적')
    await expect(palette(page).getByTestId('search-section-chats')).toBeVisible()
    await expect(messages(page).getByRole('option')).toHaveCount(6)
    await page.keyboard.press('ArrowDown')
    await shot('palette-mixed')
    if (w === 1440 && scheme === 'light') {
      const row = messages(page).getByRole('option').first()
      const size = (l: ReturnType<Page['locator']>) => l.evaluate((e) => getComputedStyle(e).fontSize)
      const sizes = {
        sectionLabel: await size(palette(page).locator('#sh-messages')),
        name: await size(row.locator('span.font-medium').first()),
        room: await size(row.getByTestId('search-message-room')),
        time: await size(row.locator('span.tabular-nums')),
        text: await size(row.getByTestId('search-message-text')),
        chatRow: await size(palette(page).getByTestId('search-section-chats').getByRole('option').first()),
        input: await size(input(page)),
      }
      fs.writeFileSync(path.join(SHOTS!, 'font-sizes.json'), JSON.stringify(sizes, null, 2))
    }
    await input(page).fill('zzz-없음')
    await expect(messages(page)).toHaveCount(0)
    await expect(palette(page).getByTestId('search-section-files')).toBeVisible()
    await shot('palette-empty')
    await input(page).fill('견적')
    await expect(messages(page).getByRole('option')).toHaveCount(6)
    // the jump: Enter on the first message (the chat record is first)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-testid="room-message"][data-highlight]')).toBeInViewport()
    await page.mouse.move(w / 2, 4)
    await shot('room-jump')
    await page.goto(`/rooms/${ROOM}/t/${ROOT}?m=${REPLY}`)
    await expect(page.locator('[data-testid="room-message"][data-highlight]')).toBeVisible()
    await shot('thread-jump')
  })
}
