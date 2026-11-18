// Preload of the team page (sandboxed, contextIsolation). Exposes window.mycelDesktop (shared/src/desktop-bridge.ts)
// and nothing else: browser relay functions, pane open/close/state, connection state, notifications (a click opens the
// address the page named; Settings › Notifications' test notification), downloads (a notice when one ends, Show in folder by its number), the dock badge, the window's focus, a picture put on the clipboard (이미지 복사), team list and the teams menu, and
// a connector sign-in's one-time return address (its port only), Settings > Browser (read the site setting, back to asking, remove / clear always-allowed sites; "all" only asks the
// main process, which shows its own confirmation dialog).
// The main process re-checks every call: top frame only, team origin only (main/main.ts, common/trust.ts).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopBridge } from '@mycel/shared'
import { keepPageFocus } from '../common/keyboard-focus'

// constants come from the main process: this preload stays free of shared runtime code (zod etc.)
const info = ipcRenderer.sendSync('bridge:info') as { global: string; bridgeVersion: number; appVersion: string; platform: DesktopBridge['platform']; store?: boolean; workFiles?: number; workFilesWide?: number; meeting?: number; downloads?: boolean } | null

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
  // meeting notes: only where the app has the sound helper (a Mac, macOS 14.4+, not the store build); start() shows the
  // app's own dialog, the page gets lines and state, never sound
  ...(info?.meeting
    ? {
        meeting: {
          version: info.meeting,
          state: () => ipcRenderer.invoke('bridge:meeting-state'),
          start: () => ipcRenderer.invoke('bridge:meeting-start'),
          stop: () => ipcRenderer.invoke('bridge:meeting-stop'),
          lines: () => ipcRenderer.invoke('bridge:meeting-lines'),
          onLines: on('bridge:meeting-lines-changed'),
          onState: on('bridge:meeting-state-changed'),
          openSoundSettings: () => ipcRenderer.send('bridge:meeting-sound-settings'),
          unsaved: () => ipcRenderer.invoke('bridge:meeting-unsaved'),
          saved: (startedAt: number) => ipcRenderer.send('bridge:meeting-saved', Number(startedAt)),
        },
      }
    : {}),
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
