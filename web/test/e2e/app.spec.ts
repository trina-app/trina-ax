import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'
import { PRODUCT } from '@mycel/shared'

test('a dropped WebSocket shows "reconnecting", resumes, and the answer continues', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('slow answer, slow slow slow slow slow slow slow slow slow slow slow slow')
  await page.getByTestId('send').click()
  const answer = page.getByTestId('assistant-message').last()
  await expect(answer).toContainText('Here is')
  await page.request.post('/__test/drop-ws')
  await expect(page.getByTestId('conn-banner')).toContainText('다시 연결하는 중')
  await expect(page.getByTestId('conn-banner')).toHaveCount(0, { timeout: 8000 })
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 20_000 })
  // the resumed stream did not lose or repeat text
  const text = await answer.locator('.answer').first().innerText()
  expect(text).toContain('Here is the answer for: slow answer')
  expect(text.match(/Here is/g)).toHaveLength(1)
})

test('a new server version offers a reload', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.request.post('/__test/server-version', { data: { version: '0.2.0' } })
  await page.request.post('/__test/drop-ws')
  await expect(page.getByText('새 버전이 준비됐어요.')).toBeVisible({ timeout: 8000 })
  await expect(page.getByRole('button', { name: '새로 고침' })).toBeVisible()
})

test('projects: create one on a folder, open a chat in it', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByRole('link', { name: '프로젝트' }).click()
  await page.getByTestId('project-new').click()
  await page.getByTestId('project-name').fill('Launch')
  await page.getByRole('dialog').getByRole('button', { name: '선택' }).click()
  await page.getByRole('dialog').last().getByRole('button', { name: 'marketing' }).click()
  await page.getByTestId('folder-pick').click()
  await page.getByRole('dialog').getByLabel('지침').fill('Answer in short bullet points.')
  await page.getByTestId('project-save').click()
  await expect(page.getByRole('heading', { name: 'Launch' })).toBeVisible()
  await expect(page.getByText('Answer in short bullet points.')).toBeVisible()
  await page.getByTestId('project-chat').click()
  await expect(page.getByText('이 프로젝트의 폴더와 지침으로 대화해요')).toBeVisible()
  await page.getByTestId('composer-input').fill('project question')
  await page.getByTestId('send').click()
  await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'done')
  const log = (await (await page.request.post('/__test/log')).json()) as string[]
  expect(log).toContain('POST /api/projects')
})

test('settings: memory list and forget; devices', async ({ page }) => {
  await reset(page)
  await page.request.post('/__test/memory', { data: { text: 'Prefers answers in Korean' } })
  await signIn(page)
  await page.goto('/settings/memory')
  await expect(page.getByTestId('memory-list')).toContainText('Prefers answers in Korean')
  await page.getByRole('button', { name: '잊게 하기' }).click()
  await expect(page.getByText('AI가 기억하는 내용이 없어요')).toBeVisible()
  await page.getByRole('link', { name: '보안·기기' }).click()
  await expect(page.getByText('지금 이 기기')).toBeVisible()
})

test('keyboard: ⌘K opens search, Esc closes it, ⌘⇧O starts a new chat', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/files')
  await expect(page.getByTestId('file-table')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: '채팅 검색' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+o')
  await expect(page.getByTestId('composer-input')).toBeVisible()
})

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })
  test('drawer sidebar, full-screen panel, no horizontal scroll', async ({ page }) => {
    await reset(page)
    await signIn(page)
    await expect(page.getByTestId('new-chat')).not.toBeVisible()
    await page.getByRole('button', { name: '메뉴 열기' }).click()
    await expect(page.getByRole('dialog', { name: '사이드바' }).getByTestId('new-chat')).toBeVisible()
    await page.getByRole('dialog', { name: '사이드바' }).getByRole('link', { name: '파일' }).click()
    await page.getByTestId('file-row').filter({ hasText: 'marketing' }).getByRole('button').first().click()
    await page.getByTestId('file-row').filter({ hasText: 'plan.md' }).getByRole('button').first().click()
    const panel = page.getByTestId('file-panel')
    await expect(panel).toBeVisible()
    const box = (await panel.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(389)
    await panel.getByRole('button', { name: '닫기' }).click()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
  })
})

test('PWA: manifest and service worker', async ({ page }) => {
  await reset(page)
  await page.goto('/login')
  const manifest = await (await page.request.get('/manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ name: PRODUCT.displayName, short_name: PRODUCT.shortName, display: 'standalone', start_url: '/' })
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true)
  for (const i of manifest.icons as { src: string }[]) expect((await page.request.get(i.src)).status()).toBe(200)
  // http://127.0.0.1 counts as a secure context, so the worker registers
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), { timeout: 10_000 }).toBe(1)
})
