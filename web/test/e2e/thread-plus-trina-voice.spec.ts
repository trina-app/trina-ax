// Esc while a recording runs, with the thread and the ✦ side chat over the room (pages/Room.tsx: there Esc closes one
// panel a press; docs/decisions/20261117-thread-plus-trina.md): the first Esc throws the recording away (voice input's
// own rule, lib/voiceInput.ts) and no panel closes; the next Esc closes the panel. In the thread's box and in the side
// chat's. Chromium's fake microphone stands in for a real one (voice.spec.ts).
import { expect, test, type Locator, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block', viewport: { width: 1024, height: 768 }, launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] })

const SORA = { id: 'sora', name: '소라님' }
const ROOT = '019a5f00-0000-7000-8000-000000000601'
const MIC = '음성 입력 (Space 길게)'

async function both(page: Page) {
  await reset(page)
  await routeRoom(page, { members: [SORA], messages: [
    { id: ROOT, author: SORA, body: '이번 주 시안 검토 일정 공유드려요.', extra: { thread: { replyCount: 1, lastReplyAt: '2026-11-05T09:03:00.000Z', repliers: [SORA], newReplies: false } } },
    { id: '019a5f00-0000-7000-8000-000000000602', author: SORA, body: '금요일까지 부탁드려요.', threadRootId: ROOT },
  ] })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}/t/${ROOT}`)
  await page.getByTestId('room-side-chat-button').click()
  await expect(page.getByTestId('room-page')).toHaveAttribute('data-columns', 'pair')
}

/** a recording started with the panel's mic, then Esc twice */
async function escTwice(page: Page, panel: Locator, other: Locator) {
  await panel.getByRole('button', { name: MIC }).click()
  await expect(panel.getByRole('group', { name: '녹음 중' })).toBeVisible()
  await page.keyboard.press('Escape')
  // the recording is gone, both panels are still there
  await expect(panel.getByTestId('voice-bar')).toHaveCount(0)
  await expect(panel).toBeVisible()
  await expect(other).toBeVisible()
  await panel.locator('textarea').first().focus()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(other).toBeVisible()
}

test('the thread\'s box: Esc throws the recording away first, then closes the thread', async ({ page }) => {
  await both(page)
  await escTwice(page, page.getByTestId('room-thread'), page.getByTestId('room-side-chat'))
})

test('the side chat\'s box: Esc throws the recording away first, then closes the side chat', async ({ page }) => {
  await both(page)
  await escTwice(page, page.getByTestId('room-side-chat'), page.getByTestId('room-thread'))
})
