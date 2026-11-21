// A free-roam demo on screen (docs/decisions/20261119-demo-free-roam-web.md): the mock server is no demo server, so here
// GET /api/demo answers like a free-roam instance (kind "freeRoam", used, cap, signupUrl) and GET /api/me like one too:
// `server.dev` false and the feature row all off (server/src/system/deployment.ts FREE_ROAM_OFF), so the app finds the
// demo without the dev flag. At 1440 and 390, light and dark: the sign-in page's one action, the bar (in the page's flow,
// never over the message box; at most two lines on a 390 px phone in every language), its quiet Start free and its
// practice label (a tap opens the whole sentence), the suggestions under Home's box (not in the bar), the count in
// questions to the end, the limit dialog (a bottom sheet on a phone, opened on Start free) and the message box that
// stops after it, a new visitor's `?fresh=1` (the previous visitor's drafts go), the hidden sections (AI accounts,
// Security & devices, Apps, push, Scheduled, invites), the read-only profile and connectors, no mic, and the admin
// pages' one line with Back to Home (QA 2026-11-22). The visitor reads as the snapshot's: Mina at Steepling (the
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

      test('the bar: who you are, the questions left, practice, Start free; the suggestions under Home\'s box', async ({ page }) => {
        const used = { now: 1_000 }
        await freeRoam(page, used)
        await signInAsMina(page)
        await page.goto('/')
        const bar = page.getByTestId('free-roam-bar')
        await expect(page.getByTestId('free-roam-who')).toHaveText("You're Mina at Steepling, a made-up company.")
        // how much they can still ask, in questions: floor((300k - 1k) / 35k)
        await expect(page.getByTestId('free-roam-left')).toHaveText('About 8 questions left')
        await expect(page.getByTestId('free-roam-practice')).toHaveText('Gmail, Drive, Higgsfield: practice only')
        // one quiet Start free, a link to the sign-up address in a new tab (owner, QA 2026-11-22 F8)
        const start = page.getByTestId('free-roam-bar-start-free')
        await expect(start).toHaveText('Start free')
        await expect(start).toHaveAttribute('href', 'https://example.com/pricing')
        await expect(start).toHaveAttribute('target', '_blank')
        if (width === 1440) await expect(page.getByTestId('sidebar-team')).toHaveText('Steepling')
        // no mic in the box (voice is fenced), though the team's voice input is on
        await expect(page.getByTestId('voice-button')).toHaveCount(0)
        // no Scheduled in the Trina panel (a computer; a phone's drawer has the same condition)
        if (width === 1440) {
          await expect(page.getByTestId('trina-panel').getByTestId('nav-skills')).toBeVisible()
          await expect(page.getByTestId('nav-scheduled')).toHaveCount(0)
        }
        // the suggestions: on Home, not in the bar (owner, QA 2026-11-22 F9)
        await expect(page.getByTestId('free-roam-chip')).toHaveCount(3)
        await expect(bar.getByTestId('free-roam-chip')).toHaveCount(0)
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
        // one line on a computer, 56 px at most on a phone (it was 120 to 145 px with the chips)
        expect(b.height).toBeLessThanOrEqual(width === 1440 ? 24 : 56)
        // Start free at the end of its line
        const s = (await start.boundingBox())!
        expect(s.x + s.width).toBeGreaterThan(b.x + b.width - 24)
        // the chips: under the box on a computer (a phone docks the box at the bottom, the suggestions over it, as Home's
        // other suggestions); each whole inside the width, tall enough to tap on a phone
        const chips = await page.getByTestId('free-roam-chip').all()
        for (const c of chips) {
          const r = (await c.boundingBox())!
          expect(r.x).toBeGreaterThanOrEqual(0)
          expect(r.x + r.width).toBeLessThanOrEqual(width + 0.5)
          if (width === 1440) expect(r.y).toBeGreaterThan(box.y + box.height - 1)
          else expect(r.height).toBeGreaterThanOrEqual(32)
        }
        await shot(page, `${at}-2-bar`)
        // another screen: no chips there
        await page.goto('/files')
        await expect(page.getByTestId('free-roam-bar')).toBeVisible()
        await expect(page.getByTestId('free-roam-chip')).toHaveCount(0)

        // in questions right to the end, never a %
        used.now = 255_000
        await page.goto('/')
        await expect(page.getByTestId('free-roam-left')).toHaveText('About 1 question left')
        used.now = 297_000
        await page.reload()
        await expect(page.getByTestId('free-roam-left')).toHaveText('Almost out of questions')
        await expect(bar).not.toContainText('%')
        await shot(page, `${at}-3-almost-out`)
      })

      test('the practice label: a tap or click opens the whole sentence, a tap outside or Esc closes it', async ({ page }) => {
        await freeRoam(page, { now: 1_000 })
        await signInAsMina(page)
        await page.goto('/')
        const label = page.getByTestId('free-roam-practice')
        await expect(label).toHaveAttribute('aria-expanded', 'false')
        await label.click()
        const tip = page.getByTestId('free-roam-practice-tip')
        await expect(tip).toHaveText('Gmail, Google Drive and Higgsfield here are practice copies: mail is never really sent, and new pictures come from a prepared set.')
        // inside the screen, over the page (not pushing the bar taller)
        const r = (await tip.boundingBox())!
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.x + r.width).toBeLessThanOrEqual(width + 0.5)
        await shot(page, `${at}-2b-practice`)
        await page.keyboard.press('Escape')
        await expect(tip).toHaveCount(0)
        await expect(label).toBeFocused()
        await label.click()
        await expect(tip).toBeVisible()
        await page.getByTestId('composer-input').click()
        await expect(tip).toHaveCount(0)
      })

      test('Home shows no My setup card, even when the server has one (QA TC-6473)', async ({ page }) => {
        for (const locale of ['en', 'ko'] as const) {
          if (locale !== 'en') await reset(page, { teamLocale: locale, usersFollowTeam: true })
          await freeRoam(page, { now: 1_000 })
          // what a free-roam server sends (server/src/onboarding/member-welcome.ts): demo, tools sent done
          const seeded = await page.request.post('/__test/member-welcome', { headers: { 'x-mycel-csrf': '1' }, data: { welcome: {
            kind: 'member', team: 'Steepling', inviter: { id: 'olga', name: 'Sara Lee' }, people: 6, rooms: [{ id: '01900000-0000-7000-8000-0000000000a1', kind: 'all', name: null }],
            owner: { id: 'olga', name: 'Sara Lee' }, steps: { rooms: true, hi: true, photo: false, asked: false, tools: true }, allSet: false, demo: true,
          } } })
          expect(seeded.ok()).toBeTruthy()
          await signInAsMina(page)
          await page.goto('/')
          await expect(page.getByTestId('free-roam-bar')).toBeVisible()
          await expect(page.getByTestId('composer-input')).toBeVisible()
          // a demo's Home keeps its own top (pages/Home.tsx `extras`): no card, so no "Connect your tools" and no
          // desktop app row
          await expect(page.getByTestId('member-welcome')).toHaveCount(0)
          await expect(page.getByTestId('member-welcome-tools')).toHaveCount(0)
          await expect(page.getByTestId('member-welcome-open-app')).toHaveCount(0)
          await shot(page, `${at}-${locale}-home-no-welcome-card`)
        }
      })

      test('the bar in Korean: the questions left, within the width', async ({ page }) => {
        await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
        await freeRoam(page, { now: 1_000 })
        await signInAsMina(page)
        await page.goto('/')
        const bar = page.getByTestId('free-roam-bar')
        await expect(page.getByTestId('free-roam-left')).toHaveText('질문 8번 정도 남았어요')
        const b = (await bar.boundingBox())!
        expect(b.x + b.width).toBeLessThanOrEqual(width + 0.5)
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        for (const c of await page.getByTestId('free-roam-chip').all()) {
          const r = (await c.boundingBox())!
          expect(r.x + r.width).toBeLessThanOrEqual(width + 0.5)
        }
        await shot(page, `${at}-2-bar-ko`)
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
        await expect(dialog).toContainText("You've used all your questions")
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
        await expect(page.getByTestId('free-roam-out')).toContainText("You've used all your questions. You can still look around everything here.")
        // out: no count and no second Start free in the bar (the line under the box has its own)
        await expect(page.getByTestId('free-roam-left')).toHaveCount(0)
        await expect(page.getByTestId('free-roam-bar-start-free')).toHaveCount(0)
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
        // never a dead end (QA 2026-11-22 F20)
        await page.getByTestId('free-roam-back-home').click()
        await expect(page).toHaveURL(/\/$/)
        await expect(page.getByTestId('composer-input')).toBeVisible()
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

      test('a new visitor (?fresh=1): the previous visitor\'s drafts and queued sends go before anything shows; the address loses it', async ({ page }) => {
        await freeRoam(page, { now: 1_000 })
        await signInAsMina(page)
        await page.goto('/')
        await expect(page.getByTestId('composer-input')).toBeVisible()
        // the previous visitor of this browser: the same user id on every copy
        const id = await page.evaluate(async () => (await (await fetch('/api/me', { credentials: 'same-origin' })).json()).user.id as string)
        await page.getByTestId('composer-input').fill('the last visitor\'s unsent words')
        await page.evaluate((uid) => {
          localStorage.setItem(`mycel.queue:${uid}:01900000-0000-7000-8000-0000000000c1`, '{"items":[]}')
          sessionStorage.setItem(`mycel.chips:${uid}:new`, '[]')
          sessionStorage.setItem('mycel.demo.limitSeen', '1')
        }, id)
        await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mycel.draft:')).length)).toBeGreaterThan(0)
        // a reload alone keeps them (the same visitor)
        await page.reload()
        await expect(page.getByTestId('composer-input')).toHaveValue('the last visitor\'s unsent words')
        // the gate's new start
        await page.goto('/?fresh=1')
        await expect(page.getByTestId('composer-input')).toBeVisible()
        await expect(page.getByTestId('composer-input')).toHaveValue('')
        expect(new URL(page.url()).search).toBe('')
        const left = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => /^mycel\.(draft|queue|chips|demo)/.test(k)))
        expect(left).toEqual([])
      })
    })
  }
}

// The bar on a 390 px phone in every language of the demo (QA 2026-11-22 M6): 56 px at most, measured in the browser.
// Two rows cannot hold who you are, the count, the practice label and Start free in es and id (who you are alone is
// 316-323 px of the 366 px), and ", a made-up company" is never cut, so three short rows: who you are; the count and
// Start free; the practice label. A touch screen opens the practice sentence with a tap.
test.describe('390 px phone, every language', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const MADE_UP: Record<string, string> = { en: 'a made-up company', ko: '가상 회사', ja: '架空の会社', zh: '虚构公司', es: 'una empresa inventada', id: 'perusahaan rekaan' }
  for (const locale of ['en', 'ko', 'ja', 'zh', 'es', 'id'] as const) {
    test(`${locale}: the bar is 56 px at most, three short rows; a tap opens the practice sentence`, async ({ page }) => {
      await reset(page, { teamLocale: locale, usersFollowTeam: true })
      await freeRoam(page, { now: 1_000 })
      await signInAsMina(page)
      await page.goto('/')
      const bar = page.getByTestId('free-roam-bar')
      await expect(page.getByTestId('free-roam-left')).toBeVisible()
      await expect(page.getByTestId('free-roam-who')).toContainText(MADE_UP[locale]!)
      const b = (await bar.boundingBox())!
      expect(b.height, `${locale} bar ${b.height}px`).toBeLessThanOrEqual(56)
      expect(b.x + b.width).toBeLessThanOrEqual(390.5)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
      // who you are on one row of its own; the count and Start free share the next; the practice label the last
      const who = (await page.getByTestId('free-roam-who').boundingBox())!
      expect(who.height, `${locale} who`).toBeLessThanOrEqual(17)
      const left = (await page.getByTestId('free-roam-left').boundingBox())!
      const start = (await page.getByTestId('free-roam-bar-start-free').boundingBox())!
      const practice = (await page.getByTestId('free-roam-practice').boundingBox())!
      expect(left.y, locale).toBeGreaterThan(who.y + 8)
      expect(Math.abs((start.y + start.height / 2) - (left.y + left.height / 2)), locale).toBeLessThan(6)
      expect(start.x + start.width, locale).toBeGreaterThan(390 - 24)
      expect(practice.y, locale).toBeGreaterThan(left.y + 8)
      expect(practice.height, `${locale} practice`).toBeLessThanOrEqual(17)
      if (shots && (locale === 'en' || locale === 'ko')) await shot(page, `390-touch-${locale}-bar`)
      await page.getByTestId('free-roam-practice').tap()
      await expect(page.getByTestId('free-roam-practice-tip')).toBeVisible()
      const tip = (await page.getByTestId('free-roam-practice-tip').boundingBox())!
      expect(tip.x).toBeGreaterThanOrEqual(0)
      expect(tip.x + tip.width).toBeLessThanOrEqual(390.5)
      if (shots && (locale === 'en' || locale === 'ko')) await shot(page, `390-touch-${locale}-practice`)
      // a tap outside closes it
      await page.getByTestId('composer-input').tap()
      await expect(page.getByTestId('free-roam-practice-tip')).toHaveCount(0)
    })
  }
})
