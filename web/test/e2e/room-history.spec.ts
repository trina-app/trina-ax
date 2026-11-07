// A team room seen by a member who joined it later (docs/DECISIONS.md "지난 대화"): the earlier messages are there, and
// an old answer they could not open is one faint line in its place ("볼 수 없는 자료를 참고한 답이라 가려졌어요"), with
// who asked it, and nothing to do on it (no hover row, menu, reaction or thread). The room is answered through page.route
// (rooms-mock.ts). SHOTS_DIR=<folder>: the screenshots (1440 and 390, light and dark) go there.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const MINJUN = { id: 'minjun', name: '민준' }
const SEOYEON = { id: 'seoyeon', name: '서연' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`

async function openRoom(page: Page) {
  await reset(page)
  await routeRoom(page, {
    kind: 'team',
    members: [MINJUN, SEOYEON],
    messages: [
      { id: id(1), author: MINJUN, body: '다음 주 캠페인 예산 정리해 둘게요' },
      { id: id(2), author: SEOYEON, body: '@트리나 3분기 광고비 얼마 썼는지 알려줘' },
      { id: id(3), author: SEOYEON, body: '', extra: { authorKind: 'ai', author: null, askedBy: SEOYEON, withheld: true, replyTo: { id: id(2), author: SEOYEON, excerpt: '@트리나 3분기 광고비 얼마 썼는지 알려줘', fileCount: 0, deleted: false } } },
      { id: id(4), author: MINJUN, body: '고마워요, 확인했어요' },
    ],
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(4)
}

test('an old answer hidden from me is one faint line with who asked it, and nothing to do on it', async ({ page }) => {
  await openRoom(page)
  const line = page.locator('[data-withheld]')
  await expect(line).toHaveCount(1)
  await expect(line.getByTestId('room-withheld')).toHaveText('볼 수 없는 자료를 참고한 답이라 가려졌어요')
  await expect(line.getByTestId('room-ai-asked-by')).toContainText('서연')
  await line.hover()
  await expect(line.getByTestId('message-hover-bar')).toHaveCount(0)
  await expect(line.getByTestId('message-menu')).toHaveCount(0)
  await expect(line.getByTestId('room-thread-line')).toHaveCount(0)
})

const shots = (page: Page) => {
  const dir = process.env.SHOTS_DIR!
  fs.mkdirSync(dir, { recursive: true })
  return (name: string) => page.screenshot({ path: path.join(dir, `${name}.png`) })
}

test('screenshots at 1440 (light and dark)', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  const shot = shots(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openRoom(page)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await shot(`room-history-1440-${scheme}`)
  }
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('screenshots at 390 (light and dark)', async ({ page }) => {
    test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
    const shot = shots(page)
    await openRoom(page)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await shot(`room-history-390-${scheme}`)
    }
  })
})
