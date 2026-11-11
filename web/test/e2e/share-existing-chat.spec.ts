// An existing private chat shared with its project's people (docs/DECISIONS.md "Shared project chats", "An existing chat
// shared"): the move dialog's switch "프로젝트 사람들과 공유" (off by default; nothing narrower: shared right after the move),
// the confirm when the chat used something some of the project cannot see (cancel: moved, still private; from the title
// menu it asks first even when nothing is narrower), the same
// from a chat row's "…" menu in the sidebar (the list grouped by project, so the moved chat's row is made again while
// the dialog stays), the title menu's "프로젝트 사람들과 공유…", and a second person sees the chat afterwards. At 1440 and 390 px wide, with axe on each
// dialog. The mock (test/mock/server.ts, "프로젝트 사람들과 공유"): "mine-source" in a question reads a note in my own
// folder, "memory" brings the memory note.
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

/** A team project on marketing/ (Olga and Bob read it), its setting on */
async function project(page: Page, share = true) {
  const r = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: '' })
  expect(r.status()).toBe(201)
  const id = ((await r.json()) as { id: string }).id
  if (share) expect((await patch(page, `/api/projects/${id}`, { shareChats: true })).ok()).toBeTruthy()
  return id
}

/** A private chat of Olga's with one question answered, outside any project (or moved into `projectId`) */
async function privateChat(page: Page, question: string, projectId?: string) {
  const chat = (await (await post(page, '/api/chats', {})).json()) as { id: string; shared?: unknown }
  expect(chat.shared).toBeUndefined()
  expect((await post(page, `/api/chats/${chat.id}/messages`, { content: question, clientMessageId: uuidv7() })).status()).toBe(202)
  await expect.poll(async () => ((await (await page.request.get(`/api/chats/${chat.id}`)).json()) as { runState: string }).runState).toBe('idle')
  if (projectId) expect((await patch(page, `/api/chats/${chat.id}`, { projectId })).ok()).toBeTruthy()
  return chat.id
}

// reduced motion: dialogs and toasts appear without a transition axe could catch halfway
for (const vp of [{ name: '1440', phone: false, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } }, { name: '390', phone: true, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } }]) {
  test.describe(`sharing an existing chat at ${vp.name}`, () => {
    test.use(vp.use)

    async function bob(browser: Browser) {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, locale: 'ko-KR', ...vp.use })
      const page = await ctx.newPage()
      await signIn(page, BOB)
      return page
    }
    const seenLine = (page: Page) => page.getByTestId(vp.phone ? 'composer-phone-footer' : 'composer-footer')
    /** the title menu's "Move to project…", the project picked */
    async function openMove(page: Page) {
      await page.getByTestId('chat-menu').click()
      await page.getByTestId('chat-project-move').click()
      const dialog = page.getByRole('dialog')
      await dialog.getByText('Launch', { exact: true }).click()
      return dialog
    }

    test('moved with the switch on and nothing narrower: shared right away, and Bob sees it', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page)
      const chatId = await privateChat(page, '출시 일정 정리해 줘')
      await page.goto(`/c/${chatId}`)
      await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      const dialog = await openMove(page)
      // the switch: off by default, with what it does under it
      const toggle = dialog.getByTestId('chat-project-share-toggle')
      await expect(toggle).not.toBeChecked()
      await expect(dialog.getByTestId('chat-project-share-hint')).toHaveText('공유하면 지금까지의 대화도 모두 보여요. 공유는 되돌릴 수 없어요.')
      await expect(toggle).toHaveAccessibleDescription(/되돌릴 수 없어요/)
      await audit(page, 'move dialog with the share switch')
      // no project: no switch
      await dialog.getByText('프로젝트 없음').click()
      await expect(dialog.getByTestId('chat-project-share')).toHaveCount(0)
      await dialog.getByText('Launch', { exact: true }).click()
      await dialog.getByText('프로젝트 사람들과 공유', { exact: true }).click()
      await expect(toggle).toBeChecked()
      await dialog.getByTestId('chat-project-save').click()
      await expect(page.getByTestId('toast').filter({ hasText: '프로젝트 사람들과 공유했어요' })).toBeVisible()
      // one toast: the share says it (the header says where it went)
      await expect(page.getByTestId('toast')).toHaveCount(1)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      // the header's mark and the line under the box, as for any shared chat
      await expect(page.getByTestId('chat-project')).toHaveText('Launch')
      await expect(page.getByTestId('chat-shared')).toHaveAccessibleName('공유 채팅 · 프로젝트 사람 2명이 볼 수 있어요')
      await expect(seenLine(page)).toContainText('프로젝트 사람 2명이 이 채팅을 볼 수 있어요.')
      // nothing to share any more in the menu
      await page.getByTestId('chat-menu').click()
      await expect(page.getByTestId('chat-share')).toHaveCount(0)
      await expect(page.getByTestId('chat-project-move')).toHaveCount(0)
      await page.keyboard.press('Escape')

      // Bob: on the project page, with the mark and who made it; he opens it and can write in it
      const b = await bob(browser)
      await b.goto(`/projects/${id}`)
      const row = b.getByTestId('project-chats').getByRole('link', { name: /출시 일정/ })
      await expect(row.getByTestId('shared-icon')).toBeVisible()
      await expect(row.getByTestId('project-chat-by')).toHaveText('Olga')
      await row.click()
      await expect(b.getByTestId('user-message')).toHaveCount(1)
      await expect(b.getByTestId('user-message').getByTestId('message-author')).toHaveText('Olga')
      await expect(b.getByTestId('composer-input')).toBeEditable()
      await b.context().close()
    })

    test('moved with the switch on, and it used my own folder and memories: the confirm; cancel leaves it moved and private', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      await project(page)
      const chatId = await privateChat(page, 'mine-source memory 메모 정리해 줘')
      await page.goto(`/c/${chatId}`)
      await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      const dialog = await openMove(page)
      await dialog.getByText('프로젝트 사람들과 공유', { exact: true }).click()
      await dialog.getByTestId('chat-project-save').click()
      // one dialog asks (no toast over it: the move is told when it ends up not shared)
      const ask = page.getByRole('dialog', { name: '이 채팅을 공유해서 프로젝트 사람 2명이 볼 수 있게 할까요?' })
      await expect(ask).toBeVisible()
      await expect(ask.getByTestId('share-chat-note')).toHaveText('공유하면 지금까지의 대화도 모두 보여요. 공유는 되돌릴 수 없어요.')
      await expect(ask.getByTestId('share-chat-provenance')).toHaveText('이 채팅에는 프로젝트 사람 1명이 볼 수 없는 자료의 내용이 들어 있어요: 내 폴더')
      await expect(ask.getByTestId('share-chat-memories')).toHaveText('개인 메모리를 참고한 답이 있을 수 있어요')
      // 공유하기 is the default; the note comes first, before anything else in the dialog's body
      await expect(ask.getByTestId('share-chat-confirm')).toBeFocused()
      await expect(ask.getByTestId('share-chat-ask').locator('p').first()).toHaveAttribute('data-testid', 'share-chat-note')
      await audit(page, 'share confirm')
      await expect(page.getByTestId('toast')).toHaveCount(0)
      await ask.getByTestId('share-chat-cancel').click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      // moved (now it says so), and still mine alone
      await expect(page.getByTestId('toast').filter({ hasText: "'Launch' 프로젝트로 옮겼어요" })).toBeVisible()
      await expect(page.getByTestId('chat-project')).toHaveText('Launch')
      await expect(page.getByTestId('chat-shared')).toHaveCount(0)
      const b = await bob(browser)
      expect((await b.request.get(`/api/chats/${chatId}`)).status()).toBe(404)
      await b.context().close()
    })

    test('from a chat row\'s "…" in the sidebar: moved with the switch on, the confirm, shared; the row moves to its project and keeps the dialog', async ({ page, browser }) => {
      await reset(page)
      // the history grouped by project: the moved chat's row goes to another group (and is made again)
      await page.addInitScript(() => localStorage.setItem('mycel.sidebar.recentsView', JSON.stringify({ status: 'all', activity: 'all', group: 'project', sort: 'updated' })))
      await signIn(page)
      await project(page)
      const chatId = await privateChat(page, 'mine-source 경쟁사 메모 정리해 줘')
      await page.goto('/')
      if (vp.phone) await page.getByTestId('menu-open').click()
      const list = page.locator(vp.phone ? '[data-drawer]' : 'body').getByTestId('recents-list')
      const row = list.getByRole('listitem').filter({ hasText: '경쟁사 메모' })
      await row.hover()
      await row.getByRole('button', { name: '기록 메뉴', exact: true }).click()
      await row.getByTestId('chat-row-move').click()
      const dialog = page.getByRole('dialog', { name: '이 기록의 프로젝트' })
      await dialog.getByText('Launch', { exact: true }).click()
      await expect(dialog.getByTestId('chat-project-share-toggle')).not.toBeChecked()
      await audit(page, 'move dialog from the row menu')
      await dialog.getByText('프로젝트 사람들과 공유', { exact: true }).click()
      await dialog.getByTestId('chat-project-save').click()
      const ask = page.getByRole('dialog', { name: '이 채팅을 공유해서 프로젝트 사람 2명이 볼 수 있게 할까요?' })
      await expect(ask.getByTestId('share-chat-provenance')).toHaveText('이 채팅에는 프로젝트 사람 1명이 볼 수 없는 자료의 내용이 들어 있어요: 내 폴더')
      // the row went under its project meanwhile; the question is still there
      await expect(list.getByRole('heading', { name: 'Launch' })).toBeVisible()
      await expect(ask).toBeVisible()
      await audit(page, 'share confirm from the row menu')
      await ask.getByTestId('share-chat-confirm').click()
      await expect(page.getByTestId('toast').filter({ hasText: '프로젝트 사람들과 공유했어요' })).toBeVisible()
      await expect(page.getByRole('dialog', { name: '이 채팅을 공유해서 프로젝트 사람 2명이 볼 수 있게 할까요?' })).toHaveCount(0)
      // the row has the shared mark, and its menu has no move any more
      await expect(list.getByRole('listitem').filter({ hasText: '경쟁사 메모' }).getByTestId('shared-icon')).toBeVisible()
      const b = await bob(browser)
      expect((await b.request.get(`/api/chats/${chatId}`)).status()).toBe(200)
      await b.context().close()
    })

    test('the title menu asks first even when nothing is narrower: the sentence alone, then shared', async ({ page }) => {
      await reset(page)
      await signIn(page)
      const id = await project(page)
      const chatId = await privateChat(page, '출시 일정 정리해 줘', id)
      await page.goto(`/c/${chatId}`)
      await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      await page.getByTestId('chat-menu').click()
      await page.getByTestId('chat-share').click()
      const ask = page.getByRole('dialog', { name: '이 채팅을 공유해서 프로젝트 사람 2명이 볼 수 있게 할까요?' })
      await expect(ask.getByTestId('share-chat-note')).toHaveText('공유하면 지금까지의 대화도 모두 보여요. 공유는 되돌릴 수 없어요.')
      await expect(ask.getByTestId('share-chat-provenance')).toHaveCount(0)
      await expect(ask.getByTestId('share-chat-memories')).toHaveCount(0)
      await expect(page.getByTestId('chat-shared')).toHaveCount(0)
      await ask.getByTestId('share-chat-confirm').click()
      await expect(page.getByTestId('toast').filter({ hasText: '프로젝트 사람들과 공유했어요' })).toBeVisible()
      await expect(page.getByTestId('chat-shared')).toBeVisible()
    })

    test('the title menu shares a private chat already in the project: the confirm, then shared; Bob sees it', async ({ page, browser }) => {
      await reset(page)
      await signIn(page)
      const quiet = await project(page, false)
      const before = await privateChat(page, 'mine-source 메모 정리해 줘', quiet)
      // a project that does not share its chats: no such item
      await page.goto(`/c/${before}`)
      await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
      await page.getByTestId('chat-menu').click()
      await expect(page.getByTestId('chat-project-move')).toBeVisible()
      await expect(page.getByTestId('chat-share')).toHaveCount(0)
      await page.keyboard.press('Escape')
      // now it does
      expect((await patch(page, `/api/projects/${quiet}`, { shareChats: true })).ok()).toBeTruthy()
      await page.reload()
      await expect(page.getByTestId('chat-project')).toHaveText('Launch')
      await page.getByTestId('chat-menu').click()
      const item = page.getByTestId('chat-share')
      await expect(item).toHaveText('프로젝트 사람들과 공유…')
      await audit(page, 'chat menu with share')
      await item.click()
      const ask = page.getByRole('dialog', { name: '이 채팅을 공유해서 프로젝트 사람 2명이 볼 수 있게 할까요?' })
      await expect(ask.getByTestId('share-chat-provenance')).toHaveText('이 채팅에는 프로젝트 사람 1명이 볼 수 없는 자료의 내용이 들어 있어요: 내 폴더')
      await expect(ask.getByTestId('share-chat-memories')).toHaveCount(0)
      // asked again when something changed meanwhile, said so on top
      expect((await post(page, '/__test/share-changed', {})).ok()).toBeTruthy()
      await ask.getByTestId('share-chat-confirm').click()
      const again = page.getByRole('dialog', { name: '이 채팅을 공유해서 프로젝트 사람 2명이 볼 수 있게 할까요?' })
      await expect(again.getByTestId('share-chat-changed')).toHaveText('그 사이 바뀐 것이 있어요. 다시 확인해 주세요')
      await expect(again.getByTestId('share-chat-confirm')).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('toast').filter({ hasText: '프로젝트 사람들과 공유했어요' })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByTestId('chat-shared')).toBeVisible()
      await expect(seenLine(page)).toContainText('프로젝트 사람 2명이 이 채팅을 볼 수 있어요.')
      await audit(page, 'shared chat after sharing')
      const b = await bob(browser)
      await b.goto(`/c/${before}`)
      await expect(b.getByTestId('user-message').getByTestId('message-author')).toHaveText('Olga')
      await expect(b.getByTestId('chat-shared')).toBeVisible()
      await b.context().close()
    })
  })
}
