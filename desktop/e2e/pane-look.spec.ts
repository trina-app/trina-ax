// The in-app browser while the AI uses it (docs/DECISIONS.md "AI가 브라우저를 쓰는 동안"): a calm signal in the toolbar
// (a pulsing dot, "트리나가 브라우저를 쓰는 중", a Stop button, a thin accent line over the page), never a solid accent
// colour, also before the first page has drawn; the page keeps its size when a call starts or ends.
// With SHOTS_DIR set, the review screenshots of the whole window are saved there (light and dark, the AI in control,
// the first page loading).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { ACME, addTeam, answer, call, chrome, close, dragEdge, launch, newTurn, newUserData, paneViews, result, SHOP, signIn, text, windowShot } from './helpers'

const SHOTS = process.env.SHOTS_DIR

/** The system's light or dark look: the app's own colours (nativeTheme) and its screens' prefers-color-scheme (Playwright
 * pins every page it drives to light unless told otherwise). */
async function theme(app: ElectronApplication, page: Page, dark: boolean) {
  await app.evaluate(({ nativeTheme }, d) => {
    nativeTheme.themeSource = d ? 'dark' : 'light'
  }, dark)
  for (const p of app.windows()) if (p.url().startsWith('mycel-ui:')) await p.emulateMedia({ colorScheme: dark ? 'dark' : 'light' })
  // the fake team page has no dark look of its own: give it the web app's dark canvas for the pictures
  await page.evaluate((d) => {
    document.documentElement.style.background = d ? '#0e0c0b' : ''
    document.documentElement.style.color = d ? '#f6f2ea' : ''
  }, dark)
}

async function windowSize(app: ElectronApplication, width: number, height: number) {
  await app.evaluate(({ BaseWindow }, s) => BaseWindow.getAllWindows()[0]!.setContentSize(s.width, s.height), { width, height })
}

/** One pixel of the browser toolbar's view as it draws it, at (x, y) in the view: [r, g, b]. */
async function toolbarPixel(app: ElectronApplication, x: number, y: number): Promise<number[]> {
  return app.evaluate(async ({ webContents }, p) => {
    const w = webContents.getAllWebContents().find((c) => c.getURL().endsWith('/pane.html'))!
    const img = await w.capturePage({ x: p.x, y: p.y, width: 1, height: 1 })
    const bgra = img.toBitmap()
    return [bgra[2]!, bgra[1]!, bgra[0]!]
  }, { x, y })
}
const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]!) <= 6)
const ACCENT_LIGHT = [232, 82, 26]
const CANVAS_LIGHT = [252, 251, 248]
const windowColour = (app: ElectronApplication) => app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.getBackgroundColor().toUpperCase())

test('the AI in control: a calm signal that comes and goes; no solid accent colour before the first page draws', async () => {
  const app = await launch(newUserData())
  try {
    const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
    await windowSize(app, 1440, 900)
    await theme(app, page, false)
    expect(await windowColour(app)).toBe('#FCFBF8')
    const c = await chrome(app)
    const driving = c.getByTestId('driving')

    // the first page of a turn: the question, the AI's signal, and the theme's own surface where the page goes
    newTurn()
    const first = await call(ACME, 'navigate', { url: `${SHOP}/slow?ms=4000` })
    await expect(c.getByTestId('permission-prompt')).toBeVisible()
    await expect(driving).toBeVisible()
    await expect(driving).toContainText('트리나가 브라우저를 쓰는 중')
    await expect(c.getByTestId('stop')).toBeVisible()
    expect((await paneViews(app)).tab).toBeNull()
    const look = () =>
      c.evaluate(() => {
        const css = (el: Element | null, pseudo?: string) => (el ? getComputedStyle(el, pseudo) : null)
        return {
          body: css(document.body)!.backgroundColor,
          pane: css(document.getElementById('main'))!.backgroundColor,
          row: css(document.querySelector('.driving-bar'))!.backgroundColor,
          line: css(document.getElementById('toolbar'), '::after')!.backgroundColor,
          lineHeight: css(document.getElementById('toolbar'), '::after')!.height,
        }
      })
    expect(await look()).toEqual({ body: 'rgba(0, 0, 0, 0)', pane: 'rgb(252, 251, 248)', row: 'rgba(0, 0, 0, 0)', line: 'rgb(232, 82, 26)', lineHeight: '2px' })
    // what the view draws under the question (the page's place): the canvas, not the accent
    const under = await toolbarPixel(app, 300, 800)
    expect(near(under, CANVAS_LIGHT), String(under)).toBe(true)
    expect(near(under, ACCENT_LIGHT)).toBe(false)

    // allowed: the tab loads late; it is not drawn yet, the view shows a quiet loading line on the same surface
    await answer(app, '이번만 허용', 'site')
    await expect.poll(async () => (await paneViews(app)).tab?.visible).toBe(false)
    await expect(c.getByTestId('pane-loading')).toBeVisible()
    await expect(c.getByTestId('pane-loading')).toHaveText('페이지를 여는 중…')
    expect(near(await toolbarPixel(app, 300, 800), CANVAS_LIGHT)).toBe(true)
    expect((await result(ACME, first.callId)).result.ok).toBe(true)
    // the page drew: the tab is shown, across the whole browser width
    await expect.poll(async () => (await paneViews(app)).tab?.visible).toBe(true)
    const before = (await paneViews(app)).tab!
    expect({ x: before.x, width: before.width }).toEqual({ x: 1440 - 648, width: 648 })
    await expect(driving).toBeHidden()
    expect((await look()).line).toBe('rgba(0, 0, 0, 0)')

    // a call runs: the signal is back; the page is not framed or narrowed
    const waiting = await call(ACME, 'computer', { action: 'wait', duration: 8 })
    await expect(driving).toBeVisible()
    const during = (await paneViews(app)).tab!
    expect({ x: during.x, width: during.width }).toEqual({ x: before.x, width: before.width })
    expect((await look()).line).toBe('rgb(232, 82, 26)')
    // the person stops it: the signal goes at once
    await c.getByTestId('stop').click()
    expect(text(await result(ACME, waiting.callId))).toContain('The user stopped')
    await expect(driving).toBeHidden()
    // a call that ends by itself: the same
    const quick = await call(ACME, 'computer', { action: 'wait', duration: 1 })
    await expect(driving).toBeVisible()
    expect((await result(ACME, quick.callId)).result.ok).toBe(true)
    await expect(driving).toBeHidden()

    // dark: the window's own colour follows
    await theme(app, page, true)
    await expect.poll(() => windowColour(app)).toBe('#0E0C0B')
    expect((await look()).pane).toBe('rgb(14, 12, 11)')
  } finally {
    await close(app)
  }
})

test.describe('screenshots', () => {
  test.skip(!SHOTS, 'SHOTS_DIR not set')

  test('the AI in control, light and dark; the first page loading', async () => {
    mkdirSync(SHOTS!, { recursive: true })
    const app = await launch(newUserData())
    try {
      const page = await signIn(await addTeam(app, 'acme.localhost:19151', ACME))
      await windowSize(app, 1440, 900)
      const c = await chrome(app)
      for (const dark of [false, true]) {
        const mode = dark ? 'dark' : 'light'
        await theme(app, page, dark)
        // a fresh pane: the first page of a turn asks first, then loads late
        newTurn()
        const first = await call(ACME, 'navigate', { url: `${SHOP}/slow?ms=6000` })
        await expect(c.getByTestId('permission-prompt')).toBeVisible()
        await page.waitForTimeout(400)
        await windowShot(app, join(SHOTS!, `ask-first-${mode}.png`))
        await answer(app, '이번만 허용', 'site')
        await page.waitForTimeout(1200)
        await windowShot(app, join(SHOTS!, `loading-${mode}.png`))
        expect((await result(ACME, first.callId)).result.ok).toBe(true)
        // the shop page, the AI in control (a long wait), then idle
        const nav = await call(ACME, 'navigate', { url: `${SHOP}/` })
        expect((await result(ACME, nav.callId)).result.ok).toBe(true)
        const waiting = await call(ACME, 'computer', { action: 'wait', duration: 8 })
        await expect(c.getByTestId('driving')).toBeVisible()
        await page.waitForTimeout(500)
        await windowShot(app, join(SHOTS!, `ai-${mode}.png`))
        await c.getByTestId('stop').click()
        expect(text(await result(ACME, waiting.callId))).toContain('The user stopped')
        await expect(c.getByTestId('driving')).toBeHidden()
        await page.waitForTimeout(300)
        await windowShot(app, join(SHOTS!, `idle-${mode}.png`))
        // close the pane's tabs for the next round (a fresh pane again)
        const ctx = JSON.parse(text(await result(ACME, (await call(ACME, 'tabs_context')).callId)).split('\nThe browser pane')[0]!) as { tabs: { tabId: string }[] }
        for (const t of ctx.tabs) await result(ACME, (await call(ACME, 'tabs_close', { tabId: t.tabId })).callId)
      }
      // the edge (only where the handle exists): dragged narrow and wide, the accent line while it drags
      if (process.env.SHOTS_EDGE !== '0') {
        expect((await result(ACME, (await call(ACME, 'navigate', { url: `${SHOP}/` })).callId)).result.ok).toBe(true)
        for (const dark of [false, true]) {
          const mode = dark ? 'dark' : 'light'
          await theme(app, page, dark)
          await dragEdge(app, 1040)
          await page.waitForTimeout(400)
          await windowShot(app, join(SHOTS!, `narrow-${mode}.png`))
          await dragEdge(app, 360, { release: false })
          await page.waitForTimeout(400)
          await windowShot(app, join(SHOTS!, `wide-dragging-${mode}.png`))
          await dragEdge(app, 360)
          await page.waitForTimeout(400)
          await windowShot(app, join(SHOTS!, `wide-${mode}.png`))
          await (await chrome(app)).getByTestId('pane-divider').dblclick()
        }
      }
    } finally {
      await close(app)
    }
  })
})
