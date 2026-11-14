// Screenshots of apps posting in rooms (QA TC-1546, TC-1547, TC-1412), 1440 and 390 wide, light and dark, for review by
// eye: the room ⋯ with "Add an app", the picker, the four guides (before and after the first Copy, waiting, Nothing
// yet?, connected, a refusal, the in-dialog example), the list (paused, someone who left knows the address) and settings
// (Sentry, an Other app waiting with How to send, paused, refused), the no-internet-address state for the owner and an admin, the cards in the timeline, a quiet line, an
// example, the thread with "Summarise this thread", a member's sender popover, the side chat's chip, the Activity
// notices (paused, someone who left) and Admin › System › Connection's line. Only when ROOM_APPS_SHOTS names a folder.
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'
import { appMessage, mockApp, mockPreset, routeRoomApps, type MockApp } from './room-apps-mock'

const dir = process.env.ROOM_APPS_SHOTS
test.skip(!dir, 'ROOM_APPS_SHOTS is not set')
test.use({ serviceWorkers: 'block', locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] })

const MINA = { id: 'mina', name: 'Mina' }
const JUN = { id: 'jun', name: 'Jun' }
const SENTRY = mockApp('sentry')
const GITHUB = mockApp('github', { id: 'app-github' })
const FORMS = mockApp('google_forms', { id: 'app-forms', name: 'Sign-up form', pausedUntil: '2099-01-01T00:00:00.000Z', canResume: true, today: 500 })
const OTHER = mockApp('other', { id: 'app-other', name: 'Backup alerts', firstOkAt: null, lastOkAt: null, today: 0 })
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
  { id: id(4), author: MINA, body: '', threadRootId: ROOT, extra: appMessage(SENTRY, { title: 'Resolved by Jun' }) },
  { id: id(5), author: MINA, body: '', extra: appMessage(GITHUB, { kind: 'Pull request opened · acme/web', title: 'Fix the cart total on Safari', details: ['by jun-dev'], status: 'Status: Open', link: { url: 'https://github.com/acme/web/pull/7', host: 'github.com' } }) },
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
      await page.getByTestId('apps-guide-name').fill('Backup alerts')
      await shot('08a-guide-other-new')
      await page.getByTestId('apps-copy-address').click()
      apps.connectNext()
      await expect(page.getByTestId('apps-status')).toHaveAttribute('data-state', 'ok', { timeout: 8000 })
      await shot('08-guide-other-connected')
      await page.getByTestId('apps-example').click()
      await expect(page.getByTestId('apps-preview')).toBeVisible()
      await page.getByTestId('apps-preview').scrollIntoViewIfNeeded()
      await shot('09-guide-other-preview')
      await close()

      // ---- a room with apps: cards, thread, list and settings
      apps = await start(page, { apps: [SENTRY, FORMS, { ...GITHUB, lastRefusal: { at: '2026-11-05T10:57:00.000Z', reason: 'signature' }, signed: true, leaverKnows: true } as MockApp, OTHER] })
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
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-list-row').nth(3).click()
      await expect(page.getByTestId('apps-how-to-send')).toBeVisible()
      await shot('16b-settings-other')
      await page.getByTestId('apps-how-to-send').scrollIntoViewIfNeeded()
      await shot('16c-settings-other-how-to-send')
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

    // ---- presets (plan 20261114-1522, P1, QA TC-1634): the picker's groups, each new guide (top and its last step),
    // Other's "Don't see your app?", each new card in the timeline, a preset's settings
    test(`room apps presets screenshots (${vp.name}, ${scheme})`, async ({ page }) => {
      test.setTimeout(240_000)
      await page.setViewportSize(vp.size)
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      const shot = async (name: string) => { await page.waitForTimeout(250); await page.screenshot({ path: `${dir}/${name}-${vp.name}-${scheme}.png` }) }
      const dialog = page.getByTestId('apps-dialog')
      await start(page, { messages: MESSAGES.slice(0, 1) })
      await page.getByTestId('room-menu').first().click()
      await page.getByTestId('room-menu-apps').click()
      await expect(page.getByTestId('apps-picker')).toBeVisible()
      await shot('p01-picker')
      await page.getByTestId('apps-pick-other').scrollIntoViewIfNeeded()
      await shot('p02-picker-end')
      for (const p of ['stripe', 'shopify', 'notion', 'zendesk', 'typeform', 'tally', 'jotform'] as const) {
        await page.getByTestId(`apps-pick-${p}`).click()
        await expect(page.getByTestId('apps-guide')).toHaveAttribute('data-kind', p)
        await shot(`p-guide-${p}`)
        const safer = page.getByTestId('apps-safer')
        if (await safer.count()) await safer.locator('summary').click()
        await page.getByTestId('apps-done').scrollIntoViewIfNeeded()
        await shot(`p-guide-${p}-end`)
        await page.getByTestId('apps-back').click()
      }
      await page.getByTestId('apps-pick-other').click()
      await shot('p-guide-other')
      await page.getByTestId('apps-zapier').locator('summary').click()
      await page.getByTestId('apps-zapier').scrollIntoViewIfNeeded()
      await shot('p-guide-other-zapier')
      await page.getByTestId('apps-make').locator('summary').click()
      await page.getByTestId('apps-make').scrollIntoViewIfNeeded()
      await shot('p-guide-other-make')
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)

      // the cards, as the server's presets write them (shared plain-text card, the one checked link)
      const P = {
        notion: mockPreset('notion'), typeform: mockPreset('typeform'), tally: mockPreset('tally'), jotform: mockPreset('jotform'),
        stripe: mockPreset('stripe', { lastRefusal: { at: '2026-11-05T10:57:00.000Z', reason: 'signature' }, signed: true }), shopify: mockPreset('shopify'), zendesk: mockPreset('zendesk'),
      }
      const cards: MockMessage[] = [
        { id: id(50), author: MINA, body: '', extra: appMessage(P.stripe, { kind: 'Payment received', title: '$49.00 from Jamie Rivera', details: ['Pro plan (monthly)'], status: 'Status: Succeeded', link: { url: 'https://dashboard.stripe.com/payments/pi_3Q', host: 'dashboard.stripe.com' } }) },
        { id: id(51), author: MINA, body: '', extra: appMessage(P.shopify, { kind: 'New order #1042', title: '86.00 USD · 3 items', details: ['2 × T-shirt', '1 × Mug', 'Jamie, Portland'], status: 'Status: Paid', link: { url: 'https://admin.shopify.com/store/acme/orders/5501', host: 'admin.shopify.com' } }) },
        { id: id(52), author: MINA, body: '', extra: appMessage(P.zendesk, { kind: 'New ticket #318 · high', title: "Can't sign in after the update", details: ['From Jamie Rivera', 'Assigned to Jun'], status: 'Status: Open', link: { url: 'https://acme.zendesk.com/agent/tickets/318', host: 'acme.zendesk.com' } }) },
        { id: id(53), author: MINA, body: '', extra: appMessage(P.notion, { kind: 'Notion · Content calendar', title: 'Launch post for the spring sale', details: ['Owner: Mina Park', 'Due: Nov 20'], status: 'Status: In review', link: { url: 'https://www.notion.so/acme/Launch-post-1a2b', host: 'www.notion.so' } }) },
        { id: id(54), author: MINA, body: '', extra: appMessage(P.typeform, { kind: 'New response · Customer survey', title: 'How did you hear about us?: From a friend', details: ['Rating: 9', 'Email: jamie@example.com', '+3 more'] }) },
        { id: id(55), author: MINA, body: '', extra: appMessage(P.tally, { kind: 'New response · Event sign-up', title: 'Name: Jamie Rivera', details: ['Ticket: Early bird', 'Upload: badge-photo.jpg'] }) },
        { id: id(56), author: MINA, body: '', extra: appMessage(P.jotform, { kind: 'New response · Quote request', title: 'Company: Example Co.', details: ['Budget: 5,000', '+3 more'] }) },
      ]
      await start(page, { apps: Object.values(P), messages: [MESSAGES[0]!, ...cards] })
      await page.getByTestId('room-messages').locator('[data-app="stripe"]').first().scrollIntoViewIfNeeded()
      await shot('p-cards-1')
      await page.getByTestId('room-messages').locator('[data-app="jotform"]').first().scrollIntoViewIfNeeded()
      await shot('p-cards-2')
      // settings: Stripe's refused secret (named), Shopify's switches and Regenerate warning
      await page.getByTestId('room-menu').first().click()
      await page.getByTestId('room-menu-apps').click()
      await expect(page.getByTestId('apps-list')).toBeVisible()
      await shot('p-list')
      await page.getByTestId('apps-list-row').nth(4).click()
      await shot('p-settings-stripe-refused')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-list-row').nth(5).click()
      await page.getByTestId('apps-new-address').click()
      await shot('p-settings-shopify-regenerate')
    })
  }
}
