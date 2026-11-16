// Screenshots of an Other app's icon (docs/decisions/20261116-other-app-icon.md, QA TC-3544 / TC-3545), 1440 and 390
// wide, light and dark, for review by eye: the timeline with three Other apps on their letters beside a service's logo,
// the list, one app's settings with its letter and the Change icon menu, the emoji picker, the settings and the timeline
// after an emoji and after an image. Only when ROOM_APPS_SHOTS names a folder.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'
import { appMessage, mockApp, mockPreset, routeRoomApps, type MockApp } from './room-apps-mock'

const dir = process.env.ROOM_APPS_SHOTS
test.skip(!dir, 'ROOM_APPS_SHOTS is not set')
test.use({ serviceWorkers: 'block', locale: 'en-US' })

const MINA = { id: 'mina', name: 'Mina' }
const ALERT = mockApp('other', { id: '019a5f00-0000-7000-8000-0000000a0001', name: 'Dr Alaseo Alert' })
const BACKUP = mockApp('other', { id: '019a5f00-0000-7000-8000-0000000a0002', name: 'Backup alerts' })
const DEPLOY = mockApp('other', { id: '019a5f00-0000-7000-8000-0000000a0003', name: 'deploy bot' })
const SENTRY = mockApp('sentry')
const NOTION = mockPreset('notion')
const APPS = [ALERT, BACKUP, DEPLOY, SENTRY, NOTION]
const WIDE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAHgAAABQCAIAAABd+SbeAAAAg0lEQVR42u3QMQ0AAAgDsAlAIP5PVOCCcDSpgma6OBAFokUjWrRoC6JFI1q0aAuiRSNatGhEi0a0aNGIFo1o0aIRLRrRokUjWjSiRYtGtGhEixaNaNGIFi0a0aIRLVo0okUjWrRoRItGtGjRiBaNaNGiES0a0aJFI1o0okWLRrRoRP+x/Pbv0VElslcAAAAASUVORK5CYII=', 'base64')
const LINES: Record<string, string> = {
  [ALERT.id]: 'Blood pressure monitor offline in room 3', [BACKUP.id]: 'Nightly backup finished: 14 GB', [DEPLOY.id]: 'Deployed web 2.4.1 to production',
  [SENTRY.id]: 'TypeError in checkout', [NOTION.id]: 'Page updated: Clinic hours',
}
const MESSAGES: MockMessage[] = APPS.map((a, i) => ({ id: `019a5f00-0000-7000-8000-00000000e${String(i).padStart(3, '0')}`, author: MINA, body: '', extra: appMessage(a, { title: LINES[a.id]! }) }))

async function start(page: Page, apps: MockApp[]) {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await routeRoom(page, { kind: 'team', members: [MINA], messages: MESSAGES, room: { name: 'clinic-ops' } })
  const state = await routeRoomApps(page, { apps: apps.map((a) => ({ ...a })) })
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-messages')).toBeVisible()
  return state
}

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`other app icon screenshots (${vp.name}, ${scheme})`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      const shot = async (name: string) => { await page.waitForTimeout(250); await page.screenshot({ path: `${dir}/icon-${name}-${vp.name}-${scheme}.png` }) }
      const manage = async (name: string) => {
        await page.getByTestId('app-sender-button').filter({ hasText: name }).first().click()
        await page.getByTestId('app-sender-manage').click()
        await expect(page.getByTestId('apps-settings')).toBeVisible()
      }
      await start(page, APPS)
      await shot('01-timeline-letters')
      await page.getByTestId('room-menu').first().click()
      await page.getByTestId('room-menu-apps').click()
      await expect(page.getByTestId('apps-list')).toBeVisible()
      await shot('02-list-letters')
      await page.keyboard.press('Escape')
      await manage('Dr Alaseo Alert')
      await shot('03-settings-letter')
      await page.getByTestId('apps-icon-change').click()
      await shot('04-change-menu')
      await page.getByTestId('apps-icon-emoji').click()
      await expect(page.getByTestId('emoji-picker')).toBeVisible()
      await shot('05-emoji-picker')
      await page.getByTestId('emoji-search').fill('police car light')
      await page.getByTestId('emoji-picker').locator('[data-emoji="🚨"]').first().click()
      await expect(page.getByTestId('apps-icon').getByTestId('app-emoji')).toBeVisible()
      await shot('06-settings-emoji')
      await page.keyboard.press('Escape')
      await manage('Backup alerts')
      await page.getByTestId('apps-icon-change').click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('apps-icon-upload').click()
      await (await chooser).setFiles({ name: 'backup.png', mimeType: 'image/png', buffer: WIDE_PNG })
      await expect(page.getByTestId('apps-icon').getByTestId('app-tile')).toHaveAttribute('data-icon', 'image')
      await shot('07-settings-image')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('apps-dialog')).toHaveCount(0)
      await shot('08-timeline-mixed')
    })
  }
}
