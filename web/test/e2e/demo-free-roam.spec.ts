// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md): the mock server is no demo server, so here
// GET /api/demo answers like a free-roam instance (kind "freeRoam", used, cap, signupUrl) and GET /api/me like one too:
// `server.dev` false and the feature row all off (server/src/system/deployment.ts FREE_ROAM_OFF), so the app finds the
// demo without the dev flag. At 1440 and 390, light and dark: the sign-in page's one action, the bar and its
// suggestions (in the page's flow, never over the message box), the meter from 80 %, the limit dialog (a bottom sheet on
// a phone) and the message box that stops after it, the hidden AI-account sections and the admin pages' one line.
// FREE_ROAM_SHOTS=<folder> saves a screenshot of each state there.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { DemoInfo } from '@mycel/shared/api'
import { reset } from './helpers'

const BOB = { username: 'bob', password: 'bob password 1' }
const CAP = 300_000
const INFO = (used: number): DemoInfo => ({
  company: 'Steepling', sameQuestion: null, current: 'newHire', network: false, kind: 'freeRoam', used, cap: CAP, signupUrl: 'https://example.com/pricing',
  personas: [{ key: 'newHire', name: 'Bob', team: 'Marketing', intro: 'Your first day at Steepling.', questions: [] }],
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
    await r.fulfill({ response: res, json: me })
  })
}

async function signInAsBob(page: Page) {
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

      test('sign-in: only "Continue as Bob", which asks the gate to sign back in (its start when that fails)', async ({ page }) => {
        await freeRoam(page, { now: 0 })
        const resumed: string[] = []
        await page.route('**/__demo/resume', (r) => { resumed.push(r.request().method()); return r.fulfill({ status: 502, json: { error: { code: 'internal' } } }) })
        await page.route('**/__demo/start', (r) => r.fulfill({ contentType: 'text/html', body: '<p id="gate-start">start</p>' }))
        await page.goto('/login')
        const go = page.getByTestId('free-roam-continue')
        await expect(go).toHaveText('Continue as Bob')
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
        await signInAsBob(page)
        await page.goto('/')
        const bar = page.getByTestId('free-roam-bar')
        await expect(bar).toContainText("You're Bob at Steepling, a made-up company. Try anything.")
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
        await shot(page, `${at}-2-bar`)

        used.now = 250_000
        await page.reload()
        await expect(page.getByTestId('free-roam-meter')).toHaveText('About 20% of your demo AI left')
        await shot(page, `${at}-3-meter`)
      })

      test('a suggestion is sent as a new chat', async ({ page }) => {
        await freeRoam(page, { now: 1_000 })
        await signInAsBob(page)
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
        await signInAsBob(page)
        await page.goto('/')
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText("You've used this demo's AI")
        await expect(dialog).toContainText('Everything you made stays here to look around.')
        await expect(dialog.getByTestId('free-roam-start-free')).toHaveAttribute('href', 'https://example.com/pricing')
        if (width === 390) {
          const d = (await dialog.boundingBox())!
          expect(Math.round(d.y + d.height)).toBeGreaterThanOrEqual(840)
        }
        await shot(page, `${at}-4-limit`)
        await dialog.getByTestId('free-roam-look-around').click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.getByTestId('free-roam-out')).toContainText("You've used this demo's AI.")
        await page.getByTestId('composer-input').fill('Hello')
        await expect(page.getByTestId('send')).toBeDisabled()
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
        await signInAsBob(page)
        await page.goto('/settings')
        await expect(page.getByTestId('settings-dialog')).toBeVisible()
        for (const id of ['usage', 'providers', 'ai-apps', 'dev-env-sites']) await expect(page.locator(`[href="/settings/${id}"]`)).toHaveCount(0)
        await expect(page.locator('[href="/settings/profile"]').first()).toBeVisible()
        await shot(page, `${at}-6-settings`)
        await page.goto('/admin/settings/dev-env')
        await expect(page.getByTestId('free-roam-unavailable')).toHaveText("The dev environment isn't available in the demo.")
        await page.goto('/admin')
        await expect(page.getByTestId('free-roam-unavailable')).toHaveText('Not available in the demo')
        await shot(page, `${at}-7-admin`)
      })
    })
  }
}
