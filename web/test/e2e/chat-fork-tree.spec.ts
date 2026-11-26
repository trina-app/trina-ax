// "새 채팅에서 이어 하기" on my own chat and its place in the Trina history (docs/decisions/20261126-chat-fork-tree.md):
// the title menu's item (never "포크") opens "<제목> (이어서)" with the line back at the top and, under the box, "🔒 나만
// 보는 채팅 · ‘<제목>’에서 이어 왔어요. 원래 채팅은 그대로예요." (the title a link); in the list it sits one level under its
// chat, and so does a continuation of a continuation (from the row's "···"); no arrows; the older chat keeps its place;
// "목록에서 따로 두기" makes it a row of its own (its line stays); a deleted chat's continuation stays, on its own. At
// 1440 and 390 px wide, light and dark, with axe on the list. The mock: test/mock/server.ts forkChat, updateChat.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { chatList as showList, navChatRow } from './nav'

const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
const idle = (page: Page, chatId: string) => expect.poll(async () => ((await (await page.request.get(`/api/chats/${chatId}`)).json()) as { runState: string }).runState).toBe('idle')
async function chatWithAnswer(page: Page, title: string) {
  const chat = (await (await post(page, '/api/chats', { title })).json()) as { id: string }
  expect((await post(page, `/api/chats/${chat.id}/messages`, { content: `${title} 시작`, clientMessageId: uuidv7() })).status()).toBe(202)
  await idle(page, chat.id)
  return chat.id
}
// a phone: the history is the 트리나 tab's drawer, reached from Home (a chat page's own back goes elsewhere)
const chatList = async (page: Page) => {
  if ((page.viewportSize()?.width ?? 1440) < 768) await page.goto('/')
  return showList(page)
}
const forkOf = async (page: Page, id: string) => ((await (await post(page, `/api/chats/${id}/fork`, {})).json()) as { id: string }).id

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

for (const vp of [{ name: '1440', use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`continue in a new chat at ${vp.name}, ${scheme}`, () => {
      test.use({ ...vp.use, colorScheme: scheme })

      test('from the title and the row; one level under its chat; the older chat stays put; moved out on its own; a deleted chat\'s one stays', async ({ page }) => {
        await reset(page)
        await signIn(page)
        const root = await chatWithAnswer(page, '출시 계획')
        const other = await chatWithAnswer(page, '예산 정리')

        // the title menu: "새 채팅에서 이어 하기", never the shared chat's item, never "포크"
        await page.goto(`/c/${root}`)
        await expect(page.getByTestId('assistant-message')).toHaveCount(1)
        await page.getByTestId('chat-menu').click()
        await expect(page.getByTestId('chat-continue-privately')).toHaveCount(0)
        await expect(page.getByTestId('chat-fork')).toHaveText('새 채팅에서 이어 하기')
        await page.getByTestId('chat-fork').click()
        await expect(page).not.toHaveURL(new RegExp(`/c/${root}$`))
        const f1 = page.url().split('/c/')[1]!
        await expect(page.getByTestId('chat-title')).toContainText('출시 계획 (이어서)')
        await expect(page.getByTestId('chat-forked-from')).toHaveText('‘출시 계획’에서 이어 왔어요')
        // the line under the box: only mine, where it came from (a link), the original unchanged
        const who = page.locator('[data-testid="who-sees"][data-fork]:visible').first()
        await expect(who).toHaveText('나만 보는 채팅 · ‘출시 계획’에서 이어 왔어요. 원래 채팅은 그대로예요.')
        await expect(who.getByTestId('who-sees-fork-link')).toHaveAttribute('href', `/c/${root}`)
        await expect(page.getByTestId('user-message')).toHaveCount(1)
        await expect(page.getByTestId('composer-input')).toHaveValue('')
        if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/fork-chat-${vp.name}-${scheme}.png` })

        // a continuation of the continuation, from the row's "···": it too sits one level under the first chat
        let list = await chatList(page)
        const f1Row = navChatRow(page, { id: f1 })
        await expect(f1Row).toHaveAttribute('data-tree-depth', '1')
        if (vp.name === '1440') await f1Row.hover()
        await f1Row.getByTestId('chat-row-menu').click()
        await expect(page.getByTestId('chat-row-fork')).toHaveText('새 채팅에서 이어 하기')
        await page.getByTestId('chat-row-fork').click()
        await expect(page).not.toHaveURL(new RegExp(`/c/${f1}$`))
        const f2 = page.url().split('/c/')[1]!
        list = await chatList(page)
        const ids = async () => list.locator('li[data-chat-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-chat-id')))
        // the older chat keeps its place (after the newer "예산 정리"); its continuations right under it, newest first
        expect((await ids()).filter((id) => [root, other, f1, f2].includes(id!))).toEqual([other, root, f2, f1])
        await expect(navChatRow(page, { id: f2 })).toHaveAttribute('data-tree-depth', '1')
        await expect(navChatRow(page, { id: root })).not.toHaveAttribute('data-tree-depth', /./)
        // no arrows, nothing folds
        await expect(list.getByTestId('chat-row-fork-toggle')).toHaveCount(0)
        await audit(page, `tree ${vp.name} ${scheme}`)
        if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/fork-tree-${vp.name}-${scheme}.png` })

        // "목록에서 따로 두기": a row of its own (f2 came from it, so f2 now sits under it); its line stays
        const f1Again = navChatRow(page, { id: f1 })
        if (vp.name === '1440') await f1Again.hover()
        await f1Again.getByTestId('chat-row-menu').click()
        await expect(page.getByTestId('chat-row-fork-detach')).toHaveText('목록에서 따로 두기')
        await page.getByTestId('chat-row-fork-detach').click()
        await expect(navChatRow(page, { id: f1 })).not.toHaveAttribute('data-tree-depth', /./)
        await expect(navChatRow(page, { id: f2 })).toHaveAttribute('data-tree-depth', '1')
        await page.goto(`/c/${f1}`)
        await expect(page.getByTestId('chat-forked-from')).toHaveText('‘출시 계획’에서 이어 왔어요')

        // a deleted chat: its continuation stays, on its own
        const g = await forkOf(page, other)
        expect((await page.request.delete(`/api/chats/${other}`, { headers: { [CSRF_HEADER]: '1' } })).ok()).toBeTruthy()
        await page.goto(`/c/${f1}`)
        await chatList(page)
        await expect(navChatRow(page, { id: g })).toBeVisible()
        await expect(navChatRow(page, { id: g })).not.toHaveAttribute('data-tree-depth', /./)
      })
    })
  }
}
