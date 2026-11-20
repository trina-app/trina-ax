// ⌘K room messages like Slack (QA TC-5365, docs/DECISIONS.md "⌘K: from:, in:, phrases, word forms, best match, near
// matches"): from:/in: in the text search only the rooms' messages and files and the section says what they were read
// as; the order is the best match first (정확도순) or the newest (최신순), chosen at the section's end and asked of the
// server; nothing as typed shows near matches as such; a filter that names nobody says so. Enter still opens the room
// at the message. The search answers through page.route, contract-shaped (the mock server lists no rooms).
// And the Slack-style keys and chips (docs/decisions/20261120-search-shortcuts-slack.md, QA TC-5640 to TC-5650): ⌘K;
// ⌘F in a room or a thread opens search with "This conversation" on (room=); ⌘F in an AI chat is the page's find (not
// prevented); a second ⌘F focuses the box; "Sent by me" and "Mentions me" send from:me and mentions:me; Backspace in an
// empty box turns the last chip off; the empty box lists unread conversations (mentions first, not muted or hidden);
// the room's ⋯ at 390 px; Korean input (e.key 'ㄹ', e.code 'KeyF'). ⌘K is ControlOrMeta (either counts); ⌘F follows the
// page's user agent (pressF).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ROOM = id(9101)
const MINJUN = { id: 'minjun', name: '민준' }, SEOYEON = { id: 'seoyeon', name: '서연' }
const at = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString()
const hit = (n: number, author: typeof MINJUN, snippet: string, hours: number) => ({ id: id(n), roomId: ROOM, threadRootId: null, authorKind: 'user', author, askedBy: null, markdown: false, snippet, createdAt: at(hours) })
const ROOMS = [{ id: ROOM, kind: 'team', name: '마케팅', peers: [MINJUN, SEOYEON], memberCount: 3 }]
const BEST = hit(1, MINJUN, 'Q4 budget review 회의는 금요일', 30)
const NEWER = hit(2, MINJUN, 'review the budget 회의 전에', 2)

async function routes(page: Page) {
  const asked: { q: string; sort: string | null }[] = []
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/room-messages\?/, (route) => {
    const u = new URL(route.request().url())
    const q = u.searchParams.get('q') ?? '', sort = u.searchParams.get('sort')
    asked.push({ q, sort })
    if (q.startsWith('from:민준')) return route.fulfill(json({ items: sort === 'recent' ? [NEWER, BEST] : [BEST, NEWER], rooms: ROOMS, nextCursor: null, filters: { from: [MINJUN], in: [], missing: [] } }))
    if (q.startsWith('from:nobody')) return route.fulfill(json({ items: [], rooms: [], nextCursor: null, filters: { from: [], in: [], missing: ['from:nobody'] } }))
    if (q === 'recieve') return route.fulfill(json({ items: [hit(3, SEOYEON, 'Please receive the package', 5)], rooms: ROOMS, nextCursor: null, near: true }))
    return route.fulfill(json({ items: [], rooms: [], nextCursor: null }))
  })
  await page.route(/\/api\/room-files\?/, (route) => route.fulfill(json({ items: [], rooms: [], nextCursor: null })))
  return asked
}

const palette = (page: Page) => page.getByTestId('search-palette')
const input = (page: Page) => palette(page).getByRole('combobox')
const messages = (page: Page) => palette(page).getByTestId('search-section-messages')

test('from: a person: only messages, the section says who; best match first, 최신순 asks again; Enter opens the room at it', async ({ page }) => {
  const asked = await routes(page)
  await reset(page)
  await signIn(page)
  await page.keyboard.press('ControlOrMeta+k')
  await input(page).fill('from:민준 회의를')
  await expect(messages(page)).toBeVisible()
  await expect(messages(page).locator('p').first()).toHaveText('대화 메시지 · 보낸 사람 민준')
  // nothing else is searched with a filter in the text: no chat records, projects or team files
  await expect(palette(page).getByTestId('search-section-chats')).toHaveCount(0)
  await expect(palette(page).getByTestId('search-section-projects')).toHaveCount(0)
  const rows = messages(page).getByRole('option')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).getByTestId('search-message-text')).toContainText('budget review 회의는')
  // the particle is not marked: "회의" is (parseSearch's term)
  await expect(rows.nth(0).locator('mark')).toHaveText('회의')
  expect(asked.at(-1)).toEqual({ q: 'from:민준 회의를', sort: 'relevant' })
  // the order: 정확도순 now; 최신순 asks the server again
  const sort = palette(page).getByTestId('search-sort')
  await expect(sort).toContainText('정확도순')
  await sort.click()
  await page.getByTestId('search-sort-recent').click()
  await expect(sort).toContainText('최신순')
  await expect(rows.nth(0).getByTestId('search-message-text')).toContainText('the budget 회의 전에')
  expect(asked.at(-1)).toEqual({ q: 'from:민준 회의를', sort: 'recent' })
  // the keys are back in the box: Enter opens the first, the room at that message
  await expect(input(page)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}\\?m=${NEWER.id}$`))
})

test('nothing as typed: 비슷한 메시지, no order to choose; a filter that names nobody says so', async ({ page }) => {
  await routes(page)
  await reset(page)
  await signIn(page)
  await page.keyboard.press('ControlOrMeta+k')
  await input(page).fill('recieve')
  await expect(messages(page).locator('p').first()).toHaveText('비슷한 메시지')
  await expect(palette(page).getByTestId('search-sort')).toHaveCount(0)
  await expect(messages(page).getByRole('option')).toHaveCount(1)
  await input(page).fill('from:nobody 견적')
  await expect(palette(page).getByTestId('search-filter-missing')).toHaveText('from:nobody에 맞는 사람이나 내 대화가 없어요.')
  await expect(messages(page)).toHaveCount(0)
})

// ---------------- the Slack-style keys and chips ----------------
const R = (n: number) => `019a5f00-0000-7000-8000-00000000c0${String(n).padStart(2, '0')}`
const BEN = { id: 'ben', name: 'Ben' }, CHO = { id: 'cho', name: 'Cho' }
const SPECS: MockRoomSpec[] = [
  { id: R(1), kind: 'group', name: '디자인 리뷰', peers: [BEN], unread: 2, ago: 1, last: 'new mockups' },
  { id: R(2), kind: 'group', name: '예산', peers: [CHO], unread: 1, mentioned: true, ago: 50, last: '@Olga budget?' },
  { id: R(3), kind: 'group', name: '조용한 방', peers: [BEN], unread: 9, muted: true, mentioned: true, ago: 2, last: 'lunch' },
  { id: R(4), kind: 'dm', name: null, peers: [CHO], unread: 4, hidden: true, ago: 3, last: 'hidden one' },
  { id: R(5), kind: 'group', name: '출시', peers: [BEN, CHO], unread: 3, ago: 5, last: 'ship it' },
  { id: R(6), kind: 'group', name: '마감', peers: [BEN, CHO], unread: 1, ago: 6, last: 'due friday' },
]

/** the room messages and files asked for: their q and room= */
async function routeAsked(page: Page) {
  const asked: { path: string; q: string; room: string | null }[] = []
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/room-(messages|files)\?/, (route) => {
    const u = new URL(route.request().url())
    asked.push({ path: u.pathname, q: u.searchParams.get('q') ?? '', room: u.searchParams.get('room') })
    return route.fulfill(json({ items: [], rooms: [], nextCursor: null, filters: { from: [], in: [], missing: [] } }))
  })
  return asked
}
async function signedIn(page: Page) {
  await reset(page)
  const asked = await routeAsked(page)
  await routeRooms(page, SPECS)
  await signIn(page)
  return asked
}
/** whether the page called preventDefault on the next keydown: read once the event is done (the app's own listener may
 * be added again after this one when search opens and takes a history entry) */
const watchKey = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { lastPrevented?: boolean | null }
  w.lastPrevented = null
  window.addEventListener('keydown', (e) => { if (!['Meta', 'Control'].includes(e.key)) setTimeout(() => { w.lastPrevented = e.defaultPrevented }) })
})
const lastPrevented = async (page: Page) => {
  await page.waitForFunction(() => (window as unknown as { lastPrevented?: boolean | null }).lastPrevented !== null)
  return page.evaluate(() => (window as unknown as { lastPrevented?: boolean | null }).lastPrevented)
}
const chip = (page: Page, c: 'here' | 'mine' | 'mentions') => palette(page).getByTestId(`search-chip-${c}`)
/** ⌘F as the app reads it: ⌘ where the page's user agent is a Mac's, else Ctrl (Playwright's Desktop Chrome says
 * Windows on every host, so ControlOrMeta would send ⌘ to a "Windows" page on a Mac) */
const pressF = async (page: Page) => page.keyboard.press(`${(await page.evaluate(() => /Mac OS X|Macintosh/.test(navigator.userAgent))) ? 'Meta' : 'Control'}+f`)
const lastAsked = (asked: { path: string; q: string; room: string | null }[], path: string) => asked.filter((a) => a.path === path).at(-1)

test('⌘K opens search with no chip on; ⌘F in a room opens it on This conversation and asks with room=', async ({ page }) => {
  const asked = await signedIn(page)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await expect(chip(page, 'here')).toHaveCount(0)
  await expect(chip(page, 'mine')).toHaveAttribute('aria-pressed', 'false')
  await expect(chip(page, 'mentions')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Escape')
  await page.goto(`/rooms/${R(1)}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  await pressF(page)
  await expect(chip(page, 'here')).toHaveAttribute('aria-pressed', 'true')
  // no text: a hint, no request
  await expect(palette(page).getByTestId('search-none')).toHaveText('이 대화에서 찾을 내용을 입력해 주세요.')
  expect(asked).toEqual([])
  await input(page).fill('견적')
  await expect.poll(() => lastAsked(asked, '/api/room-messages')).toEqual({ path: '/api/room-messages', q: '견적', room: R(1) })
  await expect.poll(() => lastAsked(asked, '/api/room-files')).toEqual({ path: '/api/room-files', q: '견적', room: R(1) })
  // the chip off: every room again; no room id anywhere on screen
  await chip(page, 'here').click()
  await expect(chip(page, 'here')).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => lastAsked(asked, '/api/room-messages')?.room).toBeNull()
  await expect(palette(page)).not.toContainText(R(1))
})

test('⌘F in a thread: This conversation; in an AI chat: the page\'s own find (not prevented); elsewhere: as ⌘K', async ({ page }) => {
  await signedIn(page)
  await page.goto(`/rooms/${R(1)}/t/019a5f00-0000-7000-8000-000000000900`)
  await expect(page.getByTestId('app-layout')).toBeVisible()
  await pressF(page)
  await expect(chip(page, 'here')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await page.goto('/c/019a5f00-0000-7000-8000-0000000000ff')
  await expect(page.getByTestId('app-layout')).toBeVisible()
  await watchKey(page)
  await pressF(page)
  expect(await lastPrevented(page)).toBe(false)
  await expect(palette(page)).toHaveCount(0)
  await page.goto('/activity')
  await expect(page.getByTestId('app-layout')).toBeVisible()
  await pressF(page)
  await expect(palette(page)).toBeVisible()
  await expect(chip(page, 'here')).toHaveCount(0)
})

test('a second ⌘F focuses the box and selects its text (prevented: no page find over the box)', async ({ page }) => {
  await signedIn(page)
  await page.goto(`/rooms/${R(1)}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  await pressF(page)
  await input(page).fill('budget')
  await chip(page, 'mine').focus()
  await watchKey(page)
  await pressF(page)
  expect(await lastPrevented(page)).toBe(true)
  await expect(input(page)).toBeFocused()
  expect(await input(page).evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 6])
})

test('Sent by me and Mentions me send from:me and mentions:me; Backspace in an empty box turns the last chip off', async ({ page }) => {
  const asked = await signedIn(page)
  await page.keyboard.press('ControlOrMeta+k')
  await chip(page, 'mine').click()
  await expect(chip(page, 'mine')).toHaveAttribute('aria-pressed', 'true')
  // a chip with no text asks already
  await expect.poll(() => lastAsked(asked, '/api/room-messages')?.q).toBe('from:me')
  await chip(page, 'mentions').click()
  await input(page).fill('견적')
  await expect.poll(() => lastAsked(asked, '/api/room-messages')?.q).toBe('견적 from:me mentions:me')
  // only the rooms' messages and files with a chip on: no chat records
  await expect(palette(page).getByTestId('search-section-chats')).toHaveCount(0)
  await input(page).fill('')
  await input(page).press('Backspace')
  await expect(chip(page, 'mentions')).toHaveAttribute('aria-pressed', 'false')
  await expect(chip(page, 'mine')).toHaveAttribute('aria-pressed', 'true')
  await input(page).press('Backspace')
  await expect(chip(page, 'mine')).toHaveAttribute('aria-pressed', 'false')
})

test('the empty box: up to 3 unread conversations, mentions first, not muted or hidden ones', async ({ page }) => {
  await signedIn(page)
  await page.keyboard.press('ControlOrMeta+k')
  const attention = palette(page).getByTestId('search-section-attention')
  await expect(attention.getByRole('option')).toHaveCount(3)
  await expect(attention.getByTestId('search-row-name')).toHaveText([/^예산/, /^디자인 리뷰/, /^출시/])
  await expect(attention).not.toContainText('조용한 방')
  await expect(attention).not.toContainText('Cho')
  await attention.getByRole('option').first().click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${R(2)}$`))
})

test('Korean input: ⌘ with e.key ㄹ (e.code KeyF) still opens This conversation; nothing while composing', async ({ page }) => {
  await signedIn(page)
  await page.goto(`/rooms/${R(1)}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  const mac = await page.evaluate(() => /Mac OS X|Macintosh/.test(navigator.userAgent))
  const fire = (composing: boolean) => page.evaluate(([m, c]) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ㄹ', code: 'KeyF', metaKey: m, ctrlKey: !m, isComposing: c, bubbles: true, cancelable: true })) }, [mac, composing] as const)
  await fire(true)
  await expect(palette(page)).toHaveCount(0)
  await fire(false)
  await expect(chip(page, 'here')).toHaveAttribute('aria-pressed', 'true')
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('the room ⋯ › Search in this conversation opens search on it; the chips are 44 px tall', async ({ page }) => {
    await signedIn(page)
    await page.goto(`/rooms/${R(1)}`)
    await expect(page.getByTestId('room-message').first()).toBeVisible()
    await page.getByTestId('room-menu').click()
    await page.getByTestId('room-menu-search').click()
    await expect(chip(page, 'here')).toHaveAttribute('aria-pressed', 'true')
    for (const c of ['here', 'mine', 'mentions'] as const) expect((await chip(page, c).boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})

// This conversation + Sent by me + "budget" sends from:me with room=, whichever order the chip and the text come in
test('This conversation + Sent by me sends q "budget from:me" with room=', async ({ page }) => {
  const asked = await signedIn(page)
  await page.goto(`/rooms/${R(1)}`)
  await expect(page.getByTestId('room-message').first()).toBeVisible()
  await pressF(page)
  await expect(chip(page, 'here')).toHaveAttribute('aria-pressed', 'true')
  await chip(page, 'mine').click()
  await input(page).fill('budget')
  await expect.poll(() => lastAsked(asked, '/api/room-messages')).toEqual({ path: '/api/room-messages', q: 'budget from:me', room: R(1) })
  await expect.poll(() => lastAsked(asked, '/api/room-files')).toEqual({ path: '/api/room-files', q: 'budget from:me', room: R(1) })
  // order reversed: Sent by me first, then text, then the chip after typing
  await chip(page, 'mine').click()
  await expect.poll(() => lastAsked(asked, '/api/room-messages')).toEqual({ path: '/api/room-messages', q: 'budget', room: R(1) })
  await chip(page, 'mine').click()
  await expect.poll(() => lastAsked(asked, '/api/room-messages')).toEqual({ path: '/api/room-messages', q: 'budget from:me', room: R(1) })
  // every request that carried "budget" while Sent by me was on had from:me
  expect(asked.filter((a) => a.q === 'budget' && a.path === '/api/room-messages').length).toBeGreaterThan(0)
})

// a narrow computer window (768–811 px): the thread is a sheet with role="dialog" over the room (pages/Room.tsx
// data-sheet); it is the conversation, not another dialog, so ⌘F still opens search on This conversation
test.describe('a narrow window (790 px)', () => {
  test.use({ viewport: { width: 790, height: 860 } })
  test('⌘F on a thread drawn as a sheet opens This conversation', async ({ page }) => {
    await signedIn(page)
    await page.goto(`/rooms/${R(1)}/t/019a5f00-0000-7000-8000-000000000900`)
    await expect(page.locator('[role="dialog"][data-sheet]')).toHaveCount(1)
    await watchKey(page)
    await pressF(page)
    expect(await lastPrevented(page)).toBe(true)
    await expect(chip(page, 'here')).toHaveAttribute('aria-pressed', 'true')
  })
})
