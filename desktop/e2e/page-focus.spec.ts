// The team page's own focus is not its window's (docs/DECISIONS.md "화면에 연 대화는 울리지 않는다"). The team page is
// one of several views in the window: after the app starts with a remembered team the window is focused and no view has
// the focus, so the page's document.hasFocus() is false until a click into it (the same while the address strip has the
// keyboard: not checked here, the strip is not always on screen). Going by it, the web app rang for the room on screen
// and did not mark it read. It goes by the app's word (DesktopBridge.focus) instead, which this checks: focused while
// the window is.
// Playwright makes every page it drives report the focus; that is turned off here, so the page answers as for a person.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, bindWindow, close, launch, newUserData, signIn, teamPage } from './helpers'

const windowFocused = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isFocused())
const realFocus = async (p: Page) => (await p.context().newCDPSession(p)).send('Emulation.setFocusEmulationEnabled', { enabled: false })
const pageFocus = (p: Page) => p.evaluate(() => document.hasFocus())
const bridgeFocus = (p: Page) => p.evaluate(() => (window as unknown as { mycelDesktop: { focus: { get(): Promise<boolean> } } }).mycelDesktop.focus.get())

test('started with a team: the window focused and the team page without focus of its own; the bridge says focused', async () => {
  const userData = newUserData()
  let app = await launch(userData)
  try {
    await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
  } finally {
    await close(app)
  }
  app = await launch(userData)
  try {
    const page = await bindWindow(await teamPage(app, ACME), ACME)
    await realFocus(page)
    // (another app in front on this computer: the window never gets the focus, nothing to check)
    await expect.poll(() => windowFocused(app), { timeout: 5000 }).toBe(true).catch(() => {})
    test.skip(!(await windowFocused(app)), 'the window did not get the focus: another app is in front')
    // started with the team: no view has the focus
    expect(await pageFocus(page)).toBe(false)
    expect(await bridgeFocus(page)).toBe(true)
    // the team page gets it (a click into it): both say focused (so the page's own answer above was not the test's)
    await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))!.focus(), ACME)
    await expect.poll(() => pageFocus(page)).toBe(true)
    expect(await bridgeFocus(page)).toBe(true)
  } finally {
    await close(app)
  }
})
