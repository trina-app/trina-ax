// The keyboard goes back where it was when the person comes back to the window (docs/DECISIONS.md "창으로 돌아오면
// 키보드는 보던 곳으로", common/keyboard-focus.ts). The window holds several views; before, after a start with a team, a
// minimize and a restore, or the team list and back, the window was focused and no view had the keyboard: typing did
// nothing until a click into the page. And after the window was ordered out and back in (Cmd-H and a dock click),
// Chromium had moved the page's focus to its first focusable element: the message box lost it.
//
// What "typing reaches the page" takes, checked here: the window has the focus, the team page is the web contents with
// the keyboard (macOS: the window's first responder, where key presses go), the page's document has the focus, and its
// focused element is the message box. Playwright's own key presses would reach the page without any of that (they go
// straight to the page), so the test does not type through them. Playwright makes every page it drives report the
// focus; that is turned off here, so the page answers as for a person.
// The ways away and back are the app's own window calls: another window of the app taking the focus (as Cmd-Tab does),
// the window ordered out and back in (what Cmd-H and a dock click do to it; the app itself cannot be brought back in
// front without taking the focus from whatever else runs on the computer), and a minimize and a restore (the dock).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, answer, bindWindow, call, chrome, close, launch, newTurn, newUserData, result, SHOP, signIn, tabPage, teamPage, welcome } from './helpers'

const windowFocused = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().some((w) => w.isFocused() && w.getTitle() !== 'away'))
/** the address of the web contents that has the keyboard, or null */
const keyboardAt = (app: ElectronApplication) => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? null)
const realFocus = async (p: Page) => (await p.context().newCDPSession(p)).send('Emulation.setFocusEmulationEnabled', { enabled: false })
const pageFocus = (p: Page) => p.evaluate(() => document.hasFocus())
const focused = (p: Page) => p.evaluate(() => {
  const el = document.activeElement as HTMLTextAreaElement | null
  return { id: el?.id ?? '', value: el?.value ?? '', caret: el?.selectionStart ?? -1 }
})

/**
 * Type at the keyboard: each key goes to the web contents that has the keyboard, as the system sends a key press
 * (Playwright's own key presses go straight to the page it drives, wherever the keyboard is). Letters only.
 */
const typeAtKeyboard = (app: ElectronApplication, text: string) => app.evaluate(({ webContents }, keys) => {
  const w = webContents.getFocusedWebContents()
  if (!w) return null
  for (const k of keys) {
    w.sendInputEvent({ type: 'keyDown', keyCode: k })
    w.sendInputEvent({ type: 'char', keyCode: k })
    w.sendInputEvent({ type: 'keyUp', keyCode: k })
  }
  return w.getURL()
}, text)

/** The person clicks an element of a view (the view gets the keyboard, then the mouse press reaches the page). */
async function personClicks(app: ElectronApplication, p: Page, selector: string) {
  const at = await p.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  await app.evaluate(({ webContents }, { url, x, y }) => {
    const w = webContents.getAllWebContents().find((c) => c.getURL() === url)!
    w.focus()
    w.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    w.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }, { url: p.url(), ...at })
}

/** another app in front of this computer: the window never gets the focus, nothing to check */
async function needFocus(app: ElectronApplication) {
  await expect.poll(() => windowFocused(app), { timeout: 5000 }).toBe(true).catch(() => {})
  test.skip(!(await windowFocused(app)), 'the window did not get the focus: another app is in front')
}

/** Take the window away and bring it back, one of three ways (see above). */
async function awayAndBack(app: ElectronApplication, how: 'other window' | 'ordered out' | 'minimized') {
  if (how === 'other window') {
    await app.evaluate(({ BrowserWindow }) => {
      const w = new BrowserWindow({ width: 320, height: 200, title: 'away', show: true })
      ;(globalThis as { away?: unknown }).away = w
      w.focus()
    })
    await expect.poll(() => windowFocused(app)).toBe(false)
    await app.evaluate(({ BaseWindow }) => {
      const away = (globalThis as { away?: { close(): void } }).away
      BaseWindow.getAllWindows().find((w) => w.getTitle() !== 'away')!.focus()
      away?.close()
    })
  } else if (how === 'ordered out') {
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.blur())
    await expect.poll(() => windowFocused(app)).toBe(false)
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.focus())
  } else {
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.minimize())
    await expect.poll(() => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.isMinimized())).toBe(true)
    await app.evaluate(({ BaseWindow }) => {
      const w = BaseWindow.getAllWindows()[0]!
      w.restore()
      w.focus()
    })
  }
  await needFocus(app)
}

/** whom the app's in-app browser belongs to, as it saved it (null: not saved yet) */
const browserOwner = (userData: string): unknown => {
  try {
    const teamId = (JSON.parse(readFileSync(join(userData, 'teams.json'), 'utf8')) as { teams: { id: string }[] }).teams[0]!.id
    return JSON.parse(readFileSync(join(userData, 'teams', teamId, 'browser-owner.json'), 'utf8'))
  } catch {
    return null
  }
}

/** A started app with a remembered, signed-in team (a login start, a relaunch after an update). The app has seen the
 * person signed in before it quit, so the relaunch does not empty the in-app browser for a new person meanwhile. */
async function started(): Promise<{ app: ElectronApplication; page: Page }> {
  const userData = newUserData()
  const first = await launch(userData)
  try {
    const page = await signIn(await addTeam(first, 'acme.localhost:19151', ACME))
    await page.reload()
    await bindWindow(page, ACME)
    await expect.poll(() => browserOwner(userData)).toEqual({ userId: 'owner' })
  } finally {
    await close(first)
  }
  const app = await launch(userData)
  const page = await bindWindow(await teamPage(app, ACME), ACME)
  await realFocus(page)
  return { app, page }
}

/** The message box (the team page's own box in the app; here a plain one the page focuses, with a draft in it). */
async function messageBox(page: Page, draft: string) {
  await page.evaluate((d) => {
    const box = document.createElement('textarea')
    box.id = 'message'
    box.setAttribute('aria-label', 'message')
    document.body.append(box)
    box.focus()
    box.value = d
    box.setSelectionRange(d.length, d.length)
  }, draft)
}

test('after a start, the keyboard is in the team page without a click; also right after the team is added', async () => {
  const userData = newUserData()
  let app = await launch(userData)
  try {
    // the first start: the team list's address box had the keyboard, the team page takes its place
    const added = await addTeam(app, 'acme.localhost:19151', ACME)
    await realFocus(added)
    await needFocus(app)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    await signIn(added)
  } finally {
    await close(app)
  }
  app = await launch(userData)
  try {
    const page = await bindWindow(await teamPage(app, ACME), ACME)
    await realFocus(page)
    await needFocus(app)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    await expect.poll(() => pageFocus(page)).toBe(true)
    // the page's own box (the web app focuses its message box): it has the focus, with no click
    await messageBox(page, '')
    expect(await focused(page)).toMatchObject({ id: 'message' })
  } finally {
    await close(app)
  }
})

test('the message box keeps the focus, its draft and its caret when the window goes away and comes back', async () => {
  const { app, page } = await started()
  try {
    await needFocus(app)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    await messageBox(page, '내일 회의는 3시에')
    for (const how of ['other window', 'ordered out', 'minimized'] as const) {
      await awayAndBack(app, how)
      await expect.poll(() => keyboardAt(app), { message: how }).toMatch(/^http:\/\/acme\.localhost:19151\//)
      await expect.poll(() => pageFocus(page), { message: how }).toBe(true)
      // not moved to the page's first link (the order-out case before), not jumped to the box either: the box had it
      expect(await focused(page), how).toEqual({ id: 'message', value: '내일 회의는 3시에', caret: '내일 회의는 3시에'.length })
    }
    // another element had the focus: that one comes back, not the message box (a field after the box: Chromium's own
    // choice after an order-out is the page's first link, #external)
    await page.evaluate(() => {
      const search = document.createElement('input')
      search.id = 'search'
      document.body.append(search)
      search.focus()
    })
    await awayAndBack(app, 'ordered out')
    await expect.poll(() => pageFocus(page)).toBe(true)
    expect((await focused(page)).id).toBe('search')
  } finally {
    await close(app)
  }
})

test('a frame in the page taking the focus (an artifact) is not the page losing it: a click back into the box stays there', async () => {
  const { app, page } = await started()
  try {
    await needFocus(app)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    await messageBox(page, '초안')
    // the person clicks into the artifact frame, then back into the message box (twice: no bounce builds up)
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => (document.getElementById('art') as HTMLIFrameElement).focus())
      await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('art')
      await page.evaluate(() => (document.getElementById('message') as HTMLTextAreaElement).focus())
      await new Promise((r) => setTimeout(r, 300))
      expect(await focused(page)).toMatchObject({ id: 'message', value: '초안' })
      expect(await pageFocus(page)).toBe(true)
    }
  } finally {
    await close(app)
  }
})

test('a page load in the in-app browser does not take the keyboard from the message box: the typing goes on into the box', async () => {
  const { app, page } = await started()
  try {
    await needFocus(app)
    // the person opens the in-app browser; the AI opens a site and the person allows it in the toolbar
    await page.evaluate(() => (window as unknown as { mycelDesktop: { pane: { open(): void } } }).mycelDesktop.pane.open())
    newTurn()
    const first = await call(ACME, 'navigate', { url: `${SHOP}/` })
    await answer(app, '이번만 허용', 'site')
    expect((await result(ACME, first.callId)).result.ok).toBe(true)
    // the person clicks into the message box and types
    await messageBox(page, '')
    await personClicks(app, page, '#message')
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    expect(await typeAtKeyboard(app, 'abc')).toMatch(/^http:\/\/acme\.localhost:19151\//)
    // the AI moves the browser on (the same turn: no question) while the person types
    const next = await call(ACME, 'navigate', { url: `${SHOP}/?ai` })
    await typeAtKeyboard(app, 'def')
    expect((await result(ACME, next.callId)).result.ok).toBe(true)
    await typeAtKeyboard(app, 'ghi')
    // the site moves on by itself, and the app loads a page in the tab
    const tab = await tabPage(app, (u) => u === `${SHOP}/?ai`)
    await tab.evaluate(() => { location.href = '/?redirect' })
    await tabPage(app, (u) => u === `${SHOP}/?redirect`)
    await typeAtKeyboard(app, 'jkl')
    await app.evaluate(({ webContents }, shop) => void webContents.getAllWebContents().find((w) => w.getURL().startsWith(shop))!.loadURL(`${shop}/?load`), SHOP)
    await tabPage(app, (u) => u === `${SHOP}/?load`)
    await typeAtKeyboard(app, 'mno')
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    expect(await pageFocus(page)).toBe(true)
    expect(await focused(page)).toEqual({ id: 'message', value: 'abcdefghijklmno', caret: 15 })
    // the person uses the address bar: the page they open there gets the keyboard, as in a browser
    const c = await chrome(app)
    await personClicks(app, c, '[data-testid="pane-address"]')
    await c.getByTestId('pane-address').fill(`${SHOP}/?typed`)
    await c.getByTestId('pane-address').press('Enter')
    await tabPage(app, (u) => u === `${SHOP}/?typed`)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/shop\.test:19153\/\?typed/)
    // the person clicks back into the message box: the next load in the pane leaves it there
    await personClicks(app, page, '#message')
    await app.evaluate(({ webContents }, shop) => void webContents.getAllWebContents().find((w) => w.getURL().startsWith(shop))!.loadURL(`${shop}/?after`), SHOP)
    await tabPage(app, (u) => u === `${SHOP}/?after`)
    await typeAtKeyboard(app, 'pq')
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    expect((await focused(page)).value).toBe('abcdefghijklmnopq')
  } finally {
    await close(app)
  }
})

test('the team list and back: the keyboard is in the team page again, in its message box', async () => {
  const { app, page } = await started()
  try {
    await needFocus(app)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    await messageBox(page, '초안')
    await page.evaluate(() => (window as unknown as { mycelDesktop: { openTeams(): void } }).mycelDesktop.openTeams())
    const list = await welcome(app)
    await expect.poll(() => keyboardAt(app)).toMatch(/\/welcome\.html$/)
    await list.getByRole('button', { name: '돌아가기' }).click()
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    await expect.poll(() => pageFocus(page)).toBe(true)
    expect(await focused(page)).toEqual({ id: 'message', value: '초안', caret: 2 })
  } finally {
    await close(app)
  }
})

test('the in-app browser in front: the keyboard goes back there, a layout does not take it from the toolbar, closed: the team page', async () => {
  const { app, page } = await started()
  try {
    await needFocus(app)
    await page.evaluate(() => (window as unknown as { mycelDesktop: { pane: { open(): void } } }).mycelDesktop.pane.open())
    const c = await chrome(app)
    await c.getByTestId('pane-address').fill(`${SHOP}/`)
    await c.getByTestId('pane-address').press('Enter')
    const tab = await tabPage(app, (u) => u.startsWith(SHOP))
    await expect(tab.locator('#q')).toBeVisible()
    // the person clicks into the site
    await app.evaluate(({ webContents }, shop) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(shop))!.focus(), SHOP)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/shop\.test:19153\//)
    for (const how of ['other window', 'ordered out', 'minimized'] as const) {
      await awayAndBack(app, how)
      await expect.poll(() => keyboardAt(app), { message: how }).toMatch(/^http:\/\/shop\.test:19153\//)
    }
    // the person types an address in the pane's toolbar; the window is resized meanwhile (its views are laid out
    // again): the toolbar keeps the keyboard
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getURL().endsWith('/pane.html'))!.focus())
    await expect.poll(() => keyboardAt(app)).toMatch(/\/pane\.html$/)
    await app.evaluate(({ BaseWindow }) => {
      const w = BaseWindow.getAllWindows()[0]!
      const [width, height] = w.getSize()
      w.setSize(width - 40, height)
    })
    await new Promise((r) => setTimeout(r, 500))
    expect(await keyboardAt(app)).toMatch(/\/pane\.html$/)
    // the person writes in the team page's message box and leaves the window; meanwhile the in-app browser loads
    // another page, which takes the keyboard (Chromium does that on a page load): back at the window, the message box
    // has it again
    await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))!.focus(), ACME)
    await messageBox(page, '보고서 초안')
    await app.evaluate(({ BrowserWindow }) => {
      const w = new BrowserWindow({ width: 320, height: 200, title: 'away', show: true })
      ;(globalThis as { away?: unknown }).away = w
      w.focus()
    })
    await expect.poll(() => windowFocused(app)).toBe(false)
    await app.evaluate(({ webContents }, shop) => void webContents.getAllWebContents().find((w) => w.getURL().startsWith(shop))!.loadURL(`${shop}/?while-away`), SHOP)
    await tabPage(app, (u) => u === `${SHOP}/?while-away`)
    await app.evaluate(({ BaseWindow }) => {
      const away = (globalThis as { away?: { close(): void } }).away
      BaseWindow.getAllWindows().find((w) => w.getTitle() !== 'away')!.focus()
      away?.close()
    })
    await needFocus(app)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
    await expect.poll(() => pageFocus(page)).toBe(true)
    expect(await focused(page)).toEqual({ id: 'message', value: '보고서 초안', caret: '보고서 초안'.length })
    // back in the site, then the pane closes: the team page gets the keyboard
    await app.evaluate(({ webContents }, shop) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(shop))!.focus(), SHOP)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/shop\.test:19153\//)
    await page.evaluate(() => (window as unknown as { mycelDesktop: { pane: { close(): void } } }).mycelDesktop.pane.close())
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151\//)
  } finally {
    await close(app)
  }
})
