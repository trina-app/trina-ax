// Session markers (docs/DECISIONS.md "Session markers"): one marker per 트리나 기록 row at its right end (a grey ring
// while it runs, "?" when it waits on me, a dot and an ink title for a new answer), "···" in its place on hover, left of
// "···" on a phone; from the chat list (a reload keeps it, opening the chat clears it); the reason in the hover peek; the
// filter; the one count in the tab title with rooms counted once; the room's "?"; on a phone the ☰ dot, the toast with
// [열기], and the 대화 tab's own count unchanged.
import { expect, test, type Page } from '@playwright/test'
import { uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { chatFilterClear, navChatList, navChatRow, navRoomLinks, openChatFilter, openNewChat, phoneAiMark, showChats, showRooms, tabMark } from './nav'

/** the chat's row in the AI's history on screen (the sidebar or the 트리나 panel; on a phone the drawer or the 트리나 tab) */
const rowOf = (page: Page, id: string) => navChatRow(page, { id })
const idOf = (page: Page) => new URL(page.url()).pathname.split('/')[2]!

/** send from Home (a new chat) and leave it for Home again before the answer ends; its chat id */
async function startAndLeave(page: Page, text: string): Promise<string> {
  await page.goto('/')
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\//)
  const id = idOf(page)
  await openNewChat(page)
  await expect(page).toHaveURL(/\/$/)
  return id
}

async function hide(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

test('a grey ring while it runs, then the dot and an ink title; "···" takes its place on hover, the peek says why; opening clears it, a reload keeps it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const id = await startAndLeave(page, 'slow answer please, slow slow slow')
  const row = rowOf(page, id)
  await expect(row.getByTestId('marker-running')).toBeVisible()
  await expect(row.getByRole('img', { name: '답하는 중' })).toBeVisible()
  await expect(row.getByTestId('marker-new')).toBeVisible({ timeout: 20_000 })
  await expect(row.getByRole('img', { name: '새 답' })).toBeVisible()
  // (an unread name: 600 in ink, one look in every panel since #697, list/List.tsx rowName)
  await expect(row.getByRole('link')).toHaveClass(/font-semibold text-ink/)
  // one marker in the "···" slot, its right edge 12 px in (the rooms' pills' column)
  const marker = row.getByTestId('chat-marker')
  const menu = row.getByRole('button', { name: '기록 메뉴' })
  const [m, r] = [await marker.locator('[role="img"]').boundingBox(), await row.boundingBox()]
  expect(Math.abs(r!.x + r!.width - 12 - (m!.x + m!.width))).toBeLessThan(1)
  // on hover "···" shows and the marker gives way; the peek's first line is the reason
  await row.hover()
  await expect(marker).toHaveCSS('opacity', '0')
  await expect(menu).toHaveCSS('opacity', '1')
  await expect(page.getByTestId('chat-peek-reason')).toHaveText('새 답')
  await page.mouse.move(900, 500)
  // from the chat list: a reload keeps it
  await page.reload()
  await expect(rowOf(page, id).getByTestId('marker-new')).toBeVisible()
  // opened: gone, here and after a reload
  await rowOf(page, id).getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`/c/${id}$`))
  await expect(rowOf(page, id).getByTestId('chat-marker')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  await expect(rowOf(page, id).getByTestId('chat-marker')).toHaveCount(0)
})

test('"?" for a card and for a failed answer; the filter shows them and the running ones, not a new answer; one count in the title', async ({ page }) => {
  await reset(page)
  await signIn(page)
  // (the mock fails an "error" answer at once; its sub-agent step first gives the page 1.5 s to leave)
  const failed = await startAndLeave(page, 'error after a sub-agent step')
  const done = await startAndLeave(page, 'slow hello there slow slow')
  await page.goto('/')
  await page.getByTestId('composer-input').fill('please ask me something')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('ask-card')).toBeVisible()
  const asked = idOf(page)
  // on screen: the card's "?" stays (it waits on me until answered), named by the AI's question
  await expect(rowOf(page, asked).getByRole('img', { name: '어느 분기를 볼까요?' })).toBeVisible()
  await openNewChat(page)
  await expect(rowOf(page, failed).getByRole('img', { name: '멈췄어요: 오류' })).toBeVisible({ timeout: 20_000 })
  await expect(rowOf(page, done).getByTestId('marker-new')).toBeVisible({ timeout: 20_000 })
  await expect(navChatList(page).getByTestId('chat-marker')).toHaveCount(3)
  // the title counts chats (3), each once
  await hide(page, true)
  await expect(page).toHaveTitle(/^\(3\) /)
  await hide(page, false)
  await expect(page).toHaveTitle(/^[^(]/)
  // "답변 중이거나 내 답을 기다림"
  await openChatFilter(page)
  await page.getByTestId('recents-view-status').click()
  await page.getByTestId('recents-status-waiting').click()
  await page.keyboard.press('Escape')
  await expect(rowOf(page, asked)).toHaveCount(1)
  await expect(rowOf(page, failed)).toHaveCount(1)
  await expect(rowOf(page, done)).toHaveCount(0)
  await chatFilterClear(page).click()
  // the failed one opened: its "?" goes (a card's would stay)
  await rowOf(page, failed).getByRole('link').click()
  await expect(rowOf(page, failed).getByTestId('chat-marker')).toHaveCount(0)
  await expect(rowOf(page, asked).getByTestId('marker-ask')).toBeVisible()
})

test('⌘K "Needs attention" shows the sidebar\'s marks and words: "?" for the chat waiting for me (not "answering"), the dot for a new answer (QA TC-419)', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const done = await startAndLeave(page, 'slow hello there slow slow')
  await page.goto('/')
  await page.getByTestId('composer-input').fill('please ask me something')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('ask-card')).toBeVisible()
  const asked = idOf(page)
  await openNewChat(page)
  await expect(rowOf(page, done).getByTestId('marker-new')).toBeVisible({ timeout: 20_000 })
  const sideAsk = rowOf(page, asked).getByTestId('marker-ask')
  await expect(sideAsk).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  const attention = page.getByTestId('search-palette').getByTestId('search-section-attention')
  const row = (id: string) => attention.locator(`[data-key="chat:${id}"]`)
  // the same mark, and the sidebar's own words for it (its label)
  await expect(row(asked).getByTestId('search-row-marker')).toHaveAttribute('data-marker', 'ask')
  await expect(row(asked).getByTestId('search-marker-reason')).toHaveText((await sideAsk.getAttribute('aria-label'))!)
  await expect(row(asked)).not.toContainText('답하는 중')
  await expect(row(done).getByTestId('search-row-marker')).toHaveAttribute('data-marker', 'new')
  await expect(row(done).getByTestId('search-marker-reason')).toHaveText((await rowOf(page, done).getByTestId('marker-new').getAttribute('aria-label'))!)
  // "?" before a new answer; opening the chat from here clears its dot in both places
  await expect(attention.locator('[data-key^="chat:"]').first()).toHaveAttribute('data-key', `chat:${asked}`)
  await row(done).click()
  await expect(page).toHaveURL(new RegExp(`/c/${done}$`))
  await expect(rowOf(page, done).getByTestId('chat-marker')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(row(asked)).toBeVisible()
  await expect(row(done)).toHaveCount(0)
})

test('rooms: "@" over the count; the one count holds DMs and mentions once each, not plain team unread', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const now = new Date().toISOString()
  const base = { canRename: false, managerId: null, memberCount: 2, lastReadSeq: 0, lastSeq: 9, lastMessage: null, muted: false, createdAt: now, activityAt: now, mentioned: false, unreadCount: 0, threadsUnread: 0, nextThreadId: null }
  // someone the people directory does not list: the DM is named after the room's own peer
  const peer = { id: 'zed', name: 'Zed Park' }
  const rooms = [
    { ...base, id: uuidv7(), kind: 'dm', name: null, groupId: null, peers: [peer], unreadCount: 3 },
    { ...base, id: uuidv7(), kind: 'team', name: '마케팅팀', groupId: uuidv7(), peers: [peer], unreadCount: 12 },
    { ...base, id: uuidv7(), kind: 'team', name: '영업팀', groupId: uuidv7(), peers: [peer], unreadCount: 2, mentioned: true },
    { ...base, id: uuidv7(), kind: 'all', name: null, groupId: null, peers: [peer], unreadCount: 1, mentioned: true },
  ]
  expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
  await showRooms(page)
  const badge = (name: string) => navRoomLinks(page).filter({ hasText: name }).getByTestId('room-unread')
  await expect(badge('Zed Park')).toHaveText(/^3/)
  await expect(badge('마케팅팀')).toHaveText(/^12/)
  await expect(badge('영업팀')).toContainText('@')
  await expect(badge('전체')).toContainText('@')
  // the one count: the DM and the two mentions (each room once); the team room's 12 only make it bold
  await hide(page, true)
  await expect(page).toHaveTitle(/^\(3\) /)
  await hide(page, false)
  // the phone: the 대화 tab's pill is the rail's number, the conversations with something unread (4, not 18 messages);
  // the AI's mark is for the AI chats only, and none wants me
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(tabMark(page, 'chats')).toContainText('4')
  await expect(phoneAiMark(page)).toHaveCount(0)
})

test.describe('a phone (390 px)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('in the drawer the marker sits left of "···"; a long answer that ended while I was elsewhere is a toast with [열기], and the ☰ dot', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await page.getByTestId('composer-input').fill('slow long answer please slow slow')
    await page.getByTestId('send').click()
    await expect(page).toHaveURL(/\/c\//)
    const id = idOf(page)
    // ‹ goes back to the new chat's box it was sent from (a phone's Home, the 트리나 tab)
    await page.getByTestId('chat-back').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('composer-input')).toBeVisible()
    // the answer ends while the chat is not on screen: after the wait, one toast with [열기]; the ☰ dot lights (accent)
    const toast = page.getByTestId('toast').filter({ hasText: '새 답' })
    await expect(toast).toBeVisible({ timeout: 25_000 })
    // the new chat's box lists no chats (the 트리나 tab has them: QA TC-253)
    await expect(page.getByTestId('home-recents')).toHaveCount(0)
    // the 트리나 tab (the bar is not on /new): its mark lights; its list has the dot left of the always-shown "···"
    await showChats(page)
    await expect(phoneAiMark(page)).toBeVisible()
    await expect(phoneAiMark(page)).not.toHaveAttribute('data-ask', '')
    const row = rowOf(page, id)
    await expect(row.getByTestId('marker-new')).toBeVisible()
    const [m, b] = [await row.getByTestId('chat-marker').locator('[role="img"]').boundingBox(), await row.getByRole('button', { name: '기록 메뉴' }).boundingBox()]
    expect(m!.x + m!.width).toBeLessThanOrEqual(b!.x + 4)
    await expect(row.getByRole('button', { name: '기록 메뉴' })).toHaveCSS('opacity', '1')
    await expect(row.getByTestId('chat-marker')).toHaveCSS('opacity', '1')
    await page.keyboard.press('Escape')
    await toast.getByTestId('toast-action').click()
    await expect(page).toHaveURL(new RegExp(`/c/${id}$`))
    await page.getByTestId('chat-back').click()
    await expect(phoneAiMark(page)).toHaveCount(0)
  })
})
