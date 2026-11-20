// Every Home onboarding card can be closed (owner 2026-11-20; components/onboarding/CardHide.tsx): the 7-day goal and
// "Ready in your team" get the member welcome card's quiet "Hide". The hide is kept on the server (prefs.goalCard,
// prefs.preparedCard), so another device (the app, another browser) does not show the card either, and a way back
// brings it: Admin › Home for the goal, Settings › Profile for both. Screenshots at 1440 and 390, light and dark, when
// HOME_CARD_SHOTS names a folder.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { reset, signIn } from './helpers'

const H = { [CSRF_HEADER]: '1' }
const BOB = { username: 'bob', password: 'bob password 1' }
const dir = process.env.HOME_CARD_SHOTS

async function call(page: Page, method: 'POST' | 'PATCH' | 'PUT', path: string, data: unknown = {}) {
  const r = await page.request.fetch(path, { method, headers: H, data })
  expect(r.ok(), `${method} ${path}: ${r.status()}`).toBeTruthy()
  return r.json().catch(() => null)
}
const goal = () => {
  const start = Date.now() - 86_400_000
  return { goal: { state: 'open', target: 3, days: 7, startedAt: new Date(start).toISOString(), endsAt: new Date(start + 7 * 86_400_000).toISOString(), daysLeft: 6, skill: null, reachedAt: null, joined: 0, waiting: null } }
}

for (const width of [1440, 390] as const) for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${width} · ${scheme}`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme, locale: 'en-US' })
    const phone = width === 390
    const shot = async (page: Page, name: string) => { if (dir) await page.screenshot({ path: `${dir}/${width}-${scheme}-${name}.png`, fullPage: true }) }

    test('the goal card: Hide keeps it hidden on every device; Admin › Home and Settings › Profile bring it back', async ({ page, browser }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await call(page, 'POST', '/api/onboarding/welcome/team')
      await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
      await call(page, 'POST', '/__test/team-goal', goal())
      await page.goto('/')
      const card = page.getByTestId('team-goal')
      await expect(card).toBeVisible()
      // on a phone the card is one row: its Hide is with the next step under it
      if (phone) await page.getByTestId('team-goal-toggle').click()
      const hide = page.getByTestId('team-goal-hide')
      await expect(hide).toHaveText('Hide')
      await expect(hide).toHaveAttribute('aria-label', 'Hide the team goal')
      await shot(page, 'goal-1-card')
      await hide.click()
      await expect(card).toHaveCount(0)
      await expect(page.getByText('Team goal hidden. Show it again in Settings › Profile.')).toBeVisible()
      // kept on the server: another sign-in (the app, another browser) does not show it
      const me = await (await page.request.get('/api/me')).json()
      expect(me.user.prefs.goalCard).toBe('hidden')
      const other = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: scheme, locale: 'en-US' })
      const p2 = await other.newPage()
      await signIn(p2)
      await expect(p2.getByTestId('composer-input')).toBeVisible()
      await expect(p2.getByTestId('team-goal')).toHaveCount(0)
      // the way back: Admin › Home (where the owner checklist is) on a computer, Settings › Profile everywhere
      if (!phone) {
        await p2.goto('/admin')
        await expect(p2.getByTestId('admin-home-cards-goalCard')).toHaveText('Show the team goal on Home again')
        await shot(p2, 'goal-2-admin-home-show-again')
      }
      await p2.goto('/settings/profile')
      await expect(p2.getByTestId('profile-home-cards-goalCard')).toBeVisible()
      await shot(p2, 'goal-3-settings-show-again')
      await p2.getByTestId('profile-home-cards-goalCard').click()
      await expect(p2.getByTestId('profile-home-cards')).toHaveCount(0)
      await p2.goto('/')
      await expect(p2.getByTestId('team-goal')).toBeVisible()
      await other.close()
    })

    test('"Ready in your team": Hide for a member, the undo, and Settings › Profile brings it back', async ({ page }) => {
      await reset(page, { teamLocale: 'en', usersFollowTeam: true })
      await signIn(page)
      await call(page, 'POST', '/api/onboarding/welcome/team')
      await call(page, 'PATCH', '/api/onboarding/welcome', { finish: true })
      await page.context().clearCookies()
      await signIn(page, BOB)
      const block = page.getByTestId('team-prepared')
      await expect(block).toBeVisible()
      const hide = page.getByTestId('team-prepared-hide')
      await expect(hide).toHaveText('Hide')
      await shot(page, 'prepared-1-block')
      await hide.click()
      await expect(block).toHaveCount(0)
      // the toast's undo brings it back at once
      await page.getByRole('button', { name: 'Undo' }).click()
      await expect(block).toBeVisible()
      await hide.click()
      await expect(block).toHaveCount(0)
      await page.reload()
      await expect(page.getByTestId('composer-input')).toBeVisible()
      await expect(block).toHaveCount(0)
      await page.goto('/settings/profile')
      const back = page.getByTestId('profile-home-cards-preparedCard')
      await expect(back).toHaveText("Show 'Ready in your team' on Home again")
      // a member has no team goal to bring back
      await expect(page.getByTestId('profile-home-cards-goalCard')).toHaveCount(0)
      await back.click()
      await page.goto('/')
      await expect(block).toBeVisible()
    })
  })
}
