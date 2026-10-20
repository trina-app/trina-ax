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
import { z } from 'zod'
import { BrowserCall, BrowserResult } from './api/browser'
import type { ClientFrame, ServerFrame } from './api/ws'

/** window[DESKTOP_BRIDGE_GLOBAL] inside the desktop app. */
export const DESKTOP_BRIDGE_GLOBAL = 'mycelDesktop'
/** Bumped when the bridge changes incompatibly. The web page can ask for a minimum (createBrowserRelay). */
export const DESKTOP_BRIDGE_VERSION = 1

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
export const ConnectInfo = z.object({
  teamId: z.string().min(1).max(200),
  /** SHA-256 of the LAN certificate (DER), hex, with or without colons */
  lanCertSha256: z.string().regex(/^([0-9A-Fa-f]{2}:?){31}[0-9A-Fa-f]{2}$/).nullable(),
  lanPort: z.number().int().min(1).max(65535),
  /** e.g. ["acme-mac.local", "192.168.0.20"] */
  lanHosts: z.array(z.string().min(1).max(253)).max(8),
})
export type ConnectInfo = z.infer<typeof ConnectInfo>

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
export function createBrowserRelay(o: BrowserRelayOptions): BrowserRelay {
  const keep = o.keep ?? 200
  const done = new Map<string, BrowserResult>()
  const inFlight = new Set<string>()
  const remember = (callId: string, r: BrowserResult) => {
    done.set(callId, r)
    while (done.size > keep) done.delete(done.keys().next().value as string)
  }
  const fail = (callId: string, error: string): BrowserResult => ({ callId, ok: false, content: [{ type: 'text', text: error }], error })

  const run = (raw: BrowserCall) => {
    const parsed = BrowserCall.safeParse(raw)
    if (!parsed.success) return
    const call = parsed.data
    const prev = done.get(call.callId)
    if (prev) return o.send({ type: 'browser.result', result: prev })
    if (inFlight.has(call.callId)) return o.send({ type: 'browser.ack', callId: call.callId })
    inFlight.add(call.callId)
    o.send({ type: 'browser.ack', callId: call.callId })
    const finish = (r: BrowserResult) => {
      inFlight.delete(call.callId)
      const checked = BrowserResult.safeParse(r)
      const result = checked.success && r.callId === call.callId ? checked.data : fail(call.callId, 'The desktop app returned a malformed browser result.')
      remember(call.callId, result)
      o.send({ type: 'browser.result', result })
    }
    if (o.minBridgeVersion !== undefined && o.bridge.bridgeVersion < o.minBridgeVersion) {
      return finish(fail(call.callId, 'The desktop app is too old for browser tools. Ask the user to update the desktop app.'))
    }
    o.bridge.browser.run(call).then(finish, (e: unknown) => finish(fail(call.callId, `Browser pane error: ${e instanceof Error ? e.message : String(e)}`)))
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
