// A private channel linked to a team project (docs/decisions/20261119-channel-project-link.md; QA rows of the plan
// docs/AGENTS/plan/20261119-channel-project-link.md): link from the channel's info and from the project page, create a
// channel from the project, the header's Files button opens the project folder and Back returns to the same channel,
// Save to project in one click for a PDF, a .sh opens the sheet with the project picked, a member who cannot open the
// project sees only the neutral line, and a live room.updated takes the button away. The room and project routes are
// answered through page.route as the team server sends them (the server's checks: tests/unit/b-rooms-project-link*.ts).
// SHOTS_DIR=<folder>: the screens (1440 and 390, light and dark).
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { reportBrowserAnswers } from './coverage-report'

test.use({ serviceWorkers: 'block' })

const id = (n: number) => `019a5f00-0000-7000-8000-${String(n).padStart(12, '0')}`
const ROOM = id(9101), OTHER = id(9102), MADE = id(9103), PROJECT = id(9201)
const SORA = { id: 'sora', name: 'Sora Kim' }
const OLGA = { id: 'olga', name: 'Olga' }
const FOLDER = 'projects/Launch site'
const PDF = { id: id(9301), name: 'quote-v2.pdf', size: 1_200_000, mime: 'application/pdf', kind: 'pdf', thumb: false }
const SH = { id: id(9302), name: 'deploy.sh', size: 420, mime: 'text/x-sh', kind: 'text', thumb: false }
const T0 = Date.parse('2026-11-19T09:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

type State = { room: Record<string, unknown>; other: Record<string, unknown>; project: Record<string, unknown>; events: Record<string, unknown>[]; saves: unknown[]; created: unknown[] }

/** Everything this spec's rooms and project need, as the server answers it. `linked`: start linked; `outsider`: I am in
 * the channel but cannot open the project (no Room.project; the neutral line). */
async function start(page: Page, o: { linked?: boolean } = {}): Promise<State> {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  reportBrowserAnswers(page)
  const linkOf = () => ({ id: PROJECT, name: 'Launch site', folderPath: FOLDER, canSave: true })
  const s: State = {
    room: {
      id: ROOM, kind: 'group', name: 'Launch', canRename: true, managerId: 'olga', groupId: null, memberCount: 2, peers: [SORA], lastSeq: 3, unreadCount: 0, threadsUnread: 0,
      nextThreadId: null, mentioned: false, lastReadSeq: 3, lastMessage: null, muted: false, notify: { own: null, byDefault: 'all', level: 'all' }, createdAt: at(-60), activityAt: at(3),
      ...(o.linked ? { project: linkOf() } : { canLinkProject: true }),
    },
    other: {
      id: OTHER, kind: 'group', name: 'Ops', canRename: true, managerId: 'sora', groupId: null, memberCount: 2, peers: [SORA], lastSeq: 2, unreadCount: 0, threadsUnread: 0,
      nextThreadId: null, mentioned: false, lastReadSeq: 2, lastMessage: null, muted: false, notify: { own: null, byDefault: 'all', level: 'all' }, createdAt: at(-90), activityAt: at(1),
    },
    project: {
      id: PROJECT, name: 'Launch site', folderPath: FOLDER, instructions: 'Short answers.', createdBy: OLGA, createdAt: at(-120), canEdit: true, canManage: true, audience: 8, shareChats: true,
      ...(o.linked ? { channel: { roomId: ROOM, name: 'Launch', memberCount: 2, inIt: true, canUnlink: true } } : { canLinkChannel: true }),
    },
    events: [], saves: [], created: [],
  }
  const msg = (n: number, files: unknown[], body: string) => ({ id: id(9400 + n), roomId: ROOM, seq: n, authorKind: 'user', author: SORA, askedBy: null, visibility: 'room', body, replyTo: null, mentions: [], files, createdAt: at(n), editedAt: null, deletedAt: null })
  const roomMessages = () => [msg(1, [PDF], 'The quote'), msg(2, [SH], 'The script'), ...s.events]
  const otherMessages = [{ id: id(9500), roomId: OTHER, seq: 1, authorKind: 'user', author: SORA, askedBy: null, visibility: 'room', body: '', replyTo: null, mentions: [], files: [], createdAt: at(0), editedAt: null, deletedAt: null, event: { type: 'project_linked', project: null } }]
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const event = (type: 'project_linked' | 'project_unlinked') => s.events.push({ id: id(9600 + s.events.length), roomId: ROOM, seq: 10 + s.events.length, authorKind: 'user', author: OLGA, askedBy: null, visibility: 'room', body: '', replyTo: null, mentions: [], files: [], createdAt: at(10), editedAt: null, deletedAt: null, event: { type, project: { id: PROJECT, name: 'Launch site' } } })
  const link = () => {
    delete s.room.canLinkProject
    s.room.project = linkOf()
    delete s.project.canLinkChannel
    s.project.channel = { roomId: ROOM, name: 'Launch', memberCount: 2, inIt: true, canUnlink: true }
    event('project_linked')
  }
  if (o.linked) event('project_linked')
  await page.route(/\/api\/rooms(\/|\?|$)/, async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const m = req.method()
    const rooms = () => [s.room, s.other, ...(s.created as Record<string, unknown>[])]
    if (m === 'GET' && p === '/api/rooms') return route.fulfill(json({ items: rooms() }))
    const r = /^\/api\/rooms\/([^/]+)(?:\/(.+))?$/.exec(p)
    const room = r && rooms().find((x) => x.id === r[1])
    if (!r || !room) return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
    const what = r[2]
    if (m === 'GET' && !what) return route.fulfill(json(room))
    if (m === 'GET' && what === 'messages') return route.fulfill(json({ items: room.id === ROOM ? roomMessages() : room.id === OTHER ? otherMessages : [], nextCursor: null }))
    if (m === 'GET' && what === 'members') return route.fulfill(json({ items: [OLGA, SORA].map((user) => ({ user, joinedAt: at(-60) })) }))
    if (m === 'GET' && what === 'saved-files') return route.fulfill(json({ items: [] }))
    if (m === 'GET' && what === 'ai') return route.fulfill(json({ answering: 0, mine: [] }))
    if (m === 'POST' && what === 'read') return route.fulfill(json({ lastReadSeq: 3, unreadCount: 0, mentioned: false }))
    if (m === 'PUT' && what === 'project') { link(); return route.fulfill(json(s.room)) }
    if (m === 'DELETE' && what === 'project') { delete s.room.project; s.room.canLinkProject = true; delete s.project.channel; s.project.canLinkChannel = true; event('project_unlinked'); return route.fulfill({ status: 204, body: '' }) }
    if (m === 'POST' && what === 'save-plan') {
      const b = req.postDataJSON() as { fileIds: string[]; folder?: string }
      const files = b.fileIds.map((f) => [PDF, SH].find((x) => x.id === f)!).map((f) => ({ id: f.id, name: f.name, size: f.size }))
      return route.fulfill(json({ files, suggestion: null, sensitive: false, ...(b.folder ? { folder: { path: b.folder, outside: 3 } } : {}) }))
    }
    if (m === 'POST' && what === 'save-to-team') {
      const b = req.postDataJSON() as { fileIds: string[]; folder: string; oneClick?: boolean }
      s.saves.push(b)
      return route.fulfill(json({ saved: b.fileIds.map((f) => ({ fileId: f, path: `${b.folder}/${[PDF, SH].find((x) => x.id === f)!.name}`, existed: false })) }))
    }
    return route.fulfill(json({ error: { code: 'not_found', message: 'not in this mock' } }, 404))
  })
  await page.route(/\/api\/projects(\/|\?|$)/, async (route) => {
    const req = route.request()
    const p = new URL(req.url()).pathname
    const m = req.method()
    if (m === 'GET' && p === '/api/projects') return route.fulfill(json({ items: [s.project] }))
    if (m === 'GET' && p === `/api/projects/${PROJECT}`) return route.fulfill(json(s.project))
    if (m === 'GET' && p === `/api/projects/${PROJECT}/people`) {
      // the project's people as the team directory has them (the picker ticks only people it lists)
      const dir = await (await page.request.get('/api/people')).json() as { people: { id: string; name: string }[] }
      return route.fulfill(json({ people: [{ ...OLGA, creator: true }, ...dir.people.filter((x) => x.id !== 'olga' && x.name !== 'Olga').slice(0, 1)] }))
    }
    if (m === 'POST' && p === `/api/projects/${PROJECT}/channel`) {
      const b = req.postDataJSON() as { name: string; userIds: string[] }
      const made = { ...s.room, id: MADE, name: b.name, memberCount: b.userIds.length + 1, project: linkOf() }
      delete (made as Record<string, unknown>).canLinkProject
      s.created.push(made)
      delete s.project.canLinkChannel
      s.project.channel = { roomId: MADE, name: b.name, memberCount: b.userIds.length + 1, inIt: true, canUnlink: true }
      return route.fulfill(json(made, 201))
    }
    return route.fallback()
  })
  await signIn(page)
  for (const f of ['projects', FOLDER, `${FOLDER}/Specs`]) {
    const r = await page.request.post('/api/files/mkdir', { headers: { [CSRF_HEADER]: '1' }, data: { path: f } })
    expect([200, 201, 409]).toContain(r.status())
  }
  return s
}

test('link from the channel info: the Files button opens the project folder, Back returns to the same channel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page)
  await page.goto(`/rooms/${ROOM}`)
  await expect(page.getByTestId('room-project-files')).toHaveCount(0)
  await page.getByTestId('room-members-button').click()
  await expect(page.getByTestId('room-info-project-none')).toHaveText('Not linked')
  await page.getByTestId('room-info-project-link').click()
  await page.getByTestId('link-project-row').click()
  // the confirm says who sees what
  await expect(page.getByRole('dialog').getByText('The project\'s 8 members will see this channel\'s name on the project page.')).toBeVisible()
  await page.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(page.getByTestId('room-info-project-name')).toContainText('Launch site')
  await page.keyboard.press('Escape')
  const files = page.getByTestId('room-project-files')
  await expect(files).toBeVisible()
  await expect(files).toHaveAttribute('href', `/files?path=${encodeURIComponent(FOLDER)}`)
  await files.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Open the Launch site project folder')
  await files.click()
  await expect(page).toHaveURL(/\/files\?path=projects%2FLaunch%20site$/)
  await expect(page.getByText('Specs', { exact: true }).first()).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}$`))
  await expect(page.getByTestId('room-project-files')).toBeVisible()
})

test('Save to project: a PDF in one click to the project root; a .sh opens the sheet with the project picked', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const s = await start(page, { linked: true })
  await page.goto(`/rooms/${ROOM}`)
  // the named line for me, who can open the project
  await expect(page.getByTestId('room-event-project')).toHaveText('Launch site')
  const pdf = page.locator(`[data-testid="room-file"][data-file-name="${PDF.name}"]`)
  await pdf.hover()
  const save = pdf.getByTestId('room-file-save')
  await save.hover()
  await expect(page.getByRole('tooltip')).toHaveText('Save to Launch site')
  await save.click()
  const toast = page.getByTestId('toast').last()
  await expect(toast).toContainText('Saved to Launch site')
  await expect(toast).toContainText('3 people outside this channel can open it.')
  await expect(toast.getByTestId('toast-more')).toHaveText('Open')
  await expect(toast.getByTestId('toast-link')).toHaveText('Undo')
  expect(s.saves).toEqual([{ fileIds: [PDF.id], folder: FOLDER, oneClick: true }])
  await expect(pdf.getByTestId('room-file-in-team')).toHaveAccessibleName('In project · Launch site')

  const sh = page.locator(`[data-testid="room-file"][data-file-name="${SH.name}"]`)
  await sh.hover()
  await sh.getByTestId('room-file-save').click()
  await expect(page.getByTestId('room-save-sheet')).toBeVisible()
  await expect(page.getByTestId('room-save-place')).toContainText('Launch site')
  expect(s.saves).toHaveLength(1)
})

test('link from the project page, then a live room.updated without the link takes the Files button away', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const s = await start(page)
  await page.goto(`/projects/${PROJECT}`)
  await expect(page.getByTestId('project-channel-empty')).toHaveText('Talk about this project with its people.')
  await page.getByTestId('project-channel-link').click()
  await page.getByTestId('link-channel-row').first().click()
  await page.getByRole('button', { name: 'Link', exact: true }).click()
  await expect(page.getByTestId('project-channel-name')).toContainText('Launch')
  await page.getByTestId('project-channel-open').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${ROOM}$`))
  await expect(page.getByTestId('room-project-files')).toBeVisible()
  // the project closes to me elsewhere: the server sends the room without it
  const { project: _, ...closed } = s.room
  const r = await page.request.post('/__test/publish', { data: { event: { type: 'room.updated', data: { roomId: ROOM, change: 'updated', room: closed } } } })
  expect(r.ok()).toBeTruthy()
  await expect(page.getByTestId('room-project-files')).toHaveCount(0)
})

test('create a channel from the project: the project people ticked, linked, it opens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page)
  await page.goto(`/projects/${PROJECT}`)
  await page.getByTestId('project-channel-create').click()
  await expect(page.getByRole('dialog')).toContainText('Create a channel for Launch site')
  await expect(page.getByTestId('picker-name')).toHaveValue('Launch site')
  await expect(page.getByTestId('picker-project-note')).toContainText('Its Files open this project\'s folder.')
  await expect(page.getByTestId('picker-count')).toHaveText('1 selected')
  await page.getByTestId('picker-go').click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${MADE}$`))
  await expect(page.getByTestId('room-project-files')).toBeVisible()
})

test('a member who cannot open the project: only the neutral line, no button, no project row', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await start(page)
  await page.goto(`/rooms/${OTHER}`)
  await expect(page.getByTestId('room-event')).toHaveText('Sora Kim linked this channel to a project')
  await expect(page.getByTestId('room-event-project')).toHaveCount(0)
  await expect(page.getByTestId('room-project-files')).toHaveCount(0)
  await page.getByTestId('room-members-button').click()
  await expect(page.getByTestId('room-info')).toBeVisible()
  await expect(page.getByTestId('room-info-project')).toHaveCount(0)
})

test.describe('a phone, dark', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' })
  test('the folder icon in the header, the project page Channel row, Save to <project> first in the long-press menu', async ({ page }) => {
    await start(page, { linked: true })
    await page.goto(`/rooms/${ROOM}`)
    const files = page.getByTestId('room-project-files')
    await expect(files).toBeVisible()
    const b = (await files.boundingBox())!
    expect(b.height).toBeGreaterThanOrEqual(44)
    expect(b.x + b.width).toBeLessThanOrEqual(390)
    const pdf = page.locator(`[data-testid="room-file"][data-file-name="${PDF.name}"]`)
    await pdf.getByTestId('room-file-open').dispatchEvent('contextmenu', { button: 2 })
    const items = page.getByRole('menuitem')
    await expect(page.getByTestId('file-menu-save-project')).toHaveText('Save to Launch site')
    await expect(page.getByTestId('file-menu-save-team')).toHaveText('Save to another folder…')
    const order = await items.allTextContents()
    expect(order.indexOf('Save to Launch site')).toBeLessThan(order.indexOf('Save to another folder…'))
    await page.keyboard.press('Escape')
    await page.goto(`/projects/${PROJECT}`)
    const row = page.getByTestId('project-channel-name')
    await expect(row).toBeVisible()
    expect((await row.boundingBox())!.x + (await row.boundingBox())!.width).toBeLessThanOrEqual(390)
    // one line at 390: the whole Channel row is one row's height
    expect((await page.getByTestId('project-channel').boundingBox())!.height).toBeLessThan(60)
  })
})

test('screenshots for review (SHOTS_DIR): 1440 and 390, light and dark', async ({ page }) => {
  test.skip(!process.env.SHOTS_DIR, 'SHOTS_DIR not set')
  test.setTimeout(240_000)
  const dir = process.env.SHOTS_DIR!
  fs.mkdirSync(dir, { recursive: true })
  for (const width of [1440, 390]) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: width > 400 ? 900 : 844 })
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      const shot = (name: string) => page.screenshot({ path: path.join(dir, `e2e-${width}-${scheme}-${name}.png`) })
      await start(page)
      await page.goto(`/projects/${PROJECT}`)
      await expect(page.getByTestId('project-channel-create')).toBeVisible()
      await shot('project-no-channel')
      await page.getByTestId('project-channel-create').click()
      await expect(page.getByTestId('picker-project-note')).toBeVisible()
      await shot('create-channel')
      await page.keyboard.press('Escape')
      await page.getByTestId('project-channel-link').click()
      await expect(page.getByTestId('link-channel-picker')).toBeVisible()
      await shot('link-channel-picker')
      await page.keyboard.press('Escape')
      await page.goto(`/rooms/${ROOM}`)
      await page.getByTestId('room-members-button').click()
      await expect(page.getByTestId('room-info-project')).toBeVisible()
      await shot('info-not-linked')
      await page.getByTestId('room-info-project-link').click()
      await expect(page.getByTestId('link-project-picker')).toBeVisible()
      await shot('link-project-picker')
      await page.getByTestId('link-project-row').click()
      await shot('link-confirm')
      await page.getByRole('button', { name: 'Link', exact: true }).click()
      await expect(page.getByTestId('room-info-project-name')).toBeVisible()
      await shot('info-linked')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('room-project-files')).toBeVisible()
      await shot('room-linked')
      await page.goto(`/projects/${PROJECT}`)
      await expect(page.getByTestId('project-channel-name')).toBeVisible()
      await shot('project-linked')
      await page.goto(`/rooms/${OTHER}`)
      await expect(page.getByTestId('room-event')).toBeVisible()
      await shot('room-neutral-line')
    }
  }
})
