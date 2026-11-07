// Shared project chats, phase 1 (docs/DECISIONS.md "Shared project chats"): a project editor turns the setting on in the
// project's edit dialog (its hints: who will see new chats, what turning it off does, why it is off under safe
// operations; none for a personal project); a new chat in that project is seen and continued by the project's people.
// The chat's header has the people icon, the line under the box says how many see it, other people's messages carry
// their names, and only what the person may do is offered. While someone else's question is answered the box keeps the
// text with a line saying whose; the read card goes to the person who asked, the others see that it waits for them.
// At 1440 and 390 px wide, with axe on each screen. The mock (test/mock/server.ts, "shared project chats"): "hold" keeps
// an answer running until POST /__test/shared-release, "readcard" raises the read card first.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const FOOTER_START = 'AI는 실수할 수 있어요. 중요한 내용은 확인해 주세요.'

const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })
const patch = (page: Page, path: string, data: object) => page.request.patch(path, { headers: { [CSRF_HEADER]: '1' }, data })
const del = (page: Page, path: string) => page.request.delete(path, { headers: { [CSRF_HEADER]: '1' } })

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** A team project on marketing/, its setting on (or off) */
async function project(page: Page, share = true) {
  const r = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(r.status()).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  if (share) expect((await patch(page, `/api/projects/${id}`, { shareChats: true })).ok()).toBeTruthy()
  return id
}

/** A shared chat of `page`'s person in the project, with one question answered */
async function sharedChat(page: Page, projectId: string, question: string) {
  const chat = (await (await post(page, '/api/chats', { projectId })).json()) as { id: string; shared?: unknown }
  expect(chat.shared).toBeTruthy()
  expect((await post(page, `/api/chats/${chat.id}/messages`, { content: question, clientMessageId: uuidv7() })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  return chat.id
}

const reason = async (r: { json: () => Promise<unknown> }) => ((await r.json()) as { error: { params?: { reason?: string } } }).error.params?.reason

// reduced motion: a message's actions fade in and out (Messages.tsx); axe must not catch one halfway
for (const vp of [{ name: '1440', phone: false, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`shared project chats at ${vp.name}`, () => {
    test.use(vp.use)

    /** Bob (a member who can read marketing/) in a window of his own */
    async function bob(browser: Browser) {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', ...vp.use })
      const page = await ctx.newPage()
      await signIn(page, BOB)
      return page
    }
    /** the line under the box that says who sees the chat: the row under the box on a computer, under it on a phone */
    const seenLine = (page: Page) => page.getByTestId(vp.phone ? 'composer-phone-footer' : 'composer-footer')

    test('the setting: its hints, on and off, none for a personal project, held under safe operations', async ({ page }) => {
      await reset(page, { withAdmin: true })
      await signIn(page)
      const id = await project(page, false)
      await page.goto(`/projects/${id}`)
      await page.getByTestId('project-menu').click()
      await page.getByTestId('project-edit').click()
      const dialog = page.getByRole('dialog')
      const toggle = dialog.getByTestId('project-share-chats-toggle')
      const hint = dialog.getByTestId('project-share-chats-hint')
      await expect(toggle).not.toBeChecked()
      // Olga, Bob and the two admins read marketing/
      await expect(hint).toHaveText('켜면 새로 여는 채팅을 이 폴더를 볼 수 있는 4명(팀장·관리자 포함)이 보고 이어갈 수 있어요. 지금까지의 채팅은 계속 나만 봐요.')
      await expect(toggle).toHaveAccessibleDescription(/켜면 새로 여는 채팅을/)
      await audit(page, 'project dialog, off')
      await dialog.getByText('이 프로젝트의 채팅을 프로젝트 사람들과 공유').click()
      await expect(toggle).toBeChecked()
      await expect(hint).toHaveText('끄면 새 채팅은 다시 나만 봐요. 이미 공유한 채팅은 그대로 공유돼요.')
      const saved = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/projects/${id}`))
      await dialog.getByTestId('project-save').click()
      expect((await saved).postDataJSON()).toMatchObject({ shareChats: true })
      await expect(dialog).toHaveCount(0)
      // the box says who will see a new chat, and offers team files only
      await expect(seenLine(page)).toHaveText('새 채팅은 프로젝트 사람 4명이 볼 수 있어요.')
      await page.getByTestId('attach-button').click()
      await expect(page.getByTestId('attach-computer')).toHaveCount(0)
      await expect(page.getByTestId('attach-team-only')).toHaveText('공유 채팅에는 팀 파일만 붙일 수 있어요. 컴퓨터의 파일은 프로젝트 폴더에 올린 뒤 붙여 주세요.')
      await page.keyboard.press('Escape')
      // a save that does not touch the setting does not send it
      await page.getByTestId('project-menu').click()
      await page.getByTestId('project-edit').click()
      await expect(toggle).toBeChecked()
      const again = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/api/projects/${id}`))
      await dialog.getByTestId('project-save').click()
      expect((await again).postDataJSON()).not.toHaveProperty('shareChats')

      // a personal project has no such setting
      const mine = ((await (await post(page, '/api/projects', { name: 'Mine', scope: 'personal', instructions: '' })).json()) as { id: string }).id
      await page.goto(`/projects/${mine}`)
      await page.getByTestId('project-menu').click()
      await page.getByTestId('project-edit').click()
      await expect(dialog.getByTestId('project-name')).toBeVisible()
      await expect(dialog.getByTestId('project-share-chats')).toHaveCount(0)
      const refused = await patch(page, `/api/projects/${mine}`, { shareChats: true })
      expect(refused.status()).toBe(409)
      expect(await reason(refused)).toBe('project_personal')

      // safe operations (1A): the switch is off-limits and says why; a new chat in the project is a chat of one person
      expect((await post(page, '/__test/confidential', { all: true })).ok()).toBeTruthy()
      await page.goto(`/projects/${id}`)
      await expect(seenLine(page)).toHaveCount(0)
      await page.getByTestId('project-menu').click()
      await page.getByTestId('project-edit').click()
      await expect(toggle).toBeDisabled()
      await expect(hint).toHaveText('안전 작업 모드에서는 채팅을 공유할 수 없어요.')
      await audit(page, 'project dialog, safe operations')
    })

    test('a shared chat: the header mark, the line under the box, a second person continues, names above messages', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page)
      await page.goto(`/projects/${id}`)
      await expect(seenLine(page)).toHaveText('새 채팅은 프로젝트 사람 2명이 볼 수 있어요.')
      await page.getByTestId('composer-input').fill('출시 일정 정리해 줘')
      await page.getByTestId('send').click()
      await expect(page).toHaveURL(/\/c\/[0-9a-f-]+$/)
      const chatId = page.url().split('/c/')[1]!
      await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('chat-shared')).toHaveAccessibleName('공유 채팅 · 프로젝트 사람 2명이 볼 수 있어요')
      await expect(seenLine(page)).toHaveText(vp.phone ? '프로젝트 사람 2명이 이 채팅을 볼 수 있어요.' : `${FOOTER_START} 프로젝트 사람 2명이 이 채팅을 볼 수 있어요.`)
      // my own message carries no name; the creator renames and deletes, nobody moves it
      await expect(page.getByTestId('message-author')).toHaveCount(0)
      await page.getByTestId('chat-menu').click()
      await expect(page.getByTestId('chat-rename')).toBeVisible()
      await expect(page.getByTestId('chat-delete')).toBeVisible()
      await expect(page.getByTestId('chat-project-move')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await audit(page, 'shared chat, its creator')

      // Bob: not in his list (he has not written in it), but on the project page with the icon and who made it
      const b = await bob(browser)
      expect(((await (await b.request.get('/api/chats')).json()) as { items: { id: string }[] }).items.map((c) => c.id)).not.toContain(chatId)
      await b.goto(`/projects/${id}`)
      const section = b.getByTestId('project-chats')
      await expect(section.getByRole('heading', { name: '채팅' })).toBeVisible()
      const row = section.getByRole('link', { name: /출시 일정/ })
      await expect(row.getByTestId('shared-icon')).toBeVisible()
      await expect(row.getByTestId('project-chat-by')).toHaveText('Olga')
      await audit(b, 'project page, a viewer')
      await row.click()
      await expect(b.getByTestId('user-message')).toHaveCount(1)
      await expect(b.getByTestId('user-message').getByTestId('message-author')).toHaveText('Olga')
      // not his to rename, delete, edit or answer again: a plain title, no edit, no "regenerate", no engine
      await expect(b.getByTestId('chat-menu')).toHaveCount(0)
      await expect(b.getByTestId('chat-title')).toHaveText(/출시 일정/)
      await expect(b.getByTestId('edit-message')).toHaveCount(0)
      await expect(b.getByTestId('regenerate')).toHaveCount(0)
      await expect(b.getByTestId('suggest-skill')).toHaveCount(0)
      await audit(b, 'shared chat, a viewer')
      // he continues it
      await b.getByTestId('composer-input').fill('안내 문구도 써 줘')
      await b.getByTestId('send').click()
      await expect(b.getByTestId('assistant-message')).toHaveCount(2)
      await expect(b.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await expect(b.getByTestId('assistant-message').last()).toContainText('출시는 다음 주 화요일이에요')
      // his own answer is his to answer again; Olga's still is not
      await expect(b.getByTestId('assistant-message').last().getByTestId('regenerate')).toHaveCount(1)
      await expect(b.getByTestId('assistant-message').first().getByTestId('regenerate')).toHaveCount(0)
      // now it is in his list, with the icon (computers: the sidebar)
      expect(((await (await b.request.get('/api/chats')).json()) as { items: { id: string }[] }).items.map((c) => c.id)).toContain(chatId)
      if (!vp.phone) await expect(b.getByRole('link', { name: /공유 채팅.*출시 일정/ })).toBeVisible()

      // Olga's screen reads the messages again when Bob's turn ends: his question with his name
      await expect(page.getByTestId('user-message')).toHaveCount(2)
      await expect(page.getByTestId('user-message').last().getByTestId('message-author')).toHaveText('Bob')
      await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await b.context().close()
    })

    test('the queue line while someone else is answered, and the read card answered yes and no', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page)
      const chatId = await sharedChat(page, id, '출시 일정 정리해 줘')
      await page.goto(`/c/${chatId}`)
      const b = await bob(browser)
      await b.goto(`/c/${chatId}`)
      await expect(b.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')

      // Olga's question runs: Bob's box keeps his text and says whose turn it is
      await b.getByTestId('composer-input').fill('나도 물어볼게')
      await page.getByTestId('composer-input').fill('hold 일정표 다시 봐 줘')
      await page.getByTestId('send').click()
      await expect(page.getByTestId('stop')).toBeVisible()
      const hold = b.getByTestId('composer-hold')
      await expect(hold).toHaveText('Olga님의 질문에 답하는 중이에요. 끝나면 보낼 수 있어요.')
      await expect(b.getByTestId('send')).toBeDisabled()
      await expect(b.getByTestId('stop')).toHaveCount(0)
      await expect(b.getByTestId('send-later')).toHaveCount(0)
      await expect(b.getByTestId('composer-input')).toHaveValue('나도 물어볼게')
      await expect(b.getByTestId('composer-input')).toHaveAccessibleDescription(/Olga님의 질문에 답하는 중이에요/)
      // the question appears for him (no live text): read again when the turn started
      await expect(b.getByTestId('user-message').last()).toContainText('hold 일정표 다시 봐 줘')
      await audit(b, 'queue line')
      // the server says the same to a send or a stop of his
      const busy = await post(b, `/api/chats/${chatId}/messages`, { content: 'x', clientMessageId: uuidv7() })
      expect(busy.status()).toBe(409)
      expect(await reason(busy)).toBe('shared_chat_busy')
      const stop = await post(b, `/api/chats/${chatId}/stop`, {})
      expect(stop.status()).toBe(403)
      expect(await reason(stop)).toBe('shared_chat_runner')
      expect((await post(page, '/__test/shared-release', { chatId })).ok()).toBeTruthy()
      await expect(hold).toHaveCount(0)
      await expect(b.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await expect(b.getByTestId('assistant-message').last()).toContainText('출시는 다음 주 화요일이에요')
      await expect(b.getByTestId('composer-input')).toHaveValue('나도 물어볼게')
      await expect(b.getByTestId('send')).toBeEnabled()

      // the read card: Olga's to answer, Bob sees that it waits for her
      await page.getByTestId('composer-input').fill('readcard 3분기 숫자 알려 줘')
      await page.getByTestId('send').click()
      const card = page.getByTestId('ask-card')
      await expect(card).toHaveAttribute('data-origin', 'server')
      await expect(card).toContainText('AI가 finance/2026/q3.csv을(를) 읽으려고 해요. 이 채팅을 보는 프로젝트 사람 2명 중 1명은 이곳을 볼 수 없어요.')
      await expect(card.getByTestId('ask-yes')).toHaveText('읽고 공유하기')
      await expect(card.getByTestId('ask-no')).toHaveText('읽지 않기')
      await audit(page, 'read card')
      await expect(hold).toHaveText('Olga님의 확인을 기다리는 중이에요.')
      await expect(b.getByTestId('ask-card')).toHaveCount(0)
      await audit(b, 'card waiting')
      await card.getByTestId('ask-yes').click()
      await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('assistant-message').last()).toContainText('3분기 금액은 100이에요')
      await expect(hold).toHaveCount(0)
      await expect(b.getByTestId('assistant-message').last()).toContainText('3분기 금액은 100이에요')

      // answered no: the step says it was not read, and the answer does without it
      await page.getByTestId('composer-input').fill('readcard 다시 3분기')
      await page.getByTestId('send').click()
      await page.getByTestId('ask-card').getByTestId('ask-no').click()
      await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
      await expect(page.getByTestId('assistant-message').last()).toContainText('그 파일은 읽지 않았어요')
      await expect(b.getByTestId('assistant-message').last()).toContainText('그 파일은 읽지 않았어요')
      await b.context().close()
    })

    test('the refusals: what someone may not do is not offered, and the server refuses it too', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page)
      const chatId = await sharedChat(page, id, '출시 일정 정리해 줘')
      const b = await bob(browser)

      // not his: rename, delete, another answer to Olga's question; nobody's: a move, a file from the computer
      const rename = await patch(b, `/api/chats/${chatId}`, { title: 'mine now' })
      expect([rename.status(), await reason(rename)]).toEqual([403, 'shared_chat_creator'])
      const remove = await del(b, `/api/chats/${chatId}`)
      expect([remove.status(), await reason(remove)]).toEqual([403, 'shared_chat_manage'])
      const answer = ((await (await b.request.get(`/api/chats/${chatId}/messages`)).json()) as { items: { id: string; role: string }[] }).items.find((m) => m.role === 'assistant')!
      const again = await post(b, `/api/chats/${chatId}/messages/${answer.id}/regenerate`, {})
      expect([again.status(), await reason(again)]).toEqual([403, 'shared_chat_own_messages'])
      const other = ((await (await post(page, '/api/projects', { name: 'Other', scope: 'team', folderPath: 'docs', instructions: '' })).json()) as { id: string }).id
      const move = await patch(page, `/api/chats/${chatId}`, { projectId: other })
      expect([move.status(), await reason(move)]).toEqual([409, 'shared_chat_move'])
      const upload = await post(page, '/api/upload-sessions', { target: { kind: 'attachment', chatId, name: 'a.txt' }, size: 3, sha256: 'a'.repeat(64) })
      expect([upload.status(), await reason(upload)]).toEqual([409, 'shared_chat_upload'])

      // a computer file given to the box anyway (dropped, pasted) is refused there with the reason
      await page.goto(`/c/${chatId}`)
      await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('acme notes') })
      await expect(page.getByRole('alert').filter({ hasText: '공유 채팅에는 팀 파일만 붙일 수 있어요.' })).toBeVisible()
      await expect(page.getByTestId('attachment-chip')).toHaveCount(0)

      // a send refused in the moment (someone else's question began just before): the text stays, with the reason
      await page.route(`**/api/chats/${chatId}/messages`, (r) => r.request().method() === 'POST'
        ? r.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'Bob님의 질문에 답하는 중이에요. 끝나면 보낼 수 있어요.', params: { reason: 'shared_chat_busy' } } } })
        : r.fallback())
      await page.getByTestId('composer-input').fill('하나 더')
      await page.getByTestId('send').click()
      await expect(page.getByRole('alert').filter({ hasText: 'Bob님의 질문에 답하는 중이에요.' })).toBeVisible()
      await expect(page.getByTestId('composer-input')).toHaveValue('하나 더')
      await expect(page.getByTestId('user-message')).toHaveCount(1)
      await expect(page.getByTestId('send-failed')).toHaveCount(0)
      await audit(page, 'refused send')
      await page.unroute(`**/api/chats/${chatId}/messages`)

      // deleting the project says its shared chat goes too
      await page.goto(`/projects/${id}`)
      await page.getByTestId('project-menu').click()
      await page.getByTestId('project-delete').click()
      await expect(page.getByTestId('project-delete-shared')).toHaveText('공유 채팅 1개도 함께 지워져요.')
      await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()
      // pointing it at another folder (admins) says who will see its shared chat there
      await page.getByTestId('project-menu').click()
      await page.getByTestId('project-edit').click()
      await page.getByTestId('project-folder-choose').click()
      const picker = page.getByRole('dialog').filter({ has: page.getByTestId('folder-pick') })
      await picker.getByRole('button', { name: '팀 폴더' }).click()
      await picker.getByRole('button', { name: 'docs', exact: true }).click()
      await picker.getByTestId('folder-pick').click()
      await expect(page.getByTestId('project-form-repoint-shared')).toHaveText(/^공유 채팅 1개를 이 폴더를 볼 수 있는 \d+명이 보게 돼요\.$/)
      await audit(page, 'repoint')
      await page.getByRole('dialog').getByRole('button', { name: '취소' }).click()

      // safe operations (1A): a shared chat is read-only, and says where to ask instead
      expect((await post(page, '/__test/confidential', { all: true })).ok()).toBeTruthy()
      await b.goto(`/c/${chatId}`)
      await expect(b.getByTestId('shared-safe-ops')).toHaveText('안전 작업 모드라서 공유 채팅을 이어갈 수 없어요. 내 채팅에서 물어봐 주세요.')
      await expect(b.getByTestId('composer-input')).toHaveCount(0)
      const blocked = await post(b, `/api/chats/${chatId}/messages`, { content: 'x', clientMessageId: uuidv7() })
      expect([blocked.status(), await reason(blocked)]).toEqual([409, 'safe_ops'])
      await audit(b, 'safe operations')
      await b.context().close()
    })
  })
}
