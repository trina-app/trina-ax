// The in-app browser beside the team page (docs/DECISIONS.md "브라우저 너비는 끌어서" and "AI가 브라우저를 쓰는 동안"):
// the width math of the edge handle (desktop/src/common/pane-width.ts), and how the desktop app is wired to it and to the
// calmer AI-control signal. The views themselves are checked in the desktop e2e (desktop/e2e/pane-resize.spec.ts,
// pane-look.spec.ts).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clampPane,
  PAGE_MIN,
  PANE_BIG_STEP,
  PANE_DEFAULT_FRACTION,
  PANE_GRAB,
  PANE_MIN,
  PANE_STEP,
  paneFromEdge,
  paneGrab,
  paneKeyWidth,
  paneLimits,
  paneWidthFor,
  readPaneFraction,
  settlePane,
} from '../../desktop/src/common/pane-width'
import { STRINGS } from '../../desktop/src/common/i18n'

describe('limits', () => {
  test('the team page keeps 360 px and the browser 400 px', () => {
    expect(PANE_MIN).toBe(400)
    expect(PAGE_MIN).toBe(360)
    expect(paneLimits(1440)).toEqual({ min: 400, max: 1080 })
    // the window's own minimum width (900) leaves room for both
    expect(paneLimits(900)).toEqual({ min: 400, max: 540 })
  })

  test('a window too narrow for both: the browser keeps its minimum, and never more than the window', () => {
    expect(paneLimits(700)).toEqual({ min: 400, max: 400 })
    expect(paneLimits(300)).toEqual({ min: 300, max: 300 })
    expect(paneLimits(0)).toEqual({ min: 0, max: 0 })
  })

  test('widths are clamped and whole pixels; nonsense is the minimum', () => {
    expect(clampPane(10, 1440)).toBe(400)
    expect(clampPane(5000, 1440)).toBe(1080)
    expect(clampPane(612.6, 1440)).toBe(613)
    expect(clampPane(Number.NaN, 1440)).toBe(400)
  })
})

describe('the remembered width', () => {
  test('nothing remembered: the default share of the window', () => {
    expect(PANE_DEFAULT_FRACTION).toBe(0.45)
    expect(paneWidthFor(null, 1440)).toBe(648)
    expect(paneWidthFor(null, 1000)).toBe(450)
  })

  test('a window resize keeps the share, within the limits', () => {
    expect(paneWidthFor(0.3, 2000)).toBe(600)
    expect(paneWidthFor(0.3, 1440)).toBe(432)
    // narrower: the browser's minimum
    expect(paneWidthFor(0.3, 1000)).toBe(400)
    // a wide browser in a smaller window: the team page keeps its 360 px
    expect(paneWidthFor(0.8, 1000)).toBe(640)
    expect(paneWidthFor(0.8, 2000)).toBe(1600)
  })

  test('only a number strictly between 0 and 1 is read back from window.json', () => {
    expect(readPaneFraction(0.3)).toBe(0.3)
    for (const bad of [0, 1, -0.2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0.3', null, undefined, {}]) expect(readPaneFraction(bad)).toBeNull()
  })

  test('a width set for good is remembered as a share of the window; a double-click forgets it', () => {
    expect(settlePane(720, 1440, null)).toBe(0.5)
    expect(settlePane(5000, 1440, null)).toBe(0.75)
    expect(settlePane(null, 1440, 0.5)).toBeNull()
    // a window with no room to choose: the width picked before stays remembered
    expect(settlePane(400, 700, 0.6)).toBe(0.6)
    expect(settlePane(400, 700, null)).toBeNull()
  })
})

describe('the edge handle', () => {
  test('dragging: the edge where the pointer is, in screen coordinates, within the limits', () => {
    // window content from x = 100 to 1540 (1440 wide): an edge at 900 leaves the browser 640 px
    expect(paneFromEdge(900, 100, 1440)).toBe(640)
    expect(paneFromEdge(1500, 100, 1440)).toBe(400)
    expect(paneFromEdge(120, 100, 1440)).toBe(1080)
  })

  test('keys on the focused edge: Left widens, Right narrows, Shift a bigger step, Home and End the limits', () => {
    const limits = { min: 400, max: 1080 }
    expect(paneKeyWidth('ArrowLeft', false, 600, limits)).toBe(600 + PANE_STEP)
    expect(paneKeyWidth('ArrowRight', false, 600, limits)).toBe(600 - PANE_STEP)
    expect(paneKeyWidth('ArrowLeft', true, 600, limits)).toBe(600 + PANE_BIG_STEP)
    expect(paneKeyWidth('Home', false, 600, limits)).toBe(400)
    expect(paneKeyWidth('End', false, 600, limits)).toBe(1080)
    expect(paneKeyWidth('Enter', false, 600, limits)).toBeNull()
    expect(paneKeyWidth('a', false, 600, limits)).toBeNull()
  })

  test('the grab strip over the team page: 6 px, none when the browser fills the window', () => {
    expect(PANE_GRAB).toBe(6)
    expect(paneGrab(792)).toBe(6)
    expect(paneGrab(3)).toBe(3)
    expect(paneGrab(0)).toBe(0)
  })
})

describe('wiring', () => {
  const dir = join(import.meta.dir, '../../desktop/src')
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
  const win = read('main/app-window.ts')
  const pane = read('main/pane/pane.ts')
  const main = read('main/main.ts')
  const ui = read('ui/pane.ts')
  const css = read('ui/ui.css')

  test('the edge channels answer only the browser toolbar, with checked input', () => {
    expect(main).toContain("ipcMain.handle('ui:pane-width', (e) => (fromChrome(e) ? win!.paneWidth() : null))")
    expect(main).toContain("if (!fromChrome(e) || (phase !== 'start' && phase !== 'move' && phase !== 'end' && phase !== 'reset')) return")
    expect(main).toContain("typeof edgeX === 'number' && Number.isFinite(edgeX) ? edgeX : undefined")
    expect(main).toMatch(/ipcMain\.on\('ui:pane-resize-key', \(e, key: unknown, shift: unknown\) => fromChrome\(e\) && typeof key === 'string'/)
    expect(main).not.toContain('ui:pane-resize\'')
  })

  test('the width comes from the remembered share, is saved when a drag ends, and the keyboard goes back', () => {
    expect(win).toContain('this.paneFraction = readPaneFraction(saved.paneFraction)')
    expect(win).toContain('const pw = this.pane?.open ? paneWidthFor(this.paneFraction, w) : 0')
    expect(win).toMatch(/if \(phase === 'reset'\) this\.setPaneFraction\(null\)\s*this\.saveWindow\(\)/)
    expect(win).toContain('this.keysAfterDrag(press)')
    // back only where the toolbar still has the keyboard, to a view still on screen, never over a dialog or menu
    expect(win).toContain("if (!this.chrome.webContents.isFocused() || !this.keysReady() || !this.shownViews().includes(back)) return")
    expect(win).toContain('this.personInPane = press.personInPane')
  })

  test('the toolbar view reaches over the team page\'s edge, transparent there, and stays above it', () => {
    expect(win).toContain("this.chrome.setBackgroundColor('#00000000')")
    expect(pane).toContain('chrome.setBounds({ x: b.x - grab, y: b.y, width: b.width + grab, height: b.height })')
    expect(pane).toContain('if (at < 0 || views.children.slice(at + 1).some((v) => !tabViews.has(v))) views.addChildView(chrome)')
    expect(css).toMatch(/html\.pane,\s*body\.pane \{\s*background: transparent;/)
    // the handle and the pane's box are made once: a re-render does not end a drag
    expect(ui).toContain('root.replaceChildren(edge, main)')
    expect(ui).toContain('main.replaceChildren(toolbar, stage)')
    expect(ui).toContain("role: 'separator', 'aria-orientation': 'vertical', tabindex: '0'")
  })

  test('no solid accent colour: not behind the page, not as a frame; the page keeps its size while the AI drives', () => {
    expect(css).not.toMatch(/body\.pane\.driving \{[^}]*background/)
    expect(css).not.toMatch(/\.driving-bar \{[^}]*background: var\(--accent\)/)
    expect(pane).not.toMatch(/driving > 0 \? 3/)
    expect(pane).toContain('t.view.setBounds({ x: b.x, y: b.y + this.toolbarHeight, width: b.width, height: Math.max(0, b.height - this.toolbarHeight) })')
    // the AI-control line: 2px, inside the toolbar's bottom edge
    expect(css).toMatch(/body\.driving #toolbar::after \{[^}]*height: 2px;[^}]*background: var\(--accent\);/)
    // a tab is drawn once its first real page commits (or fails with an error page)
    expect(pane).toContain('if (!isBlankPage(url)) this.drawTab(tab)')
    expect(pane).toContain('return t && !t.popup && t.drawn && !t.wc.isDestroyed() ? t.view : undefined')
  })

  test('the window\'s own colour follows the system\'s light or dark look', () => {
    expect(win).toContain("return nativeTheme.shouldUseDarkColors ? '#0E0C0B' : '#FCFBF8'")
    expect(win).toContain("nativeTheme.on('updated', themed)")
  })

  test('the words: plain, the AI by its name, in every language', () => {
    expect(STRINGS.ko['pane.driving']).toBe('트리나가 브라우저를 쓰는 중')
    expect(STRINGS.en['pane.driving']).toBe('Trina is using the browser')
    for (const l of ['ko', 'en', 'id', 'ja', 'es'] as const) {
      for (const k of ['pane.driving', 'pane.loading', 'pane.resize', 'pane.stop'] as const) expect(STRINGS[l][k].length).toBeGreaterThan(0)
      expect(STRINGS[l]['pane.driving']).not.toMatch(/\bAI\b|ＡＩ/)
    }
  })
})
