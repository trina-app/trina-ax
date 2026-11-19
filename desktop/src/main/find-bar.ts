// The find bar (Cmd+F, Ctrl+F on Windows and Linux; Edit › Find…): a small view of the app's own (ui/findbar.html)
// over the top-right corner of the view it searches, with webContents.findInPage on that view (common/find-bar.ts).
// The bar's text is in its own view, never in the page it searches, so it does not find itself. AppWindow picks the
// view to search (findTarget), places the bar on every layout (place) and closes it when that view leaves the window.
import { WebContentsView, type BaseWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { findBarRect, findPrefill, type FindResult } from '../common/find-bar'
import { UI_ORIGIN } from '../common/trust'
import { APP_WEB_PREFERENCES, guardUiView } from './security'
import { attachContextMenu } from './context-menu'
import type { UiLocale } from '../common/i18n'

/** what the bar's page is told: open with this text (selected), or the latest count */
export interface FindBarOpen {
  text: string
  /** a new Cmd+F: put the keyboard in the field and select its text */
  seq: number
}

export class FindBar {
  readonly view: WebContentsView
  /** the view searched while the bar is open */
  target?: WebContentsView
  private text = ''
  private seq = 0
  /** the request id of the latest findInPage: older answers are dropped */
  private request = 0
  private result: FindResult | null = null
  private loaded = false
  private pending?: FindBarOpen
  private onFound = (_e: Electron.Event, r: Electron.Result) => {
    if (r.requestId !== this.request) return
    this.result = { active: r.activeMatchOrdinal, matches: r.matches }
    this.send('ui:find-result', this.result)
  }
  /** the searched page went to another document: its matches are gone (the bar stays, as a browser's does) */
  private onNavigate = () => {
    this.result = null
    this.send('ui:find-result', null)
  }
  private onGone = () => this.close(false)

  constructor(private o: { win: BaseWindow; distDir: string; locale: () => UiLocale; focusTarget: (v: WebContentsView) => void; focusBar: () => void }) {
    this.view = new WebContentsView({ webPreferences: { preload: join(o.distDir, 'preload-ui.cjs'), ...APP_WEB_PREFERENCES, partition: 'mycel-ui' } })
    guardUiView(this.view.webContents)
    attachContextMenu(this.view.webContents, { window: o.win, locale: o.locale, allowedOrigins: () => [] })
    // transparent around the card (its shadow); the card paints itself in the theme's colours
    this.view.setBackgroundColor('#00000000')
    this.view.webContents.on('did-finish-load', () => {
      this.loaded = true
      if (this.pending) this.send('ui:find-open', this.pending)
      this.pending = undefined
    })
  }

  /** the bar's page loads at the first Cmd+F, not with the window (a loaded view outside the window could take the
   * keyboard's focus events from the views on screen) */
  private started = false
  private start() {
    if (this.started) return
    this.started = true
    void this.view.webContents.loadURL(`${UI_ORIGIN}/findbar.html`)
  }

  get open(): boolean {
    return this.target !== undefined
  }

  /** Cmd+F: open over `target` (or move there), with the selected text of that page if there is one. */
  async show(target: WebContentsView) {
    if (this.target !== target) {
      this.close(false)
      this.target = target
      const wc = target.webContents
      wc.on('found-in-page', this.onFound)
      wc.on('did-navigate', this.onNavigate)
      wc.on('destroyed', this.onGone)
      this.result = null
    }
    this.start()
    this.place()
    this.o.focusBar()
    // the page's selection, read in an isolated world (the page cannot fake what getSelection answers there)
    const selected = await target.webContents.executeJavaScriptInIsolatedWorld(1999, [{ code: 'String(getSelection?.() ?? "")' }]).catch(() => '')
    if (this.target !== target) return
    const prefill = findPrefill(selected)
    if (prefill !== null && prefill !== this.text) {
      this.text = prefill
      this.result = null
    }
    this.seq++
    const msg: FindBarOpen = { text: this.text, seq: this.seq }
    if (this.loaded) this.send('ui:find-open', msg)
    else this.pending = msg
    // a text the bar opens with is searched at once (the count shows), unless it is the search already on screen
    if (this.text && !this.result) this.request = target.webContents.findInPage(this.text, { findNext: true, forward: true })
    else if (this.result) this.send('ui:find-result', this.result)
  }

  /** The text in the field changed: a new search (Chromium starts it where the page's selection is, as a browser does). Empty: the highlights go. */
  query(text: string) {
    const t = text.slice(0, 1000)
    // the same text again (a paste over it, Cmd+F with nothing selected): the search goes on where it is
    if (t === this.text && this.result) return this.send('ui:find-result', this.result)
    this.text = t
    const wc = this.liveTarget()
    if (!wc) return
    if (!this.text) {
      this.result = null
      wc.stopFindInPage('clearSelection')
      this.send('ui:find-result', null)
      return
    }
    this.request = wc.findInPage(this.text, { findNext: true, forward: true })
  }

  /** Enter / Cmd+G (next), Shift+Enter / Shift+Cmd+G (the one before). */
  step(forward: boolean) {
    const wc = this.liveTarget()
    if (!wc || !this.text) return
    this.request = wc.findInPage(this.text, { findNext: false, forward })
  }

  /** Esc, ✕, or the searched view left the window: the highlights go, the match the bar was on stays selected (as
   * in a browser), and the keyboard goes back to the page when `focusBack`. */
  close(focusBack: boolean) {
    const t = this.target
    this.target = undefined
    this.result = null
    if (t && !t.webContents.isDestroyed()) {
      t.webContents.off('found-in-page', this.onFound)
      t.webContents.off('did-navigate', this.onNavigate)
      t.webContents.off('destroyed', this.onGone)
      t.webContents.stopFindInPage('keepSelection')
    }
    const views = this.o.win.isDestroyed() ? undefined : this.o.win.contentView
    if (views?.children.includes(this.view)) views.removeChildView(this.view)
    if (focusBack && t && !t.webContents.isDestroyed()) this.o.focusTarget(t)
  }

  /** On every layout of the window: over the searched view's top-right corner, above every other view. */
  place() {
    const t = this.target
    if (!t || this.o.win.isDestroyed()) return
    const views = this.o.win.contentView
    if (views.children.at(-1) !== this.view) views.addChildView(this.view)
    this.view.setBounds(findBarRect(t.getBounds()))
  }

  state(): { text: string; seq: number; result: FindResult | null } {
    return { text: this.text, seq: this.seq, result: this.result }
  }

  localeChanged(payload: unknown) {
    this.send('ui:locale', payload)
  }

  dispose() {
    this.close(false)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
  }

  private liveTarget(): WebContents | undefined {
    const wc = this.target?.webContents
    return wc && !wc.isDestroyed() ? wc : undefined
  }

  private send(channel: string, payload: unknown) {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.send(channel, payload)
  }
}
