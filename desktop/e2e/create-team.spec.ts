// "Create a team for free" from the desktop app (docs/decisions/20261126-desktop-create-team.md) against a fake hosting
// console and a fake new team (./fake-console.ts): S0 → sign in in the browser (the test plays the browser) → name the
// team → starting → the team's own setup page in the app's window, for a Google and an e-mail owner; every state line;
// closing the app while the team is made and coming back; an expired token; a cancel in the browser; an older team
// server's setup link; the Mac App Store build; and a console without the flow, which keeps the first screen as it was.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { PRODUCT } from '@mycel/shared/product'
import { close, launch, newUserData, view, welcome, stopLeftoverApps } from './helpers'
import { startFakeConsole, type FakeConsole } from './fake-console'

stopLeftoverApps()

let fake: FakeConsole
test.beforeAll(async () => { fake = await startFakeConsole() })
test.afterAll(async () => { await fake?.close() })
test.beforeEach(() => fake.reset())

async function start(userData = newUserData('en'), env: Record<string, string> = {}): Promise<{ app: ElectronApplication; w: Page; userData: string }> {
  const app = await launch(userData, { MYCEL_CONSOLE_ORIGIN: fake.origin, MYCEL_DESKTOP_TEST_CREATE_POLL_MS: '150', ...env }, ['--use-mock-keychain'])
  await app.evaluate(({ shell }) => {
    ;(globalThis as any).__opened = []
    shell.openExternal = async (u: string) => void (globalThis as any).__opened.push(u)
  })
  return { app, w: await welcome(app), userData }
}
const opened = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as any).__opened as string[])
/** the connect address the app opened in the browser (the newest one) */
async function connectUrl(app: ElectronApplication, count: number): Promise<string> {
  await expect.poll(async () => (await opened(app)).filter((u) => u.startsWith(`${fake.origin}/app/connect`)).length).toBe(count)
  return (await opened(app)).filter((u) => u.startsWith(`${fake.origin}/app/connect`)).at(-1)!
}
/** sign in in the "browser" for the n-th time */
async function signInBrowser(app: ElectronApplication, n: number, o: { error?: 'cancelled' } = {}) {
  expect(await fake.browse(await connectUrl(app, n), o)).toBe(200)
}
async function nameTeam(w: Page, name = 'Acme Cafe') {
  await expect(w.getByRole('heading', { name: 'Name your team' })).toBeVisible()
  await w.getByLabel('Team name').fill(name)
  await w.getByTestId('agree').check()
  await w.getByTestId('create-submit').click()
}
const teamView = (app: ElectronApplication, path: string) => view(app, (u) => u.startsWith(fake.teamUrl + path))

test('S0 → S5 for a Google owner: one sign-in in the browser, a name, the wait, the team opens on its setup page', async () => {
  const { app, w, userData } = await start()
  try {
    // S0: two rows and the demo link, no box yet
    await expect(w.getByTestId('create-team')).toContainText('Create a team for free')
    await expect(w.getByTestId('create-team')).toContainText('Your own team in about 5 minutes. Free, no card.')
    await expect(w.getByTestId('join-team')).toHaveText('Join with an invite link')
    await expect(w.locator('#address')).toHaveCount(0)
    await expect(w.getByText('Install it yourself')).toHaveCount(0)
    await w.getByTestId('demo').click()
    await expect.poll(() => opened(app)).toContain('https://demo.trina.app')
    // S1 and back (button and Esc)
    await w.getByTestId('join-team').click()
    await expect(w.locator('#address')).toBeVisible()
    await expect(w.getByTestId('no-address')).toBeVisible()
    await w.getByTestId('join-back').click()
    await expect(w.getByTestId('create-team')).toBeVisible()
    await w.getByTestId('join-team').click()
    await w.keyboard.press('Escape')
    await expect(w.getByTestId('create-team')).toBeVisible()

    // S2: the browser opens the console's connect page (state, S256 challenge, the loopback port, the language)
    await w.getByTestId('create-team').click()
    // S2: two ways, Google in the browser or an e-mail code in the app; nothing opened in the browser yet
    await expect(w.getByTestId('signin-google')).toHaveText('Continue with Google')
    await expect(w.getByLabel('Email')).toBeVisible()
    await expect(w.getByTestId('signin-agree')).toContainText('By continuing you agree to the Terms and Privacy.')
    await w.getByTestId('signin-terms').click()
    await expect.poll(() => opened(app)).toContain(`${fake.origin}/legal/terms`)
    expect((await opened(app)).some((u) => u.includes('/app/connect'))).toBe(false)
    await w.getByTestId('signin-google').click()
    await expect(w.getByText('Continue in your browser to sign in.')).toBeVisible()
    const url = new URL(await connectUrl(app, 1))
    expect([...url.searchParams.keys()].sort()).toEqual(['challenge', 'locale', 'port', 'state'])
    expect(url.searchParams.get('locale')).toBe('en')
    await signInBrowser(app, 1)

    // S3: the name, the address derived from it, the Free plan's rules, the agree box
    await expect(w.getByRole('heading', { name: 'Name your team' })).toBeVisible()
    await expect(w.getByText('Signed in as owner@example.com')).toBeVisible()
    await w.getByLabel('Team name').fill('Acme Cafe')
    await expect(w.getByTestId('team-host')).toHaveText('acme-cafe.trina.app')
    await expect(w.getByTestId('free-plan')).toContainText('Up to 3 people')
    await expect(w.getByTestId('free-plan')).toContainText('1 answer at a time')
    await expect(w.getByTestId('free-plan')).toContainText('5 GB for files')
    await expect(w.getByTestId('create-submit')).toBeDisabled()
    await w.getByTestId('terms').click()
    await expect.poll(() => opened(app)).toContain('https://terms.example.test/free')
    await w.getByTestId('agree').check()
    await w.getByTestId('create-submit').click()

    // S4, then the team's own setup page in the app's window
    await expect(w.getByText('Setting up Acme Cafe…')).toBeVisible()
    await expect(w.getByText('About 3 to 5 minutes. You can close the app.')).toBeVisible()
    const page = await teamView(app, '/app-setup')
    await expect(page.locator('#welcome')).toHaveText('Welcome to Acme Cafe, owner')
    await expect(page.locator('#pw')).toHaveCount(0)
    await page.locator('#go').click()
    await expect(page.locator('#team-home')).toHaveText('Acme Cafe home')
    expect(fake.setups).toEqual([{ claim: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), password: null }])

    // what the console was sent: the Free plan, the consent shown, the computer's zone and language; a bearer, no cookie
    const create = fake.log.find((l) => l.method === 'POST' && l.path === '/api/app/v1/teams')!
    expect(create.body).toMatchObject({ v: 1, planId: 'free', displayName: 'Acme Cafe', slug: 'acme-cafe', locale: 'en', consent: { termsVersion: 'free-2026-11' } })
    expect(typeof (create.body as { timeZone: string }).timeZone).toBe('string')
    for (const l of fake.log.filter((x) => x.path !== '/api/app/v1/token' && x.auth)) {
      expect(l.auth).toMatch(/^Bearer /)
      expect(l.cookie).toBeNull()
    }
    // the team is remembered by its address, with its name; nothing of the claim is kept
    const teams = JSON.parse(readFileSync(join(userData, 'teams.json'), 'utf8'))
    expect(teams.teams).toMatchObject([{ origin: fake.teamUrl, label: 'Acme Cafe' }])
    expect(readFileSync(join(userData, 'teams.json'), 'utf8')).not.toContain('#c=')
  } finally {
    await close(app)
  }
})

test('an e-mail owner signs in in the app with a code (no browser) and chooses a password on the setup page', async () => {
  fake.sc.owner = 'email'
  const { app, w } = await start()
  try {
    await w.getByTestId('create-team').click()
    // a half address is refused on the screen; nothing is sent
    await w.getByLabel('Email').fill('owner@example')
    await w.getByTestId('signin-send').click()
    await expect(w.getByTestId('create-error')).toHaveText('Enter a full email address, like name@company.com.')
    expect(fake.sent).toEqual([])
    await w.getByLabel('Email').fill('owner@example.com')
    await w.getByTestId('signin-send').click()
    await expect(w.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    await expect(w.getByText('We sent a 6-digit code to owner@example.com.')).toBeVisible()
    expect(fake.sent).toMatchObject([{ email: 'owner@example.com', locale: 'en', store: false }])
    // a wrong code, then Send again (a new code; the old one no longer works), then an expired one
    await w.getByLabel('6-digit code').fill('000000')
    await w.getByTestId('signin-verify').click()
    await expect(w.getByTestId('create-error')).toHaveText('That code is not right. Check it and try again.')
    await w.getByTestId('signin-send-again').click()
    await expect.poll(() => fake.sent.length).toBe(2)
    await w.getByLabel('6-digit code').fill(fake.sent[0]!.code)
    await w.getByTestId('signin-verify').click()
    await expect(w.getByTestId('create-error')).toHaveText('That code is not right. Check it and try again.')
    fake.sc.emailCodeExpired = true
    await w.getByLabel('6-digit code').fill(fake.sent[1]!.code)
    await w.getByTestId('signin-verify').click()
    await expect(w.getByTestId('create-error')).toHaveText('That code has expired. Send a new one.')
    fake.sc.emailCodeExpired = false
    // Use another email: back to the two ways
    await w.getByTestId('signin-other-email').click()
    await expect(w.getByTestId('signin-google')).toBeVisible()
    await w.getByLabel('Email').fill('owner@example.com')
    await w.getByTestId('signin-send').click()
    await expect.poll(() => fake.sent.length).toBe(3)
    // too many wrong tries
    for (let i = 0; i < 3; i++) {
      await w.getByLabel('6-digit code').fill('000000')
      await w.getByTestId('signin-verify').click()
      await expect(w.getByTestId('create-error')).toBeVisible()
    }
    await expect(w.getByTestId('create-error')).toHaveText('Too many tries. Wait a few minutes, then send a new code.')
    await w.getByTestId('signin-send-again').click()
    await expect.poll(() => fake.sent.length).toBe(4)
    await w.getByLabel('6-digit code').fill(fake.sent[3]!.code)
    await w.getByTestId('signin-verify').click()
    // signed in: the name screen; the browser was never opened
    await expect(w.getByText('Signed in as owner@example.com')).toBeVisible()
    expect((await opened(app)).some((u) => u.includes('/app/connect'))).toBe(false)
    await nameTeam(w, 'Acme')
    const page = await teamView(app, '/app-setup')
    await expect(page.locator('#welcome')).toHaveText('Welcome to Acme, owner')
    await page.locator('#pw').fill('a long test password 1')
    await page.locator('#go').click()
    await expect(page.locator('#team-home')).toBeVisible()
    expect(fake.setups).toEqual([{ claim: expect.any(String), password: 'a long test password 1' }])
  } finally {
    await close(app)
  }
})

test('every state line: each its own words and its one button; Back to the first screen', async () => {
  const { app, w } = await start()
  const again = async () => {
    await w.getByTestId('create-back').click()
    await expect(w.getByTestId('create-team')).toBeVisible()
    await w.getByTestId('create-team').click()
  }
  const line = (text: string) => expect(w.getByRole('heading', { name: text })).toBeVisible()
  try {
    // cancelled in the browser: why, Try again, Back
    await w.getByTestId('create-team').click()
    await w.getByTestId('signin-google').click()
    await signInBrowser(app, 1, { error: 'cancelled' })
    await expect(w.getByTestId('create-error')).toHaveText('Sign-in was cancelled.')
    await w.getByTestId('signin-google').click()
    await signInBrowser(app, 2)
    await expect(w.getByRole('heading', { name: 'Name your team' })).toBeVisible()
    // Back from S3; the token is kept, so the next start asks the console without the browser
    await again()

    // the address is taken: back to S3 with the address open for editing
    fake.sc.createError = { code: 'slug_unavailable', status: 409 }
    await nameTeam(w)
    await expect(w.getByTestId('slug-error')).toHaveText('This address is taken or not allowed. Choose another one.')
    await expect(w.locator('#team-slug')).toHaveValue('acme-cafe')
    await w.locator('#team-slug').fill('acme-cafe-2')
    fake.sc.createError = { code: 'capacity_full', status: 409, fields: { pool: 'free' } }
    await w.getByTestId('create-submit').click()
    await line('The free servers are full right now. Try again later.')
    expect(fake.log.filter((l) => l.path === '/api/app/v1/teams').at(-1)!.body).toMatchObject({ slug: 'acme-cafe-2' })
    for (const [code, text] of [
      ['network_limit', 'Too many new teams were made from this network today. Try again tomorrow.'],
      ['email_unverified', 'Confirm your email address first, then try again.'],
      ['no_free_region', 'Free teams are not offered in your region yet.'],
      ['free_awake_limit', 'The free servers are busy. Try again in a few minutes.'],
    ] as const) {
      await again()
      fake.sc.createError = { code, status: code === 'network_limit' ? 429 : 409 }
      await nameTeam(w)
      await line(text)
    }

    // from /me: the free team used, the waiting list
    fake.sc.freeLeft = false
    await again()
    await line('This account already used its free team.')
    await w.getByTestId('notice-action').click()
    await expect.poll(() => opened(app)).toContain('https://ax.trina.app/pricing')
    fake.sc.freeLeft = true
    fake.sc.waitlist = true
    await again()
    await line(`We're opening ${PRODUCT.displayName} slowly.`)
    await expect(w.getByText('Signed in as owner@example.com')).toBeVisible()
    await w.getByTestId('notice-action').click()
    await line('You\'re on the list.')
    expect(fake.log.some((l) => l.method === 'POST' && l.path === '/api/app/v1/waitlist')).toBe(true)
    fake.sc.waitlist = false

    // the account's team in each state
    const cafe = () => fake.newTeam('Acme Cafe', 'acme-cafe', 'active')
    fake.sc.team = { ...cafe(), state: 'canceled', comeback: true }
    await again()
    await line('Finish bringing Acme Cafe back in the console.')
    await w.getByTestId('notice-action').click()
    await expect.poll(() => opened(app)).toContain(fake.origin)
    fake.sc.team = { ...cafe(), state: 'suspended' }
    await again()
    await line('Acme Cafe is on hold.')
    fake.sc.team = { ...cafe(), state: 'past_due' }
    await again()
    await line('Acme Cafe is on hold.')
    fake.sc.team = { ...cafe(), state: 'paused' }
    fake.sc.resumeError = { code: 'free_awake_limit', status: 409 }
    await again()
    await line('Acme Cafe is paused.')
    await w.getByTestId('notice-action').click()
    await line('The free servers are busy. Try again in a few minutes.')
    fake.sc.team = { ...cafe(), state: 'provision_failed' }
    await again()
    await line('Setting up Acme Cafe did not work.')
    fake.sc.provisionPolls = 1000
    await w.getByTestId('notice-action').click()
    await expect(w.getByText('Setting up Acme Cafe…')).toBeVisible()
    expect(fake.log.some((l) => l.method === 'POST' && l.path === '/api/app/v1/teams/team_cafe1/retry')).toBe(true)
    // Esc leaves the starting screen (the team being made stays saved)
    await w.keyboard.press('Escape')
    await expect(w.getByTestId('create-team')).toBeVisible()

    // a live team: no name screen, "Open it" opens it (set up already: its start)
    fake.sc.team = { ...cafe(), setUp: true }
    fake.sc.provisionPolls = 0
    await w.getByTestId('create-team').click()
    // (the saved team being made is asked first: it is active now and set up, so it opens)
    const home = await teamView(app, '/')
    await expect(home.locator('#team-home')).toBeVisible()
  } finally {
    await close(app)
  }
})

test('"Open it" on a live team that is not set up yet: the owner claim opens its setup page', async () => {
  fake.sc.team = fake.newTeam('Acme Cafe', 'acme-cafe', 'active')
  const { app, w } = await start()
  try {
    await w.getByTestId('create-team').click()
    await w.getByTestId('signin-google').click()
    await signInBrowser(app, 1)
    await expect(w.getByRole('heading', { name: 'You already have a team, Acme Cafe.' })).toBeVisible()
    await expect(w.getByRole('heading', { name: 'Name your team' })).toHaveCount(0)
    await w.getByTestId('notice-action').click()
    const page = await teamView(app, '/app-setup')
    await expect(page.locator('#welcome')).toHaveText('Welcome to Acme Cafe, owner')
  } finally {
    await close(app)
  }
})

test('closed while the team is made: reopening comes back to the wait, then the team opens; an expired token asks to sign in again', async () => {
  fake.sc.provisionPolls = 100_000
  const userData = newUserData('en')
  let { app, w } = await start(userData)
  try {
    await w.getByTestId('create-team').click()
    await w.getByTestId('signin-google').click()
    await signInBrowser(app, 1)
    await nameTeam(w)
    await expect(w.getByText('Setting up Acme Cafe…')).toBeVisible()
    await close(app)

    // reopened: straight to the wait, no browser
    ;({ app, w } = await start(userData))
    await expect(w.getByText('Setting up Acme Cafe…')).toBeVisible()
    expect(await opened(app)).toEqual([])
    await close(app)

    // reopened after the token expired: "Sign in again to finish", then the wait goes on and the team opens
    fake.expireTokens()
    ;({ app, w } = await start(userData))
    await expect(w.getByRole('heading', { name: 'Sign in again to finish' })).toBeVisible()
    await expect(w.getByText('Setting up Acme Cafe goes on after you sign in.')).toBeVisible()
    fake.sc.provisionPolls = 0
    await w.getByTestId('signin-google').click()
    await signInBrowser(app, 1)
    const page = await teamView(app, '/app-setup')
    await expect(page.locator('#welcome')).toHaveText('Welcome to Acme Cafe, owner')
    // nothing waits any more: the next start opens the team, not the wait
    await close(app)
    ;({ app, w } = await start(userData))
    await expect.poll(() => app.windows().some((p) => p.url().startsWith(fake.teamUrl))).toBe(true)
  } finally {
    await close(app)
  }
})

test('an older team server: the console\'s old setup link opens in the app\'s window instead', async () => {
  fake.sc.claimError = { code: 'unsupported', status: 409, fields: { setupUrl: '' } }
  const { app, w } = await start()
  try {
    fake.sc.claimError.fields = { setupUrl: `${fake.teamUrl}/setup#t=oldlink` }
    await w.getByTestId('create-team').click()
    await w.getByTestId('signin-google').click()
    await signInBrowser(app, 1)
    await nameTeam(w)
    const page = await teamView(app, '/setup')
    await expect(page.locator('#old-setup')).toHaveText('Old setup #t=oldlink')
  } finally {
    await close(app)
  }
})

test('the Mac App Store build: no create row and no plans; "Already made a team? Sign in" opens the owned team, or says there is none', async () => {
  const { app, w } = await start(newUserData('en'), { MYCEL_DESKTOP_TEST_STORE: '1' })
  try {
    await expect(w.getByTestId('store-signin')).toContainText('Already made a team?')
    await expect(w.getByTestId('create-team')).toHaveCount(0)
    await expect(w.locator('#address')).toBeVisible()
    await expect(w.getByTestId('demo')).toBeVisible()
    await expect(w.getByText(/plan|price/i)).toHaveCount(0)
    await w.getByTestId('store-signin-button').click()
    await w.getByTestId('signin-google').click()
    const url = new URL(await connectUrl(app, 1))
    expect(url.searchParams.get('store')).toBe('1')
    await signInBrowser(app, 1)
    await expect(w.getByRole('heading', { name: 'No team yet.' })).toBeVisible()
    await expect(w.getByTestId('notice-action')).toHaveCount(0)
    // a used free team: no "See plans" here
    fake.sc.freeLeft = false
    fake.sc.team = { ...fake.newTeam('Acme Cafe', 'acme-cafe', 'paused') }
    await w.getByTestId('create-back').click()
    await w.getByTestId('store-signin-button').click()
    await expect(w.getByRole('heading', { name: 'Acme Cafe is paused.' })).toBeVisible()
    await expect(w.getByTestId('notice-action')).toHaveCount(0)
    // the owned team, live and not set up: its setup page
    fake.sc.team = fake.newTeam('Acme Cafe', 'acme-cafe', 'active')
    await w.getByTestId('create-back').click()
    await w.getByTestId('store-signin-button').click()
    const page = await teamView(app, '/app-setup')
    await expect(page.locator('#welcome')).toHaveText('Welcome to Acme Cafe, owner')
    expect(fake.log.some((l) => l.method === 'POST' && ['/api/app/v1/teams', '/api/app/v1/waitlist'].includes(l.path))).toBe(false)
    expect((await opened(app)).some((u) => /pricing/.test(u))).toBe(false)
  } finally {
    await close(app)
  }
})

test('the Mac App Store build signs in with an e-mail code too (login only: store on the code request)', async () => {
  fake.sc.team = fake.newTeam('Acme Cafe', 'acme-cafe', 'active')
  fake.sc.team = { ...fake.sc.team, setUp: true }
  const { app, w } = await start(newUserData('en'), { MYCEL_DESKTOP_TEST_STORE: '1' })
  try {
    await w.getByTestId('store-signin-button').click()
    await w.getByLabel('Email').fill('owner@example.com')
    await w.getByTestId('signin-send').click()
    await expect.poll(() => fake.sent.length).toBe(1)
    expect(fake.sent[0]).toMatchObject({ store: true })
    await w.getByLabel('6-digit code').fill(fake.sent[0]!.code)
    await w.getByTestId('signin-verify').click()
    const home = await teamView(app, '/')
    await expect(home.locator('#team-home')).toBeVisible()
    expect((await opened(app)).some((u) => /pricing/.test(u))).toBe(false)
  } finally {
    await close(app)
  }
})

test('a setup that fails while the team still reads as being made: never a wait forever', async () => {
  // its address went to another team: back to the name, the address open to change; the button retries that team
  fake.sc.provisionError = 'slug_conflict'
  const { app, w } = await start()
  try {
    await w.getByTestId('create-team').click()
    await w.getByTestId('signin-google').click()
    await signInBrowser(app, 1)
    await nameTeam(w)
    await expect(w.getByTestId('slug-error')).not.toBeEmpty()
    // the retry changes only the address: the name is the one the team was made with, and cannot be changed here
    await expect(w.getByLabel('Team name')).toHaveValue('Acme Cafe')
    await expect(w.getByLabel('Team name')).toBeDisabled()
    await w.locator('#team-slug').fill('acme-cafe-2')
    await w.getByTestId('agree').check()
    await w.getByTestId('create-submit').click()
    await expect.poll(() => fake.sc.retries.length).toBe(1)
    expect(fake.sc.retries[0]).toEqual({ v: 1, slug: 'acme-cafe-2' })
    // one team only: no second POST /teams
    expect(fake.log.filter((l) => l.method === 'POST' && l.path === '/api/app/v1/teams').length).toBe(1)
    // the team opens at its new address
    const newUrl = fake.teamUrl.replace('//cafe.', '//acme-cafe-2.')
    const page = await view(app, (u) => u.startsWith(`${newUrl}/app-setup`))
    await expect(page.locator('#welcome')).toHaveText('Welcome to Acme Cafe, owner')
  } finally {
    await close(app)
  }
  // any other failure: the failed-setup notice with Try again
  fake.reset()
  fake.sc.provisionError = 'setup_failed'
  const again = await start()
  try {
    await again.w.getByTestId('create-team').click()
    await again.w.getByTestId('signin-google').click()
    await signInBrowser(again.app, 1)
    await nameTeam(again.w)
    await expect(again.w.getByTestId('notice-action')).toBeVisible()
    await again.w.getByTestId('notice-action').click()
    await expect.poll(() => fake.sc.retries.length).toBe(1)
    const page = await teamView(again.app, '/app-setup')
    await expect(page.locator('#welcome')).toHaveText('Welcome to Acme Cafe, owner')
  } finally {
    await close(again.app)
  }
})

test('a console without the flow (GET /me 404): the first screen stays the box, no create row', async () => {
  fake.sc.old = true
  const { app, w } = await start()
  try {
    await expect(w.getByRole('heading', { name: 'Join your team' })).toBeVisible()
    await expect(w.locator('#address')).toBeVisible()
    await expect(w.getByTestId('create-team')).toHaveCount(0)
    await expect(w.getByTestId('store-signin')).toHaveCount(0)
    // still a way to make a team: the website
    await expect(w.getByTestId('signup-web')).toContainText('Make a team on the website')
    await w.getByTestId('signup-web').click()
    await expect.poll(async () => (await opened(app)).some((u) => u.startsWith(fake.origin))).toBe(true)
    expect(fake.log.filter((l) => l.path === '/api/app/v1/me').every((l) => l.auth === null)).toBe(true)
  } finally {
    await close(app)
  }
})
