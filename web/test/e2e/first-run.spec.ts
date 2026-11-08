// First run (docs/AGENTS/plan/20261108-0930-first-run-one-box.md), the web's part, in a real browser against the mock:
// a used or unknown invite leads with "이미 가입했다면 로그인하세요" and a real sign-in button; both join forms end with
// "이미 가입했어요? 로그인"; Settings › 앱 shows the team's address (GET /api/me team.address) with a copy button, at
// 1360 and on a phone, and no row when the server names no address.
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CSRF_HEADER } from '@mycel/shared/api'
import { translate } from '../../src/i18n'
import { realErrors, reset, signIn, watchConsole } from './helpers'

const ko = (k: Parameters<typeof translate>[1]) => translate('ko', k)

async function audit(page: Page, where: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).exclude('iframe').analyze()
  const serious = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([])
}

const post = async (page: Page, url: string, data: unknown) => {
  const r = await page.request.post(url, { headers: { [CSRF_HEADER]: '1' }, data })
  expect(r.status(), url).toBe(201)
  return r.json()
}

test('a used or unknown invite: the reason, "이미 가입했다면 로그인하세요" and a sign-in button that opens /login', async ({ page }) => {
  const errors = watchConsole(page)
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  // someone joins with it, then opens the same link again from the chat
  const other = await page.context().browser()!.newContext({ locale: 'ko-KR' })
  const p2 = await other.newPage()
  await p2.goto(`/invite/${token}`)
  await p2.getByTestId('invite-name').fill('New Person')
  await p2.getByTestId('invite-username').fill('newbie')
  await p2.getByTestId('invite-password').fill('another password 1')
  await p2.getByTestId('invite-submit').click()
  await expect(p2).not.toHaveURL(/\/invite\//)
  await other.close()
  const p3 = await (await page.context().browser()!.newContext({ locale: 'ko-KR' })).newPage()
  for (const path of [`/invite/${token}`, '/invite/AAAAAAAAAAAAAAAAAAAAAA']) {
    await p3.goto(path)
    await expect(p3.getByText(ko('invite.invalid'))).toBeVisible()
    await expect(p3.getByText(ko('auth.alreadyJoined'))).toBeVisible()
    const button = p3.getByTestId('invalid-signin')
    await expect(button).toBeVisible()
    await expect(button).toHaveText(ko('auth.signIn'))
    await expect(p3.getByTestId('join-form')).toHaveCount(0)
  }
  await audit(p3, 'a used invite')
  await p3.getByTestId('invalid-signin').click()
  await expect(p3).toHaveURL(/\/login$/)
  await expect(p3.getByTestId('login-username')).toBeVisible()
  await p3.context().close()
  expect(realErrors(errors)).toEqual([])
})

test('both join forms end with "이미 가입했어요? 로그인"; a used-up team link leads to signing in too', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const link = await post(page, '/api/admin/team-link', { maxUses: 1 })
  const ctx = await browser.newContext({ locale: 'ko-KR' })
  const p = await ctx.newPage()
  // the single-use invite
  await p.goto(`/invite/${token}`)
  await expect(p.getByTestId('join-form')).toBeVisible()
  await expect(p.getByTestId('join-have-account')).toHaveText(`${ko('auth.haveAccount')} ${ko('auth.signIn')}`)
  await p.getByTestId('join-signin').click()
  await expect(p).toHaveURL(/\/login$/)
  // the team link (its token in the #fragment)
  const url = new URL(link.link.url)
  await p.goto(url.pathname + url.hash)
  await expect(p.getByTestId('join-form')).toBeVisible()
  await expect(p.getByTestId('join-have-account')).toHaveText(`${ko('auth.haveAccount')} ${ko('auth.signIn')}`)
  await audit(p, 'the team link form')
  // one use: someone takes it, the next visitor is told and led to sign in
  await p.getByTestId('invite-name').fill('First Person')
  await p.getByTestId('invite-username').fill('first')
  await p.getByTestId('invite-password').fill('another password 1')
  await p.getByTestId('invite-submit').click()
  await expect(p).not.toHaveURL(/\/join/)
  const late = await (await browser.newContext({ locale: 'ko-KR' })).newPage()
  await late.goto(url.pathname + url.hash)
  await expect(late.getByTestId('join-problem')).toBeVisible()
  await expect(late.getByText(ko('auth.alreadyJoined'))).toBeVisible()
  await late.getByTestId('invalid-signin').click()
  await expect(late).toHaveURL(/\/login$/)
  await late.context().close()
  await ctx.close()
})

for (const phone of [false, true]) {
  test(`Settings › 앱: the team address and a copy button${phone ? ' (phone)' : ''}; none known, no row`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 390, height: 844 })
    await reset(page)
    expect((await page.request.post('/__test/team-address', { data: { address: 'https://acme.trina.app' } })).ok()).toBe(true)
    await signIn(page)
    await page.goto('/settings/apps')
    const row = page.getByTestId('apps-team-address')
    await expect(row).toBeVisible()
    await expect(row).toContainText(ko('apps.teamAddress'))
    await expect(row).toContainText(ko('apps.teamAddressHint'))
    await expect(page.getByTestId('apps-team-address-host')).toHaveText('acme.trina.app')
    // the install pictures name the team's address, not the page's own host (127.0.0.1 here)
    await expect(page.getByTestId('install-guide')).not.toContainText('127.0.0.1')
    await row.getByRole('button', { name: ko('common.copy') }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://acme.trina.app')
    await audit(page, 'Settings › 앱 with the team address')
    expect((await page.request.post('/__test/team-address', { data: { address: null } })).ok()).toBe(true)
    await page.reload()
    await expect(page.getByTestId('install-guide').or(page.getByRole('heading', { name: ko('apps.desktopTitle') })).first()).toBeVisible()
    await expect(page.getByTestId('apps-team-address')).toHaveCount(0)
  })
}

// phase 2 (docs/AGENTS/plan/20261108-1025-first-run-open-links.md): "앱에서 열기" on both join pages, a trina-ax:// link
// that carries this page's own link (the team link's token from memory: the address bar no longer has it)
test('"앱에서 열기" on both join pages opens the same page in the app (Mac and iPhone browsers)', async ({ page, browser }) => {
  await reset(page)
  await signIn(page)
  const { token } = await post(page, '/api/admin/invites', { role: 'member', groupIds: [] })
  const link = await post(page, '/api/admin/team-link', {})
  const linkUrl = new URL(link.link.url)
  for (const ua of ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1']) {
    const ctx = await browser.newContext({ locale: 'ko-KR', userAgent: ua })
    const p = await ctx.newPage()
    await p.goto(`/invite/${token}`)
    const open = p.getByTestId('open-in-app')
    await expect(open).toHaveText(ko('auth.openInApp'))
    const origin = new URL(p.url()).origin
    expect(await open.getAttribute('href')).toBe(`trina-ax://open?url=${encodeURIComponent(`${origin}/invite/${token}`)}`)
    await p.goto(linkUrl.pathname + linkUrl.hash)
    await expect(p.getByTestId('join-form')).toBeVisible()
    // the page took the token out of the address bar; the link still carries it
    expect(new URL(p.url()).hash).toBe('')
    expect(await p.getByTestId('open-in-app').getAttribute('href')).toBe(`trina-ax://open?url=${encodeURIComponent(`${origin}/join${linkUrl.hash}`)}`)
    await ctx.close()
  }
  // a system the apps do not run on: no line
  const linux = await browser.newContext({ locale: 'ko-KR', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' })
  const lp = await linux.newPage()
  await lp.goto(`/invite/${token}`)
  await expect(lp.getByTestId('join-form')).toBeVisible()
  await expect(lp.getByTestId('open-in-app')).toHaveCount(0)
  await linux.close()
})
