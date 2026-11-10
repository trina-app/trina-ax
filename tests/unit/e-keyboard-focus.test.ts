// Where the keyboard goes when the person comes back to the desktop app window (docs/DECISIONS.md "창으로 돌아오면
// 키보드는 보던 곳으로", desktop/src/common/keyboard-focus.ts): which view gets it, the view that had it when the window
// lost the focus, and the team page's own element across the window going away. The window and the views themselves
// are checked in the desktop e2e (desktop/e2e/keyboard-focus.spec.ts); here the decisions and how they are wired.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { keepPageFocus, keyboardBack, keyboardTarget, type FocusableElement, type KeyboardScene } from '../../desktop/src/common/keyboard-focus'

type V = 'page' | 'list' | 'toolbar' | 'tab' | 'closed tab' | 'strip'

const scene = (over: Partial<KeyboardScene<V>> & { keys?: V | null } = {}): KeyboardScene<V> => {
  const { keys = null, ...rest } = over
  return { ready: true, shown: ['page'], hasKeys: (v) => v === keys, page: 'page', ...rest }
}

describe('keyboardTarget', () => {
  test('nothing has the keyboard after a start: the team page gets it; the app\'s own screen when that is what shows', () => {
    expect(keyboardTarget(scene())).toBe('page')
    expect(keyboardTarget(scene({ shown: ['list'], page: 'list' }))).toBe('list')
  })

  test('never while the window is in the back or a dialog or menu of the app is open', () => {
    expect(keyboardTarget(scene({ ready: false }))).toBeNull()
    expect(keyboardTarget(scene({ ready: false, last: { view: 'page', inPane: false } }))).toBeNull()
  })

  test('a view that has the keyboard keeps it: the person\'s click or the view macOS kept wins', () => {
    expect(keyboardTarget(scene({ shown: ['page', 'toolbar', 'tab'], keys: 'toolbar', last: { view: 'tab', inPane: true } }))).toBeNull()
    expect(keyboardTarget(scene({ shown: ['page', 'strip'], keys: 'strip' }))).toBeNull()
    // a view that is not in the window does not count (the team list was taken out)
    expect(keyboardTarget(scene({ shown: ['page'], keys: 'list' }))).toBe('page')
  })

  test('the view that had it last, while it is on screen; the in-app browser\'s tab when the keyboard was last in the pane', () => {
    expect(keyboardTarget(scene({ shown: ['page', 'toolbar', 'tab'], last: { view: 'tab', inPane: true }, paneTab: 'tab' }))).toBe('tab')
    expect(keyboardTarget(scene({ shown: ['page', 'toolbar', 'tab'], last: { view: 'toolbar', inPane: true }, paneTab: 'tab' }))).toBe('toolbar')
    // the tab the person used was closed, another one shows: that one
    expect(keyboardTarget(scene({ shown: ['page', 'toolbar', 'tab'], last: { view: 'closed tab', inPane: true }, paneTab: 'tab' }))).toBe('tab')
    // the pane closed: the team page
    expect(keyboardTarget(scene({ shown: ['page'], last: { view: 'tab', inPane: true } }))).toBe('page')
    // back from the team list: the list is gone, the team page
    expect(keyboardTarget(scene({ shown: ['page', 'toolbar', 'tab'], last: { view: 'list', inPane: false }, paneTab: 'tab' }))).toBe('page')
  })

  test('nothing to give it to: null', () => {
    expect(keyboardTarget(scene({ shown: [], page: 'page' }))).toBeNull()
    expect(keyboardTarget(scene({ shown: ['toolbar'], page: undefined }))).toBeNull()
  })
})

describe('keyboardBack', () => {
  test('the view that had the keyboard when the window lost the focus, if still on screen, also over the system\'s choice', () => {
    expect(keyboardBack<V>({ ready: true, shown: ['page', 'toolbar', 'tab'], atBlur: { view: 'tab' } })).toBe('tab')
    expect(keyboardBack<V>({ ready: true, shown: ['page'], atBlur: { view: 'tab' } })).toBeNull()
    expect(keyboardBack<V>({ ready: true, shown: ['page'] })).toBeNull()
    expect(keyboardBack<V>({ ready: false, shown: ['page'], atBlur: { view: 'page' } })).toBeNull()
  })
})

/** A page with a window that takes focus and blur listeners, a document and elements that record focus calls. */
function fakePage() {
  type Ev = { target: unknown; isTrusted?: boolean }
  const listeners: Record<string, ((e: Ev) => void)[]> = {}
  const win = { addEventListener: (type: string, fn: (e: Ev) => void) => void (listeners[type] ??= []).push(fn) }
  const body = { isConnected: true, focus() {} }
  // the page's own focus: false while another view (or another app) has the keyboard, true while a frame in it has it
  let pageFocused = true
  const doc = { activeElement: body as FocusableElement | null, body, hasFocus: () => pageFocused }
  /** the page's own focus or blur (a trusted event on the window); blur: the view lost the keyboard */
  const fire = (type: 'focus' | 'blur', target: unknown = win, isTrusted = true) => {
    if (target === win) pageFocused = type === 'focus' ? true : frameTook
    listeners[type]?.forEach((fn) => fn({ target, isTrusted }))
  }
  let frameTook = false
  /** a frame inside the page takes the focus: the top window blurs while the page keeps the focus */
  const frameBlur = () => {
    frameTook = true
    fire('blur')
    frameTook = false
  }
  type El = FocusableElement & { calls: number; isConnected: boolean; shadowRoot: { activeElement: FocusableElement | null } | null; dialog?: { contains(o: unknown): boolean } | null }
  const el = (): El => {
    const e: El = { isConnected: true, calls: 0, shadowRoot: null, focus: () => { e.calls++; doc.activeElement = e }, closest: () => e.dialog ?? null }
    return e
  }
  return { win, doc, fire, frameBlur, el, body }
}

describe('keepPageFocus', () => {
  test('the message box had the focus; Chromium moved it to the first link while the window was away: back to the box', () => {
    const p = fakePage()
    keepPageFocus(p)
    const box = p.el()
    const link = p.el()
    p.doc.activeElement = box
    p.fire('blur')
    p.doc.activeElement = link // ordered out and in: the page's first focusable element
    p.fire('focus')
    expect(box.calls).toBe(1)
    expect(p.doc.activeElement).toBe(box)
    // once: the next return with nothing moved does nothing
    p.fire('blur')
    p.fire('focus')
    expect(box.calls).toBe(1)
  })

  test('nothing moved, the element left the page, or nothing had the focus: no focus call', () => {
    const p = fakePage()
    keepPageFocus(p)
    const box = p.el()
    p.doc.activeElement = box
    p.fire('blur')
    p.fire('focus')
    expect(box.calls).toBe(0)
    p.fire('blur')
    box.isConnected = false
    p.doc.activeElement = p.body
    p.fire('focus')
    expect(box.calls).toBe(0)
    const other = p.el()
    p.doc.activeElement = p.body
    p.fire('blur')
    p.doc.activeElement = other
    p.fire('focus')
    expect(other.calls).toBe(0)
  })

  test('an element\'s own focus and blur (target: the element) are not the page\'s', () => {
    const p = fakePage()
    keepPageFocus(p)
    const box = p.el()
    const link = p.el()
    p.doc.activeElement = box
    p.fire('blur', box)
    p.doc.activeElement = link
    p.fire('focus', link)
    expect(box.calls).toBe(0)
  })

  test('drop(): the page moved on its own (a notification opened another conversation), its focus stays', () => {
    const p = fakePage()
    const kept = keepPageFocus(p)
    const box = p.el()
    const other = p.el()
    p.doc.activeElement = box
    p.fire('blur')
    kept.drop()
    p.doc.activeElement = other
    p.fire('focus')
    expect(box.calls).toBe(0)
    expect(p.doc.activeElement).toBe(other)
  })

  test('the focus inside a component (an open shadow root): that element, not its host', () => {
    const p = fakePage()
    keepPageFocus(p)
    const host = p.el()
    const inner = p.el()
    host.shadowRoot = { activeElement: inner }
    p.doc.activeElement = host
    p.fire('blur')
    host.shadowRoot = { activeElement: null }
    p.doc.activeElement = p.el()
    p.fire('focus')
    expect(inner.calls).toBe(1)
    expect(host.calls).toBe(0)
  })

  test('a frame in the page taking the focus (an artifact) is not the page losing it: nothing is put back', () => {
    const p = fakePage()
    keepPageFocus(p)
    const box = p.el()
    const frame = p.el()
    p.doc.activeElement = box
    // the person clicks into the artifact, then back into the box: the window's focus comes before the box's
    p.doc.activeElement = frame
    p.frameBlur()
    p.doc.activeElement = p.body
    p.fire('focus')
    expect(frame.calls).toBe(0)
    expect(box.calls).toBe(0)
  })

  test('events the page dispatches itself do nothing', () => {
    const p = fakePage()
    keepPageFocus(p)
    const box = p.el()
    const link = p.el()
    p.doc.activeElement = box
    p.fire('blur', p.win, false)
    p.doc.activeElement = link
    p.fire('focus', p.win, false)
    expect(box.calls).toBe(0)
    // a trusted blur, then an untrusted focus: still nothing; the next trusted focus puts it back
    p.doc.activeElement = box
    p.fire('blur')
    p.doc.activeElement = link
    p.fire('focus', p.win, false)
    expect(box.calls).toBe(0)
    p.fire('focus')
    expect(box.calls).toBe(1)
  })

  test('a dialog the page opened meanwhile keeps the focus; a dialog that holds the element does not count', () => {
    const p = fakePage()
    keepPageFocus(p)
    const box = p.el()
    const field = p.el()
    field.dialog = { contains: (o) => o === field }
    p.doc.activeElement = box
    p.fire('blur')
    p.doc.activeElement = field
    p.fire('focus')
    expect(box.calls).toBe(0)
    // the box itself is in the dialog (the person wrote in a dialog's field), the focus went to the dialog's first link
    const inDialog = p.el()
    const first = p.el()
    first.dialog = { contains: (o) => o === inDialog || o === first }
    p.doc.activeElement = inDialog
    p.fire('blur')
    p.doc.activeElement = first
    p.fire('focus')
    expect(inDialog.calls).toBe(1)
  })

  test('an element whose focus throws does not break the page\'s focus event', () => {
    const p = fakePage()
    keepPageFocus(p)
    const box: FocusableElement = { isConnected: true, focus: () => { throw new Error('gone') } }
    p.doc.activeElement = box
    p.fire('blur')
    p.doc.activeElement = p.el()
    expect(() => p.fire('focus')).not.toThrow()
  })
})

describe('wiring', () => {
  const dir = join(import.meta.dir, '../../desktop/src')
  const win = readFileSync(join(dir, 'main/app-window.ts'), 'utf8')
  const pane = readFileSync(join(dir, 'main/pane/pane.ts'), 'utf8')
  const menu = readFileSync(join(dir, 'main/context-menu.ts'), 'utf8')
  const preload = readFileSync(join(dir, 'preload/app.ts'), 'utf8')

  test('the window: back on its focus, settled after every layout, only while focused and no dialog or menu of the app is open', () => {
    expect(win).toMatch(/this\.win\.on\('blur', \(\) => \{\s*this\.keysAtBlur = this\.keys\s*\}\)/)
    expect(win).toContain("this.win.on('focus', () => this.keysBack())")
    // the view at the blur over the system's choice on macOS only; a notification's click asks for the team page
    expect(win).toContain("const atBlur = wanted ? { view: wanted } : process.platform === 'darwin' ? this.keysAtBlur : undefined")
    expect(win).toMatch(/reveal: \(\) => \{\s*if \(this\.win\.isDestroyed\(\)\) return\s*(\/\/[^\n]*\n\s*)+if \(this\.app\) this\.keysWanted = this\.app/)
    // the app's own screen takes the keyboard only in a focused window (never in front of another app)
    expect(win.match(/this\.shell\.webContents\.focus\(\)/g)).toHaveLength(2)
    expect(win.match(/if \(this\.win\.isFocused\(\)\) this\.shell\.webContents\.focus\(\)/g)).toHaveLength(2)
    expect(win).toMatch(/layout\(\) \{\s*if \(this\.win\.isDestroyed\(\)\) return\s*\/\/[^\n]*\n\s*this\.settleKeysSoon\(\)/)
    expect(win).toContain('return !this.win.isDestroyed() && this.win.isFocused() && !this.allowAllOpen && !this.choosingFiles && !contextMenuOpen()')
    expect(win).toContain('hasKeys: (v) => v.webContents.isFocused(),')
    // every view reports when it gets the keyboard: the app's own three, the team page, the pane's tabs
    expect(win).toContain('this.watchKeys(v, v === this.chrome)')
    expect(win).toContain('this.watchKeys(app, false)')
    expect(win).toContain('onKeys: (view) => this.keysAt(view, true),')
    expect(pane).toContain("if (!popup) wc.on('focus', () => this.host.onKeys?.(view))")
  })

  test('a right-click menu counts as open until it closes, also when it could not be shown', () => {
    expect(menu).toMatch(/menusOpen\+\+\s*let closed = false/)
    expect(menu).toContain('menu.popup({ window: o.window, frame: p.frame ?? undefined, callback: close })')
    expect(menu).toMatch(/\} catch \{\s*close\(\)\s*\}/)
  })

  test('the team page preload keeps the page\'s element; a notification\'s open drops it', () => {
    expect(preload).toContain('const kept = keepPageFocus({ win: window, doc: document })')
    expect(preload).toContain("ipcRenderer.on('bridge:open', () => kept.drop())")
  })
})
