// Preload of the desktop app's own screens (welcome / team list and the browser pane toolbar), served from the
// mycel-ui:// scheme. The main process answers each channel only for the view it belongs to (main/main.ts registerIpc).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const on = (channel: string) => (cb: (payload: any) => void) => {
  const handler = (_e: IpcRendererEvent, payload: unknown) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

contextBridge.exposeInMainWorld('mycelUi', {
  strings: () => ipcRenderer.sendSync('ui:strings'),
  welcome: {
    state: () => ipcRenderer.invoke('ui:welcome-state'),
    onState: on('ui:welcome-state'),
    add: (address: string) => ipcRenderer.invoke('ui:add-team', String(address)),
    open: (id: string) => ipcRenderer.send('ui:open-team', String(id)),
    remove: (id: string) => ipcRenderer.invoke('ui:remove-team', String(id)),
    back: () => ipcRenderer.send('ui:back'),
    retry: () => ipcRenderer.send('ui:retry'),
  },
  pane: {
    state: () => ipcRenderer.invoke('ui:pane-state'),
    onState: on('ui:pane-state'),
    onPrompts: on('ui:pane-prompts'),
    onActivity: on('ui:pane-activity'),
    navigate: (url: string) => ipcRenderer.send('ui:pane-navigate', String(url)),
    history: (dir: 'back' | 'forward' | 'reload') => ipcRenderer.send('ui:pane-history', dir),
    newTab: () => ipcRenderer.send('ui:pane-new-tab'),
    select: (id: string) => ipcRenderer.send('ui:pane-select', String(id)),
    closeTab: (id: string) => ipcRenderer.send('ui:pane-close-tab', String(id)),
    close: () => ipcRenderer.send('ui:pane-close'),
    stop: () => ipcRenderer.send('ui:pane-stop'),
    answer: (id: string, decision: 'once' | 'always' | 'deny') => ipcRenderer.send('ui:pane-answer', { id: String(id), decision }),
    toolbarHeight: (h: number) => ipcRenderer.send('ui:pane-toolbar-height', Number(h)),
    resize: (screenX: number) => ipcRenderer.send('ui:pane-resize', Number(screenX)),
    sites: () => ipcRenderer.invoke('ui:pane-sites'),
    removeSite: (host: string) => ipcRenderer.send('ui:pane-site-remove', String(host)),
    clearSites: () => ipcRenderer.send('ui:pane-sites-clear'),
  },
})
