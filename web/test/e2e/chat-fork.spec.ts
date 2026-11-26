// "Continue in a chat only you see" on a shared chat makes a fork (docs/decisions/20261126-chat-fork.md): a chat only I
// see in the same project with the conversation so far, others' names kept, one quiet line "‘title’에서 이어 왔어요"
// above it that links back, an empty box. The shared chat is not changed and the other person cannot open the copy. At
// 1440 and 390 px wide, light and dark, with axe on each. The mock: test/mock/server.ts forkChat.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
const patch = (page: Page, path: string, data: object) => page.request.patch(path, { headers: { [CSRF_HEADER]: '1' }, data })

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}
const idle = (page: Page, chatId: string) => expect.poll(async () => ((await (await page.request.get(`/api/chats/${chatId}`)).json()) as { runState: string }).runState).toBe('idle')

for (const vp of [{ name: '1440', use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`chat fork at ${vp.name}, ${scheme}`, () => {
      test.use({ ...vp.use, colorScheme: scheme })
      async function bob(browser: Browser) {
        const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', ...vp.use, colorScheme: scheme })
        const page = await ctx.newPage()
        await signIn(page, BOB)
        return page
      }

      test('a shared chat continued in a chat only I see: the conversation, the line back, an empty box; Bob never sees it', async ({ page, browser }) => {
        await reset(page)
        await signIn(page)
        const r = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
        const projectId = ((await r.json()) as { id: string }).id
        expect((await patch(page, `/api/projects/${projectId}`, { shareChats: true })).ok()).toBeTruthy()
        const chat = (await (await post(page, '/api/chats', { projectId, title: '출시 계획' })).json()) as { id: string; shared?: unknown }
        expect(chat.shared).toBeTruthy()
        expect((await post(page, `/api/chats/${chat.id}/messages`, { content: '출시 일정 잡아 줘', clientMessageId: uuidv7() })).status()).toBe(202)
        await idle(page, chat.id)
        // Bob writes in it too
        const b = await bob(browser)
        await b.goto(`/c/${chat.id}`)
        await b.getByTestId('composer-input').fill('예산도 같이 봐 줘')
        await b.getByTestId('send').click()
        await expect(b.getByTestId('assistant-message')).toHaveCount(2)
        await expect(b.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')

        await page.goto(`/c/${chat.id}`)
        await expect(page.getByTestId('assistant-message')).toHaveCount(2)
        await page.getByTestId('chat-menu').click()
        await page.getByTestId('chat-continue-privately').click()
        await expect(page).not.toHaveURL(new RegExp(`/c/${chat.id}$`))
        await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
        const fork = page.url().split('/c/')[1]!
        // the line back, the conversation with Bob's name, not shared, an empty box
        await expect(page.getByTestId('chat-forked-from')).toHaveText('‘출시 계획’에서 이어 왔어요')
        await expect(page.getByTestId('user-message')).toHaveCount(2)
        await expect(page.getByTestId('user-message').last()).toContainText('예산도 같이 봐 줘')
        // who asked stays on each question (Bob's is not shown as mine)
        await expect(page.getByTestId('user-message').last().getByTestId('message-author-row')).toContainText('Bob')
        await expect(page.getByTestId('assistant-message')).toHaveCount(2)
        await expect(page.getByTestId('chat-shared')).toHaveCount(0)
        await expect(page.getByTestId('composer-input')).toHaveValue('')
        await audit(page, `fork ${vp.name} ${scheme}`)
        if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/fork-${vp.name}-${scheme}.png` })
        // the line opens the shared chat, which is as it was
        await page.getByTestId('chat-forked-from-link').click()
        await expect(page).toHaveURL(new RegExp(`/c/${chat.id}$`))
        await expect(page.getByTestId('assistant-message')).toHaveCount(2)
        await expect(page.getByTestId('chat-shared')).toBeVisible()
        // Bob cannot open the copy
        await b.goto(`/c/${fork}`)
        await expect(b.getByTestId('user-message')).toHaveCount(0)
        await b.context().close()
      })
    })
  }
}
