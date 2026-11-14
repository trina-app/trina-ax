// Admin › Members & invites for guests (pages/admin/Guests.tsx; docs/DECISIONS.md "Guest invites: the admin and invite
// screens, simpler"): Guests in the Role filter, removed guests out of sight behind "Show removed", used guest links
// gone, a project guest link named; "Make team member" reads the seats before its dialog (full: says so with See plans,
// nothing to confirm) and says the AI then follows the team's settings; "Change AI" has one title and Team AI is off
// without a team AI account.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

test.use({ viewport: { width: 1440, height: 900 } })

const ROOM = uuidv7()
const base = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const at = new Date(Date.now() - 3600_000).toISOString()
const ROOMS = [{ ...base, id: ROOM, kind: 'group', name: '견적 준비', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at }]

async function start(page: Page) {
  await reset(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'room', id: ROOM } } })).ok()).toBeTruthy()
  expect((await page.request.post('/__test/guest', { data: { id: 'rhea', name: 'Rhea', place: { kind: 'room', id: ROOM } } })).ok()).toBeTruthy()
  await signIn(page)
  await page.goto('/admin/members')
  await expect(page.getByTestId('guests-list')).toBeVisible()
}

const menu = (page: Page, username: string) => page.getByTestId(`guest-row-${username}`).getByTestId('member-more')

test('the Role filter has Guests: only the guests list then', async ({ page }) => {
  await start(page)
  await expect(page.getByTestId('members-table')).toBeVisible()
  await page.getByTestId('member-role-filter').selectOption('guest')
  await expect(page.getByTestId('members-table')).toBeHidden()
  await expect(page.getByTestId('guest-row-gina')).toBeVisible()
  await page.getByTestId('member-role-filter').selectOption('admin')
  await expect(page.getByTestId('guests-section')).toHaveCount(0)
  // the search narrows the guests too
  await page.getByTestId('member-role-filter').selectOption('all')
  await page.getByTestId('member-search').fill('rhea')
  await expect(page.getByTestId('guest-row-rhea')).toBeVisible()
  await expect(page.getByTestId('guest-row-gina')).toHaveCount(0)
})

test('a removed guest is out of sight until "Show removed"', async ({ page }) => {
  await start(page)
  await menu(page, 'rhea').click()
  await page.getByTestId('guest-remove-rhea').click()
  await page.getByTestId('dialog-confirm').click()
  await expect(page.getByTestId('guest-row-rhea')).toHaveCount(0)
  await expect(page.getByTestId('guests-show-removed')).toHaveText('내보낸 게스트 보기 (1)')
  await page.getByTestId('guests-show-removed').click()
  await expect(page.getByTestId('guest-row-rhea')).toBeVisible()
  await page.getByTestId('guests-show-removed').click()
  await expect(page.getByTestId('guest-row-rhea')).toHaveCount(0)
})

test('Make team member with every seat taken: the dialog says so first, with See plans and nothing to confirm', async ({ page }) => {
  await start(page)
  expect((await page.request.post('/__test/guest-limit', { data: { seatsFull: true } })).ok()).toBeTruthy()
  await menu(page, 'gina').click()
  await page.getByTestId('guest-convert-gina').click()
  await expect(page.getByTestId('guest-convert-full')).toContainText('남은 자리가 없어요')
  await expect(page.getByTestId('guest-convert-plans')).toHaveAttribute('href', 'https://plans.example.com/acme')
  await expect(page.getByTestId('guest-convert-confirm')).toHaveCount(0)
})

test('Make team member: says the AI then follows the team, and converts', async ({ page }) => {
  await start(page)
  await menu(page, 'gina').click()
  await page.getByTestId('guest-convert-gina').click()
  await expect(page.getByTestId('guest-convert-ai')).toHaveText('AI는 다른 팀원처럼 팀 설정을 따라요.')
  await page.getByTestId('guest-convert-confirm').click()
  await expect(page.getByTestId('guest-row-gina')).toHaveCount(0)
  await expect(page.getByTestId('members-table')).toContainText('Gina')
})

test('Change AI: one title; Team AI is off without a team AI account, and its fields sit under it once there is one', async ({ page }) => {
  await start(page)
  await menu(page, 'gina').click()
  await page.getByTestId('guest-ai-gina').click()
  const dialog = page.getByTestId('guest-ai-dialog')
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('Gina님의 AI')
  // the choices' own heading is for screen readers only
  await expect(dialog.locator('legend')).toHaveClass(/sr-only/)
  await expect(page.getByTestId('guest-ai-team')).toBeDisabled()
  await expect(page.getByTestId('guest-ai-add-account')).toBeVisible()
  await page.keyboard.press('Escape')
  expect((await page.request.post('/__test/team-credential', { data: { label: 'Team Claude' } })).ok()).toBeTruthy()
  await menu(page, 'gina').click()
  await page.getByTestId('guest-ai-gina').click()
  await page.getByTestId('guest-ai-team').check()
  await expect(page.getByTestId('guest-ai-account')).toBeVisible()
  await page.getByTestId('guest-ai-save').click()
  await expect(page.getByTestId('guest-row-gina')).toContainText('팀 AI · $20')
})

test('invite links: a used guest link is gone, a project link names its project', async ({ page, browser }) => {
  await start(page)
  const r = await page.request.post('/__test/project', { data: { name: '연간 계획', by: 'olga' } })
  const { id } = (await r.json()) as { id: string }
  // two guest links into the project: one used, one open
  await page.goto(`/projects/${id}`)
  const urls: string[] = []
  for (const name of ['Used Kim', 'Open Lee']) {
    await page.getByTestId('project-members-manage').click()
    await page.getByTestId('invite-guest-row').click()
    await page.getByTestId('guest-invite-name').fill(name)
    await page.getByTestId('guest-invite-create').click()
    urls.push((await page.getByTestId('guest-invite-url').textContent())!)
    await page.getByTestId('guest-invite-done').click()
  }
  // the first one is used, in a browser of its own
  const ctx = await browser.newContext()
  const token = new URL(urls[0]!).pathname.split('/invite/')[1]
  const ok = await ctx.request.post(new URL(`/api/invites/${token}/accept`, urls[0]).toString(), { data: { username: 'kim', name: 'Kim', password: 'kim password 1' }, headers: { [CSRF_HEADER]: '1' } })
  expect(ok.ok()).toBeTruthy()
  await ctx.close()
  await page.goto('/admin/members')
  const list = page.getByTestId('invite-list')
  await expect(list).toContainText('Open Lee')
  await expect(list).toContainText('연간 계획')
  await expect(list).not.toContainText('Used Kim')
})
