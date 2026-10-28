// What the desktop app (component E) gives the team web page (component D), and the small relay the web page
// runs to hand browser.call events from its WebSocket to the desktop app (design tab 5 "데스크톱 앱 규칙").
//
// The web page owns the WebSocket (one per window, windowId). When it runs inside the desktop app, the preload
// script exposes `window.mycelDesktop` (DESKTOP_BRIDGE_GLOBAL). The main process only answers calls from the top
// frame of the team page it opened (never iframes, artifacts or previews). Permission prompts and the "AI is using"
// indicator live in the desktop app's own pane UI, not in the web page, so a page served through the relay can
// send browser commands but cannot answer the user's site prompts.
//
// Web page usage:
//   const bridge = getDesktopBridge()
//   const relay = bridge && createBrowserRelay({ bridge, windowId, send: (f) => ws.send(JSON.stringify(f)) })
//   ws.onmessage = (m) => { const ev = ServerFrame.parse(JSON.parse(m.data)); relay?.handle(ev); ... }
import { BrowserCall, BrowserResult } from './api/browser'
import type { ClientFrame, ServerFrame } from './api/ws'

/** window[DESKTOP_BRIDGE_GLOBAL] inside the desktop app. */
export const DESKTOP_BRIDGE_GLOBAL = 'mycelDesktop'
/** Bumped when the bridge changes incompatibly. The web page can ask for a minimum (createBrowserRelay). */
export const DESKTOP_BRIDGE_VERSION = 1

/**
 * Token at the end of the User-Agent of the desktop app's in-app browser (the pane the AI drives). The pane never
 * opens team addresses (blocked in the desktop app); as a second line the team server answers 401 to any request
 * whose User-Agent contains this token (design tab 5 "앱 안 브라우저 분리"). Owner of the server check: A.
 */
export const IN_APP_BROWSER_UA_MARK = 'MycelBrowser/1'

/** true when a User-Agent header comes from the desktop app's in-app browser. */
export function isInAppBrowserUserAgent(ua: string | null | undefined): boolean {
  return typeof ua === 'string' && ua.includes(IN_APP_BROWSER_UA_MARK)
}

export interface DesktopPaneTab {
  tabId: string
  title: string
  url: string
  active: boolean
  loading: boolean
  /** page-opened popup (sign-in window): only the user may drive it */
  popup?: boolean
}
export interface DesktopPaneState {
  open: boolean
  tabs: DesktopPaneTab[]
  activeTabId?: string
  /** the AI is running a browser tool right now */
  driving: boolean
}

/** How this window reaches the team server (tab 6 "같은 네트워크의 데스크톱 앱"). */
export interface DesktopConnection {
  /** 'direct' = office network, pinned certificate; 'remote' = the team address (relay) */
  route: 'remote' | 'direct'
  /** origin the window is showing */
  origin: string
  /** the team address the user entered */
  teamAddress: string
  /** the pinned certificate of the direct address changed: direct connection stopped until the server confirms it */
  fingerprintMismatch: boolean
}

/**
 * The in-app browser's site setting for this team on this computer, as Settings > Browser shows it. It lives only in
 * the desktop app (per team, on this computer); the pane's ⚙ panel shows the same value.
 */
export interface DesktopBrowserSettings {
  /** ask: the person answers for each new site; all: every public website (office network and this computer still ask or stay blocked) */
  siteAccess: 'ask' | 'all'
  /** public sites allowed always */
  always: string[]
  /** office-network addresses allowed always */
  privateAlways: string[]
  /** the team lets people turn on "all" (Admin > Team settings), as the desktop app last heard from the team server */
  teamAllowsAll: boolean
}

/** How setAccess ended. 'changed' for "all" only after the person confirmed the desktop app's own dialog. */
export type DesktopAccessOutcome = 'changed' | 'unchanged' | 'cancelled' | 'not-allowed' | 'busy' | 'unavailable'

export interface DesktopBridge {
  bridgeVersion: number
  /** desktop app (shell) version, e.g. "0.1.0" */
  appVersion: string
  platform: 'darwin' | 'win32' | 'linux'
  browser: {
    /** Run one browser.call. Same callId twice returns the first result (never runs twice). */
    run(call: BrowserCall): Promise<BrowserResult>
    /** browser.cancel: the turn stopped */
    cancel(callId: string): void
  }
  pane: {
    open(): void
    close(): void
    toggle(): void
    getState(): Promise<DesktopPaneState>
    onState(cb: (s: DesktopPaneState) => void): () => void
  }
  connection: {
    get(): Promise<DesktopConnection>
    onChange(cb: (c: DesktopConnection) => void): () => void
  }
  /** Native notification (admin alerts, finished jobs). Shown only while the window is not focused. */
  notify(n: { title: string; body: string; tag?: string }): void
  /** Open the desktop app's team list (switch team / add a team). */
  openTeams(): void
  /** The language the team page shows now (the person's choice, else the team default): the desktop app's own
   * screens, menus and prompts follow it. Optional: desktop apps before this addition do not have it. */
  setLocale?(locale: 'ko' | 'en' | 'id'): void
  /**
   * Settings > Browser: the same setting as the pane's ⚙ panel, and nothing else. The page can read it, go back to
   * asking, remove an always-allowed site and clear them all. setAccess('all') only asks: the desktop app shows its
   * own confirmation dialog and changes the setting only when the person confirms there; it is refused while the
   * team does not allow it. Optional: desktop apps before this addition do not have it (the section stays hidden).
   */
  browserSettings?: {
    get(): Promise<DesktopBrowserSettings | null>
    /** the setting changed (here, in the pane's ⚙ panel, by an answer "always allow", or by the team's policy) */
    onChange(cb: (s: DesktopBrowserSettings) => void): () => void
    setAccess(v: 'ask' | 'all'): Promise<DesktopAccessOutcome>
    removeSite(host: string): Promise<DesktopBrowserSettings | null>
    clearSites(): Promise<DesktopBrowserSettings | null>
  }
}

export function getDesktopBridge(): DesktopBridge | null {
  const b = (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_GLOBAL] as DesktopBridge | undefined
  return b && typeof b === 'object' && typeof b.bridgeVersion === 'number' ? b : null
}

/**
 * Office-network direct connection info (tab 6). The team server answers GET CONNECT_INFO_PATH over the team
 * address (real TLS); the desktop app then accepts only this certificate on the LAN address (no trust on first use).
 */
export const CONNECT_INFO_PATH = '/api/connect-info'
/** the schema lives with the endpoint (shared/src/api/system.ts) */
export { ConnectInfo } from './api/system'

export interface BrowserRelayOptions {
  bridge: DesktopBridge
  /** this window's id (the one sent as x-mycel-window and on /api/ws) */
  windowId: string
  /** send a client frame on the WebSocket (or POST /api/browser/results on the long-poll path) */
  send: (frame: ClientFrame) => void
  /** refuse to run calls when the desktop app is older than this bridge version (the page shows "update the app") */
  minBridgeVersion?: number
  /** how many finished results to keep for re-sending after a reconnect (default 200) */
  keep?: number
  /** and at most this many characters of them in total (screenshots are large; default 32 MB) */
  keepChars?: number
}

export interface BrowserRelay {
  /** Feed every server frame; returns true when it was a browser frame for this window. */
  handle(frame: ServerFrame): boolean
  /** Run a call that arrived through the long-poll fallback (GET /api/browser/calls). */
  run(call: BrowserCall): void
  /** calls running in the desktop app right now */
  readonly running: number
}

/**
 * Hands browser.call to the desktop app and sends browser.ack / browser.result back. A call that arrives again
 * (replay after a reconnect) is never run twice: running → ack again; finished → result again.
 */
/** Characters a result holds (texts + base64 images): what the relay counts against keepChars. */
export function browserResultChars(r: BrowserResult): number {
  let n = r.error?.length ?? 0
  for (const c of r.content) n += c.type === 'text' ? c.text.length : c.data.length
  return n
}

export function createBrowserRelay(o: BrowserRelayOptions): BrowserRelay {
  const keep = o.keep ?? 200
  const keepChars = o.keepChars ?? 32 * 1024 * 1024
  const done = new Map<string, { r: BrowserResult; size: number }>()
  let doneChars = 0
  const inFlight = new Set<string>()
  const remember = (callId: string, r: BrowserResult) => {
    const size = browserResultChars(r)
    done.set(callId, { r, size })
    doneChars += size
    // the newest result always stays (it may be the one a reconnect asks for)
    while (done.size > 1 && (done.size > keep || doneChars > keepChars)) {
      const [oldest, e] = done.entries().next().value as [string, { size: number }]
      done.delete(oldest)
      doneChars -= e.size
    }
  }
  // a closed WebSocket throws on send: the result stays remembered and goes out again when the call is replayed
  const send = (frame: ClientFrame) => {
    try {
      o.send(frame)
    } catch {
      // ignored on purpose (see above)
    }
  }
  const fail = (callId: string, error: string): BrowserResult => ({ callId, ok: false, content: [{ type: 'text', text: error }], error })

  const run = (raw: BrowserCall) => {
    const parsed = BrowserCall.safeParse(raw)
    if (!parsed.success) return
    const call = parsed.data
    const prev = done.get(call.callId)
    if (prev) return send({ type: 'browser.result', result: prev.r })
    if (inFlight.has(call.callId)) return send({ type: 'browser.ack', callId: call.callId })
    inFlight.add(call.callId)
    send({ type: 'browser.ack', callId: call.callId })
    const finish = (r: BrowserResult) => {
      inFlight.delete(call.callId)
      const checked = BrowserResult.safeParse(r)
      const result = checked.success && r.callId === call.callId ? checked.data : fail(call.callId, 'The desktop app returned a malformed browser result.')
      remember(call.callId, result)
      send({ type: 'browser.result', result })
    }
    if (o.minBridgeVersion !== undefined && o.bridge.bridgeVersion < o.minBridgeVersion) {
      return finish(fail(call.callId, 'The desktop app is too old for browser tools. Ask the user to update the desktop app.'))
    }
    let pending: Promise<BrowserResult>
    try {
      pending = o.bridge.browser.run(call)
    } catch (e) {
      pending = Promise.reject(e)
    }
    pending.then(finish, (e: unknown) => finish(fail(call.callId, `Browser pane error: ${e instanceof Error ? e.message : String(e)}`)))
  }

  return {
    handle(frame) {
      if (frame.type === 'browser.call') {
        if (frame.data.windowId !== o.windowId) return false
        run(frame.data.call)
        return true
      }
      if (frame.type === 'browser.cancel') {
        if (frame.data.windowId !== o.windowId) return false
        if (inFlight.has(frame.data.callId)) o.bridge.browser.cancel(frame.data.callId)
        return true
      }
      return false
    },
    run,
    get running() {
      return inFlight.size
    },
  }
}
