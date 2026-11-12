// "Alice is typing…" in the browser (docs/DECISIONS.md "입력 중 표시"; components/rooms/RoomTypingLine.tsx): a second
// member's `room.typing` frames (the mock's POST /__test/typing stands for the server, whose rules
// tests/unit/b-room-typing.test.ts checks) show one quiet line over the room's box or the thread's box, for that place
// only; it runs out by itself; the box does not move when it comes or goes; what this page sends while I type (GET
// /__test/typing): "typing" for the room or the thread, "stopped" on send. With SHOTS_DIR set, the last tests save the
// screens for review (1440 and 390, light and dark).
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '김소라' }
const MINSU = { id: 'minsu', name: '이민수' }
const BOB = { id: 'bob', name: 'Bob' }
const ROOT = { id: '019a5f00-0000-7000-8000-000000000001', author: SORA, body: '다음 주 일정 정리해 봤어요' }
const OLDER = { id: '019a5f00-0000-7000-8000-000000000002', author: MINSU, body: '확인했습니다. 금요일 회의는 오후로 옮길까요?' }

async function openRoom(page: Page) {
  await reset(page)
  const room = await routeRoom(page, { members: [SORA, MINSU, BOB], messages: [ROOT, OLDER] })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-input')).toBeVisible()
  return room
}
async function tell(page: Page, userId: string, typing = true, threadRootId: string | null = null) {
  const r = await page.request.post('/__test/typing', { data: { roomId: ROOM_ID, threadRootId, userId, typing } })
  expect(r.ok()).toBeTruthy()
}
const sentFrames = async (page: Page) => ((await (await page.request.get('/__test/typing')).json()) as { sent: { roomId: string; threadRootId: string | null; typing: boolean }[] }).sent
const line = (page: Page, where = page.getByTestId('room')) => where.getByTestId('room-typing-line').first()

test('a second member typing: one line over the box, two names, several; it runs out; the box does not move', async ({ page }) => {
  await openRoom(page)
  const box = page.getByTestId('room-composer').first()
  const before = await box.boundingBox()
  await expect(line(page)).toHaveAttribute('aria-live', 'polite')
  await expect(line(page)).toHaveText('')
  await tell(page, SORA.id)
  await expect(line(page)).toHaveText('김소라님이 입력 중…')
  await tell(page, MINSU.id)
  await expect(line(page)).toHaveText('김소라님과 이민수님이 입력 중…')
  await tell(page, BOB.id)
  await expect(line(page)).toHaveText('여러 명이 입력 중…')
  // the box stayed where it was
  expect(await box.boundingBox()).toEqual(before)
  await tell(page, BOB.id, false)
  await tell(page, MINSU.id, false)
  await expect(line(page)).toHaveText('김소라님이 입력 중…')
  // no "stopped" from her: gone about 5 s after her last ping
  await expect(line(page)).toHaveText('', { timeout: 8000 })
  expect(await box.boundingBox()).toEqual(before)
})

test('typing in the room says so; sending says "stopped"; a thread\'s typing shows in its box only', async ({ page }) => {
  const room = await openRoom(page)
  await page.getByTestId('room-input').click()
  await page.keyboard.type('금요일 오후 좋아요')
  await expect.poll(async () => (await sentFrames(page)).map((f) => [f.threadRootId, f.typing])).toEqual([[null, true]])
  await page.keyboard.press('Enter')
  await expect.poll(() => room.sent.length).toBe(1)
  await expect.poll(async () => (await sentFrames(page)).map((f) => f.typing)).toEqual([true, false])

  await page.goto(`/rooms/${ROOM_ID}/t/${ROOT.id}`)
  const thread = page.getByTestId('room-thread')
  await expect(thread.getByTestId('room-input')).toBeVisible()
  await tell(page, MINSU.id, true, ROOT.id)
  await expect(line(page, thread)).toHaveText('이민수님이 입력 중…')
  // not in the room's own box
  await expect(page.getByTestId('room').getByTestId('room-typing-line').first()).toHaveText('')
  await thread.getByTestId('room-input').click()
  await page.keyboard.type('네')
  await expect.poll(async () => (await sentFrames(page)).at(-1)).toEqual(expect.objectContaining({ threadRootId: ROOT.id, typing: true }))
})

// ---------------- screenshots for review (SHOTS_DIR) ----------------
const shots = (page: Page) => {
  const dir = process.env.SHOTS_DIR!
  fs.mkdirSync(dir, { recursive: true })
  return (name: string) => page.screenshot({ path: path.join(dir, `${name}.png`) })
}

test('screenshots at 1440: the room and a thread with the line (light and dark)', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  test.setTimeout(120_000)
  const shot = shots(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openRoom(page)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await page.goto(`/rooms/${ROOM_ID}`)
    await expect(page.getByTestId('room-input')).toBeVisible()
    await tell(page, SORA.id)
    await tell(page, MINSU.id)
    await expect(line(page)).toHaveText('김소라님과 이민수님이 입력 중…')
    await shot(`typing-room-1440-${scheme}`)
    await page.goto(`/rooms/${ROOM_ID}/t/${ROOT.id}`)
    const thread = page.getByTestId('room-thread')
    await expect(thread.getByTestId('room-input')).toBeVisible()
    await tell(page, BOB.id, true, ROOT.id)
    await expect(line(page, thread)).toHaveText('Bob님이 입력 중…')
    await shot(`typing-thread-1440-${scheme}`)
  }
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('at 390: the line fits over the box and the box does not move (light and dark)', async ({ page }) => {
    test.setTimeout(120_000)
    await openRoom(page)
    const box = page.getByTestId('room-composer').first()
    const before = await box.boundingBox()
    await tell(page, SORA.id)
    await expect(line(page)).toHaveText('김소라님이 입력 중…')
    expect(await box.boundingBox()).toEqual(before)
    // inside the screen, one line
    const r = (await line(page).boundingBox())!
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.x + r.width).toBeLessThanOrEqual(390)
    expect(r.height).toBeLessThan(24)
    // it covers no message: the last one ends above it
    const last = (await page.getByTestId('room-message').last().boundingBox())!
    expect(last.y + last.height).toBeLessThanOrEqual(r.y + 1)
    // readable words (contrast) in both themes
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      const axe = await new AxeBuilder({ page }).include('[data-testid="room-typing-line"]').withRules(['color-contrast']).analyze()
      expect(axe.violations).toEqual([])
    }
    if (!process.env.SHOTS_DIR) return
    const shot = shots(page)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await tell(page, SORA.id)
      await tell(page, MINSU.id)
      await expect(line(page)).toHaveText('김소라님과 이민수님이 입력 중…')
      await shot(`typing-room-390-${scheme}`)
    }
  })
})
