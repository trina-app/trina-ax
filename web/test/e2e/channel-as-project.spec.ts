// Create a channel's "Make it a project" (docs/decisions/20261121-create-channel-as-project.md), at 1440 (light) and
// 390 (dark), against the mock server (test/mock/server.ts createProject, openProjectRoom with ?listed=1):
// - off (the default): Create private channel makes a private channel, no project;
// - on: Create project makes a team project with the people picked and lands in its room, listed under Projects in the
//   Chats list before any message, with the same people;
// - a name a team project I see has: the "-2" hint, and the project is made in the "-2" folder;
// - guests: a private channel takes none; a project takes one whose project place is free, never one in another project.
// SHOTS_DIR: the dialog's screenshots (off, on, name taken; light and dark) go there (none without it).
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const base = { canRename: true, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
// a DM with Bob, so the phone's Chats list shows its sections (and their "+") at all
const DM = { ...base, id: uuidv7(), kind: 'dm', name: null, canRename: false, groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(10) }

const VIEWPORTS = [
  { name: '1440', phone: false, scheme: 'light' as const, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } },
  { name: '390', phone: true, scheme: 'dark' as const, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } },
]

/** a team project of Olga's (POST /api/projects scope team), so its name is taken */
async function teamProject(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/projects', { headers: H, data: { name, scope: 'team', instructions: '', participants: [{ subjectType: 'user', subjectId: 'bob' }] } })
  expect(r.status()).toBe(201)
  return ((await r.json()) as { id: string }).id
}

for (const vp of VIEWPORTS) {
  test.describe(`Create a channel as a project at ${vp.name} (${vp.scheme})`, () => {
    test.use({ ...vp.use, locale: 'en-US', colorScheme: vp.scheme })
    const tap = (page: Page, id: string) => (vp.phone ? page.getByTestId(id).first().tap() : page.getByTestId(id).first().click())
    const dialog = (page: Page) => page.getByRole('dialog')
    const tick = (page: Page, name: string) => dialog(page).getByTestId('people-row').filter({ hasText: name }).getByTestId('picker-tick').check()

    /** the Chats list's Channels "+" › Create a channel */
    async function openDialog(page: Page) {
      if (vp.phone) await page.goto('/rooms')
      else await page.getByTestId('rail-chats').click()
      await tap(page, 'rooms-channels-add')
      await tap(page, 'rooms-new-channel')
      await expect(dialog(page).getByRole('heading')).toHaveText('Create a channel')
    }

    test.beforeEach(async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
      await signIn(page)
      expect((await page.request.post('/__test/rooms', { data: { rooms: [DM] } })).ok()).toBeTruthy()
    })

    test('off (the default): Create private channel makes a private channel, no project', async ({ page }) => {
      await openDialog(page)
      const box = dialog(page).getByTestId('picker-as-project-tick')
      await expect(box).not.toBeChecked()
      await expect(dialog(page).getByTestId('picker-as-project')).toHaveText('Make it a projectShared folder and Trina for these people')
      await dialog(page).getByTestId('picker-name').fill('Weekly sync')
      await tick(page, 'Bob')
      await expect(dialog(page).getByTestId('picker-go')).toHaveText('Create private channel')
      await tap(page, 'picker-go')
      await expect(dialog(page)).toHaveCount(0)
      await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]+$/)
      await expect(page.getByTestId('room-title')).toHaveText('Weekly sync')
      await expect(page.getByTestId('room-project')).toHaveCount(0)
      const projects = (await (await page.request.get('/api/projects', { headers: H })).json()) as { items: { name: string }[] }
      expect(projects.items.map((p) => p.name)).not.toContain('Weekly sync')
    })

    test('on: Create project makes the project with the people picked and lands in its room, listed, with the same people', async ({ page }) => {
      await openDialog(page)
      await dialog(page).getByTestId('picker-name').fill('Launch plan')
      await dialog(page).getByTestId('picker-as-project-tick').check()
      await tick(page, 'Bob')
      await tick(page, 'Dana')
      await expect(dialog(page).getByTestId('picker-go')).toHaveText('Create project')
      await tap(page, 'picker-go')
      await expect(dialog(page)).toHaveCount(0)
      await expect(page.getByTestId('room-title')).toHaveText('Launch plan')
      await expect(page.getByTestId('room-project')).toBeVisible()
      const roomId = /\/rooms\/([0-9a-f-]+)$/.exec(page.url())![1]!
      // the same people: me and the two picked
      const members = (await (await page.request.get(`/api/rooms/${roomId}/members`, { headers: H })).json()) as { items: { user: { id: string } }[] }
      expect(members.items.map((m) => m.user.id).sort()).toEqual(['bob', 'dana', 'olga'])
      // listed under Projects before its first message
      const room = (await (await page.request.get(`/api/rooms/${roomId}`, { headers: H })).json()) as { listed?: boolean; lastMessage: unknown }
      expect(room).toMatchObject({ listed: true, lastMessage: null })
      if (vp.phone) {
        await page.goto('/rooms')
        await expect(page.getByTestId('rooms-page').locator('[data-testid="rooms-section"][data-section="project"]')).toContainText('Launch plan')
      } else {
        const panel = page.getByTestId('chats-panel')
        await expect(panel.locator('[data-testid="chats-panel-section"][data-section="project"]').getByTestId('sidebar-room-row')).toHaveText(['Launch plan'])
      }
      // no private channel of that name was made
      const rooms = (await (await page.request.get('/api/rooms', { headers: H })).json()) as { items: { name: string | null; projectRoom?: boolean }[] }
      expect(rooms.items.filter((r) => r.name === 'Launch plan').map((r) => !!r.projectRoom)).toEqual([true])
    })

    test('a name a team project has: the "-2" hint, and the project goes to the "-2" folder', async ({ page }) => {
      await teamProject(page, 'Launch')
      await openDialog(page)
      await dialog(page).getByTestId('picker-name').fill('Launch')
      // a channel's name may be anything: no hint while it is off
      await expect(dialog(page).getByTestId('picker-name-taken')).toHaveCount(0)
      await dialog(page).getByTestId('picker-as-project-tick').check()
      await expect(dialog(page).getByTestId('picker-name-taken')).toHaveText('A project called Launch already exists; this one will be Launch-\u20602 in Files.')
      await tick(page, 'Bob')
      await expect(dialog(page).getByTestId('picker-go')).toBeEnabled()
      await tap(page, 'picker-go')
      await expect(page.getByTestId('room-project')).toBeVisible()
      const projects = (await (await page.request.get('/api/projects', { headers: H })).json()) as { items: { name: string; folderPath: string }[] }
      expect(projects.items.filter((p) => p.name === 'Launch').map((p) => p.folderPath).sort()).toEqual(['projects/Launch', 'projects/Launch-2'])
    })

    test('guests: a private channel takes none; a project takes one whose project place is free, never one in another project', async ({ page }) => {
      await teamProject(page, 'Launch')
      const room = uuidv7()
      expect((await page.request.post('/__test/rooms', { data: { rooms: [DM, { ...base, id: room, kind: 'group', name: 'Quotes', groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(60), activityAt: ago(5) }] } })).ok()).toBeTruthy()
      expect((await page.request.post('/__test/guest', { data: { id: 'gina', name: 'Gina', place: { kind: 'project', name: 'Launch' } } })).ok()).toBeTruthy()
      expect((await page.request.post('/__test/guest', { data: { id: 'rhea', name: 'Rhea', place: { kind: 'room', id: room } } })).ok()).toBeTruthy()
      await openDialog(page)
      await dialog(page).getByTestId('picker-name').fill('Quote review')
      await tick(page, 'Rhea')
      await expect(dialog(page).getByTestId('picker-count')).toHaveText('A guest can be in one private channel or group chat, and one project.')
      await expect(dialog(page).getByTestId('picker-go')).toBeDisabled()
      await dialog(page).getByTestId('picker-as-project-tick').check()
      // a project: Rhea (a group chat only) can come; Gina (in another project) is greyed out, with no tick
      await expect(dialog(page).getByTestId('picker-count')).toHaveText('1 selected')
      await expect(dialog(page).getByTestId('picker-go')).toBeEnabled()
      const gina = dialog(page).locator('[data-testid="people-row-elsewhere"]').filter({ hasText: 'Gina' })
      await expect(gina).toContainText("In the 'Launch' project")
      await expect(gina.getByTestId('picker-tick')).toHaveCount(0)
      // off again: Rhea blocks the private channel again
      await dialog(page).getByTestId('picker-as-project-tick').uncheck()
      await expect(dialog(page).getByTestId('picker-go')).toBeDisabled()
    })

    test('screenshots: off, on, name taken (light and dark)', async ({ page }) => {
      test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
      await teamProject(page, 'Launch')
      await openDialog(page)
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        const shot = (name: string) => page.screenshot({ path: path.join(process.env.SHOTS_DIR!, `${vp.name}-${scheme}-${name}.png`) })
        const box = dialog(page).getByTestId('picker-as-project-tick')
        if (await box.isChecked()) await box.uncheck()
        await dialog(page).getByTestId('picker-name').fill('Weekly sync')
        if (!(await dialog(page).getByTestId('people-row').filter({ hasText: 'Bob' }).getByTestId('picker-tick').isChecked())) await tick(page, 'Bob')
        if (!(await dialog(page).getByTestId('people-row').filter({ hasText: 'Dana' }).getByTestId('picker-tick').isChecked())) await tick(page, 'Dana')
        await page.mouse.move(0, 0)
        await shot('off')
        await box.check()
        await expect(dialog(page).getByTestId('picker-go')).toHaveText('Create project')
        await shot('on')
        await dialog(page).getByTestId('picker-name').fill('Launch')
        await expect(dialog(page).getByTestId('picker-name-taken')).toBeVisible()
        await shot('name-taken')
      }
    })
  })
}
