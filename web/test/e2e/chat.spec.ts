import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'

async function ask(page: Page, text: string) {
  await page.getByTestId('composer-input').fill(text)
  await page.getByTestId('send').click()
}
const lastAnswer = (page: Page) => page.getByTestId('assistant-message').last()

test('streaming answer: markdown, math, code, table, steps; external images are not loaded', async ({ page }) => {
  await reset(page)
  const errors = watchConsole(page)
  const external: string[] = []
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1')) external.push(r.url())
  })
  await signIn(page)
  await ask(page, 'Hello there, search the web')
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('user-text')).toHaveText('Hello there, search the web')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  const a = lastAnswer(page)
  await expect(a.locator('table')).toContainText('alpha')
  await expect(a.locator('.katex')).toHaveCount(1) // $x^2 + 1$; "$5" stays a price
  await expect(a).toContainText('price of $5')
  await expect(a.locator('code.hljs').first()).toContainText('print')
  await expect(a.getByText('외부 이미지 · evil.example')).toBeVisible()
  await expect(a.locator('img[src*="evil.example"]')).toHaveCount(0)
  await expect(a.locator('svg[id^="mmd-"], [role="img"] svg').first()).toBeVisible()
  // steps fold into a summary when done; web search sources are plain links
  await a.getByText('작업 2단계').click()
  await a.getByText('Web search "team ax"').click()
  await expect(a.getByTestId('search-sources').getByRole('link')).toHaveAttribute('href', 'https://example.com/a')
  // a result with a javascript: address is shown as text, not as a link
  await expect(a.getByTestId('search-sources').getByRole('link')).toHaveCount(1)
  await expect(a.getByTestId('search-sources')).toContainText('Poisoned result')
  // the chat shows up in the sidebar, titled by the server
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Hello there, search the web' })).toBeVisible()
  expect(external).toEqual([])
  expect(realErrors(errors)).toEqual([])
})

test('copy answer, regenerate makes a branch, ‹ › switches back', async ({ page, context }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'first question')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await lastAnswer(page).hover()
  await lastAnswer(page).getByRole('button', { name: '답변 복사' }).click()
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('Here is **the answer** for: first question')
  void context
  await lastAnswer(page).getByTestId('regenerate').click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(lastAnswer(page).getByTestId('branch-label')).toHaveText('2 / 2')
  await lastAnswer(page).getByRole('button', { name: '이전 버전' }).click()
  await expect(lastAnswer(page).getByTestId('branch-label')).toHaveText('1 / 2')
})

test('edit the question makes a new branch; files changed in the turn are summarized', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'write the files please')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  const summary = lastAnswer(page).getByTestId('file-summary')
  await expect(summary).toContainText('파일 1개 저장 · 1개 충돌 사본 · 1개 권한 없음')
  await summary.getByRole('button').first().click()
  await expect(summary).toContainText('marketing/report.md')
  await summary.getByRole('button', { name: 'marketing/report.md' }).click()
  await expect(page.getByTestId('file-panel')).toContainText('Report')
  const user = page.getByTestId('user-message').first()
  await user.hover()
  await user.getByRole('button', { name: '메시지 수정' }).click()
  await page.getByLabel('메시지 수정').fill('edited question')
  await page.getByTestId('edit-send').click()
  // the earlier answer changed files: the person is told they stay changed
  await expect(page.getByRole('dialog')).toContainText('되돌아가지 않아요')
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByTestId('user-text')).toHaveText('edited question')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('user-message').getByTestId('branch-label')).toHaveText('2 / 2')
})

test('stop a running answer', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'slow answer please, slow slow slow slow slow slow slow slow slow slow')
  await expect(page.getByTestId('stop')).toBeVisible()
  await page.getByTestId('stop').click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'stopped')
  await expect(lastAnswer(page)).toContainText('중지됨')
  await expect(page.getByTestId('send')).toBeVisible()
})

test('ask_user card: pick an option, the answer continues', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'please ask me something')
  const card = page.getByTestId('ask-card')
  await expect(card).toContainText('어느 분기를 볼까요?')
  // a free-text answer goes to the AI: the card always says not to type secrets there
  await expect(card.getByTestId('ask-no-secrets')).toHaveText('비밀번호·인증 코드는 AI에게 알려 주지 마세요.')
  await card.getByLabel('4분기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(card).toHaveCount(0)
  await expect(lastAnswer(page)).toContainText('You chose "q4"')
})

test('a safety check the server raised has its own header, never the "AI asks" one', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'ask me a safety question')
  const card = page.getByTestId('ask-card')
  await expect(card).toHaveAttribute('data-origin', 'server')
  await expect(card).toContainText('팀 서버의 안전 확인')
  await expect(card).not.toContainText('AI가 확인하고 싶어 해요')
  await card.getByLabel('열지 않기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(card).toHaveCount(0)
})

test('an error answer offers retry', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'cause an error')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'error')
  await expect(lastAnswer(page).getByTestId('answer-error')).toContainText('지금은 AI 엔진을 쓸 수 없습니다. 팀장에게 알려 주세요')
})

test('attachments: an image is uploaded right away and shown as a thumbnail', async ({ page }) => {
  await reset(page)
  await signIn(page)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEhAG1y0w7JgAAAABJRU5ErkJggg==', 'base64')
  await page.getByTestId('file-input').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByTestId('attachment-chip')).toContainText('dot.png')
  await expect(page.getByTestId('attachment-chip')).not.toContainText('%')
  await ask(page, 'what is in the picture?')
  const user = page.getByTestId('user-message').first()
  await expect(user.locator('img[alt="dot.png"]')).toBeVisible()
  await expect(user.locator('img[alt="dot.png"]')).toHaveAttribute('src', /\/api\/uploads\/[0-9a-f-]+\/thumbnail/)
})

test('search (⌘K) finds chats by content', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'banana bread recipe')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await page.getByTestId('new-chat').click()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByPlaceholder('채팅 제목이나 내용으로 찾기').fill('banana')
  await expect(page.getByRole('option', { name: /banana bread recipe/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('user-text')).toHaveText('banana bread recipe')
})
