// Admin › Members › "Invite to team" (pages/admin/Members.tsx InviteDialog; docs/DECISIONS.md "Guests from Admin ›
// Invite to team"): Team member (the default, the link with a role and groups) or Guest. Guest says who that is in one
// line and lists the one place they may join: group chats the admin is in and team projects whose members they may
// change (pages/admin/GuestPlacePicker.tsx). A place opens the rooms' and projects' guest invite form, whose Cancel comes
// back here. A full plan says so in place of the places.
import { expect, test, type Page } from '@playwright/test'
import { uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

test.use({ viewport: { width: 1440, height: 900 } })

const GROUP = uuidv7()
const base = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const at = new Date(Date.now() - 3600_000).toISOString()
const ROOMS = [
  { ...base, id: GROUP, kind: 'group', name: '견적 준비', groupId: null, memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at },
  // a DM is no place for a guest
  { ...base, id: uuidv7(), kind: 'dm', name: null, groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at },
]

/** the owner, or (`admin`) the admin Dana */
async function start(page: Page, admin = false) {
  await reset(page, { withAdmin: admin })
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  const r = await page.request.post('/__test/project', { data: { name: '납품 일정', by: 'bob' } })
  const { id } = (await r.json()) as { id: string }
  await signIn(page, admin ? { username: 'dana', password: 'dana password 1' } : undefined)
  return id
}

async function openGuest(page: Page) {
  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  // Team member is chosen first: today's form
  await expect(page.getByRole('tab', { name: '팀원' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('invite-create')).toBeVisible()
  await page.getByRole('tab', { name: '게스트' }).click()
  await expect(page.getByTestId('invite-guest-line')).toHaveText('팀 밖의 사람이에요. 그룹 대화나 프로젝트 한 곳에만 들어와요.')
  await expect(page.getByTestId('invite-create')).toHaveCount(0)
}

test('the owner invites a guest into a group chat from Admin › Invite to team', async ({ page }) => {
  await start(page)
  await openGuest(page)
  // the group chat, never the DM
  await expect(page.getByTestId('guest-place-room')).toHaveCount(1)
  await page.getByTestId('guest-place-room').filter({ hasText: '견적 준비' }).click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'견적 준비' 방만")
  // the owner gets all three AI choices; the 7-day, one-use line
  await expect(page.getByTestId('guest-ai-team')).toBeVisible()
  await expect(page.getByTestId('guest-invite-expiry')).toBeVisible()
  // Cancel comes back to the places, Guest still chosen
  await page.getByRole('button', { name: '취소' }).click()
  await expect(page.getByRole('tab', { name: '게스트' })).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('guest-place-room').click()
  await page.getByTestId('guest-invite-name').fill('Alex')
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  expect((await created).postDataJSON()).toMatchObject({ place: { kind: 'room', id: GROUP }, ai: { mode: 'none' } })
  await expect(page.getByTestId('guest-invite-copy')).toHaveText('링크 복사')
  await page.getByTestId('guest-invite-done').click()
  // the invite list has the new link at once
  await expect(page.getByTestId('invite-list')).toContainText('Alex')
})

test('an admin invites a guest into a project someone else made', async ({ page }) => {
  const id = await start(page, true)
  await openGuest(page)
  await page.getByTestId('guest-place-project').filter({ hasText: '납품 일정' }).click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'납품 일정' 프로젝트만")
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  expect((await created).postDataJSON()).toMatchObject({ place: { kind: 'project', id } })
  await expect(page.getByTestId('guest-invite-ready')).toBeVisible()
})

test('a full plan: the limit instead of the places, with See plans', async ({ page }) => {
  await start(page)
  expect((await page.request.post('/__test/guest-limit', { data: { guests: 0 } })).ok()).toBeTruthy()
  await openGuest(page)
  await expect(page.getByTestId('guest-invite-full')).toContainText('게스트는 0명까지예요')
  await expect(page.getByTestId('guest-place-picker')).toHaveCount(0)
  await expect(page.getByTestId('guest-invite-plans')).toHaveAttribute('href', 'https://plans.example.com/acme')
  // Team member still works as before
  await page.getByRole('tab', { name: '팀원' }).click()
  await expect(page.getByTestId('invite-create')).toBeVisible()
})

test('the plan fills up meanwhile: a refused Create link shows the limit, not the places again', async ({ page }) => {
  await start(page)
  await page.route('**/api/guest-invites', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'plan_limit', message: 'x', params: { reason: 'guest_limit', limit: 3 } } }) })
    : route.fallback())
  await openGuest(page)
  await page.getByTestId('guest-place-room').click()
  await page.getByTestId('guest-invite-create').click()
  await expect(page.getByTestId('guest-invite-full')).toContainText('게스트는 3명까지예요')
  await expect(page.getByTestId('guest-place-picker')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: '게스트' })).toHaveAttribute('aria-selected', 'true')
})
