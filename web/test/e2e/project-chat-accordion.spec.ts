// 프로젝트 panel: a project's ▸ opens its chats under its row, and a round count says how many unread mentions of me
// wait in a project and in each chat, with who mentioned me (docs/decisions/20261120-project-chat-accordion.md). The
// mock server keeps no thread-mention notices (its GET /api/notifications has no conversation rows), so the Inbox's
// answer is given here with two of Bob's mentions in one chat and one of Dana's in another.
// With PROJECT_ACCORDION_SHOTS set to a folder, the screens are also saved there (the review's before and after).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { openRail, reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const shots = process.env.PROJECT_ACCORDION_SHOTS
test.use({ colorScheme: 'dark', serviceWorkers: 'block' })

async function project(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}
async function chat(page: Page, projectId: string, title: string): Promise<string> {
  const r = await page.request.post('/api/chats', { headers: H, data: { projectId, title } })
  expect(r.ok()).toBeTruthy()
  return ((await r.json()) as { id: string }).id
}
const mention = (id: string, chatId: string, name: string, title: string) => ({
  id, eventType: 'chat.thread_reply', sourceId: id, code: 'chat.thread_reply', createdAt: new Date().toISOString(), readAt: null,
  chatId, link: 'chat_thread', chatThread: { chatId, rootId: null, name, title, mention: true },
})
const shot = async (page: Page, name: string) => {
  if (shots) await page.getByTestId('projects-panel').screenshot({ path: `${shots}/${name}.png` })
}

test('a project row opens its chats in place, with the unread mentions of me counted', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const hn = await project(page, 'Hacker News automation')
  const trina = await project(page, 'trina-ax')
  await project(page, 'video marketing')
  const daily = await chat(page, hn, 'Daily top 30 digest')
  const scrape = await chat(page, hn, 'Scraper keeps timing out')
  await chat(page, hn, 'Weekly summary for Slack')
  await chat(page, trina, 'Release notes 0.4.0')
  await page.route('**/api/notifications?*', async (route) => {
    const r = await route.fetch()
    const body = (await r.json()) as { items: unknown[]; unreadCount: number; noticeUnreadCount?: number }
    const items = [mention('n1', scrape, 'Bob', 'Scraper keeps timing out'), mention('n2', scrape, 'Bob', 'Scraper keeps timing out'), mention('n3', daily, 'Dana', 'Daily top 30 digest')]
    await route.fulfill({ response: r, json: { ...body, items: [...items, ...body.items], unreadCount: body.unreadCount + 3, noticeUnreadCount: (body.noticeUnreadCount ?? 0) + 3 } })
  })
  await page.reload()
  await openRail(page, 'projects')
  const panel = page.getByTestId('projects-panel')
  const row = panel.getByTestId('projects-panel-row').filter({ hasText: 'Hacker News automation' })
  await expect(row).toBeVisible()
  await shot(page, 'before-or-folded')

  // folded at first: the project's count is every unread mention in it (2 + 1), who on hover
  const hnLi = panel.locator('li').filter({ has: page.getByTestId('projects-panel-row').filter({ hasText: 'Hacker News automation' }) })
  await expect(hnLi.getByTestId('projects-panel-mentions')).toContainText('3')
  await expect(hnLi.getByTestId('projects-panel-mentions').locator('..')).toHaveAttribute('title', /Bob, Dana/)
  await expect(panel.getByTestId('projects-panel-chats')).toHaveCount(0)

  await hnLi.getByTestId('projects-panel-fold').click()
  await expect(hnLi.getByTestId('projects-panel-fold')).toHaveAttribute('aria-expanded', 'true')
  const chats = panel.getByTestId('projects-panel-chats')
  await expect(chats.getByTestId('projects-panel-chat')).toHaveCount(3)
  // the chat with the most mentions first; each its own count
  await expect(chats.getByTestId('projects-panel-chat').first()).toContainText('Scraper keeps timing out')
  await expect(chats.getByTestId('projects-panel-chat-mentions')).toHaveText([/^2/, /^1/])
  if (shots) await page.waitForTimeout(300)
  await shot(page, 'after-open')

  // a chat row opens the chat; the fold is kept
  await chats.getByTestId('projects-panel-chat').first().click()
  await expect(page).toHaveURL(new RegExp(`/c/${scrape}`))
  await openRail(page, 'projects')
  await expect(page.getByTestId('projects-panel-chats').getByTestId('projects-panel-chat')).toHaveCount(3)

  // folded again
  await hnLi.getByTestId('projects-panel-fold').click()
  await expect(panel.getByTestId('projects-panel-chats')).toHaveCount(0)
})

test('a phone: the ▸ has its own place in the row and opens the chats under it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  const hn = await project(page, 'Hacker News automation')
  await chat(page, hn, 'Daily top 30 digest')
  await page.goto('/projects')
  const fold = page.getByTestId('projects-panel-fold')
  await expect(fold).toBeVisible()
  // 44px or more to tap, clear of the project's icon
  const box = (await fold.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(40)
  await fold.click()
  await expect(page.getByTestId('projects-panel-chat')).toHaveText([/Daily top 30 digest/])
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  // (the ▸ turns in 150 ms)
  if (shots) await page.waitForTimeout(300).then(() => page.screenshot({ path: `${shots}/after-phone.png` }))
})
