// A chat's file edited in place, with versions (docs/AGENTS/plan/20261121-1206-chat-file-edit-versions.md), at 1440
// and 390 px wide. Olga's chat is shared with Bob, and her question carries 회의록.md (a file kept with the chat).
//   1. Olga edits it in the file panel and saves: Bob's tile says "Olga님이 수정" at once, and his panel too.
//   2. The versions list (who, when, size): open version 1, "이 버전으로 되돌리기" makes a new newest version with its text;
//      nothing goes.
//   3. Bob is someone the file is hidden from (it is carried only by answers hidden from him): no tile, the file and its
//      versions are the 404 of a missing one, the panel shows neither the list nor the line.
//   4. A project chat: its chat files are read-only (the project folder is its save place): no pencil, no Restore.
// The mock (test/mock/server.ts "a chat's file edited in place"). QA screenshots with SHOTS_DIR set: light and dark.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { isPhone } from './nav'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const NAME = '회의록.md'
const FIRST = '# 주간 회의\n\n- 예산 검토'
const EDITED = '# 주간 회의\n\n- 예산 검토\n- 출시일 11월 28일'

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
const idle = (page: Page, chatId: string) => expect.poll(async () => ((await (await page.request.get(`/api/chats/${chatId}`)).json()) as { runState: string }).runState).toBe('idle')

/** Olga's chat shared with Bob, then her question with 회의록.md attached: the chat id and the file's id */
async function sharedChatWithFile(page: Page): Promise<{ chatId: string; fileId: string }> {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: '이번 주 회의 정리해 줘', clientMessageId: uuidv7() } })).status()).toBe(202)
  await idle(page, chat.id)
  const subjects = [{ subjectType: 'user', subjectId: 'bob' }]
  const p = (await (await page.request.post(`/api/chats/${chat.id}/audience/preview`, { headers: H, data: { subjects } })).json()) as { previewKey: string }
  expect((await page.request.put(`/api/chats/${chat.id}/audience`, { headers: H, data: { subjects, confirmKey: p.previewKey } })).ok()).toBeTruthy()
  const up = await page.request.post('/api/uploads', { headers: H, multipart: { chatId: chat.id, file: { name: NAME, mimeType: 'text/markdown', buffer: Buffer.from(FIRST) } } })
  expect(up.status()).toBe(201)
  const file = (await up.json()) as { id: string; source?: string }
  expect(file.source).toBe('chat')
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: '회의록 확인해 줘', attachmentIds: [file.id], clientMessageId: uuidv7() } })).status()).toBe(202)
  await idle(page, chat.id)
  return { chatId: chat.id, fileId: file.id }
}
async function openChat(page: Page, chatId: string) {
  await page.goto(`/c/${chatId}`)
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
}
const tile = (page: Page) => page.getByTestId('user-message').locator('[data-source="chat"]').filter({ hasText: NAME })
const panel = (page: Page) => page.getByTestId('file-panel')
async function closePanel(page: Page) {
  if (isPhone(page)) await page.goBack()
  else await panel(page).getByRole('button', { name: '닫기' }).click()
  await expect(panel(page)).toHaveCount(0)
}
/** the pencil (a computer) or ⋯ › 고치기 (a phone, prose only) */
async function startEdit(page: Page) {
  if (isPhone(page)) {
    await panel(page).getByTestId('file-panel-more').click()
    await page.getByTestId('file-more-edit').click()
  } else await panel(page).getByTestId('file-edit').click()
  await expect(panel(page).getByTestId('file-editor')).toBeVisible()
}

for (const vp of [{ name: '1440', use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`a chat's file, edited with versions, at ${vp.name}`, () => {
    test.use(vp.use)
    async function as(browser: Browser, who: { username: string; password: string }) {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', ...vp.use })
      const page = await ctx.newPage()
      await signIn(page, who)
      return page
    }

    test('Olga edits and saves: Bob sees "Updated by Olga" on the tile and in the panel', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const { chatId, fileId } = await sharedChatWithFile(page)
      const bob = await as(browser, BOB)
      await openChat(bob, chatId)
      await expect(tile(bob)).toBeVisible()
      await expect(tile(bob).getByTestId('attachment-updated')).toHaveCount(0)

      await openChat(page, chatId)
      await tile(page).click()
      await expect(panel(page).getByTestId('file-panel-title')).toHaveText(NAME)
      await expect(panel(page)).toContainText('예산 검토')
      // never changed: no line, no list
      await expect(panel(page).getByTestId('file-panel-history')).toHaveCount(0)
      await startEdit(page)
      await panel(page).getByTestId('file-editor').fill(EDITED)
      await audit(page, 'edit panel')
      await shots(page, 'chat-file-edit')
      await panel(page).getByTestId('file-save').click()
      await expect(page.getByTestId('toast').filter({ hasText: '저장했어요.' })).toBeVisible()
      await expect(panel(page)).toContainText('출시일 11월 28일')
      await expect(panel(page).getByTestId('file-panel-updated')).toContainText('Olga님이 수정')
      await expect(panel(page).getByTestId('file-versions-toggle')).toHaveText('버전 2개')

      // Bob: his tile says who changed it, at once (no reload), and his panel opens the newest
      await expect(tile(bob).getByTestId('attachment-updated')).toContainText('Olga님이 수정')
      await shots(bob, 'chat-file-updated-chip')
      await tile(bob).click()
      await expect(panel(bob)).toContainText('출시일 11월 28일')
      await expect(panel(bob).getByTestId('file-panel-updated')).toContainText('Olga님이 수정')
      await audit(bob, 'updated panel')
      // the AI saved it for Olga next: "트리나가 Olga님 대신 수정"
      expect((await page.request.post('/__test/chat-file-version', { data: { chatId, fileId, content: `${EDITED}\n- 담당: 민수`, by: 'olga', ai: true } })).ok()).toBeTruthy()
      await expect(panel(bob).getByTestId('file-panel-updated')).toContainText('트리나가 Olga님 대신 수정')
      await expect(panel(bob)).toContainText('담당: 민수')
      await closePanel(bob)
      await expect(tile(bob).getByTestId('attachment-updated')).toContainText('트리나가 Olga님 대신 수정')
      await bob.context().close()
    })

    test('the versions list: open version 1, restore it as the newest, nothing deleted', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const { chatId, fileId } = await sharedChatWithFile(page)
      expect((await page.request.put(`/api/chats/${chatId}/files/${fileId}/content`, { headers: H, data: { content: EDITED } })).ok()).toBeTruthy()
      await openChat(page, chatId)
      await tile(page).click()
      await expect(panel(page)).toContainText('출시일 11월 28일')
      await panel(page).getByTestId('file-versions-toggle').click()
      const rows = panel(page).getByTestId('file-version-row')
      await expect(rows).toHaveCount(2)
      // newest first: who, when, size; the newest has no Open or Restore
      await expect(rows.first()).toContainText('버전 2')
      await expect(rows.first()).toContainText('지금 버전')
      await expect(rows.first()).toContainText('Olga')
      await expect(rows.first().getByTestId('file-version-restore')).toHaveCount(0)
      await expect(rows.last()).toContainText('버전 1')
      await audit(page, 'versions list')
      await shots(page, 'chat-file-versions')
      await rows.last().getByTestId('file-version-open').click()
      await expect(panel(page).getByTestId('file-version-shown')).toContainText('버전 1')
      await expect(panel(page)).not.toContainText('출시일 11월 28일')
      // an earlier version is restored, not edited
      await expect(panel(page).getByTestId('file-edit')).toHaveCount(0)
      await audit(page, 'version 1 open')
      await shots(page, 'chat-file-version-open')
      await panel(page).getByTestId('file-version-restore-shown').click()
      await expect(page.getByTestId('toast').filter({ hasText: '버전 1을 최신 버전으로 되돌렸어요. 지운 건 없어요.' })).toBeVisible()
      await expect(panel(page).getByTestId('file-version-shown')).toHaveCount(0)
      await expect(panel(page).getByTestId('file-versions-toggle')).toHaveText('버전 3개')
      await expect(panel(page)).toContainText('예산 검토')
      await expect(panel(page)).not.toContainText('출시일 11월 28일')
      await shots(page, 'chat-file-restored')
      const v = (await (await page.request.get(`/api/chats/${chatId}/files/${fileId}/versions`)).json()) as { items: { version: number; head?: true; size: number }[] }
      expect(v.items.map((x) => x.version)).toEqual([1, 2, 3])
      expect(v.items[2]!.head).toBe(true)
      expect(v.items[2]!.size).toBe(v.items[0]!.size)
    })

    test('someone the file is hidden from: no tile, no versions, nothing about it', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const { chatId, fileId } = await sharedChatWithFile(page)
      expect((await page.request.put(`/api/chats/${chatId}/files/${fileId}/content`, { headers: H, data: { content: EDITED } })).ok()).toBeTruthy()
      expect((await page.request.post('/__test/chat-file-hidden', { data: { fileId, from: 'bob' } })).ok()).toBeTruthy()
      const bob = await as(browser, BOB)
      await openChat(bob, chatId)
      await expect(tile(bob)).toHaveCount(0)
      expect((await bob.request.get(`/api/chats/${chatId}/files/${fileId}/versions`)).status()).toBe(404)
      expect((await bob.request.get(`/api/chats/${chatId}/files/${fileId}?version=1`)).status()).toBe(404)
      expect((await bob.request.post(`/api/chats/${chatId}/files/${fileId}/versions/1/restore`, { headers: H })).status()).toBe(404)
      expect((await bob.request.put(`/api/chats/${chatId}/files/${fileId}/content`, { headers: H, data: { content: 'x' } })).status()).toBe(404)
      // a link to it: one plain line that it is not there, no viewer, and nothing of its versions or who changed it
      // (lib/chatFileLink.ts, QA TC-6935)
      await bob.goto(`/c/${chatId}?file=${fileId}`)
      await expect(bob.getByTestId('toast').filter({ hasText: '파일을 찾을 수 없거나 볼 권한이 없어요.' })).toBeVisible()
      await expect(panel(bob)).toHaveCount(0)
      await expect(bob.getByTestId('file-panel-history')).toHaveCount(0)
      await expect(bob.locator('body')).not.toContainText('Olga님이 수정')
      await expect(bob.getByTestId('file-edit')).toHaveCount(0)
      await shots(bob, 'chat-file-hidden')
      await bob.context().close()
    })

    test('a project chat: its chat files are read-only (no pencil, no Restore)', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const { chatId, fileId } = await sharedChatWithFile(page)
      expect((await page.request.put(`/api/chats/${chatId}/files/${fileId}/content`, { headers: H, data: { content: EDITED } })).ok()).toBeTruthy()
      expect((await page.request.post('/__test/chat-file-project', { data: { chatId } })).ok()).toBeTruthy()
      await openChat(page, chatId)
      await tile(page).click()
      await expect(panel(page)).toContainText('출시일 11월 28일')
      await expect(panel(page).getByTestId('file-panel-updated')).toContainText('Olga님이 수정')
      await expect(panel(page).getByTestId('file-edit')).toHaveCount(0)
      if (isPhone(page)) {
        await panel(page).getByTestId('file-panel-more').click()
        await expect(page.getByTestId('file-more-edit')).toHaveCount(0)
        await page.keyboard.press('Escape')
      }
      await panel(page).getByTestId('file-versions-toggle').click()
      await expect(panel(page).getByTestId('file-version-row')).toHaveCount(2)
      await expect(panel(page).getByTestId('file-version-restore')).toHaveCount(0)
      await expect(panel(page).getByTestId('file-version-open')).toHaveCount(1)
      const r = await page.request.put(`/api/chats/${chatId}/files/${fileId}/content`, { headers: H, data: { content: 'x' } })
      expect(r.status()).toBe(409)
      expect(((await r.json()) as { error: { params?: { reason?: string } } }).error.params?.reason).toBe('chat_file_read_only')
    })
  })
}
