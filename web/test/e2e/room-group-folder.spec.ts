// A department's room and its folder (QA TC-3834, TC-6304, TC-6305; docs/decisions/20261121-department-room-files.md,
// which supersedes the folder row of 20261121-room-files-list.md): a team room of a group with a folder I can open has
// 📁 {group} first in its header, which opens /files?path=<the folder> (Back returns to the room). Its uploads go to
// <group folder>/Chat attachments (the chip names "{group} › Chat attachments"), so the header has that one button; the
// room's Files list shows only while it holds files of its own (Room.roomFiles: an upload that stayed, "Only in this
// conversation"). Only a team room whose group has a folder I can open (Room.groupFolder, decided by the server) has the
// folder button: none in a team room without it, the everyone room, a 1:1 or a group chat, which keep their Files list.
// A phone shows the folder icon alone, with the accessible name. SHOTS_DIR=<folder>: screens for review (1440 and 390,
// light and dark, English and Korean).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { routeRooms, type MockRoomSpec } from './rooms-mock'

test.use({ serviceWorkers: 'block' })

const H = { [CSRF_HEADER]: '1' }
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

async function folders(page: Page) {
  // the group's folder with its meeting notes, in the mock's files
  for (const p of ['groups', 'groups/leads', 'groups/leads/Meeting notes']) {
    const r = await page.request.post('/api/files/mkdir', { headers: H, data: { path: p } })
    expect([200, 201, 409]).toContain(r.status())
  }
}
async function start(page: Page, locale: 'en' | 'ko' = 'en') {
  await reset(page, { teamLocale: locale, usersFollowTeam: true })
  await routeRooms(page, ROOMS)
  await signIn(page)
  await folders(page)
}

test('a group\'s room: 📁 {group} first, which opens its folder, Back returns; no Files list; the other rooms keep theirs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page)
  await page.goto('/rooms')
  await page.goto(`/rooms/${LEADS}`)
  const folder = page.getByTestId('room-group-folder')
  await expect(folder).toBeVisible()
  await expect(folder).toHaveText('leads')
  await expect(folder).toHaveAccessibleName('Open the leads folder')
  await expect(folder).toHaveAttribute('href', '/files?path=groups%2Fleads')
  // one button: its files are in the folder
  await expect(page.getByTestId('room-files-button')).toHaveCount(0)
  // beside the title and the member count, on the header's left (before ✦ and ⋯)
  const title = await page.getByTestId('room-title').boundingBox()
  const box = await folder.boundingBox()
  const side = await page.getByTestId('room-side-chat-button').boundingBox()
  expect(box!.x).toBeGreaterThan(title!.x)
  expect(box!.x + box!.width).toBeLessThan(side!.x)
  await folder.click()
  await expect(page).toHaveURL(/\/files\?path=groups%2Fleads$/)
  await expect(page.getByText('Meeting notes', { exact: true }).first()).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/rooms/${LEADS}$`))
  await expect(page.getByTestId('room-group-folder')).toBeVisible()

  // no folder button: a team room without the folder, the everyone room, a 1:1, a group chat (their Files list all the same)
  for (const id of [NO_FOLDER, ALL, DM, GROUP]) {
    await page.goto(`/rooms/${id}`)
    await expect(page.getByTestId('room-message')).toHaveCount(1)
    await expect(page.getByTestId('room-group-folder')).toHaveCount(0)
    await page.getByTestId('room-files-button').click()
    await expect(page.getByTestId('room-files')).toBeVisible()
    await expect(page.getByTestId('room-files-folder')).toHaveCount(0)
  }
})

// QA TC-3848: an admin changes the folder's rules (or a group that decides it) and the server sends room.updated, built
// for each member (server/src/rooms/service.ts groupFoldersChanged): the button goes and comes back without a reload
test('the folder button follows a live room.updated: gone when the folder closes to me (the Files list then), back when it opens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page)
  await page.goto(`/rooms/${LEADS}`)
  await expect(page.getByTestId('room-group-folder')).toBeVisible()
  const room = ((await page.evaluate(() => fetch('/api/rooms').then((r) => r.json()))) as { items: { id: string; groupFolder?: string }[] }).items.find((r) => r.id === LEADS)!
  const { groupFolder: _, ...closed } = room
  const publish = (r: unknown) => page.request.post('/__test/publish', { data: { event: { type: 'room.updated', data: { roomId: LEADS, change: 'updated', room: r } } } }).then((x) => expect(x.ok()).toBeTruthy())
  const loads = { n: 0 }
  page.on('request', (r) => { const u = new URL(r.url()).pathname; if (u === '/api/rooms' || u === `/api/rooms/${LEADS}`) loads.n++ })
  await publish(closed)
  await expect(page.getByTestId('room-group-folder')).toHaveCount(0)
  await expect(page.getByTestId('room-files-button')).toBeVisible()
  await expect(page.getByTestId('room-message')).toHaveCount(1)
  await publish(room)
  await expect(page.getByTestId('room-group-folder')).toBeVisible()
  await expect(page.getByTestId('room-files-button')).toHaveCount(0)
  // no reload of the page or the list: the event alone did it
  expect(loads.n).toBe(0)
})

// against the mock server's rooms (test/mock/server.ts: a team room with a folder puts uploads in its Chat attachments)
test('an upload lands in {group} › Chat attachments and the header keeps one button; one that stays is "Only in this conversation" and brings the Files list', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await folders(page)
  const id = uuidv7()
  const base = { canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false, createdAt: new Date().toISOString(), activityAt: new Date().toISOString() }
  expect((await page.request.post('/__test/rooms', { data: { rooms: [{ ...base, id, kind: 'team', name: 'leads', groupId: uuidv7(), memberCount: 3, peers: [SORA, MINSU], groupFolder: 'groups/leads' }] } })).ok()).toBeTruthy()
  const send = async (name: string) => {
    const up = await page.request.post(`/api/rooms/${id}/files`, { headers: H, multipart: { file: { name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 leads') } } })
    expect(up.status()).toBe(201)
    const f = (await up.json()) as { id: string }
    expect((await page.request.post(`/api/rooms/${id}/messages`, { headers: H, data: { body: '', clientMessageId: `cm-${uuidv7()}`, mentions: [], fileIds: [f.id] } })).status()).toBe(201)
  }
  await send('agenda.pdf')
  await page.goto(`/rooms/${id}`)
  const chip = page.getByTestId('room-file').filter({ hasText: 'agenda.pdf' })
  await expect(chip.getByTestId('room-file-in-team')).toHaveText('leads › Chat attachments')
  await expect(chip.getByTestId('room-file-room-only')).toHaveCount(0)
  await expect(page.getByTestId('room-group-folder')).toBeVisible()
  await expect(page.getByTestId('room-files-button')).toHaveCount(0)
  // it is in the folder, in Files
  const tree = (await (await page.request.get(`/api/files/tree?path=${encodeURIComponent('groups/leads/Chat attachments')}`, { headers: H })).json()) as { entries: { name: string }[] }
  expect(tree.entries.map((e) => e.name)).toContain('agenda.pdf')

  // the group folder shared wider than the room (the server keeps that upload in the room)
  expect((await page.request.post('/__test/make-project', { data: { stay: ['salaries.pdf'] } })).ok()).toBeTruthy()
  await send('salaries.pdf')
  await page.reload()
  const kept = page.getByTestId('room-file').filter({ hasText: 'salaries.pdf' })
  await expect(kept.getByTestId('room-file-room-only')).toHaveText('Only in this conversation')
  await expect(kept.getByTestId('room-file-in-team')).toHaveCount(0)
  await page.getByTestId('room-files-button').click()
  const rows = page.getByTestId('room-files-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-file-name', 'salaries.pdf')
  await expect(rows.first()).toContainText('Only in this conversation')
})

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
test('the folder icon alone, with its name, in the header; it opens the folder and Back returns', async ({ page }) => {
  await start(page, 'ko')
  await page.goto('/rooms')
  await page.goto(`/rooms/${LEADS}`)
  const folder = page.getByTestId('room-group-folder')
  await expect(folder).toBeVisible()
  await expect(folder).toHaveAccessibleName('leads 폴더 열기')
  await expect(folder.getByText('leads')).toBeHidden()
  const b = (await folder.boundingBox())!
  expect(b.height).toBeGreaterThanOrEqual(44)
  expect(b.x + b.width).toBeLessThanOrEqual(390)
  await expect(page.getByTestId('room-files-button')).toHaveCount(0)
  await folder.tap()
  await expect(page).toHaveURL(/\/files\?path=groups%2Fleads$/)
  await expect(page.getByText('Meeting notes', { exact: true }).first()).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/rooms/${LEADS}$`))
  await expect(page.getByTestId('room-group-folder')).toBeVisible()
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
        await expect(page.getByTestId('room-group-folder')).toBeVisible()
        await page.screenshot({ path: path.join(dir, `${width}-${scheme}-${locale}-leads.png`) })
        await page.mouse.move(0, 0)
        await page.goto(`/rooms/${NO_FOLDER}`)
        await expect(page.getByTestId('room-message')).toHaveCount(1)
        await page.screenshot({ path: path.join(dir, `${width}-${scheme}-${locale}-no-folder.png`) })
      }
    }
  }
})
