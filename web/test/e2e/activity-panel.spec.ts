// 활동 beside the rail (docs/AGENTS/plan/20261112-1839-nav-rail.md §2.1, phase P3), with the server's `navRail` switch
// on: the one Activity (docs/decisions/20261126-one-activity.md, 20261127-activity-lean.md): every notice on the left
// (GET /api/notifications, no only=), one line of filters 전체 · 멘션 · 스레드 · "⋯" (DM · 트리나 · 요청, 요청 for the owner
// and admins only; a pick from it shows as its own chip), newest first, the 안 읽음 switch, the rail's 활동 number the same
// as the list's unread rows; a notice opens on the right while 활동 stays lit; one with no page of its own opens as
// itself; a mention opens its room with 활동 lit; an old ?tab=mentions or ?in=chats link picks its filter.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { navRail, openRail, reset, signIn } from './helpers'
import { DICTS, translate } from '../../src/i18n'

const t = DICTS.ko
const tr = (key: 'activity.chip.trinaDid', params: Record<string, string>) => translate('ko', key, params)
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

/** GET /api/notifications answered with `items`, POST …/read marks one */
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

/** where the two-notices test saves its 1440 and 390 shots (none unless set) */
const SHOTS = process.env.SHOTS_DIR
const rows = (page: Page) => page.getByTestId('activity-panel').getByTestId('activity-panel-row')
/** the filters on the line, by their test ids ("more": the "⋯") */
const line = (page: Page) => page.getByTestId('activity-panel-chips').locator('button[data-testid^="activity-chip-"]').evaluateAll((els) => els.map((e) => String(e.getAttribute('data-testid')).replace('activity-chip-', '')))
/** a filter of the "⋯" menu */
async function pickMore(page: Page, chip: string) {
  await page.getByTestId('activity-chip-more').click()
  await page.getByTestId(`activity-more-${chip}`).click()
}

test('owner: the notices on the left, newest first; 전체 · 멘션 · 스레드 · ⋯ (DM · 트리나 · 요청); the rail\'s number is the list\'s', async ({ page }) => {
  const chatId = await start(page)
  const asked = await routeNotices(page, week(chatId))
  await page.reload()
  await page.getByTestId('rail-activity').click()
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  await expect(page.getByTestId('rail-activity')).toHaveAttribute('aria-current', 'page')
  // the list asks for every notice (store/chatMentions.ts reads its conversation rows with only=rooms on its own)
  expect(asked).toContain('')
  expect(asked).not.toContain('notices')
  // newest first, read and unread together (no 읽음 section)
  await expect(rows(page)).toHaveCount(5)
  expect(await rows(page).evaluateAll((els) => els.map((e) => e.hasAttribute('data-unread')))).toEqual([true, true, true, true, false])
  await expect(page.getByTestId('activity-panel-read')).toHaveCount(0)
  // no gear in the panel: the empty right side has the settings link
  await expect(page.getByTestId('activity-panel-settings')).toHaveCount(0)
  await expect(page.getByTestId('activity-pick-settings')).toHaveAttribute('href', '/settings/notifications')
  // the rail says 4, as many as the unread rows
  await expect(page.getByTestId('rail-activity-mark')).toHaveAttribute('data-n', '4')
  await expect(page.getByTestId('activity-panel-dot')).toHaveCount(4)
  // the line: 전체 · 멘션 · 스레드 · ⋯, one row; ⋯ holds DM, 트리나 (the scheduled runs) and 요청 (the connection), its dot
  // for what is unread there
  await expect.poll(() => line(page)).toEqual(['all', 'mentions', 'threads', 'more'])
  await expect(page.getByTestId('activity-chip-more-dot')).toHaveCount(1)
  await page.getByTestId('activity-chip-more').click()
  await expect(page.getByRole('menu').locator('[data-menu-label]')).toHaveText([t['feed.tab.dms'], tr('activity.chip.trinaDid', { name: '트리나' }), t['activity.chip.requests']])
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('activity-panel-mark-all')).toBeVisible()
  await pickMore(page, 'trina')
  // picked, 트리나 shows as its own chip before "⋯"; "⋯" stays "⋯"
  await expect.poll(() => line(page)).toEqual(['all', 'mentions', 'threads', 'trina', 'more'])
  await expect(page.getByTestId('activity-chip-trina')).toHaveAttribute('aria-pressed', 'true')
  await expect(rows(page)).toHaveCount(3)
  // "Mark all as read" is the server's tabs': never under 트리나 or 요청, which the server cannot read alone
  await expect(page.getByTestId('activity-panel-mark-all')).toHaveCount(0)
  expect(await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-chip')))).toEqual(['trina', 'trina', 'trina'])
  await pickMore(page, 'requests')
  await expect(rows(page)).toHaveCount(1)
  await expect.poll(() => line(page)).toEqual(['all', 'mentions', 'threads', 'requests', 'more'])
  await expect(rows(page).first()).toHaveAttribute('data-chip', 'requests')
  // no line to 대화's 멘션·스레드 any more: they are here
  await expect(page.getByTestId('activity-panel-to-chats')).toHaveCount(0)
  // nothing picked: the right side says where to look
  await expect(page.getByTestId('activity-pick')).toContainText(t['activity.pick'])
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
  // a notice with no page of its own opens as itself (newest first: the failed run is the fourth)
  await rows(page).nth(3).click()
  await expect(page).toHaveURL(/\/activity\?n=/)
  await expect(page.getByTestId('activity-opened').getByTestId('notification-text')).toContainText('아침 요약')
})

test('a job\'s notice opens the chat 트리나 showed last: every rail place still answers, 트리나 first (owner, 11-22)', async ({ page }) => {
  const chatId = await start(page)
  // "'…'에서 부탁한 작업을 트리나가 마쳤어요": a job the AI ran in the chat on screen, so 트리나's last chat is the notice's
  const job = notice(9, 'dev_env.job', 1, { chatId, link: 'chat', devEnv: { projectId: '', projectName: '', job: { name: 'ffmpeg', exitCode: 0, chatTitle: '주간 보고 결과' } } })
  await routeNotices(page, [job, ...week(chatId).slice(1)])
  // 트리나 shows the chat first, so it is what 트리나 reopens: the same address as the notice's
  await page.goto(`/c/${chatId}`)
  await expect(page.getByTestId('rail-ai')).toHaveAttribute('aria-current', 'page')
  await page.getByTestId('rail-activity').click()
  await expect(rows(page).first()).toContainText('부탁한 작업을 트리나가 마쳤어요')
  await rows(page).first().click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
  await expect(page.getByTestId('rail-activity')).toHaveAttribute('aria-current', 'page')
  // 트리나: its list and its light, on the same chat
  await page.getByTestId('rail-ai').click()
  await expect(page.getByTestId('rail-ai')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('rail-activity')).not.toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('activity-panel')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
  // each other place, from that notice's chat again
  for (const item of ['chats', 'projects', 'files', 'ai', 'activity'] as const) {
    await page.getByTestId('rail-activity').click()
    await expect(page.getByTestId('rail-activity')).toHaveAttribute('aria-current', 'page')
    await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
    await openRail(page, item)
  }
})

test('member: no 요청 in "⋯" (it is for the owner and admins)', async ({ page }) => {
  const chatId = await start(page, MEMBER)
  await routeNotices(page, week(chatId))
  await page.reload()
  await page.getByTestId('rail-activity').click()
  await expect.poll(() => line(page)).toEqual(['all', 'mentions', 'threads', 'more'])
  await page.getByTestId('activity-chip-more').click()
  await expect(page.getByRole('menu').locator('[data-menu-label]')).toHaveText([t['feed.tab.dms'], tr('activity.chip.trinaDid', { name: '트리나' })])
  await expect(page.getByTestId('activity-more-requests')).toHaveCount(0)
})

// QA TC-1088: with no notification the right side said both "No notifications yet." and "Pick a notification on the
// left"; with only read ones it said "No notifications yet."
test('the right side: no pick hint while the list is empty; with notices, the hint and never "No notifications yet."', async ({ page }) => {
  const chatId = await start(page, MEMBER)
  const items: Item[] = []
  await routeNotices(page, items)
  await page.reload()
  await page.getByTestId('rail-activity').click()
  await expect(page.getByTestId('activity-panel-empty')).toHaveText(t['notifications.empty'])
  await expect(page.getByTestId('activity-pick')).toContainText(t['notifications.empty'])
  await expect(page.getByTestId('activity-pick-hint')).toHaveCount(0)
  // only notices already read: the hint, no "nothing yet"
  items.push(...week(chatId).map((x) => ({ ...x, readAt: ago(1) })))
  await page.reload()
  await expect(rows(page)).toHaveCount(5)
  await expect(page.getByTestId('activity-pick-hint')).toHaveText(t['activity.pick'])
  await expect(page.getByTestId('activity-pick')).not.toContainText(t['notifications.empty'])
})

test('"Mark all as read" reads every notice; an old ?tab=mentions or ?in=chats link picks its chip in 활동', async ({ page }) => {
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
  expect(body).toEqual({ tab: 'all' })
  await expect(page.getByTestId('rail-activity-mark')).toHaveCount(0)
  await expect(page.getByTestId('activity-panel-mark-all')).toHaveCount(0)
  await page.goto('/activity?tab=mentions')
  await expect(page).toHaveURL(/\/activity\?tab=mentions$/)
  await expect(page.getByTestId('rail-activity')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('activity-chip-mentions')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('activity-panel-empty')).toHaveText(t['feed.emptyFiltered'])
  // 대화's old 멘션·스레드 link: the one Activity, its tab kept, never a 404
  await page.goto('/activity?in=chats&tab=threads')
  await expect(page).toHaveURL(/\/activity\?tab=threads$/)
  await expect(page.getByTestId('rail-activity')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('activity-chip-threads')).toHaveAttribute('aria-pressed', 'true')
  await page.goto('/activity?in=chats')
  await expect(page).toHaveURL(/\/activity$/)
  await expect(page.getByTestId('activity-panel')).toBeVisible()
  // DM (in "⋯"): a link still picks it, as its own chip; it says where plain DMs are
  await page.goto('/activity?tab=dms')
  await expect(page.getByTestId('activity-chip-dms')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => line(page)).toEqual(['all', 'mentions', 'threads', 'dms', 'more'])
  await expect(page.getByTestId('activity-panel-empty')).toHaveText(t['feed.dmsEmpty'])
})

test('a chip picked after a link stays on Back: the address follows the chip, Back never puts the link\'s chip back', async ({ page }) => {
  const chatId = await start(page)
  await routeNotices(page, week(chatId))
  await page.goto('/activity?tab=threads')
  await expect(page.getByTestId('activity-chip-threads')).toHaveAttribute('aria-pressed', 'true')
  await pickMore(page, 'trina')
  await expect(page).toHaveURL(/\/activity\?tab=trina$/)
  // a notice opens on the right; Back: 활동 with 트리나 still picked
  await rows(page).first().click()
  await expect(page).toHaveURL(new RegExp(`/c/${chatId}$`))
  await page.goBack()
  await expect(page).toHaveURL(/\/activity\?tab=trina$/)
  await expect(page.getByTestId('activity-chip-trina')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('activity-chip-threads')).toHaveAttribute('aria-pressed', 'false')
})

// Two people joined one project: both notices open that project. Only the one opened is selected (a fill, semibold),
// the other stays read-looking; 활동 reopened from the rail keeps it; on a phone (no panel) the
// list never shows a read notice in bold.
test('two notices to one project: only the one opened is selected, at 1440 and 390', async ({ page }) => {
  await start(page)
  const H = { [CSRF_HEADER]: '1' }
  const project = ((await (await page.request.post('/api/projects', { headers: H, data: { name: 'Acme', scope: 'team', folderPath: 'acme', instructions: '' } })).json()) as { id: string }).id
  const joinedOne = (n: number, who: string, minutes: number): Item => notice(n, 'project.joined', minutes, { readAt: ago(1), projectJoined: { name: who, project: { id: project, name: 'Acme' } } })
  await routeNotices(page, [joinedOne(11, '민준', 5), joinedOne(12, '지아', 9)])
  await page.reload()
  await page.getByTestId('rail-activity').click()
  const two = rows(page)
  await expect(two).toHaveCount(2)
  const text = (i: number) => two.nth(i).getByTestId('activity-panel-text')
  for (const i of [0, 1]) await expect(text(i)).not.toHaveClass(/font-semibold/)
  await two.nth(1).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  await expect(two.nth(1)).toHaveAttribute('aria-current', 'page')
  await expect(two.nth(0)).not.toHaveAttribute('aria-current', 'page')
  await expect(text(1)).toHaveClass(/font-semibold/)
  await expect(text(0)).not.toHaveClass(/font-semibold/)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/activity-one-selected-1440-light.png` })
  // the other one: it alone
  await two.nth(0).click()
  await expect(two.nth(0)).toHaveAttribute('aria-current', 'page')
  await expect(two.nth(1)).not.toHaveAttribute('aria-current', 'page')
  // another place, a reload, and back: 활동 reopens that project with the same notice selected
  await page.getByTestId('rail-files').click()
  await expect(page.getByTestId('files-panel')).toBeVisible()
  await page.reload()
  await page.getByTestId('rail-activity').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  await expect(two.nth(0)).toHaveAttribute('aria-current', 'page')
  await expect(two.nth(1)).not.toHaveAttribute('aria-current', 'page')
  // the same project opened from 프로젝트's list: that list's row is selected, 활동 is not lit (its panel is gone)
  await page.getByTestId('rail-projects').click()
  await page.getByTestId('projects-panel-row').filter({ hasText: 'Acme' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  await expect(page.getByTestId('rail-projects')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('activity-panel')).toHaveCount(0)

  // a phone: 활동 is a page of its own, nothing in it looks selected, and a read notice is never bold
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/activity')
  const items = page.getByTestId('notification-item')
  await expect(items).toHaveCount(2)
  for (const i of [0, 1]) {
    await expect(items.nth(i).locator('[aria-current="page"]')).toHaveCount(0)
    await expect(items.nth(i).locator('.font-bold, .font-semibold')).toHaveCount(0)
  }
  await items.nth(1).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`/projects/${project}$`))
  await page.goBack()
  await expect(items).toHaveCount(2)
  for (const i of [0, 1]) await expect(items.nth(i).locator('[aria-current="page"], .font-bold, .font-semibold')).toHaveCount(0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/activity-one-selected-390-light.png` })
})

// docs/decisions/20261127-activity-lean.md: 안 읽음 is a switch, off by default, remembered in this browser and the same
// switch as the phone page's; with nothing unread it says so and offers the whole list again
test('안 읽음: only the unread rows, remembered over a reload and shared with the phone; all read: "모두 읽었어요." and "모두 보기"', async ({ page }) => {
  const chatId = await start(page)
  const items = week(chatId)
  await routeNotices(page, items)
  await page.reload()
  await page.getByTestId('rail-activity').click()
  const unreads = page.getByTestId('activity-panel-unreads')
  await expect(unreads).toHaveAttribute('aria-pressed', 'false')
  await expect(unreads).toHaveText(t['feed.unreads'])
  await expect(rows(page)).toHaveCount(5)
  await unreads.click()
  await expect(rows(page)).toHaveCount(4)
  // a row read while the list is open stays until the switch is flipped or the list opens again
  await rows(page).nth(3).click()
  await expect(page).toHaveURL(/\/activity\?n=/)
  await expect(rows(page)).toHaveCount(4)
  await expect(rows(page).nth(3)).not.toHaveAttribute('data-unread', '')
  await page.reload()
  await expect(page.getByTestId('activity-panel-unreads')).toHaveAttribute('aria-pressed', 'true')
  await expect(rows(page)).toHaveCount(3)
  // the phone's page: the same switch, on
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/activity')
  await expect(page.getByTestId('activity-unreads')).toHaveAttribute('aria-pressed', 'true')
  await page.setViewportSize({ width: 1440, height: 860 })
  // everything read: all caught up, and "모두 보기" turns the switch off
  for (const x of items) x.readAt ??= ago(1)
  await page.goto('/activity')
  await expect(page.getByTestId('activity-panel-empty')).toContainText(t['feed.caughtUp'])
  await page.getByTestId('activity-panel-show-all').click()
  await expect(rows(page)).toHaveCount(5)
  await expect(page.getByTestId('activity-panel-unreads')).toHaveAttribute('aria-pressed', 'false')
})

// one line that never wraps: a chip with no room moves into "⋯" (스레드 first), 전체 and a picked filter stay, "⋯" is
// never pushed out; below a 1052 px window the switch is its bell (the word its name and tooltip)
for (const locale of ['ko', 'en', 'id', 'ja', 'es'] as const) {
  test(`one filter line at 240 and 288 px in ${locale}; the switch's bell below 1052`, async ({ page }) => {
    const d = DICTS[locale]
    await page.setViewportSize({ width: 1100, height: 760 })
    await reset(page, { teamLocale: locale, usersFollowTeam: true })
    await signIn(page)
    const chat = await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: { title: 'Weekly' } })
    await routeNotices(page, week(((await chat.json()) as { id: string }).id))
    const fits = async (title = true) => {
      const box = page.getByTestId('activity-panel-chips')
      const panel = (await page.getByTestId('activity-panel').boundingBox())!
      const more = (await page.getByTestId('activity-chip-more').boundingBox())!
      // one line (28 px chips, the 4 px above), "⋯" inside the panel, every chip before it
      expect((await box.boundingBox())!.height).toBeLessThanOrEqual(34)
      expect(more.x + more.width).toBeLessThanOrEqual(panel.x + panel.width)
      for (const c of await box.locator('button[data-testid^="activity-chip-"]:not([data-testid="activity-chip-more"])').all()) {
        const b = (await c.boundingBox())!
        expect(b.x + b.width).toBeLessThanOrEqual(more.x)
      }
      // the title is never cut (below 1052 the hide button joins the header, and a long title such as Japanese's
      // アクティビティ is cut there, as it was with the gear)
      if (title) expect(await page.getByTestId('panel-title').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
    }
    for (const width of [1100, 1440]) {
      await page.setViewportSize({ width, height: 760 })
      await page.goto('/activity')
      await expect(rows(page)).toHaveCount(5)
      await expect(page.getByTestId('activity-panel-unreads')).toHaveText(d['feed.unreads'])
      await fits()
      // a picked menu filter: its own chip, "⋯" still there
      await pickMore(page, 'requests')
      await expect(page.getByTestId('activity-chip-requests')).toHaveAttribute('aria-pressed', 'true')
      await fits()
      // a chip that moved is in the menu, and works from there
      const moved = await page.getByTestId('activity-chip-threads').count() ? null : 'threads'
      if (moved) {
        await page.getByTestId('activity-chip-more').click()
        await expect(page.getByTestId('activity-more-threads')).toBeVisible()
        await page.keyboard.press('Escape')
      }
      await page.getByTestId('activity-chip-all').click()
      if (SHOTS && (locale === 'ko' || locale === 'es')) await page.getByTestId('activity-panel').screenshot({ path: `${SHOTS}/activity-line-${width}-${locale}.png` })
    }
    // below 1052: the bell, named by the word
    await page.setViewportSize({ width: 1000, height: 760 })
    const bell = page.getByTestId('activity-panel-unreads')
    await expect(bell).toHaveAttribute('aria-label', d['feed.unreads'])
    await expect(bell).toHaveText('')
    await fits(locale !== 'ja')
  })
}

test('rows are two lines: where and when, then who and the line; a 1:1 DM names its person once', async ({ page }) => {
  await start(page)
  const room = (n: number, kind: string, o: Item) => notice(n, 'room.mention', n, { link: 'room', room: { id: id(n + 500), kind, message: id(n + 600), count: 1, people: 1, at: ago(n), reason: 'mention', ...o } })
  await routeNotices(page, [
    room(1, 'team', { name: '마케팅', from: '김민지', fromId: 'minji', preview: '@다현 이번 주 캠페인 시안 확인 부탁드려요. 금요일까지 꼭 봐 주세요.', thread: id(900) }),
    room(2, 'dm', { name: null, from: '이서연', fromId: 'seoyeon', preview: '파일 확인했어요' }),
  ])
  await page.reload()
  await page.getByTestId('rail-activity').click()
  await expect(rows(page)).toHaveCount(2)
  const first = rows(page).nth(0), dm = rows(page).nth(1)
  await expect(first.getByTestId('activity-panel-text')).toHaveText(`#마케팅 › ${t['rooms.thread']}`)
  await expect(first.getByTestId('activity-panel-meta')).toHaveText('김민지: @다현 이번 주 캠페인 시안 확인 부탁드려요. 금요일까지 꼭 봐 주세요.')
  await expect(dm.getByTestId('activity-panel-text')).toHaveText('이서연')
  await expect(dm.getByTestId('activity-panel-meta')).toHaveText('파일 확인했어요')
  // two lines each, the long line cut, not wrapped
  for (const r of [first, dm]) expect((await r.boundingBox())!.height).toBeLessThanOrEqual(50)
})
