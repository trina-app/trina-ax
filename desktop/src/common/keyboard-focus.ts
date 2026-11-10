// Where the keyboard goes when the person comes back to the app window
// (docs/DECISIONS.md "창으로 돌아오면 키보드는 보던 곳으로"). The window (main/app-window.ts) is a BaseWindow that holds
// several views: the team page, the in-app browser's toolbar and tab, the host strip, the app's own welcome / team list /
// offline screen. Unlike a BrowserWindow, nothing gives one of them the keyboard. Checked in the desktop e2e (Electron
// 44, macOS): after a start with a team, a minimize and a restore, or the team list and [돌아가기], the window was focused
// and no view had the keyboard, so typing did nothing until a click into the page. After the window was ordered out and
// back in (Cmd-H and a dock click) the window's first view, the team page, had it even when the person had been typing
// in the in-app browser. A plain switch to another window and back keeps the view (macOS keeps it).
//
// keyboardBack: when the window gets the focus back, the view that had the keyboard when it lost the focus gets it
// again, if it is still on screen, also where the system gave it to another view meanwhile. Run at once in the window's
// focus event: a click that brought the window back is handled after it, so the view the person clicked wins.
//
// keyboardTarget: any other time the views change, and after the window's focus, which view gets it, or none. Only while the window has the focus (focusing a view brings the window
// forward on macOS) and no dialog or menu of the app is open, and only when no view in the window has the keyboard (the
// person's own click, or the view macOS kept, always wins). Then the view that had it last, if it is still on screen;
// else the in-app browser's tab when the keyboard was last in the in-app browser and it is still open; else the team
// page, or the app's own screen when that is what the window shows. Focusing the view itself (webContents.focus) keeps
// the page's own focused element: the message box and its draft.
//
// keepPageFocus: the team page's own element. When the window was ordered out and back in (Cmd-H and a dock click),
// Chromium hands the page's focus to its first focusable element on the way back: the message box lost the focus and
// typing went to a link. The team page's preload (preload/app.ts) remembers the element that had the focus when the page
// lost it and, when the page gets the focus back with another element focused, puts it back there, if it is still in the
// page. drop(): the page moves on its own (a conversation opened from a notification click), its own focus wins.
// Pure (no Electron, no DOM globals): unit-tested in tests/unit/e-keyboard-focus.test.ts.

export interface KeyboardScene<V> {
  /** the window has the focus and no dialog or menu of the app is open over it */
  ready: boolean
  /** the views in the window now */
  shown: readonly V[]
  /** does this view have the keyboard now */
  hasKeys(view: V): boolean
  /** the view that had the keyboard last; inPane: the in-app browser's toolbar or one of its tabs */
  last?: { view: V; inPane: boolean }
  /** the in-app browser's tab on screen (the pane open) */
  paneTab?: V
  /** the team page, or the app's own screen when the window shows that */
  page?: V
}

/** The window got the focus back: the view to give the keyboard to at once, or null. */
export function keyboardBack<V>(s: { ready: boolean; shown: readonly V[]; atBlur?: { view: V } }): V | null {
  return s.ready && s.atBlur && s.shown.includes(s.atBlur.view) ? s.atBlur.view : null
}

/** The view to give the keyboard to now, or null (leave it where it is). */
export function keyboardTarget<V>(s: KeyboardScene<V>): V | null {
  if (!s.ready || s.shown.some((v) => s.hasKeys(v))) return null
  const onScreen = (v: V | undefined): v is V => v !== undefined && s.shown.includes(v)
  if (s.last && onScreen(s.last.view)) return s.last.view
  if (s.last?.inPane && onScreen(s.paneTab)) return s.paneTab
  return onScreen(s.page) ? s.page : null
}

/** The bits of an element keepPageFocus uses. */
export interface FocusableElement {
  readonly isConnected: boolean
  /** (a DOM Element has it when it is an HTML, SVG or MathML element) */
  focus?(): void
  /** an open shadow root's own focused element (the page's focus may sit inside a component) */
  readonly shadowRoot?: { readonly activeElement: FocusableElement | null } | null
}

/** The bits of the page keepPageFocus uses: its window (the page's focus and blur events) and its document. */
export interface FocusPage {
  win: { addEventListener(type: 'focus' | 'blur', listener: (e: { target: unknown }) => void): void }
  doc: { readonly activeElement: FocusableElement | null; readonly body: unknown }
}

/** The element that has the page's focus, inside open shadow roots too. */
function deepActive(doc: FocusPage['doc']): FocusableElement | null {
  let el = doc.activeElement
  for (let i = 0; el?.shadowRoot?.activeElement && i < 32; i++) el = el.shadowRoot.activeElement
  return el
}

/** Keep the page's own focused element across the window going away and coming back (see above). */
export function keepPageFocus({ win, doc }: FocusPage): { drop(): void } {
  let held: FocusableElement | null = null
  // focus and blur of elements do not bubble: on the window, these are the page's own (target: the window)
  win.addEventListener('blur', (e) => {
    if (e.target !== win) return
    const el = deepActive(doc)
    held = el && el !== doc.body ? el : null
  })
  win.addEventListener('focus', (e) => {
    if (e.target !== win) return
    const el = held
    held = null
    if (!el || !el.isConnected || deepActive(doc) === el) return
    try {
      el.focus?.()
    } catch {
      // gone meanwhile
    }
  })
  return { drop: () => { held = null } }
}
