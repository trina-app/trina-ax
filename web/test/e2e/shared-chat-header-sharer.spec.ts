// The header of a chat someone shared with me by name or group (components/chat/SharedChat.tsx SharedByLine; plan
// docs/AGENTS/plan/20261121-0510-shared-chat-header-sharer.md): its name, truncated on one line with the whole name as
// a tooltip, and "{name}님이 공유" with their face, after the title on a computer and as a second line under it on a
// phone, inside the same 48px bar. Its creator sees no "shared by"; a shared project chat keeps "Project / Title" and
// nothing new. At 1440 and 390 px wide; SHOTS_DIR=<dir> takes each header light and dark.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const LONG = '3분기 예산 질문과 다음 달 마케팅 캠페인 일정, 그리고 새 직원 온보딩 체크리스트까지 한 번에 정리하기'

async function shots(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR
  if (!dir) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${dir}/${name}-${scheme}.png`, clip: { x: 0, y: 0, width: page.viewportSize()!.width, height: 160 } })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** a chat of the signed-in person with one answer, named */
async function chatOf(page: Page, title: string, projectId?: string) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: projectId ? { projectId } : {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: '예산 요약해 줘', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  expect((await page.request.patch(`/api/chats/${chat.id}`, { headers: H, data: { title } })).ok()).toBeTruthy()
  return chat.id
}
async function shareWithBob(page: Page, chatId: string) {
  const subjects = [{ subjectType: 'user', subjectId: 'bob' }]
  const p = (await (await page.request.post(`/api/chats/${chatId}/audience/preview`, { headers: H, data: { subjects } })).json()) as { previewKey?: string }
  expect((await page.request.put(`/api/chats/${chatId}/audience`, { headers: H, data: { subjects, ...(p.previewKey ? { confirmKey: p.previewKey } : {}) } })).ok()).toBeTruthy()
}
async function open(page: Page, chatId: string) {
  await page.goto(`/c/${chatId}`)
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('chat-title')).toBeVisible()
}

for (const vp of [{ name: '1440', phone: false, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`a shared chat's header at ${vp.name}`, () => {
    test.use(vp.use)

    async function bob(browser: Browser) {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', ...vp.use })
      const page = await ctx.newPage()
      await signIn(page, BOB)
      return page
    }
    /** the header stays one 48px bar, the title on one line */
    async function oneBar(page: Page) {
      expect((await page.getByTestId('chat-bar').boundingBox())!.height).toBeLessThanOrEqual(49)
      const title = page.getByTestId('chat-title')
      const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20)
      expect((await title.locator('span').first().boundingBox())!.height).toBeLessThanOrEqual(lineHeight + 2)
    }

    test('a recipient sees the title and who shared it; its creator does not', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const chatId = await chatOf(page, LONG)
      await shareWithBob(page, chatId)

      const b = await bob(browser)
      await open(b, chatId)
      await shots(b, `sharer-recipient-${vp.name}`)
      // the whole name as the title's tooltip, truncated on one line
      await expect(b.getByTestId('chat-title').locator('[title]').first()).toHaveAttribute('title', LONG)
      const by = b.getByTestId('chat-shared-by')
      await expect(by).toBeVisible()
      await expect(by.locator('.truncate')).toHaveText('Olga님이 공유')
      await expect(by).toHaveAttribute('title', 'Olga님이 공유')
      await expect(b.getByTestId('chat-shared')).toBeVisible()
      await oneBar(b)
      // on a phone it is the line under the title; on a computer, in the title's row
      const titleBox = (await b.getByTestId('chat-title').boundingBox())!
      const byBox = (await by.boundingBox())!
      if (vp.phone) expect(byBox.y).toBeGreaterThan(titleBox.y + titleBox.height / 2)
      else expect(Math.abs(byBox.y + byBox.height / 2 - (titleBox.y + titleBox.height / 2))).toBeLessThan(4)
      // nothing in the header names anyone else
      await expect(b.getByTestId('chat-bar')).not.toContainText('Bob')
      // the title still opens its menu (the line under it on a phone lets taps through)
      if (vp.phone) {
        // a tap on the line under the title reaches the title's button
        const top = byBox.y + 2
        expect(top).toBeLessThan(titleBox.y + titleBox.height)
        await b.touchscreen.tap(byBox.x + byBox.width / 2, top)
      } else await b.getByTestId('chat-menu').click()
      await expect(b.getByTestId('chat-copy-link')).toBeVisible()
      await b.keyboard.press('Escape')
      await b.context().close()

      // the creator: no "shared by"
      await open(page, chatId)
      await expect(page.getByTestId('chat-shared')).toBeVisible()
      await expect(page.getByTestId('chat-shared-by')).toHaveCount(0)
      await oneBar(page)
      await shots(page, `sharer-creator-${vp.name}`)
    })

    test('a shared project chat keeps "Project / Title" and nothing new', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const r = await page.request.post('/api/projects', { headers: H, data: { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' } })
      expect(r.status()).toBe(201)
      const projectId = ((await r.json()) as { id: string }).id
      expect((await page.request.patch(`/api/projects/${projectId}`, { headers: H, data: { shareChats: true } })).ok()).toBeTruthy()
      const chatId = await chatOf(page, '런칭 일정 정리', projectId)

      const b = await bob(browser)
      await open(b, chatId)
      await expect(b.getByTestId('chat-project')).toHaveText('Launch')
      await expect(b.getByTestId('chat-title')).toContainText('런칭 일정 정리')
      await expect(b.getByTestId('chat-shared-by')).toHaveCount(0)
      await oneBar(b)
      await shots(b, `sharer-project-${vp.name}`)
      await b.context().close()
    })
  })
}
