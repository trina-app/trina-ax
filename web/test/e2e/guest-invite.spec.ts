// Guest invites (components/GuestInvite.tsx; docs/DECISIONS.md "Guests: only what they were invited to"): "Invite a guest"
// is the first row of a group chat's add list and of a project's members dialog. Its dialog asks a name and the AI
// (off by default; the owner and admins also get "Team AI", a member only none and own), makes a one-time link with Copy,
// and the plan's guest cap reads "게스트는 N명까지예요" (never a word about seats). The link opens the invite page, which
// says the guest joins one place only, with the members' sign-up form; joining lands in the guest's own view.
import { expect, test, type Page } from '@playwright/test'
import { uuidv7 } from '@mycel/shared/api'
import { OWNER, reset, signIn } from './helpers'

test.use({ viewport: { width: 1440, height: 900 } })

const GROUP = uuidv7()
const base = { canRename: true, managerId: 'olga', unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const at = new Date(Date.now() - 3600_000).toISOString()
const ROOMS = [{ ...base, id: GROUP, kind: 'group', name: '견적 준비', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: at, activityAt: at }]

async function start(page: Page, who = OWNER) {
  await reset(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
  await signIn(page, who)
}

/** The room's add list, from its title (the room info) › 초대하기. */
async function openRoomAdd(page: Page) {
  await page.goto(`/rooms/${GROUP}`)
  await page.getByTestId('room-members-button').click()
  await page.getByTestId('room-invite').click()
  await expect(page.getByTestId('invite-guest-row')).toBeVisible()
}

test('owner invites a guest into a group chat: name, AI with all three choices, a one-time link with Copy', async ({ page }) => {
  await start(page)
  await openRoomAdd(page)
  await expect(page.getByTestId('invite-guest-row')).toContainText('게스트 초대하기')
  await page.getByTestId('invite-guest-row').click()
  const dialog = page.getByTestId('guest-invite-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'견적 준비' 방만")
  // AI is off by default; the owner sees all three, Team AI asks an account and a monthly limit
  await expect(page.getByTestId('guest-ai-none')).toBeChecked()
  await expect(page.getByTestId('guest-ai-team')).toBeVisible()
  await expect(page.getByTestId('guest-ai-own')).toBeVisible()
  await page.getByTestId('guest-ai-team').check()
  await expect(page.getByTestId('guest-ai-team-fields')).toBeVisible()
  await expect(page.getByTestId('guest-ai-account').or(page.getByTestId('guest-ai-no-account')).first()).toBeVisible()
  await page.getByTestId('guest-ai-none').check()
  await page.getByTestId('guest-invite-name').fill('Alex')
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  const body = (await created).postDataJSON()
  expect(body).toMatchObject({ place: { kind: 'room', id: GROUP }, ai: { mode: 'none' } })
  await expect(page.getByTestId('guest-invite-ready')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('Alex님에게 보낼 링크')
  await expect(page.getByTestId('guest-invite-url')).toContainText('/invite/')
  await expect(page.getByTestId('guest-invite-ready').getByRole('button', { name: '링크 복사' })).toBeVisible()
  // the invite list says who the link is for
  await page.goto('/admin/members')
  await expect(page.getByTestId('invite-list')).toContainText('Alex')
})

test('Team AI: the first team AI account is chosen as soon as the list is read, with a monthly limit', async ({ page }) => {
  await start(page)
  const cred = await page.request.post('/__test/team-credential', { data: { label: 'Team Claude' } })
  const { id: credentialId } = (await cred.json()) as { id: string }
  await openRoomAdd(page)
  await page.getByTestId('invite-guest-row').click()
  await page.getByTestId('guest-ai-team').check()
  await expect(page.getByTestId('guest-ai-account')).toHaveValue(credentialId)
  await page.getByTestId('guest-ai-limit').fill('15')
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  expect((await created).postDataJSON()).toMatchObject({ ai: { mode: 'team', credentialId, limitUsd: 15 } })
  await expect(page.getByTestId('guest-invite-ready')).toBeVisible()
})

test('Cancel goes back to the add list', async ({ page }) => {
  await start(page)
  await openRoomAdd(page)
  await page.getByTestId('invite-guest-row').click()
  await expect(page.getByTestId('guest-invite-dialog')).toBeVisible()
  await page.getByRole('button', { name: '취소' }).click()
  await expect(page.getByTestId('invite-guest-row')).toBeVisible()
  await expect(page.getByTestId('people-search')).toBeVisible()
})

test('a member sees no Team AI; a full plan says so plainly and Create link is off', async ({ page }) => {
  await start(page, { username: 'bob', password: 'bob password 1' })
  expect((await page.request.post('/__test/guest-limit', { data: { guests: 0 } })).ok()).toBeTruthy()
  await openRoomAdd(page)
  await page.getByTestId('invite-guest-row').click()
  await expect(page.getByTestId('guest-ai-none')).toBeChecked()
  await expect(page.getByTestId('guest-ai-own')).toBeVisible()
  await expect(page.getByTestId('guest-ai-team')).toHaveCount(0)
  // nothing about a cap before it is reached
  await expect(page.getByTestId('guest-invite-full')).toHaveCount(0)
  await page.getByTestId('guest-invite-create').click()
  await expect(page.getByTestId('guest-invite-full')).toHaveText('게스트는 0명까지예요. 이미 다 찼어요.')
  await expect(page.getByTestId('guest-invite-full')).not.toContainText('자리')
  await expect(page.getByTestId('guest-invite-create')).toBeDisabled()
  // a member gets no plan link
  await expect(page.getByTestId('guest-invite-plans')).toHaveCount(0)
})

test("a project's creator invites from the members dialog; the link's page says it is one project only, then the form", async ({ page, browser }) => {
  await start(page)
  const r = await page.request.post('/__test/project', { data: { name: '견적 준비', by: 'olga' } })
  const { id } = (await r.json()) as { id: string }
  await page.goto(`/projects/${id}`)
  await page.getByTestId('project-members-manage').click()
  await page.getByTestId('invite-guest-row').click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'견적 준비' 프로젝트만")
  await page.getByTestId('guest-invite-create').click()
  const url = (await page.getByTestId('guest-invite-url').textContent())!
  // the guest opens it signed out
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const guest = await ctx.newPage()
  await guest.goto(new URL(url).pathname)
  await expect(guest.getByRole('heading', { level: 1 })).toContainText('Olga')
  await expect(guest.getByTestId('invite-guest-place')).toContainText('팀의 다른 곳은 보이지 않아요')
  await expect(guest.getByTestId('invite-full')).toHaveCount(0)
  // the members' sign-up form
  await guest.getByTestId('invite-name').fill('Alex')
  await guest.getByTestId('invite-username').fill('alex')
  await guest.getByTestId('invite-password').fill('alex password 1')
  await guest.getByTestId('invite-submit').click()
  // in: the guest's own view (no 파일, AI off)
  await expect(guest).toHaveURL(new RegExp(`/projects/${id}$`))
  await expect(guest.getByTestId('guest-no-ai')).toBeVisible()
  await expect(guest.getByTestId('rail-files')).toHaveCount(0)
  await ctx.close()
})

test('a guest already in another place: the refusal shows under their row, with Make team member for the owner', async ({ page }) => {
  await start(page)
  const r = await page.request.post('/__test/project', { data: { name: '다른 프로젝트', by: 'olga' } })
  const { id } = (await r.json()) as { id: string }
  expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'project', id } } })).ok()).toBeTruthy()
  // the server refuses a guest in a second place (server/src/auth/guests.ts failOnePlace)
  await page.route(`**/api/rooms/${GROUP}/members`, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'conflict', message: 'x', params: { reason: 'guest_one_place', userId: 'gina' } } }) })
    : route.fallback())
  await openRoomAdd(page)
  await page.getByTestId('people-row').filter({ hasText: 'Gina' }).getByTestId('picker-tick').check()
  await page.getByTestId('picker-go').click()
  const note = page.getByTestId('guest-one-place')
  await expect(note).toContainText('게스트는 방이나 프로젝트 한 곳에만 들어갈 수 있어요')
  await note.getByTestId('guest-one-place-convert').click()
  await expect(page).toHaveURL(/\/admin\/members\?member=gina/)
})
