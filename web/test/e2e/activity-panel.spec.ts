// 활동 beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P3), with the server's `navRail` switch
// on: the notices that are not conversations on the left (GET /api/notifications?only=notices), chips 전체 · 트리나 · 요청
// (요청 for the owner and admins only), unread first, the rail's 활동 number the same as the list's unread rows; a notice
// opens on the right while 활동 stays lit; one with no page of its own opens as itself; mentions and threads are 대화's
// (one line on top goes there, and an old ?tab=mentions link lands there). With the switch off the Activity page is as it
// was (activity-tabs.spec.ts and the other Activity suites run with it off).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { navRail, reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.ko
const MEMBER = { username: 'bob', password: 'bob password 1' }
const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

type Item = Record<string, unknown>
const notice = (n: number, code: string, minutes: number, o: Item = {}): Item => ({ id: id(n), eventType: code, sourceId: id(n + 1000), code, createdAt: ago(minutes), readAt: null, chatId: null, link: null, outcome: null, ...o })

/** an owner's week: two scheduled runs (one opens its chat), a connection to sign in to again, a skill to review, someone
 * who joined, and one already read; `chatId`: the chat the first run made */
function week(chatId: string): Item[] {
  return [
    notice(1, 'schedule.success', 5, { chatId, link: 'chat', outcome: 'succeeded', schedule: { title: '주간 보고' } }),
    notice(2, 'connection.reconnect', 30, { link: 'connections' }),
    notice(3, 'team.joined', 50, { joined: { name: '민준' } }),
    notice(4, 'schedule.failure', 70, { outcome: 'failed', schedule: { title: '아침 요약' } }),
    notice(5, 'schedule.success', 600, { readAt: ago(500), outcome: 'succeeded', schedule: { title: '월말 정리' } }),
  ]
}

/** GET /api/notifications answered with `items` (only=notices: they are all notices), POST …/read marks one */
async function routeNotices(page: Page, items: Item[]) {
  const asked: string[] = []
  await page.route('**/api/notifications?*', (route) => {
    const url = new URL(route.request().url())
    asked.push(url.searchParams.get('only') ?? '')
    const unread = items.filter((x) => !x.readAt).length
    return route.fulfill({ json: { items: url.searchParams.get('only') === 'rooms' ? [] : items, nextCursor: null, unreadCount: unread, roomUnreadCount: 0, noticeUnreadCount: unread } })
  })
  await page.route(/\/api\/notifications\/[^/]+\/read$/, (route) => {
    const item = items.find((x) => route.request().url().includes(String(x.id)))!
    item.readAt ??= new Date().toISOString()
    return route.fulfill({ json: item })
  })
  await page.route(/\/api\/notifications\/[^/?]+$/, (route) => {
    const item = items.find((x) => route.request().url().endsWith(String(x.id)))
    return item ? route.fulfill({ json: item }) : route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '' } } })
  })
  return asked
}

async function start(page: Page, who?: typeof MEMBER) {
  await page.setViewportSize({ width: 1440, height: 860 })
  await reset(page)
  await navRail(page)
  await signIn(page, who)
  const chat = await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: { title: '주간 보고 결과' } })
  return ((await chat.json()) as { id: string }).id
}

const rows = (page: Page) => page.getByTestId('activity-panel').getByTestId('activity-panel-row')

test('owner: the notices on the left, unread first; chips 전체 · 트리나 · 요청; the rail\'s number is the list\'s', async ({ page }) => {
  const chatId = await start(page)
  const asked = await routeNotices(page, week(chatId))
  await page.reload()
  await page.getByTestId('rail-activity').click()
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  await expect(page.getByTestId('rail-activity')).toHaveAttribute('aria-current', 'page')
  expect(asked).toContain('notices')
  // unread first (newest first), the read one under 읽음
  await expect(rows(page)).toHaveCount(5)
  expect(await rows(page).evaluateAll((els) => els.map((e) => e.hasAttribute('data-unread')))).toEqual([true, true, true, true, false])
  await expect(page.getByTestId('activity-panel-read')).toContainText(t['activity.read'])
  // the rail says 4, as many as the unread rows
  await expect(page.getByTestId('rail-activity-mark')).toHaveAttribute('data-n', '4')
  await expect(page.getByTestId('activity-panel-dot')).toHaveCount(4)
  // the chips: 트리나 the scheduled runs, 요청 the connection
  await expect(page.getByTestId('activity-panel-chips').getByRole('button')).toHaveText([t['feed.tab.all'], '트리나', t['activity.chip.requests']])
  await expect(page.getByTestId('activity-panel-mark-all')).toBeVisible()
  await page.getByTestId('activity-chip-trina').click()
  await expect(rows(page)).toHaveCount(3)
  // "Mark all as read" reads the whole list: only under 전체, never what a chip hides
  await expect(page.getByTestId('activity-panel-mark-all')).toHaveCount(0)
  expect(await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-chip')))).toEqual(['trina', 'trina', 'trina'])
  await page.getByTestId('activity-chip-requests').click()
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toHaveAttribute('data-chip', 'requests')
  // no mention or thread rows here: one line says they are in 대화, and goes there with 대화 lit
  await expect(page.getByTestId('activity-panel-to-chats')).toHaveText(t['activity.inChats'])
  // nothing picked: the right side says where to look
  await expect(page.getByTestId('activity-pick')).toContainText(t['activity.pick'])
  await page.getByTestId('activity-panel-to-chats').click()
  await expect(page).toHaveURL(/\/activity\?in=chats$/)
  await expect(page.getByTestId('rail-chats')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('chats-panel')).toBeVisible()
})

test('a notice opens on the right while 활동 stays lit; it is read; Back and the rail keep 활동', async ({ page }) => {
  const chatId = await start(page)
  await routeNotices(page, week(chatId))
  await page.reload()
  await page.getByTestId('rail-activity').click()
  const first = rows(page).first()
  await first.click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
  await expect(page.getByTestId('rail-activity')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('rail-ai')).not.toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  await expect(first).toHaveAttribute('aria-current', 'page')
  await expect(first).not.toHaveAttribute('data-unread', '')
  await expect(page.getByTestId('rail-activity-mark')).toHaveAttribute('data-n', '3')
  // another place and back: 활동 opens that chat again, still lit
  await page.getByTestId('rail-files').click()
  await expect(page.getByTestId('files-panel')).toBeVisible()
  await page.getByTestId('rail-activity').click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
  await expect(page.getByTestId('rail-activity')).toHaveAttribute('aria-current', 'page')
  // a notice with no page of its own opens as itself
  await rows(page).nth(2).click()
  await expect(page).toHaveURL(/\/activity\?n=/)
  await expect(page.getByTestId('activity-opened').getByTestId('notification-text')).toContainText('아침 요약')
})

test('member: 전체 · 트리나 only (요청 is for the owner and admins)', async ({ page }) => {
  const chatId = await start(page, MEMBER)
  await routeNotices(page, week(chatId))
  await page.reload()
  await page.getByTestId('rail-activity').click()
  await expect(page.getByTestId('activity-panel-chips').getByRole('button')).toHaveText([t['feed.tab.all'], '트리나'])
  await expect(page.getByTestId('activity-chip-requests')).toHaveCount(0)
})

test('"Mark all as read" reads the notices only; an old ?tab=mentions link goes to 대화\'s 멘션·스레드', async ({ page }) => {
  const chatId = await start(page)
  const items = week(chatId)
  await routeNotices(page, items)
  let body: unknown = null
  await page.route('**/api/notifications/read', (route) => {
    body = route.request().postDataJSON()
    for (const x of items) x.readAt ??= new Date().toISOString()
    return route.fulfill({ json: { read: 4 } })
  })
  await page.reload()
  await page.getByTestId('rail-activity').click()
  await page.getByTestId('activity-panel-mark-all').click()
  await expect(page.getByTestId('activity-panel-dot')).toHaveCount(0)
  expect(body).toEqual({ tab: 'all', only: 'notices' })
  await expect(page.getByTestId('rail-activity-mark')).toHaveCount(0)
  await expect(page.getByTestId('activity-panel-mark-all')).toHaveCount(0)
  await page.goto('/activity?tab=mentions')
  await expect(page).toHaveURL(/\/activity\?in=chats&tab=mentions$/)
  await expect(page.getByTestId('rail-chats')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('activity-tab-mentions')).toHaveAttribute('aria-selected', 'true')
})

test('with the switch off, Activity is the page it was: its tabs, no panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 860 })
  await reset(page)
  await signIn(page)
  await page.goto('/activity?tab=mentions')
  await expect(page.getByTestId('activity-tabs')).toBeVisible()
  await expect(page.getByTestId('activity-tab-mentions')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('activity-panel')).toHaveCount(0)
  await expect(page.getByTestId('rail')).toHaveCount(0)
})
