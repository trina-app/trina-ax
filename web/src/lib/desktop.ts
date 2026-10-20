// The desktop app (component E, desktop/) exposes `window.mycelDesktop` through its preload script; in a normal
// browser or the PWA it is undefined and the in-app Browser pane does not exist.
//
// Contract between this page and the desktop shell (ported from Saram's `saramDesktop`):
// - pane: the native Browser view the shell draws over an empty slot of the side panel (BrowserPanel.tsx).
// - browser.call: run one browser tool (shared BrowserToolName, input exactly as the engine sent it) and return
//   MCP-style content. The page forwards server browser.call events here and sends browser.result back over the
//   WebSocket (lib/browserRelay.ts). browser.cancel: the turn stopped.
// The shell only answers calls from this top-level frame of the team address it opened (tab 5 desktop rules).

export interface BrowserTab {
  tabId: string
  title: string
  url: string
  active?: boolean
  /** page-opened popup (sign-in window): only the person may drive it */
  popup?: boolean
  loading?: boolean
}

export interface PaneState {
  open: boolean
  tabs: BrowserTab[]
  activeTabId?: string
  /** the AI is running a browser tool right now */
  driving: boolean
}

export interface PanePermissionRequest {
  id: string
  chatId: string
  host: string
  url: string
  tool: string
}

export type PermissionDecision = 'once' | 'always' | 'deny'

export interface DesktopToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string; shareToChat?: boolean })[]
  isError: boolean
}

type Off = () => void

export interface DesktopApi {
  /** shell version, e.g. "0.1.0" */
  version: string
  pane: {
    setBounds(rect: { x: number; y: number; width: number; height: number } | null): void
    setVisible(visible: boolean): void
    navigate(url: string): void
    history(dir: 'back' | 'forward' | 'reload'): void
    selectTab(id: string): void
    closeTab(id: string): void
    newTab(): void
    getState(): Promise<PaneState>
    onState(cb: (state: PaneState) => void): Off
    onOpen(cb: () => void): Off
    onClose(cb: () => void): Off
    onPermission(cb: (req: PanePermissionRequest) => void): Off
    onPermissionResolved(cb: (r: { id: string; decision: PermissionDecision }) => void): Off
    answerPermission(id: string, decision: PermissionDecision): void
  }
  browser: {
    call(chatId: string, tool: string, input: Record<string, unknown>, callId: string): Promise<DesktopToolResult>
    cancel(callId: string): void
    endTurn(chatId: string): void
  }
}

export const desktop = (): DesktopApi | undefined => (globalThis as { mycelDesktop?: DesktopApi }).mycelDesktop
export const isDesktop = () => !!desktop()
