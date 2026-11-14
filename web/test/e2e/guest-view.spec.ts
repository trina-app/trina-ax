// A guest's own view (components/GuestView.tsx; docs/DECISIONS.md "Guests: only what they were invited to"): the rail and
// the phone's tabs have no 파일 (and no 프로젝트 for a guest in a room), the team's pages send them Home, Settings has
// only their own sections, their AI is off by default so Ask Trina shows one line instead of a box, their project's page
// tells them once that its members see their chats (with AI on: their own sign-in here), and the room list has only
// their room (no everyone room).
import { expect, test, type Page } from '@playwright/test'
import { uuidv7 } from '@mycel/shared/api'
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

async function guestIn(page: Page, place: { kind: 'room'; id: string } | { kind: 'project'; name: string }, ai: { mode: 'none' | 'own' | 'team' } = { mode: 'none' }) {
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
    // AI off: no ✦ side chat in the room
    await page.goto(`/rooms/${GROUP}`)
    await expect(page.getByTestId('room-header')).toBeVisible()
    await expect(page.getByTestId('room-side-chat-button')).toHaveCount(0)
    // the room info: no 초대하기 for a guest
    await page.getByTestId('room-members-button').click()
    await expect(page.getByTestId('room-members')).toBeVisible()
    await expect(page.getByTestId('room-invite')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.goto('/settings')
    await expect(page.getByTestId('settings-content')).toBeVisible()
    for (const tab of ['connectors', 'ai-apps', 'allowances', 'memory', 'usage', 'providers']) await expect(page.locator(`a[href="/settings/${tab}"]`)).toHaveCount(0)
    await expect(page.locator('a[href="/settings/profile"]')).toBeVisible()
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
  })
})
