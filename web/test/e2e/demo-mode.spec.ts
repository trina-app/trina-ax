// Demo mode (docs/DECISIONS.md "Demo company: a new hire at 트리나"; GET /api/demo, POST /api/demo/persona). The mock
// server is no demo server, so GET /api/demo is answered here, and a persona switch signs in as that demo person the
// way the server does (a real sign-in of the seeded account; here the mock's accounts bob, dana and eve). The sign-in
// page offers one action, start as the new hire; Home then greets them with their intro and questions, and the demo
// bar's sheet switches to the team lead. A phone shows the same bar and sheet.
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER, type DemoInfo, type DemoPersonaKey } from '@mycel/shared/api'
import { reset } from './helpers'

const ACCOUNTS: Record<DemoPersonaKey, { username: string; password: string; name: string }> = {
  newHire: { username: 'bob', password: 'bob password 1', name: 'Bob' },
  lead: { username: 'dana', password: 'dana password 1', name: 'Dana' },
  ceo: { username: 'eve', password: 'eve password 1', name: 'Eve' },
}
const SAME = 'What did we decide about the spring launch?'
const PERSONAS: DemoInfo['personas'] = [
  { key: 'newHire', name: 'Bob', team: 'Marketing', intro: 'Your first week at Acme Demo: ask anything.', questions: ['Where is the brand guide?', SAME] },
  { key: 'lead', name: 'Dana', team: 'Marketing', intro: 'You lead the marketing team.', questions: [SAME] },
  { key: 'ceo', name: 'Eve', team: null, intro: 'You run Acme Demo.', questions: ['How are we doing this quarter?'] },
]

/** Answers the demo endpoints like a demo server; returns the persona keys switched to, in order. */
async function demoServer(page: Page) {
  let current: DemoPersonaKey | null = null
  const switched: DemoPersonaKey[] = []
  await page.route('**/api/demo', (r) => r.fulfill({ json: { company: 'Acme Demo', sameQuestion: SAME, current, network: false, personas: PERSONAS } satisfies DemoInfo }))
  await page.route('**/api/demo/persona', async (r) => {
    const key = (r.request().postDataJSON() as { key: DemoPersonaKey }).key
    const a = ACCOUNTS[key]
    const login = await page.request.post('/api/auth/login', { headers: { [CSRF_HEADER]: '1' }, data: { username: a.username, password: a.password } })
    expect(login.ok()).toBeTruthy()
    current = key
    switched.push(key)
    await r.fulfill({ json: { ok: true } })
  })
  return switched
}

async function whoAmI(page: Page) {
  return ((await (await page.request.get('/api/me')).json()) as { user: { username: string } }).user.username
}

test('the sign-in page starts as the new hire; Home greets them; the bar switches to the team lead', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  const switched = await demoServer(page)
  await page.goto('/login')
  const start = page.getByTestId('demo-start')
  await expect(start).toContainText(PERSONAS[0]!.intro)
  // the usual form is one link away, not on the page
  await expect(page.getByTestId('login-username')).toHaveCount(0)
  await page.getByTestId('demo-start-button').click()

  // Home as the new hire: the demo bar, their intro, their questions (no "same question" line before a switch)
  await expect(page.getByTestId('demo-intro')).toHaveText(PERSONAS[0]!.intro)
  await expect(page.getByTestId('demo-bar')).toContainText('Acme Demo')
  await expect(page.getByTestId('demo-bar')).toContainText('Bob')
  await expect(page.getByTestId('demo-question')).toHaveText(['Where is the brand guide?', SAME])
  expect(await whoAmI(page)).toBe('bob')

  // the bar's sheet: the three people, the current one marked; the lead signs in as Dana
  await page.getByTestId('demo-switch').click()
  await expect(page.getByTestId('demo-personas').getByRole('button')).toHaveCount(3)
  await expect(page.getByTestId('demo-persona-newHire')).toHaveAttribute('aria-current', 'true')
  await page.getByTestId('demo-persona-lead').click()
  await expect(page.getByTestId('demo-intro')).toHaveText(PERSONAS[1]!.intro)
  await expect(page.getByTestId('demo-same-hint')).toBeVisible()
  expect(await whoAmI(page)).toBe('dana')
  expect(switched).toEqual(['newHire', 'lead'])
})

test('another account: the usual sign-in form is one link away', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await demoServer(page)
  await page.goto('/login')
  await page.getByTestId('demo-start').getByRole('button').last().click()
  await expect(page.getByTestId('login-username')).toBeVisible()
  await expect(page.getByTestId('demo-start')).toHaveCount(0)
})

test('a phone: the bar fits the width and its sheet switches person', async ({ page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true, withAdmin: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await demoServer(page)
  await page.goto('/login')
  await page.getByTestId('demo-start-button').click()
  const bar = page.getByTestId('demo-bar')
  await expect(bar).toBeVisible()
  const box = (await bar.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  const sw = page.getByTestId('demo-switch')
  expect((await sw.boundingBox())!.height).toBeGreaterThanOrEqual(32)
  await sw.click()
  await page.getByTestId('demo-persona-ceo').click()
  await expect(page.getByTestId('demo-bar')).toContainText('Eve')
  expect(await whoAmI(page)).toBe('eve')
})
