// The chat screen, like Claude's: answers are plain text with nothing beside them, the newest answer keeps its actions
// in view (older ones show them on hover or focus; on a phone after a tap), the chat's name opens rename and
// delete, a file sent with a message is a small card, and the box says "Reply" in a chat that has started. The box
// holds only the text and a quiet send key; attach, voice and the engine sit in one row under it, with the note.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const post = (page: Page, path: string, data: object) => page.request.post(path, { headers: { [CSRF_HEADER]: '1' }, data })

async function newProject(page: Page) {
  const r = await post(page, '/api/projects', { name: 'Launch', scope: 'team', folderPath: 'marketing', instructions: 'Short answers.' })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}

/** A chat named "Launch plan" with two questions answered. */
async function chatWithTwoAnswers(page: Page, projectId?: string) {
  const r = await post(page, '/api/chats', { ...(projectId ? { projectId } : {}), title: 'Launch plan' })
  const id = ((await r.json()) as { id: string }).id
  await page.goto(`/c/${id}`)
  const input = page.getByTestId('composer-input')
  for (const [i, q] of ['first question', 'second question'].entries()) {
    await input.fill(q)
    await page.getByTestId('send').click()
    await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(i + 1)
  }
  return id
}

const NOTE = 'AI는 실수할 수 있어요. 중요한 내용은 확인해 주세요. 내 채팅은 나만 볼 수 있어요.'

/** The box holds the text and the send key; attach, voice and the engine are in the row under it. */
async function expectBoxLikeClaude(page: Page) {
  const box = page.getByTestId('composer')
  const row = page.getByTestId('composer-controls')
  await expect(box.getByTestId('composer-input')).toBeVisible()
  await expect(box.getByTestId('send')).toBeVisible()
  await expect(box.getByTestId('attach-button')).toHaveCount(0)
  await expect(row.getByTestId('attach-button')).toBeVisible()
  await expect(row.getByRole('button', { name: '음성 입력 (Space 길게)' })).toBeVisible()
  await expect(row.getByTestId('engine-picker')).toBeVisible()
  // one line until there is more to say
  expect((await box.getByTestId('composer-input').boundingBox())!.height).toBeLessThanOrEqual(50)
  const rowTop = (await row.boundingBox())!.y
  const boxBottom = (await box.boundingBox())!.y + (await box.boundingBox())!.height
  expect(rowTop).toBeGreaterThanOrEqual(boxBottom - 1)
}

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

test('answers have nothing beside them, and only the newest keeps its actions in view', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await chatWithTwoAnswers(page)
  const answers = page.getByTestId('assistant-message')
  // no picture next to an answer
  await expect(answers.locator('.lucide-sparkles')).toHaveCount(0)
  await expect(answers.first().getByText('first question')).toBeVisible()
  const older = answers.first().getByTestId('answer-actions')
  const newest = answers.last().getByTestId('answer-actions')
  await page.mouse.move(5, 5)
  await expect(newest).toHaveCSS('opacity', '1')
  await expect(older).toHaveCSS('opacity', '0')
  await answers.first().hover()
  await expect(older).toHaveCSS('opacity', '1')
  await page.mouse.move(5, 5)
  await expect(older).toHaveCSS('opacity', '0')
  // from the keyboard: focus on an action shows the row
  await older.getByTestId('regenerate').focus()
  await expect(older).toHaveCSS('opacity', '1')
  // a chat that has started says "Reply"; a new chat keeps its own hint
  await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', '답장하기')
  await page.goto('/')
  await expect(page.getByTestId('composer-input')).toHaveAttribute('placeholder', '무엇이든 물어보세요')
})

test("the chat's name opens rename and delete, after the project it is in", async ({ page }) => {
  await reset(page)
  await signIn(page)
  const projectId = await newProject(page)
  await chatWithTwoAnswers(page, projectId)
  await expect(page.getByTestId('chat-project')).toHaveText('Launch')
  await expect(page.getByTestId('chat-project')).toHaveAttribute('href', `/projects/${projectId}`)
  const title = page.getByTestId('chat-title')
  await expect(title).toHaveText('Launch plan')
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible()
  const name = page.getByTestId('chat-menu')
  await name.click()
  await expect(page.getByTestId('chat-rename')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  // the chat is in a project: "Change project…" sits between Rename and Delete
  await expect(page.getByTestId('chat-project-move')).toBeFocused()
  await expect(page.getByTestId('chat-project-move')).toHaveText(/Change project…|프로젝트 바꾸기…/)
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('chat-delete')).toBeFocused()
  await audit(page, 'chat menu')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(name).toBeFocused()
  // rename: the top line and the sidebar both follow
  await name.click()
  await page.getByTestId('chat-rename').click()
  await page.getByRole('dialog').getByRole('textbox').fill('Shorter plan')
  await page.getByTestId('dialog-confirm').click()
  await expect(title).toHaveText('Shorter plan')
  await expect(page.locator('nav').getByRole('link', { name: 'Shorter plan' })).toBeVisible()
  // a click outside closes the menu
  await name.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByTestId('messages').click({ position: { x: 5, y: 5 } })
  await expect(page.getByRole('menu')).toBeHidden()
  // delete: to the trash, and back to a new chat
  await name.click()
  await page.getByTestId('chat-delete').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText('채팅을 삭제했어요.')).toBeVisible()
})

test('the message box is one line with a quiet send key, and the controls sit under it, on every page with the box', async ({ page }) => {
  await reset(page)
  await signIn(page)
  // the new-chat page and a project's page use the same box
  await expectBoxLikeClaude(page)
  const projectId = await newProject(page)
  await page.goto(`/projects/${projectId}`)
  await expectBoxLikeClaude(page)
  await chatWithTwoAnswers(page)
  await expectBoxLikeClaude(page)
  // the send key: dim and off while the box is empty, on with text in it
  const send = page.getByTestId('send')
  await expect(send).toBeDisabled()
  await expect(send).toHaveClass(/text-faint/)
  await page.getByTestId('composer-input').fill('one more thing')
  await expect(send).toBeEnabled()
  await expect(send).toHaveClass(/text-ink/)
  // the note is in the row, between the controls
  await expect(page.getByTestId('composer-controls').getByText(NOTE)).toBeVisible()
  await expect(page.getByText(NOTE)).toHaveCount(1)
  // while an answer runs, Stop takes the send key's place in the box
  await page.getByTestId('composer-input').fill('slow answer please, slow slow slow slow slow slow slow slow slow slow')
  await send.click()
  await expect(page.getByTestId('composer').getByTestId('stop')).toBeVisible()
  await expect(page.getByTestId('composer').getByTestId('send')).toHaveCount(0)
  await page.getByTestId('stop').click()
  await expect(page.getByTestId('composer').getByTestId('send')).toBeVisible()
})

test('a file sent with a message is a small card with its name, type and size', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('file-input').setInputFiles({ name: 'launch-brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Spring launch\n') })
  await expect(page.getByTestId('attachment-chip')).toContainText('launch-brief.txt')
  await expect(page.getByTestId('attachment-chip').locator('.animate-spin')).toHaveCount(0)
  await page.getByTestId('composer-input').fill('read the brief')
  await page.getByTestId('send').click()
  const card = page.getByTestId('user-message').locator('[data-source="upload"]')
  await expect(card).toContainText('launch-brief.txt')
  await expect(card).toContainText('TXT')
  await expect(card).toContainText('14 B')
  await expect(card.locator('svg')).toHaveCount(0)
})

test('on a phone the newest answer shows its actions, an older answer or my message after a tap, and the chat fits a phone', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'ko-KR', baseURL: test.info().project.use.baseURL })
  const page = await ctx.newPage()
  await reset(page)
  await signIn(page)
  await chatWithTwoAnswers(page)
  expect(await page.evaluate(() => matchMedia('(hover: hover)').matches)).toBe(false)
  const answers = page.getByTestId('assistant-message')
  const mine = page.getByTestId('user-message').first()
  await expect(answers.last().getByTestId('answer-actions')).toBeVisible()
  await expect(answers.last().getByTestId('answer-actions')).toHaveCSS('clip-path', 'none')
  // no hover on a phone: the actions of older messages are out of sight until the message is tapped (sr-only), but a
  // screen reader still reads them
  await expect(answers.first().getByTestId('answer-actions')).toHaveCSS('clip-path', 'inset(50%)')
  await expect(mine.getByTestId('message-actions')).toHaveCSS('clip-path', 'inset(50%)')
  expect(await answers.first().ariaSnapshot()).toContain('button "다시 생성"')
  expect(await mine.ariaSnapshot()).toContain('button "메시지 수정"')
  await answers.first().getByText('first question').tap()
  await expect(answers.first().getByTestId('answer-actions')).toHaveCSS('clip-path', 'none')
  await expect(answers.first().getByTestId('answer-actions-tap')).toHaveCSS('clip-path', 'none')
  await expect(answers.first().getByTestId('regenerate')).toBeVisible()
  await mine.getByTestId('user-text').tap()
  await expect(mine.getByTestId('message-actions-tap')).toHaveCSS('clip-path', 'none')
  // the branch switch ("‹ 2 / 2 ›") always shows; the other actions still wait for the tap
  await mine.getByTestId('edit-message').tap()
  await page.getByTestId('edit-input').fill('first question, again')
  await page.getByTestId('edit-send').tap()
  await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1)
  const edited = page.getByTestId('user-message').first()
  await expect(edited.getByTestId('branch-label')).toHaveText('2 / 2')
  await expect(edited.getByTestId('branch-nav')).toBeVisible()
  await expect(edited.getByTestId('message-actions')).toHaveCSS('clip-path', 'none')
  await expect(edited.getByTestId('message-actions-tap')).toHaveCSS('clip-path', 'inset(50%)')
  await expect(page.getByTestId('chat-menu')).toBeVisible()
  // on a phone the note under the message box is left out (the bottom is for the box and the keyboard); the chat's own
  // bar (back, title, new chat) is the only bar
  await expect(page.getByText(NOTE)).toBeHidden()
  await expect(page.getByTestId('chat-back')).toBeVisible()
  await expect(page.getByTestId('menu-open')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await audit(page, 'chat on a phone')
  await ctx.close()
})

for (const scheme of ['light', 'dark'] as const) {
  test(`the chat screen passes the accessibility checks (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await reset(page)
    await signIn(page)
    await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes\n') })
    await expect(page.getByTestId('attachment-chip').locator('.animate-spin')).toHaveCount(0)
    await page.getByTestId('composer-input').fill('read the notes')
    await page.getByTestId('send').click()
    await expect(page.locator('[data-testid="assistant-message"][data-status="done"]')).toHaveCount(1)
    await audit(page, `chat (${scheme})`)
  })
}
