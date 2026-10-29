import { CHAT_ERROR_MESSAGES, CSRF_HEADER, ERROR_MESSAGES } from '@mycel/shared/api'
import { expect, test, type Page } from '@playwright/test'
import { realErrors, reset, signIn, watchConsole } from './helpers'
import { DICTS } from '../../src/i18n'

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

test('ask_user card is back after a page reload and the answer still reaches the turn', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await ask(page, 'please ask me something')
  await expect(page.getByTestId('ask-card')).toContainText('어느 분기를 볼까요?')
  await page.reload()
  const card = page.getByTestId('ask-card')
  await expect(card).toContainText('어느 분기를 볼까요?')
  await card.getByLabel('3분기').check()
  await card.getByRole('button', { name: '답하기' }).click()
  await expect(card).toHaveCount(0)
  await expect(lastAnswer(page)).toContainText('You chose "q3"')
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

for (const legacy of [false, true]) {
  for (const reason of ['auth', 'no_credential', 'proxy_down', 'wall_timeout'] as const) {
    test(`${legacy ? 'legacy' : 'reason-bearing'} ${reason} error follows KO → ID → EN through chat re-entry`, async ({ page }) => {
      await reset(page)
      await signIn(page)
      const text = CHAT_ERROR_MESSAGES[reason]
      // The same official phrase in a user message must stay untouched.
      const question = `${legacy ? 'legacy ' : ''}error:${reason}\n${text.ko}`
      await ask(page, question)
      await expect(lastAnswer(page)).toHaveAttribute('data-status', 'error')
      const chatUrl = page.url()
      const error = lastAnswer(page).getByTestId('answer-error')
      await expect(error).toContainText(text.ko)
      for (const locale of ['id', 'en'] as const) {
        await page.goto('/settings/profile')
        await page.getByTestId(`locale-${locale}`).click()
        await expect(page.locator('html')).toHaveAttribute('lang', locale)
        await page.goto(chatUrl)
        await expect(error).toContainText(text[locale])
        await expect(error).not.toContainText(text.ko)
        await expect(error.getByTestId('retry')).toHaveText(locale === 'id' ? 'Coba lagi' : 'Try again')
        await expect(page.getByTestId('user-text')).toHaveText(question)
        await page.reload()
        await expect(error).toContainText(text[locale])
        await expect(page.getByTestId('user-text')).toHaveText(question)
      }
    })
  }
}

for (const [fixture, fallback] of [['unknown', 'Unknown upstream failure'], ['future', ERROR_MESSAGES.engine_unavailable.ko]]) {
  test(`${fixture} stored error stays verbatim after changing language`, async ({ page }) => {
    await reset(page)
    await signIn(page)
    await ask(page, `error:${fixture}\n${CHAT_ERROR_MESSAGES.auth.ko}`)
    await expect(lastAnswer(page)).toHaveAttribute('data-status', 'error')
    const chatUrl = page.url()
    for (const locale of ['id', 'en']) {
      await page.goto('/settings/profile')
      await page.getByTestId(`locale-${locale}`).click()
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await page.goto(chatUrl)
      await expect(lastAnswer(page).getByTestId('answer-error')).toContainText(fallback!)
      await expect(page.getByTestId('user-text')).toContainText(CHAT_ERROR_MESSAGES.auth.ko)
    }
  })
}

// B-W41-2 / UI-02, shared dialog helper: a menu item unmounts when its menu closes, so the dialog it opens
// must return focus to the menu's trigger, not to BODY. The sidebar chat menu has no page-level anchor.
for (const openWith of ['keyboard', 'mouse'] as const) {
  for (const [item, dismissWith] of [['common.delete', 'Escape'], ['chat.rename', 'Escape'], ['common.delete', 'Cancel']] as const) {
    test(`sidebar chat menu dialog returns focus to the menu button (${openWith}, ${item}, ${dismissWith})`, async ({ page }) => {
      const t = DICTS.ko
      await reset(page)
      await signIn(page)
      for (const title of ['Focus chat A', 'Focus chat B']) {
        expect((await page.request.post('/api/chats', { headers: { [CSRF_HEADER]: '1' }, data: { title } })).ok()).toBeTruthy()
      }
      await page.reload()
      for (const title of ['Focus chat B', 'Focus chat A']) {
        const li = page.getByRole('listitem').filter({ hasText: title })
        const trigger = li.getByRole('button', { name: t['chat.menu'], exact: true })
        const choice = li.getByRole('menuitem', { name: t[item] })
        if (openWith === 'keyboard') {
          await trigger.focus()
          await page.keyboard.press('Enter')
          await choice.focus()
          await page.keyboard.press('Enter')
        } else {
          await li.hover()
          await trigger.click()
          await choice.click()
        }
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        if (dismissWith === 'Escape') await page.keyboard.press('Escape')
        else await dialog.getByRole('button', { name: t['common.cancel'], exact: true }).click()
        await expect(dialog).toHaveCount(0)
        await expect(trigger).toBeFocused()
        await expect(li).toBeVisible()
      }
    })
  }
}
