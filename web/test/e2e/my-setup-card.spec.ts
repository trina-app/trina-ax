// "My setup" (docs/decisions/20261120-my-setup-card.md; components/onboarding/MemberWelcome.tsx, MyToolsRow.tsx):
// Home's top shows one card at a time for the owner (the team setup's "Continue setup" while it is unfinished, on a
// computer too; then their own My setup card; then the 7-day goal once that is hidden or done), and a member who joins
// sees My setup first. The card's rows: the owner's three (tools, photo, the desktop app), a member's with hi and ask;
// the rooms as one line under the title; "Connect your tools" with its own [Connect] per tool; Hide and Settings ›
// Profile's way back; "You're all set" a few seconds, then gone. The mock makes no card by itself (the server makes the
// owner's at the setup's end: tests/unit/b-member-welcome.test.ts): each test seeds it. Screenshots at 1440 and 390
// when MY_SETUP_SHOTS names a folder.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, type MemberWelcome } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const dir = process.env.MY_SETUP_SHOTS
const EVERYONE = '01900000-0000-7000-8000-0000000000a1'

async function call(page: Page, method: 'POST' | 'PATCH', path: string, data: unknown = {}) {
  const r = await page.request.fetch(path, { method, headers: H, data })
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}
const goal = () => {
  const start = Date.now() - 86_400_000
  return { goal: { state: 'open', target: 3, days: 7, startedAt: new Date(start).toISOString(), endsAt: new Date(start + 7 * 86_400_000).toISOString(), daysLeft: 6, skill: null, reachedAt: null, joined: 0, waiting: null } }
}
const card = (over: Partial<MemberWelcome> = {}): MemberWelcome => ({
  kind: 'member', team: 'Acme', inviter: { id: 'olga', name: 'Olga Berg' }, people: 4,
  rooms: [{ id: EVERYONE, kind: 'all', name: null }], owner: { id: 'olga', name: 'Olga Berg' },
  steps: { rooms: true, hi: false, photo: false, asked: false, tools: false }, allSet: false, ...over,
})
const seed = (page: Page, welcome: MemberWelcome | null) => call(page, 'POST', '/__test/member-welcome', { welcome })
/** This server with Google Drive and the Google apps set up (the mock has neither): Gmail open, Calendar connected by
 * the team for everyone, Docs and Sheets off */
async function withGoogle(page: Page) {
  await page.route('**/api/integrations/google-drive', (r) => r.fulfill({ json: { configured: true, status: 'disconnected', account: null, scopes: [], expiresAt: null, personalAllowed: true, teamShares: [] } }))
  const app = (id: string, o: Record<string, unknown> = {}) => ({ id, available: true, reason: null, status: 'disconnected', account: null, writePolicy: 'ask', serviceDown: false, tools: [], shared: null, ...o })
  await page.route('**/api/integrations/google-apps', (r) => r.fulfill({ json: { apps: [
    app('gmail'), app('calendar', { shared: { id: 'team-cal', account: { email: 'team@acme.example', name: 'Acme' }, status: 'connected', alwaysAllowed: false } }),
    app('docs', { available: false, reason: 'not_set_up' }), app('sheets', { available: false, reason: 'not_set_up' }),
  ] } }))
}
const rows = (page: Page) => page.getByTestId('member-welcome-rows').locator(':scope > li').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))

for (const width of [1440, 390] as const) {
  test.describe(`${width}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: 'en-US' })
    // Home scrolls inside itself: a phone's shot takes a taller window so the whole card is in it
    const shot = async (page: Page, name: string) => {
      if (!dir) return
      if (width === 390) await page.setViewportSize({ width, height: 1500 })
      await page.screenshot({ path: `${dir}/${width}-${name}.png`, fullPage: true })
      if (width === 390) await page.setViewportSize({ width, height: 844 })
    }

    test('the owner: Continue setup while it is unfinished, then My setup, then the goal; Hide and Settings › Profile bring it back', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await call(page, 'POST', '/api/onboarding/welcome/team')
      await call(page, 'POST', '/__test/team-goal', goal())
      // the setup unfinished: opening the app lands on the steps (once); ‹ (a phone) or Ask Trina (the list panel) leads
      // to Home, whose top row is the setup's
      await page.goto('/')
      await expect(page).toHaveURL(/\/welcome/)
      if (width === 390) await page.getByTestId('welcome-bar-back').click()
      else await page.getByRole('button', { name: /Ask Trina/ }).first().click()
      await expect(page).toHaveURL(/\/$/)
      await expect(page.getByTestId('home-top').getByTestId('welcome-resume')).toBeVisible()
      await expect(page.getByTestId('welcome-resume-text')).toContainText('Continue setup')
      await expect(page.getByTestId('team-goal')).toHaveCount(0)
      // one way back on Home, not two: the list panel's row hides here (on a computer it stays on other pages)
      await expect(page.getByTestId('setup-row')).toHaveCount(0)
      await shot(page, 'owner-0-setup-unfinished')

      // the setup's end screen: the owner's own card (the server makes it then)
      await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
      await seed(page, card({ kind: 'owner', inviter: null }))
      await withGoogle(page)
      await page.goto('/')
      const c = page.getByTestId('member-welcome')
      await expect(c).toBeVisible()
      await expect(c).toHaveAttribute('data-kind', 'owner')
      await expect(page.getByTestId('member-welcome-title')).toHaveText('Now your own setup, Olga')
      await expect(page.getByTestId('member-welcome-line')).toHaveText('The team is set up. These are just for you.')
      await expect(page.getByTestId('member-welcome-progress')).toHaveText('Only you see this')
      expect(await rows(page)).toEqual(['member-welcome-tools', 'member-welcome-photo', 'member-welcome-files'])
      // this browser (Windows): the files row opens the desktop app
      await expect(page.getByTestId('member-welcome-files')).toContainText('Open the desktop app')
      await expect(page.getByTestId('member-welcome-open-app')).toHaveAttribute('href', '/open-app')
      await expect(page.getByTestId('my-tools')).toBeVisible()
      await expect(page.getByTestId('my-tools-item').first()).toBeVisible()
      await expect(page.getByTestId('team-goal')).toHaveCount(0)
      await expect(page.getByTestId('welcome-resume')).toHaveCount(0)
      await page.getByTestId('home-scroll').evaluate((el) => { el.scrollTop = 0 })
      await shot(page, 'owner-1-my-setup')

      // Hide: the goal card is the one thing now
      await page.getByTestId('member-welcome-hide').click()
      await expect(c).toHaveCount(0)
      await expect(page.getByTestId('team-goal')).toBeVisible()
      // Settings › Profile brings it back
      await page.goto('/settings/profile')
      await expect(page.getByTestId('profile-my-setup-show')).toHaveText('Show my setup on Home again')
      await page.getByTestId('profile-my-setup-show').click()
      await expect(page.getByTestId('profile-my-setup')).toHaveCount(0)
      await page.goto('/')
      await expect(page.getByTestId('member-welcome')).toHaveAttribute('data-kind', 'owner')
      await expect(page.getByTestId('team-goal')).toHaveCount(0)
    })

    test('a member who joins sees My setup first: the rooms in one line, tools first, each with its own Connect', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await seed(page, card())
      await withGoogle(page)
      await signIn(page, BOB)
      const c = page.getByTestId('member-welcome')
      await expect(c).toBeVisible()
      await expect(c).toHaveAttribute('data-kind', 'member')
      // the usual tools (the team chose none): Drive, Gmail, Calendar (the team's, for everyone: no button), Notion
      await expect(page.getByTestId('my-tools-item')).toHaveCount(4)
      expect(await page.getByTestId('my-tools-item').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-id')}:${e.getAttribute('data-state')}`))).toEqual(['google-drive:open', 'gmail:open', 'calendar:team', 'notion:open'])
      await expect(page.getByTestId('my-tools-team')).toHaveText('Team connected')
      await expect(page.getByTestId('member-welcome-line')).toHaveText("Olga Berg invited you · 4 people are here · You're in Everyone")
      await expect(page.getByTestId('member-welcome-rooms')).toHaveAttribute('href', '/rooms')
      await expect(page.getByTestId('member-welcome-progress')).toHaveText('Get started · 0 of 3')
      expect(await rows(page)).toEqual(['member-welcome-tools', 'member-welcome-hi', 'member-welcome-photo', 'member-welcome-ask', 'member-welcome-files'])
      // every tool has its own Connect (or says it is connected)
      const items = page.getByTestId('my-tools-item')
      await expect(items.first()).toBeVisible()
      for (const li of await items.all()) await expect(li.getByTestId('my-tools-connect').or(li.getByTestId('my-tools-mine')).or(li.getByTestId('my-tools-team'))).toHaveCount(1)
      await expect(page.getByTestId('team-prepared')).toHaveCount(0)
      await page.getByTestId('home-scroll').evaluate((el) => { el.scrollTop = 0 })
      await shot(page, 'member-1-my-setup')
      // the full list: Settings › Connectors
      await page.getByTestId('my-tools-more').click()
      await expect(page).toHaveURL(/\/settings\/connectors$/)
    })

    test('all rows done: "You\'re all set" a few seconds, then gone', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await seed(page, card({ steps: { rooms: true, hi: true, photo: false, asked: true, tools: true }, allSet: true }))
      await signIn(page, BOB)
      const c = page.getByTestId('member-welcome')
      await expect(c).toHaveAttribute('data-state', 'all-set')
      await expect(c).toContainText("You're all set")
      await expect(c).toHaveCount(0, { timeout: 10_000 })
    })
  })
}
