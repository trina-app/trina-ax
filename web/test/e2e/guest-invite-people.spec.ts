// Guest invites wherever people are invited (docs/DECISIONS.md "Guests from Invite people"), one shared Guest half
// (components/GuestInviteChoice.tsx):
// - "Invite people" (the team menu, ⌘K, the phone's 나 tab; owners and admins): Team member (picked first, the team link's
//   message as before) or Guest: one line, the one place they join, then the rooms' and projects' guest form;
// - "New conversation" (the chats panel's +, /rooms?new=1): its first row is "Invite a guest", which picks the place first;
// - a room's header "⋯": 초대하기, the add list whose first row is "Invite a guest";
// - the team link's invite step elsewhere (the owner's welcome steps, where Invite people sends an owner while they are
//   unfinished): one quiet line "Invite a guest", the same place-first flow.
// The places are the ones the server accepts from the caller: group chats they are in; projects they may change the
// members of (a member: the ones they made).
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
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
const BOB = { username: 'bob', password: 'bob password 1' }
const DANA = { username: 'dana', password: 'dana password 1' }

async function start(page: Page, o: { admin?: boolean; rooms?: unknown[] } = {}) {
  await reset(page, { withAdmin: !!o.admin })
  expect((await page.request.post('/__test/rooms', { data: { rooms: o.rooms ?? ROOMS } })).ok()).toBeTruthy()
}

/** the team menu › Invite people, Team member first, then Guest */
async function openInvitePeopleGuest(page: Page) {
  await page.getByTestId('team-menu').click()
  await page.getByTestId('team-menu-invite').click()
  await expect(page.getByRole('tab', { name: '팀원' })).toHaveAttribute('aria-selected', 'true')
  // Team member: the team link's message, as before
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await page.getByRole('tab', { name: '게스트' }).click()
  await expect(page.getByTestId('invite-guest-line')).toHaveText('팀 밖의 사람이에요. 비공개 채널, 그룹 대화나 프로젝트에 들어와요.')
  await expect(page.getByTestId('invite-step')).toHaveCount(0)
}

test('the places: private channels (named, a lock) and group chats (no name) under their own headings, each worded as itself', async ({ page }) => {
  const dmGroup = uuidv7()
  await start(page, { rooms: [...ROOMS, { ...base, id: dmGroup, kind: 'group', name: null, groupId: null, memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }, { id: 'dana', name: 'Dana' }], createdAt: at, activityAt: at }] })
  await signIn(page)
  await openInvitePeopleGuest(page)
  await expect(page.getByTestId('guest-place-channels').getByTestId('guest-place-room')).toHaveText(/견적 준비/)
  await expect(page.getByTestId('guest-place-channels').locator('svg.lucide-lock')).toHaveCount(1)
  await expect(page.getByTestId('guest-place-picker')).toContainText('비공개 채널')
  await expect(page.getByTestId('guest-place-rooms').getByTestId('guest-place-room')).toHaveCount(1)
  // an unnamed group: a group chat, by its people's names
  await page.getByTestId('guest-place-rooms').getByTestId('guest-place-room').click()
  await expect(page.getByTestId('guest-invite-where')).toContainText('그룹 대화만')
  expect(await page.getByTestId('guest-invite-where').textContent()).not.toContain('비공개 채널')
})

test('the owner: Invite people › Guest › a group chat › the guest form, Cancel back, Create link', async ({ page }) => {
  await start(page)
  await signIn(page)
  await openInvitePeopleGuest(page)
  await expect(page.getByTestId('guest-place-room')).toHaveCount(1)
  await page.getByTestId('guest-place-room').filter({ hasText: '견적 준비' }).click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'견적 준비' 비공개 채널만")
  await page.getByRole('button', { name: '취소' }).click()
  await expect(page.getByRole('tab', { name: '게스트' })).toHaveAttribute('aria-selected', 'true')
  await page.getByTestId('guest-place-room').click()
  await page.getByTestId('guest-invite-name').fill('Alex')
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  expect((await created).postDataJSON()).toMatchObject({ place: { kind: 'room', id: GROUP }, ai: { mode: 'none' } })
  await page.getByTestId('guest-invite-done').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('an admin: Invite people › Guest lists a project someone else made; a full plan shows the limit', async ({ page }) => {
  await start(page, { admin: true })
  const r = await page.request.post('/__test/project', { data: { name: '납품 일정', by: 'bob' } })
  const { id } = (await r.json()) as { id: string }
  await signIn(page, DANA)
  await openInvitePeopleGuest(page)
  await page.getByTestId('guest-place-project').filter({ hasText: '납품 일정' }).click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'납품 일정' 프로젝트만")
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  expect((await created).postDataJSON()).toMatchObject({ place: { kind: 'project', id } })
  await page.getByTestId('guest-invite-done').click()

  // the plan has no room for more guests: the limit and See plans in place of the places
  expect((await page.request.post('/__test/guest-limit', { data: { guests: 0 } })).ok()).toBeTruthy()
  await openInvitePeopleGuest(page)
  await expect(page.getByTestId('guest-invite-full')).toContainText('게스트는 0명까지예요')
  await expect(page.getByTestId('guest-place-picker')).toHaveCount(0)
  await expect(page.getByTestId('guest-invite-plans')).toHaveAttribute('href', 'https://plans.example.com/acme')
})

test('the owner: New conversation starts with Invite a guest, which picks the place first', async ({ page }) => {
  await start(page)
  await signIn(page)
  await page.goto('/rooms?new=1')
  await expect(page.getByTestId('invite-guest-row')).toContainText('게스트 초대')
  await page.getByTestId('invite-guest-row').click()
  await expect(page.getByTestId('guest-invite-flow')).toBeVisible()
  await page.getByTestId('guest-place-room').click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'견적 준비' 비공개 채널만")
  // Cancel goes back to the places, and Cancel there back to the people list
  await page.getByRole('button', { name: '취소' }).click()
  await expect(page.getByTestId('guest-invite-flow')).toBeVisible()
  await page.getByTestId('invite-guest-close').click()
  await expect(page.getByTestId('people-search')).toBeVisible()
  await expect(page.getByTestId('invite-guest-row')).toBeVisible()
})

test("the owner: a group chat's ⋯ has 초대하기, the add list with Invite a guest first", async ({ page }) => {
  await start(page)
  await signIn(page)
  await page.goto(`/rooms/${GROUP}`)
  await page.getByTestId('room-menu').click()
  await page.getByTestId('room-menu-invite').click()
  await expect(page.getByTestId('invite-guest-row')).toContainText('이 비공개 채널만')
  await page.getByTestId('invite-guest-row').click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'견적 준비' 비공개 채널만")
})

test('a member: no Invite people; New conversation offers their group chats and the projects they made only', async ({ page }) => {
  await start(page)
  await page.request.post('/__test/project', { data: { name: '내 프로젝트', by: 'bob' } })
  await page.request.post('/__test/project', { data: { name: '남의 프로젝트', by: 'olga' } })
  await signIn(page, BOB)
  // the team link is the owner's and admins': no team menu button for a member
  await expect(page.getByTestId('team-menu')).toHaveCount(0)
  await page.goto('/rooms?new=1')
  await page.getByTestId('invite-guest-row').click()
  await expect(page.getByTestId('guest-place-room')).toHaveText(/견적 준비/)
  await expect(page.getByTestId('guest-place-project')).toHaveCount(1)
  await expect(page.getByTestId('guest-place-project')).toContainText('내 프로젝트')
  await page.getByTestId('guest-place-project').click()
  // a member's AI choices: none and own, never Team AI
  await expect(page.getByTestId('guest-ai-team')).toHaveCount(0)
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  expect((await created).postDataJSON()).toMatchObject({ place: { kind: 'project' } })
  await expect(page.getByTestId('guest-invite-ready')).toBeVisible()
})

test('a member with no group chat and no project of theirs: a plain line instead of places', async ({ page }) => {
  await start(page, { rooms: [] })
  await signIn(page, BOB)
  await page.goto('/rooms?new=1')
  await page.getByTestId('invite-guest-row').click()
  await expect(page.getByTestId('guest-place-none')).toContainText('게스트를 초대할 비공개 채널, 그룹 대화나 프로젝트가 아직 없어요')
})

test("the owner's welcome steps: Invite people lands on the invite step, whose line opens Invite a guest", async ({ page }) => {
  await start(page)
  await signIn(page)
  const H = { [CSRF_HEADER]: '1' }
  await page.request.fetch('/api/onboarding/welcome/team', { method: 'POST', headers: H, data: {} })
  for (const id of ['ai', 'profile', 'result', 'skills', 'files', 'tools']) await page.request.fetch('/api/onboarding/welcome', { method: 'PATCH', headers: H, data: { step: { id, state: 'skipped' } } })
  await page.goto('/welcome')
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await expect(page.getByTestId('invite-step-guest')).toContainText('팀 밖의 사람인가요?')
  await page.getByTestId('invite-step-guest-open').click()
  await expect(page.getByTestId('guest-invite-flow')).toBeVisible()
  await page.getByTestId('guest-place-room').click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'견적 준비' 비공개 채널만")
  // Done/Cancel leaves the welcome step where it was
  await page.getByRole('button', { name: '취소' }).click()
  await page.getByRole('button', { name: '취소' }).click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
})

test('Invite people has no second guest line under Team member (the Guest tab is right there)', async ({ page }) => {
  await start(page)
  await signIn(page)
  await page.getByTestId('team-menu').click()
  await page.getByTestId('team-menu-invite').click()
  await expect(page.getByTestId('invite-step')).toBeVisible()
  await expect(page.getByTestId('invite-step-guest')).toHaveCount(0)
})

test("a guest: no Invite a guest in New conversation's place, and no 초대하기 in their room's ⋯", async ({ page }) => {
  await start(page)
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'room', id: GROUP }, ai: { mode: 'none' } } })).ok()).toBeTruthy()
  await page.goto('/login')
  await page.getByTestId('login-username').fill('gina')
  await page.getByTestId('login-password').fill('gina password 1')
  await page.getByTestId('login-submit').click()
  await page.goto(`/rooms/${GROUP}`)
  await expect(page.getByTestId('room-header')).toBeVisible()
  await page.getByTestId('room-menu').click()
  await expect(page.getByRole('menu').getByRole('menuitem').first()).toBeVisible()
  await expect(page.getByTestId('room-menu-invite')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('team-menu-invite')).toHaveCount(0)
  await expect(page.getByTestId('invite-guest-row')).toHaveCount(0)
})
