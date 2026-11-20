// ⌘K room messages like Slack (QA TC-5365, docs/DECISIONS.md "⌘K: from:, in:, phrases, word forms, best match, near
// matches"): from:/in: in the text search only the rooms' messages and files and the section says what they were read
// as; the order is the best match first (정확도순) or the newest (최신순), chosen at the section's end and asked of the
// server; nothing as typed shows near matches as such; a filter that names nobody says so. Enter still opens the room
// at the message. The search answers through page.route, contract-shaped (the mock server lists no rooms).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

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
