// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md): the mock server is no demo server, so here
// GET /api/demo answers like a free-roam instance (kind "freeRoam", used, cap, signupUrl) and GET /api/me like one too:
// `server.dev` false and the feature row all off (server/src/system/deployment.ts FREE_ROAM_OFF), so the app finds the
// demo without the dev flag. At 1440 and 390, light and dark: the sign-in page's one action, the bar and its
// suggestions (in the page's flow, never over the message box; on a phone the row's edge fades while more is past it),
// the meter from 80 %, the limit dialog (a bottom sheet on a phone, opened on Start free) and the message box that stops
// after it, the hidden sections (AI accounts, Security & devices, Apps, push, Scheduled, invites), the read-only profile
// and connectors, no mic, and the admin pages' one line. The visitor reads as the snapshot's: Mina at Steepling (the
// mock's Bob and its team are renamed here, so the screenshots say what a visitor sees).
// FREE_ROAM_SHOTS=<folder> saves a screenshot of each state there.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { DemoInfo } from '@mycel/shared/api'
import { reset } from './helpers'

/** the mock's member account, shown as the snapshot's person (scripts/demo/steepling: Mina at Steepling) */
const BOB = { username: 'bob', password: 'bob password 1' }
const CAP = 300_000
const INFO = (used: number): DemoInfo => ({
  company: 'Steepling', sameQuestion: null, current: 'newHire', network: false, kind: 'freeRoam', used, cap: CAP, signupUrl: 'https://example.com/pricing',
  personas: [{ key: 'newHire', name: 'Mina', team: 'Marketing', intro: 'Your first day at Steepling.', questions: [] }],
  // the demo content's chips (GET /api/demo freeRoam.suggestions): a short label, a longer prompt it sends
  freeRoam: { suggestions: [
    { label: "Make next week's social posts", prompt: "Use our 3 social post options skill to make next week's posts" },
    { label: "Check Chris's reply", prompt: "Did Chris reply to the banner mail? What did he say?" },
    { label: "What's in Brand assets?", prompt: "What's in our Brand assets folder?" },
  ] },
})
const FEATURES_OFF = { connectionChange: false, selfUpdate: false, officeUpdate: false, connectedFolders: false, apiEngineAnyUrl: false, hostDiagnostics: false, pluginFileInstall: false }
const shots = process.env.FREE_ROAM_SHOTS

/** the mock answers as a free-roam instance; `used` is what GET /api/demo says each time it is asked */
async function freeRoam(page: Page, used: { now: number }) {
  await page.route('**/api/demo', (r) => r.fulfill({ json: INFO(used.now) }))
  await page.route('**/api/me', async (r) => {
    const res = await r.fetch()
    if (!res.ok()) return r.fulfill({ response: res })
    const me = await res.json()
    me.server = { ...me.server, dev: false, deployment: 'self', features: FEATURES_OFF }
    // the snapshot's names (the mock's are Bob and its own team); voice input on, so a hidden mic is the demo's doing
    me.user = { ...me.user, username: 'mina', name: 'Mina', email: 'mina@steepling.example' }
    me.team = { ...me.team, name: 'Steepling', voiceInput: true }
    await r.fulfill({ response: res, json: me })
  })
  // the snapshot's connected service beside the mock's list (the fakes answer it: server/src/demo/fakes/higgsfield.ts)
  await page.route('**/api/integrations', async (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    const res = await r.fetch()
    if (!res.ok()) return r.fulfill({ response: res })
    const list = await res.json()
    const at = '2026-11-19T03:00:00.000Z'
    list.items = [...list.items, {
      id: 'demo-higgsfield', scope: 'personal', kind: 'mcp', name: 'Higgsfield', slug: 'higgsfield', url: 'https://mcp.higgsfield.ai/mcp', auth: 'oauth', authHeader: null,
      hasSecret: true, account: 'team@steepling.example', notes: null, writePolicy: 'ask', status: 'connected', lastError: null, tools: [], toolsUpdatedAt: at,
      access: null, createdBy: { id: 'bob', name: 'Mina' }, createdAt: at, updatedAt: at, lastUsedAt: null, canManage: true,
    }]
    await r.fulfill({ response: res, json: list })
  })
}

async function signInAsMina(page: Page) {
  const login = await page.request.post('/api/auth/login', { headers: { 'x-mycel-csrf': '1' }, data: { ...BOB, tokenMode: 'cookie' } })
  expect(login.ok()).toBeTruthy()
}

async function shot(page: Page, name: string) {
  if (!shots) return
  fs.mkdirSync(shots, { recursive: true })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(shots, `${name}.png`) })
}

for (const width of [1440, 390] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    const at = `${width}-${scheme}`
    test.describe(at, () => {
      test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.emulateMedia({ colorScheme: scheme })
        await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      })

      test('sign-in: only "Continue as Mina", which asks the gate to sign back in (its start when that fails)', async ({ page }) => {
        await freeRoam(page, { now: 0 })
        const resumed: string[] = []
        await page.route('**/__demo/resume', (r) => { resumed.push(r.request().method()); return r.fulfill({ status: 502, json: { error: { code: 'internal' } } }) })
        await page.route('**/__demo/start', (r) => r.fulfill({ contentType: 'text/html', body: '<p id="gate-start">start</p>' }))
        await page.goto('/login')
        const go = page.getByTestId('free-roam-continue')
        await expect(go).toHaveText('Continue as Mina')
        await expect(page.getByTestId('login-username')).toHaveCount(0)
        await expect(page.getByTestId('demo-start')).toHaveCount(0)
        await shot(page, `${at}-1-sign-in`)
        await go.click()
        await expect(page).toHaveURL(/\/__demo\/start$/)
        expect(resumed).toEqual(['POST'])
      })

      test('the bar: who you are and the suggestions, above the message box; the meter from 80 %', async ({ page }) => {
        const used = { now: 1_000 }
        await freeRoam(page, used)
        await signInAsMina(page)
        await page.goto('/')
        const bar = page.getByTestId('free-roam-bar')
        await expect(bar).toContainText("You're Mina at Steepling, a made-up company. Try anything.")
        if (width === 1440) await expect(page.getByTestId('sidebar-team')).toHaveText('Steepling')
        // no mic in the box (voice is fenced), though the team's voice input is on
        await expect(page.getByTestId('voice-button')).toHaveCount(0)
        // no Scheduled in the Trina panel (a computer; a phone's drawer has the same condition)
        if (width === 1440) {
          await expect(page.getByTestId('trina-panel').getByTestId('nav-skills')).toBeVisible()
          await expect(page.getByTestId('nav-scheduled')).toHaveCount(0)
        }
        await expect(page.getByTestId('free-roam-chip')).toHaveCount(3)
        await expect(page.getByTestId('free-roam-meter')).toHaveCount(0)
        // no DEV banner, no person switcher
        await expect(page.getByTestId('dev-banner')).toHaveCount(0)
        await expect(page.getByTestId('demo-switch')).toHaveCount(0)
        // in the page: within the width, never over the message box
        const b = (await bar.boundingBox())!
        expect(b.x).toBeGreaterThanOrEqual(0)
        expect(b.x + b.width).toBeLessThanOrEqual(width + 0.5)
        const box = (await page.getByTestId('composer-input').boundingBox())!
        expect(b.y + b.height).toBeLessThanOrEqual(box.y)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        // a chip: tall enough to tap on a phone
        if (width === 390) expect((await page.getByTestId('free-roam-chip').first().boundingBox())!.height).toBeGreaterThanOrEqual(32)
        // a phone: the row scrolls sideways and its edge fades while more chips are past it, until its end
        const row = page.getByTestId('free-roam-chips')
        if (width === 390) {
          await expect(row).toHaveAttribute('data-more', 'true')
          expect(await row.evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage)).toContain('gradient')
          await row.evaluate((el) => { el.scrollLeft = el.scrollWidth })
          await expect(row).not.toHaveAttribute('data-more')
          await row.evaluate((el) => { el.scrollLeft = 0 })
          await expect(row).toHaveAttribute('data-more', 'true')
        } else {
          await expect(row).not.toHaveAttribute('data-more')
        }
        await shot(page, `${at}-2-bar`)

        used.now = 250_000
        await page.reload()
        await expect(page.getByTestId('free-roam-meter')).toHaveText('About 20% of your demo AI left')
        await shot(page, `${at}-3-meter`)
      })

      test('a suggestion is sent as a new chat', async ({ page }) => {
        await freeRoam(page, { now: 1_000 })
        await signInAsMina(page)
        await page.goto('/')
        const chip = page.getByTestId('free-roam-chip').nth(1)
        await expect(chip).toHaveText("Check Chris's reply")
        await chip.click()
        await expect(page).toHaveURL(/\/c\/[0-9a-f-]+/)
        // the chip's prompt is what goes, not its short label
        await expect(page.getByTestId('user-message').first()).toContainText('Did Chris reply to the banner mail? What did he say?')
      })

      test('at the limit: the dialog (a bottom sheet on a phone), then the box stops with one line', async ({ page }) => {
        await freeRoam(page, { now: CAP })
        await signInAsMina(page)
        await page.goto('/')
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText("You've used this demo's AI")
        await expect(dialog).toContainText('Everything you made stays here to look around.')
        await expect(dialog.getByTestId('free-roam-start-free')).toHaveAttribute('href', 'https://example.com/pricing')
        if (width === 390) {
          const d = (await dialog.boundingBox())!
          expect(Math.round(d.y + d.height)).toBeGreaterThanOrEqual(840)
        }
        // it opens on its one action, Start free, and no tooltip pops up (✕ is not where it starts)
        await expect(dialog.getByTestId('free-roam-start-free')).toBeFocused()
        await page.waitForTimeout(700)
        await expect(page.getByRole('tooltip')).toHaveCount(0)
        await shot(page, `${at}-4-limit`)
        await dialog.getByTestId('free-roam-look-around').click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.getByTestId('free-roam-out')).toContainText("You've used this demo's AI.")
        // the box takes no more words for the AI, and send looks and is off
        const input = page.getByTestId('composer-input')
        await expect(input).toHaveAttribute('readonly', '')
        await expect(input).toHaveAttribute('aria-disabled', 'true')
        // (aria-disabled: Playwright would not click it) typing goes nowhere
        await input.focus()
        await page.keyboard.type('Hello')
        await expect(input).toHaveValue('')
        await expect(page.getByTestId('send')).toBeDisabled()
        await expect(page.getByTestId('send')).toHaveClass(/text-faint/)
        // no suggestions once the AI is used up
        await expect(page.getByTestId('free-roam-chip')).toHaveCount(0)
        await shot(page, `${at}-5-out`)
        // a reload in the same tab keeps the line, not the dialog
        await page.reload()
        await expect(page.getByTestId('free-roam-out')).toBeVisible()
        await expect(page.getByRole('dialog')).toHaveCount(0)
      })

      test('no AI-account sections in Settings; the admin pages say one line', async ({ page }) => {
        await freeRoam(page, { now: 1_000 })
        await signInAsMina(page)
        await page.goto('/settings')
        await expect(page.getByTestId('settings-dialog')).toBeVisible()
        for (const id of ['usage', 'providers', 'ai-apps', 'dev-env-sites', 'security', 'apps']) await expect(page.locator(`[href="/settings/${id}"]`)).toHaveCount(0)
        await expect(page.locator('[href="/settings/profile"]').first()).toBeVisible()
        // the team's row has no Invite people (a phone's 나 tab)
        await expect(page.getByTestId('settings-invite')).toHaveCount(0)
        await shot(page, `${at}-6-settings`)
        await page.goto('/admin/settings/dev-env')
        await expect(page.getByTestId('free-roam-unavailable')).toHaveText("The dev environment isn't available in the demo.")
        await page.goto('/admin')
        await expect(page.getByTestId('free-roam-unavailable')).toHaveText('Not available in the demo')
        await shot(page, `${at}-7-admin`)
      })

      test('Settings: the profile to read, no account deletion, no push; Security, Apps and Scheduled stay away by address too', async ({ page }) => {
        await freeRoam(page, { now: 1_000 })
        await signInAsMina(page)
        await page.goto('/settings/profile')
        const name = page.getByTestId('profile-name')
        await expect(name).toHaveValue('Mina')
        await expect(name).toHaveAttribute('readonly', '')
        await expect(page.getByTestId('profile-email')).toHaveAttribute('readonly', '')
        await expect(page.getByTestId('profile-title')).toHaveAttribute('readonly', '')
        await expect(page.getByTestId('profile-form')).toContainText('Your name and email belong to the demo and stay as they are.')
        await expect(page.getByTestId('account-deletion-link')).toHaveCount(0)
        await expect(page.getByTestId('account-deletion-keep')).toHaveCount(0)
        await shot(page, `${at}-8-profile`)
        for (const to of ['/settings/account/delete', '/settings/security', '/settings/apps']) {
          await page.goto(to)
          await expect(page).toHaveURL(/\/settings$/)
        }
        await page.goto('/settings/notifications')
        await expect(page.getByTestId('notifications-device')).toBeVisible()
        await expect(page.getByTestId('notification-sound')).toBeVisible()
        await expect(page.getByTestId('push-notifications')).toHaveCount(0)
        await expect(page.getByTestId('notifications-phone')).toHaveCount(0)
        await page.goto('/scheduled')
        await expect(page.getByTestId('free-roam-unavailable')).toHaveText('Not available in the demo')
      })

      test('Connectors: what is connected, to read; nothing to connect, add or open', async ({ page }) => {
        await freeRoam(page, { now: 1_000 })
        await signInAsMina(page)
        await page.goto('/settings/connectors')
        await expect(page.getByTestId('connectors-demo')).toHaveText("These services are connected for the demo. Connecting new ones isn't available here.")
        await expect(page.getByTestId('integration-add')).toHaveCount(0)
        await expect(page.getByTestId('connector-not-listed')).toHaveCount(0)
        await expect(page.getByTestId('connector-discover')).toHaveCount(0)
        // the connected service: a row to read (its status), no button that opens its page
        await expect(page.getByTestId('connected-app')).toHaveCount(1)
        await expect(page.getByTestId('connected-app')).toContainText('Higgsfield')
        await expect(page.getByTestId('connector-row-status')).toHaveText('Connected')
        await expect(page.getByTestId('connector-row-open')).toHaveCount(0)
        await expect(page.getByTestId('template-connect')).toHaveCount(0)
        // no "ask your admin" empty state either
        await expect(page.getByText('Nothing to connect yet')).toHaveCount(0)
        await shot(page, `${at}-9-connectors`)
        // a connector's page by address: back to the list
        await page.goto('/settings/connectors/google-drive')
        await expect(page).toHaveURL(/\/settings\/connectors$/)
      })
    })
  }
}
