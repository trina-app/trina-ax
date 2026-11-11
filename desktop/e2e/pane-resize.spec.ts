// The in-app browser's width (docs/DECISIONS.md "브라우저 너비는 끌어서", common/pane-width.ts): the person drags the edge
// between the team page and the browser, or focuses it and uses the arrow keys; double-click resets. The team page keeps
// 360 px and the browser 400 px; the width is a share of the window, remembered across restarts and kept when the
// window changes size. A drag does not move the keyboard: typing goes where it went before (#327).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, bindWindow, chrome, close, dragEdge, launch, newUserData, paneViews, signIn, teamPage } from './helpers'

const windowJson = (userData: string) => JSON.parse(readFileSync(join(userData, 'window.json'), 'utf8')) as { paneFraction?: number }

async function contentSize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BaseWindow }, s) => BaseWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), { width, height })
}

async function openPane(page: Page) {
  await page.evaluate(() => (window as unknown as { mycelDesktop: { pane: { open(): void } } }).mycelDesktop.pane.open())
}

/** the browser's width now: the window minus the team page */
const paneWidth = async (app: ElectronApplication) => {
  const v = await paneViews(app)
  return v.content.width - (v.page?.width ?? 0)
}

/** both views agree on the edge: the team page ends where the browser begins, the toolbar's view 6 px further left */
async function expectEdge(app: ElectronApplication, pane: number) {
  await expect.poll(() => paneWidth(app)).toBe(pane)
  const v = await paneViews(app)
  expect(v.page!.x).toBe(0)
  expect(v.toolbar).toEqual({ x: v.content.width - pane - 6, y: 0, width: pane + 6, height: v.content.height })
}

test('drag the edge: both views follow, the limits hold, the width survives a restart and a window resize', async () => {
  const userData = newUserData()
  let app = await launch(userData)
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    await contentSize(app, 1440, 900)
    await openPane(page)
    // nothing remembered: 45% of the window
    await expectEdge(app, 648)
    const c = await chrome(app)
    const edge = c.getByTestId('pane-divider')
    await expect(edge).toHaveAttribute('role', 'separator')
    await expect(edge).toHaveAttribute('aria-valuenow', '648')
    await expect(edge).toHaveAttribute('aria-valuemin', '400')
    await expect(edge).toHaveAttribute('aria-valuemax', '1080')

    // wider: the edge to x = 600
    await dragEdge(app, 600)
    await expectEdge(app, 840)
    await expect(edge).toHaveAttribute('aria-valuenow', '840')
    await expect.poll(() => windowJson(userData).paneFraction).toBeCloseTo(840 / 1440, 3)
    // past the team page's minimum: it keeps 360 px
    await dragEdge(app, 100)
    await expectEdge(app, 1080)
    // past the browser's minimum: it keeps 400 px
    await dragEdge(app, 1400)
    await expectEdge(app, 400)
    // a press without a move changes nothing
    await dragEdge(app, 1040, { steps: 0 })
    await expectEdge(app, 400)
    await dragEdge(app, 900)
    await expectEdge(app, 540)
    expect(windowJson(userData).paneFraction).toBeCloseTo(540 / 1440, 3)

    // a smaller window keeps the share within the limits; a bigger one gives the share back
    await contentSize(app, 1000, 800)
    await expectEdge(app, 400)
    await contentSize(app, 2000, 900)
    await expectEdge(app, 750)
    await contentSize(app, 1440, 900)
    await expectEdge(app, 540)

    // after a restart: the same width
    await close(app)
    app = await launch(userData)
    const again = await bindWindow(await teamPage(app, ACME), ACME)
    await contentSize(app, 1440, 900)
    await openPane(again)
    await expectEdge(app, 540)
  } finally {
    await close(app)
  }
})

test('the focused edge: arrow keys, Shift, Home and End; a double-click resets', async () => {
  const userData = newUserData()
  const app = await launch(userData)
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    await contentSize(app, 1440, 900)
    await openPane(page)
    await expectEdge(app, 648)
    const c = await chrome(app)
    const edge = c.getByTestId('pane-divider')
    await edge.focus()
    await edge.press('ArrowLeft')
    await expectEdge(app, 672)
    await edge.press('Shift+ArrowLeft')
    await expectEdge(app, 768)
    await edge.press('ArrowRight')
    await expectEdge(app, 744)
    await edge.press('Home')
    await expectEdge(app, 400)
    await edge.press('End')
    await expectEdge(app, 1080)
    await expect(edge).toHaveAttribute('aria-valuenow', '1080')
    await expect(edge).toBeFocused()
    expect(windowJson(userData).paneFraction).toBeCloseTo(0.75, 3)
    // a double-click: the default width again, nothing remembered
    await edge.dblclick()
    await expectEdge(app, 648)
    await expect.poll(() => windowJson(userData).paneFraction).toBeUndefined()
  } finally {
    await close(app)
  }
})

/** Type at the keyboard: each key goes to the web contents that has it, as the system sends key presses. */
const typeAtKeyboard = (app: ElectronApplication, text: string) =>
  app.evaluate(({ webContents }, keys) => {
    const w = webContents.getFocusedWebContents()
    if (!w) return null
    for (const k of keys) {
      w.sendInputEvent({ type: 'keyDown', keyCode: k })
      w.sendInputEvent({ type: 'char', keyCode: k })
      w.sendInputEvent({ type: 'keyUp', keyCode: k })
    }
    return w.getURL()
  }, text)
const keyboardAt = (app: ElectronApplication) => app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? null)
const windowFocused = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().some((w) => w.isFocused()))

test('a drag of the edge keeps the keyboard where it was: the team page\'s message box, its draft and caret', async () => {
  const app = await launch(newUserData())
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    // the page answers about its focus as for a person (Playwright makes every page it drives report the focus)
    await (await page.context().newCDPSession(page)).send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await expect.poll(() => windowFocused(app), { timeout: 5000 }).toBe(true).catch(() => {})
    test.skip(!(await windowFocused(app)), 'the window did not get the focus: another app is in front')
    await contentSize(app, 1440, 900)
    await openPane(page)
    await expectEdge(app, 648)
    await page.evaluate(() => {
      const box = document.createElement('textarea')
      box.id = 'message'
      document.body.append(box)
      box.value = 'draft'
      box.focus()
      box.setSelectionRange(5, 5)
    })
    await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find((w) => w.getURL().startsWith(origin))!.focus(), ACME)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151/)

    // during the drag the page keeps its own element; the system has the keyboard on the toolbar the press landed in,
    // and the layout moving under the pointer gives it to no other view
    await dragEdge(app, 700, { release: false })
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('message')
    expect(await keyboardAt(app)).toMatch(/\/pane\.html$/)
    // released: the keyboard is back in the team page, on the message box, and typing goes on where it was
    const toolbar = await paneViews(app).then((v) => v.toolbar!)
    await app.evaluate(({ BaseWindow }, b) => {
      const win = BaseWindow.getAllWindows().find((w) => w.contentView.children.length > 0)!
      const content = win.getContentBounds()
      const v = (win.contentView.children as (Electron.View & { webContents?: Electron.WebContents })[]).find((x) => x.webContents?.getURL().endsWith('/pane.html'))!
      v.webContents!.sendInputEvent({ type: 'mouseUp', x: 3, y: Math.round(b.height / 2), globalX: content.x + 697, globalY: content.y + Math.round(b.height / 2), button: 'left', clickCount: 1 })
    }, toolbar)
    await expectEdge(app, 740)
    await expect.poll(() => keyboardAt(app)).toMatch(/^http:\/\/acme\.localhost:19151/)
    expect(await page.evaluate(() => ({ id: document.activeElement?.id, caret: (document.activeElement as HTMLTextAreaElement).selectionStart, focused: document.hasFocus() }))).toEqual({ id: 'message', caret: 5, focused: true })
    expect(await typeAtKeyboard(app, 'ok')).toMatch(/^http:\/\/acme\.localhost:19151/)
    await expect.poll(() => page.evaluate(() => (document.getElementById('message') as HTMLTextAreaElement).value)).toBe('draftok')

    // the person clicked into the browser toolbar's address bar: it keeps the keyboard and its own focus
    const c = await chrome(app)
    const at = await c.getByTestId('pane-address').evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2) }
    })
    await app.evaluate(({ webContents }, p) => {
      const w = webContents.getAllWebContents().find((x) => x.getURL().endsWith('/pane.html'))!
      w.focus()
      w.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      w.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    }, at)
    await expect.poll(() => c.evaluate(() => document.activeElement?.id)).toBe('pane-address')
    await dragEdge(app, 760)
    await expectEdge(app, 680)
    await expect.poll(() => keyboardAt(app)).toMatch(/\/pane\.html$/)
    expect(await c.evaluate(() => document.activeElement?.id)).toBe('pane-address')
  } finally {
    await close(app)
  }
})
