// Preload of the team page (sandboxed, contextIsolation). Exposes window.mycelDesktop (shared/src/desktop-bridge.ts)
// and nothing else: browser relay functions, pane open/close/state, connection state, notifications, team list.
// The main process re-checks every call: top frame only, team origin only (main/bridge.ts).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopBridge } from '@mycel/shared'

// constants come from the main process: this preload stays free of shared runtime code (zod etc.)
const info = ipcRenderer.sendSync('bridge:info') as { global: string; bridgeVersion: number; appVersion: string; platform: DesktopBridge['platform'] } | null

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
  notify: (n) => ipcRenderer.send('bridge:notify', { title: String(n?.title ?? ''), body: String(n?.body ?? ''), tag: n?.tag === undefined ? undefined : String(n.tag) }),
  openTeams: () => ipcRenderer.send('bridge:open-teams'),
}

// only the top frame gets the bridge (subframes don't run this preload: nodeIntegrationInSubFrames is off)
if (info) contextBridge.exposeInMainWorld(info.global, bridge)
