// "My setup" (docs/decisions/20261120-my-setup-card.md; components/onboarding/MemberWelcome.tsx, MyToolsRow.tsx):
// Home's top shows one card at a time for the owner (docs/decisions/20261128-owner-personal-onboarding.md: their My
// setup card from day one, the team setup's way back as its first row while the setup is open; the standalone
// "Continue setup" only while no card shows; the 7-day goal once the card is hidden or done), and a member who joins
// sees My setup first. The card's rows: the owner's (tools, ask, photo, the desktop app), a member's with hi; the
// rooms as one line under the title; "Connect your tools" with its own [Connect] per tool; Hide with its undo toast and
// Settings › Profile's way back; "You're all set" a few seconds, then gone. The mock makes no card by itself (the
// server makes the owner's on their first read: tests/unit/b-owner-late-card.test.ts): each test seeds it, setupOpen
// included. Screenshots at 1440 and 390 when MY_SETUP_SHOTS names a folder, and every card state in light and dark
// ("card states").
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

    test('the owner: My setup from day one with the setup row first; Continue → the steps → back; Hide → Undo; hidden → the standalone row', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await call(page, 'POST', '/api/onboarding/welcome/team')
      await call(page, 'POST', '/__test/team-goal', goal())
      await seed(page, card({ kind: 'owner', inviter: null, setupOpen: true }))
      await withGoogle(page)
      // the setup unfinished: opening the app lands on the steps (once); ‹ (a phone) or Ask Trina (the list panel) leads
      // to Home, whose top is the owner's card with the setup's row first
      await page.goto('/')
      await expect(page).toHaveURL(/\/welcome/)
      if (width === 390) await page.getByTestId('welcome-bar-back').click()
      else await page.getByRole('button', { name: /Ask Trina/ }).first().click()
      await expect(page).toHaveURL(/\/$/)
      // 회사 소개 done meanwhile (the steps were seen in this tab: Home stays Home)
      await call(page, 'PATCH', '/api/onboarding/welcome', { step: { id: 'profile', state: 'done' } })
      await page.goto('/')
      const c = page.getByTestId('member-welcome')
      await expect(page.getByTestId('home-top').getByTestId('member-welcome')).toBeVisible()
      await expect(c).toHaveAttribute('data-kind', 'owner')
      await expect(page.getByTestId('member-welcome-title')).toHaveText("Let's get you started, Olga")
      await expect(page.getByTestId('member-welcome-line')).toHaveText('These are just for you.')
      await expect(page.getByTestId('member-welcome-setup-text')).toHaveText(/^Continue team setup · \d\/\d$/)
      await expect(page.getByTestId('member-welcome-progress')).toHaveText('Get started · 0 of 2 required')
      expect(await rows(page)).toEqual(['member-welcome-tools', 'member-welcome-ask', 'member-welcome-photo', 'member-welcome-files'])
      // one thing: no standalone setup row, no list-panel row on Home, no goal, no "Ready in your team"
      await expect(page.getByTestId('welcome-resume')).toHaveCount(0)
      await expect(page.getByTestId('setup-row')).toHaveCount(0)
      await expect(page.getByTestId('team-goal')).toHaveCount(0)
      if (width === 1440) await expect(page.getByTestId('team-prepared')).toHaveCount(0)
      await page.getByTestId('home-scroll').evaluate((el) => { el.scrollTop = 0 })
      await shot(page, 'owner-0-setup-open')
      // Continue → the steps at their step; "나중에 하기"/back → Home and the same card
      await page.getByTestId('member-welcome-setup-button').click()
      await expect(page).toHaveURL(/\/welcome/)
      await page.goBack()
      await expect(page).toHaveURL(/\/$/)
      await expect(page.getByTestId('member-welcome-setup')).toBeVisible()

      // Hide: a toast with Undo, which brings the card back
      await page.getByTestId('member-welcome-hide').click()
      await expect(c).toHaveCount(0)
      const toast = page.getByRole('status').filter({ hasText: 'My setup hidden' })
      await expect(toast).toBeVisible()
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect(c).toBeVisible()
      // hidden for real: the setup's own row is the way back on Home (never lost)
      await page.getByTestId('member-welcome-hide').click()
      await expect(c).toHaveCount(0)
      await expect(page.getByTestId('home-top').getByTestId('welcome-resume')).toBeVisible()
      await expect(page.getByTestId('welcome-resume-text')).toContainText('Continue setup')
    })

    test('the owner after the setup: "Your turn now", tools and ask; Hide → the goal; Settings › Profile brings it back', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await call(page, 'POST', '/api/onboarding/welcome/team')
      await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
      await call(page, 'POST', '/__test/team-goal', goal())
      await seed(page, card({ kind: 'owner', inviter: null }))
      await withGoogle(page)
      await page.goto('/')
      const c = page.getByTestId('member-welcome')
      await expect(c).toBeVisible()
      await expect(c).toHaveAttribute('data-kind', 'owner')
      await expect(page.getByTestId('member-welcome-title')).toHaveText('Your turn now, Olga')
      await expect(page.getByTestId('member-welcome-line')).toHaveText('The team is set up. These are just for you.')
      await expect(page.getByTestId('member-welcome-progress')).toHaveText('Get started · 0 of 2 required')
      await expect(page.getByTestId('member-welcome-setup')).toHaveCount(0)
      expect(await rows(page)).toEqual(['member-welcome-tools', 'member-welcome-ask', 'member-welcome-photo', 'member-welcome-files'])
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
      await expect(page.getByTestId('member-welcome-progress')).toHaveText('Get started · 0 of 3 required')
      expect(await rows(page)).toEqual(['member-welcome-tools', 'member-welcome-hi', 'member-welcome-ask', 'member-welcome-photo', 'member-welcome-files'])
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

// Every state of the owner's and an admin's card (the plan's mockups), in Korean, at 1440 and 390, light and dark: the
// setup open, never opened, both personal rows done while it is open, no AI, the setup over, an admin. Screenshots
// when MY_SETUP_SHOTS names a folder; the checks run either way.
for (const width of [1440, 390] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`card states · ${width} · ${scheme}`, () => {
      test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: 'ko-KR', colorScheme: scheme })
      test('each state', async ({ page }) => {
        const snap = async (name: string) => {
          await page.getByTestId('home-scroll').evaluate((el) => { el.scrollTop = 0 })
          if (!dir) return
          if (width === 390) await page.setViewportSize({ width, height: 1400 })
          await page.screenshot({ path: `${dir}/${width}-${scheme}-${name}.png`, fullPage: true })
          if (width === 390) await page.setViewportSize({ width, height: 844 })
        }
        await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
        await signIn(page)
        await withGoogle(page)
        await call(page, 'POST', '/api/onboarding/welcome/team')
        // the first landing opens the steps once (this tab then stays on Home)
        await page.goto('/')
        await expect(page).toHaveURL(/\/welcome/)
        const open = async (w: MemberWelcome) => {
          await seed(page, w)
          await page.goto('/')
          await expect(page.getByTestId('member-welcome')).toBeVisible()
        }
        const owner = (over: Partial<MemberWelcome> = {}) => card({ kind: 'owner', inviter: null, people: 1, ...over })
        // 1. a setup nobody opened (a server we set up for a customer): "팀 설정 시작하기 · 1/5"
        await open(owner({ setupOpen: true }))
        await expect(page.getByTestId('member-welcome-setup')).toHaveAttribute('data-state', 'start')
        await expect(page.getByTestId('member-welcome-setup-text')).toHaveText(/^팀 설정 시작하기 · 1\/\d$/)
        await expect(page.getByTestId('member-welcome-title')).toHaveText('Olga님, 시작해 볼까요')
        await snap('owner-a-setup-never-opened')
        // 2. the setup under way: "팀 설정 이어서 하기 · 2/5"
        await call(page, 'PATCH', '/api/onboarding/welcome', { step: { id: 'profile', state: 'done' } })
        await open(owner({ setupOpen: true }))
        await expect(page.getByTestId('member-welcome-setup-text')).toHaveText(/^팀 설정 이어서 하기 · 2\/\d$/)
        await snap('owner-b-setup-open')
        // 3. both personal rows done, the setup still open: the card stays for it
        await open(owner({ setupOpen: true, steps: { rooms: true, hi: false, photo: false, asked: true, tools: true } }))
        await expect(page.getByTestId('member-welcome-progress')).toHaveText('내 설정은 다 했어요 · 팀 설정이 남았어요')
        await snap('owner-c-both-done-setup-open')
        // 4. no AI: the AI row first, in the team's words, no setup row, no no-AI line
        await page.route('**/api/me/ai-access', (r) => r.fulfill({ json: { usable: false, action: 'connect_team', requested: false } }))
        await open(owner({ setupOpen: true }))
        await expect(page.getByTestId('member-welcome-rows').locator(':scope > li').first()).toHaveAttribute('data-testid', 'member-welcome-ask')
        await expect(page.getByTestId('member-welcome-ask')).toContainText('AI를 연결하면')
        await expect(page.getByTestId('member-welcome-setup')).toHaveCount(0)
        await expect(page.getByTestId('no-ai-card')).toHaveCount(0)
        await snap('owner-d-no-ai')
        await page.unroute('**/api/me/ai-access')
        // 5. the setup over: "이제 Olga님 차례예요"
        await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
        await open(owner())
        await expect(page.getByTestId('member-welcome-title')).toHaveText('이제 Olga님 차례예요')
        await expect(page.getByTestId('member-welcome-setup')).toHaveCount(0)
        await snap('owner-e-setup-over')
        // 6. an admin made later: the member card, no inviter
        await open(card({ inviter: null }))
        await expect(page.getByTestId('member-welcome-hi')).toBeVisible()
        await snap('admin-f-card')
        // 7. hidden: the toast with Undo
        await page.getByTestId('member-welcome-hide').click()
        await expect(page.getByRole('status').filter({ hasText: '내 설정을 숨겼어요' })).toBeVisible()
        await snap('g-hidden-toast')
      })
    })
  }
}

// Korean at 1440: the owner's card ("이제 {name}님 차례예요") and a member's, for the review's screenshots
test.describe('1440 · ko', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' })
  test('the owner\'s and a member\'s card in Korean', async ({ page }) => {
    await reset(page, { teamLocale: 'ko', usersFollowTeam: true })
    await signIn(page)
    await call(page, 'POST', '/api/onboarding/welcome/team')
    await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
    await seed(page, card({ kind: 'owner', inviter: null }))
    await withGoogle(page)
    await page.goto('/')
    await expect(page.getByTestId('member-welcome-title')).toHaveText('이제 Olga님 차례예요')
    await expect(page.getByTestId('my-tools-item')).toHaveCount(4)
    if (dir) await page.screenshot({ path: `${dir}/1440-ko-owner-my-setup.png`, fullPage: true })
    await seed(page, card())
    await page.context().clearCookies()
    await signIn(page, BOB)
    await expect(page.getByTestId('member-welcome')).toHaveAttribute('data-kind', 'member')
    await expect(page.getByTestId('my-tools-item')).toHaveCount(4)
    if (dir) await page.screenshot({ path: `${dir}/1440-ko-member-my-setup.png`, fullPage: true })
  })
})
