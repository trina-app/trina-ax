/**
 * The in-app browser pane (design tab 5), the way the Claude desktop app does it: real browser tabs
 * (WebContentsView) inside the app window, driven over the Chrome DevTools Protocol through Electron's
 * webContents.debugger. Ported from Saram desktop/src/pane.ts and extended for Team AX:
 *
 *  - every call comes from the team server as a BrowserCall (shared/src/api/browser.ts) and its input is checked
 *    against shared/src/browser-tools.ts; the result goes back as a BrowserResult
 *  - "Allowed sites" (once = this turn / always = saved per team / deny), asked in the pane's own toolbar UI,
 *    not in the team page (a page served through the relay cannot answer the person's prompts)
 *  - office-network (private) addresses always need the person's approval, also for redirects and
 *    sub-requests (net-guard.ts)
 *  - password fields refuse clicks and typing; script runs and network-body reads are shown every time
 *  - "AI is using" state, a stop button (cancels the running call), and turn cancellation (browser.cancel)
 *
 * Each team has its own pane and its own session partition.
 */
import { BaseWindow, BrowserWindow, WebContentsView, type Rectangle, type Session, type WebContents } from 'electron'
import { parseBrowserToolInput, type BrowserToolInput, type ParsedBrowserCall } from '@mycel/shared'
import type { BrowserCall, BrowserResult } from '@mycel/shared/api'
import type { DesktopPaneState, DesktopPaneTab } from '@mycel/shared'
import { errorResult, toBrowserResult, type PaneContent, type PaneResult } from '../../common/browser-result'
import { MOD_BITS, parseKeyCombo, redactUrl, ToolError } from '../../common/input'
import { siteKey, SitePermissions, type PermissionDecision, type SiteScope } from '../../common/site-permissions'
import { BROWSER_TOOLS } from '@mycel/shared'
import { HostClassifier } from './classify'
import { installNetGuard, stopIfRebound } from './net-guard'
import { debug } from '../debug'

export interface PanePrompt {
  id: string
  scope: SiteScope
  host: string
  url: string
  tool: string
}
export interface PaneActivity {
  id: number
  kind: 'script' | 'network' | 'blocked' | 'password'
  host: string
  at: number
}

/** What the pane needs from the window around it. */
export interface PaneHost {
  win: BaseWindow
  /** the toolbar UI (pane.html), already created by the window */
  chrome: WebContentsView
  /** the pane opened or closed: the window re-splits and calls setBounds */
  onOpenChange(open: boolean): void
  onState(state: DesktopPaneState): void
  onPrompts(prompts: PanePrompt[]): void
  onActivity(a: PaneActivity): void
  /** saved permissions changed */
  onSavePermissions(p: ReturnType<SitePermissions['toJSON']>): void
}

interface ConsoleEntry {
  level: string
  text: string
  host: string
}
interface NetworkEntry {
  id: string
  method: string
  url: string
  type: string
  status?: number | string
}
interface Tab {
  id: string
  view: WebContentsView
  wc: WebContents
  console: ConsoleEntry[]
  network: Map<string, NetworkEntry>
  host: string
  /** a page-opened popup window, not a pane tab */
  popup?: BrowserWindow
  forceLeave?: boolean
}
/** The call being run (for prompts raised by the net guard during it). */
interface CallCtx {
  callId: string
  turnId?: string
  tool: string
  cancelled: boolean
  /** the person pressed stop, or the turn ended */
  abort: AbortController
}

const MAX_LOG = 500
const PROMPT_TIMEOUT_MS = 180_000
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const PRESETS: Record<string, { width: number; height: number; mobile: boolean } | null> = {
  mobile: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: false },
  desktop: null,
}
/** isolated world for the desktop's own checks (the page cannot replace these functions) */
const CHECK_WORLD = 1201
const PW_CHECK = `(() => {
  const isPw = (el) => !!el && el.tagName === 'INPUT' && ((el.getAttribute('type') || '').toLowerCase() === 'password' || /(^|\\s)(current-|new-)?password(\\s|$)/i.test(el.getAttribute('autocomplete') || ''));
  const deep = (el) => { while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el; };
  const at = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i; } return el; };
  return {
    focused: () => { const el = deep(document.activeElement); return { pw: isPw(el), inFrame: !!el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME') }; },
    point: (x, y) => { const el = at(x, y); const label = el && el.closest ? el.closest('label') : null; return isPw(el) || !!(label && isPw(label.control)); },
  };
})()`
/** keys allowed while a password field has focus (they type nothing) */
const SAFE_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])


const ok = (text: string, images: PaneContent[] = []): PaneResult => ({ content: [{ type: 'text', text }, ...images], isError: false })
const err = (text: string): PaneResult => ({ content: [{ type: 'text', text }], isError: true })
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })
const PASSWORD_REFUSED = 'That is a password field. The AI may not type or click into password fields; ask the user to type it in the browser pane, then continue.'

export class BrowserPane {
  private tabs = new Map<string, Tab>()
  private activeId?: string
  private isOpen = false
  private bounds?: Rectangle
  private toolbarHeight = 76
  private nextTab = 1
  private nextPopup = 1
  private nextActivity = 1
  private driving = 0
  private prompts: (PanePrompt & { settle: (d: PermissionDecision) => void; callId?: string })[] = []
  private calls = new Map<string, CallCtx>()
  /** results of finished calls by callId (a replayed call returns the first result, never runs twice) */
  private results = new Map<string, Promise<BrowserResult>>()
  /** private hosts the person opened themselves from the address bar this session */
  readonly userHosts = new Set<string>()
  readonly perms: SitePermissions
  readonly classifier: HostClassifier
  private disposed = false

  constructor(
    private host: PaneHost,
    readonly session: Session,
    private pageScript: string,
    saved: ConstructorParameters<typeof SitePermissions>[0],
    classifier: HostClassifier,
  ) {
    this.perms = new SitePermissions(saved)
    this.classifier = classifier
    this.pageScript = `window.__name = window.__name || ((f) => f);\n${pageScript}`
    // look like plain Chrome: sites flag "Electron/..." or the app name as an outdated browser
    const ua = session.getUserAgent()
    const chrome = ua.replace(/ Electron\/\S+/, '').replace(/ \S*(mycel|team-ax|Team AX)\S*\/\S+/gi, '')
    if (chrome !== ua) session.setUserAgent(chrome)
    session.setPermissionRequestHandler((_wc, permission, done) => done(['fullscreen', 'clipboard-sanitized-write'].includes(permission)))
    installNetGuard(this)
  }

  // ----------------------------------------------------------- layout / state

  /** Where the pane goes in the window (null = hidden). */
  setBounds(bounds: Rectangle | null) {
    this.bounds = bounds ?? undefined
    this.layout()
  }

  setToolbarHeight(h: number) {
    const v = Math.max(40, Math.min(600, Math.round(h)))
    if (v !== this.toolbarHeight) {
      this.toolbarHeight = v
      this.layout()
    }
  }

  get open() {
    return this.isOpen
  }

  private layout() {
    if (this.disposed || this.host.win.isDestroyed()) return
    const win = this.host.win
    const b = this.isOpen ? this.bounds : undefined
    const chrome = this.host.chrome
    if (b && b.width > 0) {
      if (!win.contentView.children.includes(chrome)) win.contentView.addChildView(chrome)
      chrome.setBounds(b)
    } else if (win.contentView.children.includes(chrome)) win.contentView.removeChildView(chrome)
    // a 3px accent frame around the page while the AI drives it (the toolbar UI paints it behind the page)
    const inset = this.driving > 0 ? 3 : 0
    for (const t of this.tabs.values()) {
      if (t.popup) continue
      const shown = b && b.width > 0 && t.id === this.activeId
      if (shown) {
        if (!win.contentView.children.includes(t.view)) win.contentView.addChildView(t.view)
        t.view.setBounds({
          x: b.x + inset,
          y: b.y + this.toolbarHeight + inset,
          width: Math.max(0, b.width - inset * 2),
          height: Math.max(0, b.height - this.toolbarHeight - inset * 2),
        })
      } else if (win.contentView.children.includes(t.view)) win.contentView.removeChildView(t.view)
    }
  }

  state(): DesktopPaneState {
    const tabs: DesktopPaneTab[] = [...this.tabs.values()].map((t) => ({
      tabId: t.id,
      title: t.wc.isDestroyed() ? '' : t.wc.getTitle(),
      url: t.wc.isDestroyed() ? '' : t.wc.getURL(),
      active: t.id === this.activeId,
      loading: !t.wc.isDestroyed() && t.wc.isLoading(),
      ...(t.popup ? { popup: true } : {}),
    }))
    return { open: this.isOpen, activeTabId: this.activeId, driving: this.driving > 0, tabs }
  }

  private emit() {
    if (!this.disposed) this.host.onState(this.state())
  }

  private emitPrompts() {
    this.host.onPrompts(this.prompts.map(({ id, scope, host, url, tool }) => ({ id, scope, host, url, tool })))
  }

  activity(kind: PaneActivity['kind'], host: string) {
    this.host.onActivity({ id: this.nextActivity++, kind, host, at: Date.now() })
  }

  show() {
    if (this.isOpen) return
    this.isOpen = true
    this.host.onOpenChange(true)
    this.layout()
    this.emit()
  }

  /** The person closed the pane: tabs keep running in the background. */
  hide() {
    if (!this.isOpen) return
    this.isOpen = false
    this.host.onOpenChange(false)
    this.layout()
    this.emit()
  }

  toggle() {
    if (this.isOpen) this.hide()
    else this.show()
  }

  // ------------------------------------------------------------------ tabs

  private async createTab(url?: string, foreground = true): Promise<Tab> {
    const view = new WebContentsView({
      webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, safeDialogs: true },
    })
    view.setBackgroundColor('#ffffff')
    view.webContents.setUserAgent(this.session.getUserAgent())
    const tab = this.register(`tab-${this.nextTab++}`, view.webContents, view)
    // CDP commands only answer once the tab has a renderer
    await view.webContents.loadURL('about:blank')
    await this.instrument(tab)
    if (foreground || !this.activeId) this.activeId = tab.id
    this.layout()
    if (url) await this.load(tab, url)
    this.emit()
    return tab
  }

  private register(id: string, wc: WebContents, view: WebContentsView, popup?: BrowserWindow): Tab {
    const tab: Tab = { id, view, wc, console: [], network: new Map(), host: '', popup }
    this.tabs.set(id, tab)
    const refresh = () => this.emit()
    wc.on('did-start-loading', refresh)
    wc.on('did-stop-loading', refresh)
    wc.on('page-title-updated', refresh)
    wc.on('did-navigate', (_e, url) => {
      const host = siteKey(url)
      if (host !== tab.host) tab.network.clear()
      tab.host = host
      refresh()
    })
    wc.on('did-navigate-in-page', refresh)
    wc.on('will-prevent-unload', (e) => {
      if (tab.forceLeave) e.preventDefault()
    })
    wc.on('destroyed', () => {
      this.tabs.delete(id)
      if (this.activeId === id) this.activeId = [...this.tabs.values()].filter((t) => !t.popup).at(-1)?.id
      this.layout()
      this.emit()
    })
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!/^(https?:|about:blank)/i.test(url)) return { action: 'deny' }
      // window.open with features = a popup (often a sign-in window): a real window the person handles
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 720,
            autoHideMenuBar: true,
            webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        }
      }
      void this.createTab(url, disposition === 'foreground-tab')
      return { action: 'deny' }
    })
    wc.on('did-create-window', (child) => {
      const popupTab = this.register(`popup-${this.nextPopup++}`, child.webContents, view, child)
      void this.instrument(popupTab)
      child.on('closed', () => {
        this.tabs.delete(popupTab.id)
        this.emit()
      })
      this.emit()
    })
    return tab
  }

  /** Attach CDP: console, network, dialogs and the ref script on every document. */
  private async instrument(tab: Tab) {
    const dbg = tab.wc.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    dbg.on('message', (_e, method, params: any) => {
      switch (method) {
        case 'Runtime.consoleAPICalled':
          push(tab.console, {
            level: params.type === 'warning' ? 'warn' : params.type,
            text: (params.args ?? [])
              .map((a: any) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type)))
              .join(' '),
            host: tab.host,
          })
          break
        case 'Runtime.exceptionThrown':
          push(tab.console, { level: 'error', text: params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'Uncaught exception', host: tab.host })
          break
        case 'Network.requestWillBeSent':
          tab.network.set(params.requestId, { id: params.requestId, method: params.request.method, url: params.request.url, type: String(params.type ?? 'Other').toLowerCase() })
          if (tab.network.size > MAX_LOG) tab.network.delete(tab.network.keys().next().value!)
          break
        case 'Network.responseReceived': {
          const e = tab.network.get(params.requestId)
          if (e) e.status = params.response.status
          if (params.type === 'Document' && stopIfRebound(this, tab.wc, params.response.url, params.response.remoteIPAddress)) {
            push(tab.console, { level: 'error', text: `[blocked] ${redactUrl(params.response.url)} answered from an office-network address (${params.response.remoteIPAddress}); the page was stopped.`, host: tab.host })
          }
          break
        }
        case 'Network.loadingFailed': {
          const e = tab.network.get(params.requestId)
          if (e) e.status = `failed (${params.errorText})`
          break
        }
        case 'Page.javascriptDialogOpening':
          // while the AI drives, a dialog would block every CDP call: alerts are accepted, confirm/prompt
          // dismissed (the AI reads what it said in the console); otherwise the person answers it
          if (this.driving > 0) {
            push(tab.console, { level: 'warn', text: `[dialog] ${params.type}: ${params.message} (${params.type === 'alert' ? 'closed' : 'dismissed'} automatically)`, host: tab.host })
            void this.cdp(tab, 'Page.handleJavaScriptDialog', { accept: params.type === 'alert' }).catch(() => {})
          }
          break
      }
    })
    await this.cdp(tab, 'Runtime.enable')
    await this.cdp(tab, 'Network.enable')
    await this.cdp(tab, 'Page.enable')
    await this.cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: this.pageScript })
  }

  private cdp<T = any>(tab: Tab, method: string, params?: Record<string, unknown>): Promise<T> {
    return tab.wc.debugger.sendCommand(method, params) as Promise<T>
  }

  private async load(tab: Tab, url: string) {
    try {
      await tab.wc.loadURL(url)
    } catch (e) {
      // ERR_ABORTED: a redirect or the page navigating again; anything else is a real failure
      const msg = String((e as Error).message ?? e)
      if (/ERR_BLOCKED_BY_CLIENT/.test(msg)) throw new ToolError(`Opening ${url} was blocked: the user did not allow that office-network address.`)
      if (!/ERR_ABORTED/.test(msg)) throw new ToolError(`Could not load ${url}: ${msg.split('\n')[0]}`)
    }
  }

  /** Let navigations started by an action finish. */
  private async settle(tab: Tab, signal?: AbortSignal) {
    await sleep(150, signal)
    if (!tab.wc.isDestroyed() && tab.wc.isLoading()) {
      await Promise.race([new Promise<void>((r) => tab.wc.once('did-stop-loading', () => r())), sleep(10_000, signal)])
    }
  }

  tabForWebContents(id: number): { tab: Tab; topUrl: string } | undefined {
    for (const t of this.tabs.values()) if (!t.wc.isDestroyed() && t.wc.id === id) return { tab: t, topUrl: t.wc.getURL() }
    return undefined
  }

  // ------------------------------------------------------------ person's controls

  async userNavigate(raw: string) {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`
    if (!/^https?:/i.test(url)) return
    const key = siteKey(url)
    // the person typed it: an office address they open themselves needs no prompt
    if (key) this.userHosts.add(key)
    this.show()
    const tab = this.activeTab() ?? (await this.createTab())
    await this.load(tab, url).catch(() => {})
  }

  userHistory(dir: 'back' | 'forward' | 'reload') {
    const t = this.activeTab()
    if (!t) return
    if (dir === 'reload') t.wc.reload()
    else if (dir === 'back') t.wc.navigationHistory.goBack()
    else t.wc.navigationHistory.goForward()
  }

  selectTab(id: string) {
    const t = this.tabs.get(id)
    if (!t) return
    if (t.popup) t.popup.focus()
    else this.activeId = id
    this.layout()
    this.emit()
  }

  closeTab(id: string) {
    const t = this.tabs.get(id)
    if (!t) return
    if (t.popup) t.popup.close()
    else {
      if (this.host.win.contentView.children.includes(t.view)) this.host.win.contentView.removeChildView(t.view)
      t.wc.close()
    }
    if (![...this.tabs.values()].some((x) => !x.popup && x.id !== id)) this.hide()
  }

  async newTab() {
    this.show()
    await this.createTab(undefined, true)
  }

  /** The stop button: end every running call and deny open prompts. */
  stop() {
    for (const c of this.calls.values()) this.cancelCtx(c, 'The user stopped the browser action in the browser pane. Do not retry it; ask the user what to do.')
  }

  /** browser.cancel from the server (the turn stopped). */
  cancel(callId: string) {
    const c = this.calls.get(callId)
    if (c) this.cancelCtx(c, 'The turn was stopped.')
  }

  private cancelCtx(c: CallCtx, reason: string) {
    if (c.cancelled) return
    c.cancelled = true
    c.abort.abort(new ToolError(reason))
    for (const p of [...this.prompts]) if (p.callId === c.callId) p.settle('deny')
  }

  /** Close every tab (window closing / team switch): detached tabs would otherwise outlive the window. */
  dispose() {
    this.disposed = true
    for (const p of [...this.prompts]) p.settle('deny')
    for (const c of this.calls.values()) this.cancelCtx(c, 'The desktop app window closed.')
    for (const t of Array.from(this.tabs.values())) {
      try {
        if (t.wc.debugger.isAttached()) t.wc.debugger.detach()
      } catch {
        // already gone
      }
      if (t.popup && !t.popup.isDestroyed()) t.popup.destroy()
      else if (!t.wc.isDestroyed()) {
        if (!this.host.win.isDestroyed() && this.host.win.contentView.children.includes(t.view)) this.host.win.contentView.removeChildView(t.view)
        t.wc.close()
      }
    }
    this.tabs.clear()
  }

  private activeTab(): Tab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : undefined
  }

  // ------------------------------------------------------------ permission

  /** Ask the person in the pane toolbar. Resolves 'deny' on timeout, stop, cancel or window close. */
  ask(req: Omit<PanePrompt, 'id'>, ctx?: CallCtx): Promise<PermissionDecision> {
    if (this.disposed) return Promise.resolve('deny')
    this.show()
    return new Promise((resolve) => {
      const id = crypto.randomUUID()
      const settle = (d: PermissionDecision) => {
        const i = this.prompts.findIndex((p) => p.id === id)
        if (i < 0) return
        this.prompts.splice(i, 1)
        clearTimeout(timer)
        this.emitPrompts()
        resolve(d)
      }
      const timer = setTimeout(() => settle('deny'), PROMPT_TIMEOUT_MS)
      this.prompts.push({ id, ...req, settle, callId: ctx?.callId })
      this.emitPrompts()
    })
  }

  answer(id: string, decision: PermissionDecision) {
    this.prompts.find((p) => p.id === id)?.settle(decision)
  }

  /** The call the net guard should attribute a navigation to (the newest running one). */
  currentCall(): CallCtx | undefined {
    return [...this.calls.values()].filter((c) => !c.cancelled).at(-1)
  }

  get isDriving() {
    return this.driving > 0
  }

  /** Record a decision for both the site and (when private) the office-network scope. */
  grant(scopes: SiteScope[], host: string, d: PermissionDecision, turnId?: string) {
    let changed = false
    for (const s of scopes) changed = this.perms.grant(s, host, d, turnId) || changed
    if (changed) this.host.onSavePermissions(this.perms.toJSON())
  }

  revokeSite(host: string) {
    if (this.perms.revoke(host)) this.host.onSavePermissions(this.perms.toJSON())
  }

  /** May the AI act on / open `url` in this call? Asks the person when not allowed yet. */
  private async permit(ctx: CallCtx, url: string, tool: string): Promise<void> {
    const scheme = url.split(':')[0].toLowerCase()
    if (scheme === 'about' || scheme === 'data' || url === '') return
    if (scheme !== 'http' && scheme !== 'https') throw new ToolError(`Only http(s) pages can be opened in the browser pane (${url}).`)
    const host = siteKey(url)
    const hostname = new URL(url).hostname
    const isPrivate = (await this.classifier.classify(hostname)) === 'private'
    const siteOk = this.perms.isAllowed('site', host, ctx.turnId)
    const privateOk = !isPrivate || this.perms.isAllowed('private', host, ctx.turnId) || this.userHosts.has(host)
    if (siteOk && privateOk) return
    const scope: SiteScope = isPrivate && !privateOk ? 'private' : 'site'
    const d = await this.ask({ scope, host, url: redactUrl(url), tool }, ctx)
    if (ctx.cancelled) throw ctx.abort.signal.reason
    if (d === 'deny') {
      throw new ToolError(
        scope === 'private'
          ? `The user declined opening the office-network address ${host}. Do not try it again; tell the user what you could not do.`
          : `The user declined ${tool} on ${host}. Do not try that site again; tell the user what you could not do.`,
      )
    }
    this.grant(isPrivate ? ['site', 'private'] : ['site'], host, d, ctx.turnId)
  }

  // --------------------------------------------------------------- calls

  /** Run one browser.call. The same callId twice returns the first result. */
  run(call: BrowserCall): Promise<BrowserResult> {
    const prev = this.results.get(call.callId)
    if (prev) return prev
    const p = this.runOnce(call)
    this.results.set(call.callId, p)
    while (this.results.size > 300) this.results.delete(this.results.keys().next().value as string)
    return p
  }

  private async runOnce(call: BrowserCall): Promise<BrowserResult> {
    if (Date.now() > call.deadline) return errorResult(call.callId, 'The browser call arrived after its deadline; nothing was done.')
    const parsed = parseBrowserToolInput(call.tool, call.args)
    if (!parsed.ok) return errorResult(call.callId, parsed.error)
    const ctx: CallCtx = { callId: call.callId, turnId: call.turnId, tool: call.tool, cancelled: false, abort: new AbortController() }
    debug('start', call.tool, call.callId)
    this.calls.set(call.callId, ctx)
    this.driving++
    this.layout()
    this.emit()
    // the server stops waiting at the deadline; stop working on it too
    const deadline = setTimeout(() => this.cancelCtx(ctx, 'The browser call took too long and was stopped.'), Math.max(0, call.deadline - Date.now()))
    try {
      const aborted = new Promise<PaneResult>((resolve) =>
        ctx.abort.signal.addEventListener('abort', () => resolve(err(String((ctx.abort.signal.reason as Error)?.message ?? 'Stopped.'))), { once: true }),
      )
      const work = parsed.call.tool === 'browser_batch' ? this.batch(ctx, parsed.call.input) : this.single(ctx, parsed.call)
      const r = await Promise.race([work, aborted])
      debug('end', call.tool, call.callId, r.isError ? `error: ${(r.content[0] as { text?: string })?.text?.slice(0, 300)}` : 'ok')
      return toBrowserResult(call.callId, r)
    } finally {
      clearTimeout(deadline)
      this.calls.delete(call.callId)
      this.driving = Math.max(0, this.driving - 1)
      this.layout()
      this.emit()
    }
  }

  private async batch(ctx: CallCtx, input: BrowserToolInput['browser_batch']): Promise<PaneResult> {
    const { actions } = input
    if (actions.some((a) => a.name === 'browser_batch')) return err('browser_batch cannot be nested; list the sub-actions directly.')
    if (actions.some((a) => a.name === 'preview_start')) return err('preview_start is not batchable; call it on its own (or start the batch with navigate).')
    const content: PaneContent[] = []
    for (let i = 0; i < actions.length; i++) {
      if (ctx.cancelled) return { content: [...content, { type: 'text', text: 'Stopped.' }], isError: true }
      const a = actions[i]
      const sub = { ...a.input }
      if (input.save_to_disk && a.name === 'computer') sub.save_to_disk = true
      const p = parseBrowserToolInput(a.name, sub)
      const r = p.ok ? await this.single(ctx, p.call) : err(p.error)
      content.push({ type: 'text', text: `[${i + 1}/${actions.length}] ${a.name}${r.isError ? ' failed' : ''}:` }, ...r.content)
      if (r.isError) {
        content.push({ type: 'text', text: `Stopped at action ${i + 1}; the remaining ${actions.length - i - 1} were not run.` })
        return { content, isError: true }
      }
    }
    return { content, isError: false }
  }

  private async single(ctx: CallCtx, call: ParsedBrowserCall): Promise<PaneResult> {
    let tab: Tab | undefined
    try {
      if (call.tool !== 'tabs_context') this.show()
      tab = this.target(call)
      const kind = BROWSER_TOOLS[call.tool].kind
      if (tab?.popup && kind === 'mutates-tab') {
        throw new ToolError('That tab is a page-opened popup (often a sign-in window), which the AI may not drive, navigate, or close. Ask the user to finish or close it.')
      }
      if (tab && kind !== 'no-tab-target' && call.tool !== 'navigate' && !call.tool.startsWith('tabs_')) {
        const before = tab.wc.getURL()
        await this.permit(ctx, before, call.tool)
        if (tab.wc.getURL() !== before && siteKey(tab.wc.getURL()) !== siteKey(before)) {
          throw new ToolError(`Page navigated from ${siteKey(before)} to ${siteKey(tab.wc.getURL())} during the permission check; retry.`)
        }
      }
      const result = await this.exec(ctx, tab, call)
      if (tab && !tab.wc.isDestroyed()) await this.settle(tab, ctx.abort.signal)
      return result
    } catch (e) {
      return err(e instanceof ToolError ? e.message : `Error: ${String((e as Error).message ?? e).split('\n')[0]}`)
    }
  }

  /** The tab a call acts on: tabId, or the fronted tab. preview_start / navigate open the pane. */
  private target(call: ParsedBrowserCall): Tab | undefined {
    if (call.tool === 'tabs_context' || call.tool === 'tabs_create' || call.tool === 'preview_start' || call.tool === 'browser_batch') return undefined
    const tabId = (call.input as { tabId?: string }).tabId
    if (tabId !== undefined && tabId !== '') {
      const t = this.tabs.get(tabId)
      if (!t) throw new ToolError(`No browser pane tab ${tabId}. Call tabs_context for the open tabs.`)
      return t
    }
    const active = this.activeTab()
    if (active) return active
    if (call.tool === 'navigate') return undefined
    throw new ToolError("The browser pane isn't open. Open it with preview_start or navigate and a url.")
  }

  private async exec(ctx: CallCtx, tab: Tab | undefined, call: ParsedBrowserCall): Promise<PaneResult> {
    const need = () => {
      if (!tab) throw new ToolError("The browser pane isn't open. Open it with preview_start or navigate and a url.")
      return tab
    }
    switch (call.tool) {
      case 'preview_start': {
        const url = normalize(call.input.url)
        await this.permit(ctx, url, call.tool)
        const t = await this.createTab(undefined, true)
        await this.load(t, url)
        return ok(`Opened ${t.wc.getURL()} in the browser pane — tabId ${t.id}. Title: ${t.wc.getTitle()}`)
      }
      case 'navigate': {
        const raw = call.input.url
        if (raw === 'back' || raw === 'forward') {
          const t = need()
          if (raw === 'back') t.wc.navigationHistory.goBack()
          else t.wc.navigationHistory.goForward()
          await this.settle(t, ctx.abort.signal)
          return ok(`Went ${raw}: ${t.wc.getURL()} — ${t.wc.getTitle()}`)
        }
        const url = normalize(raw)
        await this.permit(ctx, url, call.tool)
        const t = tab ?? (await this.createTab(undefined, true))
        t.forceLeave = Boolean(call.input.force)
        try {
          await this.load(t, url)
        } finally {
          t.forceLeave = false
        }
        return ok(`Navigated tab ${t.id} to ${t.wc.getURL()} — ${t.wc.getTitle()}`)
      }
      case 'tabs_context': {
        const tabs = [...this.tabs.values()].map((t) => ({ tabId: t.id, origin: originOf(t.wc.getURL()), isActive: t.id === this.activeId }))
        return ok(`${JSON.stringify({ browserOpen: this.tabs.size > 0, tabs }, null, 2)}\nThe browser pane is ${this.isOpen ? 'displayed' : 'hidden'}.`)
      }
      case 'tabs_create': {
        const t = await this.createTab(undefined, Boolean(call.input.foreground))
        return ok(`Created tab ${t.id}${call.input.foreground ? ' (fronted)' : ' in the background'}. Load a page into it with navigate and this tabId.`)
      }
      case 'tabs_select': {
        const t = need()
        this.selectTab(t.id)
        return ok(`Fronted tab ${t.id}.`)
      }
      case 'tabs_close': {
        const t = need()
        this.closeTab(t.id)
        return ok(`Closed tab ${t.id}.${this.tabs.size ? '' : ' The browser pane is closed.'}`)
      }
      case 'read_page': {
        const t = need()
        const i = call.input
        const r = await this.page(t, `tree(${JSON.stringify({ filter: i.filter === 'interactive' ? 'interactive' : 'all', depth: i.depth ?? 15, refId: i.ref_id, maxChars: i.max_chars ?? 50_000 })})`)
        if (r.error) throw new ToolError(r.error)
        return ok(`${t.wc.getURL()} — ${t.wc.getTitle()}\n${r.text || '(no elements)'}`)
      }
      case 'find': {
        const t = need()
        const r = await this.page(t, `find(${JSON.stringify(call.input.query)})`)
        if (!r.matches.length) return ok(`No elements match "${call.input.query}". Try other words or read_page.`)
        return ok(`${r.matches.join('\n')}${r.more ? '\nMore than 20 matches; use a more specific query.' : ''}`)
      }
      case 'get_page_text': {
        const t = need()
        const max = call.input.max_chars ?? 50_000
        const text = String(await this.page(t, 'text()')).replace(/\n{3,}/g, '\n\n').trim()
        return ok(`${t.wc.getURL()} — ${t.wc.getTitle()}\n\n${text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text || '(no text)'}`)
      }
      case 'form_input': {
        const t = need()
        const { ref, value } = call.input
        if (await this.page(t, `passwordRef(${JSON.stringify(ref)})`)) {
          this.activity('password', t.host)
          throw new ToolError(PASSWORD_REFUSED)
        }
        const r = await this.page(t, `setValue(${JSON.stringify(ref)}, ${JSON.stringify(value)})`)
        if (!r.ok) {
          if (r.password) this.activity('password', t.host)
          throw new ToolError(r.error)
        }
        return ok(`Set ${ref}${r.name ? ` "${r.name}"` : ''} to ${JSON.stringify(value)}`)
      }
      case 'javascript_tool': {
        const t = need()
        // shown every time, also on always-allowed sites (design tab 5)
        this.activity('script', t.host)
        // replMode = DevTools console semantics: top-level await, last expression value
        const r: any = await this.cdp(t, 'Runtime.evaluate', { expression: call.input.text, replMode: true, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 30_000 })
        if (r.exceptionDetails) return err(`Uncaught ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
        const v = r.result
        const out = v.type === 'undefined' ? 'undefined' : v.value !== undefined ? (typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2)) : (v.description ?? v.type)
        return ok(out.length > 20_000 ? `${out.slice(0, 20_000)}\n… (truncated)` : out)
      }
      case 'read_console_messages': {
        const t = need()
        const i = call.input
        let rows = t.console.filter((m) => m.host === t.host)
        if (i.onlyErrors) rows = rows.filter((m) => m.level === 'error')
        if (i.pattern) rows = rows.filter((m) => m.text.includes(i.pattern!))
        const shown = rows.slice(-Math.min(200, i.limit ?? 50))
        if (!shown.length) return ok(`No console messages${i.pattern ? ` containing "${i.pattern}"` : ''} on ${t.host || 'this page'}.`)
        return ok(shown.map((m) => `[${m.level}] ${m.text}`).join('\n'))
      }
      case 'read_network_requests': {
        const t = need()
        const i = call.input
        if (i.requestId) {
          const entry = t.network.get(i.requestId)
          if (!entry) throw new ToolError(`No request ${i.requestId} on this page.`)
          this.activity('network', t.host)
          const body: any = await this.cdp(t, 'Network.getResponseBody', { requestId: entry.id }).catch(() => null)
          if (!body) throw new ToolError(`The body of ${i.requestId} is not available (not finished, or evicted).`)
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
          return ok(`${entry.method} ${redactUrl(entry.url)} → ${entry.status ?? 'pending'}\n\n${text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (truncated)` : text}`)
        }
        let rows = [...t.network.values()].map((r) => ({ ...r, url: redactUrl(r.url) }))
        if (i.urlPattern) rows = rows.filter((r) => r.url.includes(i.urlPattern!))
        const shown = rows.slice(-(i.limit ?? 50))
        if (!shown.length) return ok('No network requests recorded for this page.')
        return ok(shown.map((r) => `[${r.id}] ${r.method} ${r.url} → ${r.status ?? 'pending'} (${r.type})`).join('\n'))
      }
      case 'resize_window':
        return this.resize(need(), call.input)
      case 'computer':
        return this.computer(ctx, need(), call.input)
      case 'browser_batch':
        return err('browser_batch cannot be nested.')
    }
  }

  /** Call a page-script helper (window.__claude.*) and return its value. */
  private async page(tab: Tab, call: string): Promise<any> {
    const has: any = await this.cdp(tab, 'Runtime.evaluate', { expression: 'Boolean(window.__claude)', returnByValue: true })
    if (!has.result?.value) await this.cdp(tab, 'Runtime.evaluate', { expression: this.pageScript })
    const r: any = await this.cdp(tab, 'Runtime.evaluate', { expression: `window.__claude.${call}`, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new ToolError(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result?.value
  }

  /** Password checks in an isolated world (the page cannot swap these functions out). */
  private async check<T>(tab: Tab, expr: string): Promise<T> {
    return (await tab.wc.executeJavaScriptInIsolatedWorld(CHECK_WORLD, [{ code: `${PW_CHECK}.${expr}` }])) as T
  }

  private async passwordFocused(tab: Tab): Promise<boolean> {
    const top = await this.check<{ pw: boolean; inFrame: boolean }>(tab, 'focused()').catch(() => ({ pw: false, inFrame: false }))
    if (top.pw) return true
    if (!top.inFrame) return false
    // focus is inside an iframe: ask every subframe (cross-origin frames included)
    for (const f of tab.wc.mainFrame.framesInSubtree) {
      if (f === tab.wc.mainFrame) continue
      const r = (await f.executeJavaScript(`${PW_CHECK}.focused()`).catch(() => null)) as { pw?: boolean } | null
      if (r?.pw) return true
    }
    return false
  }

  private async viewport(tab: Tab): Promise<{ width: number; height: number }> {
    const r: any = await this.cdp(tab, 'Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true }).catch(() => null)
    const v = r?.result?.value
    if (Array.isArray(v)) return { width: v[0], height: v[1] }
    const b = tab.view.getBounds()
    return { width: b.width, height: b.height }
  }

  private async screenshot(tab: Tab, region?: number[], scale = 1): Promise<{ text: string; data: string }> {
    const vp = await this.viewport(tab)
    const rect = region
      ? { x: Math.round(region[0]), y: Math.round(region[1]), width: Math.max(1, Math.round(region[2] - region[0])), height: Math.max(1, Math.round(region[3] - region[1])) }
      : undefined
    let img = await tab.wc.capturePage(rect)
    if (img.isEmpty()) throw new ToolError('The tab is not being drawn (it is in the background or the pane is hidden). Front it with tabs_select, or read it with read_page / get_page_text.')
    // screenshots in CSS pixels so coordinates match; zoom keeps device pixels for small text
    if (!rect) img = img.resize({ width: vp.width, height: vp.height })
    if (scale < 1) {
      const s = img.getSize()
      img = img.resize({ width: Math.max(1, Math.round(s.width * scale)), height: Math.max(1, Math.round(s.height * scale)) })
    }
    const size = rect ? `region (${region!.join(', ')}) magnified` : `viewport ${vp.width}x${vp.height}`
    const note = scale < 1 ? ` · image scaled to ${Math.round(scale * 100)}%; coordinates stay in the ${vp.width}x${vp.height} frame` : ''
    return { text: `Screenshot · ${size}${note}`, data: img.toJPEG(70).toString('base64') }
  }

  private async point(tab: Tab, input: BrowserToolInput['computer']): Promise<{ x: number; y: number; name?: string }> {
    if (input.ref) {
      const c = await this.page(tab, `center(${JSON.stringify(input.ref)})`)
      if (!c) throw new ToolError(`No element ${input.ref} on the page (it may have changed). Call read_page or find again.`)
      await sleep(50) // let scrollIntoView land
      return { x: c.x, y: c.y, name: c.name }
    }
    const c = input.coordinate
    if (!c) throw new ToolError(`${input.action} needs coordinate [x, y] or ref.`)
    return { x: c[0], y: c[1] }
  }

  private mouse(tab: Tab, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
    return this.cdp(tab, 'Input.dispatchMouseEvent', { type, x, y, ...extra })
  }

  private async click(tab: Tab, p: { x: number; y: number }, button: 'left' | 'right', clickCount: number, modifiers: number) {
    await this.mouse(tab, 'mouseMoved', p.x, p.y, { modifiers })
    for (let i = 1; i <= clickCount; i++) {
      await this.mouse(tab, 'mousePressed', p.x, p.y, { button, clickCount: i, modifiers, buttons: button === 'left' ? 1 : 2 })
      await this.mouse(tab, 'mouseReleased', p.x, p.y, { button, clickCount: i, modifiers })
    }
  }

  private async key(tab: Tab, combo: string) {
    const { def, modifiers, command } = parseKeyCombo(combo)
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers }
    await this.cdp(tab, 'Input.dispatchKeyEvent', {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
      ...(command ? { commands: [command] } : {}),
    })
    await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  private async refusePassword(tab: Tab) {
    this.activity('password', tab.host)
    throw new ToolError(PASSWORD_REFUSED)
  }

  private async computer(ctx: CallCtx, tab: Tab, input: BrowserToolInput['computer']): Promise<PaneResult> {
    const action = input.action
    const modifiers = input.modifiers ? input.modifiers.split('+').reduce((m, k) => m | (MOD_BITS[k.trim().toLowerCase()] ?? 0), 0) : 0
    switch (action) {
      case 'screenshot':
      case 'zoom': {
        if (action === 'zoom' && !input.region) throw new ToolError('zoom needs region [x0, y0, x1, y1].')
        const s = await this.screenshot(tab, action === 'zoom' ? input.region : undefined, input.scale ?? 1)
        return ok(`${s.text}${input.save_to_disk ? '\nThe image is shown to the user in the chat.' : ''}`, [
          { type: 'image', data: s.data, mimeType: 'image/jpeg', ...(input.save_to_disk ? { share: true } : {}) },
        ])
      }
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click': {
        const p = await this.point(tab, input)
        if (await this.check<boolean>(tab, `point(${p.x}, ${p.y})`).catch(() => false)) await this.refusePassword(tab)
        const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1
        await this.click(tab, p, action === 'right_click' ? 'right' : 'left', count, modifiers)
        return ok(`${action.replace('_', ' ')} at (${Math.round(p.x)}, ${Math.round(p.y)})${p.name ? ` on "${p.name}"` : ''}`)
      }
      case 'hover': {
        const p = await this.point(tab, input)
        await this.mouse(tab, 'mouseMoved', p.x, p.y)
        return ok(`Hovered at (${Math.round(p.x)}, ${Math.round(p.y)})${p.name ? ` over "${p.name}"` : ''}`)
      }
      case 'type': {
        if (typeof input.text !== 'string') throw new ToolError('type needs text.')
        if (await this.passwordFocused(tab)) await this.refusePassword(tab)
        await this.cdp(tab, 'Input.insertText', { text: input.text })
        return ok(`Typed ${JSON.stringify(input.text)}`)
      }
      case 'key': {
        const text = input.text?.trim()
        if (!text) throw new ToolError('key needs keys in text, e.g. "Enter" or "cmd+a".')
        const keys = text.split(/\s+/)
        if (keys.some((k) => /^(cmd|ctrl|meta|control)\+(=|-|0|\+)$/i.test(k))) throw new ToolError('Page zoom shortcuts are not supported; use the zoom action instead.')
        const parsed = keys.map((k) => parseKeyCombo(k)) // throws on unknown keys before anything is pressed
        if (parsed.some((p) => !SAFE_KEYS.has(p.def.key) || p.command) && (await this.passwordFocused(tab))) await this.refusePassword(tab)
        const repeat = input.repeat ?? 1
        for (let i = 0; i < repeat; i++) {
          for (const k of keys) {
            if (ctx.cancelled) throw new ToolError('Stopped.')
            await this.key(tab, k)
          }
        }
        return ok(`Pressed ${text}${repeat > 1 ? ` ×${repeat}` : ''}`)
      }
      case 'scroll': {
        const vp = await this.viewport(tab)
        const c = input.coordinate ?? [vp.width / 2, vp.height / 2]
        const ticks = input.scroll_amount ?? 3
        const dir = input.scroll_direction ?? 'down'
        const px = ticks * 100
        await this.mouse(tab, 'mouseWheel', c[0], c[1], { deltaX: dir === 'left' ? -px : dir === 'right' ? px : 0, deltaY: dir === 'up' ? -px : dir === 'down' ? px : 0 })
        await sleep(250, ctx.abort.signal)
        return ok(`Scrolled ${dir} ${ticks} ticks at (${Math.round(c[0])}, ${Math.round(c[1])})`)
      }
      case 'scroll_to': {
        if (!input.ref) throw new ToolError('scroll_to needs ref.')
        const p = await this.point(tab, input)
        return ok(`Scrolled ${input.ref} into view; it is now at (${Math.round(p.x)}, ${Math.round(p.y)}).`)
      }
      case 'left_click_drag': {
        const s = input.start_coordinate
        const e = input.coordinate
        if (!s || !e) throw new ToolError('left_click_drag needs start_coordinate and coordinate.')
        const from = { x: s[0], y: s[1] }
        const to = { x: e[0], y: e[1] }
        await this.mouse(tab, 'mouseMoved', from.x, from.y)
        await this.mouse(tab, 'mousePressed', from.x, from.y, { button: 'left', clickCount: 1, buttons: 1 })
        for (let i = 1; i <= 12; i++) {
          await this.mouse(tab, 'mouseMoved', from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12, { buttons: 1 })
        }
        await this.mouse(tab, 'mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 })
        return ok(`Dragged from (${from.x}, ${from.y}) to (${to.x}, ${to.y})`)
      }
      case 'wait': {
        const sec = input.duration ?? 1
        await sleep(sec * 1000, ctx.abort.signal)
        return ok(`Waited ${sec}s`)
      }
    }
  }

  private async resize(tab: Tab, input: BrowserToolInput['resize_window']): Promise<PaneResult> {
    const notes: string[] = []
    if (input.colorScheme) {
      await this.cdp(tab, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: input.colorScheme }] })
      notes.push(`prefers-color-scheme: ${input.colorScheme}`)
    }
    let size: { width: number; height: number; mobile: boolean } | null | undefined
    if (input.preset) size = PRESETS[input.preset]
    else if (input.width !== undefined || input.height !== undefined) {
      if (!(input.width && input.height)) throw new ToolError('Custom sizes need both width and height.')
      size = { width: input.width, height: input.height, mobile: input.width < 768 }
    }
    if (size === null) {
      await this.cdp(tab, 'Emulation.clearDeviceMetricsOverride')
      await this.cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false })
      await this.cdp(tab, 'Emulation.setUserAgentOverride', { userAgent: tab.wc.session.getUserAgent() })
      notes.push('viewport back to the pane size')
    } else if (size) {
      await this.cdp(tab, 'Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: size.mobile })
      await this.cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: size.mobile, maxTouchPoints: size.mobile ? 5 : 1 })
      if (size.mobile) await this.cdp(tab, 'Emulation.setUserAgentOverride', { userAgent: MOBILE_UA })
      notes.push(`viewport ${size.width}x${size.height}${size.mobile ? ' (mobile device: touch + Android user agent; reload so load-time checks re-run)' : ''}`)
    }
    if (!notes.length) throw new ToolError('Pass a preset, width and height, or colorScheme.')
    return ok(`Tab ${tab.id}: ${notes.join('; ')}.`)
  }
}

function normalize(url: string): string {
  const u = url.trim()
  if (!u) throw new ToolError('A url is required.')
  return /^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z0-9.-]+:\d+/i.test(u) ? u : `https://${u}`
}

function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol.startsWith('http') ? u.origin : u.protocol.replace(':', '')
  } catch {
    return url
  }
}

function push<T>(list: T[], item: T) {
  list.push(item)
  if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG)
}
