// Screenshots of apps posting in rooms (QA TC-1546, TC-1547, TC-1412), 1440 and 390 wide, light and dark, for review by
// eye: the room ⋯ with "Add an app", the picker, the four guides (before and after the first Copy, waiting, Nothing
// yet?, connected, a refusal), the list (paused, someone who left knows the address) and settings (normal, paused,
// refused), the no-internet-address state for the owner and an admin, the cards in the timeline, a quiet line, an
// example, the thread with "Summarise this thread", a member's sender popover, the side chat's chip, the Activity
// notices (paused, someone who left) and Admin › System › Connection's line. Only when ROOM_APPS_SHOTS names a folder.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'
import { appMessage, mockApp, routeRoomApps, type MockApp } from './room-apps-mock'

const dir = process.env.ROOM_APPS_SHOTS
test.skip(!dir, 'ROOM_APPS_SHOTS is not set')
test.use({ serviceWorkers: 'block', locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] })

const MINA = { id: 'mina', name: 'Mina' }
const JUN = { id: 'jun', name: 'Jun' }
const SENTRY = mockApp('sentry')
const GITHUB = mockApp('github', { id: 'app-github' })
const FORMS = mockApp('google_forms', { id: 'app-forms', name: 'Sign-up form', pausedUntil: '2099-01-01T00:00:00.000Z', canResume: true, today: 500 })
const ROOT = '019a5f00-0000-7000-8000-00000000c001'
const id = (n: number) => `019a5f00-0000-7000-8000-00000000c${String(n).padStart(3, '0')}`
const MESSAGES: MockMessage[] = [
  { id: id(0), author: MINA, body: 'Morning! The deploy is out.' },
  {
    id: ROOT, author: MINA, body: '',
    extra: appMessage(SENTRY, {
      kind: 'New issue · checkout-web · error', title: "TypeError: Cannot read properties of undefined (reading 'total')",
      details: ['in app/cart/summary.ts'], status: 'Status: Resolved', link: { url: 'https://sentry.io/organizations/acme/issues/42/', host: 'sentry.io' },
    }, { thread: { replyCount: 3, lastReplyAt: '2026-11-05T09:20:00.000Z', repliers: [JUN], newReplies: false } }),
  },
  { id: id(2), author: MINA, body: '', threadRootId: ROOT, extra: appMessage(SENTRY, { title: 'Happened again', details: ['3 events in 5 minutes'] }) },
  { id: id(3), author: JUN, body: "I'm on it", threadRootId: ROOT },
  { id: id(4), author: MINA, body: '', threadRootId: ROOT, extra: appMessage(SENTRY, { title: 'Resolved by Jun (unverified)' }) },
  { id: id(5), author: MINA, body: '', extra: appMessage(GITHUB, { kind: 'Pull request opened · acme/web', title: 'Fix the cart total on Safari', details: ['by jun-dev (unverified)'], status: 'Status: Open', link: { url: 'https://github.com/acme/web/pull/7', host: 'github.com' } }) },
  { id: id(6), author: MINA, body: '', extra: appMessage({ ...FORMS, quiet: true }, { title: 'Sign-up form reached 500 messages today and was paused. It starts again tomorrow.' }) },
  { id: id(7), author: MINA, body: '', extra: appMessage({ ...SENTRY, example: true, quiet: true }, { kind: 'Example', title: 'This is how messages from Sentry look here' }) },
]

const NOTICES = [
  { id: 'n1', eventType: 'room_app.paused', code: 'room_app.paused', sourceId: 'app-forms.2026-11-05', createdAt: '2026-11-05T10:00:00.000Z', readAt: null, chatId: null, link: 'room', outcome: null,
    roomApp: { appId: 'app-forms', name: 'Sign-up form', roomId: ROOM_ID, roomKind: 'team', roomName: 'dev', day: '2026-11-05', cap: 500, skipped: 37, pausedUntil: '2026-11-06T00:00:00.000Z', canResume: true } },
  { id: 'n2', eventType: 'room_app.leaver', code: 'room_app.leaver', sourceId: 'app-sentry.abc', createdAt: '2026-11-05T09:00:00.000Z', readAt: null, chatId: null, link: 'room', outcome: null,
    roomAppLeaver: { appId: 'app-sentry', name: 'Sentry', roomId: ROOM_ID, roomKind: 'team', roomName: 'dev' } },
]

async function start(page: Page, o: { apps?: MockApp[]; available?: boolean; role?: 'admin' | 'member'; messages?: MockMessage[] } = {}) {
  // the routes of the step before go (a member's or an admin's /api/me, the room's)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await routeRoom(page, { kind: 'team', members: [MINA, JUN], messages: o.messages ?? MESSAGES, room: { name: 'dev' } })
  const apps = await routeRoomApps(page, { apps: (o.apps ?? []).map((a) => ({ ...a })), available: o.available, createdAgoMs: 180_000 })
  if (o.role) {
    await page.route(/\/api\/me$/, async (route) => {
      const r = await route.fetch()
      const me = await r.json() as { user?: { role: string } }
      if (me?.user) me.user.role = o.role!
      await route.fulfill({ response: r, json: me })
    })
  }
  await signIn(page)
  await page.goto(`/rooms/${ROOM_ID}`)
  await expect(page.getByTestId('room-messages')).toBeVisible()
  return apps
}

for (const vp of [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`room apps screenshots (${vp.name}, ${scheme})`, async ({ page }) => {
      test.setTimeout(240_000)
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      const shot = async (name: string) => { await page.waitForTimeout(250); await page.screenshot({ path: `${dir}/${name}-${vp.name}-${scheme}.png` }) }
      const menu = async () => { await page.getByTestId('room-menu').first().click(); await expect(page.getByTestId('room-menu-apps')).toBeVisible() }
      const dialog = page.getByTestId('apps-dialog')
      const close = async () => { await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0) }

      // ---- a new room: the menu, the picker, the guides
      let apps = await start(page, { messages: MESSAGES.slice(0, 1) })
      await menu()
      await shot('01-menu-add')
      await page.getByTestId('room-menu-apps').click()
      await expect(page.getByTestId('apps-picker')).toBeVisible()
      await shot('02-picker')
      await page.getByTestId('apps-pick-sentry').click()
      await shot('03-guide-sentry')
      await page.getByTestId('apps-safer').locator('summary').click()
      await page.getByTestId('apps-sentry-alert').locator('summary').click()
      await shot('04-guide-sentry-optional')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-github').click()
      await page.getByTestId('apps-copy-address').click()
      await expect(page.getByTestId('apps-nothing-yet')).toBeVisible()
      await page.getByTestId('apps-nothing-yet').locator('summary').click()
      await shot('05-guide-github-nothing-yet')
      apps.refuseNext('signature')
      await expect(page.getByTestId('apps-status')).toHaveAttribute('data-state', 'refused', { timeout: 8000 })
      await shot('06-guide-github-refused')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-google_forms').click()
      await shot('07-guide-forms')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-other').click()
      await page.getByTestId('apps-copy-address').click()
      apps.connectNext()
      await expect(page.getByTestId('apps-status')).toHaveAttribute('data-state', 'ok', { timeout: 8000 })
      await shot('08-guide-other-connected')
      await close()

      // ---- a room with apps: cards, thread, list and settings
      apps = await start(page, { apps: [SENTRY, FORMS, { ...GITHUB, lastRefusal: { at: '2026-11-05T10:57:00.000Z', reason: 'signature' }, signed: true, leaverKnows: true } as MockApp] })
      await shot('10-timeline-cards')
      await page.getByTestId('app-sender-button').first().click()
      await shot('11-sender-popover-manager')
      await page.keyboard.press('Escape')
      await page.locator('[data-testid="room-message"][data-app="sentry"]').first().getByTestId('room-thread-line').click()
      await expect(page.getByTestId('thread-app-summarise')).toBeVisible()
      await shot('12-thread')
      await page.goto(`/rooms/${ROOM_ID}`)
      await expect(page.getByTestId('room-messages')).toBeVisible()
      await page.getByTestId('room-side-chat-button').click()
      await expect(page.getByTestId('side-chat-app-chip')).toBeVisible()
      await shot('13-side-chat-chip')
      await page.goto(`/rooms/${ROOM_ID}`)
      await expect(page.getByTestId('room-messages')).toBeVisible()
      await menu()
      await shot('14-menu-list')
      await page.getByTestId('room-menu-apps').click()
      await expect(page.getByTestId('apps-list')).toBeVisible()
      await shot('15-list')
      await page.getByTestId('apps-list-row').first().click()
      await shot('16-settings')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-list-row').nth(1).click()
      await shot('17-settings-paused')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-list-row').nth(2).click()
      await shot('18-settings-refused-leaver')
      await page.getByTestId('apps-remove').click()
      await shot('19-remove-confirm')
      await page.keyboard.press('Escape')
      await close()

      // ---- a member: the popover says who to ask
      await start(page, { role: 'member', apps: [SENTRY] })
      await page.getByTestId('app-sender-button').first().click()
      await shot('20-sender-popover-member')
      await page.keyboard.press('Escape')

      // ---- no internet address, owner and admin
      await start(page, { available: false, messages: MESSAGES.slice(0, 1) })
      await menu()
      await page.getByTestId('room-menu-apps').click()
      await expect(page.getByTestId('apps-no-address')).toBeVisible()
      await shot('21-no-address-owner')
      await close()
      await start(page, { available: false, role: 'admin', messages: MESSAGES.slice(0, 1) })
      await menu()
      await page.getByTestId('room-menu-apps').click()
      await expect(page.getByTestId('apps-no-address')).toBeVisible()
      await shot('22-no-address-admin')
      await close()

      // ---- Activity: the paused notice and someone who left (as the owner again)
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      await page.route(/\/api\/notifications(\?|$)/, (route) => route.fulfill({ json: { items: NOTICES, nextCursor: null, unreadCount: 2, roomUnreadCount: 0, noticeUnreadCount: 2 } }))
      await page.route(/\/api\/notifications\/(n1|n2)(\/read)?$/, (route) => route.fulfill({ json: NOTICES.find((n) => route.request().url().includes(`/${n.id}`)) }))
      await page.goto('/activity')
      // a computer: the panel's row opens the notice beside it; a phone: the page lists it with its buttons
      if (vp.name === '1440') await page.getByText(/Sign-up form paused in/).first().click()
      await expect(page.getByTestId('notification-room-app-resume').first()).toBeVisible()
      await shot('23-activity-notices')

      // ---- Admin › System › Connection: the line when apps are exempt from the address's limits
      await page.route(/\/api\/admin\/connection$/, async (route) => {
        const r = await route.fetch()
        const c = await r.json() as Record<string, unknown>
        await route.fulfill({ response: r, json: { ...c, appsAnywhere: true, publicAddress: 'team.example.com', mode: 'direct-only' } })
      })
      await page.goto(vp.name === '390' ? '/admin/system/connection' : '/admin/system')
      await expect(page.getByTestId('connection-apps-anywhere')).toBeVisible()
      await page.getByTestId('connection-apps-anywhere').scrollIntoViewIfNeeded()
      await shot('24-admin-connection')
    })
  }
}
