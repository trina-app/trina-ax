// "이 방에서는 항상 허용" (docs/DECISIONS.md "대화방에서 새 파일은 미리 허용"), what is left of it outside the side chat's own
// card: Settings › 트리나에게 허용한 것 (rows, delete, the empty line) and the admin switch. The room's own card went with
// the room AI (docs/DECISIONS.md "Room @트리나 code removed"); the side chat's card is an AI chat's card.
import { expect, test } from '@playwright/test'
import type { AiAllowance, RoomFilesAllowance } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { ROOM_ID } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const SORA = { id: 'sora', name: '소라님' }
const JIN = { id: 'jin', name: '박진' }
const FOLDER = '영업/견적서'
const ROOM_VIEW = { id: ROOM_ID, kind: 'group' as const, name: '디자인 리뷰', peers: [SORA, JIN], memberCount: 3 }
const DM_VIEW = { id: '019a5f00-0000-7000-8000-000000000a09', kind: 'dm' as const, name: null, peers: [SORA], memberCount: 2 }
const grantRow = (n: number, room: RoomFilesAllowance['room']): AiAllowance => ({ kind: 'room_files', id: `019a5f00-0000-7000-8000-0000000005${String(n).padStart(2, '0')}`, room, folder: n === 1 ? FOLDER : '마케팅/캠페인/2026', createdAt: '2026-11-08T03:00:00.000Z', expiresAt: '2026-12-08T03:00:00.000Z' })

test('Settings › 트리나에게 허용한 것: one row per grant, the room as I see it (a 1:1 by the other person); empty, one line', async ({ page }) => {
  await reset(page)
  await page.request.post('/__test/ai-allowances', { data: { items: [grantRow(1, ROOM_VIEW), grantRow(2, DM_VIEW)] } })
  await signIn(page)
  await page.goto('/settings/allowances')
  const rows = page.getByTestId('allowance-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('디자인 리뷰')
  await expect(rows.nth(1)).toContainText('소라님')
  await expect(rows.nth(1)).toContainText('마케팅/캠페인/2026')
  await rows.nth(1).getByRole('button', { name: '지우기' }).click()
  await expect(rows).toHaveCount(1)
  await rows.nth(0).getByRole('button', { name: '지우기' }).click()
  await expect(page.getByTestId('allowances-empty')).toHaveText('아직 허용한 것이 없어요.')
})

test('Settings › 트리나에게 허용한 것: "Always allow" on a kind of card, in plain words, deleted like a room row (docs/DECISIONS.md "Always allow on every card")', async ({ page }) => {
  await reset(page)
  await page.request.post('/__test/ai-allowances', { data: { items: [
    { kind: 'card', id: 'card:delete_files', card: 'delete_files', createdAt: '2026-11-13T03:00:00.000Z' },
    grantRow(1, ROOM_VIEW),
  ] } })
  await signIn(page)
  await page.goto('/settings/allowances')
  const rows = page.getByTestId('allowance-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('파일을 휴지통으로 옮기기')
  await expect(rows.nth(0)).toContainText('항상 허용')
  await rows.nth(0).getByRole('button', { name: '지우기' }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText('디자인 리뷰')
})

test("Admin › Team settings: the switch for \"항상 허용\" on confirmation cards, on by default, saved with the form", async ({ page }) => {
  await reset(page)
  await signIn(page)
  await page.goto('/admin/settings')
  const row = page.getByTestId('team-room-always')
  await expect(row).toHaveAttribute('data-on', 'true')
  await expect(row).toContainText('"항상 허용" 쓰기')
  await expect(row.locator('#ts-room-always-desc')).toHaveText('켜 두면 사람들이 확인 카드에서 "항상 허용"을 골라 같은 종류의 확인을 다시 받지 않을 수 있어요. 끄면 매번 물어봐요.')
  const saved = page.waitForRequest((r) => r.url().endsWith('/api/admin/settings') && r.method() === 'PATCH')
  await row.getByText('"항상 허용" 쓰기').click()
  await expect(row).toHaveAttribute('data-on', 'false')
  await page.getByRole('button', { name: '저장', exact: true }).click()
  expect((await saved).postDataJSON()).toEqual({ roomAlwaysAllow: false })
  await page.reload()
  await expect(page.getByTestId('team-room-always')).toHaveAttribute('data-on', 'false')
})
