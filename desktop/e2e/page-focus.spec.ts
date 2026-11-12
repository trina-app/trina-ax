// The team page's own focus is not its window's (docs/DECISIONS.md "화면에 연 대화는 울리지 않는다"). The team page is
// one of several views in the window: while the in-app browser (its toolbar or a tab) has the keyboard, the page's
// document.hasFocus() is false (the same while the address strip has it: not checked here, the strip is not always on
// screen; before "창으로 돌아오면 키보드는 보던 곳으로" also after a start with a remembered team, until a click into the
// page). Going by it, the web app rang for the room on screen and did not mark it read. It goes by the app's word
// (DesktopBridge.focus) instead, which this checks: focused while the window is and shows the team page; not while the
// team list covers the page (which still reports itself visible).
// Playwright makes every page it drives report the focus; that is turned off here, so the page answers as for a person.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, bindWindow, chrome, close, launch, newUserData, signIn, teamPage, welcome } from './helpers'

const windowFocused = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isFocused())
const realFocus = async (p: Page) => (await p.context().newCDPSession(p)).send('Emulation.setFocusEmulationEnabled', { enabled: false })
const pageFocus = (p: Page) => p.evaluate(() => document.hasFocus())
const bridgeFocus = (p: Page) => p.evaluate(() => (window as unknown as { mycelDesktop: { focus: { get(): Promise<boolean> } } }).mycelDesktop.focus.get())

test('started with a team, the in-app browser toolbar with the keyboard: the team page without focus of its own, the bridge says focused; under the team list it says not', async () => {
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
    // started with the team, the team page has the keyboard ("창으로 돌아오면 키보드는 보던 곳으로"); the person opens the
    // in-app browser and its toolbar takes the keyboard: the page has no focus of its own, the window still has it
    await expect.poll(() => pageFocus(page)).toBe(true)
    await page.evaluate(() => (window as unknown as { mycelDesktop: { pane: { open(): void } } }).mycelDesktop.pane.open())
    await chrome(app)
    await expect.poll(() => page.evaluate(() => (window as unknown as { mycelDesktop: { pane: { getState(): Promise<{ open: boolean } | null> } } }).mycelDesktop.pane.getState().then((s) => s?.open ?? false))).toBe(true)
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().endsWith('/pane.html'))!.focus())
    await expect.poll(() => pageFocus(page)).toBe(false)
    expect(await windowFocused(app)).toBe(true)
    expect(await bridgeFocus(page)).toBe(true)
    // the team page gets it (a click into it): both say focused (so the page's own answer above was not the test's)
    await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))!.focus(), ACME)
    await expect.poll(() => pageFocus(page)).toBe(true)
    expect(await bridgeFocus(page)).toBe(true)
    // the team list over it: the page still reports itself visible, so the bridge says not looked at (and tells it)
    await page.evaluate(() => {
      const w = window as unknown as { mycelDesktop: { focus: { onChange(cb: (f: boolean) => void): () => void } }; told: boolean[] }
      w.told = []
      w.mycelDesktop.focus.onChange((f) => w.told.push(f))
    })
    await page.evaluate(() => (window as unknown as { mycelDesktop: { openTeams(): void } }).mycelDesktop.openTeams())
    const list = await welcome(app)
    await expect.poll(() => bridgeFocus(page)).toBe(false)
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible')
    // back to the team: looked at again
    await list.getByRole('button', { name: '돌아가기' }).click()
    await expect.poll(() => bridgeFocus(page)).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { told: boolean[] }).told)).toEqual([false, true])
  } finally {
    await close(app)
  }
})
