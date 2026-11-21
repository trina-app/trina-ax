// "Make it a project" (QA TC-6290..TC-6294, TC-6296, TC-6297, TC-6309; docs/decisions/20261121-make-project-from-room.md;
// docs/decisions/20261121-sidebar-projects-group.md), at 1440 (light) and 390 (dark), against the mock server's rooms
// (test/mock/server.ts makeProjectInfo / makeProject: short, the real checks are tests/unit/b-make-project.test.ts):
// - a channel with a PDF and an image: ⋯ › Make it a project, the confirm's lines, Make project; the room stays open
//   with the project's 📁 button, the event line, and the closing line once the files moved; the files are in
//   {name} › Chat attachments in Files, their chips name it, and the room is under Projects in the Chats list;
// - while the files move, the header's quiet "Moving files…"; a file that stays: the confirm says so, its chip says
//   "Only in this conversation", and the room keeps its Files list beside the 📁 button;
// - a 1:1: ⋯ › New project with {name} makes a new project of the two and opens its room; the DM stays.
// SHOTS_DIR: where the screenshots go (none without it).
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, uuidv7 } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const base = { canRename: true, managerId: null, unreadCount: 0, threadsUnread: 0, nextThreadId: null, mentioned: false, lastReadSeq: 0, lastSeq: 0, lastMessage: null, muted: false }
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const BOB = { id: 'bob', name: 'Bob' }, ERIN = { id: 'erin', name: 'Erin' }
// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function sendFile(page: Page, roomId: string, name: string, mimeType: string, buffer: Buffer) {
  const up = await page.request.post(`/api/rooms/${roomId}/files`, { headers: H, multipart: { file: { name, mimeType, buffer } } })
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
  test.describe(`Make it a project at ${vp.name} (${vp.scheme})`, () => {
    test.use({ ...vp.use, locale: 'en-US', colorScheme: vp.scheme })
    const shot = async (page: Page, name: string) => { if (process.env.SHOTS_DIR) await page.screenshot({ path: path.join(process.env.SHOTS_DIR, `${vp.name}-${vp.scheme}-en-${name}.png`) }) }
    const tap = (page: Page, id: string) => (vp.phone ? page.getByTestId(id).tap() : page.getByTestId(id).click())
    let CHANNEL = '', DM = ''

    test.beforeEach(async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      CHANNEL = uuidv7()
      DM = uuidv7()
      const rooms = [
        { ...base, id: CHANNEL, kind: 'group', name: 'Launch crew', groupId: null, memberCount: 3, peers: [BOB, ERIN], createdAt: ago(600), activityAt: ago(5) },
        { ...base, id: DM, kind: 'dm', name: null, canRename: false, groupId: null, memberCount: 2, peers: [BOB], createdAt: ago(600), activityAt: ago(10) },
      ]
      expect((await page.request.post('/__test/rooms', { data: { rooms } })).ok()).toBeTruthy()
    })

    test('a channel with a PDF and an image: the confirm, then the 📁 button, the event lines, the files in Chat attachments, the Projects group', async ({ page }) => {
      await sendFile(page, CHANNEL, 'launch-plan.pdf', 'application/pdf', Buffer.from('%PDF-1.4 launch plan'))
      await sendFile(page, CHANNEL, 'poster.png', 'image/png', PNG)
      await page.goto(`/rooms/${CHANNEL}`)
      await expect(page.getByTestId('room-file')).toHaveCount(2)
      await tap(page, 'room-menu')
      await tap(page, 'room-menu-make-project')
      const dialog = page.getByRole('dialog')
      await expect(dialog).toContainText('Make it a project')
      await expect(page.getByTestId('make-project-name')).toHaveValue('Launch crew')
      await expect(page.getByTestId('make-project-body')).toHaveText("Its 3 members become the project's people. Files sent here move to Launch crew › Chat attachments. People added later see messages from now on.")
      await expect(page.getByTestId('make-project-later')).toHaveText('People added to the project later can open these files.')
      await expect(page.getByTestId('make-project-staying')).toHaveCount(0)
      await shot(page, 'make-project-confirm')
      await tap(page, 'make-project-confirm')
      await expect(dialog).toHaveCount(0)
      // the room stays open, now the project's
      await expect(page).toHaveURL(new RegExp(`/rooms/${CHANNEL}$`))
      await expect(page.getByTestId('room-project')).toBeVisible()
      await expect(page.getByTestId('room-files-button')).toHaveCount(0)
      const events = page.getByTestId('room-event')
      await expect(events.filter({ hasText: 'made this conversation the project Launch crew.' })).toHaveCount(1)
      await expect(events.filter({ hasText: '2 files moved to Launch crew › Chat attachments.' })).toHaveCount(1)
      await expect(events.filter({ hasText: 'stayed in this conversation' })).toHaveCount(0)
      // the name in the line opens the project
      await expect(events.getByTestId('room-event-project')).toHaveAttribute('href', /\/projects\//)
      await page.reload()
      await expect(page.getByTestId('room-file').filter({ hasText: 'launch-plan.pdf' }).getByTestId('room-file-in-team')).toBeVisible()
      await shot(page, 'make-project-after')
      // in Files
      const tree = (await (await page.request.get(`/api/files/tree?path=${encodeURIComponent('projects/Launch crew/Chat attachments')}`, { headers: H })).json()) as { entries: { name: string }[] }
      expect(tree.entries.map((e) => e.name).sort()).toEqual(['launch-plan.pdf', 'poster.png'])
      // the Chats list: under Projects, between Channels and Direct messages
      if (!vp.phone) {
        await page.getByTestId('rail-chats').click()
        const panel = page.getByTestId('chats-panel')
        await expect.poll(() => panel.locator('[data-testid="chats-panel-section"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))).toEqual(['team', 'project', 'dm'])
        await expect(panel.locator('[data-testid="chats-panel-section"][data-section="project"]').getByTestId('sidebar-room-row')).toHaveText(['Launch crew'])
        await shot(page, 'projects-group')
      } else {
        await page.goto('/rooms')
        await expect.poll(() => page.getByTestId('rooms-page').locator('[data-testid="rooms-section"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-section')))).toEqual(['team', 'project', 'dm'])
        await shot(page, 'projects-group')
      }
    })

    test('while the files move: "Moving files…"; one that stays: said in the confirm, "Only in this conversation", and the Files list stays', async ({ page }) => {
      await sendFile(page, CHANNEL, 'launch-plan.pdf', 'application/pdf', Buffer.from('%PDF-1.4 launch plan'))
      await sendFile(page, CHANNEL, 'before-erin.pdf', 'application/pdf', Buffer.from('%PDF-1.4 older'))
      expect((await page.request.post('/__test/make-project', { data: { stay: ['before-erin.pdf'], hold: true } })).ok()).toBeTruthy()
      await page.goto(`/rooms/${CHANNEL}`)
      await tap(page, 'room-menu')
      await tap(page, 'room-menu-make-project')
      await expect(page.getByTestId('make-project-staying')).toHaveText('1 file stays in the conversation only, because not everyone here can see it.')
      await tap(page, 'make-project-confirm')
      await expect(page.getByTestId('room-files-moving')).toHaveText(' · Moving files…')
      await shot(page, 'moving-files')
      expect((await page.request.post('/__test/make-project', { data: { release: true } })).ok()).toBeTruthy()
      await expect(page.getByTestId('room-files-moving')).toHaveCount(0)
      await expect(page.getByTestId('room-event').filter({ hasText: '1 file moved to Launch crew › Chat attachments. 1 stayed in this conversation.' })).toHaveCount(1)
      await page.reload()
      await expect(page.getByTestId('room-file').filter({ hasText: 'before-erin.pdf' }).getByTestId(vp.phone ? 'room-file-open' : 'room-file-room-only')).toContainText(vp.phone ? 'before-erin.pdf' : 'Only in this conversation')
      // the 📁 button first, then Files: the list shows only the file that stayed
      await expect(page.getByTestId('room-project')).toBeVisible()
      await tap(page, 'room-files-button')
      const rows = page.getByTestId('room-files-row')
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText('Only in this conversation')
      await shot(page, 'room-only-files')
    })

    test('the people changed while the confirm was open: "The people changed" and the new count', async ({ page }) => {
      await page.goto(`/rooms/${CHANNEL}`)
      await tap(page, 'room-menu')
      await tap(page, 'room-menu-make-project')
      await expect(page.getByTestId('make-project-body')).toContainText('Its 3 members')
      // someone added meanwhile (the room's peers on the server)
      const rooms = (await (await page.request.get('/api/rooms', { headers: H })).json()) as { items: { id: string }[] }
      const now = rooms.items.map((r) => (r.id === CHANNEL ? { ...r, peers: [BOB, ERIN, { id: 'dave', name: 'Dave' }], memberCount: 4 } : r))
      expect((await page.request.post('/__test/rooms', { data: { rooms: now } })).ok()).toBeTruthy()
      await tap(page, 'make-project-confirm')
      await expect(page.getByTestId('make-project-changed')).toHaveText('The people changed')
      await expect(page.getByTestId('make-project-body')).toContainText('Its 4 members')
      await tap(page, 'make-project-confirm')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByTestId('room-project')).toBeVisible()
    })

    test('a 1:1: New project with Bob makes a project of the two and opens its room; the DM stays', async ({ page }) => {
      await page.goto(`/rooms/${DM}`)
      await tap(page, 'room-menu')
      await expect(page.getByTestId('room-menu-make-project')).toHaveCount(0)
      await tap(page, 'room-menu-dm-project')
      await expect(page.getByRole('dialog')).toContainText('New project with Bob')
      await expect(page.getByTestId('make-project-name')).toHaveValue('Bob')
      await expect(page.getByTestId('make-project-body')).toHaveText("You and Bob become the project's people. It gets its own chat room.")
      await page.getByTestId('make-project-name').fill('Bob and me')
      await shot(page, 'dm-project-confirm')
      await tap(page, 'make-project-confirm')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page).not.toHaveURL(new RegExp(`/rooms/${DM}$`))
      await expect(page.getByTestId('room-title')).toHaveText('Bob and me')
      await expect(page.getByTestId('room-project')).toBeVisible()
      // the DM is where it was
      await page.goto(`/rooms/${DM}`)
      await expect(page.getByTestId('room-title')).toHaveText('Bob')
    })
  })
}
