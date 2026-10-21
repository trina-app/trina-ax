// Owner feedback 2026-10-21 (LinkedIn compose): "사내망 요청을 막았어요: static.licdn.com" and "AI가 linkedin.com에서
// 스크립트를 실행했어요" stacked as banners over the page, and no way to say "always allow".
//  - static.licdn.com was never treated as office network: it was the hold on a page the AI ran script in
//    (common/net-policy.ts), logged under the office-network label. Now it is its own kind ("offsite") in the log.
//  - routine events (script runs, held-back requests, a page's office / this-computer sub-requests) only go to the
//    activity log; one dismissible line over the page at most, for a stopped page load or a password field
//  - "Allow all websites" in the pane settings: public sites open without asking; office addresses still ask
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { ACME, activityLog, addTeam, answer, ATTACKER, bindWindow, call, chrome, close, launch, newTurn, newUserData, OFFICE_SITE, result, run, SHOP, teamPage, text } from './helpers'

const prompts = async (app: ElectronApplication) => (await chrome(app)).getByTestId('permission-prompt').count()

test.describe('quiet browsing', () => {
  let app: ElectronApplication
  test.beforeAll(async () => {
    app = await launch(newUserData())
    await addTeam(app, 'acme.localhost:19151', ACME)
  })
  test.afterAll(async () => close(app))

  test('a page the AI scripted: the script run and held-back requests go to the log, nothing over the page', async () => {
    newTurn()
    const s = await call(ACME, 'navigate', { url: `${SHOP}/` })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, s.callId)).result.ok).toBe(true)
    // the LinkedIn shape: the AI runs a script, then a request to another public host (a CDN there) is held back
    const r = await run(ACME, 'javascript_tool', { action: 'javascript_exec', text: `await fetch('${ATTACKER}/cdn/app.js?quiet=1', { mode: 'no-cors' }).then(() => 'sent', () => 'held')` })
    expect(text(r)).toContain('held')
    // a page's own sub-request into the office network (this turn's site is allowed, nas.lan is not)
    const intranet = await run(ACME, 'navigate', { url: `${SHOP}/intranet.html` })
    expect(intranet.result.ok).toBe(true)

    const c = await chrome(app)
    await expect(c.getByTestId('activity-count')).toBeVisible()
    await expect(c.getByTestId('notice')).toHaveCount(0)
    await expect(c.locator('.activity')).toHaveCount(0) // the old stacked banners
    const log = await activityLog(app)
    await expect(log.locator('[data-kind="script"]').first()).toContainText('shop.test:19153')
    await expect(log.locator('[data-kind="offsite"]').first()).toContainText('attacker.test:19158')
    await expect(log.locator('[data-kind="blocked"]').first()).toContainText('nas.lan:19153')
    // a public site is never reported as the office network
    await expect(log.locator('[data-kind="blocked"]', { hasText: 'attacker.test' })).toHaveCount(0)
    await expect(c.getByTestId('activity-count')).toHaveCount(0) // seen
    // the "AI is using the browser" bar carries the latest action instead of a banner per action
    await expect(c.getByTestId('driving-last')).not.toBeEmpty()
    await c.getByTestId('activity-button').click()
    await expect(c.getByTestId('activity')).toHaveCount(0)
  })

  test('a refused page load to this computer or the team is one dismissible line; a newer one replaces it', async () => {
    const c = await chrome(app)
    const address = c.getByTestId('pane-address')
    await address.fill(`${ACME}/`)
    await address.press('Enter')
    await expect(c.getByTestId('notice')).toContainText('acme.localhost:19151')
    await address.fill('http://localhost:19153/')
    await address.press('Enter')
    await expect(c.getByTestId('notice')).toHaveCount(1)
    await expect(c.getByTestId('notice')).toContainText('localhost:19153')
    await c.getByTestId('notice').getByRole('button').click()
    await expect(c.getByTestId('notice')).toHaveCount(0)
  })
})

test('allow all websites: public sites open without asking, office addresses still ask, shown and saved', async () => {
  const userData = newUserData()
  let app = await launch(userData)
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await page.evaluate(() => (window as any).mycelDesktop.pane.open())
    const c = await chrome(app)
    await c.getByTestId('sites-button').click()
    await expect(c.getByTestId('site-access-ask')).toBeChecked()
    await c.getByTestId('site-access-all').check()
    await expect(c.getByTestId('access-all-on')).toBeVisible()
    await c.getByTestId('sites-button').click()

    newTurn()
    const shop = await run(ACME, 'navigate', { url: `${SHOP}/` })
    expect(shop.result.ok, text(shop)).toBe(true)
    expect(await prompts(app)).toBe(0)
    const other = await run(ACME, 'navigate', { url: `${ATTACKER}/ok?q=allow-all` })
    expect(other.result.ok, text(other)).toBe(true)
    expect(await prompts(app)).toBe(0)

    // office network: still asked
    const office = await call(ACME, 'navigate', { url: `${OFFICE_SITE}/` })
    await answer(app, '거부', 'private')
    const o = await result(ACME, office.callId)
    expect(o.result.ok).toBe(false)
    expect(text(o)).toContain('office-network address nas.lan:19153')
    // the team address and this computer: still never
    const team = await run(ACME, 'navigate', { url: `${ACME}/api/me` })
    expect(text(team)).toContain("team's own address")

    const teamId = (JSON.parse(readFileSync(join(userData, 'teams.json'), 'utf8')) as { teams: { id: string }[] }).teams[0].id
    expect(JSON.parse(readFileSync(join(userData, 'teams', teamId, 'permissions.json'), 'utf8')).siteAccess).toBe('all')
  } finally {
    await close(app)
  }
  app = await launch(userData)
  try {
    const page = await bindWindow(await teamPage(app, ACME), ACME)
    await page.evaluate(() => (window as any).mycelDesktop.pane.open())
    const c = await chrome(app)
    await expect(c.getByTestId('access-all-on')).toBeVisible()
    // back to asking: the pill goes, a new site asks again
    await c.getByTestId('access-all-on').click()
    await c.getByTestId('site-access-ask').check()
    await expect(c.getByTestId('access-all-on')).toHaveCount(0)
    newTurn()
    const asks = await call(ACME, 'navigate', { url: `${SHOP}/` })
    await answer(app, '거부', 'site')
    expect((await result(ACME, asks.callId)).result.ok).toBe(false)
  } finally {
    await close(app)
  }
})
