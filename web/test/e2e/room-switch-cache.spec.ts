// Going back to a room left a moment ago (docs/DECISIONS.md "Rooms left a moment ago open at once", QA TC-401): it shows
// at once from memory, with no loading placeholder, and only what came after its newest message is read (the server's
// newer cursor), never its newest page again. Left part way up with nothing new since, it opens at the same message;
// a message sent there while away shows exactly once, at the newest, in sight (one that came live, one the read after
// brings). Two group rooms through
// page.route (paged like the server: limit, older and newer cursors), live messages through the mock's /__test/publish;
// the rooms are switched as a person does (the sidebar at 1440, the list and ‹ at 390).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ serviceWorkers: 'block' })

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const A = id(9101), B = id(9102)
const BEN = { id: 'ben', name: '벤' }, CY = { id: 'cy', name: '시와' }
const T0 = Date.now() - 86_400_000
const at = (n: number) => new Date(T0 + n * 60_000).toISOString()
const message = (roomId: string, n: number, body: string) => ({
  id: id(roomId === A ? 10_000 + n : 20_000 + n), roomId, seq: n, authorKind: 'user', author: n % 2 ? BEN : CY, askedBy: null, visibility: 'room', body, replyTo: null, mentions: [], files: [], createdAt: at(n), editedAt: null, deletedAt: null,
})
type Msg = ReturnType<typeof message>
/** the server's cursor from a position (base64url JSON, server/src/rooms/service.ts) */
const decode = (c: string | null) => (c ? (JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { n?: string; s?: string }) : null)

interface Mock { messages: Record<string, Msg[]>; reads: { room: string; cursor: { n?: string; s?: string } | null }[] }

async function routeRooms(page: Page): Promise<Mock> {
  const mock: Mock = { messages: { [A]: Array.from({ length: 80 }, (_, i) => message(A, i + 1, `a-${String(i + 1).padStart(3, '0')}`)), [B]: Array.from({ length: 60 }, (_, i) => message(B, i + 1, `b-${String(i + 1).padStart(3, '0')}`)) }, reads: [] }
  const room = (rid: string) => {
    const list = mock.messages[rid]!
    const lastSeq = list.at(-1)!.seq
    return { id: rid, kind: 'group', name: rid === A ? '견적 회의' : '디자인 리뷰', canRename: true, managerId: 'olga', groupId: null, memberCount: 3, peers: [BEN, CY], lastSeq, lastReadSeq: lastSeq,
      unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastMessage: null, muted: false, createdAt: at(-60), activityAt: at(lastSeq) }
  }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/rooms(\/|\?|$)/, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname, method = req.method()
    if (method === 'GET' && p === '/api/rooms') return route.fulfill(json({ items: [room(A), room(B)] }))
    const m = /^\/api\/rooms\/([^/]+)(\/.*)?$/.exec(p)
    const rid = m?.[1] ?? ''
    if (!mock.messages[rid]) return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
    const rest = m?.[2] ?? ''
    if (method === 'GET' && rest === '') return route.fulfill(json(room(rid)))
    if (method === 'GET' && rest === '/members') return route.fulfill(json({ items: [{ id: 'olga', name: 'Olga' }, BEN, CY].map((user) => ({ user, joinedAt: at(-60) })) }))
    if (method === 'GET' && rest === '/ai') return route.fulfill(json({ answering: 0, mine: [] }))
    if (method === 'GET' && rest === '/ai/requests') return route.fulfill(json({ items: [] }))
    if (method === 'POST' && rest === '/read') return route.fulfill(json({ lastReadSeq: room(rid).lastSeq, unreadCount: 0, mentioned: false }))
    if (method === 'GET' && rest === '/messages') {
      const all = mock.messages[rid]!
      const cursor = decode(url.searchParams.get('cursor'))
      mock.reads.push({ room: rid, cursor })
      const limit = Number(url.searchParams.get('limit') ?? 50)
      if (cursor?.n) {
        const after = all.filter((x) => x.seq > Number(cursor.n))
        const items = after.slice(0, limit)
        return route.fulfill(json({ items, nextCursor: null, ...(after.length > limit ? { newerCursor: Buffer.from(JSON.stringify({ n: String(items.at(-1)!.seq) })).toString('base64url') } : {}) }))
      }
      const before = cursor?.s ? all.filter((x) => x.seq < Number(cursor.s)) : all
      const items = before.slice(-limit)
      return route.fulfill(json({ items, nextCursor: before.length > limit ? Buffer.from(JSON.stringify({ s: String(items[0]!.seq) })).toString('base64url') : null }))
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return mock
}

const publish = (page: Page, event: unknown) => page.request.post('/__test/publish', { data: { event } }).then((r) => expect(r.ok()).toBeTruthy())
const scroller = (page: Page) => page.getByTestId('room-scroller')

/** to a room as a person does: the sidebar on a computer; on a phone ‹ to the list, then the room's row */
async function openRoom(page: Page, rid: string, phone: boolean) {
  if (phone) {
    if (await page.getByTestId('room-back').isVisible()) await page.getByTestId('room-back').click()
    await page.locator(`[data-testid="rooms-row"][href="/rooms/${rid}"]`).click()
  } else await page.locator(`[data-testid="sidebar-rooms-list"] a[href="/rooms/${rid}"]`).click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${rid}$`))
}

/** from now on: did a loading placeholder (the skeleton) ever show in the room's list? */
const watchSkeleton = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __skeleton: boolean }
  w.__skeleton = false
  const look = () => { if (document.querySelector('[data-testid="room-scroller"] .animate-pulse')) w.__skeleton = true }
  new MutationObserver(look).observe(document.body, { childList: true, subtree: true })
  look()
})
const sawSkeleton = (page: Page) => page.evaluate(() => (window as unknown as { __skeleton: boolean }).__skeleton)

/** the first message row in sight and how far below the list's top it is */
const firstInSight = (page: Page) => scroller(page).evaluate((el) => {
  const top = el.getBoundingClientRect().top
  const row = [...el.querySelectorAll<HTMLElement>('[data-testid="room-message"]')].find((r) => r.getBoundingClientRect().bottom > top)!
  return { text: row.innerText.split('\n').find((l) => /^[ab]-\d{3}/.test(l)) ?? '', offset: Math.round(row.getBoundingClientRect().top - top) }
})

for (const vp of [{ name: '1440', width: 1440, height: 900, phone: false }, { name: '390', width: 390, height: 844, phone: true }]) {
  test.describe(`at ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('back to a room left part way up: at once at the same message, only what is new read, no placeholder', async ({ page }) => {
      await reset(page)
      const mock = await routeRooms(page)
      await signIn(page)
      if (vp.phone) await page.goto('/rooms')
      await openRoom(page, A, vp.phone)
      await expect(page.getByText('a-080', { exact: true })).toBeVisible()
      // part way up (not so far that the older page loads)
      await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 700 })
      await page.waitForTimeout(400)
      const left = await firstInSight(page)
      expect(left.text).toMatch(/^a-\d{3}$/)

      await openRoom(page, B, vp.phone)
      await expect(page.getByText('b-060', { exact: true })).toBeVisible()
      const before = mock.reads.length
      await watchSkeleton(page)
      await openRoom(page, A, vp.phone)
      // at once: the same message at the same place, no loading placeholder
      await expect(page.getByText(left.text, { exact: true })).toBeVisible()
      expect(await firstInSight(page)).toEqual(left)
      await page.waitForTimeout(800)
      expect(await sawSkeleton(page)).toBe(false)
      // one read of A: from after its newest message, never the newest page again
      expect(mock.reads.slice(before)).toEqual([{ room: A, cursor: { n: '80' } }])
      expect(await firstInSight(page)).toEqual(left)
    })

    test('a message sent while I was away: back at the newest with it in sight, exactly once', async ({ page }) => {
      await reset(page)
      const mock = await routeRooms(page)
      await signIn(page)
      if (vp.phone) await page.goto('/rooms')
      await openRoom(page, A, vp.phone)
      await expect(page.getByText('a-080', { exact: true })).toBeVisible()
      // part way up when leaving: something new since opens at the newest, as before
      await scroller(page).evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 700 })
      await page.waitForTimeout(400)
      await openRoom(page, B, vp.phone)
      await expect(page.getByText('b-060', { exact: true })).toBeVisible()
      // someone writes in A meanwhile: live, and the server has it too
      const live = message(A, 81, 'a-081 while away')
      mock.messages[A]!.push(live)
      await publish(page, { type: 'room.message', data: { roomId: A, message: live } })
      await page.waitForTimeout(300)
      const before = mock.reads.length
      await watchSkeleton(page)
      await openRoom(page, A, vp.phone)
      await expect(page.getByTestId('room-message').filter({ hasText: 'a-081 while away' })).toBeInViewport()
      await page.waitForTimeout(800)
      await expect(page.getByTestId('room-message').filter({ hasText: 'a-081 while away' })).toHaveCount(1)
      expect(await sawSkeleton(page)).toBe(false)
      expect(mock.reads.slice(before)).toEqual([{ room: A, cursor: { n: '81' } }])
    })

    test('left at the bottom: back at the bottom, with what came meanwhile in sight', async ({ page }) => {
      await reset(page)
      const mock = await routeRooms(page)
      await signIn(page)
      if (vp.phone) await page.goto('/rooms')
      await openRoom(page, B, vp.phone)
      await expect(page.getByText('b-060', { exact: true })).toBeVisible()
      await openRoom(page, A, vp.phone)
      await expect(page.getByText('a-080', { exact: true })).toBeVisible()
      // two messages in B while away: one came live, one the live updates did not bring (the read after it does)
      const live = message(B, 61, 'b-061 live')
      const missed = message(B, 62, 'b-062 missed')
      mock.messages[B]!.push(live, missed)
      await publish(page, { type: 'room.message', data: { roomId: B, message: live } })
      await page.waitForTimeout(300)
      const before = mock.reads.length
      await openRoom(page, B, vp.phone)
      await expect(page.getByTestId('room-message').filter({ hasText: 'b-062 missed' })).toBeInViewport()
      await expect(page.getByTestId('room-message').filter({ hasText: 'b-061 live' })).toHaveCount(1)
      await expect(page.getByTestId('room-message').filter({ hasText: 'b-062 missed' })).toHaveCount(1)
      expect(mock.reads.slice(before)).toEqual([{ room: B, cursor: { n: '61' } }])
    })
  })
}
