// "새 채팅에서 이어 하기" on my own chat and its place in the Trina history (docs/decisions/20261126-chat-fork-tree.md):
// the title menu's item (never "포크") opens "<제목> (이어서)" with the line back at the top and, under the box, "🔒 나만
// 보는 채팅 · ‘<제목>’에서 이어 왔어요. 원래 채팅은 그대로예요." (the title a link); in the list it sits one level under its
// chat, and so does a continuation of a continuation (from the row's "···"); no arrows; the older chat keeps its place;
// "목록에서 따로 두기" makes it a row of its own (its line stays); a deleted chat's continuation stays, on its own; a
// continuation used today sits under its original of 3 days ago, in that chat's date (docs/decisions/
// 20261127-fork-in-history.md), and a project's page nests it too. At
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
        // a phone shows that line only: the top one said the same words on the same screen (QA after #651)
        if (vp.name === '390') await expect(page.getByTestId('chat-forked-from')).toBeHidden()
        else await expect(page.getByTestId('chat-forked-from')).toBeVisible()
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

      // QA 11-27: a live update (a reply, a rename with "···", the same from another tab, a new continuation) moved a
      // continuation to the top as a row of its own until a reload. No reload here: every change comes in live.
      test('the "└" stays through a reply, a rename and changes from another window; a detach there moves it out', async ({ page }) => {
        await reset(page)
        await signIn(page)
        const root = await chatWithAnswer(page, '출시 계획')
        await chatWithAnswer(page, '예산 정리')
        const f = await forkOf(page, root)
        // a computer: the continuation on screen with the history beside it; a phone: the history on Home
        await page.goto(vp.name === '1440' ? `/c/${f}` : '/')
        await showList(page)
        const row = navChatRow(page, { id: f })
        await expect(row).toHaveAttribute('data-tree-depth', '1')

        if (vp.name === '1440') {
          // a reply sent here
          await page.getByTestId('composer-input').fill('일정도 정리해 줘')
          await page.getByTestId('composer-input').press('Enter')
          await expect(page.getByTestId('assistant-message')).toHaveCount(2)
          await idle(page, f)
          await expect(row).toHaveAttribute('data-tree-depth', '1')
        }
        // a rename from the row's "···"
        if (vp.name === '1440') await row.hover()
        await row.getByTestId('chat-row-menu').click()
        await page.getByTestId('chat-row-rename').click()
        await page.getByTestId('dialog-input').fill('출시 일정')
        await page.getByTestId('dialog-confirm').click()
        await expect(row).toContainText('출시 일정')
        await expect(row).toHaveAttribute('data-tree-depth', '1')
        // a reply from another window
        expect((await post(page, `/api/chats/${f}/messages`, { content: '다른 탭에서 보낸 질문', clientMessageId: uuidv7() })).status()).toBe(202)
        await idle(page, f)
        await expect(row).toHaveAttribute('data-tree-depth', '1')
        // a rename from another window whose event says nothing of the parents (an older server): still under its chat
        expect((await post(page, '/__test/chat-updated-bare', { chatId: f, title: '출시 일정 v2' })).ok()).toBeTruthy()
        await expect(row).toContainText('출시 일정 v2')
        await expect(row).toHaveAttribute('data-tree-depth', '1')
        // a new continuation from another window: under the first chat at once
        const g = await forkOf(page, f)
        await expect(navChatRow(page, { id: g })).toHaveAttribute('data-tree-depth', '1')
        if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/fork-live-${vp.name}-${scheme}.png` })
        // a detach from another window: a row of its own, its continuation under it
        expect((await page.request.patch(`/api/chats/${f}`, { headers: { [CSRF_HEADER]: '1' }, data: { forkParent: null } })).ok()).toBeTruthy()
        await expect(row).not.toHaveAttribute('data-tree-depth', /./)
        await expect(navChatRow(page, { id: g })).toHaveAttribute('data-tree-depth', '1')
        await expect(navChatRow(page, { id: root })).not.toHaveAttribute('data-tree-depth', /./)
      })

      // like the Claude app's session list (docs/decisions/20261127-fork-in-history.md): a continuation used today sits
      // right under its original from 3 days ago, in the original's date group, with its "└"; the original stays put
      test('a continuation used today sits under its original of 3 days ago, at the original\'s place', async ({ page }) => {
        await reset(page)
        await signIn(page)
        const day = 86_400_000
        const at = (ms: number) => { const d = new Date(Date.now() - ms); d.setHours(12, 0, 0, 0); return d.toISOString() }
        const old = await chatWithAnswer(page, '보고서 초안')
        const mid = await chatWithAnswer(page, '견적 비교')
        expect((await post(page, '/__test/chat-at', { chatId: old, at: at(3 * day) })).ok()).toBeTruthy()
        expect((await post(page, '/__test/chat-at', { chatId: mid, at: at(day) })).ok()).toBeTruthy()
        const cont = await forkOf(page, old)
        const today = await chatWithAnswer(page, '회의록 정리')
        await page.goto(`/c/${today}`)
        const list = await chatList(page)
        await expect(navChatRow(page, { id: cont })).toBeVisible()
        if (process.env.SHOT_DIR) await list.screenshot({ path: `${process.env.SHOT_DIR}/history-${vp.name}-${scheme}.png` })
        const ids = await list.locator('li[data-chat-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-chat-id')))
        expect(ids.filter((id) => [old, mid, cont, today].includes(id!))).toEqual([today, mid, old, cont])
        await expect(navChatRow(page, { id: cont })).toHaveAttribute('data-tree-depth', '1')
        const group = (id: string) => list.locator('[data-testid="history-date"]', { has: page.locator(`li[data-chat-id="${id}"]`) })
        await expect(group(cont)).toHaveAttribute('data-bucket', 'week')
        await expect(group(old)).toHaveAttribute('data-bucket', 'week')
        // the elbow: drawn in front of the row, 28 px in
        const inset = await navChatRow(page, { id: cont }).evaluate((li) => li.getBoundingClientRect().left - li.parentElement!.getBoundingClientRect().left)
        expect(inset).toBe(28)
        expect(await navChatRow(page, { id: cont }).evaluate((li) => getComputedStyle(li, '::before').content)).not.toBe('none')
        await audit(page, `cross-date ${vp.name} ${scheme}`)
      })

      test("a project's chat list nests my continuation under its chat", async ({ page }) => {
        await reset(page)
        await signIn(page)
        const projectId = ((await (await post(page, '/api/projects', { name: '내 메모', scope: 'personal', participants: [], instructions: '' })).json()) as { id: string }).id
        const made = async (title: string) => {
          const id = ((await (await post(page, '/api/chats', { title, projectId })).json()) as { id: string }).id
          expect((await post(page, `/api/chats/${id}/messages`, { content: `${title} 시작`, clientMessageId: uuidv7() })).status()).toBe(202)
          await idle(page, id)
          return id
        }
        const a = await made('분기 보고')
        const b = await made('채용 공고')
        expect((await post(page, '/__test/chat-at', { chatId: a, at: new Date(Date.now() - 3 * 86_400_000).toISOString() })).ok()).toBeTruthy()
        const cont = await forkOf(page, a)
        await page.goto(`/projects/${projectId}`)
        const rows = page.getByTestId('project-chats').locator('li')
        await expect(rows).toHaveCount(3)
        if (process.env.SHOT_DIR) await page.getByTestId('project-chats').screenshot({ path: `${process.env.SHOT_DIR}/project-${vp.name}-${scheme}.png` })
        await expect(rows.nth(0)).toContainText('채용 공고')
        await expect(rows.nth(1)).toContainText('분기 보고')
        await expect(rows.nth(2)).toContainText('분기 보고 (이어서)')
        await expect(rows.nth(2)).toHaveAttribute('data-tree-depth', '1')
        void b
        void cont
      })
    })
  }
}
