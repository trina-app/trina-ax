// Preload of the team page (sandboxed, contextIsolation). Exposes window.mycelDesktop (shared/src/desktop-bridge.ts)
// and nothing else: browser relay functions, pane open/close/state, connection state, notifications (a click opens the
// address the page named; Settings › Notifications' test notification), downloads (a notice when one ends, Show in folder by its number), the dock badge, the window's focus, a picture put on the clipboard (이미지 복사), team list and the teams menu, and
// a connector sign-in's one-time return address (its port only), apps on this computer (calls, Stop, setting values in; never the confirm), Settings > Browser (read the site setting, back to asking, remove / clear always-allowed sites; "all" only asks the
// main process, which shows its own confirmation dialog).
// The main process re-checks every call: top frame only, team origin only (main/main.ts, common/trust.ts).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopBridge } from '@mycel/shared'
import { keepPageFocus } from '../common/keyboard-focus'

// constants come from the main process: this preload stays free of shared runtime code (zod etc.)
const info = ipcRenderer.sendSync('bridge:info') as { global: string; bridgeVersion: number; appVersion: string; platform: DesktopBridge['platform']; store?: boolean; workFiles?: number; workFilesWide?: number; downloads?: boolean; localApps?: number; dictation?: number; googleSignIn?: number } | null

const on = (channel: string) => (cb: (payload: any) => void) => {
  const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

const bridge: DesktopBridge = {
  bridgeVersion: info?.bridgeVersion ?? 0,
  appVersion: info?.appVersion ?? '0.0.0',
  platform: info?.platform ?? 'darwin',
  store: info?.store === true,
  browser: {
    run: (call) => ipcRenderer.invoke('bridge:browser-run', call),
    cancel: (callId) => ipcRenderer.send('bridge:browser-cancel', String(callId)),
  },
  pane: {
    open: () => ipcRenderer.send('bridge:pane', 'open'),
    close: () => ipcRenderer.send('bridge:pane', 'close'),
    toggle: () => ipcRenderer.send('bridge:pane', 'toggle'),
    getState: () => ipcRenderer.invoke('bridge:pane-state'),
    onState: on('bridge:pane-state'),
  },
  connection: {
    get: () => ipcRenderer.invoke('bridge:connection'),
    onChange: on('bridge:connection'),
  },
  notify: (n) => ipcRenderer.send('bridge:notify', { title: String(n?.title ?? ''), body: String(n?.body ?? ''), tag: n?.tag === undefined ? undefined : String(n.tag), open: n?.open === undefined ? undefined : String(n.open), read: n?.read === undefined ? undefined : String(n.read) }),
  testNotify: () => ipcRenderer.invoke('bridge:notify-test'),
  onOpen: on('bridge:open'),
  onRead: on('bridge:read'),
  setBadgeCount: (n, dot) => ipcRenderer.send('bridge:badge', Number(n), dot === true),
  focus: {
    get: () => ipcRenderer.invoke('bridge:focus'),
    onChange: on('bridge:focus'),
  },
  systemActivity: { onChange: on('bridge:system-activity') },
  openTeams: () => ipcRenderer.send('bridge:open-teams'),
  teamMenu: () => ipcRenderer.send('bridge:team-menu'),
  hostLine: (drawn) => ipcRenderer.send('bridge:host-line', drawn === true),
  setLocale: (locale) => ipcRenderer.send('bridge:set-locale', String(locale)),
  setTheme: (theme) => ipcRenderer.send('bridge:set-theme', String(theme)),
  folderProblem: (name) => ipcRenderer.invoke('bridge:folder-problem', String(name)),
  copyImage: (png) => ipcRenderer.invoke('bridge:copy-image', png instanceof Uint8Array ? png : new Uint8Array(0)),
  // downloads go straight into the Downloads folder once the page listens (it shows the notice); not in the Mac App
  // Store build. The page names a download by its number, never a path
  ...(info?.downloads
    ? {
        downloads: {
          onDone: (cb: (d: { id: number; name: string; ok: boolean }) => void) => {
            const off = on('bridge:download')(cb)
            ipcRenderer.send('bridge:downloads-ready')
            return off
          },
          show: (id: number) => ipcRenderer.send('bridge:download-show', Number(id)),
        },
      }
    : {}),
  // "Find work files on this computer": only when the app offers it (not the Mac App Store build); the page names no path
  ...(info?.workFiles
    ? {
        workFiles: {
          version: info.workFiles,
          ...(info.workFilesWide ? { wide: info.workFilesWide } : {}),
          scan: (o?: { wide?: boolean; words?: string[] }) => ipcRenderer.invoke('bridge:work-files-scan', o && typeof o === 'object' ? { wide: o.wide === true, words: Array.isArray(o.words) ? o.words.slice(0, 20).map(String) : [] } : {}),
          stop: () => ipcRenderer.send('bridge:work-files-stop'),
          onProgress: on('bridge:work-files-progress'),
          add: (ids: string[]) => ipcRenderer.invoke('bridge:work-files-add', Array.isArray(ids) ? ids.slice(0, 101).map(String) : []),
          // `onCloud`: the app is getting this file from its cloud first (bridge:work-files-reading, for this id only)
          read: (id: string, o?: { onCloud?: (cloud: any) => void }) => {
            const onCloud = typeof o?.onCloud === 'function' ? o.onCloud : null
            const off = onCloud ? on('bridge:work-files-reading')((p) => { if (p && p.id === String(id) && typeof p.cloud === 'string') onCloud(p.cloud) }) : null
            return ipcRenderer.invoke('bridge:work-files-read', String(id)).finally(() => off?.())
          },
          openSettings: () => ipcRenderer.send('bridge:work-files-settings'),
          pickRoot: (id: 'documents' | 'desktop' | 'downloads') => ipcRenderer.invoke('bridge:work-files-pick', String(id)),
          pickFolder: () => ipcRenderer.invoke('bridge:work-files-pick-folder'),
          ...(info.workFilesWide && info.platform === 'darwin'
            ? {
                fullDisk: {
                  state: () => ipcRenderer.invoke('bridge:work-files-full-disk'),
                  openSettings: () => ipcRenderer.send('bridge:work-files-full-disk-settings'),
                  relaunch: () => ipcRenderer.send('bridge:work-files-relaunch'),
                },
              }
            : {}),
        },
      }
    : {}),
  // apps on this computer (main/local-apps.ts): calls in, answers out; the confirm is the app's own dialog
  ...(info?.localApps
    ? {
        localApps: {
          version: info.localApps,
          run: (call) => ipcRenderer.invoke('bridge:local-run', call),
          cancel: (callId) => ipcRenderer.send('bridge:local-cancel', String(callId)),
          stop: (id) => ipcRenderer.send('bridge:local-stop', String(id)),
          running: () => ipcRenderer.invoke('bridge:local-running'),
          onRunning: on('bridge:local-running'),
          onConfirmed: on('bridge:local-confirmed'),
          onAsking: on('bridge:local-asking'),
          setSettings: (id, values) => ipcRenderer.invoke('bridge:local-settings', String(id), values && typeof values === 'object' ? { ...values } : {}),
          settingNames: (id) => ipcRenderer.invoke('bridge:local-setting-names', String(id)),
          connected: () => ipcRenderer.invoke('bridge:local-connected'),
          forget: (id) => ipcRenderer.invoke('bridge:local-forget', String(id)),
        },
      }
    : {}),
  ...(info?.platform === 'darwin' ? { openMicSettings: () => ipcRenderer.send('bridge:mic-settings') } : {}),
  // voice input on this Mac (main/dictation.ts): the page hands over samples and gets words; never a file or a path
  ...(info?.dictation
    ? {
        dictation: {
          version: info.dictation,
          check: (language: string) => ipcRenderer.invoke('bridge:dictation-check', String(language)),
          install: (language: string, onProgress?: (percent: number) => void) => {
            const lang = String(language)
            const off = typeof onProgress === 'function' ? on('bridge:dictation-progress')((p) => { if (p && p.language === lang && typeof p.percent === 'number') onProgress(p.percent) }) : null
            return ipcRenderer.invoke('bridge:dictation-install', lang).finally(() => off?.())
          },
          start: (language: string) => ipcRenderer.invoke('bridge:dictation-start', String(language)),
          push: (id: number, samples: Float32Array) => { if (samples instanceof Float32Array) ipcRenderer.send('bridge:dictation-push', Number(id), samples) },
          stop: (id: number) => ipcRenderer.send('bridge:dictation-stop', Number(id)),
          cancel: (id: number) => ipcRenderer.send('bridge:dictation-cancel', Number(id)),
          onEvent: on('bridge:dictation-event'),
        },
      }
    : {}),
  // Sign in with Google: the app takes the code back for the team on screen (main/app-window.ts offerLink); the page
  // only learns that it may offer the button
  ...(info?.googleSignIn ? { googleSignIn: info.googleSignIn } : {}),
  // a connector sign-in's one-time return address on 127.0.0.1 (common/sign-in-return.ts): its port, never its requests
  signInReturn: {
    open: () => ipcRenderer.invoke('bridge:sign-in-return-open'),
    close: (port) => ipcRenderer.send('bridge:sign-in-return-close', Number(port)),
  },
  browserSettings: {
    get: () => ipcRenderer.invoke('bridge:browser-settings'),
    onChange: on('bridge:browser-settings'),
    setAccess: (v) => ipcRenderer.invoke('bridge:browser-access', v === 'all' ? 'all' : 'ask'),
    removeSite: (host) => ipcRenderer.invoke('bridge:browser-site-remove', String(host)),
    clearSites: () => ipcRenderer.invoke('bridge:browser-sites-clear'),
  },
}

// only the top frame gets the bridge (subframes don't run this preload: nodeIntegrationInSubFrames is off)
if (info) contextBridge.exposeInMainWorld(info.global, bridge)

// the team page keeps its own focused element (the message box) when the window comes back from Cmd-H
// (common/keyboard-focus.ts); a notification's click opens another conversation: the page's own focus there wins
if (info) {
  const kept = keepPageFocus({ win: window, doc: document })
  ipcRenderer.on('bridge:open', () => kept.drop())
}
