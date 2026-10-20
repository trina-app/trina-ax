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
