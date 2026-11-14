// "Share…" for a chat outside projects (docs/DECISIONS.md "Chats shared with people and groups", QA TC-1405): the
// Drive-model Share dialog (components/chat/ChatShareDialog.tsx) at 1440 and 390 px wide. Every exit: Save is off with
// no change; a pick says "new"; ✕ on a saved row strikes it out with Undo; ✕/Esc with unsaved changes asks "Discard
// changes?" (Keep editing keeps the picks, Discard leaves); a failed save keeps the picks with the error above the
// button; the server's check comes back in place with "Share anyway" and "Show answers ›" (the widening list, the chat as
// its target; on a phone an answer opens on the same screen and "‹ Back to sharing" brings the dialog back with the
// picks). The person it is shared with finds it in their list and in Activity ("Olga shared a chat with you" with its
// title), continues it, hides it from their list (opening it brings it back), and sees "This chat is no longer shared
// with you" with Go to Home when taken out while it is open. A personal project's chat explains and offers Move…, after
// which the dialog opens again; the admin's delete-account dialog counts the person's shared chats. axe on each dialog.
// The mock (test/mock/server.ts "chats shared with people and groups"): POST /__test/chat-share {confirm, fail}, POST
// /__test/widening {items}.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { activityRows, chatList, isPhone } from './nav'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const SORA_PASSWORD = 'sora-Password-1'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** Sora (a member) joins; a chat of Olga's outside projects with one answer, named */
async function world(page: Page, title = 'Q3 budget questions') {
  expect((await page.request.post('/api/admin/users', { headers: H, data: { id: 'sora', username: 'sora', name: '김소라', role: 'member', groupIds: [], temporaryPassword: SORA_PASSWORD } })).ok()).toBeTruthy()
  return chatOf(page, title)
}
async function chatOf(page: Page, title: string, projectId?: string) {
  const chat = (await (await page.request.post('/api/chats', { headers: H, data: projectId ? { projectId } : {} })).json()) as { id: string }
  expect((await page.request.post(`/api/chats/${chat.id}/messages`, { headers: H, data: { content: '예산 요약해 줘', clientMessageId: uuidv7() } })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  expect((await page.request.patch(`/api/chats/${chat.id}`, { headers: H, data: { title } })).ok()).toBeTruthy()
  const answer = ((await (await page.request.get(`/api/chats/${chat.id}/messages`)).json()) as { items: { id: string; role: string }[] }).items.find((m) => m.role === 'assistant')!
  return { chatId: chat.id, answerId: answer.id }
}
/** who sees it, saved by the API (the creator's page) */
const saveAudience = (page: Page, chatId: string, subjects: { subjectType: 'user' | 'group'; subjectId: string }[]) =>
  page.request.put(`/api/chats/${chatId}/audience`, { headers: H, data: { subjects } })

for (const vp of [{ name: '1440', use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`sharing a chat with people at ${vp.name}`, () => {
    test.use(vp.use)

    async function as(browser: Browser, who: { username: string; password: string }) {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', ...vp.use })
      const page = await ctx.newPage()
      await signIn(page, who)
      return page
    }
    async function openShare(page: Page, chatId: string) {
      await page.goto(`/c/${chatId}`)
      await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      await page.getByTestId('chat-menu').click()
      await expect(page.getByTestId('chat-share')).toHaveText('공유…')
      await page.getByTestId('chat-share').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('chat-share-dialog')).toBeVisible()
      await expect(dialog.getByTestId('chat-share-picker')).toBeVisible()
      return dialog
    }
    async function pick(page: Page, name: string, id: string, type: 'user' | 'group' = 'user') {
      await page.getByTestId('chat-share-picker-search').fill(name)
      await page.getByTestId(`participant-add-${type}-${id}`).click()
      await expect(page.getByTestId(`participant-${type}-${id}`)).toHaveAttribute('data-state', 'new')
    }

    test('share: empty, a pick, Discard asked (Keep editing keeps it), Save; Bob finds it in his list and Activity and continues it', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const w = await world(page)
      const dialog = await openShare(page, w.chatId)
      // empty: me, who started it, without ✕; nothing to save
      await expect(dialog.getByTestId('participant-user-olga')).toHaveAttribute('data-state', 'fixed')
      await expect(dialog.getByTestId('participant-tags-user-olga')).toContainText('이 채팅을 시작함')
      await expect(dialog.getByTestId('participant-remove-user-olga')).toHaveCount(0)
      await expect(dialog.getByTestId('chat-share-save')).toBeDisabled()
      await expect(dialog.getByTestId('chat-share-save')).toHaveText('공유')
      await expect(dialog.getByTestId('chat-share-note')).toContainText('추가되기 전에 나눈 대화까지')
      await audit(page, 'share dialog, empty')
      await pick(page, 'Bob', 'bob')
      // a group adds the line that whoever joins it later sees the chat too
      await pick(page, '재무팀', (await (await page.request.get('/api/me')).json() as { groups: { id: string }[] }).groups[0]!.id, 'group')
      await expect(dialog.getByTestId('chat-share-future-group')).toBeVisible()
      await audit(page, 'share dialog, with picks')
      const groupId = (await (await page.request.get('/api/me')).json() as { groups: { id: string }[] }).groups[0]!.id
      await dialog.getByTestId(`participant-remove-group-${groupId}`).click()
      await expect(dialog.getByTestId('chat-share-future-group')).toHaveCount(0)
      await expect(dialog.getByTestId('chat-share-save')).toBeEnabled()
      // ✕ with a pick not saved: asked first; Keep editing keeps it
      await page.keyboard.press('Escape')
      const ask = page.getByRole('dialog', { name: '변경 사항을 버릴까요?' })
      await expect(ask).toBeVisible()
      await expect(ask.getByTestId('dialog-cancel')).toHaveText('계속 편집')
      await expect(ask.getByTestId('dialog-confirm')).toHaveText('버리기')
      await audit(page, 'discard ask')
      await ask.getByTestId('dialog-cancel').click()
      await expect(page.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'new')
      await page.getByTestId('chat-share-save').click()
      await expect(page.getByTestId('toast').filter({ hasText: '1명과 공유했어요' })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByTestId('chat-shared')).toBeVisible()
      // the creator's line under the box opens the dialog again
      const line = page.getByTestId(isPhone(page) ? 'composer-phone-footer' : 'composer-footer').getByTestId('who-sees')
      await expect(line).toContainText('2명이 이 채팅을 볼 수 있어요')
      await line.click()
      await expect(page.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'member')
      await expect(page.getByTestId('chat-share-save')).toHaveText('저장')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // Bob: in his list, and in Activity with who shared it and its title, which opens it
      const bob = await as(browser, BOB)
      await bob.goto('/')
      const list = await chatList(bob)
      await expect(list.locator(`a[href="/c/${w.chatId}"]`).first()).toBeVisible()
      if (isPhone(bob)) {
        await bob.goto('/activity')
        const notice = bob.getByTestId('notification-item').filter({ hasText: 'Olga님이 채팅을 공유했어요.' })
        await expect(notice).toContainText('Q3 budget questions')
        await notice.getByRole('link').first().click()
      } else {
        const row = (await activityRows(bob)).filter({ hasText: 'Olga님이 채팅을 공유했어요.' })
        await expect(row).toContainText('Q3 budget questions')
        await row.click()
      }
      await expect(bob).toHaveURL(new RegExp(`/c/${w.chatId}`))
      // no Share… for him; he may hide it, and continue it
      await bob.getByTestId('chat-menu').click()
      await expect(bob.getByTestId('chat-share')).toHaveCount(0)
      await expect(bob.getByTestId('chat-hide')).toBeVisible()
      await expect(bob.getByTestId('chat-continue-privately')).toBeVisible()
      await bob.keyboard.press('Escape')
      await bob.getByTestId('composer-input').fill('Bob 질문이에요')
      await bob.getByTestId('send').click()
      await expect(bob.getByTestId('assistant-message')).toHaveCount(2)
      await expect(bob.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await bob.context().close()
    })

    test('remove, Undo, Discard; a failed save keeps the picks; removing everyone makes it mine again', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const w = await world(page)
      expect((await saveAudience(page, w.chatId, [{ subjectType: 'user', subjectId: 'bob' }, { subjectType: 'user', subjectId: 'sora' }])).ok()).toBeTruthy()
      const dialog = await openShare(page, w.chatId)
      await expect(dialog.getByTestId('chat-share-save')).toBeDisabled()
      // ✕ on a saved row: struck out with Undo; Undo puts it back
      await dialog.getByTestId('participant-remove-user-bob').click()
      await expect(dialog.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'removed')
      await expect(dialog.getByTestId('chat-share-save')).toBeEnabled()
      await audit(page, 'share dialog, a row struck out')
      await dialog.getByTestId('participant-undo-user-bob').click()
      await expect(dialog.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'member')
      await expect(dialog.getByTestId('chat-share-save')).toBeDisabled()
      // a change, then ✕: Discard leaves it as it was
      await dialog.getByTestId('participant-remove-user-sora').click()
      if (isPhone(page)) {
        // a phone's Back asks too; Keep editing keeps the sheet, and Back asks again
        await page.goBack()
        await page.getByRole('dialog', { name: '변경 사항을 버릴까요?' }).getByTestId('dialog-cancel').click()
        await expect(page.getByTestId('participant-user-sora')).toHaveAttribute('data-state', 'removed')
        await page.goBack()
        await expect(page.getByRole('dialog', { name: '변경 사항을 버릴까요?' })).toBeVisible()
        await page.getByRole('dialog', { name: '변경 사항을 버릴까요?' }).getByTestId('dialog-cancel').click()
        await expect(page.getByTestId('participant-user-sora')).toHaveAttribute('data-state', 'removed')
        await expect(page).toHaveURL(new RegExp(`/c/${w.chatId}$`))
      }
      await page.getByRole('dialog').getByRole('button', { name: '닫기' }).first().click()
      await page.getByRole('dialog', { name: '변경 사항을 버릴까요?' }).getByTestId('dialog-confirm').click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const again = await openShare(page, w.chatId)
      await expect(again.getByTestId('participant-user-sora')).toHaveAttribute('data-state', 'member')
      // a failed save: the error above the button, the picks kept; again, it saves
      await page.request.post('/__test/chat-share', { headers: H, data: { fail: 1 } })
      await again.getByTestId('participant-remove-user-sora').click()
      await again.getByTestId('chat-share-save').click()
      await expect(again.getByTestId('chat-share-error')).toHaveText('저장하지 못했어요. 바꾼 내용은 그대로 있어요. 다시 시도해 주세요.')
      await expect(again.getByTestId('participant-user-sora')).toHaveAttribute('data-state', 'removed')
      await audit(page, 'share dialog, save failed')
      await again.getByTestId('chat-share-save').click()
      await expect(page.getByTestId('toast').filter({ hasText: '저장했어요' })).toBeVisible()
      // everyone out: said before the save; then the chat is mine alone again
      const last = await openShare(page, w.chatId)
      await last.getByTestId('participant-remove-user-bob').click()
      await expect(last.getByTestId('chat-share-only-you')).toBeVisible()
      await last.getByTestId('chat-share-save').click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByTestId('chat-shared')).toHaveCount(0)
    })

    test('the check in place: memories, places, the widening line and its list; Share anyway', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const w = await world(page)
      await page.request.post('/__test/chat-share', { headers: H, data: { confirm: { hiddenAnswers: 1, memories: true, people: 1, places: [{ kind: 'mine' }] } } })
      await page.request.post('/__test/widening', { headers: H, data: { items: [
        { chatId: w.chatId, chatTitle: 'Q3 budget questions', messageId: w.answerId, at: '2026-11-12T03:00:00.000Z', askedBy: { id: 'olga', name: 'Olga' }, preview: 'The finance draft puts Q3 spend at 41 % over plan', places: [{ name: 'Finance › Board pack' }, { hidden: true }], missedBy: ['Bob'] },
      ] } })
      const dialog = await openShare(page, w.chatId)
      await pick(page, 'Bob', 'bob')
      await dialog.getByTestId('chat-share-save').click()
      await expect(dialog.getByTestId('chat-share-provenance')).toBeVisible()
      await expect(dialog.getByTestId('chat-share-memories')).toBeVisible()
      await expect(dialog.getByTestId('chat-share-widen')).toContainText('Bob')
      await expect(dialog.getByTestId('chat-share-save')).toHaveText('그래도 공유')
      await audit(page, 'share dialog, confirm')
      await dialog.getByTestId('chat-share-widen-show').click()
      await expect(page.getByTestId('widening-list')).toBeVisible()
      await expect(page.getByTestId('widening-list-title')).toContainText('Bob')
      const item = page.getByTestId(`widening-item-${w.answerId}`)
      await expect(item).toContainText('Finance › Board pack')
      // the list is about this one chat: no chat title on its items
      await expect(item.getByTestId('widening-item-chat')).toHaveCount(0)
      await audit(page, 'share dialog, widening list')
      if (isPhone(page)) {
        // a phone: the answer on this screen, then "‹ Back to sharing": the dialog again on the list, the pick kept
        await item.getByTestId('widening-item-open').click()
        await expect(page).toHaveURL(new RegExp(`/c/${w.chatId}\\?answer=`))
        await page.getByTestId('back-to-sharing').click()
        await expect(page.getByTestId('widening-list')).toBeVisible()
      } else await expect(item.getByTestId('widening-item-open')).toHaveAttribute('target', '_blank')
      await page.getByTestId('widening-list-back').click()
      await expect(page.getByTestId('participant-user-bob')).toHaveAttribute('data-state', 'new')
      // (back from the phone's answer the check is asked again; on a computer the confirm is still there)
      if (isPhone(page)) await page.getByTestId('chat-share-save').click()
      await expect(page.getByTestId('chat-share-save')).toHaveText('그래도 공유')
      await page.getByTestId('chat-share-save').click()
      await expect(page.getByTestId('toast').filter({ hasText: '1명과 공유했어요' })).toBeVisible()
    })

    test('Bob hides it from his list (opening it brings it back); taken out while it is open, he is told and goes Home', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const w = await world(page)
      expect((await saveAudience(page, w.chatId, [{ subjectType: 'user', subjectId: 'bob' }])).ok()).toBeTruthy()
      const bob = await as(browser, BOB)
      await bob.goto('/')
      let list = await chatList(bob)
      const link = list.locator(`a[href="/c/${w.chatId}"]`).first()
      await expect(link).toBeVisible()
      if (isPhone(bob)) {
        // a phone: the title menu's item (leaves for Home)
        await bob.goto(`/c/${w.chatId}`)
        await bob.getByTestId('chat-menu').click()
        await bob.getByTestId('chat-hide').click()
      } else {
        const row = list.locator('li', { has: bob.locator(`a[href="/c/${w.chatId}"]`) }).first()
        await row.hover()
        await row.getByRole('button', { name: '기록 메뉴', exact: true }).click()
        await expect(bob.getByTestId('chat-row-hide')).toHaveText('내 목록에서 숨기기')
        await bob.getByTestId('chat-row-hide').click()
      }
      await expect(bob.getByTestId('toast').filter({ hasText: '내 목록에서 숨겼어요' })).toBeVisible()
      if (isPhone(bob)) await expect(bob.getByTestId('menu-open')).toBeVisible()
      list = await chatList(bob)
      await expect(list.locator(`a[href="/c/${w.chatId}"]`)).toHaveCount(0)
      // opened again (a link): back in the list
      await bob.goto(`/c/${w.chatId}`)
      await expect(bob.getByTestId('assistant-message').first()).toBeVisible()
      await expect.poll(async () => ((await (await bob.request.get('/api/chats')).json()) as { items: { id: string }[] }).items.some((c) => c.id === w.chatId)).toBe(true)
      // Olga takes him out while it is open: "no longer shared with you" and the way Home
      expect((await saveAudience(page, w.chatId, [{ subjectType: 'user', subjectId: 'sora' }])).ok()).toBeTruthy()
      await expect(bob.getByTestId('chat-not-found')).toHaveAttribute('data-gone', 'shared')
      await expect(bob.getByTestId('chat-not-found')).toContainText('이 채팅은 더 이상 나와 공유되어 있지 않아요.')
      await audit(bob, 'lost access')
      await bob.getByTestId('chat-gone-home').click()
      await expect(bob).toHaveURL(/\/$/)
      await bob.context().close()
    })

    test('a personal project: why not, Move… out, the dialog again; the row menu offers Share…', async ({ page }) => {
      await reset(page)
      await signIn(page)
      await world(page)
      const r = await page.request.post('/api/projects', { headers: H, data: { name: '내 메모', scope: 'personal', participants: [], instructions: '' } })
      expect(r.status()).toBe(201)
      const projectId = ((await r.json()) as { id: string }).id
      const c = await chatOf(page, 'Personal notes', projectId)
      await page.goto(`/c/${c.chatId}`)
      await page.getByTestId('chat-menu').click()
      await page.getByTestId('chat-share').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByTestId('chat-share-personal')).toContainText('개인 프로젝트의 채팅은 나만 봐요')
      await audit(page, 'share dialog, personal project')
      await dialog.getByTestId('chat-share-move').click()
      const move = page.getByRole('dialog')
      await move.getByText('프로젝트 없음', { exact: true }).click()
      await move.getByTestId('chat-project-save').click()
      await expect(page.getByRole('dialog').getByTestId('chat-share-dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      if (!isPhone(page)) {
        const list = await chatList(page)
        const row = list.locator('li', { has: page.locator(`a[href="/c/${c.chatId}"]`) }).first()
        await row.hover()
        await row.getByRole('button', { name: '기록 메뉴', exact: true }).click()
        await expect(page.getByTestId('chat-row-share')).toHaveText('공유…')
        await page.getByTestId('chat-row-share').click()
        await expect(page.getByRole('dialog').getByTestId('chat-share-dialog')).toBeVisible()
      }
    })

    test('the admin deleting an account is told how many of their shared chats go with it', async ({ page, browser }) => {
      // (the members table is the computer's; the dialog is the same on a phone)
      test.skip(vp.name === '390')
      await reset(page)
      await signIn(page)
      await world(page)
      // Bob shares a chat with Olga, who writes in it
      const bob = await as(browser, BOB)
      const s = await chatOf(bob, 'Bob plan')
      expect((await saveAudience(bob, s.chatId, [{ subjectType: 'user', subjectId: 'olga' }])).ok()).toBeTruthy()
      expect((await page.request.post(`/api/chats/${s.chatId}/messages`, { headers: H, data: { content: 'Olga 질문', clientMessageId: uuidv7() } })).status()).toBe(202)
      await bob.context().close()
      await page.goto('/admin/members')
      await page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' }).getByTestId('member-more').click()
      await page.getByTestId('delete-member-bob').click()
      await expect(page.getByTestId('member-delete-shared-chats')).toContainText('1개')
      await audit(page, 'delete account dialog')
    })
  })
}
