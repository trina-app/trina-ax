// Security defaults of the desktop shell (design tab 5 "데스크톱 앱 규칙", "아티팩트 격리 규칙").
//
// Team page view: contextIsolation, sandbox, no node, webSecurity, no node in subframes, the team origin(s) only
// (anything else opens in the person's browser), subframes may only show srcdoc / blob / data / the team origin
// (artifact and preview frames cannot navigate away), WebRTC limited to proxied UDP, and RTCPeerConnection removed
// from every subframe before its scripts run (an artifact must not leak data over WebRTC, which CSP doesn't cover).
import { shell, type Session, type WebContents } from 'electron'
import { originOf } from '../common/address'
import { isOwnUiUrl } from '../common/trust'

/** Permissions the team page may ask for (voice input, notifications, copy button, fullscreen video). */
const PAGE_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])

export const APP_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false,
  safeDialogs: true,
  spellcheck: false,
} as const

/** Run in every subframe of the team page at document start (artifacts, previews). */
export const SUBFRAME_SCRIPT = `(() => {
  try { if (window === window.top) return; } catch { /* cross-origin top: we are a subframe */ }
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver']) {
    try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  try { Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: false }); } catch {}
})()`

export function openExternal(url: string) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}

/** Team session: permissions only for the team origin(s), top frame. */
export function hardenAppSession(ses: Session, allowedOrigins: () => readonly string[]) {
  ses.setPermissionRequestHandler((_wc, permission, done, details) => {
    done(details.isMainFrame && allowedOrigins().includes(originOf(details.requestingUrl)) && PAGE_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowedOrigins().includes(requestingOrigin) && PAGE_PERMISSIONS.has(permission))
  ses.setDevicePermissionHandler(() => false)
}

/** Install the guards. Resolves once the subframe script is registered (call after the view has a renderer). */
export async function guardAppView(wc: WebContents, allowedOrigins: () => readonly string[]): Promise<void> {
  wc.on('will-navigate', (e) => {
    if (allowedOrigins().includes(originOf(e.url))) return
    e.preventDefault()
    openExternal(e.url)
  })
  // a team page that redirects elsewhere (or a link that does): the window stays on the team
  wc.on('will-redirect', (e) => {
    if (!e.isMainFrame || allowedOrigins().includes(originOf(e.url))) return
    e.preventDefault()
    openExternal(e.url)
  })
  wc.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return
    const url = e.url
    if (url === 'about:srcdoc' || url === 'about:blank' || /^(blob|data):/i.test(url)) return
    if (allowedOrigins().includes(originOf(url))) return
    // an artifact / preview frame trying to leave: stop it (the page shows its own notice)
    e.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  await stripRtcInSubframes(wc)
}

/** The desktop's own screens: never navigate, never open windows. */
export function guardUiView(wc: WebContents) {
  wc.on('will-navigate', (e) => {
    if (!isOwnUiUrl(e.url)) e.preventDefault()
  })
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  wc.on('will-attach-webview', (e) => e.preventDefault())
}

/**
 * Page.addScriptToEvaluateOnNewDocument on the page and, through auto-attach, on out-of-process subframes
 * (sandboxed artifact frames usually are), so the script runs before any of the frame's own scripts.
 */
async function stripRtcInSubframes(wc: WebContents) {
  const dbg = wc.debugger
  try {
    if (!dbg.isAttached()) dbg.attach('1.3')
  } catch {
    return
  }
  const prepare = async (sessionId?: string) => {
    await dbg.sendCommand('Page.enable', {}, sessionId).catch(() => {})
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: SUBFRAME_SCRIPT }, sessionId).catch(() => {})
    // Only frames need document-start guards. Chromium still pauses dedicated workers
    // when the filter excludes them, so attach those only long enough to resume/detach.
    // Service/shared workers remain excluded; never send Page commands to a worker.
    await dbg.sendCommand('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'iframe' }, { type: 'worker' }, { exclude: true }],
    }, sessionId).catch(() => {})
  }
  dbg.on('message', (_e, method, params: any) => {
    if (method !== 'Target.attachedToTarget') return
    const sid: string = params.sessionId
    if (params.targetInfo.type !== 'iframe') {
      void dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sid).then(() => dbg.sendCommand('Target.detachFromTarget', { sessionId: sid })).catch(() => {})
      return
    }
    void prepare(sid).finally(() => dbg.sendCommand('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {}))
  })
  await prepare()
}
