// A team project is its own chat room (docs/decisions/20261120-project-is-room.md D5, D3), at 1440 (light) and 390
// (dark), with axe on each screen, against the mock server's project rooms (test/mock/server.ts installProjectRooms):
// - the owner opens Chat room from the project page: the room is made, named after the project, the header's folder
//   button goes back to the project; it is not in the conversations list until its first message; a file sent there is
//   in the project's Chat attachments on the Files page; deleting that message says the file stays there and leaves it;
//   the room's info says whose room it is, with Manage people (the project's members dialog);
// - a read-only person of the project: the clip is off with why, and a text message still goes;
// - the project's AI chat has Chat room in its header.
// What needs the real server (people added or removed on the project come and go live, "File deleted" and restore from
// the trash) is in tests/unit/b-project-room*.test.ts and the browser walk.
// SHOT_DIR: where the screenshots go (none without it).
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'
import { DICTS } from '../../src/i18n'

const t = DICTS.en
const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const NAME = 'Launch site'

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

const VIEWPORTS = [
  { name: '1440', phone: false, scheme: 'light' as const, use: { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' as const } },
  { name: '390', phone: true, scheme: 'dark' as const, use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' as const } },
]

for (const vp of VIEWPORTS) {
  test.describe(`a project's chat room at ${vp.name} (${vp.scheme})`, () => {
    test.use({ ...vp.use, locale: 'en-US', colorScheme: vp.scheme })
    const shot = async (page: Page, name: string) => { if (process.env.SHOT_DIR) await page.screenshot({ path: path.join(process.env.SHOT_DIR, `${vp.name}-${vp.scheme}-${name}.png`) }) }

    /** a team project of the owner's with Bob in it (`bobReads`: Bob may only read it); its id */
    async function start(page: Page, o: { bobReads?: boolean } = {}) {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      if (!o.bobReads) {
        const r = await page.request.post('/api/projects', { headers: H, data: { name: NAME, scope: 'team', participants: [{ subjectType: 'user', subjectId: 'bob' }], instructions: '' } })
        expect(r.status()).toBe(201)
        return ((await r.json()) as { id: string }).id
      }
      const r = await page.request.post('/__test/project', { data: { name: NAME, by: 'olga' } })
      const id = ((await r.json()) as { id: string }).id
      expect((await page.request.post('/__test/project-rules', { data: { folder: `projects/${NAME}`, others: [{ path: `projects/${NAME}`, subjectType: 'user', subjectId: 'bob', access: 'read' }] } })).ok()).toBeTruthy()
      return id
    }
    const openRoom = async (page: Page, id: string) => {
      await page.goto(`/projects/${id}`)
      const open = page.getByTestId('project-room-open')
      await expect(open).toBeVisible()
      await expect(open).toContainText(t['projects.room.open'])
      await open.click()
      await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/)
      await expect(page.getByTestId('room-title')).toHaveText(NAME)
    }

    test('Chat room from the project; the folder button back; listed after the first message; the file is in Chat attachments and stays after the delete', async ({ page }) => {
      const id = await start(page)
      await page.goto(`/projects/${id}`)
      await expect(page.getByTestId('project-room-open')).toBeVisible()
      // no Channel box any more
      await expect(page.getByTestId('project-channel')).toHaveCount(0)
      await audit(page, 'project')
      await shot(page, 'project')
      await openRoom(page, id)
      const roomUrl = page.url()
      // the header: the project's folder (its name on a computer), no Files button
      await expect(page.getByTestId('room-project')).toBeVisible()
      if (!vp.phone) await expect(page.getByTestId('room-project-name')).toHaveText(NAME)
      await expect(page.getByTestId('room-group-files')).toHaveCount(0)
      // a room nobody wrote in yet is reached from the project, not listed
      const listed = async () => {
        const r = await page.request.get('/api/rooms')
        return ((await r.json()) as { items: { id: string; lastMessage: unknown }[] }).items.find((x) => roomUrl.endsWith(x.id))
      }
      expect((await listed())?.lastMessage).toBeNull()
      await audit(page, 'room')
      await shot(page, 'room-empty')
      // the room's info: whose room it is, Manage people (the project's own dialog)
      await page.getByTestId('room-members-button').click()
      await expect(page.getByTestId('room-info-project-line')).toHaveText(t['rooms.project.info'].replace('{name}', NAME))
      await expect(page.getByTestId('room-invite')).toHaveCount(0)
      await expect(page.getByTestId('room-info-manage')).toBeVisible()
      await shot(page, 'room-info')
      await page.getByTestId('room-info-manage').click()
      await expect(page.getByTestId('project-members-dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      // a file from the computer (a computer's clip; a phone sends text here, its sheet is the phone's own)
      if (!vp.phone) {
        await page.getByTestId('room-file-input').setInputFiles({ name: 'brief.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 brief') })
        await expect(page.getByTestId('room-file-chip')).toHaveAttribute('data-status', 'done')
      }
      await page.getByTestId('room-input').fill('Here is the brief')
      await page.getByTestId('room-send').click()
      const msg = page.getByTestId('room-message').filter({ hasText: 'Here is the brief' })
      await expect(msg).toHaveCount(1)
      await expect.poll(async () => !!(await listed())?.lastMessage).toBe(true)
      await shot(page, 'room-message')
      if (!vp.phone) {
        await expect(msg.getByTestId('room-file')).toHaveAttribute('data-file-name', 'brief.pdf')
        // on the Files page, in the project's Chat attachments
        await page.goto(`/files?path=${encodeURIComponent(`projects/${NAME}/Chat attachments`)}`)
        await expect(page.getByTestId('file-row').filter({ hasText: 'brief.pdf' })).toHaveCount(1)
        // and back: the room, the project button, the project page
        await page.goto(roomUrl)
        // delete the message: the file stays in the project's Chat attachments (the confirm says so, a link to it)
        await msg.hover()
        await msg.getByTestId('message-more').click()
        await page.getByTestId('message-delete').click()
        const stays = page.getByTestId('room-delete-file-stays')
        await expect(stays).toContainText(`The file stays in ${NAME} › Chat attachments.`)
        await expect(page.getByTestId('room-delete-file-place')).toHaveAttribute('href', `/files?path=${encodeURIComponent(`projects/${NAME}/Chat attachments`)}`)
        await shot(page, 'delete-confirm')
        await page.getByTestId('dialog-confirm').click()
        await expect(page.getByTestId('room-message').filter({ hasText: t['rooms.deleted'] })).toHaveCount(1)
        await page.goto(`/files?path=${encodeURIComponent(`projects/${NAME}/Chat attachments`)}`)
        await expect(page.getByTestId('file-row').filter({ hasText: 'brief.pdf' })).toHaveCount(1)
        await page.goto(roomUrl)
      }
      await page.getByTestId('room-project').click()
      await expect(page).toHaveURL(new RegExp(`/projects/${id}$`))
    })

    test('a read-only person: the clip is off and says why; text still goes', async ({ page, browser }) => {
      const id = await start(page, { bobReads: true })
      const ctx = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block', colorScheme: vp.scheme, ...vp.use })
      const b = await ctx.newPage()
      try {
        await signIn(b, BOB)
        await openRoom(b, id)
        const off = b.getByTestId('room-attach-off')
        await expect(off).toBeVisible()
        await expect(off).toHaveAttribute('aria-label', t['rooms.project.noAttach'])
        await expect(b.getByTestId('room-attach')).toHaveCount(0)
        // (aria-disabled: Playwright waits for an enabled control; a person can still tap it, and is told why)
        await off.click({ force: true })
        await expect(b.getByText(t['rooms.project.noAttach']).last()).toBeVisible()
        await b.getByTestId('room-input').fill('Read it, thanks')
        await b.getByTestId('room-send').click()
        await expect(b.getByTestId('room-message').filter({ hasText: 'Read it, thanks' })).toHaveCount(1)
        await audit(b, 'room read-only')
        await shot(b, 'room-read-only')
      } finally { await ctx.close() }
    })

    test('the project\'s AI chat: Chat room in its header', async ({ page }) => {
      const id = await start(page)
      const c = await page.request.post('/api/chats', { headers: H, data: { title: 'Plan', projectId: id } })
      expect(c.ok()).toBeTruthy()
      const chat = (await c.json()) as { id: string }
      await page.goto(`/c/${chat.id}`)
      const open = page.getByTestId('chat-project-room')
      await expect(open).toBeVisible()
      await shot(page, 'chat-header')
      await open.click()
      await expect(page).toHaveURL(/\/rooms\/[0-9a-f-]{36}$/)
      await expect(page.getByTestId('room-title')).toHaveText(NAME)
    })
  })
}
