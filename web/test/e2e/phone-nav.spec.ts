// The phone's navigation in a real browser at 390×844 (docs/DECISIONS.md "Phone navigation: four tabs"): the app opens on
// the 트리나 tab, four tabs with one count each where there is one, ☰ (the AI's history) only on Home, ⊕ only on 대화, no
// top bar on 파일, 알림함 and 관리자 on top of 나, and ‹ that goes back instead of piling up entries, so the phone's own back
// (the browser's here) never returns to the chat or room that was just left.
import { expect, test, type Page } from '@playwright/test'
import { PRODUCT } from '@mycel/shared'
import { PRODUCT_NAMED_AFTER_AI, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const t = DICTS.ko
const ai = PRODUCT_NAMED_AFTER_AI ? t['rooms.aiName'] : PRODUCT.shortName
const historyLength = (page: Page) => page.evaluate(() => history.length)

test('a phone opens on 트리나: the box, four tabs, ☰ only there, one action per tab', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await expect(page).toHaveURL(/\/$/)
  const tabs = page.getByTestId('bottom-tabs')
  await expect(tabs.getByRole('link')).toHaveText([ai, t['tabs.chats'], t['tabs.files'], t['tabs.me']])
  await expect(page.getByTestId('tab-ai')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('composer-input')).toBeVisible()
  const bar = page.getByTestId('phone-topbar')
  await expect(bar.getByTestId('topbar-title')).toHaveText(ai)
  await expect(bar.getByTestId('menu-open')).toBeVisible()
  await expect(page.getByTestId('topbar-new-chat')).toHaveCount(0)
  await expect(page.getByTestId('topbar-new-dm')).toHaveCount(0)
  // the bar's buttons are 44 px
  const menu = (await bar.getByTestId('menu-open').boundingBox())!
  expect(Math.round(menu.width)).toBeGreaterThanOrEqual(44)
  expect(Math.round(menu.height)).toBeGreaterThanOrEqual(44)

  // 대화: its name and ⊕ a new conversation; no ☰, no pinned AI row
  await page.getByTestId('tab-chats').click()
  await expect(page).toHaveURL(/\/rooms$/)
  await expect(bar.getByTestId('topbar-title')).toHaveText(t['tabs.chats'])
  await expect(page.getByTestId('topbar-new-dm')).toBeVisible()
  await expect(page.getByTestId('menu-open')).toHaveCount(0)
  await expect(page.getByTestId('rooms-ai')).toBeHidden()
  await page.getByTestId('topbar-new-dm').click()
  await expect(page).toHaveURL(/\/rooms\?new=1$/)
  await page.getByRole('dialog', { name: t['rooms.newDm'] }).getByRole('button', { name: t['common.close'] }).click()
  await expect(page).toHaveURL(/\/rooms$/)

  // 파일: the page's own header is the bar
  await page.getByTestId('tab-files').click()
  await expect(page).toHaveURL(/\/files/)
  await expect(page.getByRole('heading', { level: 1, name: t['files.title'] })).toBeVisible()
  await expect(page.getByTestId('phone-topbar')).toHaveCount(0)

  // 나: 알림함 first, 관리자 right below for the owner; the list's own 알림 row is not there
  await page.getByTestId('tab-me').click()
  const dialog = page.getByRole('dialog', { name: t['settings.title'] })
  await expect(dialog.getByTestId('settings-inbox')).toBeVisible()
  await expect(dialog.getByTestId('settings-phone-top').getByRole('link')).toHaveText([t['inbox.title'], t['sidebar.admin']])
  await expect(dialog.getByTestId('settings-menu').getByRole('link', { name: t['notifications.title'], exact: true })).toBeHidden()
  await dialog.getByTestId('settings-inbox').click()
  await expect(page).toHaveURL(/\/settings\/notifications$/)
  await expect(dialog.getByTestId('settings-section-title')).toHaveText(t['inbox.title'])
  await dialog.getByTestId('settings-back').click()
  await dialog.getByTestId('settings-admin').click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('topbar-title')).toHaveText(t['admin.title'])
  await expect(page.getByTestId('tab-me')).toHaveAttribute('aria-current', 'page')
  // ‹ goes back to the 나 list it came from, not a new entry
  const before = await historyLength(page)
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/settings$/)
  expect(await historyLength(page)).toBe(before)
})

test('the drawer is the AI\'s history: no new chat, Inbox or Admin rows, 44 px rows, and its pages have ‹ and their name', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('menu-open').click()
  const drawer = page.getByRole('dialog', { name: t['sidebar.label'] })
  await expect(drawer).toBeVisible()
  for (const name of [t['sidebar.search'], t['sidebar.projects'], t['sidebar.scheduled'], t['sidebar.skills'], t['sidebar.trash']]) {
    const row = drawer.getByRole(name === t['sidebar.search'] ? 'button' : 'link', { name, exact: true }).first()
    await expect(row).toBeVisible()
    expect(Math.round((await row.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
  }
  await expect(drawer.getByTestId('new-chat')).toBeHidden()
  await expect(drawer.getByTestId('nav-inbox')).toBeHidden()
  await expect(drawer.getByRole('link', { name: t['sidebar.admin'] })).toBeHidden()
  await expect(drawer.getByRole('link', { name: t['sidebar.files'] })).toHaveCount(0)
  await expect(drawer.getByRole('link', { name: ai }).first()).toBeVisible()
  if (PRODUCT_NAMED_AFTER_AI) await expect(drawer.getByText(PRODUCT.displayName, { exact: true })).toBeHidden()

  await drawer.getByTestId('nav-skills').click()
  await expect(page).toHaveURL(/\/skills$/)
  await expect(page.getByTestId('topbar-title')).toHaveText(t['skills.title'])
  await expect(page.getByTestId('tab-ai')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('menu-open')).toHaveCount(0)
  const before = await historyLength(page)
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/$/)
  expect(await historyLength(page)).toBe(before)
  // opened from outside (a link): ‹ replaces it with the tab's list
  await page.goto('/scheduled')
  const opened = await historyLength(page)
  await page.getByTestId('topbar-back').click()
  await expect(page).toHaveURL(/\/$/)
  expect(await historyLength(page)).toBe(opened)
})

test('an AI chat\'s ‹ goes back where it came from; the browser\'s back then never returns to the chat', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('hello from the phone')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\//)
  const chat = page.url()
  await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByTestId('bottom-tabs')).toHaveCount(0)
  const before = await historyLength(page)
  await page.getByTestId('chat-back').click()
  await expect(page).toHaveURL(/\/$/)
  expect(await historyLength(page)).toBe(before)
  // Home lists it under the box now
  await expect(page.getByTestId('home-recent').first()).toContainText('hello from the phone')
  // the entry after Home is still the chat (forward), so back was a real back and not a new Home on top of the chat
  await page.goForward()
  await expect(page).toHaveURL(chat)
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)

  // opened from outside (a notice, a link): ‹ puts Home in place of the chat, and back does not return to it
  await page.goto(chat)
  await expect(page.getByTestId('chat-back')).toBeVisible()
  const opened = await historyLength(page)
  await page.getByTestId('chat-back').click()
  await expect(page).toHaveURL(/\/$/)
  expect(await historyLength(page)).toBe(opened)
  await page.goBack()
  expect(page.url()).not.toBe(chat)
})

test('a room\'s ‹ goes back to the list; from a notice it replaces the room with the list; counts on 대화 and 나', async ({ page }) => {
  await reset(page)
  const id = uuidv7()
  const now = new Date().toISOString()
  const room = {
    id, kind: 'dm', name: null, groupId: null, memberCount: 2, peers: [{ id: 'bob', name: '박서준 마케팅본부 콘텐츠전략파트 시니어 매니저님' }],
    unreadCount: 5, mentioned: false, lastReadSeq: 0, lastSeq: 5, muted: false, createdAt: now, activityAt: now,
    lastMessage: { id: uuidv7(), seq: 5, author: { id: 'bob', name: '박서준님' }, excerpt: '내일 회의 자료 올렸어요', fileCount: 0, deleted: false, createdAt: now },
  }
  await page.route('**/api/rooms', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: [room] } }) : r.fallback()))
  await page.route(`**/api/rooms/${id}`, (r) => r.fulfill({ json: room }))
  await page.route(`**/api/rooms/${id}/messages*`, (r) => r.fulfill({ json: { items: [], nextCursor: null } }))
  await page.route(`**/api/rooms/${id}/members`, (r) => r.fulfill({ json: { items: [] } }))
  await page.route(`**/api/rooms/${id}/ai`, (r) => r.fulfill({ json: { answering: 0, mine: [] } }))
  await page.route(`**/api/rooms/${id}/read`, (r) => r.fulfill({ json: room }))
  await page.route('**/api/notifications?*', (r) => r.fulfill({ json: { items: [], nextCursor: null, unreadCount: 3 } }))
  await signIn(page)
  await expect(page.getByTestId('tab-chats-unread')).toContainText('5')
  await expect(page.getByTestId('tab-me-unread')).toContainText('3')
  // one badge per thing: the drawer has no Inbox count, ☰ no dot
  await expect(page.getByTestId('menu-unread')).toHaveCount(0)

  await page.getByTestId('tab-chats').click()
  await page.getByTestId('rooms-row').first().click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${id}$`))
  await expect(page.getByTestId('room-back')).toBeVisible()
  const before = await historyLength(page)
  await page.getByTestId('room-back').click()
  await expect(page).toHaveURL(/\/rooms$/)
  expect(await historyLength(page)).toBe(before)
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`/rooms/${id}$`))

  // from a notice (a new page on the room): the list takes its place
  await page.goto(`/rooms/${id}`)
  await expect(page.getByTestId('room-back')).toBeVisible()
  const opened = await historyLength(page)
  await page.getByTestId('room-back').click()
  await expect(page).toHaveURL(/\/rooms$/)
  expect(await historyLength(page)).toBe(opened)
})
