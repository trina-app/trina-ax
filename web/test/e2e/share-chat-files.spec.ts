// "Share the files from this chat too?" (docs/decisions/20261121-share-chat-files.md) at 1440 and 390 px wide. Olga's
// chat made a quote PDF and its HTML in her own folder (My files › 견적 › Sincere) and links them in the answer.
//   1. She shares it with Bob: the Share dialog's checkbox row "파일도 같이 공유 (2개)" lists the two files with their
//      folder, unticked, and one small hint says the originals stay; ticked, Share adds them, the toast counts them, her own link opens the chat's
//      copy, and Bob opens the copy from the same link (through the panel: he never gets the original's path) and goes
//      on in the chat.
//   2. Shared before without the files (the owner's case): Share again shows the checkbox row on its own, Save off
//      until it is ticked; ticked, Save adds them, and the row is gone after.
//   3. Bob's link does not open: the panel says only Olga can add it, [추가 요청] sends the ask; Olga's Activity row
//      names Bob, the file and the chat, [대화에 추가] adds it, and Bob's link opens the copy.
// The mock (test/mock/server.ts "Share the files from this chat too?"): POST /__test/chat-made {chatId, files, link}.
// QA screenshots with SHOTS_DIR set: light and dark.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { isPhone, openNotice } from './nav'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const DIR = 'users/olga/견적/Sincere'
const PDF = '견적서_Sincere_마케팅에이전트.pdf'
const HTML = '견적서_Sincere_마케팅에이전트.html'
const TITLE = 'Sincere 견적'

async function shots(page: Page, name: string) {
  if (!process.env.SHOTS_DIR) return
  const w = page.viewportSize()?.width ?? 0
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}-${w}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** Olga's chat with one answer that made the two files in her own folder and links them */
async function quoteChat(page: Page) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: 'Sincere 견적서 만들어 줘', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  expect((await page.request.patch(`/api/chats/${chat.id}`, { headers: H, data: { title: TITLE } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/chat-made', { data: { chatId: chat.id, link: true, files: [{ path: `${DIR}/${PDF}`, content: '견적서 Sincere 6,000,000원' }, { path: `${DIR}/${HTML}`, content: '<h1>견적서 Sincere</h1><p>6,000,000원</p>' }] } })).ok()).toBeTruthy()
  return chat.id
}
/** shared with Bob by the API, without the files (the preview's key with the save) */
async function shareWithoutFiles(page: Page, chatId: string) {
  const subjects = [{ subjectType: 'user', subjectId: 'bob' }]
  const p = (await (await page.request.post(`/api/chats/${chatId}/audience/preview`, { headers: H, data: { subjects } })).json()) as { previewKey: string }
  expect((await page.request.put(`/api/chats/${chatId}/audience`, { headers: H, data: { subjects, confirmKey: p.previewKey } })).ok()).toBeTruthy()
}
async function openChat(page: Page, chatId: string) {
  await page.goto(`/c/${chatId}`)
  await expect(page.getByTestId('assistant-message').first()).toHaveAttribute('data-status', 'done')
}
async function openShare(page: Page, chatId: string) {
  await openChat(page, chatId)
  await page.getByTestId('chat-share').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByTestId('chat-share-dialog')).toBeVisible()
  return dialog
}
const fileLink = (page: Page, name: string) => page.getByTestId('assistant-message').getByTestId('team-file-chip').filter({ hasText: name })
const panel = (page: Page) => page.getByTestId('file-panel')
/** a file that does not open for me: the header keeps the name and Close only (no "Show in Files", download, Ask
 * Trina, add to chat, share or ⋯), and the title says nothing about where the file is */
async function blockedHeader(page: Page) {
  const header = panel(page).locator('header')
  await expect(header.getByRole('button')).toHaveCount(1)
  await expect(header.getByRole('button', { name: '닫기' })).toBeVisible()
  for (const name of ['파일 화면에서 열기', '내려받기', '크게 보기']) await expect(header.getByRole('button', { name })).toHaveCount(0)
  for (const id of ['file-ask-ai', 'file-ask-trina', 'file-add-to-chat', 'file-panel-more', 'panel-expand']) await expect(header.getByTestId(id)).toHaveCount(0)
  const title = panel(page).getByTestId('file-panel-title')
  await expect(title).toHaveAttribute('title', PDF)
  await expect(title).not.toHaveAttribute('draggable', 'true')
  await expect(header).not.toContainText('Sincere/')
}

for (const vp of [{ name: '1440', use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`sharing a chat's files at ${vp.name}`, () => {
    test.use(vp.use)
    async function as(browser: Browser, who: { username: string; password: string }) {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', ...vp.use })
      const page = await ctx.newPage()
      await signIn(page, who)
      return page
    }

    test('Olga shares with the files: the step, the copies, and Bob opens the copy from the link and goes on', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const chatId = await quoteChat(page)
      const dialog = await openShare(page, chatId)
      await page.getByTestId('chat-share-picker-search').fill('Bob')
      await page.getByTestId('participant-add-user-bob').click()
      const step = dialog.getByTestId('chat-share-files-step')
      await expect(step).toBeVisible()
      await expect(step).toContainText('파일도 같이 공유 (2개)')
      await expect(step.getByTestId('chat-share-files-item')).toHaveCount(2)
      await expect(step.getByTestId('chat-share-files-item').first()).toContainText('내 파일 › 견적 › Sincere')
      const hint = dialog.getByTestId('chat-share-files-hint')
      await expect(hint).toHaveText('채팅에 사본이 생겨요. 원본은 그대로예요.')
      await expect(hint).toHaveAttribute('title', '원본은 내 파일에 그대로 있어요. 채팅을 삭제하면 채팅의 사본도 함께 삭제돼요.')
      // the chat's own outputs, nothing Bob can't open: ticked by default (QA TC-v1d-02); one Share button, no
      // "with/without files" pair
      const box = dialog.getByTestId('chat-share-files-check')
      await expect(box).toBeChecked()
      for (const id of ['chat-share-without-files', 'chat-share-with-files']) await expect(dialog.getByTestId(id)).toHaveCount(0)
      await expect(dialog.getByTestId('chat-share-save')).toHaveText('공유')
      await audit(page, 'share step')
      await shots(page, 'share-step')
      await box.check()
      await dialog.getByTestId('chat-share-save').click()
      await expect(page.getByTestId('toast').filter({ hasText: '1명과 공유했어요 · 파일 2개를 대화에 추가했어요' })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      // her own link opens the chat's copy now (one file, not two)
      await expect(fileLink(page, PDF)).toHaveAttribute('data-copy', '')
      // Bob: the same link opens the copy (he is never told where the original is: the panel asks the server, which
      // answers with the chat's copy), nothing to ask
      const bob = await as(browser, BOB)
      await openChat(bob, chatId)
      await fileLink(bob, PDF).click()
      await expect(panel(bob).getByTestId('file-panel-title')).toContainText(PDF)
      await expect(panel(bob).getByTestId('chat-file-ask')).toHaveCount(0)
      await expect(panel(bob).getByRole('alert')).toHaveCount(0)
      await shots(bob, 'member-copy')
      // and he goes on in the chat with the AI
      if (isPhone(bob)) {
        await bob.goBack()
        await expect(panel(bob)).toHaveCount(0)
      }
      await bob.getByTestId('composer-input').fill('견적 금액을 5,500,000원으로 고쳐 줘')
      await bob.getByTestId('send').click()
      await expect(bob.getByTestId('assistant-message')).toHaveCount(2)
      await expect(bob.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await bob.context().close()
    })

    test('shared before without the files: Share shows the step on its own and adds them', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const chatId = await quoteChat(page)
      await shareWithoutFiles(page, chatId)
      const dialog = await openShare(page, chatId)
      const step = dialog.getByTestId('chat-share-files-step')
      await expect(step).toBeVisible()
      await expect(step).toHaveAttribute('data-already', '')
      await expect(step).toContainText('파일도 같이 공유 (2개)')
      // nothing changed and nothing ticked: Save off; ticked, Save adds the files alone
      await expect(dialog.getByTestId('chat-share-save')).toBeDisabled()
      await audit(page, 'already-shared step')
      await shots(page, 'already-shared-step')
      await dialog.getByTestId('chat-share-files-check').check()
      await expect(dialog.getByTestId('chat-share-save')).toBeEnabled()
      await dialog.getByTestId('chat-share-save').click()
      await expect(page.getByTestId('toast').filter({ hasText: '파일 2개를 대화에 추가했어요' })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(fileLink(page, PDF)).toHaveAttribute('data-copy', '')
      // nothing left to add: the plain dialog again
      const again = await openShare(page, chatId)
      await expect(again.getByTestId('chat-share-files-step')).toHaveCount(0)
      await expect(again.getByTestId('chat-share-save')).toBeVisible()
    })

    test('Bob\'s link does not open: he asks, Olga adds it from Activity, and his link opens the copy', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const chatId = await quoteChat(page)
      await shareWithoutFiles(page, chatId)
      const bob = await as(browser, BOB)
      await openChat(bob, chatId)
      await fileLink(bob, PDF).click()
      const ask = panel(bob).getByTestId('chat-file-ask')
      await expect(ask).toBeVisible()
      await expect(ask).toContainText('이 파일은 Olga님만 대화에 추가할 수 있어요')
      await expect(ask).not.toContainText('Sincere')
      await expect(ask).not.toContainText('견적')
      await blockedHeader(bob)
      await audit(bob, 'blocked panel')
      await shots(bob, 'blocked-panel')
      await ask.getByTestId('chat-file-ask-send').click()
      await expect(panel(bob).getByTestId('chat-file-ask-sent')).toHaveText('요청을 보냈어요. 답은 활동에서 볼 수 있어요.')
      // Olga's Activity: who, which file, which chat; [대화에 추가]
      const notice = await openNotice(page, 'Bob')
      await expect(notice.getByTestId('notification-text')).toHaveText(`Bob님이 '${TITLE}' 대화에 ${PDF} 파일을 추가해 달라고 요청했어요`)
      await expect(notice.getByTestId('access-request-share')).toHaveText('대화에 추가')
      await audit(page, 'activity request')
      await shots(page, 'activity-request')
      await notice.getByTestId('access-request-share').click()
      await expect(notice.getByTestId('access-request-done')).toHaveText('대화에 추가했어요')
      // Bob's link opens the copy now
      await openChat(bob, chatId)
      await fileLink(bob, PDF).click()
      await expect(panel(bob).getByTestId('file-panel-title')).toContainText(PDF)
      await expect(panel(bob).getByTestId('chat-file-ask')).toHaveCount(0)
      await bob.context().close()
    })

    test('a link that does not open for any other reason: "can\'t be found", and the same bare header', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const chatId = await quoteChat(page)
      await shareWithoutFiles(page, chatId)
      const bob = await as(browser, BOB)
      // the server's one answer for every other case (gone, not the chat's, someone else's folder)
      await bob.route('**/api/chats/*/file-access?*', (r) => r.fulfill({ json: { status: 'no' } }))
      await openChat(bob, chatId)
      await fileLink(bob, PDF).click()
      await expect(panel(bob).getByTestId('chat-file-ask-no')).toBeVisible()
      await blockedHeader(bob)
      await shots(bob, 'cant-open-panel')
      await bob.context().close()
    })
  })
}
