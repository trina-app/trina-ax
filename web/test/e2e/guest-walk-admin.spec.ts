// Guests in Admin after the guest walkthrough (docs/DECISIONS.md "Guests in Admin: a Home card, left or removed"):
// Admin Home has a Guests card ("1 of 3 guests", their names) that opens Members filtered to guests (S2); a guest who
// left on their own reads "Left", one taken out "Removed", and the toggle names which it shows (S3); a guest whose project
// is in the trash stays with the active ones with Restore project (S4); the Guests title's count is "1 of 3", not
// "Guests 1 of 3" again (N2); Admin's invite dialog is titled by the picked tab (N1).
// SHOTS=<dir> also saves each screen at 1440 and 390, light and dark, in Korean and English.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const ROOM = uuidv7()
const base = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const at = new Date(Date.now() - 3600_000).toISOString()
const ROOMS = [{ ...base, id: ROOM, kind: 'group', name: 'Quote prep', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at }]
const SHOTS = process.env.SHOTS

async function shoot(page: Page, name: string, open: () => Promise<void>) {
  if (!SHOTS) return
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width: w, height: h })
      await page.emulateMedia({ colorScheme: scheme })
      await open()
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${SHOTS}/${name}-${w}-${scheme}.png` })
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await open()
}

/** gina (active, in the room), lena (left the room on her own), gwen (taken out), tara (her project in the trash) */
async function start(page: Page, locale: 'ko' | 'en') {
  await reset(page, { teamLocale: locale, usersFollowTeam: true })
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  const proj = (await (await page.request.post('/__test/project', { data: { name: 'Launch plan', by: 'olga' } })).json()) as { id: string }
  const guest = (data: Record<string, unknown>) => page.request.post('/__test/guest', { data: { place: { kind: 'room', id: ROOM }, ...data } })
  expect((await guest({ id: 'gina', name: 'Gina' })).ok()).toBeTruthy()
  expect((await guest({ id: 'lena', name: 'Lena', status: 'disabled', out: 'left', leftThemselves: true })).ok()).toBeTruthy()
  expect((await guest({ id: 'gwen', name: 'Gwen', status: 'disabled', out: 'left' })).ok()).toBeTruthy()
  // Tara's project in the trash: she was switched off with it, and comes back with it
  expect((await guest({ id: 'tara', name: 'Tara', status: 'disabled', out: 'trashed', place: { kind: 'project', id: proj.id } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/guest-limit', { data: { guests: 3 } })).ok()).toBeTruthy()
  await signIn(page)
  expect((await page.request.delete(`/api/projects/${proj.id}`, { headers: { [CSRF_HEADER]: '1' } })).ok()).toBeTruthy()
}

const WORDS = {
  ko: { card: '게스트 1/3명', count: '1/3명', left: "'Quote prep'에서 직접 나갔어요", removed: "'Quote prep'에 이제 없어요 · 내보냄", toggle: '나간·내보낸 게스트 보기 (2)', titleMember: '팀원 초대', titleGuest: '게스트 초대', button: '사람 초대' },
  en: { card: '1 of 3 guests', count: '1 of 3', left: "Left 'Quote prep' on their own", removed: "No longer in 'Quote prep' · Removed", toggle: 'Show guests who left or were removed (2)', titleMember: 'Invite a team member', titleGuest: 'Invite a guest', button: 'Invite people' },
} as const

for (const locale of ['ko', 'en'] as const) {
  const w = WORDS[locale]
  test.describe(`guests in Admin (${locale})`, () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('Home has a Guests card that opens Members filtered to guests', async ({ page }) => {
      await start(page, locale)
      await page.goto('/admin')
      const card = page.getByTestId('admin-home-guests')
      await expect(card).toContainText(w.card)
      await expect(card).toContainText('Gina')
      // the Members card counts team members only (guests take no seat)
      await expect(page.getByTestId('admin-home-members')).not.toContainText('Gina')
      await shoot(page, `admin-home-guests-${locale}`, async () => { await page.goto('/admin'); await expect(page.getByTestId('admin-home').or(page.getByTestId('admin-phone-root'))).toBeVisible() })
      await page.goto('/admin')
      await card.click()
      await expect(page).toHaveURL(/\/admin\/members\?role=guest$/)
      await expect(page.getByTestId('members-table')).toBeHidden()
      await expect(page.getByTestId('guest-row-gina')).toBeVisible()
    })

    test('left on their own reads Left, taken out reads Removed; a trashed project\'s guest stays listed with Restore project', async ({ page }) => {
      await start(page, locale)
      await page.goto('/admin/members?role=guest')
      // the title's count does not repeat "Guests"
      await expect(page.getByTestId('guests-count')).toHaveText(w.count)
      // Tara (project in the trash) is with the active ones, with Restore project; Lena and Gwen wait behind the toggle
      await expect(page.getByTestId('guest-row-tara')).toBeVisible()
      await expect(page.getByTestId('guest-restore-tara')).toBeVisible()
      await expect(page.getByTestId('guest-row-lena')).toHaveCount(0)
      await expect(page.getByTestId('guests-show-removed')).toHaveText(w.toggle)
      await page.getByTestId('guests-show-removed').click()
      await expect(page.getByTestId('guest-meta-lena')).toHaveText(w.left)
      await expect(page.getByTestId('guest-meta-gwen')).toHaveText(w.removed)
      await shoot(page, `admin-guests-left-removed-${locale}`, async () => {
        await page.goto('/admin/members?role=guest')
        await page.getByTestId('guests-show-removed').click()
        await expect(page.getByTestId('guest-row-lena')).toBeVisible()
      })
    })

    test("the invite dialog's title follows the picked tab", async ({ page }) => {
      await start(page, locale)
      await page.goto('/admin/members')
      await expect(page.getByTestId('invite-new')).toHaveText(w.button)
      await page.getByTestId('invite-new').click()
      await expect(page.getByRole('dialog', { name: w.titleMember })).toBeVisible()
      await page.getByTestId('invite-kind').getByRole('tab').nth(1).click()
      await expect(page.getByRole('dialog', { name: w.titleGuest })).toBeVisible()
      await shoot(page, `admin-invite-guest-tab-${locale}`, async () => {
        await page.goto('/admin/members')
        await page.getByTestId('invite-new').click()
        await page.getByTestId('invite-kind').getByRole('tab').nth(1).click()
        await expect(page.getByRole('dialog', { name: w.titleGuest })).toBeVisible()
      })
    })
  })
}

test.describe('only guests who left', () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test('the toggle says "guests who left" when nobody was removed', async ({ page }) => {
    await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
    expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
    expect((await page.request.post('/__test/guest', { data: { id: 'lena', name: 'Lena', status: 'disabled', out: 'left', leftThemselves: true, place: { kind: 'room', id: ROOM } } })).ok()).toBeTruthy()
    await signIn(page)
    await page.goto('/admin/members?role=guest')
    await expect(page.getByTestId('guests-show-removed')).toHaveText('나간 게스트 보기 (1)')
    await page.getByTestId('guests-show-removed').click()
    await expect(page.getByTestId('guests-show-removed')).toHaveText('나간 게스트 숨기기')
  })
})
