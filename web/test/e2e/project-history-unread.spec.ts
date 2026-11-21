// A project page's Trina history shows my unread mentions in a chat as the 프로젝트 panel does: the same round count on
// the same chat (store/chatMentions.ts), the title bold; opening the chat reads them, so the count goes from both lists
// (pages/Chat.tsx readChatMentions). The mock server keeps no thread-mention notices, so the Inbox's answer is given
// here, and a notice's read (POST /api/notifications/:id/read) is kept here too.
// With PROJECT_HISTORY_SHOTS set to a folder, the screens are saved there (1440 and 390, light and dark, en and ko).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const shots = process.env.PROJECT_HISTORY_SHOTS
test.use({ serviceWorkers: 'block' })

async function setUp(page: Page, locale: 'en' | 'ko') {
  await reset(page, { teamLocale: locale, usersFollowTeam: true })
  await signIn(page)
  const r = await page.request.post('/api/projects', { headers: H, data: { name: 'Brand launch', scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  expect(r.status()).toBe(201)
  const projectId = ((await r.json()) as { id: string }).id
  const chat = async (title: string) => {
    const c = await page.request.post('/api/chats', { headers: H, data: { projectId, title } })
    expect(c.ok()).toBeTruthy()
    return ((await c.json()) as { id: string }).id
  }
  await chat('Weekly summary for Slack')
  const brand = await chat('Follow our brand guide for every post')
  // one of Bob's mentions of me in a thread of the brand chat, unread until it is read here
  const read = new Set<string>()
  const notice = () => ({
    id: 'n1', eventType: 'chat.thread_reply', sourceId: 'n1', code: 'chat.thread_reply', createdAt: new Date().toISOString(), readAt: read.has('n1') ? new Date().toISOString() : null,
    chatId: brand, link: 'chat_thread', chatThread: { chatId: brand, rootId: null, name: 'Bob', title: 'Follow our brand guide for every post', mention: true },
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
  return { projectId, brand, read }
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`${scheme}`, () => {
    test.use({ colorScheme: scheme })
    for (const locale of ['en', 'ko'] as const) {
      test(`a computer (${locale}): the project page's history shows the panel's count; opening the chat clears both`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 })
        const { projectId, brand, read } = await setUp(page, locale)
        await page.goto(`/projects/${projectId}`)
        const history = page.getByTestId('project-chats')
        const row = history.getByTestId('project-chat').filter({ hasText: 'Follow our brand guide' })
        await expect(row.getByTestId('project-chat-mentions')).toHaveText(/^1/)
        // the other chat: no count
        await expect(history.getByTestId('project-chat-mentions')).toHaveCount(1)
        // the title bold, as on the panel's chat row
        expect(await row.getByTestId('project-row-title').evaluate((el) => Number(getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600)
        // the panel beside it: the same count on the project and, opened, on the chat
        const panel = page.getByTestId('projects-panel')
        const pLi = panel.locator('li').filter({ has: page.getByTestId('projects-panel-row').filter({ hasText: 'Brand launch' }) })
        await expect(pLi.getByTestId('projects-panel-mentions')).toHaveText(/^1/)
        await pLi.getByTestId('projects-panel-fold').click()
        await expect(panel.getByTestId('projects-panel-chat-mentions')).toHaveText([/^1/])
        if (shots) await page.waitForTimeout(300).then(() => page.screenshot({ path: `${shots}/1440-${scheme}-${locale}-before.png` }))

        // opening the chat reads the mention: gone from the project page and from the panel
        await row.click()
        await expect(page).toHaveURL(new RegExp(`/c/${brand}`))
        await expect.poll(() => read.has('n1')).toBe(true)
        await page.goto(`/projects/${projectId}`)
        await expect(history.getByTestId('project-chat')).toHaveCount(2)
        await expect(history.getByTestId('project-chat-mentions')).toHaveCount(0)
        await expect(panel.getByTestId('projects-panel-mentions')).toHaveCount(0)
        await expect(panel.getByTestId('projects-panel-chat-mentions')).toHaveCount(0)
        expect(await row.getByTestId('project-row-title').evaluate((el) => Number(getComputedStyle(el).fontWeight))).toBeLessThan(600)
        if (shots) await page.waitForTimeout(300).then(() => page.screenshot({ path: `${shots}/1440-${scheme}-${locale}-after.png` }))
      })

      test(`a phone (${locale}): the count fits on the row, no sideways scroll`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        const { projectId } = await setUp(page, locale)
        await page.goto(`/projects/${projectId}`)
        const row = page.getByTestId('project-chat').filter({ hasText: 'Follow our brand guide' })
        const pill = row.getByTestId('project-chat-mentions')
        await expect(pill).toHaveText(/^1/)
        await pill.scrollIntoViewIfNeeded()
        const box = (await pill.boundingBox())!
        expect(box.x + box.width).toBeLessThanOrEqual(390)
        // the time still shows beside it
        await expect(row.locator('time')).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
        if (shots) await page.waitForTimeout(300).then(() => page.screenshot({ path: `${shots}/390-${scheme}-${locale}.png` }))
      })
    }
  })
}
