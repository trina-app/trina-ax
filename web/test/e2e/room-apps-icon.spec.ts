// An Other app's icon (docs/decisions/20261116-other-app-icon.md, QA TC-3544 / TC-3545), 1440 and 390 wide: without an
// icon each Other app shows its name's first letter on its own tint (presets keep their logos); its settings' one
// "Change icon" menu uploads an image (cut to a square in the browser), picks an emoji, or removes it; the room's
// messages follow at once. Who sees the action: the people who manage the room's apps (a team room's owner and admins,
// any member of a group chat), never a member of a team room; a refusal from the server leaves the icon as it was.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'
import { appMessage, mockApp, mockPreset, routeRoomApps, type MockApp } from './room-apps-mock'

test.use({ serviceWorkers: 'block', locale: 'en-US' })

const SIZES = [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }] as const
const MINA = { id: 'mina', name: 'Mina' }
const JUN = { id: 'jun', name: 'Jun' }
const ALERT = mockApp('other', { id: '019a5f00-0000-7000-8000-0000000a0001', name: 'Dr Alaseo Alert' })
const DEPLOY = mockApp('other', { id: '019a5f00-0000-7000-8000-0000000a0002', name: 'deploy bot' })
const NOTION = mockPreset('notion')
/** a 120 × 80 orange PNG: not a square, so the browser cuts it before it is sent */
const WIDE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAg0lEQVR42u3QMQ0AAAgDsAlAIP5PVOCCcDSpgma6OBAFokUjWrRoC6JFI1q0aAuiRSNatGhEi0a0aNGIFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNGIFi0a0aIRLVo0okUjWrRoRItGtGjRiBaNaNGiES0a0aJFI1o0okWLRrRoRP+x/Pbv0VElslcAAAAASUVORK5CYII=', 'base64')

const messages = (apps: MockApp[]): MockMessage[] => [
  { id: '019a5f00-0000-7000-8000-00000000d000', author: MINA, body: 'Morning!' },
  ...apps.map((a, i) => ({ id: `019a5f00-0000-7000-8000-00000000d${String(i + 1).padStart(3, '0')}`, author: MINA, body: '', extra: appMessage(a, { title: `${a.name} says hello` }) })),
]

async function open(page: Page, o: { size: { width: number; height: number }; kind?: 'team' | 'group'; apps: MockApp[]; role?: 'owner' | 'admin' | 'member' }) {
  await page.setViewportSize(o.size)
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await routeRoom(page, { kind: o.kind ?? 'team', members: [MINA, JUN], messages: messages(o.apps), room: { name: 'ops' } })
  const apps = await routeRoomApps(page, { apps: o.apps.map((a) => ({ ...a })) })
  if (o.role && o.role !== 'owner') {
    await page.route(/\/api\/me$/, async (route) => {
      const r = await route.fetch()
      const me = await r.json() as { user: { role: string } }
      if (me?.user) me.user.role = o.role!
      await route.fulfill({ response: r, json: me })
    })
  }
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-messages')).toBeVisible()
  return apps
}

/** The tile on the timeline in front of an app's message (the run's face). */
const faceOf = (page: Page, name: string) => page.getByTestId('room-run').filter({ hasText: `${name} says hello` }).first().getByTestId('app-tile').first()

async function settingsOf(page: Page, name: string) {
  await page.getByTestId('app-sender-button').filter({ hasText: name }).first().click()
  await page.getByTestId('app-sender-manage').click()
  await expect(page.getByTestId('apps-settings')).toBeVisible()
}

for (const vp of SIZES) {
  test.describe(`an Other app's icon (${vp.name})`, () => {
    test('each Other app shows its first letter on its own tint; a preset keeps its logo', async ({ page }) => {
      await open(page, { size: vp.size, apps: [ALERT, DEPLOY, NOTION] })
      const a = faceOf(page, 'Dr Alaseo Alert'), d = faceOf(page, 'deploy bot'), n = faceOf(page, 'Notion')
      await expect(a).toHaveAttribute('data-icon', 'letter')
      await expect(a.getByTestId('app-letter')).toHaveText('D')
      await expect(d.getByTestId('app-letter')).toHaveText('D')
      // the same letter, told apart by the tint (stable per app id)
      const bg = (l: typeof a) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(await bg(a)).not.toBe(await bg(d))
      await expect(n.getByTestId('app-logo')).toBeVisible()
      await expect(n).not.toHaveAttribute('data-icon', /./)
      // the plain blocks icon is gone from the timeline
      await expect(page.getByTestId('room-messages').locator('[data-testid="app-tile"] svg')).toHaveCount(0)
    })

    test('Change icon: an emoji, then an image cut to a square, then Remove icon; the timeline follows', async ({ page }) => {
      const apps = await open(page, { size: vp.size, apps: [ALERT, DEPLOY] })
      await settingsOf(page, 'Dr Alaseo Alert')
      const field = page.getByTestId('apps-icon')
      await expect(field.getByTestId('app-tile')).toHaveAttribute('data-icon', 'letter')
      await page.getByTestId('apps-icon-change').click()
      await expect(page.getByTestId('apps-icon-upload')).toHaveText('Upload an image')
      await expect(page.getByTestId('apps-icon-emoji')).toHaveText('Pick an emoji')
      // nothing to remove yet
      await expect(page.getByTestId('apps-icon-remove')).toHaveCount(0)

      await page.getByTestId('apps-icon-emoji').click()
      const picker = page.getByTestId('emoji-picker')
      await expect(picker).toBeVisible()
      await picker.getByTestId('emoji-search').fill('police car light')
      await picker.locator('[data-emoji="🚨"]').first().click()
      await expect(field.getByTestId('app-emoji')).toHaveText('🚨')
      expect(apps.calls).toContain(`emoji:${ALERT.id}:🚨`)

      // the image: the file chooser, cut to a square in the browser (sent as WebP or JPEG, never the original PNG)
      await page.getByTestId('apps-icon-change').click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('apps-icon-upload').click()
      await (await chooser).setFiles({ name: 'alert.png', mimeType: 'image/png', buffer: WIDE_PNG })
      await expect(field.getByTestId('app-tile')).toHaveAttribute('data-icon', 'image')
      expect(apps.calls.at(-1)).toMatch(new RegExp(`^icon:${ALERT.id}:image/(webp|jpeg):bytes$`))
      // the room behind the dialog shows it on the app's messages already, and only on that app's
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('apps-dialog')).toHaveCount(0)
      await expect(faceOf(page, 'Dr Alaseo Alert')).toHaveAttribute('data-icon', 'image')
      await expect(faceOf(page, 'deploy bot')).toHaveAttribute('data-icon', 'letter')

      // Remove icon: the letter again
      await settingsOf(page, 'Dr Alaseo Alert')
      await page.getByTestId('apps-icon-change').click()
      await expect(page.getByTestId('apps-icon-remove')).toHaveText('Remove icon')
      await page.getByTestId('apps-icon-remove').click()
      await expect(page.getByTestId('apps-icon').getByTestId('app-tile')).toHaveAttribute('data-icon', 'letter')
      expect(apps.calls.at(-1)).toBe(`icon-remove:${ALERT.id}`)
    })

    test('a file that is no picture is refused in the browser; a refusal from the server keeps the icon', async ({ page }) => {
      const apps = await open(page, { size: vp.size, apps: [ALERT] })
      await settingsOf(page, 'Dr Alaseo Alert')
      await page.getByTestId('apps-icon-change').click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('apps-icon-upload').click()
      await (await chooser).setFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') })
      await expect(page.getByText("This file can't be used as an icon. Choose a PNG, JPEG or WebP image.")).toBeVisible()
      expect(apps.calls.filter((c) => c.startsWith('icon'))).toEqual([])
      // the person's right was taken away meanwhile: the server's words, nothing changed
      apps.refuseIconNext = 403
      await page.getByTestId('apps-icon-change').click()
      await page.getByTestId('apps-icon-emoji').click()
      await page.getByTestId('emoji-picker').locator('[data-emoji]').first().click()
      await expect(page.getByText('You no longer manage the apps here.')).toBeVisible()
      await expect(page.getByTestId('apps-icon').getByTestId('app-tile')).toHaveAttribute('data-icon', 'letter')
    })

    test('a team room\'s admin sees Change icon on an Other app, never on a preset', async ({ page }) => {
      await open(page, { size: vp.size, apps: [ALERT, NOTION], role: 'admin' })
      await settingsOf(page, 'Dr Alaseo Alert')
      await expect(page.getByTestId('apps-icon-change')).toBeVisible()
      await page.keyboard.press('Escape')
      await settingsOf(page, 'Notion')
      await expect(page.getByTestId('apps-settings')).toHaveAttribute('data-kind', 'notion')
      await expect(page.getByTestId('apps-icon')).toHaveCount(0)
    })

    test('a member of a team room gets no Manage, so no Change icon', async ({ page }) => {
      await open(page, { size: vp.size, apps: [ALERT], role: 'member' })
      await page.getByTestId('app-sender-button').first().click()
      await expect(page.getByTestId('app-sender-ask')).toBeVisible()
      await expect(page.getByTestId('app-sender-manage')).toHaveCount(0)
      await expect(page.getByTestId('apps-icon-change')).toHaveCount(0)
    })

    test('a member of a group chat may change it', async ({ page }) => {
      await open(page, { size: vp.size, apps: [ALERT], role: 'member', kind: 'group' })
      await settingsOf(page, 'Dr Alaseo Alert')
      await expect(page.getByTestId('apps-icon-change')).toBeVisible()
    })
  })
}
