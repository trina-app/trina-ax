import { expect, test } from '@playwright/test'
import { reset, signIn } from './helpers'

// Chromium's fake microphone (a beep) stands in for a real one.
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] })

test('voice input goes through a transcription job into the composer', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByRole('button', { name: '음성으로 입력' }).click()
  await expect(page.getByRole('status', { name: '녹음 중' })).toBeVisible()
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  const log = (await (await page.request.post('/__test/log')).json()) as string[]
  expect(log).toContain('POST /api/transcribe')
})

const speech = async (page: import('@playwright/test').Page, provider: 'local' | 'openrouter', key = false) =>
  expect((await page.request.post('/__test/speech', { data: { provider, key } })).ok()).toBeTruthy()
const transcribeChats = async (page: import('@playwright/test').Page) => (await (await page.request.post('/__test/transcribe-chats')).json()) as (string | null)[]
const record = async (page: import('@playwright/test').Page) => {
  await page.getByRole('button', { name: '음성으로 입력' }).click()
  await expect(page.getByRole('status', { name: '녹음 중' })).toBeVisible()
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: '녹음 끝내기' }).click()
}
const NOTE = '기밀 대화에서는 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않아서 음성 입력을 쓸 수 없어요.'

test('voice input in a chat names that chat; on the new-chat page it names none', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await record(page)
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  const chatId = page.url().split('/c/')[1]!
  await expect(page.getByRole('button', { name: '음성으로 입력' })).toBeEnabled()
  await record(page)
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect(await transcribeChats(page)).toEqual([null, chatId])
})

test('a confidential chat with voice input through OpenRouter: the composer says why instead of recording', async ({ page }) => {
  await reset(page)
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByTestId('composer-input').fill('confidential plan')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  // the page knows the chat is confidential (chat.updated, sent before the answer) before the mic is pressed; a click
  // before that records, and the server refuses it (the next test)
  await expect(page.getByTestId('assistant-message').last()).toHaveAttribute('data-status', 'done')
  await page.getByRole('button', { name: '음성으로 입력' }).click()
  await expect(page.getByRole('alert')).toContainText(NOTE)
  await expect(page.getByRole('status', { name: '녹음 중' })).toHaveCount(0)
  expect(await transcribeChats(page)).toEqual([])
})

test('the server is the gate: a recording it refuses shows its note in the composer', async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.getByTestId('composer-input').fill('confidential plan')
  await page.getByTestId('send').click()
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/)
  // the team moves voice input to OpenRouter after this page loaded (it still thinks it is on this server)
  await speech(page, 'openrouter', true)
  await record(page)
  await expect(page.getByRole('alert')).toContainText('기밀 대화라서 녹음을 바깥 음성 서비스(OpenRouter)로 보내지 않았어요.')
  await expect(page.getByTestId('composer-input')).toHaveValue('')
})

test('every chat confidential (Safe operations 1A): a new chat says why too; on this server the mic records', async ({ page }) => {
  await reset(page)
  expect((await page.request.post('/__test/confidential', { data: { all: true } })).ok()).toBeTruthy()
  await speech(page, 'openrouter', true)
  await signIn(page)
  await page.getByRole('button', { name: '음성으로 입력' }).click()
  await expect(page.getByRole('alert')).toContainText(NOTE)
  await speech(page, 'local')
  await page.reload()
  await record(page)
  await expect(page.getByTestId('composer-input')).toHaveValue('받아쓴 문장입니다')
  expect(await transcribeChats(page)).toEqual([null])
})
