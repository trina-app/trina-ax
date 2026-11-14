// Apps posting in a room (docs/DECISIONS.md "Apps posting in rooms", QA TC-1546, TC-1547, TC-1412), 1440 and 390 wide:
// the room's ⋯ › "Add an app", the picker (✕ before any copy adds nothing), a guide (the first Copy adds the app and
// copies its Webhook URL, under the name typed for an Other app; the status line follows the app live: waiting,
// connected, a refusal with its reason; Show an example previews in the dialog, posting nothing), the list and one app's
// settings (rename, switches, Post quietly, Regenerate, Remove app), the paused state with Resume now, the cards in the
// timeline (the "APP" tag, plain text, the one link) and their thread (short replies, "Summarize this thread"), a
// member's view (no ⋯ item; "Ask Mina to change what shows here.), and the no-internet-address state
// for the owner and for an admin. The room and its apps are answered through page.route (rooms-mock.ts,
// room-apps-mock.ts).
import { expect, test, type Page } from '@playwright/test'
import { reset, signIn } from './helpers'
import { ROOM_ID, routeRoom, type MockMessage } from './rooms-mock'
import { ADDRESS, appMessage, mockApp, mockPreset, routeRoomApps, type MockApp } from './room-apps-mock'

test.use({ serviceWorkers: 'block', locale: 'en-US' })

const SIZES = [{ name: '1440', size: { width: 1440, height: 900 } }, { name: '390', size: { width: 390, height: 844 } }] as const
const MINA = { id: 'mina', name: 'Mina' }
const JUN = { id: 'jun', name: 'Jun' }
const SENTRY = mockApp('sentry')
const ROOT = '019a5f00-0000-7000-8000-00000000c001'
const MESSAGES: MockMessage[] = [
  { id: '019a5f00-0000-7000-8000-00000000c000', author: MINA, body: 'Morning! Deploy is out.' },
  {
    id: ROOT, author: MINA, body: '',
    extra: appMessage(SENTRY, {
      kind: 'New issue · checkout-web · error', title: "TypeError: Cannot read properties of undefined (reading 'total')",
      details: ['in app/cart/summary.ts **not bold** https://evil.example.com/x'], status: 'Status: Resolved',
      link: { url: 'https://sentry.io/organizations/acme/issues/42/', host: 'sentry.io' },
    }, { thread: { replyCount: 2, lastReplyAt: '2026-11-05T09:20:00.000Z', repliers: [JUN], newReplies: false } }),
  },
  { id: '019a5f00-0000-7000-8000-00000000c002', author: MINA, body: '', threadRootId: ROOT, extra: appMessage(SENTRY, { title: 'Happened again', details: ['3 events in 5 minutes'] }) },
  { id: '019a5f00-0000-7000-8000-00000000c003', author: MINA, body: '', threadRootId: ROOT, extra: appMessage(SENTRY, { title: 'Resolved by Jun' }) },
  { id: '019a5f00-0000-7000-8000-00000000c004', author: MINA, body: '', extra: appMessage({ ...SENTRY, quiet: true }, { title: 'Sentry reached 500 messages today and was paused. It starts again tomorrow.' }) },
]

async function open(page: Page, o: { size: { width: number; height: number }; kind?: 'team' | 'group'; apps?: MockApp[]; available?: boolean; role?: 'owner' | 'admin' | 'member'; messages?: MockMessage[] }) {
  await page.setViewportSize(o.size)
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const room = await routeRoom(page, { kind: o.kind ?? 'team', members: [MINA, JUN], messages: o.messages ?? MESSAGES, room: { name: 'dev' } })
  const apps = await routeRoomApps(page, { apps: o.apps?.map((a) => ({ ...a })) ?? [], available: o.available })
  if (o.role && o.role !== 'owner') {
    // the signed-in person as an admin or a member of the team
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
  return { room, apps }
}

const menuItem = async (page: Page) => {
  await page.getByTestId('room-menu').first().click()
  return page.getByTestId('room-menu-apps')
}

for (const vp of SIZES) {
  test.describe(`room apps (${vp.name})`, () => {
    test('the picker adds nothing; the first Copy adds the app; the guide follows it live; Show an example', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const { apps } = await open(page, { size: vp.size, messages: MESSAGES.slice(0, 1) })
      const item = await menuItem(page)
      await expect(item).toHaveText('Add an app')
      await item.click()
      await expect(page.getByTestId('apps-picker')).toBeVisible()
      await expect(page.getByTestId('apps-pick-sentry')).toContainText('Errors in your service')
      await expect(page.getByTestId('apps-left')).toHaveCount(0)
      // ✕ before any copy: nothing was added
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
      await expect(page.getByTestId('apps-dialog')).toHaveCount(0)
      expect(apps.calls).toEqual([])

      await (await menuItem(page)).click()
      await page.getByTestId('apps-pick-other').click()
      await expect(page.getByTestId('apps-title')).toHaveText('Connect another app')
      await expect(page.getByTestId('apps-address')).toHaveText("Copying makes this room's own Webhook URL")
      // ‹ goes back to the picker, still nothing added
      await page.getByTestId('apps-back').click()
      await expect(page.getByTestId('apps-picker')).toBeVisible()
      await page.getByTestId('apps-pick-other').click()
      // Copy is the next step (the one main button); Done is not yet
      await expect(page.getByTestId('apps-copy-address')).toHaveText('Copy')
      await page.getByTestId('apps-guide-name').fill('Backup alerts')
      await page.getByTestId('apps-copy-address').click()
      await expect(page.getByTestId('apps-copy-address')).toHaveText('Copied')
      expect(apps.calls).toEqual(['create:other:Backup alerts'])
      await expect(page.getByTestId('apps-title')).toHaveText('Connect Backup alerts')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ADDRESS(1))
      await expect(page.getByTestId('apps-address')).toContainText('https://acme.trina.app/in/tax_in_')
      await expect(page.getByTestId('apps-steps')).toContainText('Paste this Webhook URL there.')
      await expect(page.getByTestId('apps-how-to-send')).toContainText('"text"')
      await expect(page.getByTestId('apps-status')).toHaveText('Waiting for the first message. You can close this.')
      // a second copy adds no second app
      await page.getByTestId('apps-copy-address').click()
      expect(apps.calls.filter((c) => c.startsWith('create'))).toHaveLength(1)
      // a refusal shows live, then the first message: Connected
      apps.refuseNext('format')
      await expect(page.getByTestId('apps-status')).toContainText("wasn't shown: the message wasn't in a form Trina can read.", { timeout: 8000 })
      apps.connectNext()
      await expect(page.getByTestId('apps-status')).toContainText('Connected · first message', { timeout: 8000 })
      // the example is a preview in the dialog: nothing is posted
      await page.getByTestId('apps-example').click()
      await expect(page.getByTestId('apps-preview')).toContainText('Nightly backup')
      expect(apps.calls.some((c) => c.startsWith('example:'))).toBe(false)
      await page.getByTestId('apps-done').click()
      await expect(page.getByTestId('apps-dialog')).toHaveCount(0)
      // the ⋯ now says how many post here
      await expect(await menuItem(page)).toHaveText('Integrations · 1')
    })

    test('guides: GitHub secret, Sentry secret check, Forms code and its email note', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const { apps } = await open(page, { size: vp.size, messages: MESSAGES.slice(0, 1) })
      await (await menuItem(page)).click()
      await page.getByTestId('apps-pick-github').click()
      await expect(page.getByTestId('apps-steps')).toContainText('“Settings › Webhooks › Add webhook”')
      await page.getByTestId('apps-safer').locator('summary').click()
      await page.getByTestId('apps-copy-secret').click()
      await expect.poll(() => apps.calls).toEqual(['create:github', expect.stringMatching(/^secret:.*:generate$/)])
      await expect(page.getByTestId('apps-copy-secret')).toHaveText('Copied')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^tax_whs_/)
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-sentry').click()
      await page.getByTestId('apps-safer').locator('summary').click()
      await page.getByTestId('apps-sentry-secret').fill('not-a-secret-at-all')
      await page.getByTestId('apps-sentry-secret-save').click()
      await expect(page.getByTestId('apps-secret-error')).toHaveText("That doesn't look like a Sentry Client Secret.")
      await page.getByTestId('apps-sentry-secret').fill('a'.repeat(64))
      await page.getByTestId('apps-sentry-secret-save').click()
      await expect(page.getByTestId('apps-signed')).toContainText('only signed messages are shown')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-google_forms').click()
      await expect(page.getByTestId('apps-steps')).toContainText('“Google hasn\'t verified this app”')
      await expect(page.getByTestId('apps-forms-email')).toContainText('people who join later too')
      await expect(page.getByTestId('apps-forms-safe')).toBeVisible()
      // Forms: only the code to copy, no address on screen
      await expect(page.getByTestId('apps-address')).toHaveCount(0)
      await page.getByTestId('apps-copy-address').click()
      await expect(page.getByTestId('apps-copy-address')).toHaveText('Copied')
      const code = await page.evaluate(() => navigator.clipboard.readText())
      expect(code).toContain('const SEND_EMAIL = true')
      expect(code).toContain(`const TRINA_ADDRESS = "${ADDRESS(3)}"`)
    })

    test('the list and settings: switches, Quiet, a new address, paused with Resume now, a refusal, Remove', async ({ page }) => {
      const paused = mockApp('google_forms', { id: 'app-forms', name: 'Sign-up form', pausedUntil: '2099-01-01T00:00:00.000Z', canResume: true, today: 500 })
      const refused = mockApp('github', { id: 'app-github', lastRefusal: { at: '2026-11-05T10:57:00.000Z', reason: 'signature' }, signed: true })
      const { apps } = await open(page, { size: vp.size, apps: [SENTRY, paused, refused] })
      const item = await menuItem(page)
      await expect(item).toHaveText('Integrations · 3')
      await item.click()
      await expect(page.getByTestId('apps-list-row')).toHaveCount(3)
      await expect(page.getByTestId('apps-list-row').nth(1)).toContainText('Paused')
      await expect(page.getByTestId('apps-left')).toHaveCount(0)
      await page.getByTestId('apps-list-row').first().click()
      await expect(page.getByTestId('apps-status')).toContainText('Last message')
      await expect(page.getByTestId('apps-set-up-by')).toContainText('Set up by Olga')
      // unsigned: said once here, with its one action
      await expect(page.getByTestId('apps-warning-unsigned')).toContainText('Not signed: anyone with the Webhook URL can post.')
      // a single-kind app has no switches; this one has six
      await expect(page.getByTestId('apps-switch-new_issue')).toHaveCount(1)
      // rename
      await page.getByTestId('apps-name').fill('Sentry · checkout')
      await page.getByTestId('apps-name').press('Enter')
      await expect.poll(() => apps.calls.at(-1)).toBe('patch:app-sentry:{"name":"Sentry · checkout"}')
      await expect(page.getByTestId('apps-title')).toHaveText('Sentry · checkout')
      await expect(page.getByTestId('apps-title-kind')).toHaveText('Sentry')
      await page.getByTestId('apps-switch-alert').locator('..').click()
      await expect.poll(() => apps.calls.at(-1)).toBe('patch:app-sentry:{"events":{"alert":true}}')
      await expect(page.getByTestId('apps-settings')).toContainText('Post quietly')
      await page.getByTestId('apps-quiet').locator('..').click()
      await expect.poll(() => apps.calls.at(-1)).toBe('patch:app-sentry:{"quiet":true}')
      await page.getByTestId('apps-new-address').click()
      await expect(page.getByRole('alertdialog').or(page.getByRole('dialog').last())).toContainText('The old URL stops working right away. Paste the new Webhook URL into Sentry · checkout.')
      await page.getByRole('button', { name: 'Regenerate', exact: true }).last().click()
      await expect(page.getByTestId('apps-new-address-done')).toBeVisible()
      expect(apps.calls).toContain('rotate:app-sentry')
      // back to the list: the paused one resumes
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-list-row').nth(1).click()
      await expect(page.getByTestId('apps-status')).toContainText('Paused: it reached 500 responses today.')
      await page.getByTestId('apps-resume').click()
      await expect.poll(() => apps.calls).toContain('resume:app-forms')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-list-row').nth(2).click()
      await expect(page.getByTestId('apps-warning-refused')).toContainText("wasn't shown: the signature didn't match. Check the secret.")
      await page.getByTestId('apps-set-up-again').click()
      await expect(page.getByTestId('apps-guide')).toBeVisible()
      await page.getByTestId('apps-back').click()
      // Remove, with its words
      await page.getByTestId('apps-remove').click()
      await expect(page.getByRole('dialog').last()).toContainText("GitHub can't post here any more. Its messages stay. Also delete the Webhook URL in GitHub.")
      await page.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect.poll(() => apps.calls).toContain('delete:app-github')
      await expect(page.getByTestId('apps-list-row')).toHaveCount(2)
    })

    test('cards: the APP tag, plain text, the one link; the thread with short replies and Summarize this thread', async ({ page }) => {
      await open(page, { size: vp.size, apps: [SENTRY] })
      const card = page.locator('[data-testid="room-message"][data-app="sentry"]').first()
      await expect(card.getByTestId('app-card-title')).toHaveText("TypeError: Cannot read properties of undefined (reading 'total')")
      await expect(page.getByTestId('app-tag').first()).toHaveText('APP')
      // plain text: no Markdown, no link made from words in it
      await expect(card.getByTestId('app-card-detail')).toHaveText('in app/cart/summary.ts **not bold** https://evil.example.com/x')
      await expect(card.locator('a')).toHaveCount(1)
      await expect(card.getByTestId('room-app-link')).toHaveAttribute('href', 'https://sentry.io/organizations/acme/issues/42/')
      await expect(card.getByTestId('room-app-link')).toContainText('Open in Sentry')
      await expect(page.getByTestId('app-quiet-line')).toContainText('was paused')
      // the sender's popover: who set it up, and Manage
      await page.getByTestId('app-sender-button').first().click()
      await expect(page.getByRole('menu')).toContainText('Set up by Mina')
      await page.getByTestId('app-sender-manage').click()
      await expect(page.getByTestId('apps-settings')).toBeVisible()
      await page.keyboard.press('Escape')
      // the thread: "2 replies", short lines, the chip
      await card.getByTestId('room-thread-line').click()
      await expect(page.getByTestId('app-reply')).toHaveCount(2)
      await expect(page.getByTestId('app-reply').last()).toHaveText('Resolved by Jun')
      await expect(page.getByTestId('thread-app-summarise')).toHaveText('Summarize this thread')
    })

    test('presets: the picker\'s groups with Needs and Other last; the guides of Stripe, Zendesk, Notion, Shopify, Typeform; Other\'s JANDI line and Zapier/Make', async ({ page, context }) => {
      test.setTimeout(120_000)
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const { apps } = await open(page, { size: vp.size, messages: MESSAGES.slice(0, 1) })
      await (await menuItem(page)).click()
      const picker = page.getByTestId('apps-picker')
      await expect(picker.getByTestId('apps-pick-group')).toHaveText([/forms/i, /payments & orders/i, /work/i, /for developers/i, /any other way/i])
      const rows = picker.locator('[data-testid^="apps-pick-"]:not([data-testid="apps-pick-group"]):not([data-testid^="apps-pick-needs-"])')
      await expect(rows).toHaveCount(13)
      await expect(rows.last()).toHaveAttribute('data-testid', 'apps-pick-other')
      // the regional services wait behind "Show more services"
      await expect(page.getByTestId('apps-pick-toss_payments')).toHaveCount(0)
      await expect(page.getByTestId('apps-show-more')).toHaveText(/Show more services/)
      await expect(page.getByTestId('apps-pick-other')).toContainText('Slack, Discord or JANDI webhooks')
      await expect(page.getByTestId('apps-pick-email')).toHaveCount(0)
      await expect(page.getByTestId('apps-pick-needs-stripe')).toHaveText('Needs: Admin or Developer role in Stripe')
      await expect(page.getByTestId('apps-pick-needs-notion')).toHaveText('Needs: a paid Notion plan')
      await expect(page.getByTestId('apps-pick-notion').getByTestId('app-logo')).toHaveCount(1)
      await expect(page.getByTestId('apps-pick-shopify').getByTestId('app-initial')).toHaveText('S')
      expect(apps.calls).toEqual([])

      // Stripe: Needs in the header, its events as chips in their step, its signing secret checked by shape
      await page.getByTestId('apps-pick-stripe').click()
      await expect(page.getByTestId('apps-title')).toHaveText('Connect Stripe')
      await expect(page.getByTestId('apps-needs')).toHaveText('Needs: Admin or Developer role in Stripe')
      await expect(page.getByTestId('apps-steps')).toContainText('“Developers › Workbench › Webhooks”')
      await expect(page.getByTestId('apps-stripe-events')).toContainText('charge.refunded')
      await expect(page.getByTestId('apps-stripe-events')).not.toContainText('customer.subscription.created')
      await page.getByTestId('apps-copy-address').click()
      await expect(page.getByTestId('apps-copy-address')).toHaveText('Copied')
      expect(apps.calls).toEqual(['create:other+stripe'])
      await page.getByTestId('apps-safer').locator('summary').click()
      await expect(page.getByTestId('apps-safer-how')).toContainText('“Reveal secret”')
      await expect(page.getByTestId('apps-sentry-secret')).toHaveAttribute('placeholder', 'Signing secret (whsec_…)')
      await page.getByTestId('apps-sentry-secret').fill('not-a-secret')
      await page.getByTestId('apps-sentry-secret-save').click()
      await expect(page.getByTestId('apps-secret-error')).toHaveText("That doesn't look like Stripe's signing secret.")
      await page.getByTestId('apps-sentry-secret').fill(`whsec_${'a'.repeat(32)}`)
      await page.getByTestId('apps-sentry-secret-save').click()
      await expect(page.getByTestId('apps-signed')).toBeVisible()
      await page.getByTestId('apps-example').click()
      await expect(page.getByTestId('apps-preview')).toContainText('$49.00 from Jamie Rivera')
      await expect(page.getByTestId('apps-preview').getByTestId('app-tile')).toHaveAttribute('data-kind', 'stripe')

      // Zendesk: each trigger's body with its Copy inside the step where it is pasted
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-zendesk').click()
      await expect(page.getByTestId('apps-step').nth(2).getByTestId('apps-copy-body')).toBeVisible()
      await page.getByTestId('apps-copy-body').click()
      await expect(page.getByTestId('apps-copy-body')).toHaveText('Copied')
      // the clipboard is written after the click resolves: read it until it holds the body
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('"event":"created"')
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('{{ticket.id}}')
      await expect(page.getByTestId('apps-step-optional')).toContainText('Optional')
      await expect(page.getByTestId('apps-step-optional').getByTestId('apps-copy-body-updated')).toBeVisible()
      // the body was copied without the URL: nothing added yet
      expect(apps.calls.filter((c) => c.startsWith('create'))).toHaveLength(1)

      // Notion: no signing, "tick at least the title and Status"
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-notion').click()
      await expect(page.getByTestId('apps-steps')).toContainText('tick at least the title and Status')
      await expect(page.getByTestId('apps-safer')).toHaveCount(0)

      // Shopify: the other events are an optional step; Typeform: a secret Trina makes, answers seen by the room
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-shopify').click()
      await expect(page.getByTestId('apps-step-optional')).toContainText('“Order payment”')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-typeform').click()
      await expect(page.getByTestId('apps-forms-answers')).toContainText('email addresses too')
      await page.getByTestId('apps-safer').locator('summary').click()
      await page.getByTestId('apps-copy-secret').click()
      await expect.poll(() => apps.calls.slice(-2)).toEqual(['create:other+typeform', expect.stringMatching(/:generate$/)])

      // Other: the JANDI line under the URL, then "Don't see your app?" with Zapier's rows and Make's body
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-other').click()
      await expect(page.getByTestId('apps-other-where')).toHaveText('Paste this where an app asks for a Slack, Discord or JANDI webhook URL.')
      await expect(page.getByTestId('apps-dont-see')).toContainText("Don't see your app?")
      await page.getByTestId('apps-zapier').locator('summary').click()
      await expect(page.getByTestId('apps-zapier-needs')).toHaveText('Needs: a paid Zapier plan')
      await expect(page.getByTestId('apps-zapier-rows')).toContainText('thread')
      await page.getByTestId('apps-make').locator('summary').click()
      await page.getByTestId('apps-copy-make-body').click()
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('{{1.summary}}')
      expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject({ title: '{{1.summary}}' })
    })

    test('phase 4: Jira and HubSpot under Work with Needs; Show more services opens Toss Payments, Channel Talk, PortOne; their guides, bodies, rows and secrets; cards', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      const { apps } = await open(page, { size: vp.size, messages: MESSAGES.slice(0, 1) })
      await (await menuItem(page)).click()
      await expect(page.getByTestId('apps-pick-needs-jira')).toHaveText('Needs: space admin in Jira')
      await expect(page.getByTestId('apps-pick-needs-hubspot')).toHaveText('Needs: HubSpot Data Hub Professional or Enterprise')
      await expect(page.getByTestId('apps-pick-jira').getByTestId('app-initial')).toHaveText('Ji')

      // Jira: the created flow's body inside step 3, the transitioned and commented ones in optional steps; no signing
      await page.getByTestId('apps-pick-jira').click()
      await expect(page.getByTestId('apps-title')).toHaveText('Connect Jira')
      await expect(page.getByTestId('apps-steps')).toContainText('“Send web request”')
      await expect(page.getByTestId('apps-step').nth(2).getByTestId('apps-copy-body')).toBeVisible()
      await page.getByTestId('apps-copy-body').click()
      const body = await page.evaluate(() => navigator.clipboard.readText())
      expect(body).toContain('"event":"created"')
      expect(body).toContain('"title":"{{issue.summary.jsonEncode}}"')
      await expect(page.getByTestId('apps-step-optional')).toHaveCount(2)
      await expect(page.getByTestId('apps-copy-body-transitioned')).toBeVisible()
      await expect(page.getByTestId('apps-copy-body-commented')).toBeVisible()
      await expect(page.getByTestId('apps-safer')).toHaveCount(0)
      expect(apps.calls).toEqual([])

      // HubSpot: the keys to add, the object as a static value first; email and phone never shown
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-hubspot').click()
      await expect(page.getByTestId('apps-needs')).toHaveText('Needs: HubSpot Data Hub Professional or Enterprise')
      await expect(page.getByTestId('apps-hubspot-deal')).toContainText('“Add static value”: deal')
      await expect(page.getByTestId('apps-hubspot-deal')).toContainText('“Deal stage”')
      await expect(page.getByTestId('apps-hubspot-contact')).toContainText('“Lifecycle stage”')
      await expect(page.getByTestId('apps-steps')).toContainText('Email addresses and phone numbers are never shown')
      await expect(page.getByTestId('apps-safer')).toHaveCount(0)

      // Show more services: open, the same three for everyone
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-show-more').click()
      await expect(page.getByTestId('apps-more-list').locator('[data-testid^="apps-pick-"]')).toHaveCount(3)
      await expect(page.getByTestId('apps-pick-toss_payments').getByTestId('app-initial')).toHaveText('TP')
      // Toss Payments: its event as a chip; its security key checked by shape
      await page.getByTestId('apps-pick-toss_payments').click()
      await expect(page.getByTestId('apps-toss-events')).toHaveText('PAYMENT_STATUS_CHANGED')
      await expect(page.getByTestId('apps-steps')).toContainText('“Register webhook”')
      await page.getByTestId('apps-safer').locator('summary').click()
      await expect(page.getByTestId('apps-safer-how')).toContainText('not every Toss event is signed')
      await expect(page.getByTestId('apps-sentry-secret')).toHaveAttribute('placeholder', 'Security key')
      await page.getByTestId('apps-sentry-secret').fill('not-the-key')
      await page.getByTestId('apps-sentry-secret-save').click()
      await expect(page.getByTestId('apps-secret-error')).toHaveText("That doesn't look like Toss Payments's signing secret.")
      await page.getByTestId('apps-sentry-secret').fill('ab'.repeat(32))
      await page.getByTestId('apps-sentry-secret-save').click()
      await expect(page.getByTestId('apps-signed')).toBeVisible()
      // the first Save added the app; both tries reached the server (the wrong shape refused there)
      expect(apps.calls).toEqual(['create:other+toss_payments', expect.stringMatching(/^secret:.*:set$/), expect.stringMatching(/^secret:.*:set$/)])
      // Channel Talk and PortOne
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-channel_talk').click()
      await expect(page.getByTestId('apps-channel-types')).toContainText('User chat and event notification')
      await page.getByTestId('apps-example').click()
      await expect(page.getByTestId('apps-preview')).toContainText('New chat from Jamie Rivera')
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-pick-portone').click()
      await expect(page.getByTestId('apps-steps')).toContainText('“Payment module V2”')
      await page.getByTestId('apps-safer').locator('summary').click()
      await expect(page.getByTestId('apps-sentry-secret')).toHaveAttribute('placeholder', 'Webhook secret')
    })

    test('presets: cards with their logo and link, a refused secret named per service, the vendor\'s Regenerate warning, switches', async ({ page }) => {
      test.setTimeout(120_000)
      const stripe = mockPreset('stripe', { signed: true, lastRefusal: { at: '2026-11-05T10:57:00.000Z', reason: 'signature' } })
      const shopify = mockPreset('shopify', { eventsSeen: ['order', 'paid'] })
      const notion = mockPreset('notion')
      const messages: MockMessage[] = [
        MESSAGES[0]!,
        { id: '019a5f00-0000-7000-8000-00000000d001', author: MINA, body: '', extra: appMessage(stripe, { kind: 'Payment received', title: '$49.00 from Jamie Rivera', details: ['Pro plan (monthly)'], status: 'Status: Succeeded', link: { url: 'https://dashboard.stripe.com/payments/pi_123', host: 'dashboard.stripe.com' } }) },
        { id: '019a5f00-0000-7000-8000-00000000d002', author: MINA, body: '', extra: appMessage(shopify, { kind: 'New order #1042', title: '86.00 USD · 3 items', details: ['2 × T-shirt · Jamie, Portland https://evil.example.com'], status: 'Status: Paid' }) },
      ]
      const { apps } = await open(page, { size: vp.size, apps: [stripe, shopify, notion], messages })
      const card = page.locator('[data-testid="room-message"][data-app="stripe"]').first()
      await expect(page.locator('[data-testid="app-tile"][data-kind="stripe"]').first().getByTestId('app-logo')).toBeVisible()
      await expect(page.locator('[data-testid="app-tile"][data-kind="shopify"]').first()).toHaveText('S')
      await expect(card.getByTestId('room-app-link')).toContainText('Open in Stripe')
      await expect(card.locator('a')).toHaveCount(1)
      const order = page.locator('[data-testid="room-message"][data-app="shopify"]').first()
      await expect(order.getByTestId('app-card-detail')).toHaveText('2 × T-shirt · Jamie, Portland https://evil.example.com')
      await expect(order.locator('a')).toHaveCount(0)

      await (await menuItem(page)).click()
      await page.getByTestId('apps-list-row').first().click()
      await expect(page.getByTestId('apps-title-kind')).toHaveCount(0)
      await expect(page.getByTestId('apps-warning-refused')).toContainText('Stripe sent a message')
      await expect(page.getByTestId('apps-warning-refused')).toContainText("but the signing secret didn't match. Copy it again from Reveal secret.")
      await page.getByTestId('apps-set-up-again').click()
      await expect(page.getByTestId('apps-guide')).toHaveAttribute('data-kind', 'stripe')
      await page.getByTestId('apps-back').click()
      await expect(page.getByTestId('apps-switch-subscription_new')).toHaveCount(1)
      await page.getByTestId('apps-back').click()
      // Shopify: unsigned with its one action; Regenerate names what Shopify does with the old URL
      await page.getByTestId('apps-list-row').nth(1).click()
      await expect(page.getByTestId('apps-warning-unsigned')).toBeVisible()
      await expect(page.getByTestId('apps-switch-fulfilled')).toHaveCount(1)
      await page.getByTestId('apps-new-address').click()
      await expect(page.getByRole('dialog').last()).toContainText('Shopify deletes a webhook after repeated failures')
      await page.getByRole('button', { name: 'Regenerate', exact: true }).last().click()
      await expect.poll(() => apps.calls).toContain('rotate:app-shopify')
      // the optional events that never arrived (eventsSeen): "Not set up in Shopify", with the way to its step
      await expect(page.getByTestId('apps-switch-paid-not-set-up')).toHaveCount(0)
      await expect(page.getByTestId('apps-switch-order-not-set-up')).toHaveCount(0)
      await expect(page.getByTestId('apps-switch-refund-not-set-up')).toContainText('Not set up in Shopify')
      await page.getByTestId('apps-switch-refund-not-set-up').getByRole('button', { name: 'Show the step' }).click()
      await expect(page.getByTestId('apps-guide')).toHaveAttribute('data-kind', 'shopify')
      await expect(page.getByTestId('apps-step-optional')).toBeInViewport()
      await page.getByTestId('apps-back').click()
      await page.getByTestId('apps-back').click()
      // Notion can't sign: no "Not signed" warning, one switch (none shown), no How to send
      await page.getByTestId('apps-list-row').nth(2).click()
      await expect(page.getByTestId('apps-settings')).toHaveAttribute('data-kind', 'notion')
      await expect(page.getByTestId('apps-warning-unsigned')).toHaveCount(0)
      await expect(page.getByTestId('apps-how-to-send')).toHaveCount(0)
      await page.getByTestId('apps-how-to-connect').click()
      await expect(page.getByTestId('apps-needs')).toHaveText('Needs: a paid Notion plan')
    })

    test('a member sees cards, no ⋯ item, and who to ask', async ({ page }) => {
      await open(page, { size: vp.size, role: 'member', apps: [SENTRY] })
      await page.getByTestId('room-menu').first().click()
      await expect(page.getByTestId('room-menu-pin').or(page.getByTestId('room-menu-unpin'))).toBeVisible()
      await expect(page.getByTestId('room-menu-apps')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await page.mouse.click(5, 5)
      await page.getByTestId('app-sender-button').first().click()
      await expect(page.getByTestId('app-sender-ask')).toHaveText('Ask Mina to change what shows here.')
      await expect(page.getByTestId('app-sender-manage')).toHaveCount(0)
    })

    for (const role of ['owner', 'admin'] as const) {
      test(`no internet address: the ${role}'s words`, async ({ page }) => {
        await open(page, { size: vp.size, available: false, role, messages: MESSAGES.slice(0, 1) })
        await (await menuItem(page)).click()
        await expect(page.getByTestId('apps-no-address')).toContainText('Apps need an outside connection before they can send messages to this team.')
        if (role === 'owner') await expect(page.getByTestId('apps-open-connection')).toHaveText('Turn on connection')
        else await expect(page.getByTestId('apps-no-address-who')).toHaveText('Ask the team owner to turn on the connection.')
        await expect(page.getByTestId('apps-open-connection')).toHaveCount(role === 'owner' ? 1 : 0)
        await expect(page.getByTestId('apps-how-it-works')).toHaveAttribute('href', 'https://ax.trina.app/docs/use/room-apps/')
      })
    }
  })
}
