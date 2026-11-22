// The 프로젝트 place's mark (the owner, 11-22: a team project's row showed "1" while the rail's 프로젝트 had nothing;
// "모바일도 잘 생각해줘"): the rail on a computer and the phone's 프로젝트 tab count the projects with an unread thread
// mention of me (rail/useProjectsMark.ts), the number the project's row shows; opening the chat reads it and both go
// (pages/Chat.tsx), also when the chat is opened straight from a reload, before the mentions are read. The mock server
// keeps no thread-mention notices, so the Inbox's answer and the notice's read are given here (as
// project-history-unread.spec.ts does).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
test.use({ serviceWorkers: 'block' })

async function setUp(page: Page) {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const r = await page.request.post('/api/projects', { headers: H, data: { name: 'Yuzu launch', scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  expect(r.status()).toBe(201)
  const projectId = ((await r.json()) as { id: string }).id
  const c = await page.request.post('/api/chats', { headers: H, data: { projectId, title: 'Label proof' } })
  const chat = ((await c.json()) as { id: string }).id
  const read = new Set<string>()
  const notice = () => ({
    id: 'n1', eventType: 'chat.thread_reply', sourceId: 'n1', code: 'chat.thread_reply', createdAt: new Date().toISOString(), readAt: read.has('n1') ? new Date().toISOString() : null,
    chatId: chat, link: 'chat_thread', chatThread: { chatId: chat, rootId: null, name: 'Bob', title: 'Label proof', mention: true },
  })
  await page.route('**/api/notifications?*', async (route) => {
    const res = await route.fetch()
    const body = (await res.json()) as { items: unknown[]; unreadCount: number; noticeUnreadCount?: number }
    const n = read.has('n1') ? 0 : 1
    await route.fulfill({ response: res, json: { ...body, items: [notice(), ...body.items], unreadCount: body.unreadCount + n, noticeUnreadCount: (body.noticeUnreadCount ?? 0) + n } })
  })
  await page.route('**/api/notifications/n1/read', async (route) => {
    read.add('n1')
    await route.fulfill({ json: notice() })
  })
  return { projectId, chat, read }
}

test('a computer: the rail\'s 프로젝트 shows the projects with an unread mention; a reload straight into the chat clears it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const { chat, read } = await setUp(page)
  await page.goto('/files')
  await expect(page.getByTestId('rail-projects-mark')).toHaveAttribute('data-n', '1')
  // the chat opened by its address (a reload, a link from elsewhere): read once the mentions are known
  await page.goto(`/c/${chat}`)
  await expect.poll(() => read.has('n1')).toBe(true)
  await expect(page.getByTestId('rail-projects-mark')).toHaveCount(0)
})

test('a phone: the 프로젝트 tab shows the same number, and fits the bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setUp(page)
  await page.goto('/files')
  const mark = page.getByTestId('tab-projects-unread')
  await expect(mark).toHaveText(/^1/)
  const box = (await mark.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
