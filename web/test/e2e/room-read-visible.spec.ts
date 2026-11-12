// A room is read only as far as it was shown (QA TC-155), and a reply from a search result lands at the newest:
// - more unread messages than one page: the newest page alone reads nothing; scrolling up loads the first unread ones,
//   and back at the bottom the room is read to the newest;
// - opened from a notice with its first page slow: a message that comes meanwhile, alone on screen, reads nothing; the
//   read waits for the page;
// - a reply sent from a window around an older message (a search result, ?m=): the newest messages with the reply in
//   sight at the bottom, ?m= gone.
// At 1440 and 390. The room answers through page.route (paged like the server: limit, cursor, around); live messages
// through the mock's /__test/publish. SHOTS_DIR=<folder>: screenshots of each state.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ serviceWorkers: 'block' })

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ROOM = id(9001)
const BEN = { id: 'ben', name: '벤' }, CY = { id: 'cy', name: '시와' }
const T0 = Date.now() - 86_400_000
const at = (n: number) => new Date(T0 + n * 60_000).toISOString()
const PAGE = 50
const message = (n: number, body = `c-${String(n).padStart(3, '0')}`, author: { id: string; name: string } = BEN) => ({
  id: id(n), roomId: ROOM, seq: n, authorKind: 'user', author, askedBy: null, visibility: 'room', body, replyTo: null, mentions: [], files: [], createdAt: at(n), editedAt: null, deletedAt: null,
})

interface Mock { reads: { seq: number; loaded: number }[]; pages: string[]; messages: ReturnType<typeof message>[] }

/** a group room of `count` messages, the newest `unread` of them unread; the message page reads wait `delay` ms */
async function routeRoom(page: Page, o: { count: number; unread: number; delay?: number }): Promise<Mock> {
  const messages = Array.from({ length: o.count }, (_, i) => message(i + 1, i + 1 === 20 ? 'c-020 견적서초안' : undefined))
  const mock: Mock = { reads: [], pages: [], messages }
  const room = () => {
    const lastSeq = messages.at(-1)!.seq
    const lastReadSeq = Math.max(o.count - o.unread, ...mock.reads.map((r) => r.seq))
    return { id: ROOM, kind: 'group', name: '견적 회의', canRename: true, managerId: 'olga', groupId: null, memberCount: 3, peers: [BEN, CY], lastSeq, lastReadSeq,
      unreadCount: messages.filter((m) => m.seq > lastReadSeq && m.author.id !== 'olga').length, threadsUnread: 0, nextThreadId: null, mentioned: false, lastMessage: null, muted: false, createdAt: at(-60), activityAt: at(lastSeq) }
  }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/rooms(\/|\?|$)/, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname, method = req.method()
    if (method === 'GET' && p === '/api/rooms') return route.fulfill(json({ items: [room()] }))
    if (method === 'GET' && p === `/api/rooms/${ROOM}`) return route.fulfill(json(room()))
    if (method === 'GET' && p === `/api/rooms/${ROOM}/members`) return route.fulfill(json({ items: [{ id: 'olga', name: 'Olga' }, BEN, CY].map((user) => ({ user, joinedAt: at(-60) })) }))
    if (method === 'GET' && p === `/api/rooms/${ROOM}/ai`) return route.fulfill(json({ answering: 0, mine: [] }))
    if (method === 'GET' && p === `/api/rooms/${ROOM}/ai/requests`) return route.fulfill(json({ items: [] }))
    if (method === 'GET' && p === `/api/rooms/${ROOM}/messages`) {
      mock.pages.push(url.search)
      if (o.delay) await new Promise((r) => setTimeout(r, o.delay))
      const limit = Number(url.searchParams.get('limit') ?? PAGE), cursor = url.searchParams.get('cursor'), around = url.searchParams.get('around')
      const all = messages
      // cursors: "o<seq>" older than seq, "n<seq>" newer than seq
      let from: number, to: number
      if (around) { const i = all.findIndex((m) => m.id === around); from = Math.max(0, i - limit / 2); to = Math.min(all.length, from + limit) }
      else if (cursor?.startsWith('o')) { const i = all.findIndex((m) => m.seq === Number(cursor.slice(1))); to = i; from = Math.max(0, i - limit) }
      else if (cursor?.startsWith('n')) { const i = all.findIndex((m) => m.seq === Number(cursor.slice(1))); from = i + 1; to = Math.min(all.length, from + limit) }
      else { to = all.length; from = Math.max(0, to - limit) }
      const items = all.slice(from, to)
      return route.fulfill(json({ items, nextCursor: from > 0 ? `o${items[0]!.seq}` : null, ...(to < all.length ? { newerCursor: `n${items.at(-1)!.seq}` } : {}) }))
    }
    if (method === 'POST' && p === `/api/rooms/${ROOM}/read`) {
      const { seq } = req.postDataJSON() as { seq: number }
      const shown = await page.getByTestId('room-message').count()
      mock.reads.push({ seq, loaded: shown })
      const r = room()
      return route.fulfill(json({ lastReadSeq: r.lastReadSeq, unreadCount: r.unreadCount, mentioned: false }))
    }
    if (method === 'POST' && p === `/api/rooms/${ROOM}/messages`) {
      const b = req.postDataJSON() as { body: string; clientMessageId: string }
      const m = { ...message(messages.at(-1)!.seq + 1, b.body, { id: 'olga', name: 'Olga' }), clientId: b.clientMessageId }
      messages.push(m)
      return route.fulfill(json(m, 201))
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  await page.route('**/api/room-messages?*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    items: [{ id: id(20), roomId: ROOM, threadRootId: null, authorKind: 'user', author: BEN, askedBy: null, markdown: false, snippet: 'c-020 견적서초안', createdAt: at(20) }], nextCursor: null, rooms: [room()] }) }))
  return mock
}

const publish = (page: Page, event: unknown) => page.request.post('/__test/publish', { data: { event } }).then((r) => expect(r.ok()).toBeTruthy())
const scroller = (page: Page) => page.getByTestId('room-scroller')
const toTop = (page: Page) => scroller(page).evaluate((el) => { el.scrollTop = 0 })
const toBottom = (page: Page) => scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
const inSight = (page: Page, text: string) => page.getByTestId('room-message').filter({ hasText: text }).evaluate((el) => {
  const r = el.getBoundingClientRect(), s = document.querySelector('[data-testid="room-scroller"]')!.getBoundingClientRect()
  return r.bottom > s.top && r.top < s.bottom
})
const shot = async (page: Page, name: string) => {
  if (!process.env.SHOTS_DIR) return
  fs.mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${name}.png`) })
}

for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]) {
  test.describe(`at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('more unread than one page: the newest page reads nothing; scrolled up and back, the room is read', async ({ page }) => {
      await reset(page)
      const mock = await routeRoom(page, { count: 120, unread: 62 })
      await signIn(page)
      await page.goto(`/rooms/${ROOM}`)
      await expect(page.getByTestId('room-message')).toHaveCount(PAGE)
      await expect(page.getByTestId('room-message').last()).toBeInViewport()
      // the first unread (c-059) is not loaded: the bottom in sight reads nothing
      await page.waitForTimeout(1500)
      expect(mock.reads).toEqual([])
      await shot(page, `room-read-backlog-${vp.name}`)
      // up to the older page: it loads, and what is in sight there is read (never past the newest message in sight)
      await toTop(page)
      await expect(page.getByText('c-059', { exact: true })).toBeAttached()
      await toBottom(page)
      await expect.poll(() => mock.reads.at(-1)?.seq ?? 0).toBe(120)
      expect(mock.reads.every((r) => r.loaded > PAGE)).toBe(true)
    })

    test('opened from a notice with the first page slow: a message that came meanwhile reads nothing until the page shows', async ({ page }) => {
      await reset(page)
      const mock = await routeRoom(page, { count: 30, unread: 30, delay: 2500 })
      await signIn(page)
      await page.goto(`/rooms/${ROOM}`)
      await expect.poll(() => mock.pages.length).toBe(1)
      const live = message(31, 'live-001')
      mock.messages.push(live)
      await publish(page, { type: 'room.message', data: { roomId: ROOM, message: live } })
      await expect(page.getByText('live-001')).toBeVisible()
      await page.waitForTimeout(800)
      // the page is still on its way: only the live message is listed, and nothing is read
      expect(mock.reads).toEqual([])
      await shot(page, `room-read-slow-${vp.name}`)
      await expect(page.getByTestId('room-message')).toHaveCount(31)
      await expect.poll(() => mock.reads.at(-1)?.seq ?? 0).toBe(31)
      expect(mock.reads[0]!.loaded).toBe(31)
    })

    test('a reply from a search result lands at the newest with the reply in sight, ?m= gone', async ({ page }) => {
      await reset(page)
      await routeRoom(page, { count: 120, unread: 0 })
      await signIn(page)
      await page.goto(`/rooms/${ROOM}?m=${id(20)}`)
      await expect(page.locator('[data-testid="room-message"][data-highlight]')).toContainText('c-020')
      await expect(page.getByTestId('room-to-newest')).toBeVisible()
      const box = page.getByTestId('room-composer').getByRole('textbox')
      await box.fill('olga-reply')
      await box.press('Enter')
      await expect(page.getByTestId('room-message').filter({ hasText: 'olga-reply' })).toHaveCount(1)
      await expect.poll(() => inSight(page, 'olga-reply')).toBe(true)
      await expect(page).not.toHaveURL(/[?&]m=/)
      await expect(page.getByTestId('room-to-newest')).toHaveCount(0)
      await expect(page.getByText('c-120', { exact: true })).toBeAttached()
      // it stays there (nothing moves it back up)
      await page.waitForTimeout(1500)
      expect(await inSight(page, 'olga-reply')).toBe(true)
      await shot(page, `room-reply-from-search-${vp.name}`)
    })
  })
}
