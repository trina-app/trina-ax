// A guest into one of my personal projects (docs/DECISIONS.md "Guests into a personal project"). The guest place picker
// (components/GuestInviteChoice.tsx GuestPlacePicker) lists my own personal projects under Projects, with "Only me",
// when I may share them (the project page's "Add people"). Picking one says in one line what changes; Create link first
// shares it with nobody else yet (POST /api/projects/:id/share, as "Add people" does: a team project in projects/ that
// only I see), then makes the link. A Create link refused after the share (the plan filled up meanwhile) does not share
// it twice. A member whose team lets only admins share projects does not get their personal projects here.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { translate } from '../../src/i18n'

test.use({ viewport: { width: 1440, height: 900 } })

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }

async function start(page: Page) {
  await reset(page)
  expect((await page.request.post('/__test/rooms', { data: { rooms: [] } })).ok()).toBeTruthy()
  const mine = (await (await page.request.post('/__test/project', { data: { name: '제안서', by: 'olga', personal: true, files: { 'draft.txt': 'first draft' } } })).json()) as { id: string }
  // someone else's personal project is never mine to offer
  await page.request.post('/__test/project', { data: { name: '밥의 메모', by: 'bob', personal: true } })
  return mine.id
}

async function openGuest(page: Page) {
  await page.goto('/admin/members')
  await page.getByTestId('invite-new').click()
  await page.getByRole('tab', { name: '게스트' }).click()
}

test('the owner invites a guest into their personal project: shared first with nobody else, then the link', async ({ page }) => {
  const id = await start(page)
  await signIn(page)
  await openGuest(page)
  const row = page.getByTestId('guest-place-project')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('제안서')
  await expect(row).toContainText(translate('ko', 'projects.members.onlyMe'))
  await row.click()
  await expect(page.getByTestId('guest-invite-where')).toContainText("'제안서' 프로젝트만")
  await expect(page.getByTestId('guest-invite-personal')).toHaveText(`${translate('ko', 'guest.invite.personalProject')} ${translate('ko', 'projects.shareConfirmFinal')}`)
  // Cancel shares nothing
  const calls: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && (r.url().includes('/share') || r.url().endsWith('/api/guest-invites'))) calls.push(new URL(r.url()).pathname) })
  await page.getByRole('button', { name: '취소' }).click()
  await page.getByTestId('guest-place-project').click()
  const shared = page.waitForRequest((r) => r.url().endsWith(`/api/projects/${id}/share`) && r.method() === 'POST')
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  expect((await shared).postDataJSON()).toMatchObject({ participants: [] })
  expect((await created).postDataJSON()).toMatchObject({ place: { kind: 'project', id } })
  await expect(page.getByTestId('guest-invite-ready')).toBeVisible()
  expect(calls).toEqual([`/api/projects/${id}/share`, '/api/guest-invites'])
  // a team project now, its files moved along, still only mine until the guest joins
  const p = await (await page.request.get(`/api/projects/${id}`)).json()
  expect(p.folderPath).toBe('projects/제안서')
  expect((await (await page.request.get(`/api/files/content?path=${encodeURIComponent('projects/제안서/draft.txt')}`)).json()).content).toBe('first draft')
  await page.getByTestId('guest-invite-done').click()
  // offered again, it is a team project whose members I change: no line, no second share
  await page.getByTestId('invite-new').click()
  await page.getByRole('tab', { name: '게스트' }).click()
  await expect(page.getByTestId('guest-place-project')).not.toContainText(translate('ko', 'projects.members.onlyMe'))
  await page.getByTestId('guest-place-project').click()
  await expect(page.getByTestId('guest-invite-personal')).toHaveCount(0)
})

test('the plan fills up after the share: the limit, and the project is shared only once', async ({ page }) => {
  const id = await start(page)
  await signIn(page)
  await openGuest(page)
  await page.getByTestId('guest-place-project').click()
  await expect(page.getByTestId('guest-invite-personal')).toBeVisible()
  // the plan fills up meanwhile: the share goes through, the invite is refused
  expect((await page.request.post('/__test/guest-limit', { data: { guests: 0 } })).ok()).toBeTruthy()
  let shares = 0
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith(`/api/projects/${id}/share`)) shares++ })
  await page.getByTestId('guest-invite-create').click()
  await expect(page.getByTestId('guest-invite-full')).toBeVisible()
  expect(shares).toBe(1)
})

test('shared meanwhile in another tab: Create link still makes the link', async ({ page }) => {
  const id = await start(page)
  await signIn(page)
  await openGuest(page)
  await page.getByTestId('guest-place-project').click()
  await expect(page.getByTestId('guest-invite-personal')).toBeVisible()
  expect((await page.request.post(`/api/projects/${id}/share`, { headers: H, data: { participants: [] } })).ok()).toBeTruthy()
  const created = page.waitForRequest((r) => r.url().endsWith('/api/guest-invites') && r.method() === 'POST')
  await page.getByTestId('guest-invite-create').click()
  expect((await created).postDataJSON()).toMatchObject({ place: { kind: 'project', id } })
  await expect(page.getByTestId('guest-invite-ready')).toBeVisible()
})

test('a member whose team lets only admins share projects: their personal projects are not offered', async ({ page }) => {
  await start(page)
  await signIn(page)
  expect((await page.request.patch('/api/admin/settings', { headers: H, data: { projectCreators: 'admins' } })).ok()).toBeTruthy()
  await page.context().clearCookies()
  await signIn(page, BOB)
  await page.goto('/rooms?new=1')
  await page.getByTestId('invite-guest-row').click()
  // nothing to offer: the plain line
  await expect(page.getByTestId('guest-place-project')).toHaveCount(0)
  await expect(page.getByTestId('guest-place-none')).toHaveText(translate('ko', 'guest.invite.noPlaces'))
})

test('a member whose team lets them share: New conversation offers their personal project', async ({ page }) => {
  await start(page)
  await signIn(page, BOB)
  await page.goto('/rooms?new=1')
  await page.getByTestId('invite-guest-row').click()
  await expect(page.getByTestId('guest-place-project')).toHaveCount(1)
  await expect(page.getByTestId('guest-place-project')).toContainText('밥의 메모')
  await page.getByTestId('guest-place-project').click()
  await expect(page.getByTestId('guest-invite-personal')).toBeVisible()
})
