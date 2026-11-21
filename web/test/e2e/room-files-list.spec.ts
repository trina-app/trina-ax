// A room's Files list and ⌘K's recent files (docs/decisions/20261120-project-is-room.md D8), at 1440 (light) and 390
// (dark), with axe on each screen, against the mock server's rooms (test/mock/server.ts listRoomFiles, recentRoomFiles):
// - a group chat: Files in the header opens the list on the room's right (the whole screen on a phone), with each
//   file's name, who sent it, when and its size; a row opens the file viewer; ✕ (‹ on a phone) closes it;
// - a 1:1: no files yet says so in plain words; a file sent then shows when the list opens again;
// - ⌘K before anything is typed: Recent files, a row opening the file viewer.
// What needs the real server (a former member, a later start, hidden answers, guests) is in
// tests/unit/b-rooms-files-list.test.ts and the security cases. SHOT_DIR: where the screenshots go (none without it).
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.en
const H = { [CSRF_HEADER]: '1' }
const GROUP = uuidv7(), DM = uuidv7()
const base = { canRename: false, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const ROOMS = [
  { ...base, id: GROUP, kind: 'group', name: 'Launch crew', groupId: null, memberCount: 3, peers: [{ id: 'bob', name: 'Bob' }, { id: 'erin', name: 'Erin' }], createdAt: ago(600), activityAt: ago(5) },
  { ...base, id: DM, kind: 'dm', name: null, groupId: null, memberCount: 2, peers: [{ id: 'bob', name: 'Bob' }], createdAt: ago(600), activityAt: ago(10) },
]

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

/** a text file sent in a room by the signed-in owner, as the box does it (upload, then the message with it) */
async function sendFile(page: Page, roomId: string, name: string, text: string) {
  const up = await page.request.post(`/api/rooms/${roomId}/files`, { headers: H, multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from(text) } } })
  expect(up.status()).toBe(201)
  const f = (await up.json()) as { id: string }
  const m = await page.request.post(`/api/rooms/${roomId}/messages`, { headers: H, data: { body: '', clientMessageId: `cm-${uuidv7()}`, mentions: [], fileIds: [f.id] } })
  expect(m.status()).toBe(201)
}

const VIEWPORTS = [
  { name: '1440', phone: false, scheme: 'light' as const, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } },
  { name: '390', phone: true, scheme: 'dark' as const, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } },
]

for (const vp of VIEWPORTS) {
  test.describe(`a room's Files list at ${vp.name} (${vp.scheme})`, () => {
    test.use({ ...vp.use, locale: 'en-US', colorScheme: vp.scheme })
    const shot = async (page: Page, name: string) => { if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${vp.name}-${vp.scheme}-${name}.png`) }) }
    const tap = (page: Page, id: string) => (vp.phone ? page.getByTestId(id).tap() : page.getByTestId(id).click())

    test.beforeEach(async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      expect((await page.request.post('/__test/rooms', { data: { rooms: ROOMS } })).ok()).toBeTruthy()
    })

    test('a group chat: Files lists its files, a row opens the preview, and it closes', async ({ page }) => {
      await sendFile(page, GROUP, 'launch-plan.txt', 'Launch plan: week one')
      await sendFile(page, GROUP, 'press-notes.txt', 'Press notes for the launch')
      await page.goto(`/rooms/${GROUP}`)
      const button = page.getByTestId('room-files-button')
      await expect(button).toBeVisible()
      await expect(button).toHaveAccessibleName(t['rooms.files.open'])
      await tap(page, 'room-files-button')
      const panel = page.getByTestId('room-files-panel')
      await expect(panel).toBeVisible()
      const rows = panel.getByTestId('room-files-row')
      await expect(rows).toHaveCount(2)
      // newest first, who sent it, when and the size
      await expect(rows.nth(0)).toHaveAttribute('data-file-name', 'press-notes.txt')
      await expect(rows.nth(1)).toHaveAttribute('data-file-name', 'launch-plan.txt')
      await expect(rows.nth(0).getByTestId('room-files-meta')).toContainText('Olga')
      await expect(rows.nth(0).getByTestId('room-files-meta')).toContainText(/\d+ B/)
      if (vp.phone) {
        // the whole screen: the room under it gives way
        const b = (await panel.boundingBox())!
        expect(b.width).toBeGreaterThanOrEqual(388)
        await expect(page.getByTestId('room')).toBeHidden()
      } else {
        // beside the room, which stays
        await expect(page.getByTestId('room')).toBeVisible()
      }
      // nothing cut off sideways
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
      await audit(page, 'files list')
      await shot(page, 'files-list')
      // a row opens the file viewer with the file
      await rows.nth(0).getByRole('button').first().click()
      const viewer = page.getByTestId('image-viewer')
      await expect(viewer).toBeVisible()
      await expect(viewer).toContainText('press-notes.txt')
      await shot(page, 'files-preview')
      await page.keyboard.press('Escape')
      await expect(viewer).toHaveCount(0)
      // ✕ on a computer, ‹ on a phone
      await tap(page, vp.phone ? 'room-files-back' : 'room-files-close')
      await expect(panel).toHaveCount(0)
      await expect(page.getByTestId('room')).toBeVisible()
    })

    test('a 1:1 with no files yet says so; a file sent shows the next time it opens', async ({ page }) => {
      await page.goto(`/rooms/${DM}`)
      await tap(page, 'room-files-button')
      const panel = page.getByTestId('room-files-panel')
      await expect(panel).toContainText(t['rooms.files.empty'])
      await expect(panel).toContainText(t['rooms.files.emptyHint'])
      await audit(page, 'files empty')
      await shot(page, 'files-empty')
      await tap(page, vp.phone ? 'room-files-back' : 'room-files-close')
      await sendFile(page, DM, 'contract.txt', 'The contract, signed')
      await tap(page, 'room-files-button')
      await expect(panel.getByTestId('room-files-row')).toHaveCount(1)
      await expect(panel.getByTestId('room-files-row')).toHaveAttribute('data-file-name', 'contract.txt')
    })

    test('⌘K before anything is typed: Recent files, a row opens the preview', async ({ page }) => {
      await sendFile(page, DM, 'contract.txt', 'The contract, signed')
      await sendFile(page, GROUP, 'launch-plan.txt', 'Launch plan: week one')
      await page.goto(`/rooms/${GROUP}`)
      await expect(page.getByTestId('room-files-button')).toBeVisible()
      await page.keyboard.press('ControlOrMeta+k')
      const section = page.getByTestId('search-section-recentFiles')
      await expect(section).toBeVisible()
      await expect(section).toContainText(t['search.recentFiles'])
      const rows = section.getByRole('option')
      await expect(rows).toHaveCount(2)
      await expect(rows.nth(0)).toContainText('launch-plan.txt')
      await audit(page, 'search recent files')
      await shot(page, 'search-recent-files')
      await rows.nth(0).click()
      const viewer = page.getByTestId('image-viewer')
      await expect(viewer).toBeVisible()
      await expect(viewer).toContainText('launch-plan.txt')
    })
  })
}
