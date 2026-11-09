// A room AI answer that stayed with its asker (docs/DECISIONS.md "방에 올리기…"): one plain line says why, and
// "방에 올리기…" asks first, in the app's confirm, with each folder some members cannot see and how many cannot (never
// who), and a line when it went through an earlier answer hidden from someone. 취소 leaves it private and nothing is
// sent; 방에 올리기 posts it (it becomes the room's, asked by me). A post the server refuses because the reasons changed
// meanwhile says why (a toast) and the notice follows the updated preview. A preview that cannot be posted has the
// reason alone, no button. The room is answered through page.route (rooms-mock.ts); the update comes over the mock's
// socket. SHOTS_DIR=<folder>: screenshots (1440 and 390, light and dark) go there.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const OLGA = { id: 'olga', name: 'Olga' }
const MINJUN = { id: 'minjun', name: '민준' }
const SEOYEON = { id: 'seoyeon', name: '서연' }
const JIHO = { id: 'jiho', name: '지호' }
const id = (n: number) => `019a5f00-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`
const QUESTION = '@트리나 지난주 단가 협의한 내용 정리해 줘'
const ANSWER = '**단가 협의 정리**\n\n- 기본 단가는 지난 분기와 같아요.\n- 100개 넘는 주문은 8% 낮춰 주기로 했어요.\n- 다음 협의는 금요일이에요.'
const ASKABLE = { folders: ['groups/영업/단가표'], unable: { 'groups/영업/단가표': 2 }, personal: false, outside: false, joinedLater: [], earlier: true }
const REFUSED = { folders: [], personal: false, outside: false, joinedLater: [], hidden: true }

const answer = (preview: Record<string, unknown> | null) => ({
  id: id(3), author: OLGA, body: ANSWER,
  extra: { authorKind: 'ai', author: null, askedBy: OLGA, sourceCount: 0, replyTo: { id: id(2), author: OLGA, excerpt: QUESTION, fileCount: 0, deleted: false }, ...(preview ? { visibility: 'private', preview } : {}) },
})

async function openRoom(page: Page, preview: Record<string, unknown>) {
  await reset(page)
  await routeRoom(page, {
    kind: 'team',
    members: [MINJUN, SEOYEON, JIHO],
    messages: [
      { id: id(1), author: SEOYEON, body: '이번 주 안에 견적서 보내야 해요' },
      { id: id(2), author: OLGA, body: QUESTION },
      answer(preview),
    ],
  })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-message')).toHaveCount(3)
}

/** POST …/messages/:id/share: what the spec answers, and how many times it was asked */
async function routeShare(page: Page, answerWith: (route: Route, n: number) => Promise<void>) {
  const calls: number[] = []
  await page.route(new RegExp(`/api/rooms/${ROOM_ID}/messages/${id(3)}/share$`), async (route) => {
    calls.push(Date.now())
    await answerWith(route, calls.length)
  })
  return calls
}
const posted = () => {
  const m = answer(null)
  return { id: m.id, roomId: ROOM_ID, seq: 9, authorKind: 'ai', author: null, askedBy: OLGA, visibility: 'room', body: ANSWER, replyTo: m.extra.replyTo, mentions: [], files: [], createdAt: '2026-11-05T09:09:00.000Z', editedAt: null, deletedAt: null, sourceCount: 0 }
}

test('the private answer says why in one line; 방에 올리기… asks first with the folders and counts; 취소 leaves it private', async ({ page }) => {
  await openRoom(page, ASKABLE)
  const calls = await routeShare(page, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(posted()) }))
  const mine = page.locator('[data-visibility="private"]')
  await expect(mine.getByTestId('room-ai-private')).toContainText('나만 볼 수 있어요')
  await expect(mine.getByTestId('room-ai-preview')).toHaveText('방 사람 중 일부가 볼 수 없는 자료를 참고한 답이라 지금은 나만 보고 있어요.')
  await expect(mine.getByTestId('room-ai-share')).toHaveText('방에 올리기…')
  // nothing is named in the room's line: the folder is in the confirm only
  await expect(mine).not.toContainText('단가표')

  await mine.getByTestId('room-ai-share').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('이 답을 방에 올릴까요?')
  await expect(dialog.getByTestId('room-ai-post-reasons')).toHaveText('단가표 · 방 사람 중 2명은 못 봐요')
  await expect(dialog.getByTestId('room-ai-post-earlier')).toBeVisible()
  await expect(dialog).not.toContainText('민준')
  await dialog.getByRole('button', { name: '취소' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-visibility="private"]')).toHaveCount(1)
  expect(calls).toHaveLength(0)

  // asked again, and yes: it goes, and it is the room's now (asked by me)
  await mine.getByTestId('room-ai-share').click()
  await page.getByRole('dialog').getByTestId('dialog-confirm').click()
  await expect(page.locator('[data-visibility="private"]')).toHaveCount(0)
  const now = page.locator('[data-ai][data-visibility="room"]')
  await expect(now.getByTestId('room-ai-asked-by')).toContainText('Olga')
  await expect(page.getByTestId('room-ai-share')).toHaveCount(0)
  expect(calls).toHaveLength(1)
})

test('reasons that changed meanwhile: the server says why, the notice follows, and asked again it goes', async ({ page }) => {
  await openRoom(page, ASKABLE)
  const calls = await routeShare(page, async (route, n) => {
    if (n === 1) {
      // what the server does: the preview again (now three cannot see the folder), then 409 with why
      const update = { type: 'room.message.updated', data: { roomId: ROOM_ID, message: { ...posted(), seq: 3, visibility: 'private', preview: { ...ASKABLE, unable: { 'groups/영업/단가표': 3 } } } } }
      expect((await page.request.post('/__test/publish', { data: { event: update } })).ok()).toBeTruthy()
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'conflict', message: '그 사이에 대화방 멤버나 권한이 바뀌었어요. 바뀐 이유를 확인하고 다시 올려 주세요.', params: { reason: 'room_ai_reasons_changed' } } }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(posted()) })
  })
  const mine = page.locator('[data-visibility="private"]')
  await mine.getByTestId('room-ai-share').click()
  await page.getByRole('dialog').getByTestId('dialog-confirm').click()
  await expect(page.getByText('그 사이에 대화방 멤버나 권한이 바뀌었어요. 바뀐 이유를 확인하고 다시 올려 주세요.')).toBeVisible()
  await expect(page.locator('[data-visibility="private"]')).toHaveCount(1)
  await expect(mine.getByTestId('room-ai-share')).toBeEnabled()
  await mine.getByTestId('room-ai-share').click()
  await expect(page.getByRole('dialog').getByTestId('room-ai-post-reasons')).toHaveText('단가표 · 다른 사람은 못 봐요')
  await page.getByRole('dialog').getByTestId('dialog-confirm').click()
  await expect(page.locator('[data-visibility="private"]')).toHaveCount(0)
  expect(calls).toHaveLength(2)
})

test('a private answer that cannot be posted has the reason alone and no button', async ({ page }) => {
  await openRoom(page, REFUSED)
  const mine = page.locator('[data-visibility="private"]')
  await expect(mine.getByTestId('room-ai-preview')).toHaveText('가려진 예전 답을 참고해서 방에 올릴 수 없어요.')
  await expect(mine.getByTestId('room-ai-share')).toHaveCount(0)
})

const shots = (page: Page) => {
  const dir = process.env.SHOTS_DIR!
  fs.mkdirSync(dir, { recursive: true })
  return (name: string) => page.screenshot({ path: path.join(dir, `${name}.png`) })
}
/** the notice, the confirm and the posted answer, in each look */
async function shotsOf(page: Page, size: string) {
  const shot = shots(page)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await openRoom(page, ASKABLE)
    await routeShare(page, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(posted()) }))
    await shot(`after-${size}-${scheme}-1-notice`)
    await page.locator('[data-visibility="private"]').getByTestId('room-ai-share').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await shot(`after-${size}-${scheme}-2-confirm`)
    await page.getByRole('dialog').getByTestId('dialog-confirm').click()
    await expect(page.locator('[data-visibility="private"]')).toHaveCount(0)
    await shot(`after-${size}-${scheme}-3-posted`)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await openRoom(page, REFUSED)
    await shot(`after-${size}-${scheme}-4-refused`)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
}

test('screenshots at 1440 (light and dark)', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  await page.setViewportSize({ width: 1440, height: 900 })
  await shotsOf(page, '1440')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('screenshots at 390 (light and dark)', async ({ page }) => {
    test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
    await shotsOf(page, '390')
  })
})
