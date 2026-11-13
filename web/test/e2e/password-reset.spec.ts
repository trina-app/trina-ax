// A one-time password reset link (/reset-password/:token; GET and POST /api/password-resets/:token): the owner makes
// it in Admin › Members and hands it over; the person opens it signed out, sees whose account it is for, chooses a new
// password and lands on Home signed in; the link then says it was used; the new password signs in, the old one not.
// A phone shows the same form with the button in reach.
import { expect, test, type Browser, type Page } from '@playwright/test'
import { DICTS } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const t = DICTS.en
const NEW_PASSWORD = 'river stone 4417'

/** The owner makes Bob's link in Admin › Members (the row's "…" menu) and reads it off the dialog. */
async function makeLink(page: Page): Promise<string> {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  await signIn(page)
  await page.goto('/admin/members')
  await page.getByTestId('members-table').getByRole('row').filter({ hasText: 'Bob' }).getByTestId('member-more').click()
  await page.getByTestId('reset-link-bob').click()
  await page.getByTestId('dialog-confirm').click()
  const url = (await page.getByTestId('secret-value').textContent())!
  expect(url).toMatch(/\/reset-password\/rst[0-9a-f]+$/)
  return new URL(url).pathname
}

async function signedOut(browser: Browser, phone = false) {
  const ctx = await browser.newContext({ locale: 'en-US', ...(phone ? { viewport: { width: 390, height: 760 }, isMobile: true, hasTouch: true } : {}) })
  return { ctx, page: await ctx.newPage() }
}

test('the person opens the link, sets a new password and is signed in; the link works once', async ({ page, browser }) => {
  const link = await makeLink(page)
  const { ctx, page: bob } = await signedOut(browser)
  const errors = watchConsole(bob)
  await bob.goto(link)
  await expect(bob.getByRole('heading', { name: t['reset.title'] })).toBeVisible()
  await expect(bob.getByText(/Choose a new password for Bob \(bob\)/)).toBeVisible()
  // two different passwords: said on the page, nothing sent
  await bob.getByTestId('reset-password').fill(NEW_PASSWORD)
  await bob.getByTestId('reset-password2').fill('something else 1')
  await bob.getByTestId('reset-submit').click()
  await expect(bob.getByRole('alert')).toBeVisible()
  await bob.getByTestId('reset-password2').fill(NEW_PASSWORD)
  await bob.getByTestId('reset-submit').click()
  // signed in as Bob on Home
  await expect(bob.getByTestId('composer-input').or(bob.getByTestId('rooms-page'))).toBeVisible()
  expect(((await (await bob.request.get('/api/me')).json()) as { user: { username: string } }).user.username).toBe('bob')
  expect(realErrors(errors).filter((e) => !/status of 404/.test(e))).toEqual([])
  await ctx.close()

  // the same link again: used, the page says so and leads to signing in
  const again = await signedOut(browser)
  await again.page.goto(link)
  await expect(again.page.getByText(t['reset.invalid'])).toBeVisible()
  await expect(again.page.getByTestId('reset-password')).toHaveCount(0)
  // the old password no longer works, the new one does
  await again.page.goto('/login')
  await again.page.getByTestId('login-username').fill('bob')
  await again.page.getByTestId('login-password').fill('bob password 1')
  await again.page.getByTestId('login-submit').click()
  await expect(again.page.getByRole('alert')).toBeVisible()
  await signIn(again.page, { username: 'bob', password: NEW_PASSWORD })
  await again.ctx.close()
})

test('an unknown link says it does not work', async ({ browser, page }) => {
  await reset(page, { teamLocale: 'en', usersFollowTeam: true })
  const { ctx, page: p } = await signedOut(browser)
  await p.goto('/reset-password/rst0000')
  await expect(p.getByText(t['reset.invalid'])).toBeVisible()
  await ctx.close()
})

test('a phone: the form fits the width and its button is in reach', async ({ page, browser }) => {
  const link = await makeLink(page)
  const { ctx, page: bob } = await signedOut(browser, true)
  await bob.goto(link)
  await bob.getByTestId('reset-password').fill(NEW_PASSWORD)
  await bob.getByTestId('reset-password2').fill(NEW_PASSWORD)
  const submit = bob.getByTestId('reset-submit')
  await expect(submit).toBeInViewport()
  const box = (await submit.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.height).toBeGreaterThanOrEqual(40)
  await submit.click()
  await expect(bob.getByTestId('composer-input').or(bob.getByTestId('rooms-page'))).toBeVisible()
  await ctx.close()
})
