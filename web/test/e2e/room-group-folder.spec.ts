// A group's room links to the group's folder (QA TC-3834; docs/decisions/20261116-room-group-folder-button.md): the
// header's Files button, beside the name and the member count, opens /files?path=<the folder> and Back returns to the
// room. Only a team room whose group has a folder I can open carries it (Room.groupFolder, decided by the server):
// no button in a team room without it, the everyone room, a 1:1 or a group chat. A phone shows the folder icon alone,
// with the accessible name. SHOTS_DIR=<folder>: screens for review (1440 and 390, light and dark, English and Korean).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const rid = (n: number) => `019a5f00-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`
const SORA = { id: 'sora', name: 'Sora Kim' }
const MINSU = { id: 'minsu', name: 'Minsu Lee' }
const LEADS = rid(1), NO_FOLDER = rid(2), ALL = rid(3), DM = rid(4), GROUP = rid(5)
const ROOMS: MockRoomSpec[] = [
  { id: LEADS, kind: 'team', name: 'leads', peers: [SORA, MINSU], ago: 3, last: 'Notes from Monday are in the folder', groupFolder: 'groups/leads' },
  // a team room whose folder the rules keep me out of: the server leaves groupFolder out
  { id: NO_FOLDER, kind: 'team', name: 'finance', peers: [MINSU], ago: 10, last: 'Budget draft' },
  { id: ALL, kind: 'all', name: null, peers: [SORA, MINSU], ago: 20, last: 'Lunch?' },
  { id: DM, kind: 'dm', name: null, peers: [SORA], ago: 30, last: 'See you at 10' },
  { id: GROUP, kind: 'group', name: 'Launch', peers: [SORA, MINSU], ago: 40, last: 'Draft two is up' },
]

async function start(page: Page, locale: 'en' | 'ko' = 'en') {
  await reset(page, { teamLocale: locale, usersFollowTeam: true })
  await routeRooms(page, ROOMS)
  await signIn(page)
  // the group's folder with its meeting notes, in the mock's files
  for (const p of ['groups', 'groups/leads', 'groups/leads/Meeting notes']) {
    const r = await page.request.post('/api/files/mkdir', { headers: { [CSRF_HEADER]: '1' }, data: { path: p } })
    expect([200, 201, 409]).toContain(r.status())
  }
}

test('Files in a group\'s room opens its folder, Back returns to the room; no button in the other rooms', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page)
  await page.goto('/rooms')
  await page.goto(`/rooms/${LEADS}`)
  const files = page.getByTestId('room-group-files')
  await expect(files).toBeVisible()
  await expect(files).toHaveText('Files')
  // the name is whole beside it (not cut to "le…")
  expect(await page.getByTestId('room-title').evaluate((e) => e.scrollWidth <= Math.ceil(e.getBoundingClientRect().width) + 1)).toBe(true)
  await expect(files).toHaveAccessibleName('Files')
  await expect(files).toHaveAttribute('href', '/files?path=groups%2Fleads')
  // beside the title and the member count, on the header's left (before ✦ and ⋯)
  const title = await page.getByTestId('room-title').boundingBox()
  const box = await files.boundingBox()
  const side = await page.getByTestId('room-side-chat-button').boundingBox()
  expect(box!.x).toBeGreaterThan(title!.x)
  expect(box!.x + box!.width).toBeLessThan(side!.x)
  await files.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Open the leads folder')

  await files.click()
  await expect(page).toHaveURL(/\/files\?path=groups%2Fleads$/)
  await expect(page.getByText('Meeting notes', { exact: true }).first()).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/rooms/${LEADS}$`))
  await expect(page.getByTestId('room-group-files')).toBeVisible()

  // no button: a team room without the folder, the everyone room, a 1:1, a group chat
  for (const id of [NO_FOLDER, ALL, DM, GROUP]) {
    await page.goto(`/rooms/${id}`)
    await expect(page.getByTestId('room-message')).toHaveCount(1)
    await expect(page.getByTestId('room-group-files')).toHaveCount(0)
  }
})

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
test('the folder icon alone, with its name, in the header; it opens the folder and Back returns', async ({ page }) => {
  await start(page, 'ko')
  await page.goto('/rooms')
  await page.goto(`/rooms/${LEADS}`)
  const files = page.getByTestId('room-group-files')
  await expect(files).toBeVisible()
  await expect(files).toHaveAccessibleName('파일')
  await expect(files.getByText('파일')).toBeHidden()
  const b = (await files.boundingBox())!
  expect(b.height).toBeGreaterThanOrEqual(44)
  expect(b.x + b.width).toBeLessThanOrEqual(390)
  await files.tap()
  await expect(page).toHaveURL(/\/files\?path=groups%2Fleads$/)
  await expect(page.getByText('Meeting notes', { exact: true }).first()).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/rooms/${LEADS}$`))
  await expect(page.getByTestId('room-group-files')).toBeVisible()
})
})

test('screenshots for review (SHOTS_DIR): 1440 and 390, light and dark, English and Korean', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  test.setTimeout(180_000)
  const dir = process.env.SHOTS_DIR!
  fs.mkdirSync(dir, { recursive: true })
  for (const locale of ['en', 'ko'] as const) {
    await start(page, locale)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 400 ? 900 : 844 })
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
        await page.goto(`/rooms/${LEADS}`)
        await expect(page.getByTestId('room-group-files')).toBeVisible()
        if (width > 400) { await page.getByTestId('room-group-files').hover(); await expect(page.getByRole('tooltip')).toBeVisible() }
        await page.screenshot({ path: path.join(dir, `${width}-${scheme}-${locale}-leads.png`) })
        await page.mouse.move(0, 0)
        await page.goto(`/rooms/${NO_FOLDER}`)
        await expect(page.getByTestId('room-message')).toHaveCount(1)
        await page.screenshot({ path: path.join(dir, `${width}-${scheme}-${locale}-no-folder.png`) })
      }
    }
  }
})
