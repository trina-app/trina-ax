// Security defaults of the desktop shell (design tab 5 "데스크톱 앱 규칙", "아티팩트 격리 규칙").
//
// Team page view: contextIsolation, sandbox, no node, webSecurity, no node in subframes, the team origin(s) only
// (anything else opens in the person's browser), subframes may only show srcdoc / blob / data / the team origin
// (artifact and preview frames cannot navigate away), WebRTC limited to proxied UDP, and RTCPeerConnection removed
// from every subframe before its scripts run (an artifact must not leak data over WebRTC, which CSP doesn't cover).
import { app, shell, type Session, type WebContents } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { originOf } from '../common/address'
import { FolderGrants, PICKABLE_BLOCKED_ROOTS, restrictedFolderAction, type FolderCheck, type FolderRequest, type FolderSystem } from '../common/folder-access'
import { isOwnUiUrl } from '../common/trust'

/** Permissions the team page may ask for (voice input, notifications, copy button, fullscreen video). The folder
 * window ('fileSystem') has rules of its own: common/folder-access.ts. */
const PAGE_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])

/** The folders Chromium refuses as a pick but the team page may read: Desktop, Documents, Downloads, never the home
 * folder (common/folder-access.ts PICKABLE_BLOCKED_ROOTS, docs/DECISIONS.md "W6"). */
function folderRoots(): string[] {
  return PICKABLE_BLOCKED_ROOTS.map((name) => {
    try {
      return app.getPath(name)
    } catch {
      return ''
    }
  })
}

/** How long the folder rules wait for the file system about one path (a slow network drive): then the pick is refused. */
const FOLDER_LOOKUP_MS = 3000

/** p, or a rejection after FOLDER_LOOKUP_MS. The lookup runs off the main thread (libuv), so a stuck one blocks nothing. */
function inTime<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the file system did not answer in time')), FOLDER_LOOKUP_MS)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/** The computer as the folder rules see it: the home folder, a path with its links resolved, a folder's identity. Only
 * the path's own entries are looked at; nothing in a folder is listed or read. */
const FOLDER_SYSTEM: FolderSystem = {
  home: () => app.getPath('home'),
  realpath: (path) => inTime(realpath(path)),
  identity: (path) => inTime(stat(path, { bigint: true })).then((s) => ({ dev: s.dev, ino: s.ino })),
}

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

/**
 * Team session: permissions only for the team origin(s), top frame. The folder window (showDirectoryPicker): a folder
 * the person picks is readable by the team page, never writable (common/folder-access.ts); without this the pick ended
 * as the page's AbortError (Cancel), and a pick of the home folder, Desktop, Documents or Downloads never answered.
 * Desktop, Documents and Downloads are allowed now, unless one of them is home or holds it; the home folder and the
 * rest of Chromium's blocklist are refused.
 */
export function hardenAppSession(ses: Session, allowedOrigins: () => readonly string[]): FolderGrants {
  const folders = new FolderGrants(process.platform, FOLDER_SYSTEM)
  ses.setPermissionRequestHandler((_wc, permission, done, details) => {
    if (permission === 'fileSystem') {
      // answered once the home check is done (a few seconds at most); anything unexpected refuses
      void folders.request(details as FolderRequest, allowedOrigins()).then(done, () => done(false))
      return
    }
    done(details.isMainFrame && allowedOrigins().includes(originOf(details.requestingUrl)) && PAGE_PERMISSIONS.has(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    if (permission === 'fileSystem') return folders.check(requestingOrigin, details as FolderCheck, allowedOrigins())
    return allowedOrigins().includes(requestingOrigin) && PAGE_PERMISSIONS.has(permission)
  })
  ses.setDevicePermissionHandler(() => false)
  // a folder Chromium's blocklist refuses: the page's pick settles only when the callback is called, so it always is
  ses.on('file-system-access-restricted', (_e, d, callback) => {
    let decided: Promise<'allow' | 'deny'>
    try {
      const isTopFrame = !!d.frame && d.frame.parent === null
      decided = restrictedFolderAction({ origin: d.origin, path: d.path, isDirectory: d.isDirectory, isTopFrame }, allowedOrigins(), folderRoots(), process.platform, FOLDER_SYSTEM)
    } catch {
      decided = Promise.resolve('deny') // the frame went away meanwhile, or anything else unexpected
    }
    void decided.then(callback, () => callback('deny'))
  })
  // the caller tells it who is signed in (FolderGrants.person): a sign-out or another person forgets the picks
  return folders
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
