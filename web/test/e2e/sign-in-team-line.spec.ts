// The line under the sign-in card in the desktop app: the team address the app connected to and "Switch team", which
// opens the app's own team screen (owner 2026-11-15). Only in a desktop app that can drop its own strip above the page
// (DesktopBridge.hostLine): never in a plain browser, never in a desktop app without hostLine (its strip still shows the
// address). The real app is covered by desktop/e2e/desktop.spec.ts. Pictures: SIGNIN_LINE_SHOTS=<dir>.
import { expect, test, type Page } from '@playwright/test'
import { reset } from './helpers'

type Fake = { opened: number; hostLine: boolean[]; teamMenu: number }

/** A desktop bridge stand-in before the app's scripts; `hostLine`: the app is new enough to drop its strip. */
async function fakeDesktop(page: Page, o: { hostLine: boolean; teamAddress: string }) {
  await page.addInitScript((o) => {
    const noop = () => {}
    const d: Fake = { opened: 0, hostLine: [], teamMenu: 0 }
    const w = window as unknown as { mycelDesktop: unknown; __desktop: Fake }
    w.__desktop = d
    w.mycelDesktop = {
      bridgeVersion: 1,
      appVersion: '0.5.8',
      platform: 'darwin',
      browser: { run: async (c: { callId: string }) => ({ callId: c.callId, ok: false, content: [], error: 'no pane' }), cancel: noop },
      pane: { open: noop, close: noop, toggle: noop, getState: async () => ({ open: false, tabs: [], driving: false }), onState: () => noop },
      // over the office network the page is at another address: the line shows the team address, not location.host
      connection: { get: async () => ({ route: 'direct', origin: location.origin, teamAddress: o.teamAddress, fingerprintMismatch: false }), onChange: () => noop },
      notify: noop,
      openTeams: () => d.opened++,
      teamMenu: () => d.teamMenu++,
      setLocale: noop,
      ...(o.hostLine ? { hostLine: (drawn: boolean) => d.hostLine.push(drawn) } : {}),
    }
  }, o)
}
const fake = (page: Page) => page.evaluate(() => (window as unknown as { __desktop: Fake }).__desktop)

test.describe('sign-in: team address and Switch team under the card', () => {
  test.use({ locale: 'en-US' })

  test('a plain browser shows no line', async ({ page }) => {
    await reset(page, { teamLocale: 'en' })
    await page.goto('/login')
    await expect(page.getByTestId('login-submit')).toBeVisible()
    await expect(page.getByTestId('auth-team-line')).toHaveCount(0)
    await expect(page.getByText('Switch team')).toHaveCount(0)
  })

  test('a desktop app without hostLine keeps its own strip: no line on the page', async ({ page }) => {
    await fakeDesktop(page, { hostLine: false, teamAddress: 'https://qa.trina.app' })
    await reset(page, { teamLocale: 'en' })
    await page.goto('/login')
    await expect(page.getByTestId('login-submit')).toBeVisible()
    await expect(page.getByTestId('auth-team-line')).toHaveCount(0)
  })

  test('the desktop app: the team address and Switch team, which opens the team screen (no menu)', async ({ page }) => {
    await fakeDesktop(page, { hostLine: true, teamAddress: 'https://qa.trina.app' })
    await reset(page, { teamLocale: 'en' })
    await page.goto('/login')
    const line = page.getByTestId('auth-team-line')
    await expect(line).toBeVisible()
    await expect(page.getByTestId('auth-team-host')).toHaveText('qa.trina.app')
    // under the card, not above it
    const card = await page.getByTestId('login-submit').boundingBox()
    const box = await line.boundingBox()
    expect(box!.y).toBeGreaterThan(card!.y + card!.height)
    await expect.poll(async () => (await fake(page)).hostLine).toEqual([true])
    await page.getByTestId('auth-switch-team').click()
    expect(await fake(page)).toMatchObject({ opened: 1, teamMenu: 0 })
  })

  test('pictures at 1440 and 390, light and dark', async ({ page }) => {
    const dir = process.env.SIGNIN_LINE_SHOTS
    test.skip(!dir, 'SIGNIN_LINE_SHOTS not set')
    await fakeDesktop(page, { hostLine: true, teamAddress: 'https://qa.trina.app' })
    await reset(page, { teamLocale: 'en' })
    for (const scheme of ['light', 'dark'] as const) {
      for (const width of [1440, 390]) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
        await page.goto('/login')
        await expect(page.getByTestId('auth-team-host')).toHaveText('qa.trina.app')
        await page.screenshot({ path: `${dir}/signin-line-${width}-${scheme}.png` })
      }
    }
  })
})
