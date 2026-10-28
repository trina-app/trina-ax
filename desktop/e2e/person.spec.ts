// QA finding 4 (2026-10-27): on a shared desk the in-app browser kept the previous person's cookies and "always
// allowed" sites when someone else signed in to the same team. The pane's data now belongs to one person
// (common/browser-owner.ts): another person signing in, or a sign-out, clears it before the AI uses the pane.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ACME, addTeam, answer, bindWindow, call, chrome, close, launch, newTurn, newUserData, result, run, SHOP, text } from './helpers'

type Settings = { siteAccess: 'ask' | 'all'; always: string[]; privateAlways: string[]; teamAllowsAll: boolean }
const teamFile = (userData: string, name: string) => {
  const teamId = (JSON.parse(readFileSync(join(userData, 'teams.json'), 'utf8')) as { teams: { id: string }[] }).teams[0].id
  return JSON.parse(readFileSync(join(userData, 'teams', teamId, name), 'utf8'))
}

test('another person on the same team gets an empty in-app browser: no cookies, no allowed sites', async () => {
  test.setTimeout(180_000)
  const userData = newUserData()
  const app = await launch(userData)
  try {
    const page = await addTeam(app, 'acme.localhost:19151', ACME)
    await page.evaluate(() => fetch('/test/login?user=raka'))
    await page.reload()
    await bindWindow(page, ACME)
    await page.evaluate(() => (window as any).mycelDesktop.pane.open())
    const c = await chrome(app)
    const get = () => page.evaluate(() => (window as any).mycelDesktop.browserSettings.get() as Promise<Settings>)

    // raka: a site sets a cookie, and raka allows the site always
    newTurn()
    const first = await call(ACME, 'navigate', { url: `${SHOP}/set-cookie` })
    await expect(c.getByTestId('permission-prompt')).toBeVisible()
    await answer(app, '항상 허용', 'site')
    expect((await result(ACME, first.callId)).result.ok).toBe(true)
    expect((await run(ACME, 'navigate', { url: `${SHOP}/cookie` })).result.ok).toBe(true)
    expect(text(await run(ACME, 'get_page_text'))).toContain('fixture=1')
    await expect.poll(async () => (await get()).always).toEqual(['shop.test:19153'])
    await expect.poll(() => teamFile(userData, 'browser-owner.json')).toEqual({ userId: 'raka' })

    // the same person signs in again: nothing is cleared
    await page.evaluate(() => fetch('/test/login?user=raka'))
    await page.reload()
    await bindWindow(page, ACME)
    await page.waitForTimeout(6000)
    expect((await run(ACME, 'navigate', { url: `${SHOP}/cookie` })).result.ok).toBe(true)
    expect(text(await run(ACME, 'get_page_text'))).toContain('fixture=1')
    expect((await get()).always).toEqual(['shop.test:19153'])

    // raka signs out and seungju signs in on the same desk, without a page reload
    await page.evaluate(() => fetch('/test/logout'))
    await page.evaluate(() => fetch('/test/login?user=seungju'))
    await page.waitForTimeout(6000) // the last /api/me read is older than the 5 s check interval
    newTurn()
    const second = await call(ACME, 'navigate', { url: `${SHOP}/cookie` })
    // the site is no longer allowed: seungju is asked
    await expect(c.getByTestId('permission-prompt')).toBeVisible()
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, second.callId)).result.ok).toBe(true)
    const pageText = text(await run(ACME, 'get_page_text'))
    expect(pageText).toContain('cookie')
    expect(pageText).not.toContain('fixture=1')
    expect((await get()).always).toEqual([])
    expect(teamFile(userData, 'permissions.json')).toMatchObject({ always: [], privateAlways: [], siteAccess: 'ask' })
    expect(teamFile(userData, 'browser-owner.json')).toEqual({ userId: 'seungju' })
  } finally {
    await close(app)
  }
})
