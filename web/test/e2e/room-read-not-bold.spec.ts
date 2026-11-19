// A conversation read to its end is no longer bold (QA TC-5363, docs/decisions/20261119-room-unread-after-read.md): the
// owner opened a bold channel, read it, switched to another one, and the first one stayed bold, on every device. The
// channel had a new reply in a thread they follow (they wrote its root): reading the timeline never reads a thread, and
// the row went by both. As in Slack the row now goes by the timeline; the thread shows in the room (the root's dot, the
// header's thread mark).
// - at 1440: the sidebar row is bold with its number; opened, read, left: plain, and still plain after a reload (what
//   the server says, as on another device), while the room's header still leads to the thread;
// - at 390: the same through the 대화 list.
// The rooms answer through page.route (state like the server's: the read moves lastReadSeq, the followed thread keeps
// threadsUnread). SHOTS_DIR=<folder>: the list after the read, light and dark.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'

test.use({ serviceWorkers: 'block' })

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const READ_ROOM = id(9101), OTHER_ROOM = id(9102)
const ME = { id: 'olga', name: 'Olga' }, BEN = { id: 'ben', name: '벤' }
const T0 = Date.now() - 3_600_000
const at = (n: number) => new Date(T0 + n * 60_000).toISOString()
const ROOT = id(1)

const message = (roomId: string, n: number, body: string, author = BEN, thread: unknown = null) => ({
  id: roomId === READ_ROOM ? id(n) : id(500 + n), roomId, seq: n, authorKind: 'user', author, askedBy: null, visibility: 'room', body, replyTo: null, mentions: [], files: [],
  createdAt: at(n), editedAt: null, deletedAt: null, ...(thread ? { thread } : {}),
})

interface Mock { reads: number[] }

async function routeRooms(page: Page): Promise<Mock> {
  const mock: Mock = { reads: [] }
  // the room read: my message (a thread's root, with Ben's reply in it: seq 2, kept in the thread), then 4 of Ben's
  const thread = { replyCount: 1, lastReplyAt: at(2), repliers: [BEN], newReplies: true }
  const read = [message(READ_ROOM, 1, '견적서 초안 올렸어요', ME, thread), ...[3, 4, 5, 6].map((n) => message(READ_ROOM, n, `인화원 일정 ${n}`))]
  const other = [message(OTHER_ROOM, 1, '다른 채널 메시지')]
  const rooms = () => {
    const lastReadSeq = Math.max(1, ...mock.reads)
    return [
      { id: READ_ROOM, kind: 'group', name: 'LG-인화원', canRename: true, managerId: 'olga', groupId: null, memberCount: 2, peers: [BEN], lastSeq: 6, lastReadSeq,
        unreadCount: read.filter((m) => m.seq > lastReadSeq && m.author.id !== 'olga').length,
        // reading the room never reads the thread (server/src/rooms/service.ts markRead)
        threadsUnread: 1, nextThreadId: ROOT, mentioned: false,
        lastMessage: { id: id(6), seq: 6, author: BEN, excerpt: '인화원 일정 6', fileCount: 0, deleted: false, createdAt: at(6) }, muted: false, createdAt: at(-60), activityAt: at(6) },
      { id: OTHER_ROOM, kind: 'group', name: '영업팀', canRename: true, managerId: 'olga', groupId: null, memberCount: 2, peers: [BEN], lastSeq: 1, lastReadSeq: 1,
        unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false,
        lastMessage: { id: id(501), seq: 1, author: BEN, excerpt: '다른 채널 메시지', fileCount: 0, deleted: false, createdAt: at(-30) }, muted: false, createdAt: at(-60), activityAt: at(-30) },
    ]
  }
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route(/\/api\/rooms(\/|\?|$)/, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const p = url.pathname, method = req.method()
    if (method === 'GET' && p === '/api/rooms') return route.fulfill(json({ items: rooms() }))
    const m = /^\/api\/rooms\/([0-9a-f-]{36})(\/.*)?$/.exec(p)
    const room = m && rooms().find((r) => r.id === m[1])
    if (!m || !room) return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
    const rest = m[2] ?? ''
    if (method === 'GET' && rest === '') return route.fulfill(json(room))
    if (method === 'GET' && rest === '/members') return route.fulfill(json({ items: [ME, BEN].map((user) => ({ user, joinedAt: at(-60) })) }))
    if (method === 'GET' && rest === '/ai') return route.fulfill(json({ answering: 0, mine: [] }))
    if (method === 'GET' && rest === '/ai/requests') return route.fulfill(json({ items: [] }))
    if (method === 'GET' && rest === '/messages') return route.fulfill(json({ items: room.id === READ_ROOM ? read : other, nextCursor: null }))
    if (method === 'POST' && rest === '/read' && room.id === READ_ROOM) {
      const { seq } = req.postDataJSON() as { seq: number }
      mock.reads.push(Math.min(seq, 6))
      const r = rooms()[0]!
      return route.fulfill(json({ lastReadSeq: r.lastReadSeq, unreadCount: r.unreadCount, mentioned: false }))
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  return mock
}

const shot = async (page: Page, name: string) => {
  const dir = process.env.SHOTS_DIR
  if (!dir) return
  fs.mkdirSync(dir, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(dir, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test.describe('at 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('read a channel with a followed thread\'s new reply, switch away: its row is not bold, after a reload too', async ({ page }) => {
    await reset(page)
    const mock = await routeRooms(page)
    await signIn(page)
    await page.goto(`/rooms/${OTHER_ROOM}`)
    const row = page.getByTestId('sidebar-room-row').filter({ hasText: 'LG-인화원' })
    const link = row.getByTestId('sidebar-room')
    // unread: bold with its number (the 4 messages of the timeline; the thread's reply is not one of them)
    await expect(link).toHaveClass(/font-semibold/)
    await expect(row.getByTestId('room-unread')).toContainText('4')
    await shot(page, 'room-unread-before-1440')
    await link.click()
    await expect(page.getByText('인화원 일정 6')).toBeVisible()
    await expect.poll(() => mock.reads.at(-1) ?? 0).toBe(6)
    // the thread still leads somewhere: the header's thread mark
    await expect(page.getByTestId('room-next-thread')).toBeVisible()
    await page.getByTestId('sidebar-room-row').filter({ hasText: '영업팀' }).getByTestId('sidebar-room').click()
    await expect(page.getByText('다른 채널 메시지')).toBeVisible()
    await expect(link).not.toHaveAttribute('aria-current', 'page')
    await expect(link).not.toHaveClass(/font-semibold/)
    await expect(row.getByTestId('room-unread')).toHaveCount(0)
    await expect(row.getByTestId('room-unread-bold')).toHaveCount(0)
    await shot(page, 'room-read-after-1440')
    // what the server says now (another window or device reads the same): plain
    await page.reload()
    await expect(page.getByText('다른 채널 메시지')).toBeVisible()
    await expect(link).not.toHaveClass(/font-semibold/)
    await expect(row.getByTestId('room-unread')).toHaveCount(0)
  })
})

test.describe('at 390', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the 대화 list: read the channel, back to the list, its row is not bold', async ({ page }) => {
    await reset(page)
    const mock = await routeRooms(page)
    await signIn(page)
    await page.goto('/rooms')
    const row = page.getByTestId('rooms-row').filter({ hasText: 'LG-인화원' })
    await expect(row.locator('.font-semibold')).toHaveCount(1)
    await expect(row.getByTestId('rooms-row-unread')).toContainText('4')
    await row.click()
    await expect(page.getByText('인화원 일정 6')).toBeVisible()
    await expect.poll(() => mock.reads.at(-1) ?? 0).toBe(6)
    await page.goBack()
    await expect(row).toBeVisible()
    await expect(row.locator('.font-semibold')).toHaveCount(0)
    await expect(row.getByTestId('rooms-row-unread')).toHaveCount(0)
    await shot(page, 'room-read-after-390')
  })
})
