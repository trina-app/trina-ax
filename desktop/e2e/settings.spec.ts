// Clinic pilot (2026-10-22): staff asked the AI to answer reviews; signing in and moving between domains asked "AI
// wants to use …" for every new site, and "Allow all websites" was only in the pane's ⚙, where nobody found it.
//  - the team page's Settings > Browser reads and changes the same value as the pane's ⚙ (window.mycelDesktop
//    .browserSettings), and each side hears the other's changes at once
//  - the page can only ask for "all": the main process shows its own dialog, and only a click on "Allow all websites"
//    there changes it (cancel, Enter / Escape: nothing; a second request right away: busy)
//  - the team's policy (Admin > Team settings, Me.team.browserAllowAll) is read by the main process from the team
//    server: off refuses "all" (no dialog), turns a saved "all" back to "ask", disables the choice in the ⚙ panel, and
//    is remembered across a restart
//  - the third site question in a row carries a hint pointing at Settings › Browser and "Always allow" (once)
//  - office-network addresses and this computer stay asked / refused with "all" on
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, answer, bindWindow, call, chrome, close, launch, newTurn, newUserData, OFFICE_SITE, result, run, SHOP, teamPage, text } from './helpers'

type Settings = { siteAccess: 'ask' | 'all'; always: string[]; privateAlways: string[]; teamAllowsAll: boolean }
const get = (page: Page) => page.evaluate(() => (window as any).mycelDesktop.browserSettings.get() as Promise<Settings>)
const setAccess = (page: Page, v: string) => page.evaluate((x) => (window as any).mycelDesktop.browserSettings.setAccess(x) as Promise<string>, v)
const policy = (allowAll: boolean | null) => fetch(`${ACME.replace('acme.localhost', '127.0.0.1')}/test/policy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowAll }) })
const permissionsFile = (userData: string) => {
  const teamId = (JSON.parse(readFileSync(join(userData, 'teams.json'), 'utf8')) as { teams: { id: string }[] }).teams[0].id
  return JSON.parse(readFileSync(join(userData, 'teams', teamId, 'permissions.json'), 'utf8'))
}
/** Replace the app's native message box: answer with `response` and record what was shown. */
async function stubDialog(app: ElectronApplication, response: number) {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as any
    g.__boxes ??= []
    dialog.showMessageBox = (async (...a: any[]) => {
      g.__boxes.push(a.length > 1 ? a[1] : a[0])
      return { response: r, checkboxChecked: false }
    }) as any
  }, response)
}
const boxes = (app: ElectronApplication) => app.evaluate(() => ((globalThis as any).__boxes ?? []) as { message: string; buttons: string[]; cancelId: number; defaultId: number }[])

test('Settings > Browser and the pane ⚙ share one value; "all" needs the app\'s own dialog; the team policy is enforced by the app', async () => {
  test.setTimeout(180_000)
  await policy(true)
  const userData = newUserData()
  let app = await launch(userData)
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await page.evaluate(() => fetch('/test/login'))
    await page.evaluate(() => (window as any).mycelDesktop.pane.open())
    const c = await chrome(app)

    // the bridge offers exactly the five calls
    expect(await page.evaluate(() => Object.keys((window as any).mycelDesktop.browserSettings).sort())).toEqual(['clearSites', 'get', 'onChange', 'removeSite', 'setAccess'])
    expect(await get(page)).toEqual({ siteAccess: 'ask', always: [], privateAlways: [], teamAllowsAll: true })
    await page.evaluate(() => {
      ;(window as any).__changes = []
      ;(window as any).mycelDesktop.browserSettings.onChange((s: unknown) => (window as any).__changes.push(s))
    })
    const lastChange = () => page.evaluate(() => ((window as any).__changes as Settings[]).at(-1) ?? null)

    // the third site question in a row carries the hint (once); its link opens the ⚙ panel
    newTurn()
    for (let i = 0; i < 3; i++) {
      const s = await call(ACME, 'navigate', { url: `${SHOP}/?try=${i}` })
      const prompt = c.getByTestId('permission-prompt').first()
      await expect(prompt).toBeVisible()
      if (i < 2) await expect(c.getByTestId('prompt-hint')).toHaveCount(0)
      else {
        await expect(c.getByTestId('prompt-hint')).toContainText('설정 › 브라우저')
        await expect(c.getByTestId('prompt-hint')).toContainText('항상 허용')
        await c.getByTestId('prompt-hint-settings').click()
        await expect(c.getByTestId('sites')).toBeVisible()
        await c.getByTestId('sites-button').click()
      }
      await answer(app, '거부', 'site')
      expect((await result(ACME, s.callId)).result.ok).toBe(false)
    }
    const again = await call(ACME, 'navigate', { url: `${SHOP}/?try=4` })
    await expect(c.getByTestId('permission-prompt')).toBeVisible()
    await expect(c.getByTestId('prompt-hint')).toHaveCount(0) // once
    await answer(app, '항상 허용', 'site')
    expect((await result(ACME, again.callId)).result.ok).toBe(true)
    await expect.poll(async () => (await get(page)).always).toEqual(['shop.test:19153'])
    expect((await lastChange())?.always).toEqual(['shop.test:19153']) // the page heard about the answer

    // "all" from the page: the app's own dialog; cancelled = nothing changes
    await stubDialog(app, 0)
    expect(await setAccess(page, 'all')).toBe('cancelled')
    const shown = (await boxes(app))[0]
    expect(shown.message).toContain('Acme Team')
    expect(shown.buttons).toEqual(['취소', '모든 웹사이트 허용'])
    expect(shown.cancelId).toBe(0)
    expect(shown.defaultId).toBe(0)
    expect((await get(page)).siteAccess).toBe('ask')
    // a second request right after the dialog closed: refused without a dialog
    await stubDialog(app, 1)
    expect(await setAccess(page, 'all')).toBe('busy')
    expect((await boxes(app)).length).toBe(1)
    await new Promise((r) => setTimeout(r, 2100))
    // only these two values reach the app (anything else is "ask")
    expect(await setAccess(page, 'everything')).toBe('unchanged')
    // confirmed in the dialog: on; the pane shows "all websites allowed"; the page heard about it
    expect(await setAccess(page, 'all')).toBe('changed')
    expect((await boxes(app)).length).toBe(2)
    expect((await get(page)).siteAccess).toBe('all')
    await expect(c.getByTestId('access-all-on')).toBeVisible()
    expect((await lastChange())?.siteAccess).toBe('all')
    expect(permissionsFile(userData)).toMatchObject({ siteAccess: 'all', teamAllowsAll: true })

    // with "all": public sites open without asking; the office network still asks; this computer is still refused
    newTurn()
    expect((await run(ACME, 'navigate', { url: `${SHOP}/` })).result.ok).toBe(true)
    const office = await call(ACME, 'navigate', { url: `${OFFICE_SITE}/` })
    await answer(app, '거부', 'private')
    expect((await result(ACME, office.callId)).result.ok).toBe(false)
    expect(text(await run(ACME, 'navigate', { url: 'http://127.0.0.1:19153/' }))).toContain('this computer')

    // the pane ⚙ changes it back: the page hears at once
    await c.getByTestId('access-all-on').click()
    await c.getByTestId('site-access-ask').check()
    await expect.poll(async () => (await lastChange())?.siteAccess).toBe('ask')
    await c.getByTestId('sites-button').click()

    // remove one site from the page (and nothing for a host not in the list); clear all
    expect((await page.evaluate(() => (window as any).mycelDesktop.browserSettings.removeSite('not-there.test')))?.always).toEqual(['shop.test:19153'])
    expect((await page.evaluate(() => (window as any).mycelDesktop.browserSettings.removeSite('shop.test:19153')))?.always).toEqual([])
    expect(permissionsFile(userData).always).toEqual([])

    // "ask" from the page needs no dialog
    await new Promise((r) => setTimeout(r, 2100))
    expect(await setAccess(page, 'all')).toBe('changed')
    const before = (await boxes(app)).length
    expect(await setAccess(page, 'ask')).toBe('changed')
    expect((await boxes(app)).length).toBe(before)

    // the team turns the choice off: the app reads it from the team server (here: when the page reads the setting)
    await new Promise((r) => setTimeout(r, 2100))
    expect(await setAccess(page, 'all')).toBe('changed')
    await policy(false)
    await new Promise((r) => setTimeout(r, 5100)) // a page read re-reads the policy at most every 5 s
    await get(page)
    await expect.poll(async () => (await get(page)).teamAllowsAll).toBe(false)
    expect((await get(page)).siteAccess).toBe('ask') // reverted by the app itself
    expect((await lastChange())?.siteAccess).toBe('ask')
    expect(permissionsFile(userData)).toMatchObject({ siteAccess: 'ask', teamAllowsAll: false })
    await expect(c.getByTestId('access-all-on')).toHaveCount(0)
    // refused without a dialog, from the page and from the pane ⚙
    const n = (await boxes(app)).length
    expect(await setAccess(page, 'all')).toBe('not-allowed')
    expect((await boxes(app)).length).toBe(n)
    await c.getByTestId('sites-button').click()
    await expect(c.getByTestId('site-access-all')).toBeDisabled()
    await expect(c.getByTestId('site-access-policy')).toBeVisible()
    // a new site asks again; with the policy off, the hint (already shown) does not come back
    newTurn()
    const asks = await call(ACME, 'navigate', { url: 'http://attacker.test:19158/ok?policy=off' })
    await answer(app, '거부', 'site')
    expect((await result(ACME, asks.callId)).result.ok).toBe(false)
  } finally {
    await close(app)
  }

  // restart: the last policy is kept in the team's permissions file, so it holds from the start
  app = await launch(userData)
  try {
    const page = await bindWindow(await teamPage(app, ACME), ACME)
    expect(await get(page)).toMatchObject({ siteAccess: 'ask', teamAllowsAll: false })
    await stubDialog(app, 1)
    expect(await setAccess(page, 'all')).toBe('not-allowed')
    // the team turns it back on: possible again, after the app's dialog
    await policy(true)
    await page.evaluate(() => fetch('/test/login'))
    await new Promise((r) => setTimeout(r, 5100))
    await get(page)
    await expect.poll(async () => (await get(page)).teamAllowsAll).toBe(true)
    expect((await get(page)).siteAccess).toBe('ask')
    expect(await setAccess(page, 'all')).toBe('changed')
  } finally {
    await close(app)
    await policy(null)
  }
})
