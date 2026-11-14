// A guest's own view (components/GuestView.tsx; docs/DECISIONS.md "Guests: only what they were invited to"): the rail and
// the phone's tabs have no 파일 (and no 프로젝트 for a guest in a room, no 대화 for a guest in a project with none), the
// team's pages send them Home, Settings has only their own sections over their place, their AI is off by default so
// there is no 트리나 and no ✦ (Team AI keeps both, also while its account cannot answer yet), their project's page tells
// them once that its members see their chats (with AI on: their own sign-in here), the room list has only their room (no
// everyone room) and nothing to start, sign-in opens their place, and a removed guest's sign-in page says why.
import { expect, test, type Page } from '@playwright/test'
import { uuidv7, type GuestAiChoice } from '@mycel/shared/api'
import { reset } from './helpers'

const GROUP = uuidv7()
const EVERYONE = uuidv7()
const base = { canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const at = new Date(Date.now() - 3600_000).toISOString()
const ROOMS = [
  { ...base, id: EVERYONE, kind: 'all', name: null, groupId: null, memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at },
  { ...base, id: GROUP, kind: 'group', name: '견적 준비', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at },
]

/** Sign in as the guest (no composer to wait for: their AI is off). */
async function signInGuest(page: Page, id = 'gina') {
  await page.goto('/login')
  await page.getByTestId('login-username').fill(id)
  await page.getByTestId('login-password').fill(`${id} password 1`)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-submit')).toHaveCount(0)
}

const TEAM_AI: GuestAiChoice = { mode: 'team', credentialId: 'c1', limitUsd: 20 }

async function guestIn(page: Page, place: { kind: 'room'; id: string } | { kind: 'project'; name: string }, ai: GuestAiChoice = { mode: 'none' }) {
  await reset(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  if (place.kind === 'project') expect((await page.request.post('/__test/project', { data: { name: place.name, by: 'bob' } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place, ai } })).ok()).toBeTruthy()
  await signInGuest(page)
}

test.describe('computer', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a guest in a project with AI off lands on the project: no 트리나 or 파일, one quiet line, files and members', async ({ page }) => {
    await guestIn(page, { kind: 'project', name: '견적 준비' })
    // AI off: no Ask Trina at all; their one place opens
    await expect(page).toHaveURL(/\/projects\/[^/]+$/)
    await expect(page.getByTestId('rail')).toBeVisible()
    await expect(page.getByTestId('rail-ai')).toHaveCount(0)
    await expect(page.getByTestId('rail-files')).toHaveCount(0)
    await expect(page.getByTestId('rail-projects')).toBeVisible()
    await expect(page.getByTestId('guest-no-ai')).toHaveText('아직 AI를 쓸 수 없어요. 초대한 분께 물어봐 주세요.')
    await expect(page.getByTestId('composer-input')).toHaveCount(0)
    await expect(page.getByTestId('project-chats')).toHaveCount(0)
    // no conversation yet: no 대화 place either, and its address opens the project; the instructions are the AI's: none
    await expect(page.getByTestId('rail-chats')).toHaveCount(0)
    await expect(page.getByTestId('project-instructions')).toHaveCount(0)
    await expect(page.getByTestId('project-files')).toBeVisible()
    await page.goto('/rooms')
    await expect(page).toHaveURL(/\/projects\/[^/]+$/)
    // the team's pages are not theirs: Home, which opens their project
    for (const path of ['/files', '/skills', '/admin/members', '/scheduled', '/']) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/projects\/[^/]+$/)
    }
    await page.goto('/projects')
    await expect(page.getByTestId('project-new')).toHaveCount(0)
    await page.getByText('견적 준비').first().click()
    await expect(page.getByTestId('guest-no-ai')).toBeVisible()
    await expect(page.getByTestId('guest-project-note')).toHaveCount(0)
    await expect(page.getByTestId('project-import')).toHaveCount(0)
    await expect(page.getByTestId('project-menu')).toHaveCount(0)
  })

  test('a guest with their own sign-in: the box stays, and the project says once that its members see their chats', async ({ page }) => {
    await guestIn(page, { kind: 'project', name: '견적 준비' }, { mode: 'own' })
    await page.goto('/projects')
    await page.getByText('견적 준비').first().click()
    await expect(page.getByTestId('guest-project-note')).toHaveText(/이 프로젝트의 멤버는 여기서 나눈 대화를 볼 수 있어요/)
    await expect(page.getByTestId('guest-no-ai')).toHaveCount(0)
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('composer-input')).toBeVisible()
    await expect(page.getByTestId('guest-project-note')).toHaveCount(0)
    // their own sign-in: AI accounts stays in Settings (they sign in there), Memory does not
    await page.goto('/settings')
    await expect(page.getByTestId('settings-content')).toBeVisible()
    await expect(page.locator('a[href="/settings/providers"]')).toBeVisible()
    await expect(page.locator('a[href="/settings/memory"]')).toHaveCount(0)
  })

  test('a guest in a room: only that room (no everyone room), no 프로젝트 or 파일, Settings has only their own sections', async ({ page }) => {
    await guestIn(page, { kind: 'room', id: GROUP })
    await expect(page.getByTestId('rail-files')).toHaveCount(0)
    await expect(page.getByTestId('rail-projects')).toHaveCount(0)
    await page.goto('/rooms')
    await expect(page.getByText('견적 준비').first()).toBeVisible()
    await expect(page.locator(`a[href="/rooms/${EVERYONE}"]`)).toHaveCount(0)
    // a computer's chats page is their room itself; no folders to make and no "+" (nothing to start from the list)
    await expect(page).toHaveURL(new RegExp(`/rooms/${GROUP}$`))
    await expect(page.getByTestId('chats-panel')).toBeVisible()
    await expect(page.getByTestId('chats-panel').getByText('새 폴더')).toHaveCount(0)
    await expect(page.getByTestId('rooms-new-dm')).toHaveCount(0)
    // AI off: no ✦ side chat in the room
    await page.goto(`/rooms/${GROUP}`)
    await expect(page.getByTestId('room-header')).toBeVisible()
    await expect(page.getByTestId('room-side-chat-button')).toHaveCount(0)
    // the room info: no 초대하기 for a guest
    await page.getByTestId('room-members-button').click()
    await expect(page.getByTestId('room-members')).toBeVisible()
    await expect(page.getByTestId('room-invite')).toHaveCount(0)
    await page.keyboard.press('Escape')
    // Settings opened by its address: over their room (not 트리나); who sees the profile, and no "그룹 없음"
    await page.goto('about:blank')
    await page.goto('/settings')
    await expect(page.getByTestId('settings-content')).toBeVisible()
    for (const tab of ['connectors', 'ai-apps', 'allowances', 'memory', 'usage', 'providers']) await expect(page.locator(`a[href="/settings/${tab}"]`)).toHaveCount(0)
    await expect(page.locator('a[href="/settings/profile"]')).toBeVisible()
    await expect(page.getByTestId('room-header')).toBeAttached()
    await expect(page.getByTestId('rail-ai')).toHaveCount(0)
    await page.goto('/settings/profile')
    await expect(page.getByTestId('profile-visible')).toHaveText("이름, 직함, 사진은 '견적 준비'에 있는 사람들에게 보여요. 이메일은 관리자만 볼 수 있어요.")
    await expect(page.getByText('그룹 없음')).toHaveCount(0)
    await page.getByTestId('settings-close').click()
    await expect(page).toHaveURL(new RegExp(`/rooms/${GROUP}$`))
  })

  test('a guest with Team AI: sign-in opens their room, 트리나 and the ✦ side chat are there', async ({ page }) => {
    await guestIn(page, { kind: 'room', id: GROUP }, TEAM_AI)
    await expect(page).toHaveURL(new RegExp(`/rooms/${GROUP}$`))
    await expect(page.getByTestId('rail-ai')).toBeVisible()
    await expect(page.getByTestId('room-side-chat-button')).toBeVisible()
    await page.getByTestId('room-side-chat-button').click()
    await expect(page.getByTestId('guest-no-ai')).toHaveCount(0)
    await page.getByTestId('rail-ai').click()
    await expect(page.getByTestId('composer-input')).toBeVisible()
  })

  test("a guest with Team AI whose account cannot answer here: 트리나 and ✦ stay, the box says why", async ({ page }) => {
    await page.route('**/api/me/ai-access', (r) => r.fulfill({ json: { usable: false, action: 'ask_owner', requested: false } }))
    await guestIn(page, { kind: 'room', id: GROUP }, TEAM_AI)
    await expect(page).toHaveURL(new RegExp(`/rooms/${GROUP}$`))
    await expect(page.getByTestId('rail-ai')).toBeVisible()
    await page.getByTestId('room-side-chat-button').click()
    await expect(page.getByTestId('guest-no-ai')).toBeVisible()
    await expect(page.getByTestId('side-chat-starters')).toHaveCount(0)
    await page.goto('/')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('guest-no-ai')).toBeVisible()
    await expect(page.getByTestId('composer-input')).toHaveCount(0)
  })

  test("a removed guest's sign-in page says they are no longer in the team", async ({ page }) => {
    await guestIn(page, { kind: 'room', id: GROUP })
    await expect(page).toHaveURL(new RegExp(`/rooms/${GROUP}$`))
    await expect(page.getByTestId('room-header')).toBeVisible()
    // the server turns the account off: session.ended with reason 'disabled' (server/src/services.ts)
    await page.waitForTimeout(500)
    expect((await page.request.post('/__test/publish', { data: { event: { type: 'session.ended', data: { reason: 'disabled' } } } })).ok()).toBeTruthy()
    await expect(page.getByTestId('login-removed')).toContainText('팀에 없어서 로그인할 수 없어요')
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a guest in a room: the tab bar has no 프로젝트 or 파일', async ({ page }) => {
    await guestIn(page, { kind: 'room', id: GROUP })
    // AI off: they land in their room; the list under it has the tab bar
    await expect(page).toHaveURL(new RegExp(`/rooms/${GROUP}$`))
    await page.goto('/rooms')
    await expect(page.getByTestId('bottom-tabs')).toBeVisible()
    await expect(page.getByTestId('tab-files')).toHaveCount(0)
    await expect(page.getByTestId('tab-projects')).toHaveCount(0)
    await expect(page.getByTestId('tab-chats')).toBeVisible()
    await expect(page.getByTestId('tab-ai')).toHaveCount(0)
    await expect(page.getByTestId('rooms-start-hint')).toHaveCount(0)
  })

  test('a guest in a project with no conversation: no 대화 tab; sign-in opens the project', async ({ page }) => {
    await guestIn(page, { kind: 'project', name: '견적 준비' }, TEAM_AI)
    await expect(page).toHaveURL(/\/projects\/[^/]+$/)
    await expect(page.getByTestId('bottom-tabs').or(page.getByTestId('composer-input')).first()).toBeVisible()
    await page.goto('/projects')
    await expect(page.getByTestId('bottom-tabs')).toBeVisible()
    await expect(page.getByTestId('tab-chats')).toHaveCount(0)
    await expect(page.getByTestId('tab-ai')).toBeVisible()
    await expect(page.getByTestId('tab-projects')).toBeVisible()
  })
})
